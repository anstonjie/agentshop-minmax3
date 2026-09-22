// ============================================================================
// DramaOrchestrator —— 一键连集的队列编排器
// ----------------------------------------------------------------------------
// 结构:一个 batch job → 集与集**串行**(叙事状态有依赖,并行会让快照互相覆盖)
//       → 集内 0..5 步串行 → 步内复用 DramaService 已有的逐镜推进能力。
//
// 三条不可省的设计:
//  1. **断点可续**:每一步完成都把 cursor 写进 DB。backend 跑的是
//     `node dist/src/main`,进程重启会杀掉一切进程内任务;恢复靠的是
//     onApplicationBootstrap 扫 status=running 的批次从 cursor 续跑,
//     而不是从零重烧配额。
//  2. **预算闸**:按已消耗单元折算积分,达 warnAt 推预警、达 100% 自动 paused。
//     连集最怕"醒来发现积分烧光",所以是暂停而不是报错 —— 用户回来能续跑。
//  3. **失败隔离**:单步失败默认不中断整批(stopOnFailure=false),
//     该集标 degraded 并继续下一集;只有故事线依赖断裂(第 0/1 步失败)才停,
//     因为后面的集没有可承接的状态,继续跑等于白烧。
//
// 进度复用 ProgressGateway(命名空间 /usage,房间名 = taskId),
// 这里用 `batch:<uuid>` 当房间键,前端 WsProgressClient.subscribe 无需改动。
// ============================================================================

import {
  Injectable, Logger, OnApplicationBootstrap,
} from '@nestjs/common';
import type { Job } from 'bullmq';
import { DramaService } from './drama.service';
import { NovelLedgerService } from './novel-ledger.service';
import { QueueService, type DramaBatchJobData } from '../runtime/queue.service';
import { ProgressGateway } from '../runtime/progress.gateway';
import { runInBatchScope } from '../../common/upstream-heartbeat';
import {
  resolvePrices, unitsFromStepOutput, addUnits, unitsToCredits,
  checkBudget, type StepUnits, type UnitPrices,
} from './drama-pricing';
import {
  evaluateComposeGate, composeGateEnabled, composeGateMaxRounds,
} from './compose-gate';

/** 房间键:与 usage taskId 命名空间共存但不会撞(usage 用的是 uuid 纯串) */
export const batchRoom = (batchUuid: string) => `batch:${batchUuid}`;

/**
 * 关键帧退化闸的阈值:本集**已出图**的镜头里,无参考图(纯文生图)的占比
 * 达到这个值就认为"继续生成视频必然全程换脸"。
 *
 * 为什么卡在 0.5:退化镜头是逐镜独立的,一半以上没参考图时,同一角色在相邻
 * 镜头里长得不一样的概率已经接近必然,片子没法看;而再往后每镜要烧 40 积分的
 * 视频配额(一集 12 镜 ≈ 480 分),产出的还是一部废片。
 * 阈值留了余量 —— 少数镜头退化是正常的(新角色第一次出场、场景空镜),
 * 不该因为一两张图就把整集拦下来。
 */
export const DEGRADED_RATIO_BLOCK = 0.5;

/** 僵尸巡检:worker 刚接手 active job 的竞态宽限(此期间内不判定为僵尸) */
export const ZOMBIE_GRACE_MS = 2 * 60 * 1000;
/** 僵尸巡检:批次 updatedAt 在这个间隔内有更新,就认为有活的执行者(防跨进程误杀) */
export const ZOMBIE_ACTIVE_FRESH_MS = 3 * 60 * 1000;
/** 僵尸巡检:同一批次两次"自动续跑"之间的冷却,避免卡住→重入→又卡住的循环 */
export const AUTO_RESUME_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 本集关键帧是否退化到"不该继续烧视频配额"的程度。
 *
 * 退化 = 这一镜没拿到任何参考图,走的是纯文生图 —— 同一角色在不同镜头里会被
 * 画成不同的人。实测 2026-09-15:全局 477 帧里 193 帧退化(40.5%),剧 65 的
 * 86 帧、剧 59 的 98 帧是 100% 退化,那两部剧每一镜都在换脸,而用户看不到
 * 任何提示(退化只静静躺在 stepData 里)。
 *
 * 判定只读 step3 自己写的字段(`degraded_count` 由 genStep3 落库),不在这里
 * 重算 —— 保持单一真相源。
 */
export function shouldBlockOnDegraded(keyframeOutput: any): boolean {
  const kfs = Array.isArray(keyframeOutput?.keyframes) ? keyframeOutput.keyframes : [];
  const drawn = kfs.filter((k: any) => k?.url); // 只算真的出图了的
  if (!drawn.length) return false;             // 一张图都没有是另一种失败,不归这里管
  const degraded = drawn.filter((k: any) => k?.degraded === true).length;
  return degraded / drawn.length >= DEGRADED_RATIO_BLOCK;
}

