// ============================================================================
// OpenMontageService - 微短剧制作 8 步向导核心服务
// ----------------------------------------------------------------------------
// 会话状态存数据库 MicroDramaSession 表(通过 $queryRawUnsafe 操作,
// 因为 Prisma Client 类型在 backend 重启时才会刷新)。
//
// 各步产出结构(stepData["<step>"].output):
//   0: { summary, genre, duration_sec, aspect_ratio, style, tone, target_audience }
//   1: { title, logline, synopsis, scenes: [{ idx, location, summary }] }
//   2: { characters: [{ id, name, role, appearance, personality }],
//        locations:  [{ id, name, description, mood }],
//        props:      [{ id, name, description, used_by }] }
//   3: { characters: [{ id, views: [{ angle, url }] }],  // 4 视图: front/side/back/pose
//        locations:  [{ id, url }],
//        props:      [{ id, url }] }
//   4: { shots: [{ idx, scene_idx, duration_sec, shot_type, description,
//                  dialogue, characters, location_id, props, camera_motion }] }
//   5: { keyframes: [{ shot_idx, url, prompt }] }
//   6: { shots: [{ shot_idx, video_url, duration_sec, status }] }
//   7: { final_url, duration_sec, subtitle_url, bgm_url }
// ============================================================================

import {
  Injectable, Logger, NotFoundException, BadRequestException, Optional,
} from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { SkillDispatcher } from '../skills/skill-dispatcher.service';
import { OssService } from '../oss/oss.service';
import { planAssetShots } from '../drama/concept-art';
import { buildShotVideoPrompt } from '../drama/video-prompt';
import { cameraMotionGuide } from '../drama/camera-motion';
import { buildTimeline, timelineToAss, timelineToSrt, assLayout, escapeAssText, wrapCueText } from '../drama/timeline';
import { alignVideoWords, probeDurationSec, probeFps, probeHasAudio, probeResolution, resolveFfprobeBin } from './asr-align';
import { auditCompose } from './video-audit';
import { checkShotDescriptions, summarizeDescViolations } from '../drama/shot-description-guard';
import { rhythmPromptGuide, checkEpisodeRhythm, checkEpisodeEndHook } from '../drama/rhythm-guard';
import { planCompose } from '../drama/transition-plan';
import { evaluateComposeGate, failedShotDetails } from '../drama/compose-gate';
import { planShotRelay, groupIntoChains } from '../drama/relay-plan';
import { RETRYABLE_IMAGE_STATUS } from '../../common/upstream-retry';
import {
  videoCreateBackoffMs, videoCreateStaggerMs, adaptI2vConcurrency,
} from '../../common/upstream-retry';
import { reportUpstreamBackoff, reportShotProgress } from '../../common/upstream-heartbeat';
import {
  buildKeyframePlan, summarizePlans, indexLegacyConceptArt,
} from '../drama/keyframe-plan';

const OPEN_MONTAGE_AGENT_ID = 201;

// 8 个步骤的中文标签(对齐前端)
export const STEP_LABELS = [
  '需求确认',
  '剧本大纲',
  '角色/场景/道具设计',
  '设定图',
  '分镜脚本',
  '分镜关键帧',
  '分镜视频',
  '合成视频',
];