/** 退化闸的说明文案:写进批次时间线 + 集降级原因,用户要看得懂、知道下一步做什么 */
export function degradedReason(keyframeOutput: any): string {
  const kfs = Array.isArray(keyframeOutput?.keyframes) ? keyframeOutput.keyframes : [];
  const drawn = kfs.filter((k: any) => k?.url);
  const degraded = drawn.filter((k: any) => k?.degraded === true).length;
  return `本集 ${degraded}/${drawn.length} 张关键帧没有参考图(纯文生图),`
    + `继续生成视频会全程换脸,已跳过本集的视频与成片,不烧这部分配额。`
    + `请先到资产库点「一键定妆剩余 N 项」补齐定妆,再回来重做本集。`;
}

/** 这几步失败会切断"下一集可承接的状态",必须停批;其余步骤可降级继续 */
const BLOCKING_STEPS = new Set([0, 1]);

/**
 * 步骤 4 的产出里有没有「没拿到视频」的镜头。
 *
 * 存在的理由:幂等判定用的是「这一步有没有 output」,但步骤 4 是**部分成功**语义 ——
 * 一集 14 镜里挂 3 个,产出照样写库。只看 output 的话,续跑时整步被跳过,
 * 那 3 个失败镜头**永远不会被自动补做**,`genStep7Compose` 又用
 * `if (!video_url) continue` 把它们静默丢掉,最终成片缺镜而用户毫无感知。
 * 实测 2026-09-15:全局 437 个镜头里 103 个 failed(23.6%),全部是这种死账。
 *
 * 补做不会浪费配额:`genStep6ShotVideos` 的 `reuseMap` 只复用
 * `status==='completed' && video_url` 的镜头(且会先探测 URL 存活),
 * 其余才会重跑 —— 所以让这一步重进一次是安全的。
 *
 * `skipped`(没有关键帧可作首帧)不算:重跑还是 skipped,只会白等一轮限流窗口。
 */
export function hasFailedShots(videoOutput: any): boolean {
  const shots = Array.isArray(videoOutput?.shots) ? videoOutput.shots : [];
  return shots.some((s: any) => s && (s.status === 'failed' || s.status === 'pending'));
}

/**
 * 一段步骤序列跑完后的结论。
 *
 * `cont`     —— 批次还能不能往下走(被暂停/取消/预算闸拦下时为 false,
 *               批次终态已由 runSteps 自己写好,调用方直接 return 即可)。
 * `degraded` —— 本集被降级(退化闸命中,或非阻断步失败)。
 *               降级不等于停批,但**本集后面的步骤不能再跑** —— 它们依赖
 *               本集前序产物,硬跑只会拿到半成品再烧一遍配额。
 */
export interface StepRunResult {
  cont: boolean;
  degraded: boolean;
}

/**
 * 一次批次的**可变共享状态**。
 *
 * 存在的理由:改成集间流水线后,同一个批次里会有两段步骤序列同时在飞
 * (上一集的 4..5 与下一集的 0..3)。它们必须看到同一份预算账 —— 否则
 * 两条线各自从"开跑时的 spent"往上加,预算闸会晚一集才生效,用户醒来
 * 发现超支。所以这里用对象持有,两条线写的是同一个 `spent` / `unitsTotal`。
 *
 * `epTargetSec` 在开跑时解析一次(见 execute 的说明),两条线共用。
 */
export interface BatchRunState {
  dramaUuid: string;
  prices: UnitPrices;
  /** 预算上限(积分);0 = 不限 */
  budget: number;
  /** 单步失败是否中断整批 */
  stopOnFailure: boolean;
  /** 单集目标时长(秒),透传到 step0 大纲与 step2 分镜;**0 = 未知,由 drama.service 查账本** */
  epTargetSec: number;
  /** 已消耗(折算积分),两条线累加同一个值 */
  spent: number;
  /** 已消耗(原始单元数),推完成事件时上报 */
  unitsTotal: StepUnits;
}

@Injectable()
export class DramaOrchestrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(DramaOrchestrator.name);

  /** 本进程正在跑的批次,用于快速取消与防重复启动 */
  private readonly running = new Map<string, { cancel: boolean }>();

  /** 巡检自动续跑的时间戳(批次 uuid → ms),用于冷却,防重复拉起 */
  private readonly autoResumedAt = new Map<string, number>();

  constructor(
    private readonly svc: DramaService,
    private readonly queue: QueueService,
    private readonly progress: ProgressGateway,
    private readonly ledger: NovelLedgerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queue.dramaQueueAvailable) {
      this.logger.warn('连集队列不可用(Redis 未就绪),一键连集将退化为手动逐集');
      return;
    }
    this.queue.registerDramaExecutor(async (job) => this.handleJob(job));
    this.logger.log('连集 worker 已注册');
    // 自愈:上次进程被杀时正在跑的批次,从断点续跑
    await this.resumeInterrupted();
  }

  /**
   * 入队一批连集。队列不可用时直接拒绝,让前端给出可操作的提示。
   *
   * `force` 由"用户手动续跑"这条路径传入。队列里的 jobId 就是 batchUuid,
   * BullMQ 对同 id 的任务会静默跳过(哪怕是上一轮进程留下的 active 僵尸)——
   * 不 force 的话,接口返回 `enqueued: true` 但批次其实一动不动。
   * 2026-09-14 drama 65 卡了一整晚就是这个原因:用户点了续跑,后端回成功,队列没动。
   */
  async startBatch(
    batchUuid: string, dramaUuid: string, userId: number,
    opts?: { force?: boolean },
  ): Promise<string> {
    if (!this.queue.dramaQueueAvailable) {
      throw new Error('连集队列不可用:Redis 未启动。可先手动逐集生产。');
    }
    return this.queue.enqueueDramaBatch({ batchUuid, dramaUuid, userId }, opts);
  }

  private async handleJob(job: Job<DramaBatchJobData>) {
    const { batchUuid } = job.data;
    await this.runBatch(batchUuid);
    return { batchUuid };
  }

  /**
   * 进程重启后恢复:把上次 running 的批次重新入队。
   * 注意只恢复**本进程负责**的批次 —— 单机部署下就是全部。
   */
  private async resumeInterrupted(): Promise<void> {
    try {
      const interrupted = await this.svc.findRunningBatches();
      if (!interrupted.length) return;
      this.logger.warn(`发现 ${interrupted.length} 个中断的连集批次,从断点续跑`);
      for (const b of interrupted) {
        // 必须 force:上一轮进程留下的同 id 任务还挂在队列里(多为 active),
        // 不强制移除的话入队会被静默忽略 —— 日志写着"已恢复"但批次其实没动。
        // 2026-09-14 drama 65 就是这么被卡了一整晚(12 次"恢复"全是空转)。
        try {
          await this.queue.enqueueDramaBatch(
            { batchUuid: b.uuid, dramaUuid: b.dramaUuid, userId: Number(b.userId) },
            { force: true },
          );
          await this.svc.appendBatchLog(b.uuid, {
            ep: b.cursorEp, step: b.cursorStep, ok: true,
            msg: '后端重启,已重新入队,从断点续跑',
          }).catch(() => null);
        } catch (e: any) {
          this.logger.warn(`续跑入队失败 ${b.uuid}: ${e?.message}`);
          // 入队失败也要让用户看见(否则又是一条"看起来已恢复"的假日志)
          await this.svc.appendBatchLog(b.uuid, {
            ep: b.cursorEp, step: b.cursorStep, ok: false,
            msg: `续跑入队失败:${(e?.message || String(e)).slice(0, 160)}`,
          }).catch(() => null);
        }
      }
    } catch (e: any) {
      this.logger.warn(`恢复中断批次失败(不影响启动): ${e?.message}`);
    }
  }

  /**
   * 僵尸槽位巡检:清掉占着 `concurrency=1` 唯一槽位、却不可能再推进的 active job。
   * 由 `NovelPipelineService.scheduledGateSweep()` 每 5 分钟调用。
   *
   * 背景(2026-09-22 实测):一个跑了 11 小时卡在 EP9 的遗留批次被用户取消后,
   * DB 状态已经是 cancelled,但 Redis 里的 active job 还带锁占着槽位 —— 之后
   * 新建的批次全部"入队成功、一步不跑"。救火只能手动 `DEL ...:lock` + clean,
   * 而这事本该由程序自己发现。
   *
   * 判据(三条,任一命中即清):
   *   ① 批次记录不存在 / 已 done|failed|cancelled → 无论如何都不该再占槽位;
   *   ② 批次仍是 running,但**本进程没有它的执行者** —— 单机部署下 worker 就是
   *      本进程注册的,`running` map 里没有它 = 执行者是上一轮被杀的进程;
   *   ③ 排除竞态:worker 刚接手还没写进 running map(2 分钟宽限)、
   *      或批次 3 分钟内还有进度写入(防跨进程误杀)。
   *
   * 清完之后:若批次仍是 running(用户没放弃),自动重新入队续跑 ——
   * 断点由 cursorEp/cursorStep 保证,已完成的步骤会被幂等跳过,不会重烧配额。
   * 同一批次的自动恢复有 30 分钟冷却,避免"卡住→重入→又卡住"的无限循环。
   */
  async sweepZombieDramaSlots(): Promise<number> {
    if (!this.queue.dramaQueueAvailable) return 0;
    const actives = await this.queue.listDramaActiveJobs().catch(() => []);
    if (!actives.length) return 0;

    let cleaned = 0;
    for (const a of actives) {
      const bUuid = a.batchUuid;
      // ③-a 本进程正在跑 → 活的
      if (bUuid && this.running.has(bUuid)) continue;
      // ③-b worker 刚接手(还没写进 running map)→ 给它 2 分钟
      if (a.processedOn && Date.now() - a.processedOn < ZOMBIE_GRACE_MS) continue;

      const batch = bUuid
        ? await this.svc.getBatch(bUuid).catch(() => null)
        : null;
      const status: string | null = batch?.status ?? null;

      if (status === 'running') {
        const freshMs = batch?.updatedAt
          ? Date.now() - new Date(batch.updatedAt).getTime() : Infinity;
        // ③-c 3 分钟内还有进度写入 → 有活的执行者(可能是别的进程),不碰
        if (Number.isFinite(freshMs) && freshMs < ZOMBIE_ACTIVE_FRESH_MS) continue;
      }

      const reason = !batch
        ? '批次记录已不存在'
        : ['done', 'failed', 'cancelled'].includes(status as string)
          ? `批次已 ${status}`
          : 'DB 仍是 running 但本进程没有执行者(上一轮进程留下的僵尸)';

      const ok = await this.queue.purgeDramaJob(a.jobId).catch(() => false);
      if (!ok) {
        this.logger.warn(`[巡检] 僵尸槽位 ${a.jobId} 清理失败(${reason}),下个周期再试`);
        continue;
      }
      cleaned += 1;
      this.logger.warn(`[巡检] 已清理僵尸槽位 ${a.jobId}(${reason})`);

      if (!batch || !bUuid) continue;
      if (status !== 'running') continue; // 用户已取消/已收尾,不再拉起

      const last = this.autoResumedAt.get(bUuid) ?? 0;
      if (Date.now() - last < AUTO_RESUME_COOLDOWN_MS) continue;
      this.autoResumedAt.set(bUuid, Date.now());
      try {
        await this.queue.enqueueDramaBatch(
          { batchUuid: bUuid, dramaUuid: String(batch.dramaUuid || ''), userId: Number(batch.userId) },
          { force: true },
        );
        await this.svc.appendBatchLog(bUuid, {
          ep: Number(batch.cursorEp) || 0, step: Number(batch.cursorStep) || 0, ok: true,
          msg: '巡检发现槽位被僵尸占用,已清理并从断点重新入队',
        }).catch(() => null);
        this.logger.warn(`[巡检] 批次 ${bUuid} 已重新入队续跑(EP${batch.cursorEp} 第 ${batch.cursorStep} 步)`);
      } catch (e: any) {
        await this.svc.appendBatchLog(bUuid, {
          ep: Number(batch.cursorEp) || 0, step: Number(batch.cursorStep) || 0, ok: false,
          msg: `巡检续跑失败:${String(e?.message || e).slice(0, 160)}`,
        }).catch(() => null);
      }
    }
    return cleaned;
  }

  /** 跑一批(幂等:已完成的步骤会被跳过) */
  async runBatch(batchUuid: string): Promise<void> {
    if (this.running.has(batchUuid)) {
      this.logger.log(`批次 ${batchUuid} 已在本进程运行,跳过重复启动`);
      return;
    }
    const token = { cancel: false };
    this.running.set(batchUuid, token);

    let batch: any;
    try {
      batch = await this.svc.getBatch(batchUuid);
    } finally {
      // getBatch 失败也要清占位,否则该批次永远无法重试
    }

    try {
      if (!batch) throw new Error('批次不存在');
      if (['done', 'cancelled'].includes(batch.status)) {
        this.logger.log(`批次 ${batchUuid} 已是 ${batch.status},无需运行`);
        return;
      }
      await this.svc.setBatchStatus(batchUuid, 'running');
      await this.execute(batch, token);
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.logger.error(`批次 ${batchUuid} 异常: ${msg}`);
      await this.svc.finishBatch(batchUuid, 'failed', msg).catch(() => null);
      this.progress.emitFailed(batchRoom(batchUuid), msg);
    } finally {
      this.running.delete(batchUuid);
      // 收尾:批次到终态后把指向它的 producing 门一并落定。缺了这一步,
      // 门会永远停在 producing(前端 4s 轮询停不下来、payload 也不反映事实)。
      await this.settleGate(batchUuid);
    }
  }

  /**
   * 批次跑完后把门③ 的 payload 从 producing 推进到终态。
   * state 仍保留 'producing' —— 前端 `_buildGate3Card` 靠它选择渲染生产卡片;
   * 真正的终态写在 `batchStatus` 上,前端据此停止轮询。
   */
  private async settleGate(batchUuid: string): Promise<void> {
    try {
      const b = await this.svc.getBatch(batchUuid);
      const st = b?.status;
      if (st !== 'done' && st !== 'failed' && st !== 'cancelled') return;
      const n = await this.ledger.settleProducingGateForBatch(batchUuid, {
        batchStatus: st,
        settledAt: new Date().toISOString(),
        ...(st === 'failed' && b?.error ? { batchError: b.error } : {}),
      });
      if (n) this.logger.log(`批次 ${batchUuid} 终态 ${st},已收尾 ${n} 个 producing 门`);
    } catch (e: any) {
      this.logger.warn(`门收尾失败 ${batchUuid}(不影响批次): ${e?.message}`);
    }
  }

  private async execute(batch: any, token: { cancel: boolean }): Promise<void> {
    const dramaUuid = batch.dramaUuid;
    const prices = resolvePrices(batch.policy);
    const state: BatchRunState = {
      dramaUuid,
      prices,
      budget: Number(batch.policy?.budgetCredits) || 0,
      stopOnFailure: batch.policy?.stopOnFailure === true,
      // 单集目标时长(秒)。2026-09-15 之前这个值只喂给了 n2d-core 的切集步骤,
      // 生成链路完全不知道它 —— 于是用户选 120 秒、拿到 43 秒。现在由批次策略
      // 一路透传到 step0(大纲)与 step2(分镜)。
      //
      // ⚠ 拿不到时给 **0 而不是 120**:0 在 `resolveEpTargetSec` 里是"未知,你去
      // 查账本"的信号(优先级 input → 账本 meta.budget.ep_target_sec → 120)。
      // 这里若填 120,就会把账本里用户真正选的值(比如 60)盖掉 —— 参数化
      // 反而变成了写死。
      epTargetSec: Number(batch.policy?.epTargetSec) > 0
        ? Math.round(Number(batch.policy.epTargetSec)) : 0,
      spent: await this.svc.batchSpentCredits(batch.uuid, prices),
      unitsTotal: { images: 0, videos: 0, llms: 0 },
    };

    // ── 集间流水线 ──────────────────────────────────────────────────────
    // 上一集的「视频 + 成片」挂在这里后台跑,与下一集的「大纲/预检/分镜/关键帧」
    // 并行。收益来自一个事实:步骤 4 的绝大部分时间是在**等视频通道的限流窗口**
    // (每 key 每分钟只准建 1 个任务,实测单集 509 秒 = 全链路 76%),那段时间里
    // LLM 与图像通道完全闲置,而下一集的步骤 0-3 合计只要 145 秒。
    //
    // 能安全并行,是因为叙事状态的回写时机已经前移到步骤 0
    // (`mergeNarrativeSnapshot`,见 drama.service.ts 的说明)——
    // 下一集的大纲只依赖本集第 0 步的产出,不再等本集的视频跑完。
    //
    // 同一时刻只让**一集**的视频段在飞:视频通道是全局限流资源,两集交错排队
    // 不会提高吞吐,只会让批次时间线读起来毫无头绪。
    let videoPhase: Promise<StepRunResult> | null = null;

    for (let epNo = batch.fromEp; epNo <= batch.toEp; epNo++) {
      if (token.cancel) return this.abort(batch, '用户取消');

      // 外部暂停/取消:每集开始前检查一次 DB,支持从别的进程控制
      const fresh = await this.svc.getBatch(batch.uuid);
      if (fresh.status === 'paused') {
        this.logger.log(`批次 ${fresh.uuid} 已暂停,停在 EP${epNo} 前`);
        await this.drainVideoPhase(videoPhase);
        return;
      }
      if (fresh.status === 'cancelled') {
        await this.drainVideoPhase(videoPhase);
        return this.abort(batch, '用户取消');
      }

      // ① 本集的非视频步骤(0..3)—— 与上一集的视频并行执行
      const pre = await this.runSteps(batch, epNo, 0, 3, token, state);

      // ② 收掉上一集的视频段。**无论本集是否降级都要收** ——
      //    上一集的成片是已经烧掉配额换来的,不能因为本集出问题就丢掉。
      if (videoPhase) {
        const prev = await videoPhase;
        videoPhase = null;
        if (!prev.cont) return; // 批次已被停掉(状态由 runSteps 写好)
      }
      if (!pre.cont) return;

      // 本集被降级(退化闸命中 / 非阻断步失败):后面几步依赖本集产物,不再执行
      if (pre.degraded) {
        await this.svc.saveBatchCursor(batch.uuid, epNo, 5);
        continue;
      }

      // ③ 启动本集的视频段(4..5),后台跑,不等 —— 它的等待窗口正好被
      //    下一集的 ① 填满
      videoPhase = this.runSteps(batch, epNo, 4, 5, token, state);
    }

    if (videoPhase) {
      const last = await videoPhase;
      if (!last.cont) return;
    }

    const finalState = await this.svc.finishBatch(batch.uuid, 'done', '');
    // finishBatch 可能因为"已被取消"而拒绝覆盖,这里以真实终态为准推送
    if (finalState?.status === 'done') {
      this.progress.emitComplete(batchRoom(batch.uuid), {
        batchUuid: batch.uuid, units: state.unitsTotal, spentCredits: state.spent,
      });
      this.logger.log(`批次 ${batch.uuid} 完成:消耗折算 ${state.spent} 积分`);
    } else {
      this.logger.log(`批次 ${batch.uuid} 终态 ${finalState?.status},不推完成事件`);
    }
  }

  /**
   * 收尾在飞的那一段视频。批次要停(暂停/取消/失败)时调用 ——
   * 只是 await 让它把已生成的镜头落库,不做任何状态改写(状态由调用方决定)。
   */
  private async drainVideoPhase(p: Promise<StepRunResult> | null): Promise<void> {
    if (!p) return;
    await p.catch((e: any) => this.logger.warn(`视频段收尾异常: ${e?.message}`));
  }

  /**
   * 跑某集的 [from..to] 步。所有"停批次"的副作用(置 paused / cancelled / failed)
   * 都在这里完成,调用方只需看返回值决定要不要继续。
   *
   * `state` 是可变对象:两段流水线(前台的非视频段、后台的视频段)共享同一份
   * 累计消耗。JS 单线程,更新点都在 await 之后同步执行,不存在写坏;
   * 预算闸读到的是"到目前为止的总额",语义不变。
   */
  private async runSteps(
    batch: any, epNo: number, from: number, to: number,
    token: { cancel: boolean }, state: BatchRunState,
  ): Promise<StepRunResult> {
    const dramaUuid = state.dramaUuid;
    const ep = await this.svc.ensureEpisode(dramaUuid, epNo);
    const doneSteps = new Set<number>(
      Object.entries((ep.stepData as any) || {})
        .filter(([, v]: [string, any]) => v?.output != null)
        .map(([k]) => Number(k)),
    );
    // 2026-09-16 成片门:step5 产出存活镜/时长不达标时,回 step4 补失败镜后重合成。
    //   轮数上限防死循环(补做也烧配额);耗尽仍不达标才交片,missing_shots 由
    //   前端露出 + 一键补做(批3)。DRAMA_COMPOSE_GATE=0 可关。
    let gateRounds = 0;
    const gateMaxRounds = composeGateMaxRounds();
    // 步骤 4 是"部分成功"语义:有产出 ≠ 跑完。产出里还有 failed/pending 的镜头时
    // 把 4 从已完成集合里摘掉,让它重进一次把失败镜头补上(已成功的会复用,不重烧)。
    if (doneSteps.has(4) && hasFailedShots((ep.stepData as any)?.['4']?.output)) {
      doneSteps.delete(4);
      this.logger.log(`批次 ${batch.uuid} EP${epNo} 有失败镜头,步骤 4 将补做`);
    }
    // 2026-09-16 续跑语义:上一轮已经交过成片但成片门不达标(如 10s 片)时,
    //   不能因为 step5 在 doneSteps 里就把旧片原样交出去 —— 强制重做 4/5。
    if (doneSteps.has(5) && composeGateEnabled() && gateMaxRounds > 0) {
      const stale = evaluateComposeGate((ep.stepData as any)?.['5']?.output, state.epTargetSec);
      if (!stale.passed) {
        doneSteps.delete(5);
        if (hasFailedShots((ep.stepData as any)?.['4']?.output)) doneSteps.delete(4);
        this.logger.log(
          `批次 ${batch.uuid} EP${epNo} 旧成片门不达标(${stale.reasons.join(';')}),步骤 5 将重合成`,
        );
      }
    }

    /**
     * 关键帧退化闸。命中就记时间线 + 把本集标降级,返回说明文案(未命中返回 null)。
     *
     * 两处调用,覆盖两种时序,缺一不可:
     *   ① 步骤循环**之前** —— 上一轮已经出完图、这一轮才续跑的集
     *      (此时 doneSteps 里已经有 3,循环内的检查根本不会执行);
     *   ② 步骤 3 **成功之后** —— 本轮刚出完图的集。
     * 只放一处的话,同一部剧在"一次跑完"和"中断续跑"两条路径下行为不一致。
     */
    const degradedVerdict = async (kfOut: any): Promise<string | null> => {
      if (!shouldBlockOnDegraded(kfOut)) return null;
      const msg = degradedReason(kfOut);
      this.logger.warn(`批次 ${batch.uuid} EP${epNo} 关键帧退化闸命中: ${msg}`);
      await this.svc.appendBatchLog(batch.uuid, {
        ep: epNo, step: 3, ok: false, msg, credits: 0,
      });
      await this.svc.markEpisodeDegraded(dramaUuid, epNo, msg).catch(() => null);
      this.emitStep(batch, epNo, 3, 'degraded', state.spent, state.budget, msg);
      return msg;
    };
    // ① 续跑场景:步骤 3 已有产出,本轮不会再跑它,闸必须在这里拦
    if (from === 0 && doneSteps.has(3)
        && await degradedVerdict((ep.stepData as any)?.['3']?.output)) {
      await this.svc.saveBatchCursor(batch.uuid, epNo, 5);
      return { cont: true, degraded: true };
    }

    // 2026-09-22:本段内已重试过的步(每步最多补一次,见下方 catch)
    const retriedSteps = new Set<number>();
    for (let step = from; step <= to; step++) {
      if (token.cancel) return this.abortSteps(batch, '用户取消');
      if (doneSteps.has(step) && step !== 1) {
        // 预检(1)每次都要重跑:资产库可能已被上一轮的裁决改变,跳过会拿到旧报告
        continue;
      }
      const cur = await this.svc.getBatch(batch.uuid);
      if (cur.status === 'paused') return { cont: false, degraded: false };
      if (cur.status === 'cancelled') return this.abortSteps(batch, '用户取消');

      this.emitStep(batch, epNo, step, 'start', state.spent, state.budget);
      try {
        // 批次作用域:让深处 HTTP 重试循环里的 reportUpstreamBackoff 找得到
        // "我在为哪个批次的哪一步等上游"。不包这层,连集在 429 退避期间
        // 时间线会整整静默几分钟,前端表现为"点了没反应"。
        const out = await runInBatchScope(
          {
            batchUuid: batch.uuid, ep: epNo, step,
            beat: (msg, extra) => this.svc.batchHeartbeat(batch.uuid, epNo, step, msg, extra),
          },
          () => this.svc.generateEpisodeStep(dramaUuid, epNo, step, {
            // 目标时长只对 step0(大纲)与 step2(分镜)有意义;其余步骤忽略它,
            // 透传是为了让整条链路只有一个入参来源,避免"某一集忘了带"。
            targetSec: state.epTargetSec,
          }),
        );
        const produced = this.svc.stepOutputOf(out, step);
        const units = unitsFromStepOutput(step, produced);
        state.unitsTotal = addUnits(state.unitsTotal, units);
        state.spent += unitsToCredits(units, state.prices);
        await this.svc.confirmEpisodeStep(dramaUuid, epNo, step).catch(() => null);
        await this.svc.saveBatchCursor(batch.uuid, epNo, step);
        await this.svc.appendBatchLog(batch.uuid, {
          ep: epNo, step, ok: true,
          msg: this.stepOkMessage(step, produced),
          credits: unitsToCredits(units, state.prices),
        });
        this.emitStep(batch, epNo, step, 'done', state.spent, state.budget);
        // ② 本轮刚出完图:退化闸在这里拦,后面的视频与成片不再执行
        if (step === 3 && await degradedVerdict(produced)) {
          return { cont: true, degraded: true };
        }
        // 2026-09-16:step4 本轮重跑过(补失败镜)→ step5 必须重合成,不许复用旧成片
        if (step === 4) doneSteps.delete(5);
        // ③ 成片门:存活镜/时长不达标且还有轮数 → 回 step4 补做后重合成;
        //    轮数耗尽仍不达标才交片(日志明示,前端缺镜露出 + 一键补做见批3)
        if (step === 5 && composeGateEnabled()) {
          const verdict = evaluateComposeGate(produced, state.epTargetSec);
          if (!verdict.passed && gateRounds < gateMaxRounds) {
            gateRounds++;
            const why = verdict.reasons.join(';');
            this.logger.warn(
              `批次 ${batch.uuid} EP${epNo} 成片门未过:${why} → 自动补做第 ${gateRounds}/${gateMaxRounds} 轮`,
            );
            await this.svc.appendBatchLog(batch.uuid, {
              ep: epNo, step: 5, ok: false,
              msg: `成片门未过:${why};自动补做 ${gateRounds}/${gateMaxRounds}`,
              credits: 0,
            });
            this.emitStep(batch, epNo, 5, 'degraded', state.spent, state.budget,
              `成片门未过,补做 ${gateRounds}/${gateMaxRounds}`);
            step = 3; // for++ 后回到 step4(成功镜复用,只补失败镜)
            continue;
          }
          if (!verdict.passed) {
            await this.svc.appendBatchLog(batch.uuid, {
              ep: epNo, step: 5, ok: true,
              msg: `成片门补做耗尽仍未达标(${verdict.reasons.join(';')}),照交;缺镜可在剧集卡一键补做`,
              credits: 0,
            });
          }
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        this.logger.warn(`批次 ${batch.uuid} EP${epNo} 第${step}步失败: ${msg}`);
        await this.svc.appendBatchLog(batch.uuid, {
          ep: epNo, step, ok: false, msg, credits: 0,
        });
        const blocking = BLOCKING_STEPS.has(step) || state.stopOnFailure;
        if (blocking) {
          await this.svc.finishBatch(batch.uuid, 'failed',
            `EP${epNo} 第${step + 1}步失败:${msg}`);
          this.progress.emitFailed(batchRoom(batch.uuid),
            `EP${epNo} 第${step + 1}步失败:${msg}`);
          return { cont: false, degraded: false };
        }
        // 2026-09-22:分镜(step2)是整集的**源头** —— 它一失败,后面 3/4/5 全无产物,
        //   该集直接从成片里消失(EP1 实测:一次上游 JSON 截断 → 整集没了)。
        //   上游截断/偶发超时不值得整集报废,这里对 step2 补一次立即重试。
        //   ⚠️ 只重试一次:上游真挂了的时候,无限重试会把预算烧光还交不出片。
        if (step === 2 && !blocking && !retriedSteps.has(step)) {
          retriedSteps.add(step);
          this.logger.warn(
            `批次 ${batch.uuid} EP${epNo} 第2步(分镜)失败,上游偶发 → 立即重试一次:${msg}`,
          );
          await this.svc.appendBatchLog(batch.uuid, {
            ep: epNo, step, ok: true,
            msg: `第2步失败,自动重试一次:${String(msg).slice(0, 80)}`, credits: 0,
          }).catch(() => null);
          step -= 1; // for++ 后回到同一步
          continue;
        }
        // 非阻断步:该集标降级,本段就此收尾(后面的步依赖这一步的产物)
        await this.svc.markEpisodeDegraded(dramaUuid, epNo, msg).catch(() => null);
        this.emitStep(batch, epNo, step, 'degraded', state.spent, state.budget, msg);
        return { cont: true, degraded: true };
      }

      // ── 预算闸 ──
      const verdict = checkBudget(state.spent, state.budget);
      if (verdict.level === 'warn') {
        this.progress.emitProgress(batchRoom(batch.uuid), 0.8,
          `已用 ${verdict.used}/${verdict.budget} 积分,接近预算`);
        await this.svc.appendBatchLog(batch.uuid, {
          ep: epNo, step, ok: true,
          msg: `预算预警:${verdict.used}/${verdict.budget}`,
        });
      }
      if (verdict.level === 'block') {
        await this.svc.setBatchStatus(batch.uuid, 'paused', { epNo, step: step + 1 });
        await this.svc.appendBatchLog(batch.uuid, {
          ep: epNo, step, ok: false,
          msg: `预算耗尽,自动暂停(${verdict.used}/${verdict.budget})。可提高预算或从断点续跑。`,
        });
        this.progress.emitProgress(batchRoom(batch.uuid), 1,
          `预算耗尽已自动暂停:${verdict.used}/${verdict.budget} 积分`);
        this.logger.warn(`批次 ${batch.uuid} 预算耗尽,自动暂停于 EP${epNo} 第${step}步后`);
        return { cont: false, degraded: false };
      }
    }

    // 只有真的跑到本段末尾(视频段收尾)才算本集完成
    if (to >= 5) await this.svc.saveBatchCursor(batch.uuid, epNo, 5);
    return { cont: true, degraded: false };
  }

  /** 取消:置 cancelled 并告诉调用方停 */
  private async abortSteps(batch: any, reason: string): Promise<StepRunResult> {
    await this.abort(batch, reason);
    return { cont: false, degraded: false };
  }

  private async abort(batch: any, reason: string): Promise<void> {
    await this.svc.setBatchStatus(batch.uuid, 'cancelled').catch(() => null);
    this.logger.log(`批次 ${batch.uuid} 中止:${reason}`);
  }

  private emitStep(
    batch: any, epNo: number, step: number,
    phase: 'start' | 'done' | 'degraded', spent: number, budget: number,
    detail?: string,
  ): void {
    const total = Math.max(1, (batch.toEp - batch.fromEp + 1) * 6);
    const doneSoFar = (epNo - batch.fromEp) * 6 + step + (phase === 'start' ? 0 : 1);
    const label = this.svc.episodeStepLabels[step] || `第${step + 1}步`;
    this.progress.emitProgress(
      batchRoom(batch.uuid),
      Math.min(1, doneSoFar / total),
      `EP${epNo} ${label} ${phase === 'start' ? '开始' : phase}${
        budget > 0 ? ` · ${spent}/${budget} 分` : ''}${detail ? ` · ${detail}` : ''}`,
    );
  }

  private stepOkMessage(step: number, produced: any): string {
    if (!produced) return '完成';
    switch (step) {
      case 0: return `大纲 ${(produced.scenes || []).length} 场`;
      case 1: {
        const s = produced.summary || {};
        return `复用${s.reused ?? 0} 新增${s.newCount ?? 0} 待裁决${s.needDecision ?? 0}`;
      }
      case 2: return `${(produced.shots || []).length} 镜`;
      case 3: return `出图 ${(produced.keyframes || []).filter((k: any) => k.url).length} 张`;
      case 4: {
        const all = Array.isArray(produced.shots) ? produced.shots : [];
        const ok = all.filter((s: any) => s.video_url).length;
        const bad = all.filter((s: any) => s?.status === 'failed').length;
        // 失败必须写在时间线上 —— 成片会缺这几段,用户要在日志里看得到
        return bad ? `视频 ${ok} 段(失败 ${bad} 段,成片将缺这几镜)` : `视频 ${ok} 段`;
      }
      case 5: {
        const missing = Number(produced.missing_shots) || 0;
        return `成片 ${produced.final_url || ''}` +
          (missing ? ` · 缺 ${missing} 镜` : '');
      }
      default: return '完成';
    }
  }
}