interface DramaRow {
  id: bigint;
  uuid: string;
  userId: bigint;
  agentId: bigint;
  title: string;
  status: string;
  currentStep: number;
  stepData: any;
  taskId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LlmCtx { userId: number; agentId: number; }

/** 2026-09-21: 清洗分镜提示词中容易误触上游内容审核(400 content_policy_violation)的极端词汇 */
export function sanitizePromptForSafety(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return '';
  return prompt
    .replace(/(烟头|抽烟|香烟|吸烟|吐出烟雾)/g, '金属零件')
    .replace(/(死|杀|砍|刺|毙|戮|斩)/g, '击退')
    .replace(/(鲜血|血液|流血|血迹|血泊|伤口|血肉)/g, '红色微光')
    .replace(/(尸体|死尸|残肢|断臂|骷髅|白骨)/g, '沉睡的身影')
    .replace(/(腐烂|福尔马林|恶臭|尸臭)/g, '陈旧斑驳')
    .replace(/(手枪|步枪|子弹|开枪|射击|枪口)/g, '发射装置')
    .replace(/(裸体|赤身|诱惑|性感)/g, '着装整齐')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class OpenMontageService {
  private readonly logger = new Logger(OpenMontageService.name);
  private readonly sessionsDir: string;
  // 2026-07-31:Agnes API key 池(从 .env 读取多个 key,用于 step 5/6 并行生成负载均衡)
  //   .env 里配置:AGNES_API_KEY / AGNES_API_KEY-01 / AGNES_API_KEY-02
  //   并行图片/视频生成时轮询分配 key,避免单 key 限流,提速 ~3倍
  private readonly agnesKeys: string[];
  private readonly agnesBaseUrl: string;
  // key 轮询计数器(原子递增,保证每个并行任务拿不同 key)
  private keyRotateIdx = 0;

  // 2026-08-09:Agnes 视频 API 限流「每 key 每分钟 1 次创建」。
  //   step6 之前 Promise.all 把 16 个创建请求同一秒打出去,每个 key 只有
  //   第 1 个成功,其余全部 429。现在按 key 维护串行队列 + 最小创建间隔,
  //   拿到同一 key 的并行任务自动排队等下一个分钟窗口。
  private readonly VIDEO_CREATE_INTERVAL_MS = 63_000;
  private readonly videoCreateLastAt = new Map<string, number>();
  private readonly videoCreateChain = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: SkillDispatcher,
    @Optional() private readonly oss?: OssService,
  ) {
    this.sessionsDir = path.resolve(process.cwd(), 'uploads', 'micro-drama-sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    // 读取 Agnes key 池(过滤空值 + 去重)
    // 2026-08-09:改为自动扫描 AGNES_API_KEY 及所有 AGNES_API_KEY-* 编号 key,
    //   之前硬编码只读 -01/-02,.env 里新增的 -03 进不了池,白白浪费一路配额。
    const keyPool: string[] = [];
    for (const [name, value] of Object.entries(process.env)) {
      if (/^AGNES_API_KEY(-.+)?$/.test(name) && value && value.trim().length > 0) {
        keyPool.push(value.trim());
      }
    }
    this.agnesKeys = [...new Set(keyPool)]; // 去重
    this.agnesBaseUrl = (process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1').replace(/\/$/, '');
    this.logger.log(`[OpenMontage] Agnes key pool size: ${this.agnesKeys.length}, base_url: ${this.agnesBaseUrl}`);
  }

  /** key 池大小(并发度决策用):池里几个 key 就能安全地几路并行(每 key RPM 独立计) */
  get agnesKeyCount(): number {
    return this.agnesKeys.length;
  }

  /** 每个 key 上次使用时间戳(选"最久没用"避免撞上游 1 RPM/分钟限制) */
  private keyLastUsed = new Map<string, number>();

  /** 从 key 池选"最久没用"的 key——nextKey 纯轮询会连续撞同一波 key,实测触发 65s 退避 */
  nextKey(): string {
    if (this.agnesKeys.length === 0) {
      throw new BadRequestException('AGNES_API_KEY 未配置(.env 里需要至少一个 AGNES_API_KEY)');
    }
    // 选 lastUsed 最早的 key;从未用过(0)优先
    let best = this.agnesKeys[0];
    let bestTime = this.keyLastUsed.get(best) ?? 0;
    for (let i = 1; i < this.agnesKeys.length; i++) {
      const k = this.agnesKeys[i];
      const t = this.keyLastUsed.get(k) ?? 0;
      if (t < bestTime) { best = k; bestTime = t; }
    }
    this.keyLastUsed.set(best, Date.now());
    return best;
  }

  // 2026-09-16:i2v 并发信号量。上游视频队列是**全局**资源(video_queue_full 503),
  //   与 key 池无关 —— 11 镜 Promise.all 一把梭等于自己把队列打满,再贵的重试
  //   也救不回"创建请求根本进不去"。信号量把同时在飞的 i2v(创建+渲染)压到
  //   有效并发(见 i2vConcurrency),创建请求自然错开,队列不再饱和。
  // 2026-09-24:DRAMA_I2V_CONCURRENCY 改为**上限**(ceiling)语义 —— 滑动窗口里
  //   503 过半自动对半降(不低于 2),连续健康缓慢回升。e2e 实测 12 路齐发撞死
  //   11 号镜:固定并发 + 固定 65s 重试 = 集体重试同秒再撞。
  private i2vInFlight = 0;
  private readonly i2vWaiters: Array<() => void> = [];
  private i2vRenderCap: number | null = null;
  /** 最近创建结果滑动窗口(true=503,最多记 12 次;自适应并发的唯一输入) */
  private readonly createOutcome503: boolean[] = [];
  private i2vCeiling(): number {
    const n = Number(process.env.DRAMA_I2V_CONCURRENCY);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    // 2026-09-21:自适应 Key 池容量。避免拥有十几把 Key 却被写死为 4 并发,
    // 默认取 Key 池数量(同时设置安全上限 16),兼顾上游限流与最大并发生成吞吐。
    return Math.min(Math.max(4, this.agnesKeys.length), 16);
  }
  private i2vConcurrency(): number {
    const ceil = this.i2vCeiling();
    if (this.i2vRenderCap == null) this.i2vRenderCap = ceil;
    return this.i2vRenderCap;
  }
  /** 记录一次创建结果并刷新有效并发(纯决策走 adaptI2vConcurrency,单测覆盖) */
  private recordCreateOutcome(is503: boolean): void {
    this.createOutcome503.push(!!is503);
    if (this.createOutcome503.length > 12) this.createOutcome503.shift();
    const ceil = this.i2vCeiling();
    this.i2vRenderCap = adaptI2vConcurrency(
      this.i2vRenderCap ?? ceil,
      {
        attempts: this.createOutcome503.length,
        e503: this.createOutcome503.filter(Boolean).length,
      },
      ceil,
    );
  }
  // 2026-09-24:创建槽位(与渲染槽位分离)。渲染槽位抱着最长 30min 轮询,
  //   不能再用它限创建 —— 尾部镜头要等整段渲染完才允许创建,等于把并行压扁。
  //   创建槽位只在 POST 瞬间持有(退避 sleep 时释放),上限默认 ceiling/3,
  //   让创建请求全局错开而不至于同秒齐发。DRAMA_I2V_CREATE_CONCURRENCY 可覆盖。
  private i2vCreateInFlight = 0;
  private readonly i2vCreateWaiters: Array<() => void> = [];
  private i2vCreateConcurrency(): number {
    const n = Number(process.env.DRAMA_I2V_CREATE_CONCURRENCY);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return Math.max(2, Math.floor(this.i2vCeiling() / 3));
  }
  private acquireI2vCreateSlot(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        this.i2vCreateInFlight = Math.max(0, this.i2vCreateInFlight - 1);
        const next = this.i2vCreateWaiters.shift();
        if (next) next();
      };
      const tryAcquire = (): boolean => {
        if (this.i2vCreateInFlight < this.i2vCreateConcurrency()) {
          this.i2vCreateInFlight++;
          resolve(release);
          return true;
        }
        return false;
      };
      if (!tryAcquire()) this.i2vCreateWaiters.push(tryAcquire);
    });
  }
  /** 取一个 i2v 槽位;返回释放函数(必须在 finally 里调) */
  private acquireI2vSlot(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        this.i2vInFlight = Math.max(0, this.i2vInFlight - 1);
        const next = this.i2vWaiters.shift();
        if (next) next();
      };
      const tryAcquire = (): boolean => {
        if (this.i2vInFlight < this.i2vConcurrency()) {
          this.i2vInFlight++;
          resolve(release);
          return true;
        }
        return false;
      };
      if (!tryAcquire()) this.i2vWaiters.push(tryAcquire);
    });
  }

  /**
   * 2026-08-09:为指定 key 预约一次「视频任务创建」窗口。
   * 同一 key 的创建请求串行排队,且与上一次创建至少间隔 VIDEO_CREATE_INTERVAL_MS,
   * 避免 Agnes「每 key 每分钟 1 次」限流(429 rate_limit_exceeded)。
   */
  private acquireVideoCreateSlot(apiKey: string): Promise<void> {
    const run = async () => {
      const last = this.videoCreateLastAt.get(apiKey) || 0;
      const waitMs = last + this.VIDEO_CREATE_INTERVAL_MS - Date.now();
      if (waitMs > 0) {
        // 排队等窗口是连集视频步骤最常见的静默源(同 key 串行 63s,一集十几镜
        // 能排十几分钟),不报出去前端就只剩一个不动的进度条。
        reportUpstreamBackoff(`等视频通道限流窗口,约 ${Math.ceil(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      this.videoCreateLastAt.set(apiKey, Date.now());
    };
    const prev = this.videoCreateChain.get(apiKey) || Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.videoCreateChain.set(apiKey, next.catch(() => {}));
    return next;
  }

  // ===========================================================================
  // 会话 CRUD
  // ===========================================================================

  async createSession(params: {
    userId: number;
    agentId?: number;
    title?: string;
    requirement?: any;
  }): Promise<any> {
    const uuid = randomUUID();
    const agentId = params.agentId ?? OPEN_MONTAGE_AGENT_ID;
    const title = (params.title || '微短剧制作会话').slice(0, 200);

    // step 0 的初始 input(用户可后续编辑)
    const stepData: Record<string, any> = {
      '0': { input: params.requirement || {}, output: null },
    };

    // 用 $queryRawUnsafe 绕过 Prisma Client 类型生成(因为 query_engine.dll 被锁)
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO \`MicroDramaSession\`
       (\`uuid\`, \`userId\`, \`agentId\`, \`title\`, \`status\`, \`currentStep\`, \`stepData\`, \`updatedAt\`)
       VALUES (?, ?, ?, ?, 'active', 0, CAST(? AS JSON), CURRENT_TIMESTAMP(3))`,
      uuid,
      BigInt(params.userId),
      BigInt(agentId),
      title,
      JSON.stringify(stepData),
    );

    // 创建会话目录
    const sessionDir = path.join(this.sessionsDir, uuid);
    fs.mkdirSync(sessionDir, { recursive: true });

    return this.getSession(uuid);
  }

  async listSessions(userId: number): Promise<any[]> {
    const rows = await this.prisma.$queryRawUnsafe<DramaRow[]>(
      `SELECT * FROM \`MicroDramaSession\`
       WHERE \`userId\` = ?
       ORDER BY \`updatedAt\` DESC LIMIT 50`,
      BigInt(userId),
    );
    return rows.map((r) => this.formatRow(r));
  }

  async getSession(uuid: string): Promise<any> {
    const row = await this.getRow(uuid);
    return this.formatRow(row);
  }

  async deleteSession(uuid: string): Promise<{ ok: true }> {
    await this.getRow(uuid); // 校验存在
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM \`MicroDramaSession\` WHERE \`uuid\` = ?`,
      uuid,
    );
    // 顺带清理文件目录(保留备份,不删)
    return { ok: true };
  }

  // ===========================================================================
  // 步骤生成 / 确认 / 修改 / 删除
  // ===========================================================================

  /**
   * 生成某步产出。input 可由前端传入,也支持从 stepData['<step>'].input 读
   */
  async generateStep(uuid: string, step: number, input?: any, options?: any): Promise<any> {
    const row = await this.getRow(uuid);
    const stepData = this.parseStepData(row.stepData);
    const ctx: LlmCtx = { userId: Number(row.userId), agentId: Number(row.agentId) };

    // 合并输入:已有 input ← 新传入 input
    const effectiveInput = { ...(stepData[String(step)]?.input || {}), ...(input || {}) };
    stepData[String(step)] = stepData[String(step)] || {};
    stepData[String(step)].input = effectiveInput;
    stepData[String(step)].generating = true;
    await this.saveStepData(uuid, stepData);

    try {
      const output = await this.dispatchGenerate(step, effectiveInput, stepData, ctx, uuid, options || {});
      stepData[String(step)].output = output;
      stepData[String(step)].generating = false;
      stepData[String(step)].generatedAt = new Date().toISOString();
      await this.saveStepData(uuid, stepData);
      return this.formatRow({ ...row, stepData });
    } catch (e: any) {
      stepData[String(step)].generating = false;
      stepData[String(step)].error = e.message || String(e);
      await this.saveStepData(uuid, stepData);
      throw e;
    }
  }

  /**
   * 确认某步(把 input/output 落库,推进 currentStep 到 step+1)
   */
  async confirmStep(uuid: string, step: number, input?: any, output?: any): Promise<any> {
    const row = await this.getRow(uuid);
    const stepData = this.parseStepData(row.stepData);
    stepData[String(step)] = stepData[String(step)] || {};
    if (input) stepData[String(step)].input = { ...(stepData[String(step)].input || {}), ...input };
    if (output) stepData[String(step)].output = output;
    stepData[String(step)].confirmedAt = new Date().toISOString();

    const nextStep = Math.min(7, step + 1);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`MicroDramaSession\`
       SET \`stepData\` = CAST(? AS JSON), \`currentStep\` = ?, \`updatedAt\` = CURRENT_TIMESTAMP(3)
       WHERE \`uuid\` = ?`,
      JSON.stringify(stepData), nextStep, uuid,
    );
    return this.getSession(uuid);
  }

  /**
   * 直接修改某步的 output(用户在前端手动编辑)
   */
  async updateStepOutput(uuid: string, step: number, output: any): Promise<any> {
    const row = await this.getRow(uuid);
    const stepData = this.parseStepData(row.stepData);
    stepData[String(step)] = stepData[String(step)] || {};
    stepData[String(step)].output = output;
    stepData[String(step)].modifiedAt = new Date().toISOString();
    await this.saveStepData(uuid, stepData);
    return this.getSession(uuid);
  }

  /**
   * 删除某步产出(回退到待生成状态),不删除 input
   */
  async deleteStepOutput(uuid: string, step: number): Promise<any> {
    const row = await this.getRow(uuid);
    const stepData = this.parseStepData(row.stepData);
    if (stepData[String(step)]) {
      stepData[String(step)].output = null;
      delete stepData[String(step)].generating;
      delete stepData[String(step)].generatedAt;
      delete stepData[String(step)].confirmedAt;
      delete stepData[String(step)].error;
    }
    // 回退 currentStep
    const newStep = Math.min(step, row.currentStep);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`MicroDramaSession\`
       SET \`stepData\` = CAST(? AS JSON), \`currentStep\` = ?, \`updatedAt\` = CURRENT_TIMESTAMP(3)
       WHERE \`uuid\` = ?`,
      JSON.stringify(stepData), newStep, uuid,
    );
    return this.getSession(uuid);
  }

  // ===========================================================================
  // 8 步生成实现
  // ===========================================================================

  private async dispatchGenerate(
    step: number,
    input: any,
    stepData: Record<string, any>,
    ctx: LlmCtx,
    sessionUuid: string,
    options: any,
  ): Promise<any> {
    switch (step) {
      case 0: return this.genStep0Requirement(input);
      case 1: return this.genStep1ScriptOutline(input, stepData['0']?.output, ctx);
      case 2: return this.genStep2Design(input, stepData['1']?.output, ctx);
      case 3: return this.genStep3ConceptArt(input, stepData['2']?.output, ctx, sessionUuid);
      case 4: return this.genStep4Shots(input, stepData['1']?.output, stepData['2']?.output, ctx);
      case 5: return this.genStep5Keyframes(input, stepData['4']?.output, stepData['3']?.output, stepData['2']?.output, ctx, sessionUuid, options);
      case 6: return this.genStep6ShotVideos(input, stepData['5']?.output, stepData['4']?.output, ctx, sessionUuid, options, stepData['6']?.output);
      case 7: return this.genStep7Compose(input, stepData['6']?.output, stepData['4']?.output, sessionUuid, options);
      default:
        throw new BadRequestException(`不支持的步骤: ${step}`);
    }
  }

  // ── Step 0: 需求确认(不调 LLM,纯整理用户输入) ──
  private async genStep0Requirement(input: any): Promise<any> {
    // 用户在前端输入:topic / genre / duration_sec / aspect_ratio / style / tone / target_audience
    // 2026-07-30:duration_sec 可不填(0/null),由 step 1 LLM 根据剧情自动估算
    const rawDur = Number(input.duration_sec);
    const duration_sec = (Number.isFinite(rawDur) && rawDur > 0) ? rawDur : 0;
    const out = {
      topic: (input.topic || input.theme || '').trim(),
      genre: input.genre || '现代都市',
      duration_sec,
      duration_auto: duration_sec === 0,  // 标记是否需要自动估算
      aspect_ratio: input.aspect_ratio || '9:16',
      style: input.style || '电影质感',
      tone: input.tone || '紧张悬疑',
      target_audience: input.target_audience || '18-35 岁都市观众',
      reference_url: input.reference_url || '',
      extra: input.extra || {},
    };
    if (!out.topic) throw new BadRequestException('请输入主题');
    return out;
  }

  // ── Step 1: 剧本大纲(LLM) ──
  private async genStep1ScriptOutline(input: any, reqOutput: any, ctx: LlmCtx): Promise<any> {
    const req = reqOutput || {};
    const topic = input.topic || req.topic || '';
    if (!topic) throw new BadRequestException('缺少主题');

    // 2026-07-30:duration_sec=0 时不限制时长,让 LLM 根据剧情自动估算
    //   并要求每个场景返回 estimated_sec,后续 step 4/5/6 用这个估算分镜数和视频时长
    const dur = Number(req.duration_sec) || 0;
    const durLine = dur > 0
      ? `目标时长: ${dur} 秒(严格遵守,场景数和剧情密度按此调整)`
      : `目标时长: 不限制,请根据剧情复杂度自动估算合理时长(微短剧建议 30-120 秒)`;

    // 2026-07-31:主题超长(>2000 字)时截断到 2000 字。
    //   之前阈值 10000 字太大,用户把完整 71 镜剧本(约 5000 字)作为主题输入时,
    //   LLM 拿到超长主题后 reasoning + 复述消耗大量 token,导致输出的 JSON 被截断,
    //   parseJsonSafe 解析失败。剧本大纲只需要主题的核心信息,2000 字足够。
    const safeTopic = topic.length > 2000 ? topic.slice(0, 2000) + '\n[主题已截断,完整内容请见 step 0]' : topic;
    const sys = `你是一位资深短视频编剧。根据用户主题,输出剧本大纲 JSON。
要求:
- 严格输出 JSON,不要 markdown 包裹,不要复述主题内容
- 场景数 3-8 个,符合微短剧节奏
- 每个场景有明确地点和剧情推进
- 每个场景必须返回 estimated_sec(预计该场景占多少秒)
- logline 一句话抓住核心冲突
- total_estimated_sec 等于所有场景 estimated_sec 之和
- synopsis 控制在 100-200 字,不要长篇大论
- summary 每个场景 50 字以内`;
    const usr = `主题: ${safeTopic}
类型: ${req.genre || '现代都市'}
${durLine}
基调: ${req.tone || '紧张悬疑'}
目标观众: ${req.target_audience || '18-35 岁都市观众'}

请输出:
{
  "title": "剧名",
  "logline": "一句话概述",
  "synopsis": "剧情梗概(100-200 字)",
  "total_estimated_sec": 60,
  "scenes": [
    { "idx": 1, "location": "场景地点", "summary": "该场景剧情摘要(50 字以内)", "estimated_sec": 10 }
  ]
}`;

    // 2026-07-31:max_tokens 从 2048 调大到 8192。
    //   agnes-2.5-flash 是推理模型,reasoning 占 200-500 tokens。
    //   2048 在超长主题(如完整 71 镜剧本约 5000 字)时不够,LLM 返回的 JSON 被截断,
    //   parseJsonSafe 解析失败,抛"返回内容无法解析为 JSON"。
    //   8192 给 reasoning + 完整 JSON 输出留足空间。
    const raw = await this.callLlm(ctx, sys, usr, 0.8, 8192);
    const parsed = this.parseJsonSafe(raw);
    if (!parsed || !parsed.title) {
      const preview = (raw || '').slice(0, 200);
      throw new BadRequestException(
        `LLM 生成剧本大纲失败(返回内容无法解析为 JSON)。原始返回前200字: ${preview}`,
      );
    }

    // 2026-07-30:自动估算时,把 LLM 估算的总时长回填到 req,后续步骤使用
    if (!dur && parsed.total_estimated_sec) {
      req.duration_sec = parsed.total_estimated_sec;
      req.duration_auto = true;
    }
    // 兜底:LLM 没返回 estimated_sec 时,按场景数均分
    if (parsed.scenes && parsed.scenes.length > 0) {
      const total = parsed.total_estimated_sec || dur || (parsed.scenes.length * 10);
      const per = Math.round(total / parsed.scenes.length);
      parsed.scenes.forEach((s: any, i: number) => {
        if (!s.estimated_sec) s.estimated_sec = per;
      });
    }
    return parsed;
  }

  // ── Step 2: 角色/场景/道具设计(LLM) ──
  async genStep2Design(input: any, outline: any, ctx: LlmCtx, roster?: any): Promise<any> {
    if (!outline || !outline.scenes) throw new BadRequestException('请先生成剧本大纲');

    // 2026-09-16(批4):资产数量改由小说账本 roster 驱动 —— 旧提示词硬编码
    //   "主要角色 2-5、道具 2-6",与小说实际人物数无关(七问题之问题4"资产太少"根因)。
    //   有 roster 时清单必须全覆盖、不许自减;vehicle/wardrobe 按小说提及才出。
    const hasRoster = !!roster && (
      (Array.isArray(roster.characters) && roster.characters.length)
      || (Array.isArray(roster.locations) && roster.locations.length)
      || (Array.isArray(roster.props) && roster.props.length));

    const sys = `你是影视美术指导 + 编剧。根据剧本大纲,设计角色/场景/道具 JSON。
要求:
- 严格 JSON,无 markdown
- ${hasRoster
      ? `下方「名单」从小说账本逐字抽取:characters/locations/props 必须**覆盖名单每一项**(数量跟名单走,禁止自减);名单里 vehicles/wardrobe 非空时才输出同结构数组,为空则输出空数组`
      : '主要角色 2-5 个,场景按剧本 scenes 设计,道具 2-6 个'}
- appearance 用于后续图像生成的提示词,要具体(外貌/服装/年龄/发型/气质)
- location.description 也是图像提示词,要有视觉细节(光线/材质/氛围)
- id 必须是**语义化英文标识**(角色用 char_+姓名拼音,场景用 loc_+拼音,道具用 prop_+拼音):
  它会作为跨集引用的稳定 slug 存进资产库,char_1 / char_2 这种无语义编号在多集复用时会串号`;
    const usr = `剧本大纲:
${JSON.stringify(outline, null, 2)}
${hasRoster ? `\n名单(小说账本抽取,禁止遗漏):\n${JSON.stringify(roster, null, 2)}\n` : ''}
请输出:
{
  "characters": [
    { "id": "char_<姓名拼音>", "name": "姓名", "role": "主角/配角/反派", "age": "30岁",
      "appearance": "外貌描述(供图像生成)", "personality": "性格简介" }
  ],
  "locations": [
    { "id": "loc_<场景名拼音>", "name": "场景名", "description": "视觉描述(供图像生成)", "mood": "氛围" }
  ],
  "props": [
    { "id": "prop_<道具名拼音>", "name": "道具名", "description": "视觉描述", "used_by": ["<角色id>"] }
  ],
  "vehicles": [
    { "id": "veh_<名称拼音>", "name": "载具名", "description": "视觉描述", "used_by": [] }
  ],
  "wardrobe": [
    { "id": "wd_<名称拼音>", "name": "服装名", "description": "视觉描述(只写衣服本身的版型/颜色/面料/细节,禁止写谁在穿、禁止描述人物)", "used_by": ["<角色id>"] }
  ]
}`;

    // 2026-07-31:max_tokens 从 3072 调大到 8192,避免角色/场景/道具多时 JSON 被截断
    const raw = await this.callLlm(ctx, sys, usr, 0.7, 8192);
    const parsed = this.parseJsonSafe(raw);
    if (!parsed || !parsed.characters) throw new BadRequestException('LLM 生成设定失败,请重试');
    return parsed;
  }

  // ── Step 3: 设定图(AGNES image) ──
  // 角色 4 视图: front / side / back / pose
  // 场景图 + 道具图 各 1 张
  async genStep3ConceptArt(input: any, design: any, ctx: LlmCtx, sessionUuid: string): Promise<any> {
    if (!design) throw new BadRequestException('请先生成角色/场景/道具设计');
    const style = input.style || '电影质感, 高细节, 写实';
    const result: any = { characters: [], locations: [], props: [], vehicles: [], wardrobe: [] };

    // 2026-09-05:seed 锁定(方案1)—— input.seed 为基线(未传则保持随机),
    //   每个「会话×资产×角度」稳定哈希偏移:重试同资产同角度必出同一张图。
    //   图像 seed 内容级实测生效(同 seed 同 prompt 两次 SHA256 一致)。
    //   ⚠️ 上游 seed 合法范围 [0,999],偏移后 mod 1000 保持区内且稳定。
    const seedBase = Number.isFinite(Number(input.seed)) ? Number(input.seed) : null;
    const assetSeed = (name: string, angle: string): number | undefined => {
      if (seedBase == null) return undefined;
      const h = createHash('sha1').update(`${sessionUuid}:${name}:${angle}`).digest();
      return (seedBase + h.readUInt32BE(0)) % 1000;
    };

    // 2026-08-28:提示词与「这个资产要出哪几张图」抽到 drama/concept-art.ts 作单一来源,
    //   与剧级资产定妆共用同一实现 —— 两套 prompt 各调各的是角色画飘的头号成因。
    //   v3 调优背景(勿回退):T-pose 只给正面 / 角度关键词强权重前置 / 背面负向词列具体面部特征。
    const shoot = async (kind: string, item: any) => {
      const shots = planAssetShots(kind, item, style);
      const out: any[] = [];
      for (const sh of shots) {
        try {
          const url = await this.callImage(
            ctx, sh.prompt, sh.size, sh.negative || undefined,
            assetSeed(String(item.name || kind), sh.angle),
          );
          out.push({ angle: sh.angle, url, prompt: sh.prompt, negative_prompt: sh.negative });
          this.logger.log(`[step3] ${kind} ${item.name} ${sh.angle} 生成 OK`);
        } catch (e: any) {
          this.logger.warn(`[step3] ${kind} ${item.name} ${sh.angle} 失败: ${e.message}`);
          out.push({ angle: sh.angle, url: null, prompt: sh.prompt, negative_prompt: sh.negative, error: e.message });
        }
      }
      return out;
    };

    for (const char of design.characters || []) {
      result.characters.push({ id: char.id, name: char.name, views: await shoot('character', char) });
    }
    for (const loc of design.locations || []) {
      const [img] = await shoot('location', loc);
      result.locations.push({
        id: loc.id, name: loc.name, url: img?.url ?? null, prompt: img?.prompt, error: img?.error,
      });
    }
    for (const prop of design.props || []) {
      const [img] = await shoot('prop', prop);
      result.props.push({
        id: prop.id, name: prop.name, url: img?.url ?? null, prompt: img?.prompt, error: img?.error,
      });
    }
    // 2026-09-23 批5:vehicles/wardrobe 之前静默丢图 —— step2 生成了设计、
    // indexLegacyConceptArt 也已收编,这里不出图它们就永远没有参考
    for (const veh of design.vehicles || []) {
      const [img] = await shoot('vehicle', veh);
      result.vehicles.push({
        id: veh.id, name: veh.name, url: img?.url ?? null, prompt: img?.prompt, error: img?.error,
      });
    }
    for (const wd of design.wardrobe || []) {
      const [img] = await shoot('wardrobe', wd);
      result.wardrobe.push({
        id: wd.id, name: wd.name, url: img?.url ?? null, prompt: img?.prompt, error: img?.error,
      });
    }

    return result;
  }

  // ── Step 4: 分镜脚本(LLM) ──
  //
  // 2026-09-15 镜头时长策略重定:
  //   旧提示词写「每镜 1.5-6 秒」+ 示例 `duration_sec: 3`,LLM 严格照抄示例 ——
  //   实测 321 个成功镜头里 194 个是 4 秒,每集 14 镜却只出 43 秒成片(目标 120 秒)。
  //   镜头又多又短同时伤害三件事:
  //     ① 速度:上游视频通道每 key 每分钟只准创建 1 个任务,镜头数直接决定排队轮数;
  //     ② 内容量:成片时长 = 成功镜头数 × 单镜时长,只有账本预期的 28%~49%;
  //     ③ 一致性:切镜越多,主角跨镜换脸的机会越多。
  //   新策略:8-12 秒(上游单段硬上限 12 秒),并要求总时长贴合目标。
  //   `:742` 的 clamp(4,12) 保持不变 —— 它只是护栏,真正的时长由这里决定。
  async genStep4Shots(input: any, outline: any, design: any, ctx: LlmCtx): Promise<any> {
    if (!outline) throw new BadRequestException('请先生成剧本大纲');

    // 本集目标总时长:调用方(连集批次)透传 input.targetSec。
    // 拿不到就按微短剧单集的常规体量给 120 秒,别让 LLM 自由发挥。
    const targetSec = Number(input?.targetSec) > 0 ? Math.round(Number(input.targetSec)) : 120;
    // 单镜 5-9 秒(兼顾短视频紧凑节奏与模型运动稳定性) → 目标时长对应的镜头数区间
    const minShots = Math.max(3, Math.floor(targetSec / 9));
    const maxShots = Math.max(minShots + 1, Math.ceil(targetSec / 5));

    const sys = `你是导演 + 分镜师。把剧本拆成分镜 JSON。
要求:
- 严格 JSON,无 markdown
- **每镜 5-9 秒**(单镜切忌超过 10 秒, 彻底避免视频模型在长时自回归中产生面部融化与形变; 避免低于 4 秒导致碎镜)
- **镜头节奏张弛有度**: 开场钩子/冲突重音 4-6 秒(快速抓人), 对话交锋 5-7 秒, 场景与氛围铺垫 6-8 秒
- **所有镜头 duration_sec 之和必须接近本集目标总时长**(见下方"目标总时长"),不要凭感觉缩水
- 因此本集镜头数应落在 ${minShots}-${maxShots} 个之间
- shot_type: 远景/全景/中景/近景/特写
${cameraMotionGuide()}
- description 画面构图必须包含明确的人物肢体动作或环境动态(如走动、转头注视、手部操作、波纹起伏), 严禁毫无动静的静止画面, 彻底杜绝死镜
- dialogue **每镜必填且只能有单个角色说话(最多1-2句核心台词, 12-25字)**: 严禁在同一个镜头内塞进双人甚至多人来回对话(视频模型只能对单口型, 多人对白必造成声音错乱、对口型失败及字幕霸屏); 两人交谈必须分镜头切换表达! 纯环境音写"(只有雨声/脚步/金属摩擦声)"; 旁白写"(旁白)…"
- **因果链(叙事对齐,最高优先)**: 每一镜必须推进所属 scene 的剧情, 严禁东一棒槌西一棒槌的无关联画面堆砌;
  上一镜 end_state 是下一镜 start_state 的起点; description/dialogue 必须服务下方"剧情锚点"里的 quotes 与 summary,
  丢开锚点自由发挥 = 废镜
- **大纲 scene 带 quotes(原文逐字锚点)时**: 该场镜头的 dialogue 与 description 必须基于 quotes 改编 ——
  dialogue 保留 quotes 里台词的含义(可口语化、不可改意), description 保留 quotes 里"谁/在哪/做了什么";
  禁止丢开 quotes 凭 summary 自由发挥
- start_state: 一句话写清本镜开始时的可见状态(承接上一镜 end_state); 首镜写场景初始可见状态
- handoff(多角色镜头): 一句话写清注意/持物/视线交接 —— 谁把什么交给谁、谁的视线从哪移到哪; 只写动作状态转换, 禁止写长相; 单人或无交接填空字符串
- end_state: 一句话写清本镜结束时的可见状态(位置/姿态/持物), 下一镜从这里继续, 确保前后两镜时空与动作衔接自然, 严禁突兀闪现
- **description 禁止描述人物长相/发型/服装/性别**: 这些由角色定妆图决定, 文字再写一遍会和参考图打架导致换脸/变性别。只写构图、动作、环境、光线
${rhythmPromptGuide()}`;
    // 2026-09-23 叙事对齐:把场景剧情锚点(summary+quotes)与原文摘录**显式**塞进
    //   user prompt —— 旧实现只 JSON.stringify(outline),LLM 容易丢掉 quotes,
    //   分镜凭 ≤50 字 summary 重编 = 与小说脱节("东一棒槌西一棒槌"的分镜层根因)。
    const scenesForPrompt = Array.isArray(outline.scenes) ? outline.scenes : [];
    const sceneNarrative = scenesForPrompt.map((s: any) => {
      const qs = Array.isArray(s?.quotes) ? s.quotes : [];
      const qsBit = qs.length ? `\n  原文逐字: ${qs.join(' / ')}` : '';
      const beatIds = Array.isArray(s?.beat_ids) && s.beat_ids.length
        ? `\n  拍点: ${s.beat_ids.join(', ')}` : '';
      return `场景#${s?.idx ?? '?'} ${s?.summary || ''}${qsBit}${beatIds}`;
    }).filter(Boolean).join('\n');
    const excerptBit = String(outline?.anchor?.chapterExcerpt || '').trim()
      ? `\n\n=== 原文摘录(本集分镜必须讲明白的故事,按因果推进) ===\n${String(outline.anchor.chapterExcerpt).slice(0, 2500)}`
      : '';
    const beatsAnchorBit = String(outline?.anchor?.beatsAnchor || '').trim()
      ? `\n\n=== 原文逐字锚点([必拍] 不可省) ===\n${String(outline.anchor.beatsAnchor).slice(0, 2000)}`
      : '';

    const usr = `剧本大纲:
${JSON.stringify(outline, null, 2)}

=== 本集剧情锚点(每一镜的 description/dialogue 必须服务这些拍点) ===
${sceneNarrative || '(大纲无 scenes)'}
${excerptBit}${beatsAnchorBit}

本集目标总时长:${targetSec} 秒(镜头数 ${minShots}-${maxShots} 个,每镜 5-9 秒)

角色设定(供引用):
${JSON.stringify((design?.characters || []).map((c: any) => ({ id: c.id, name: c.name })), null, 2)}

场景设定(供引用):
${JSON.stringify((design?.locations || []).map((l: any) => ({ id: l.id, name: l.name })), null, 2)}

道具(供引用):
${JSON.stringify((design?.props || []).map((p: any) => ({ id: p.id, name: p.name })), null, 2)}

载具(供引用,本场出现时才挂到 shots.vehicles):
${JSON.stringify((design?.vehicles || []).map((v: any) => ({ id: v.id, name: v.name })), null, 2)}

服装(供引用,本场特殊造型时才挂到 shots.wardrobe;角色换装镜优先引用):
${JSON.stringify((design?.wardrobe || []).map((w: any) => ({ id: w.id, name: w.name })), null, 2)}

请输出:
{
  "shots": [
    {
      "idx": 1,
      "scene_idx": 1,
      "duration_sec": 6,
      "shot_type": "中景",
      "camera_motion": "推",
      "rhythm": "hook",
      "description": "林雅快步穿过走廊, 眼神警惕地扫视四周, 步伐急促有力",
      "dialogue": "林雅: 今晚的事, 绝不能让第三个人知道!",
      "characters": ["char_1"],
      "location_id": "loc_1",
      "props": ["prop_1"],
      "vehicles": ["veh_1"],
      "wardrobe": ["wd_1"],
      "start_state": "承接上一镜 end_state 的可见起点(首镜写场景初始状态)",
      "handoff": "(多角色镜头)A 把文件递给 B,B 的视线从桌面移到 A 脸上",
      "end_state": "B 合上文件夹,抬头看向门口"
    }
  ]
}`;

    // 2026-07-31:max_tokens 从 4096 调大到 8192,避免分镜多时 JSON 被截断
    const raw = await this.callLlm(ctx, sys, usr, 0.6, 8192);
    let parsed = this.parseJsonSafe(raw);
    if (!parsed || !parsed.shots) {
      this.logger.error(`[step4] LLM 生成 JSON 解析失败,raw.len=${raw.length}, preview=${raw.slice(0, 200)}`);
      // 2026-09-22:整集报废的代价太大 —— 连集批次 stopOnFailure=false 会**整集跳过**,
      //   EP1 就是这么从成片里消失的。抢救(parseJsonSafe 第 5 层)失败后再重试一次:
      //   降 temperature、压镜头数、压 description 字数,降低再次被截断的概率。
      const retryRaw2 = await this.callLlm(
        ctx,
        `${sys}\n\n[修订要求] 上一次输出不是合法 JSON(多半是被截断)。这次务必:` +
        `① 只输出 JSON,不要 markdown 代码块、不要任何解释文字;` +
        `② 镜头数控制在 ${minShots} 个以内;` +
        `③ description 每条不超过 60 字;④ 确保 JSON 完整闭合。`,
        usr, 0.3, 8192,
      ).catch(() => null);
      if (retryRaw2) {
        const p2 = this.parseJsonSafe(retryRaw2);
        if (p2 && p2.shots) {
          parsed = p2;
          this.logger.log('[step4] 分镜重试一次后成功');
        }
      }
      if (!parsed || !parsed.shots) {
        throw new BadRequestException('LLM 生成分镜失败,请重试');
      }
    }
    const shots0 = Array.isArray(parsed.shots) ? parsed.shots : [];
    const plannedSec0 = shots0.reduce(
      (s: number, sh: any) => s + (Number(sh?.duration_sec) || 0), 0,
    );
    this.logger.log(
      `[step4] 分镜 ${shots0.length} 镜 / 计划总时长 ${plannedSec0}s / 目标 ${targetSec}s`,
    );

    // 2026-09-16(批2)**集尾钩子镜头硬门**:末镜不留悬念 → 带 hook_out 整份重生成一次;
    //   重生成仍不过 → 照交但标 hookShotMissing(批3 前端露出),绝不静默交无钩子集。
    //   之前 hookOut 只活在大纲文本层,镜头层零强制,"集与集联系不起来"的镜头级根因。
    let shots: any[] = shots0;
    let finalParsed: any = parsed;
    let endHook = checkEpisodeEndHook(shots);
    if (!endHook.ok) {
      this.logger.warn(`[step4] 集尾钩子门未过:${endHook.reason} → 带 hook_out 重生成一次`);
      const hookOutText = String(outline?.hook_out || '').slice(0, 160);
      const retryRaw = await this.callLlm(
        ctx,
        `${sys}\n\n[修订要求] 上一版${endHook.reason}。重新输出整份分镜:最后一镜 rhythm 必须是 turn/payoff/hook,` +
        `且其画面与台词要把本集结尾钩子可视化:${hookOutText ? `「${hookOutText}」` : '(自行设计悬念落点)'} —— 留悬念,不要收平。`,
        usr, 0.6, 8192,
      );
      const retryParsed = this.parseJsonSafe(retryRaw);
      if (retryParsed && Array.isArray(retryParsed.shots) && retryParsed.shots.length) {
        finalParsed = retryParsed;
        shots = retryParsed.shots;
        endHook = checkEpisodeEndHook(shots);
        this.logger.log(
          `[step4] 集尾钩子门重生成后:${endHook.ok ? '通过' : `仍未过(${endHook.reason})`}`,
        );
      }
    }
    const hookWarnings = endHook.ok
      ? []
      : [`[集尾钩子门] ${endHook.reason};重生成仍未过,已标 hookShotMissing,建议人工改末镜或重跑本步`];

    // ── 2026-09-23 叙事对齐:slug 归一 + 场景锚点 stamp ─────────────────────
    // · LLM 常把 characters/location 写成中文名或大小写变体 → 归一到资产库 id,
    //   否则 buildKeyframePlan 找不到 slug = 角色永远无参考图(unanchored)。
    // · 每镜 stamp scene_summary/scene_quotes,step6 buildShotVideoPrompt 直接读,
    //   不必再回查 outline(旧路径视频 prompt 零剧情上下文)。
    const charIdSet: Set<string> = new Set((design?.characters || []).map((c: any) => String(c?.id)));
    const charNameToId = new Map<string, string>(
      (design?.characters || []).map((c: any) => [String(c?.name || '').trim(), String(c?.id)] as [string, string]),
    );
    const locIdSet: Set<string> = new Set((design?.locations || []).map((l: any) => String(l?.id)));
    const locNameToId = new Map<string, string>(
      (design?.locations || []).map((l: any) => [String(l?.name || '').trim(), String(l?.id)] as [string, string]),
    );
    const propIdSet: Set<string> = new Set((design?.props || []).map((p: any) => String(p?.id)));
    const propNameToId = new Map<string, string>(
      (design?.props || []).map((p: any) => [String(p?.name || '').trim(), String(p?.id)] as [string, string]),
    );
    const vehIdSet: Set<string> = new Set((design?.vehicles || []).map((v: any) => String(v?.id)));
    const vehNameToId = new Map<string, string>(
      (design?.vehicles || []).map((v: any) => [String(v?.name || '').trim(), String(v?.id)] as [string, string]),
    );
    const wdIdSet: Set<string> = new Set((design?.wardrobe || []).map((w: any) => String(w?.id)));
    const wdNameToId = new Map<string, string>(
      (design?.wardrobe || []).map((w: any) => [String(w?.name || '').trim(), String(w?.id)] as [string, string]),
    );
    const normId = (raw: any, idSet: Set<string>, nameToId: Map<string, string>): string | null => {
      const s = String(raw ?? '').trim();
      if (!s) return null;
      if (idSet.has(s)) return s;
      const byName = nameToId.get(s) || nameToId.get(s.toLowerCase());
      if (byName) return byName;
      return null; // 库内不认识的 slug 直接丢弃(进 unresolved,不污染分镜)
    };
    const sceneByIdx = new Map<number, any>(
      scenesForPrompt.map((s: any) => [Number(s?.idx), s]),
    );
    shots = shots.map((sh: any) => {
      const sc: any = sceneByIdx.get(Number(sh?.scene_idx)) || null;
      return {
        ...sh,
        characters: (Array.isArray(sh?.characters) ? sh.characters : [])
          .map((c: any) => normId(c, charIdSet, charNameToId))
          .filter(Boolean),
        location_id: normId(sh?.location_id, locIdSet, locNameToId) || undefined,
        props: (Array.isArray(sh?.props) ? sh.props : [])
          .map((p: any) => normId(p, propIdSet, propNameToId))
          .filter(Boolean),
        vehicles: (Array.isArray(sh?.vehicles) ? sh.vehicles : [])
          .map((v: any) => normId(v, vehIdSet, vehNameToId))
          .filter(Boolean),
        wardrobe: (Array.isArray(sh?.wardrobe) ? sh.wardrobe : [])
          .map((w: any) => normId(w, wdIdSet, wdNameToId))
          .filter(Boolean),
        scene_summary: String(sc?.summary || ''),
        scene_quotes: Array.isArray(sc?.quotes) ? sc.quotes.map(String).filter(Boolean) : [],
      };
    });
    // 因果链落库:handoff/end_state 只请求不校验会静默丢,这里只 warning 不拦
    const missingHandoff = shots.filter((sh: any) => !String(sh?.handoff || '').trim()
      && (Array.isArray(sh?.characters) && sh.characters.length > 1)).length;
    const missingEnd = shots.filter((sh: any) => !String(sh?.end_state || '').trim()).length;
    const missingRhythm = shots.filter((sh: any) => !String(sh?.rhythm || '').trim()).length;
    const handoffChainWarnings: string[] = [];
    if (missingHandoff) handoffChainWarnings.push(`多角色镜缺 handoff ${missingHandoff} 处`);
    if (missingEnd) handoffChainWarnings.push(`缺 end_state ${missingEnd} 处`);
    if (missingRhythm) handoffChainWarnings.push(`缺 rhythm ${missingRhythm} 处`);
    if (handoffChainWarnings.length) {
      this.logger.warn(`[step4] 因果链字段不全:${handoffChainWarnings.join(';')}`);
    }

    let plannedSec = shots.reduce(
      (s: number, sh: any) => s + (Number(sh?.duration_sec) || 0), 0,
    );

    // ── 2026-09-22 集时长硬校准 ──────────────────────────────────────────
    // 实测:目标 120s,LLM 只给 14 镜 × 5.9s = 83s(-31%)。prompt 里已经写了
    //   "所有镜头 duration_sec 之和必须接近目标总时长",仍然每次都取镜头数下限 +
    //   每镜取短时长 —— 这是 LLM 的稳定偏置,靠再写一遍提示词改不掉。
    //   按铁律「能脚本硬校验的绝不交 LLM」,这里做确定性缩放 + 残差分摊:
    //     ① 按比例缩放每镜时长并 clamp 到 [SHOT_MIN, SHOT_MAX]
    //     ② clamp 截断造成的残差,按镜序 ±1s 摊平,直到进入 ±5% 容差
    //     ③ 减时长时跳过末镜 —— 末镜是集尾钩子,不该被削
    const SHOT_MIN = 5;
    const SHOT_MAX = 10; // 上游单段硬上限 12,留 2s 余量
    if (shots.length > 0 && targetSec > 0 && plannedSec > 0) {
      const ratio = targetSec / plannedSec;
      if (ratio < 0.95 || ratio > 1.05) {
        let acc = 0;
        shots = shots.map((sh: any) => {
          const d0 = Number(sh?.duration_sec) || 0;
          const d = Math.min(SHOT_MAX, Math.max(SHOT_MIN, Math.round(d0 * ratio)));
          acc += d;
          return { ...sh, duration_sec: d };
        });
        const lo = Math.floor(targetSec * 0.95);
        const hi = Math.ceil(targetSec * 1.05);
        let guard = 0;
        // 不够 → 逐镜 +1s(末镜也参与,钩子镜长一点无害)
        while (acc < lo && guard++ < 500) {
          let moved = false;
          for (let i = 0; i < shots.length && acc < lo; i++) {
            if ((Number(shots[i].duration_sec) || 0) < SHOT_MAX) {
              shots[i].duration_sec = (Number(shots[i].duration_sec) || 0) + 1;
              acc += 1; moved = true;
            }
          }
          if (!moved) break; // 全到上限,放弃(说明镜头数本身不够,靠加时长补不回来)
        }
        // 超了 → 逐镜 -1s(从首镜开始,末镜最后才动)
        while (acc > hi && guard++ < 1000) {
          let moved = false;
          for (let i = 0; i < shots.length && acc > hi; i++) {
            if (i === shots.length - 1 && shots.length > 1) continue; // 先不动钩子镜
            if ((Number(shots[i].duration_sec) || 0) > SHOT_MIN) {
              shots[i].duration_sec = (Number(shots[i].duration_sec) || 0) - 1;
              acc -= 1; moved = true;
            }
          }
          if (!moved) {
            // 只剩末镜还能减
            const last = shots.length - 1;
            if (shots.length === 1 || (Number(shots[last].duration_sec) || 0) <= SHOT_MIN) break;
            shots[last].duration_sec = (Number(shots[last].duration_sec) || 0) - 1;
            acc -= 1;
          }
        }
        this.logger.log(
          `[step4] 时长硬校准: ${plannedSec}s → ${acc}s (目标 ${targetSec}s,` +
          ` ${shots.length} 镜, 缩放比 ${ratio.toFixed(2)})`,
        );
        plannedSec = acc;
      }
    }
    // ── 时长硬校准结束 ────────────────────────────────────────────────────

    // P0-b(借 reelbench):画面描述质检门 —— 空话/过短/废话开头/重复。MVP 只出 warnings 不硬拦。
    const descViolations = checkShotDescriptions(shots);
    const descWarnings = summarizeDescViolations(descViolations);
    if (descWarnings.length) {
      this.logger.warn(`[step4] 画面描述质检:${descWarnings.join(';')}`);
    }
    // P1-d(借 reelbench):节奏角色整集校验 —— 开篇钩子/铺垫-兑现/节奏平。只提示不拦。
    const rhythmReport = checkEpisodeRhythm(shots);
    if (rhythmReport.warnings.length) {
      this.logger.warn(`[step4] 节奏质检:${rhythmReport.warnings.join(';')}`);
    }
    return {
      ...finalParsed,
      shots,
      // 2026-09-16(批3 透明工作台):分镜提示词落库,用户能核对"导演拿到了什么要求"
      prompt_used: { system: sys, user: usr },
      descWarnings, descViolationCount: descViolations.length,
      rhythmWarnings: [...rhythmReport.warnings, ...hookWarnings],
      rhythmDistribution: rhythmReport.distribution,
      rhythmTagged: rhythmReport.tagged,
      hookShotMissing: !endHook.ok,
      endHook: { ok: endHook.ok, lastRole: endHook.lastRole, lastIdx: endHook.lastIdx, reason: endHook.reason },
      // 2026-09-22:成片时长对账用 —— 校准后的计划总时长与本集目标,对齐报告直接取这两个数
      plannedSec, targetSec,
    };
  }

  // ── Step 5: 分镜关键帧(AGNES image,每镜 1 张) ──
  // 2026-07-31:改为并行生成 + 多 key 负载均衡
  //   之前串行 for 循环,20 张图片每张 10-30 秒,总耗时 3-10 分钟。
  //   现在用 Promise.all 并行,3 个 key 轮询分配,理论提速 ~3倍(1-3 分钟)。
  //   每个 key 轮询分配,避免单 key 触发限流。
  async genStep5Keyframes(
    input: any, shots: any, conceptArt: any, design: any,
    ctx: LlmCtx, sessionUuid: string, options: any,
  ): Promise<any> {
    if (!shots || !shots.shots) throw new BadRequestException('请先生成分镜脚本');
    // 2026-09-22:分段计时。实测(18 key 池)图像 API 本身很快 —— 无参考图 ~9s、
    // 1 张参考图 ~21s、2 张 ~30s,且**并发度不影响单张耗时**(并发 3/9/18 总墙钟都是 ~30s)。
    // 而批次日志显示关键帧这一步整段要 6~8 分钟,和 API 耗时差一个数量级。
    // 差额到底在"参考图准备 / 出图 / 收尾落库"哪一段,以前只能猜,现在打点。
    const tStep0 = Date.now();

    // 2026-08-28:从「把 step3 的 prompt 文字拼回去做纯文生图」改为**参考图驱动**。
    //   文字描述锁不住一张脸,这是换集换脸的根因;规划逻辑在 drama/keyframe-plan.ts,
    //   与剧级流程共用一份实现。
    const styleSpec = {
      stylePrompt: input.style || '电影质感, 高细节',
      negativePrompt: input.negative_prompt || '',
      keyframeSize: input.size || '1280x720',
      // 2026-09-15:画幅对齐 —— 关键帧跟随视频 aspect_ratio(档位制),不再横屏图喂竖屏视频被裁切
      aspectRatio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : undefined,
    };
    const bySlug = indexLegacyConceptArt(conceptArt, design);
    const plans = shots.shots.map((sh: any) => buildKeyframePlan(sh, bySlug, styleSpec));
    const sum = summarizePlans(plans);
    const tPlan = Date.now() - tStep0;
    const refCount = plans.reduce((n, p) => n + ((p.refUrls || []).length), 0);
    this.logger.log(
      `[step5] 参考图驱动关键帧:${sum.withRef}/${sum.total} 镜带参考图,` +
      `${sum.degraded} 镜无参考图退化为文生图;待重定妆:${sum.needReportrait.join(',') || '无'}`,
    );
    this.logger.log(
      `[step5][计时] 规划 ${tPlan}ms;参考图合计 ${refCount} 张` +
      `(均 ${plans.length ? (refCount / plans.length).toFixed(1) : 0} 张/镜)`,
    );

    // 并行生成,每个任务轮询分配 key(单张失败不影响其他)
    // 2026-09-05:seed 锁定(方案1)—— input.seed 基线 + 镜号偏移,补画同镜同图。
    //   ⚠️ 上游 seed 范围 [0,999],偏移后 mod 1000。
    const kfSeedBase = Number.isFinite(Number(input.seed)) ? Number(input.seed) : null;
    const tasks = plans.map((plan) => {
      const apiKey = this.nextKey();
      const kfSeed = kfSeedBase != null
        ? (kfSeedBase + (Number(plan.shotIdx) || 0)) % 1000
        : undefined;
      return (async () => {
        try {
          const url = await this.callImageWithKey(
            apiKey, plan.prompt, plan.size, plan.negative, plan.refUrls,
            plan.ratio, kfSeed,
          );
          return {
            shot_idx: plan.shotIdx, url, prompt: plan.prompt,
            ref_urls: plan.refUrls, ref_sources: plan.refSources,
            degraded: plan.degraded,
            unanchored_characters: plan.unanchoredCharacters,
          };
        } catch (e: any) {
          // 2026-09-23 身份:兜底首帧只允许 character 参考图(与 drama.service ep-step3 同一条规则)
          const charSrc = (plan.refSources || []).find(
            (s: any) => s?.kind === 'character' && s?.sent
              && typeof s?.url === 'string' && /^https?:\/\//i.test(s.url),
          );
          const fallbackUrl = charSrc?.url || null;
          if (fallbackUrl) {
            this.logger.warn(`[step5] 镜 #${plan.shotIdx} 出图失败(${e?.message}), 自动使用角色定妆图兜底关键帧首帧`);
            return {
              shot_idx: plan.shotIdx, url: fallbackUrl, prompt: plan.prompt,
              ref_urls: plan.refUrls, ref_sources: plan.refSources,
              degraded: plan.degraded, fallback_to_ref: true,
              unanchored_characters: plan.unanchoredCharacters,
            };
          }
          if ((plan.refUrls || []).length) {
            this.logger.warn(
              `[step5] 镜 #${plan.shotIdx} 出图失败且无 character 参考图可兜底(拒绝场景图当身份锚):${e.message}`,
            );
          }
          return {
            shot_idx: plan.shotIdx, url: null, prompt: plan.prompt,
            ref_urls: plan.refUrls, ref_sources: plan.refSources,
            degraded: plan.degraded, error: e.message,
            unanchored_characters: plan.unanchoredCharacters,
          };
        }
      })();
    });

    const tGen0 = Date.now();
    const keyframes = await Promise.all(tasks);
    const tGen = Date.now() - tGen0;
    const okCount = keyframes.filter((k: any) => k.url).length;
    this.logger.log(`[step5] 关键帧完成 ${okCount}/${keyframes.length}(带参考图 ${sum.withRef} 镜)`);
    this.logger.log(
      `[step5][计时] 出图 ${tGen}ms(${(tGen / 1000).toFixed(1)}s) / ${keyframes.length} 镜并行;` +
      `本步累计 ${Date.now() - tStep0}ms —— 若出图只占一小截,时间就花在调用方或落库上`,
    );

    return {
      keyframes,
      // 交给前端提示「这些角色/场景没有可用参考图,建议重定妆后再抽帧」
      missing_refs: sum.needReportrait,
      ref_backed: sum.withRef,
      degraded_count: sum.degraded,
      unanchored_count: keyframes.filter((k: any) =>
        Array.isArray(k.unanchored_characters) && k.unanchored_characters.length > 0).length,
    };
  }

  // ── Step 6: 分镜视频(AGNES video,图生视频 i2v) ──
  // 2026-07-31:改为并行生成 + 多 key 负载均衡。
  // 2026-08-09:Agnes 视频 API 限流「每 key 每分钟 1 次创建」,之前 Promise.all
  //   同一秒打 16 个创建请求,每个 key 只有第 1 个成功,其余全 429(16 镜只成 3 个)。
  //   现在:① 创建前按 key 排队等限流窗口(acquireVideoCreateSlot)+ 429 退避重试;
  //        ② 增量重生成——默认复用上次已成功的视频,只重跑失败/缺失的镜头,
  //           避免用户重试一次就把已成功的镜头再烧一遍配额;input.force=true 才全量重跑。
  async genStep6ShotVideos(
    input: any, keyframes: any, shots: any, ctx: LlmCtx, sessionUuid: string, options: any,
    prevOutput?: any,
  ): Promise<any> {
    if (!keyframes || !keyframes.keyframes) throw new BadRequestException('请先生成关键帧');

    const keyframeMap: Record<number, string> = {};
    for (const k of keyframes.keyframes) {
      if (k.url) keyframeMap[k.shot_idx] = k.url;
    }

    const shotMap: Record<number, any> = {};
    for (const s of shots?.shots || []) shotMap[s.idx] = s;

    // 增量复用:收集上次已 completed 且有 video_url 的镜头
    //   复用前先探测 URL 存活(对象可能过期 404),失效的镜头自动重生成
    const force = input?.force === true;
    // 单镜补做:整集一次跑完要十几分钟以上(每 key 每分钟只能创建 1 次),
    // 指定 shotIdx 时只生成这一镜,其余原样保留,让前端可以逐镜推进度。
    const onlyShot = Number.isFinite(Number(input?.shotIdx)) && input?.shotIdx != null
      ? Number(input.shotIdx) : null;
    const prevMap: Record<number, any> = {};
    for (const s0 of prevOutput?.shots || []) if (s0 && s0.shot_idx != null) prevMap[s0.shot_idx] = s0;
    const reuseMap: Record<number, any> = {};
    if (!force && Array.isArray(prevOutput?.shots)) {
      const candidates = prevOutput.shots.filter(
        (s: any) => s && s.status === 'completed' && s.video_url,
      );
      const checks = await Promise.all(
        candidates.map(async (s: any) => ({ s, alive: await this.isUrlAlive(s.video_url) })),
      );
      for (const { s, alive } of checks) {
        if (alive) {
          reuseMap[s.shot_idx] = s;
        } else {
          this.logger.warn(`[step6] 镜头 ${s.shot_idx} 旧视频 URL 已失效,将重新生成`);
        }
      }
    }
    const reuseCount = Object.keys(reuseMap).length;

    // 2026-08-28:视频画幅跟随用户选择(input.aspect_ratio),不再硬编码 9:16
    //   2.5-flash 合法值:21:9/16:9/4:3/1:1/3:4/9:16;非法/缺省回退 9:16(竖屏默认)
    const LEGAL_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
    const videoAspect = LEGAL_ASPECTS.includes(input?.aspect_ratio)
      ? input.aspect_ratio
      : '9:16';

    // 2026-09-05:音频参考(方案8)—— 调用方显式传 input.audios(公网音频 URL 数组,≤3)
    //   才启用。启用后本步所有镜头切 reference 模式(images[0]=关键帧 + audios),
    //   失去硬首帧锁定但画面会随音频节奏/氛围起舞。默认不传 = 原 keyframe 路径零变化。
    const rawAudios = Array.isArray(input?.audios) ? input.audios
      : (typeof input?.audios === 'string' && input.audios ? [input.audios] : []);
    const audioRefs = rawAudios
      .filter((u: any) => typeof u === 'string' && /^https?:\/\//i.test(u))
      .slice(0, 3);

    // 2026-09-05:seed 锁定(方案1)—— input.seed 为全剧基线,逐镜 +shot_idx 偏移,
    //   补做/重试同一镜必同一果;不传则保持原随机行为。
    const seedBase = Number.isFinite(Number(input?.seed)) ? Number(input.seed) : null;

    // 2026-09-15:资产库角色名表 —— 透传给 dialogue 净化器,让它在「××地说」「愤怒的××」
    //   里也能精确认出说话人、并拆分一镜多说话人。拿不到时净化器保守处理(不猜名字),
    //   台词仍然干净,只是 speaker 可能为 null(字幕不拼前缀,不影响观感)。
    const knownNames: string[] = Array.isArray(input?.knownNames)
      ? input.knownNames.map((n: any) => String(n || '').trim()).filter(Boolean)
      : (Array.isArray(options?.knownNames)
          ? options.knownNames.map((n: any) => String(n || '').trim()).filter(Boolean)
          : []);

    // 并行生成所有「需要生成」的分镜视频,每个任务用轮询分配的 key
    //
    // 镜头级进度(2026-09-15):`Promise.all` 全有或全无 —— 11 个镜头里只要有
    //   1 个没回来,整个步骤不返回、`stepData["4"]` 不落库,中间进度对前端
    //   完全不可见。用户能看到的只有一条「视频渲染中,已等 19 分钟」,
    //   而这既可能是"才开头"也可能是"快完了",只能被理解成卡死(实测误判)。
    //   分母用本集全部镜头,复用/跳过/非补做目标的镜头不占视频通道,
    //   开局即计入分子 —— 于是分子单调递增,是真正可看的进度。
    const totalShots = keyframes.keyframes.length;
    let presettled = 0;
    let settledShots = 0;
    let failedShots = 0;
    // 2026-09-24 首发错峰:genShot 闭包按 fan-out 顺序取号,第 N 个启动的先等
    //   N×1.5s(封顶 12s)+抖动 —— 14 镜不再同秒齐发撞全局队列。复用/跳过路径
    //   在取号前直接返回,不占错峰序号。
    let launchSeq = 0;
    const bumpShot = (okShot: boolean) => {
      settledShots++;
      if (!okShot) failedShots++;
      // 标签保持中性:写成「镜失败」会让用户以为已落定的 5 个全挂了,
      // 而它只是"最后一个落定的镜头恰好失败"。失败数单独摆在括号里。
      reportShotProgress(
        settledShots, totalShots,
        failedShots > 0 ? `镜已完成(失败 ${failedShots})` : '镜已完成',
      );
    };
    const genShot = (k: any, imgUrlOverride: string | null): Promise<any> => {
      // 上次已成功的镜头直接复用,不占 key、不烧配额
      if (reuseMap[k.shot_idx]) {
        presettled++;
        return Promise.resolve({ ...reuseMap[k.shot_idx], reused: true });
      }
      // 只补做指定镜头时,其余镜头原样带过(不丢进度、不重复烧分)
      if (onlyShot != null && k.shot_idx !== onlyShot) {
        presettled++;
        return Promise.resolve(
          prevMap[k.shot_idx] || { shot_idx: k.shot_idx, video_url: null, status: 'pending' },
        );
      }
      const shot = shotMap[k.shot_idx];
      let imgUrl = imgUrlOverride || keyframeMap[k.shot_idx];
      // 2026-09-21: 镜头防丢容灾 —— 绝不因为单镜关键帧缺失就轻易 skipped 导致成片缺戏硬跳!
      // 2026-09-23 身份收紧:兜底只认 character 参考图;跨镜兜底必须同场景 + 同 cast
      //   (旧逻辑 ref_urls[0] / 前序任意镜 → 会把别的人/场景当首帧 → 变性别/换人)。
      if (!imgUrl) {
        const curShot = shot;
        const curLoc = String(curShot?.location_id || '');
        const curCast = new Set(
          (Array.isArray(curShot?.characters) ? curShot.characters : [])
            .map((c: any) => String(c || '').trim()).filter(Boolean),
        );
        const castEq = (a?: string[], b?: string[]) => {
          const sa = new Set((a || []).map(String).filter(Boolean));
          const sb = new Set((b || []).map(String).filter(Boolean));
          if (sa.size !== sb.size) return false;
          for (const x of sa) if (!sb.has(x)) return false;
          return true;
        };
        // ① 优先从该镜关键帧的 character 参考图取一张作为首帧
        const kfItem = (keyframes.keyframes || []).find((x: any) => x.shot_idx === k.shot_idx);
        const charSrc = (kfItem?.ref_sources || []).find(
          (s: any) => s?.kind === 'character' && typeof s?.url === 'string'
            && /^https?:\/\//i.test(s.url),
        );
        if (charSrc?.url) {
          imgUrl = charSrc.url;
          this.logger.warn(`[step6] 镜 #${k.shot_idx} 关键帧缺失, 自动使用角色定妆参考图兜底首帧`);
        } else {
          // ② 前序镜兜底:必须同 location 且 characters 全等(含顺序无关集合相等)
          const anyPrevKf = [...(keyframes.keyframes || [])]
            .filter((x: any) => {
              if (x.shot_idx >= k.shot_idx) return false;
              const prevShot = shotMap[x.shot_idx];
              const prevLoc = String(prevShot?.location_id || '');
              if (curLoc && prevLoc && prevLoc !== curLoc) return false;
              if (!castEq(
                Array.isArray(prevShot?.characters) ? prevShot.characters : [],
                Array.isArray(curShot?.characters) ? curShot.characters : [],
              )) return false;
              return !!(keyframeMap[x.shot_idx] || (Array.isArray(x.ref_urls) && x.ref_urls[0]));
            })
            .pop();
          const fallbackUrl = anyPrevKf
            ? (keyframeMap[anyPrevKf.shot_idx]
              || ((anyPrevKf.ref_urls || []).find((u: string) => typeof u === 'string' && /^https?:\/\//i.test(u)) as string)
              || null)
            : null;
          if (fallbackUrl) {
            imgUrl = fallbackUrl;
            this.logger.warn(`[step6] 镜 #${k.shot_idx} 关键帧缺失, 自动使用同场景同cast前序镜 #${anyPrevKf.shot_idx} 画面兜底`);
          } else {
            this.logger.warn(
              `[step6] 镜 #${k.shot_idx} 无关键帧且无同场景同cast前序可兜底(loc=${curLoc || '?'}, cast=${[...curCast].join(',') || '空'}), 标记 skipped`,
            );
          }
        }
      }
      // 无关键帧且无任何参考图可兜底的才返回 skipped
      if (!imgUrl) {
        presettled++;
        this.logger.error(`[step6] 镜 #${k.shot_idx} 无任何可用关键帧或参考图, 标记 skipped`);
        return Promise.resolve({
          shot_idx: k.shot_idx, video_url: null, status: 'skipped', reason: 'no keyframe',
        });
      }
      const apiKey = this.nextKey(); // 每个任务拿不同 key
      // 2026-08-27:agnes-video-2.5-flash seconds 合法范围 "4"-"12",低于 4 的分镜 clamp 到 4
      // 2026-09-15/2026-09-21: 与 genStep4Shots 的「每镜 5-9 秒」策略保持一致, 默认兜底 6s
      const duration = Math.max(4, Math.min(12, Math.round(shot?.duration_sec || 6)));

      // 2026-09-05:运动语言提示词(方案2)—— 不再把给图像写的构图描述直接丢给
      //   视频模型,而是翻译成"镜头怎么动 + 主体怎么动 + 真实性底线"。
      //   reference 模式(带音频)时追加 <Picture 1>/<Audio 1> 引导。
      // 2026-09-14(drama-skills 方法论):透传 characters/handoff/起止状态 ——
      //   >1 人同帧自动追加多人物守卫(身份区隔/手部持物/视线轮转),
      //   handoff 原样进 prompt,end_state 让下一镜有明确接缝。
    // 2026-09-15:**补传 dialogue** —— 之前这里漏了台词,视频模型不知道要说什么,
    //   只会自由发挥含糊人声,成片听不到剧本文本(用户反馈"没有对话"的根因之一)。
    //   Agnes video 2.5-flash 本身输出人声音轨,台词写进 prompt 才会说对内容。
    // 2026-09-23:storyBeat/prevEndState —— 5-10s 片段要知道在讲哪一场戏 + 承接上一镜终点,
    //   否则纯运动指令堆叠 = 画面会动但剧情看不懂("东一棒槌西一棒槌"的视频层根因)。
    const storyBeat = [
      String(shot?.scene_summary || '').trim(),
      ...(Array.isArray(shot?.scene_quotes) ? shot.scene_quotes.map(String).filter(Boolean) : []),
    ].filter(Boolean).join(' | ');
    const orderedShotIdxs = Object.keys(shotMap).map(Number).sort((a, b) => a - b);
    const shotPos = orderedShotIdxs.indexOf(Number(k.shot_idx));
    const prevShotObj = shotPos > 0 ? shotMap[orderedShotIdxs[shotPos - 1]] : null;
    const prevEndState = String(prevShotObj?.end_state || '').trim();
    const videoPrompt = buildShotVideoPrompt(
      {
        description: shot?.description,
        shot_type: shot?.shot_type,
        camera_motion: shot?.camera_motion,
        rhythm: typeof shot?.rhythm === 'string' ? shot.rhythm : undefined,
        characters: Array.isArray(shot?.characters) ? shot.characters : undefined,
        handoff: typeof shot?.handoff === 'string' ? shot.handoff : undefined,
        start_state: typeof shot?.start_state === 'string' ? shot.start_state : undefined,
        end_state: typeof shot?.end_state === 'string' ? shot.end_state : undefined,
        dialogue: typeof shot?.dialogue === 'string' ? shot.dialogue : undefined,
      },
      {
        fallback: k.prompt,
        styleTail: typeof input?.style === 'string' ? input.style : undefined,
        referenceMode: audioRefs.length > 0,
        refImageCount: audioRefs.length > 0 ? 1 : 0,
        refAudioCount: audioRefs.length,
        knownNames,
        storyBeat: storyBeat || undefined,
        prevEndState: shotPos > 0 ? (prevEndState || undefined) : undefined,
        rhythm: typeof shot?.rhythm === 'string' ? shot.rhythm : undefined,
      },
    );
      // 逐镜 seed 偏移(方案1):同基线 + 镜号,补做/重试可复现。
      //   ⚠️ 上游 seed 范围 [0,999],偏移后 mod 1000。
      // 2026-09-24 回炉换 seed:之前失败过的镜(503 出局/硬冻回炉)用原 seed 重烧,
      //   同 seed + 同首帧大概率复现同一结果 → 补做白烧。prev 非 completed 且记过
      //   seed → +17 链式偏移(仍确定可复现,只是换一条分布);首烧与成功镜不动。
      const shotSeed = seedBase != null
        ? (seedBase + (Number(k.shot_idx) || 0)) % 1000
        : undefined;
      const prevEntry = prevMap[k.shot_idx];
      const prevSeed = Number(prevEntry?.seed);
      const effectiveSeed = (shotSeed != null && prevEntry && prevEntry.status !== 'completed'
        && Number.isFinite(prevSeed))
        ? (prevSeed + 17) % 1000
        : shotSeed;
      if (effectiveSeed !== shotSeed) {
        this.logger.log(`[step6] 镜 #${k.shot_idx} 回炉换 seed ${shotSeed}→${effectiveSeed}(避复现)`);
      }

      // 返回一个独立捕获异常的 Promise(单个失败不影响其他)
      // 2026-09-16:进 i2v 信号量槽位 —— 控制在飞视频数,防上游队列饱和 503
      // 2026-09-24:渲染槽位只管"在飞",创建另有创建槽位 + 首发错峰(见上)
      const launchOrder = launchSeq++;
      return (async () => {
        if (launchOrder > 0) {
          const staggerMs = videoCreateStaggerMs(launchOrder);
          if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
        }
        const releaseSlot = await this.acquireI2vSlot();
        const t0 = Date.now();
        try {
          const videoUrl = await this.callVideoI2vWithKey(
            apiKey, videoPrompt, imgUrl, duration, videoAspect,
            { seed: effectiveSeed, audios: audioRefs },
          );
          bumpShot(true);
          this.logger.log(
            `[step6] 镜 #${k.shot_idx} i2v 完成 ${Date.now() - t0}ms` +
            `(${duration}s,relay=${imgUrlOverride ? 'tail' : 'kf'},seed=${effectiveSeed ?? '-'})`,
          );
          return {
            shot_idx: k.shot_idx,
            video_url: videoUrl,
            duration_sec: duration,
            status: 'completed',
            prompt: videoPrompt,
            audio_referenced: audioRefs.length > 0,
            seed: effectiveSeed ?? null,
          };
        } catch (e: any) {
          bumpShot(false);
          // 结构化失败信号:on-call 要能从一条日志回答「哪一镜、多久、什么错」
          this.logger.error(
            `[step6] 镜 #${k.shot_idx} i2v 失败 ${Date.now() - t0}ms: ${e.message || e}`,
          );
          // 2026-09-24:失败也记 seed,下次回炉据此链式偏移(不记就永远同 seed 复现)
          return {
            shot_idx: k.shot_idx, video_url: null, status: 'failed',
            error: e.message, seed: effectiveSeed ?? null,
          };
        } finally {
          releaseSlot();
        }
      })();
    };

    // P1-a 尾帧接力:同场景/handoff/共享角色的相邻镜组成链,
    //   链内**顺序**生成 —— 后镜用前镜成片的真实尾帧(抽帧→OSS 公网 URL)当 i2v 首帧参考形成画面接力;
    //   链间仍并行(跨 key)。
    //   2026-09-16(批2):**默认开**(DRAMA_SHOT_RELAY=0 可关)—— 之前默认关等于线上从没通电,
    //   画面承接缺失是"断断续续"的画面层根因之一。
    //   ⚠️ 顺序化受"每 key 每分钟 1 次创建"限速:代价≈最长链长×63s,故只链同场景(见 groupIntoChains);
    //   与 i2v 信号量叠加后上游队列不再饱和,限速等待是可控成本。
    const relayOn = String(process.env.DRAMA_SHOT_RELAY || '1').trim() !== '0'
      && onlyShot == null && audioRefs.length === 0 && !!this.oss;
    let results: any[];
    if (relayOn) {
      const relayShots = keyframes.keyframes.map((k: any) => ({
        idx: k.shot_idx,
        location_id: shotMap[k.shot_idx]?.location_id,
        characters: Array.isArray(shotMap[k.shot_idx]?.characters) ? shotMap[k.shot_idx].characters : undefined,
        handoff: typeof shotMap[k.shot_idx]?.handoff === 'string' ? shotMap[k.shot_idx].handoff : undefined,
      }));
      const rplan = planShotRelay(relayShots, { enabled: true });
      const chains = groupIntoChains(keyframes.keyframes.map((k: any) => k.shot_idx), rplan.pairs);
      const longest = chains.reduce((m, c) => Math.max(m, c.length), 0);
      const relayDir = path.join(this.sessionsDir, sessionUuid, 'relay');
      this.logger.log(
        `[step6] 尾帧接力启用:${chains.length} 条链(最长 ${longest} 镜)/接力对 ${rplan.pairs.length}/硬切 ${rplan.hardCuts.length}/i2v并发度 ${this.i2vConcurrency()}`,
      );
      settledShots = 0;
      const chainResults = await Promise.all(chains.map(async (chain) => {
        const out: any[] = [];
        let prevTail: string | null = null;
        for (const shotIdx of chain) {
          const k = keyframes.keyframes.find((x: any) => x.shot_idx === shotIdx);
          if (!k) continue;
          const r = await genShot(k, prevTail); // 链内顺序:等前一镜落定再抽尾帧喂下一镜
          out.push(r);
          prevTail = (r && r.status === 'completed' && r.video_url)
            ? await this.extractTailFramePublicUrl(r.video_url, relayDir, shotIdx)
            : null;
        }
        return out;
      }));
      results = chainResults.flat().sort((a: any, b: any) => Number(a.shot_idx) - Number(b.shot_idx));
    } else {
      const tasks = keyframes.keyframes.map((k: any) => genShot(k, null));
      // 基线:复用 / 跳过 / 非补做目标的镜头在 tasks 构建时就已"完成",
      //   先报一次,否则进度条会从 0 起跳,看起来像刚开工。
      settledShots = presettled;
      reportShotProgress(settledShots, totalShots, '镜已完成');
      // Promise.all 并行执行,保留原始顺序
      results = await Promise.all(tasks);
    }
    const okCount = results.filter((r: any) => r.status === 'completed').length;
    const skipCount = results.filter((r: any) => r.status === 'skipped').length;
    const failCount = results.filter((r: any) => r.status === 'failed').length;
    this.logger.log(
      `[step6] 分镜视频完成:共 ${results.length} 段,复用 ${reuseCount},成功 ${okCount}/跳过 ${skipCount}/失败 ${failCount}` +
      `(key 池 ${this.agnesKeys.length} 把,每 key 限 1 次/分钟)` +
      `${audioRefs.length ? `,音频参考 ${audioRefs.length} 段(reference 模式)` : ''}` +
      `${seedBase != null ? `,seed 基线 ${seedBase}` : ''}`,
    );

    return { shots: results };
  }

  /** 探测远程 URL 是否仍可访问(仅 HEAD 级探测,不下全文)。404/410 判死,其余情况保守判活 */
  private async isUrlAlive(url: string): Promise<boolean> {
    try {
      const resp = await axios.get(url, {
        responseType: 'stream',
        timeout: 20_000,
        validateStatus: () => true,
        headers: { Range: 'bytes=0-0' },
      });
      try { resp.data?.destroy?.(); } catch (_) { /* 忽略 */ }
      return resp.status !== 404 && resp.status !== 410;
    } catch (_) {
      // 网络抖动等探测失败:保守判活,避免浪费重生成配额
      return true;
    }
  }

  // ── Step 7: 合成视频（下载分镜 → 归一化 → 词级对齐 → 时间轴 → 烧字幕） ──
  //
  // 2026-09-15 重构：字幕从「按镜头时长线性累加」改为「语义锚点时间轴」。
  //   旧做法的致命缺陷：台词是 Agnes 视频模型**现场念出来的**，什么时候开口
  //   不由脚本决定。实测 shot5.mp4 —— 字幕写 0~5s，人声 1.22s 才起，整句糊成
  //   一块。新做法的锚是「词什么时候被念出来」（ASR 词级证据），见
  //   `drama/timeline.ts`。
  //
  //   流程（对齐 hypit 的「归一化先于语义对齐」）：
  //     ① 下载分镜 → ② ffprobe 建客观媒体事实（真实时长/帧率）
  //     → ③ concat → ④ ASR 词级对齐 → ⑤ 装配时间轴 → ⑥ 输出 ASS/SRT → ⑦ 烧录
  //
  //   每一环都能**单独降级**：ASR 不可用 → 回退按时长估算（source='estimated'）；
  //   烧 ASS 失败 → 回退烧 SRT；都失败 → 出无字幕成片。任何情况都不阻断出片。
  async genStep7Compose(
    input: any, shotsVideo: any, shotsScript: any, sessionUuid: string, options: any,
    scope?: { dir?: string; urlBase?: string; narrativeId?: string },
  ): Promise<any> {
    if (!shotsVideo || !shotsVideo.shots) throw new BadRequestException('请先生成分镜视频');

    // scope 让剧级流程把成片落在自己的目录(如 uploads/dramas/{dramaUuid}/ep1),
    // 不传则维持旧的 micro-drama-sessions 路径,保证老向导行为不变。
    const sessionDir = scope?.dir || path.join(this.sessionsDir, sessionUuid);
    const urlBase = scope?.urlBase || `/uploads/micro-drama-sessions/${sessionUuid}`;
    const composeDir = path.join(sessionDir, 'compose');
    fs.mkdirSync(composeDir, { recursive: true });

    // 1) 下载所有分镜视频(记录“实际进入成片”的镜头:字幕只对这些生成)
    const segPaths: string[] = [];
    const used: Array<{ shot: any; video: any }> = [];
    const shotMap: Record<number, any> = {};
    for (const s of shotsScript?.shots || []) shotMap[s.idx] = s;

    let idx = 0;
    // 2026-09-24 缺镜点名:下载失败同样记名(之前只有 warn,产出里无痕)。
    const failedDetails = failedShotDetails(shotsVideo.shots);
    const failedByIdx = new Map(failedDetails.map((d) => [d.shot_idx, d]));
    for (const sv of shotsVideo.shots) {
      if (!sv.video_url) continue;
      const segPath = path.join(composeDir, `seg_${String(idx).padStart(3, '0')}.mp4`);
      try {
        await this.downloadFile(sv.video_url, segPath);
        segPaths.push(segPath);
        used.push({
          shot: shotMap[sv.shot_idx] || { idx: sv.shot_idx, duration_sec: sv.duration_sec },
          video: sv,
        });
        idx++;
      } catch (e: any) {
        this.logger.warn(`下载分镜 ${sv.shot_idx} 失败: ${e.message}`);
        if (!failedByIdx.has(Number(sv.shot_idx))) {
          failedByIdx.set(Number(sv.shot_idx), {
            shot_idx: Number(sv.shot_idx),
            status: 'download_failed',
            reason: String(e?.message || 'download failed').replace(/\s+/g, ' ').slice(0, 120),
          });
        }
      }
    }

    if (segPaths.length === 0) throw new BadRequestException('没有可合成的分镜视频');

    // ffmpeg 路径解析:FFMPEG_BIN > PATH 里的 ffmpeg > 已知常见路径兜底
    const ffmpegBin = this.resolveFfmpegBin();
    const ffprobeBin = resolveFfprobeBin(ffmpegBin);

    // 2026-09-16(批2)**集首视觉回顾**(用户拍板方案):epNo>1 时成片头部接 3 秒
    //   「上集尾帧淡入 + 一行回顾字卡」,给集间连贯一个**画面层**开场载体 ——
    //   文本层 hookIn 只告诉编剧要接什么,观众需要眼睛看得见的"接上了"。
    //   素材 = 上集成片尾帧 + 上集 hookOut;DRAMA_EP_RECAP=0 可关;任何一步失败
    //   降级为无回顾(绝不阻断出片)。
    const recapOpt = options.recap && typeof options.recap === 'object' ? options.recap : null;
    const recapEnabledFlag = String(process.env.DRAMA_EP_RECAP || '1').trim() !== '0';
    let recapInfo: any = null;
    if (recapEnabledFlag && recapOpt?.prevVideoPath && recapOpt?.text
        && fs.existsSync(recapOpt.prevVideoPath) && segPaths.length > 0) {
      try {
        const bodyRes = probeResolution(ffprobeBin, segPaths[0]);
        const bodyFps = probeFps(ffprobeBin, segPaths[0]) || 30;
        const tailPng = path.join(composeDir, 'recap_tail.png');
        const recapAss = path.join(composeDir, 'recap.ass');
        const recapPath = path.join(composeDir, 'recap.mp4');
        // ① 抽上集尾帧(结束前 0.5s)
        await this.runFfmpeg(ffmpegBin, [
          '-y', '-sseof', '-0.5', '-i', recapOpt.prevVideoPath, '-frames:v', '1', tailPng,
        ]);
        // ② 回顾字卡:复用 ASS 管线,画布跟本集成片分辨率;顶部居中 + 半透明底。
        //   2026-09-16 端到端验收修:libass WrapStyle 0 对中文长句不保证折行,
        //   实测 60 字一行两端出屏 → 文本截 40 字,wrapCueText 预折 ≤3 行接 \N
        const lay = assLayout({ videoWidth: bodyRes?.width, videoHeight: bodyRes?.height });
        const recapLines = wrapCueText(
          `上集:${String(recapOpt.text).slice(0, 40)}`,
          lay.maxChars, 3,
        ).map(escapeAssText).join('\\N');
        fs.writeFileSync(recapAss, [
          '[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes',
          `PlayResX: ${lay.playResX}`, `PlayResY: ${lay.playResY}`, '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
          `Style: Recap,Microsoft YaHei,${lay.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,${lay.marginLR},${lay.marginLR},${Math.round(lay.playResY * 0.16)},1`,
          '', '[Events]',
          'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          `Dialogue: 0,0:00:00.20,0:00:02.90,Recap,,0,0,0,,${recapLines}`,
        ].join('\n'), 'utf8');
        // ③ 3s 静帧淡入 + 烧字卡;分辨率/帧率对齐正文段(xfade 转场要求同参)
        const vf = [
          bodyRes ? `scale=${bodyRes.width}:${bodyRes.height}` : '',
          'fade=in:0:12',
          `subtitles=${path.basename(recapAss)}`,
        ].filter(Boolean).join(',');
        await this.runFfmpeg(ffmpegBin, [
          '-y', '-loop', '1', '-t', '3', '-i', tailPng,
          '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-vf', vf, '-r', String(bodyFps), '-pix_fmt', 'yuv420p',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-shortest',
          recapPath,
        ], composeDir);
        segPaths.unshift(recapPath);
        // 合成进 used 头部:idx=-1 无台词 → 时间轴不出 cue,但窗口占 3s,
        //   让 ASR 词的绝对时间与正文字幕窗口对齐(回顾段是静音,不会分到词)
        used.unshift({
          shot: { idx: -1, dialogue: '', duration_sec: 3 },
          video: { shot_idx: -1, duration_sec: 3, recap: true },
        });
        recapInfo = { enabled: true, text: String(recapOpt.text).slice(0, 60), sec: 3 };
        this.logger.log(`[step7] 集首视觉回顾已接:3s 尾帧淡入 + 字卡`);
      } catch (e: any) {
        recapInfo = { enabled: false, reason: e?.message };
        this.logger.warn(`[step7] 集首回顾生成失败(降级为无回顾,不阻断): ${e?.message}`);
      }
    }

    // 2) 【归一化】ffprobe 实测每个分镜的真实时长。
    //    不能用 Agnes 返回的 duration_sec —— 那是**请求值**,与实际编码时长有
    //    偏差;按它累加镜头窗,第 15 镜可能偏 1 秒以上,再拿这个错窗口去分派
    //    ASR 词,等于把编码偏差当成语音偏差。
    const durations: number[] = used.map((u, i) => {
      const measured = ffprobeBin ? probeDurationSec(ffprobeBin, segPaths[i]) : null;
      const fallback = Number(u.video?.duration_sec) || Number(u.shot?.duration_sec) || 3;
      return measured && measured > 0 ? measured : fallback;
    });
    const realTotal = durations.reduce((s, d) => s + d, 0);

    // 3) ffmpeg concat demuxer 合并 → 中间无字幕文件
    const listFile = path.join(composeDir, 'concat_list.txt');
    fs.writeFileSync(
      listFile,
      segPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
      'utf8',
    );
    // 中间文件与 srt/final 同目录 —— 烧字幕时用 cwd+相对文件名(Windows 绝对路径
    //   在 subtitles 滤镜里要转义冒号,实测相对名最稳)
    const concatPath = path.join(sessionDir, 'concat.mp4');
    // P1-b(借 reelbench 转场):2026-09-16(批2)**默认开** xfade 叠化(DRAMA_COMPOSE_TRANSITIONS=0 可关)——
    //   之前默认关 = concat -c copy 裸拼,接缝硬跳是"断断续续"的接缝层根因;
    //   开时重编码,需片段同分辨率/帧率(上游同档位产出,实测满足)。
    // 2026-09-22:xfade 要求各片段同分辨率。上游偶发降档(实测一集里 704x1280 与
    //   704x960 混着)→ 链式 xfade 报 "input link main parameters do not match",
    //   整集合成失败、concat.mp4 0 字节(EP1 就是这么没成片的)。
    //   先探所有片段,只要尺寸不统一就按最大尺寸归一(scale+pad 补边,不裁内容)。
    let normalize: { w: number; h: number; fps: number } | undefined;
    // 2026-09-22:音轨探测。xfade 分支原本只 `-map [vout]`,成片零音轨(用户反馈
    //   "视频没声音")。要挂音频链就得先知道哪些片段真有音轨 —— 缺的用等长静音补,
    //   否则 acrossfade/concat 会因输入缺失整集合成失败。
    let hasAudio: boolean[] | undefined;
    try {
      const probeBin = resolveFfprobeBin(ffmpegBin);
      if (probeBin) {
        const sizes = segPaths
          .map((p) => probeResolution(probeBin, p))
          .filter((s): s is { width: number; height: number } => !!s);
        if (sizes.length === segPaths.length) {
          const uniq = new Set(sizes.map((s) => `${s.width}x${s.height}`));
          if (uniq.size > 1) {
            normalize = {
              w: Math.max(...sizes.map((s) => s.width)),
              h: Math.max(...sizes.map((s) => s.height)),
              fps: 30,
            };
            this.logger.warn(
              `[step7] 片段分辨率不一致(${[...uniq].join(', ')}) → 归一到 ` +
              `${normalize.w}x${normalize.h}@${normalize.fps}fps(scale+pad 补边)`,
            );
          }
        }
        hasAudio = segPaths.map((p) => probeHasAudio(probeBin, p));
        const nAudio = hasAudio.filter(Boolean).length;
        if (nAudio === 0) {
          this.logger.warn(`[step7] ${segPaths.length} 个片段全部无音轨 → 成片将不含音频`);
          hasAudio = undefined;
        } else if (nAudio < segPaths.length) {
          this.logger.warn(
            `[step7] ${segPaths.length - nAudio}/${segPaths.length} 个片段无音轨 → ` +
            `这些片段按等长静音补位(成片仍有声)`,
          );
        } else {
          this.logger.log(`[step7] 音轨探测:${nAudio}/${segPaths.length} 个片段带音轨`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[step7] 分辨率探测失败(不影响主流程):${e?.message || e}`);
    }

    const tplan = planCompose({
      segments: segPaths,
      durations,
      enabled: String(process.env.DRAMA_COMPOSE_TRANSITIONS || '1').trim() !== '0',
      transitionSec: Number(process.env.DRAMA_COMPOSE_TRANSITION_SEC) > 0
        ? Number(process.env.DRAMA_COMPOSE_TRANSITION_SEC) : 0.4,
      listFile,
      out: concatPath,
      normalize,
      hasAudio,
    });
    if (tplan.mode === 'xfade') {
      this.logger.log(
        `[step7] 转场已启用(xfade, ${tplan.filterComplex.length} 字符滤镜图, ` +
        `音轨 ${tplan.audioTracks}/${segPaths.length}` +
        `${tplan.silentPadded ? ` + 静音补位 ${tplan.silentPadded}` : ''})`,
      );
    }
    await this.runFfmpeg(ffmpegBin, tplan.args);

    // 4) 【词级对齐】对合成后的整片跑一次 ASR(一次加载模型,整片绝对时间)。
    //    失败/不可用一律降级,绝不阻断出片 —— alignVideoWords 本身不抛错。
    let alignReason: string | null = null;
    let alignWords: any[] = [];
    if (options.align === false) {
      alignReason = 'DISABLED_BY_OPTION';
    } else {
      // 缓存键用**分镜视频 URL 指纹**。
      //   为什么不按文件 mtime:分镜每次合成都重新下载一次(必然覆盖,mtime 必变),
      //   拿文件指纹当键等于永远命中不了。URL 才反映"素材是否真的换过" ——
      //   重生成分镜会拿到新的 Agnes URL,这时缓存自然失效。
      //   分镜没换就不用再跑模型(本机一次整片对齐约 30~60 秒)。
      const segKey = createHash('sha1')
        .update(used.map((u) => String(u.video?.video_url || '')).join('|'))
        .digest('hex');
      const align = await alignVideoWords(concatPath, {
        cacheKey: segKey,
        cacheFile: path.join(composeDir, 'asr-cache.json'),
        warn: (m: string) => this.logger.log(m),
      });
      alignWords = align.words;
      alignReason = align.available ? null : (align.reason || 'UNAVAILABLE');
      if (!align.available) this.logger.warn(`[step7] 词级对齐不可用(${alignReason}),字幕回退按镜头时长估算`);
    }
    const fps = ffprobeBin ? (probeFps(ffprobeBin, concatPath) || 0) : 0;
    // 2026-09-16:探成片真实分辨率 —— 字幕画布/字号/边距全部按它推导,
    //   竖屏 9:16 不再套 16:9 的 512×288 老画布(字被放大近一倍超屏的根因)。
    const vres = ffprobeBin ? probeResolution(ffprobeBin, concatPath) : null;
    if (vres) this.logger.log(`[step7] 成片分辨率 ${vres.width}×${vres.height}`);

    // 5) 【装配时间轴】证据(asr) + 调优(presentation) + 显示(display) 三层分离。
    //    knownNames(资产库角色名)透传给净化器:有名单时能在「××地说」「愤怒的××」里
    //    精确认出说话人、拆分一镜多说话人;拿不到时保守处理,字幕仍然干净。
    const composeKnownNames: string[] = Array.isArray(options?.knownNames)
      ? options.knownNames.map((n: any) => String(n || '').trim()).filter(Boolean)
      : [];
    const timeline = buildTimeline(
      used.map((u) => u.shot),
      alignWords,
      {
        narrativeId: scope?.narrativeId ?? null,
        durations,
        fps,
        minCueSec: 0.8,
        presentation: { leadSec: 0.12, tailSec: 0.12, handoff: 'cut' },
        knownNames: composeKnownNames,
      },
    );
    this.logger.log(
      `[step7] 时间轴: ${timeline.stats.total} 条字幕(词级对齐 ${timeline.stats.asr} / 估算 ${timeline.stats.estimated}), `
      + `说话人 ${timeline.stats.speakers.length}, 诊断 ${timeline.diagnostics.length} 条, 片长 ${realTotal.toFixed(2)}s`,
    );
    // 落盘时间轴:便于审计"这条字幕为什么在这里",也是改台词重排的输入
    try {
      fs.writeFileSync(path.join(sessionDir, 'timeline.json'), JSON.stringify(timeline, null, 2), 'utf8');
    } catch (e: any) {
      this.logger.warn(`[step7] 时间轴落盘失败(不影响出片): ${e?.message}`);
    }

    // 6) 输出字幕：ASS 主用（支持说话人配色/逐词高亮），SRT 兼容（外挂下载）
    let assPath: string | null = null;
    let subtitlePath: string | null = null;
    if (options.subtitle !== false && timeline.cues.length) {
      // 2026-09-16:短剧字幕只显示台词 —— 说话人名是旧"设计性回加"
      //   (showSpeakerName='auto' 在 ≥2 说话人时加前缀),用户明确不想要;
      //   调用方显式传 showSpeakerName:true 可恢复。画布跟成片真实分辨率走。
      const subOpts = {
        karaoke: options.karaoke === true,
        showSpeakerName: options.showSpeakerName === true,
        videoWidth: vres?.width,
        videoHeight: vres?.height,
      };
      assPath = path.join(sessionDir, 'subtitle.ass');
      fs.writeFileSync(assPath, timelineToAss(timeline, subOpts), 'utf8');
      subtitlePath = path.join(sessionDir, 'subtitle.srt');
      fs.writeFileSync(subtitlePath, timelineToSrt(timeline, subOpts), 'utf8');
    }

    // 7) 烧字幕 → final.mp4。
    //    为什么必须烧:外挂字幕不会随成片一起交付/上传平台,播放时看不到
    //    (2026-09-15 用户反馈"生成的视频没有字幕"的直接原因)。
    //    失败不阻断出片:ASS → SRT → 无字幕,逐级降级,每级都留日志。
    const finalPath = path.join(sessionDir, 'final.mp4');
    let burned = false;
    let burnStyle: string | null = null;
    if (assPath) {
      try {
        await this.burnSubtitlesInto(
          ffmpegBin, sessionDir,
          path.basename(concatPath), path.basename(assPath), path.basename(finalPath),
          vres,
        );
        burned = true; burnStyle = 'ass';
      } catch (e: any) {
        this.logger.warn(`[step7] 烧 ASS 字幕失败,回退 SRT: ${e?.message}`);
      }
    }
    if (!burned && subtitlePath) {
      try {
        await this.burnSubtitlesInto(
          ffmpegBin, sessionDir,
          path.basename(concatPath), path.basename(subtitlePath), path.basename(finalPath),
          vres,
        );
        burned = true; burnStyle = 'srt';
      } catch (e: any) {
        this.logger.warn(`[step7] 烧 SRT 字幕也失败,出无字幕成片: ${e?.message}`);
      }
    }
    if (!burned) fs.copyFileSync(concatPath, finalPath);

    // 缺镜统计:上面 `if (!sv.video_url) continue` 会把没拿到视频的镜头静默丢掉,
    // 成片短一截而用户完全不知道。这里把差额算出来往上抛,让编排器写进时间线、
    // 让工作台在成片卡片上直接告诉用户"少了哪几镜、可以去补做"。
    // 2026-09-16:回顾段(集首 3s)不是分镜,不计入 composed/缺镜/质检。
    const recapSegs = recapInfo?.enabled ? 1 : 0;
    const bodySegCount = Math.max(0, segPaths.length - recapSegs);
    const plannedShots = Array.isArray(shotsVideo.shots) ? shotsVideo.shots.length : 0;
    const missingShots = Math.max(0, plannedShots - bodySegCount);

    // 8) 【P1-c 成片质检门】借 reelbench 纪律:出片后用 ffmpeg 客观量三维(镜长/段内运动量/接缝跳变),
    //    把"支离破碎"从感觉变成数字。复用上面已下载的 segPaths、已实测的 durations、已解析的 ffmpegBin。
    //    MVP 只测量+暴露(verdict 只到 review),不硬拦不自动回炉;auditCompose 内部全程降级不抛错,
    //    质检失败绝不阻断出片。options.audit === false 可关。
    let audit: any = null;
    if (options.audit !== false) {
      try {
        audit = auditCompose(
          ffmpegBin, segPaths.slice(recapSegs), durations.slice(recapSegs), options.auditThresholds,
        );
        if (audit && !audit.skipped) {
          this.logger.log(
            `[step7] 质检: ${audit.shotCount}镜/均镜长${audit.avgShotSec?.toFixed(2)}s/每分钟${audit.cutsPerMin?.toFixed(1)}切, `
            + `死镜${audit.staticShots.length} 硬冻${audit.frozenShots.length} 硬跳接缝${audit.seamOutliers.length} → ${audit.verdict}`,
          );
        } else if (audit?.skipped) {
          this.logger.warn(`[step7] 质检跳过(${audit.reason}),不影响出片`);
        }
      } catch (e: any) {
        this.logger.warn(`[step7] 质检异常(不影响出片): ${e?.message}`);
      }
    }

    const stats = fs.statSync(finalPath);
    // 2026-09-24:质检结论映射回镜号。audit 里的 static/frozenShots 是片段序号
    //   (0 基,已剔回顾段);used[] 与 segPaths 同序且只含正片 → used[i] 即该片段的镜。
    //   输出 audit_shots 供编排器自动回炉硬冻镜(static 仅提示,不自动烧额度)。
    const segToShotIdx = (segIdx: number): number | null => {
      const sh = used[segIdx]?.video?.shot_idx;
      const n = Number(sh);
      return Number.isFinite(n) ? n : null;
    };
    const auditShotIdxs = { static: [] as number[], frozen: [] as number[] };
    if (audit && !audit.skipped) {
      for (const s of audit.staticShots || []) {
        const sh = segToShotIdx(Number(s));
        if (sh != null && !auditShotIdxs.static.includes(sh)) auditShotIdxs.static.push(sh);
      }
      for (const s of audit.frozenShots || []) {
        const sh = segToShotIdx(Number(s));
        if (sh != null && !auditShotIdxs.frozen.includes(sh)) auditShotIdxs.frozen.push(sh);
      }
      auditShotIdxs.static.sort((a, b) => a - b);
      auditShotIdxs.frozen.sort((a, b) => a - b);
      if (auditShotIdxs.frozen.length) {
        this.logger.warn(`[step7] 硬冻镜 ${auditShotIdxs.frozen.map((i) => `#${i}`).join('、')} → 可自动回炉`);
      }
    }
    return {
      final_url: `${urlBase}/final.mp4`,
      final_path: finalPath,
      duration_sec: realTotal,
      // 本集计划镜头数 / 实际进入成片的镜头数 / 差额(缺镜)
      planned_shots: plannedShots,
      composed_shots: bodySegCount,
      missing_shots: missingShots,
      // 2026-09-24:缺哪几镜、为什么(点名,供时间线/前端一键补做打靶;下载失败也记名)
      failed_shots: [...failedByIdx.values()].sort((a, b) => a.shot_idx - b.shot_idx),
      // 2026-09-16(批3):集首视觉回顾状态(null=未启用/非第2集起;{enabled:false,reason}=降级)
      recap: recapInfo,
      // 2026-09-16(批3 透明工作台):字幕全文落库 —— 之前只落磁盘 timeline.json,
      //   前端只显示文件路径,用户看不到"成片里到底说了什么"。
      subtitle_cues: timeline.cues.map((c: any) => ({
        shotIdx: c?.anchor?.shotIdx ?? null,
        startSec: Number(c?.display?.startSec ?? c?.window?.startSec ?? 0),
        endSec: Number(c?.display?.endSec ?? c?.window?.endSec ?? 0),
        text: String(c?.anchor?.text || ''),
        speaker: c?.anchor?.speaker || null,
        source: c?.anchor?.source || null,
      })),
      // 成片门判定落库(批次路径由编排器强制;手动单步也留账可查)
      compose_gate: evaluateComposeGate(
        { planned_shots: plannedShots, composed_shots: bodySegCount, duration_sec: realTotal },
        Number(input?.targetSec) || 0,
      ),
      subtitle_url: subtitlePath ? `${urlBase}/subtitle.srt` : null,
      subtitle_ass_url: assPath ? `${urlBase}/subtitle.ass` : null,
      subtitle_burned: burned,
      subtitle_style: burnStyle,
      timeline_url: `${urlBase}/timeline.json`,
      segment_count: segPaths.length,
      size_bytes: stats.size,
      // 时间轴摘要 —— 前端/运维一眼看出字幕可信度
      timeline: {
        cue_count: timeline.stats.total,
        asr_cues: timeline.stats.asr,
        estimated_cues: timeline.stats.estimated,
        speakers: timeline.stats.speakers,
        diagnostics: timeline.diagnostics.length,
        align_available: alignReason === null,
        align_reason: alignReason,
        fps,
      },
      // P1-c 成片质检结论(可能为 null=关闭,或 {skipped,reason})。前端据此显示"死镜/硬跳接缝"并可打靶回炉。
      audit,
      // 2026-09-24:质检点名到镜号(片段序号→shot_idx,见上),编排器据此自动回炉硬冻镜
      audit_shots: auditShotIdxs,
    };
  }

  /** 跑一次 ffmpeg;失败带 stderr 尾巴抛错。cwd 可指定(滤镜用相对路径更稳) */
  /**
   * 跑 ffmpeg。**必须带超时** —— 2026-09-22 实测:一次滤镜图写错(全局 apad 无参 =
   *   无限补静音 + -shortest)会让 ffmpeg **永不结束**,产物连 moov atom 都没有,
   *   而这里原本没有超时,于是第 7 步就永久挂住 → 集永远 running → 又攒僵尸槽位。
   *   超时后杀进程并 reject,让失败**响亮地**发生,由上层重试/告警,而不是静静挂死。
   * 默认 20 分钟(整集 xfade 重编码量级);FFMPEG_TIMEOUT_MS 可调。
   */
  private runFfmpeg(bin: string, args: string[], cwd?: string): Promise<void> {
    const timeoutMs = Number(process.env.FFMPEG_TIMEOUT_MS) > 0
      ? Number(process.env.FFMPEG_TIMEOUT_MS) : 20 * 60 * 1000;
    return new Promise<void>((resolve, reject) => {
      const { spawn } = require('child_process');
      const proc = spawn(bin, args, { windowsHide: true, cwd });
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { proc.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
        reject(new Error(
          `ffmpeg 超时(${Math.round(timeoutMs / 1000)}s 未结束,已强杀):` +
          ` ${args.slice(0, 6).join(' ')} ... ${stderr.slice(-400)}`,
        ));
      }, timeoutMs);
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', (e: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
      proc.on('close', (code: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 失败 code=${code}: ${stderr.slice(-500)}`));
      });
    });
  }

  /**
   * 把字幕烧进画面(libass / subtitles 滤镜)。支持 .ass 与 .srt 两种输入。
   *   · 为什么烧:外挂字幕不随成片交付,用户播放时看不到。
   *   · 为什么 cwd+相对文件名:Windows 绝对路径在滤镜串里要转义冒号(C\:/...),
   *     跨 ffmpeg 版本易踩坑;同目录相对名实测最稳。
   *   · 字体走系统 directwrite(实测 fontselect → MicrosoftYaHei),无需带字体文件。
   *   · 样式按 1280x704 实测校准:字高 ~35px、距底 ~12%、水平居中。
   *
   * 2026-09-15:ASS 时**不再传 force_style** —— ASS 文件自带 Style 段(画布/字号/
   *   边距与旧 force_style 逐项对齐),force_style 会覆盖掉它的 SecondaryColour,
   *   把逐词高亮的底色一起抹掉。SRT 无自带样式,继续走 force_style 兜底。
   */
  private async burnSubtitlesInto(
    bin: string, dir: string, inputName: string, subName: string, outName: string,
    vres?: { width: number; height: number } | null,
  ): Promise<void> {
    const isAss = /\.ass$/i.test(subName);
    let vf = `subtitles=${subName}`;
    if (!isAss) {
      // 2026-09-16:SRT 兜底路径的 force_style 也跟成片分辨率走 —— 旧 FontSize=12
      //   以 PlayResY=288 为基准,竖屏 1280 高会被 libass 放大到 ~53px,720 宽必超屏。
      //   目标字高 = 屏宽 5%,换算回 288 空间;左右安全边取 512 空间 5%。
      const fs288 = vres && vres.width > 0 && vres.height > 0
        ? Math.max(8, Math.round(vres.width * 0.05 * 288 / vres.height))
        : 12;
      const mLR = vres ? 26 : 16;
      const style = [
        'FontName=Microsoft YaHei',
        `FontSize=${fs288}`,
        'PrimaryColour=&H00FFFFFF',
        'OutlineColour=&H00000000',
        'BorderStyle=1', 'Outline=2', 'Shadow=1',
        'Alignment=2',              // 底部居中
        `MarginL=${mLR}`, `MarginR=${mLR}`,
        'MarginV=36',               // 距底约 12%
      ].join(',');
      vf = `subtitles=${subName}:force_style='${style}'`;
    }
    // 2026-09-21: 电影级统一微调色 —— 增强微对比度与饱和度,消除灰暗的 AI 塑料感
    const colorFilter = 'eq=contrast=1.05:saturation=1.08:brightness=0.01';
    const finalVf = `${vf},${colorFilter}`;
    await this.runFfmpeg(bin, [
      '-y', '-threads', '0', '-i', inputName, '-vf', finalVf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'copy',             // 保留 Agnes 视频自带的台词音轨
      outName,
    ], dir);
  }

  /**
   * 2026-09-16(批3 透明工作台):改字幕 → 重烧。
   * 复用已存在的 concat.mp4(不重新下载分镜段、不重跑 ASR),只重写 ASS/SRT
   * 并重烧 final.mp4 —— 秒级到十秒级,用户改一句台词不用重烧整集配额。
   *
   * @param dir 集目录(含 concat.mp4)
   * @param tl  应用过 applyTextEdits 的时间轴
   */
  async reburnSubtitlesFromTimeline(
    dir: string, tl: any,
  ): Promise<{ finalPath: string; assPath: string; srtPath: string }> {
    const concatPath = path.join(dir, 'concat.mp4');
    if (!fs.existsSync(concatPath)) {
      throw new BadRequestException('concat.mp4 不存在,请先合成过本集(第 5 步)再改字幕');
    }
    const ffmpegBin = this.resolveFfmpegBin();
    const ffprobeBin = resolveFfprobeBin(ffmpegBin);
    const vres = ffprobeBin ? probeResolution(ffprobeBin, concatPath) : null;
    const subOpts = {
      showSpeakerName: false,
      videoWidth: vres?.width,
      videoHeight: vres?.height,
    };
    const assPath = path.join(dir, 'subtitle.ass');
    const srtPath = path.join(dir, 'subtitle.srt');
    fs.writeFileSync(assPath, timelineToAss(tl, subOpts), 'utf8');
    fs.writeFileSync(srtPath, timelineToSrt(tl, subOpts), 'utf8');
    // 落盘改后时间轴,保持"字幕为什么在这里"可审计
    try {
      fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2), 'utf8');
    } catch (e: any) {
      this.logger.warn(`[reburn] 时间轴落盘失败(不影响重烧): ${e?.message}`);
    }
    await this.burnSubtitlesInto(
      ffmpegBin, dir, 'concat.mp4', 'subtitle.ass', 'final.mp4', vres,
    );
    return { finalPath: path.join(dir, 'final.mp4'), assPath, srtPath };
  }

  // ===========================================================================
  // 辅助:LLM / 图像 / 视频 调用
  // ===========================================================================

  async callLlm(ctx: LlmCtx, sys: string, usr: string, temperature: number, maxTokens: number): Promise<string> {
    // 2026-07-30:增加重试 + 详细日志
    //   之前 callLlm 失败时只返回空字符串,parseJsonSafe 解析失败,上层抛
    //   "LLM 生成剧本大纲失败" 但看不到真正原因。改为重试 2 次,并打印
    //   LLM 返回内容的前 200 字符,方便定位问题。
    const maxRetries = 2;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(`[callLlm] attempt ${attempt}/${maxRetries}, sys=${sys.length}chars, usr=${usr.length}chars`);
        // 单次 LLM 调用实测可跑两分钟以上(上游超时会静默降级到备用模型),
        // 不报一声就开始,这段时间时间线是空的。
        reportUpstreamBackoff(
          attempt === 1 ? 'LLM 生成中(大纲/分镜),上游偶有超时' : `LLM 重试第 ${attempt}/${maxRetries} 次`,
        );
        const result = await this.dispatcher.dispatch(
          'llm.agnes-3.0-flash',
          {
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: usr },
            ],
            temperature,
            max_tokens: maxTokens,
          },
          null,
          {
            taskId: 0n,
            userId: ctx.userId,
            agentId: ctx.agentId,
            signal: new AbortController().signal,
            upstreamOutputs: {},
          } as any,
        );
        const text = (result.output as any)?.text || '';
        if (text && text.trim()) {
          this.logger.log(`[callLlm] OK attempt ${attempt}, output=${text.length}chars, preview=${text.slice(0, 200)}`);
          return text;
        }
        this.logger.warn(`[callLlm] attempt ${attempt} 返回空 text, output=${JSON.stringify(result.output).slice(0, 300)}`);
        lastErr = new Error('LLM 返回空内容');
      } catch (e: any) {
        // 2026-07-30:详细记录 LLM API 错误,方便排查
        //   常见错误:HTTP 400 (token 超限/content 过长)、401 (key 无效)、5xx
        const errStr = e?.message || String(e);
        this.logger.error(`[callLlm] attempt ${attempt} 异常: ${errStr.slice(0, 500)}`);
        // 如果是 token 超限错误,给友好提示
        if (/too many tokens|context length|maximum context|token limit|exceed/i.test(errStr)) {
          lastErr = new Error(`主题/提示词过长,超出 LLM 上下文限制。请缩短主题后重试。(原始错误: ${errStr.slice(0, 200)})`);
        } else {
          lastErr = e;
        }
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new BadRequestException(
      `LLM 调用失败(已重试 ${maxRetries} 次): ${lastErr?.message || '未知错误'}`.slice(0, 500),
    );
  }

  /**
   * 2026-09-16(批4):多模态质检通道 —— 走平台 LLM 网关(OpenAI 兼容 content 数组)。
   * 用于定妆图解剖硬伤质检(visual-qc.ts)。
   *
   * **任何失败都返 null**(模型不支持视觉/400/超时/解析空):质检是加成门不是
   * 必经门,通道坏了定妆链路必须照跑(降级不拦,与全管线纪律一致)。
   */
  async callVisionLlm(
    ctx: LlmCtx, sys: string, imageUrl: string, question: string,
  ): Promise<string | null> {
    try {
      const result = await this.dispatcher.dispatch(
        'llm.agnes-3.0-flash',
        {
          messages: [
            { role: 'system', content: sys },
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 512,
        },
        null,
        {
          taskId: 0n,
          userId: ctx.userId,
          agentId: ctx.agentId,
          signal: new AbortController().signal,
          upstreamOutputs: {},
        } as any,
      );
      const text = (result.output as any)?.text || '';
      return text && text.trim() ? text : null;
    } catch (e: any) {
      this.logger.warn(`[vision-qc] 多模态通道不可用(降级不拦): ${(e?.message || String(e)).slice(0, 200)}`);
      return null;
    }
  }

  // ===========================================================================
  // 2026-07-31:多 key 并行调用 Agnes API(绕过 dispatcher,直接 HTTP)
  //   用于 step 5/6 并行生成,每个并行任务用不同 key,避免单 key 限流
  //   HTTP 逻辑复用 agnes.provider.ts,保持 payload 格式一致
  // ===========================================================================

  /**
   * 用指定 key 调 Agnes 图像生成(同步,返 URL)。
   *
   * 两条队列的参数规则不一样,这里必须分叉处理(实测):
   *   · 纯文生图(text image queue):negative_prompt 放顶层或 extra_body 都 HTTP 400
   *     → 反向约束只能合并进 prompt 表达
   *   · 图生图(带 extra_body.image):支持 extra_body.negative_prompt
   *     → 反向约束走正规范式,约束力更强
   * 参考图只收**上游可达的公网 http(s) URL**;本地 /uploads 路径与 data URI 一律 400。
   */
  async callImageWithKey(
    apiKey: string, prompt: string, size: string,
    negativePrompt?: string, refImages?: string[], ratio?: string, seed?: number,
  ): Promise<string> {
    const url = `${this.agnesBaseUrl}/images/generations`;
    const refs = (refImages || []).filter(
      (u) => typeof u === 'string' && /^https?:\/\//i.test(u),
    );
    // 2026-09-01:官方 2.5-flash 档位制 —— size 为 "1K"-"4K" 时配 ratio 输出像素可预测;
    //   精确像素则原样透传(上游归一化),现有分镜关键帧调用行为不变。
    const isTier = /^(1|2|3|4)K$/i.test(size);
    const LEGAL_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];
    const body: Record<string, any> = {
      model: 'agnes-image-2.5-flash',
      prompt,
      n: 1,
      size: isTier ? size.toUpperCase() : size,
      extra_body: { response_format: 'url' },
    };
    if (isTier && ratio && LEGAL_RATIOS.includes(ratio)) body.ratio = ratio;
    // 2026-09-05:seed 锁定(内容级实测确认生效:同 seed 同 prompt 两次产物
    //   SHA256 完全一致,异 seed 内容不同;官方参数表未列但顶层传入被接受)。
    //   ⚠️ 实测范围 [0,999](HTTP 400 "seed must be between -1 and 999"),
    //   统一 clamp,越界值压回合法区间,保持稳定可复现。
    //   补画/重试同镜同果,不再"重开盲盒"。不传=保持原随机行为。
    if (seed != null && Number.isFinite(Number(seed))) {
      body.seed = Math.min(999, Math.max(0, Math.floor(Number(seed))));
    }
    if (refs.length) {
      body.extra_body.image = refs;
      if (negativePrompt) body.extra_body.negative_prompt = negativePrompt;
    } else if (negativePrompt) {
      body.prompt = `${prompt}. Avoid in the image: ${negativePrompt}`;
    }

    // 429/503 指数退避重试(上游偶发负载饱和)
    const maxAttempts = 3;
    let resp: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      resp = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      });
      // 504 = Cloudflare 网关超时(图生图连发时实测出现过),同样可重试
      if (!RETRYABLE_IMAGE_STATUS.has(resp.status)) {
        // 2026-09-21: 上游 400 content_policy_violation 敏感词拦截时, 自动净化提示词并重试一次
        const errCode = resp.data?.error?.code || resp.data?.code;
        if (resp.status === 400 && errCode === 'content_policy_violation' && attempt < maxAttempts) {
          const safePrompt = sanitizePromptForSafety(body.prompt || prompt);
          this.logger.warn(`[image] 命中上游 400 内容策略, 自动净化词汇重试: "${safePrompt.slice(0, 60)}..."`);
          body.prompt = safePrompt;
          if (body.extra_body?.negative_prompt) delete body.extra_body.negative_prompt;
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }
        break;
      }
      if (attempt === maxAttempts) break;
      const backoffMs = 5_000 * attempt;
      this.logger.warn(`[image] Agnes HTTP ${resp.status},${backoffMs / 1000}s 后重试 ${attempt}/${maxAttempts - 1}`);
      reportUpstreamBackoff(
        `图像上游 ${resp.status} 限流,退避 ${backoffMs / 1000}s 后重试(${attempt}/${maxAttempts - 1})`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Agnes image HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 300)}`);
    }
    const items = resp.data?.data || [];
    if (items.length === 0) throw new Error('图像生成未返回产物');
    return items[0].url || items[0].b64_json || '';
  }

  /** 用指定 key 调 Agnes 图生视频 i2v(异步 + 轮询,返 video URL) */
  private async callVideoI2vWithKey(
    apiKey: string, prompt: string, imageUrl: string, seconds: number,
    aspect = '9:16', opts: { seed?: number; audios?: string[] } = {},
  ): Promise<string> {
    // 2026-08-27:agnes-video-v2.0 -> agnes-video-2.5-flash 参数体系迁移
    //   旧参数 num_frames/frame_rate/width/height 已被移除(HTTP 400 forbidden field)
    //   新参数:mode=keyframe + first_frame + seconds("4"-"12" 字符串)+ size="720P" + aspect_ratio
    //   单段时长上限 12s,超出会被 clamp;调用方传入的 seconds 由分段逻辑保证 ≤ 12
    const secStr = String(Math.min(12, Math.max(4, Math.round(seconds))));
    const createUrl = `${this.agnesBaseUrl}/videos`;

    // 2026-09-05:音频参考注入(方案8)。官方规则:reference 与 keyframe 互斥
    //   (reference 禁 first_frame,keyframe 禁 audios),所以要带音频必须切
    //   reference 模式:关键帧图挪进 images[0](模型按 <Picture 1> 当起始帧+
    //   角色参考),音频进 audios(prompt 侧的 <Audio 1> 引用由 video-prompt 构造)。
    //   代价:失去硬首帧锁定,一致性靠 prompt 的 <Picture 1> 引导 —— 因此默认
    //   不启用,仅当调用方显式传入可用音频公网 URL 时才切换。
    const audioRefs = (opts.audios || []).filter(
      (u) => typeof u === 'string' && /^https?:\/\//i.test(u),
    ).slice(0, 3);
    const useReference = audioRefs.length > 0;

    const body: Record<string, any> = {
      model: 'agnes-video-2.5-flash',
      prompt,
      mode: useReference ? 'reference' : 'keyframe',
      seconds: secStr,
      size: '720P',
      aspect_ratio: aspect,
    };
    if (useReference) {
      body.images = [imageUrl].filter((u) => /^https?:\/\//i.test(u)).slice(0, 5);
      body.audios = audioRefs;
      // reference 模式下若关键帧不是公网 URL,整个请求不成立 → 显式报错而非静默降级
      if (!body.images.length) {
        throw new Error('reference(音频)模式要求关键帧为公网图片 URL,当前不可用');
      }
    } else {
      body.first_frame = imageUrl;
    }
    // 2026-09-05:seed(视频 API 官方公共参数,与图像不同是文档明确支持的)。
    //   ⚠️ 实测范围 [0,999](与图像一致),统一 clamp。
    if (opts.seed != null && Number.isFinite(Number(opts.seed))) {
      body.seed = Math.min(999, Math.max(0, Math.floor(Number(opts.seed))));
    }

    // 1) 创建视频任务(先按 key 排队等限流窗口;429 与网络失败都退避重试)
    //    2026-09-05:reference(音频)模式实测创建读超时可超 90s(上游要先拉取
    //    外部音频文件),keyframe 模式维持 90s 不动,reference 放宽到 240s。
    //    2026-09-15:keyframe 模式 90s → 180s。实测 11 次失败的报错是
    //      `timeout of 90000ms exceeded` —— 上游队列繁忙时创建请求本身就慢,
    //      90 秒不够。超时是**最贵的失败**:限流窗口已经消耗掉,镜头却拿不到
    //      video_id,只能整镜重来(而重来还要再等一个 63 秒窗口)。
    //    同时把网络层异常并入重试循环 —— 之前只有 429 会重试,超时/连接重置
    //      直接冒泡成"这一镜失败",是 23.6% 失败率里占比第二高的一类。
    let createResp: any = null;
    let lastErr: any = null;
    const maxCreateAttempts = 4;
    const createTimeoutMs = useReference ? 240_000 : 180_000;
    for (let attempt = 1; attempt <= maxCreateAttempts; attempt++) {
      await this.acquireVideoCreateSlot(apiKey);
      // 创建槽位只抱住 POST 瞬间:退避 sleep 时释放,让出给别的镜头,
      // 否则退避中的镜头会把创建通道堵死(队头阻塞)。
      const releaseCreate = await this.acquireI2vCreateSlot();
      lastErr = null;
      try {
        createResp = await axios.post(createUrl, body, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: createTimeoutMs,
          validateStatus: () => true,
        });
      } catch (e: any) {
        releaseCreate();
        this.recordCreateOutcome(false);
        // 循环开头的 acquireVideoCreateSlot 会自然等到下一个限流窗口,不用额外 sleep
        createResp = null;
        lastErr = e;
        if (attempt === maxCreateAttempts) break;
        this.logger.warn(
          `[step6] Agnes video create 网络失败(key …${apiKey.slice(-4)}):` +
          `${(e?.message || String(e)).slice(0, 120)},等下一窗口重试 ${attempt}/${maxCreateAttempts - 1}`,
        );
        reportUpstreamBackoff(`视频创建超时/网络失败,重试 ${attempt}/${maxCreateAttempts - 1}`);
        continue;
      }
      releaseCreate();
      // 2026-09-16:503 video_queue_full 并入重试 —— 之前只有 429 / 网络失败会重试,
      //   503 直接 break 抛错成"这一镜 failed"。实测 drama77 七集 90% 镜头死在这里:
      //   11 镜并发打满上游队列,queue_full 不重试 = 整集只剩 1 个存活段
      //   (成片 10s 的直接根因,见 docs/短视频一键生成-七问题再排查与修复方案)。
      // 2026-09-24:退避改指数 + 抖动(固定 65s 会让 N 路并发同秒集体重试、同秒再撞,
      //   e2e 11 号镜就是这么 4 次烧完的)。每次创建结果进滑动窗口,503 高压自动降并发。
      const queueFull = createResp.status === 503
        || createResp.data?.code === 'video_queue_full';
      this.recordCreateOutcome(queueFull);
      if (createResp.status !== 429 && !queueFull) break;
      if (attempt === maxCreateAttempts) break;
      const waitMs = videoCreateBackoffMs(attempt);
      this.logger.warn(
        `[step6] Agnes video create ${queueFull ? '503 队列满' : '429'}(key …${apiKey.slice(-4)}),` +
        `${Math.round(waitMs / 1000)}s 后重试 ${attempt}/${maxCreateAttempts - 1}(并发${this.i2vConcurrency()})`,
      );
      reportUpstreamBackoff(
        `视频通道 ${queueFull ? '队列满(503)' : '429 限流'},${Math.round(waitMs / 1000)}s 后重试(${attempt}/${maxCreateAttempts - 1})`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!createResp) {
      throw new Error(
        `Agnes video create 连续 ${maxCreateAttempts} 次失败:` +
        `${(lastErr?.message || String(lastErr)).slice(0, 200)}`,
      );
    }
    if (createResp.status < 200 || createResp.status >= 300) {
      throw new Error(`Agnes video create HTTP ${createResp.status}: ${JSON.stringify(createResp.data).slice(0, 300)}`);
    }
    const videoId = createResp.data?.video_id || createResp.data?.id;
    if (!videoId) {
      throw new Error(`Agnes video create 无 video_id: ${JSON.stringify(createResp.data).slice(0, 300)}`);
    }

    // 2) 轮询(必须带 model_name,2.5 系 API 纯 video_id 查询会 404)
    const baseUrlObj = new URL(this.agnesBaseUrl);
    const pollUrl =
      `${baseUrlObj.origin}/agnesapi?video_id=${encodeURIComponent(videoId)}` +
      `&model_name=agnes-video-2.5-flash`;
    const pollIntervalMs = 5_000;
    const maxWaitMs = 1_800_000; // 30 分钟
    const start = Date.now();
    let lastStatus = 'queued';

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let pollData: any = null;
      try {
        const pollResp = await axios.get(pollUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30_000,
          validateStatus: () => true,
        });
        if (pollResp.status >= 200 && pollResp.status < 300 && pollResp.data && !pollResp.data.code) {
          pollData = pollResp.data;
        }
      } catch (_) {
        // 轮询失败继续下一轮
      }
      if (!pollData) continue;

      lastStatus = pollData.status || 'unknown';
      if (['completed', 'succeeded'].includes(lastStatus)) {
        // 2.5 API 完成响应:视频地址在 url / metadata.url
        const videoUrl =
          pollData.url ||
          pollData.metadata?.url ||
          pollData.video_url || pollData.output_url || pollData.download_url ||
          (Array.isArray(pollData.videos) && pollData.videos[0]?.url) ||
          (Array.isArray(pollData.videos) && pollData.videos[0]?.video_url);
        if (!videoUrl) {
          throw new Error(`Video completed but no URL, videoId=${videoId}`);
        }
        return videoUrl;
      }
      if (['failed', 'cancelled', 'error'].includes(lastStatus)) {
        throw new Error(`Agnes video failed: status=${lastStatus}, video=${videoId}, error=${JSON.stringify(pollData.error || 'unknown').slice(0, 200)}`);
      }
      // queued / in_progress 继续轮询。上限 30 分钟,不报一声就是整段静默。
      // 分钟粒度:消息每分钟才变一次,配合 DramaService 节流不至于打穿 DB。
      reportUpstreamBackoff(
        `视频渲染中(${lastStatus}),已等 ${Math.floor((Date.now() - start) / 60_000)} 分钟`,
      );
    }
    throw new Error(`Agnes video timeout after ${maxWaitMs}ms (last status: ${lastStatus}, video: ${videoId})`);
  }

  async callImage(ctx: LlmCtx, prompt: string, size: string, negativePrompt?: string, seed?: number): Promise<string> {
    const payload: Record<string, any> = { prompt, size, n: 1 };
    // 2026-07-30:支持 negative_prompt(用于角色四视图反向约束,避免"背面"生成成正面)
    if (negativePrompt) payload.negative_prompt = negativePrompt;
    // 2026-09-05:seed 锁定(内容级实测确认生效)—— 定妆/补画可复现同一张图。
    //   ⚠️ 实测范围 [0,999],越界 400,统一 clamp。
    if (seed != null && Number.isFinite(Number(seed))) {
      payload.seed = Math.min(999, Math.max(0, Math.floor(Number(seed))));
    }
    const result = await this.dispatcher.dispatch(
      'image.agnes-image-2.5-flash',
      payload,
      null,
      {
        taskId: 0n,
        userId: ctx.userId,
        agentId: ctx.agentId,
        signal: new AbortController().signal,
        upstreamOutputs: {},
      } as any,
    );
    const artifacts = (result as any).artifacts || [];
    if (artifacts.length === 0) throw new Error('图像生成未返回产物');
    return artifacts[0].remoteUrl || artifacts[0].url || '';
  }

  private async callVideoI2v(
    ctx: LlmCtx, prompt: string, imageUrl: string, seconds: number, aspect = '9:16',
  ): Promise<string> {
    // 2026-08-27:agnes-video-2.5-flash 参数体系(旧 num_frames/frame_rate/width/height 已移除)
    //   mode=keyframe + first_frame + seconds("4"-"12" 字符串)+ size="720P" + aspect_ratio
    const secStr = String(Math.min(12, Math.max(4, Math.round(seconds))));
    const result = await this.dispatcher.dispatch(
      'video.agnes-v2-i2v',
      {
        prompt,
        image: imageUrl,
        seconds: secStr,
        size: '720P',
        aspect_ratio: aspect,
      },
      null,
      {
        taskId: 0n,
        userId: ctx.userId,
        agentId: ctx.agentId,
        signal: new AbortController().signal,
        upstreamOutputs: {},
      } as any,
    );
    const artifacts = (result as any).artifacts || [];
    if (artifacts.length === 0) throw new Error('视频生成未返回产物');
    return artifacts[0].remoteUrl || artifacts[0].url || '';
  }

  // ===========================================================================
  // 辅助:文件 / JSON / DB
  // ===========================================================================

  async downloadFile(url: string, dest: string): Promise<void> {
    const axios = require('axios').default || require('axios');
    const resp = await axios.get(url, { responseType: 'stream', timeout: 120_000 });
    const ws = fs.createWriteStream(dest);
    await new Promise<void>((resolve, reject) => {
      resp.data.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    });
  }

  /**
   * P1-a 尾帧接力:下载某镜成片视频 → ffmpeg 抽**最后一帧** → 传 OSS → 返回公网可取 URL,
   * 供下一镜 i2v 当首帧参考(外部 Agnes 必须能公网拉到,本地 /uploads 不行)。
   * 任何环节失败 / OSS 不可用 / 只拿到本地相对路径 → 返回 null,调用方安全退回该镜自己的关键帧。
   */
  private async extractTailFramePublicUrl(
    videoUrl: string, workDir: string, shotIdx: number,
  ): Promise<string | null> {
    try {
      if (!this.oss || !videoUrl) return null;
      const ffmpegBin = this.resolveFfmpegBin();
      if (!ffmpegBin) return null;
      fs.mkdirSync(workDir, { recursive: true });
      const localVideo = path.join(workDir, `relay_src_${shotIdx}.mp4`);
      const framePath = path.join(workDir, `relay_tail_${shotIdx}.jpg`);
      await this.downloadFile(videoUrl, localVideo);
      // 2026-09-21: -sseof -0.25: 避开末端 0.15s 可能出现的动态模糊或黑屏衰减, 保证抽出的接力尾帧清晰稳定
      await this.runFfmpeg(ffmpegBin, [
        '-hide_banner', '-y', '-sseof', '-0.25', '-i', localVideo,
        '-frames:v', '1', '-q:v', '2', framePath,
      ]);
      if (!fs.existsSync(framePath)) return null;
      const up = await this.oss.uploadFile(framePath, `relay_tail_${shotIdx}.jpg`, {
        prefix: 'drama-relay', contentType: 'image/jpeg',
      });
      const pub = up.cdnUrl || up.url || '';
      // 只接受公网 http(s);本地 /uploads 相对路径外部 Agnes 拉不到 → 判不可用
      return /^https?:\/\//i.test(pub) ? pub : null;
    } catch (e: any) {
      this.logger.warn(`[relay] 抽尾帧/上传失败(退回关键帧,不阻断): shot ${shotIdx} ${e?.message}`);
      return null;
    }
  }

  // 2026-09-15 移除 buildSrt / formatSrtTime（旧的字幕实现）。
  //
  //   旧实现是「按镜头 duration_sec 线性累加」——整句一块、起点靠估。它有两个
  //   已被实测证伪的前提：① 模型会从镜头第 0 秒开口；② 镜头时长等于脚本设定。
  //   实测 shot5.mp4：字幕写 0~5s，人声 1.22s 才起。
  //
  //   现在统一走 `drama/timeline.ts` 的语义锚点时间轴（词级证据 + 可调呈现），
  //   单测在 timeline.spec.ts。**不要在这里重新长出一份 SRT 拼装逻辑** ——
  //   两份实现必然分叉，是这个项目反复踩过的坑（见 drama.service 顶部注释）。

  /**
   * 解析 ffmpeg 可执行文件路径:
   *   1. FFMPEG_BIN 环境变量(如果文件存在)
   *   2. PATH 里的 ffmpeg
   *   3. 常见安装路径兜底
   */
  private resolveFfmpegBin(): string {
    // 2026-07-31:修复逻辑 —— 之前 'ffmpeg'(PATH)在候选列表前面,
    //   循环时第一个就 return 'ffmpeg',跳过了后面的具体路径。
    //   如果 ffmpeg 不在 PATH 里,但装在 F:\ffmpeg-8.1.2,就会 ENOENT。
    //   现在改为:先检查 FFMPEG_BIN + 具体路径,都不存在才回退到 'ffmpeg'(PATH)。
    const candidates: string[] = [];
    if (process.env.FFMPEG_BIN) candidates.push(process.env.FFMPEG_BIN);
    candidates.push(
      'F:\\ffmpeg-8.1.2\\bin\\ffmpeg.exe',
      'F:\\ffmpeg\\bin\\ffmpeg.exe',
      'D:\\metaverse\\chatgpt\\ffmpeg-6.0-full_build\\ffmpeg-6.0-full_build\\bin\\ffmpeg.exe',
      'D:\\360WiFi\\ffmpeg-n6.0-latest-win64-lgpl-6.0\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    );
    for (const c of candidates) {
      if (!c) continue;
      if (fs.existsSync(c)) return c;
    }
    // 最后回退到 PATH 查找(交给 spawn 处理)
    return 'ffmpeg';
  }

  /**
   * 解析 LLM 返回的 JSON(容错链见 parseJsonSafeRaw)。
   * 2026-09-15:出口统一做键名规范化 —— agnes-3.0-flash 偶发把键名写成
   *   `"  text": "..."`(引号内带缩进空格),JSON.parse 合法但 `obj.text` 取不到,
   *   上层读字段全 undefined。这类"解析成功却用不了"的坑在下游各域都踩过,
   *   所以收在解析出口一处修,所有调用点自动受益。
   */
  parseJsonSafe(raw: string): any {
    return this.normalizeKeys(this.parseJsonSafeRaw(raw));
  }

  /** 递归 trim 全部对象键名(数组逐项);值不动 */
  private normalizeKeys(obj: any): any {
    if (Array.isArray(obj)) return obj.map((x) => this.normalizeKeys(x));
    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) out[String(k).trim()] = this.normalizeKeys(v);
      return out;
    }
    return obj;
  }

  private parseJsonSafeRaw(raw: string): any {
    const tryParse = (s: string): any => {
      try {
        let cleaned = (s || '').trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    };

    // 1. 直接解析
    let parsed = tryParse(raw);
    if (parsed) return parsed;

    // 2. 提取 {} 块
    const m = (raw || '').match(/\{[\s\S]*\}/);
    if (m) {
      parsed = tryParse(m[0]);
      if (parsed) return parsed;
    }

    // 3. 修复 LLM 常见 JSON 错误
    const fixed = this.fixLlmJson(raw || '');
    parsed = tryParse(fixed);
    if (parsed) return parsed;

    const m2 = fixed.match(/\{[\s\S]*\}/);
    if (m2) {
      parsed = tryParse(m2[0]);
      if (parsed) return parsed;
    }

    // 4. 修复字符串值内未转义换行符(常见 LLM 错误)
    //    LLM 经常输出: "logline": "第一行\n第二行  (引号没闭合就换行)
    //    把字符串值内部的裸换行替换为 \n 转义,让 JSON.parse 能通过
    const newlineFixed = this.fixUnclosedStringNewlines(raw || '');
    if (newlineFixed !== raw) {
      parsed = tryParse(newlineFixed);
      if (parsed) return parsed;
      const m3 = newlineFixed.match(/\{[\s\S]*\}/);
      if (m3) {
        parsed = tryParse(m3[0]);
        if (parsed) return parsed;
      }
      // 再走一遍 fixLlmJson
      const fixed2 = this.fixLlmJson(newlineFixed);
      parsed = tryParse(fixed2);
      if (parsed) return parsed;
      const m4 = fixed2.match(/\{[\s\S]*\}/);
      if (m4) {
        parsed = tryParse(m4[0]);
        if (parsed) return parsed;
      }
    }

    // 5. 2026-09-22:抢救**被截断**的 JSON。
    //    上游把 LLM 输出掐断时(实测分镜 raw 只有 4119 字符就断),最后一条
    //    shot 的字符串没闭合、括号也没配平 —— 前 4 层全部失效,整步直接抛
    //    "LLM 生成分镜失败",连集批次随即**整集跳过**(EP1 实测就这么没了)。
    //    这里从末尾往前找收口点截断 + 补括号,能救回前面那些完整镜头;
    //    丢最后一两镜的代价远小于整集报废(且下游时长校准会把总时长补回来)。
    const salvaged = this.salvageTruncatedJson(raw || '');
    if (salvaged) return salvaged;

    return null;
  }

  /** 按当前括号/字符串栈把未闭合的 JSON 补齐(供 salvageTruncatedJson 用) */
  private closeBrackets(s: string): string {
    let inStr = false, esc = false;
    const stack: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
    }
    let out = s;
    if (inStr) out += '"';
    for (let i = stack.length - 1; i >= 0; i--) out += (stack[i] === '{' ? '}' : ']');
    // 悬空逗号:截断常停在 "xxx", 后面直接收口 → ",}" 非法
    return out.replace(/,\s*([}\]])/g, '$1');
  }

  /**
   * 截断 JSON 抢救:从末尾往前试每个 } / ] 作为收口点,补齐括号后解析。
   * 只接受**能拿到非空 shots 数组**的结果 —— 救出空壳没有意义。
   */
  private salvageTruncatedJson(raw: string): any {
    let s = (raw || '').trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '');
    const start = s.indexOf('{');
    if (start < 0) return null;
    s = s.slice(start);
    // 截断到只剩 50 字符就没救了,直接放弃(避免整段乱拼)
    if (s.length < 50) return null;
    for (let i = s.length - 1; i >= 50; i--) {
      const c = s[i];
      if (c !== '}' && c !== ']') continue;
      const closed = this.closeBrackets(s.slice(0, i + 1));
      try {
        const p = JSON.parse(closed);
        if (p && Array.isArray(p.shots) && p.shots.length) {
          this.logger.warn(`[json-salvage] 截断 JSON 抢救成功:保留 ${p.shots.length} 镜(原文 ${raw.length} 字符)`);
          return p;
        }
      } catch { /* 继续往前试 */ }
    }
    return null;
  }

  /**
   * 修复 LLM 输出 JSON 时字符串值内未转义换行符的问题。
   *
   * LLM 常见错误:
   *   "logline": "三国名将赵云穿越民国上海滩，以兵法武艺在帮派混战中杀出一条血路，成为黑帮新王。
   *   "synopsis": "三国名将赵云在长坂坡力战曹军...
   *
   * logline 的引号在换行前没闭合,下一行直接是新的 "key":,破坏 JSON 结构。
   *
   * 修复策略:逐字符扫描,跟踪是否在字符串内部。在字符串内部遇到裸换行符时,
   * 替换为 \\n 转义;遇到下一个 "key": 模式时,先补上闭合引号。
   */
  private fixUnclosedStringNewlines(raw: string): string {
    if (!raw) return raw;
    const result: string[] = [];
    let inString = false;
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (!inString) {
        if (ch === '"') {
          inString = true;
          // 检查这是否是 key 位置(key 前面是 { 或 , 或空白)
          // 不做特殊处理,统一进入字符串模式
        }
        result.push(ch);
        i++;
      } else {
        // 在字符串内部
        if (ch === '\\') {
          // 转义字符,原样保留两位
          result.push(ch, raw[i + 1] || '');
          i += 2;
        } else if (ch === '"') {
          // 可能是字符串结束,也可能是字符串内部的裸引号
          // 看后面是否跟着 : 或 , 或 } 或 ] 或换行后的 "key":
          const rest = raw.slice(i + 1, i + 20);
          if (/^\s*:/.test(rest) || /^\s*,/.test(rest) || /^\s*\}/.test(rest) || /^\s*\]/.test(rest)) {
            // 字符串正常结束
            inString = false;
            result.push(ch);
            i++;
          } else {
            // 字符串内部的裸引号,转义它
            result.push('\\"');
            i++;
          }
        } else if (ch === '\n' || ch === '\r') {
          // 字符串内部的裸换行符,替换为 \\n
          // 但要先检查这一行是否实际是新的 "key": 行(LLM 未闭合引号的情况)
          // 向前看:从当前换行后到下一个非空白字符,如果是 "xxx": 模式
          // 且当前累积的字符串已经有内容,则先补闭合引号 + 逗号
          const lineEnd = raw.indexOf('\n', i + 1);
          const nextLine = raw.slice(i + 1, lineEnd === -1 ? raw.length : lineEnd).trim();
          if (/^"\w+"\s*:/.test(nextLine)) {
            // 下一行是新 key,说明当前字符串没闭合,补上引号 + 逗号
            // (JSON 对象的 key-value 之间必须用逗号分隔)
            inString = false;
            result.push('",', ch);
            i++;
          } else {
            // 字符串内部的正常换行,转义
            result.push('\\n');
            if (ch === '\r' && raw[i + 1] === '\n') i += 2;
            else i++;
          }
        } else {
          result.push(ch);
          i++;
        }
      }
    }
    // 如果扫描结束时仍在字符串内,补上闭合引号
    if (inString) result.push('"');
    return result.join('');
  }

  /**
   * 修复 LLM 输出 JSON 时的常见错误:
   *   1. "dialogue: "xxx"" → "dialogue": "xxx"     (key 后面缺少引号)
   *   2. "dialogue": (xxx)"yyy"" → "dialogue": "(xxx)yyy"  (value 缺少左引号)
   *   3. 中文引号 转 英文引号
   *   4. "key": "value"(trailing junk)", → "key": "value(trailing junk)",
   * 逐行处理,对每个 "key": xxx 行,如果 xxx 不是合法 JSON value,尝试修复。
   */
  private fixLlmJson(raw: string): string {
    let s = raw;
    // 中文引号 → 英文引号
    s = s.replace(/[""]/g, '"').replace(/['']/g, "'");
    // 修复 "key: "value"" → "key": "value"  (key 后缺少引号)
    s = s.replace(/"(\w+)\s*:\s*"/g, (_, k) => `"${k}": "`);

    // 逐行处理 dialogue/description 等字符串字段
    const lines = s.split(/\r?\n/);
    const fixedLines = lines.map((line) => {
      // 匹配 "key": value 形式,value 不是 " / [ / { / 数字 / true / false / null 开头
      const m = line.match(/^(\s*"\w+"\s*:\s*)([^"\s\[{]\S*)$/);
      if (!m) return line;
      const [, prefix, value] = m;
      // value 末尾应该是 , 或 } 或 ]
      const trailMatch = value.match(/^(.*?)([,\}\]]\s*)$/);
      if (!trailMatch) return line;
      let [, main, trail] = trailMatch;
      // main 现在是值内容,但可能含多余的 "
      // 去掉所有 ",重新加一对
      main = main.replace(/"/g, '');
      return `${prefix}"${main}"${trail}`;
    });
    return fixedLines.join('\n');
  }

  private parseStepData(raw: any): Record<string, any> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw as Record<string, any>;
  }

  private async getRow(uuid: string): Promise<DramaRow> {
    const rows = await this.prisma.$queryRawUnsafe<DramaRow[]>(
      `SELECT * FROM \`MicroDramaSession\` WHERE \`uuid\` = ? LIMIT 1`,
      uuid,
    );
    if (!rows || rows.length === 0) throw new NotFoundException(`会话不存在: ${uuid}`);
    return rows[0];
  }

  private async saveStepData(uuid: string, stepData: Record<string, any>): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`MicroDramaSession\` SET \`stepData\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`uuid\` = ?`,
      JSON.stringify(stepData), uuid,
    );
  }

  private formatRow(row: DramaRow): any {
    return {
      id: row.id?.toString?.() ?? String(row.id),
      uuid: row.uuid,
      userId: row.userId?.toString?.() ?? String(row.userId),
      agentId: row.agentId?.toString?.() ?? String(row.agentId),
      title: row.title,
      status: row.status,
      currentStep: row.currentStep,
      stepData: this.parseStepData(row.stepData),
      stepLabels: STEP_LABELS,
      taskId: row.taskId?.toString?.() ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
