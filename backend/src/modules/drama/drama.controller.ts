// ============================================================================
// DramaController —— 微短剧「剧 / 集 / 资产」REST API
// ----------------------------------------------------------------------------
// 全局前缀 /api(见 main.ts),全部接口默认走 JwtAuthGuard。
//
// 路由顺序注意:Nest 按声明顺序匹配,
//   所以 /dramas/batches/:batchUuid 必须声明在 /dramas/:uuid 之前,
//   /dramas/:uuid/episodes/continuity 必须声明在 /episodes/:epNo 之前。
//
// 生成类接口(图像/视频/LLM)在 M2/M3 加入,届时一律返回 202 + jobId,
// 不再沿用 open-montage 的长同步 await。
// ============================================================================

import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { DramaService } from './drama.service';
import { DramaOrchestrator } from './drama-orchestrator.service';
import { NovelLedgerService } from './novel-ledger.service';
import { NovelGenService } from './novel-gen.service';
import { NovelPipelineService } from './novel-pipeline.service';
import { PortraitBatchService } from './portrait-batch.service';
import type { AssetNeed } from './asset-matcher';

@Controller('dramas')
@UseGuards(JwtAuthGuard)
export class DramaController {
  constructor(
    private readonly svc: DramaService,
    private readonly orchestrator: DramaOrchestrator,
    private readonly novelLedger: NovelLedgerService,
    private readonly novelGen: NovelGenService,
    private readonly pipeline: NovelPipelineService,
    private readonly portraits: PortraitBatchService,
  ) {}

  private userId(req: Request): number {
    const raw = (req as any).user?.id;
    return raw == null ? 0 : Number(raw);
  }

  // ── 小说生成引擎(入口 A:标题→小说;静态段,必须声明在 /dramas/:uuid 之前) ──
  @Post('novel-gen/start')
  async startNovelGen(
    @Req() req: Request,
    @Body() body: { title: string; tier?: string; genre?: string; agentId?: number },
  ) {
    return this.novelGen.start(this.userId(req), Number(body.agentId) || 32, body);
  }

  @Get('novel-gen/tasks/:uuid')
  async getNovelGenTask(
    @Req() req: Request,
    @Param('uuid') uuid: string,
  ) {
    return this.novelGen.getTask(uuid, this.userId(req));
  }

  /** 失败/中断任务从断点重拉 */
  @Post('novel-gen/tasks/:uuid/resume')
  async resumeNovelGenTask(
    @Req() req: Request,
    @Param('uuid') uuid: string,
  ) {
    return this.novelGen.resumeTask(uuid, this.userId(req));
  }

  /** 我的小说书架:全部生成任务(进行中/已完成/失败),供「全部小说」列表页 */
  @Get('novel-gen/tasks')
  async listNovelGenTasks(@Req() req: Request) {
    return this.novelGen.listTasks(this.userId(req));
  }

  /** 已入库小说(账本快照):入口 B 上传的小说 + 走完 ingest 的剧。
   *  这些没有 novel_gen_tasks 行,单靠上面的列表会漏掉 —— 书架并起来才叫「全部小说」。
   *  ⚠️ 路径段与 novel-gen/tasks* 不冲突,但仍声明在 /:uuid 之前 */
  @Get('novel-gen/ledger-novels')
  async listLedgerNovels(@Req() req: Request) {
    return this.novelGen.listLedgerNovels(this.userId(req));
  }

  /** 读全文(format=md 漂亮排版 / txt 原始正文;生成中也能读,逐章 append 随时可见) */
  @Get('novel-gen/tasks/:uuid/novel')
  async getNovelGenText(
    @Req() req: Request,
    @Param('uuid') uuid: string,
    @Query('format') format?: string,
  ) {
    const fmt = format === 'txt' ? 'txt' : 'md';
    return this.novelGen.getNovel(this.userId(req), uuid, fmt);
  }

  /** 保存编辑后的正文(txt 源;md 随之重刷,下载直链同步更新) */
  @Put('novel-gen/tasks/:uuid/novel')
  async saveNovelGenText(
    @Req() req: Request,
    @Param('uuid') uuid: string,
    @Body() body: { content?: string },
  ) {
    if (body?.content == null) throw new BadRequestException('缺少 content(正文)');
    return this.novelGen.saveNovel(this.userId(req), uuid, body.content);
  }

  // ── 断点续跑:进入工作台时「我有什么没做完」 ──
  /**
   * 未完成清单(工作台 initState 的唯一恢复源)。
   *
   * 两类对象一起回,因为它们分属两个阶段、前端恢复动作也不同:
   *   genTasks  小说还没写完的任务(running / failed)→ 填回 _genTask 继续轮询/重拉
   *   projects  小说已成书、剧建好但流程没走完的项目 → 按 dramaUuid 拉账本回到对应门
   *
   * 为什么必须存在:此前工作台所有进度态都是纯内存字段,离开页面即丢,
   * 而 gates / batches 的续跑接口早就有,只是没人能把 dramaUuid 再拿回来。
   * 声明在 /dramas/:uuid 之前(段数不同其实不冲突,但保持「静态段在前」的惯例)。
   */
  @Get('novel/active')
  async listNovelActive(@Req() req: Request) {
    const uid = this.userId(req);
    const [tasks, projects] = await Promise.all([
      this.novelGen.listTasks(uid),
      this.novelLedger.listActiveProjects(uid),
    ]);
    const genTasks = (Array.isArray(tasks) ? tasks : []).filter(
      (t: any) => t?.status && t.status !== 'completed',
    );
    return { genTasks, projects };
  }

  // ── 批任务(必须声明在 /dramas/:uuid 之前) ──
  @Get('batches/:batchUuid')
  async getBatch(@Param('batchUuid') batchUuid: string) {
    return this.svc.getBatch(batchUuid);
  }

  @Post('batches/:batchUuid/status')
  async setBatchStatus(
    @Param('batchUuid') batchUuid: string,
    @Body() body: { status: string; cursorEp?: number; cursorStep?: number },
  ) {
    return this.svc.setBatchStatus(batchUuid, body.status, {
      epNo: body.cursorEp, step: body.cursorStep,
    });
  }

  /**
   * 从断点续跑。paused(含预算耗尽自动暂停)或进程重启后遗留的批次用这个恢复。
   * 提高 budgetCredits 后再续,就是"加钱继续";不会从第 1 集重烧。
   */
  @Post('batches/:batchUuid/resume')
  async resumeBatch(
    @Param('batchUuid') batchUuid: string,
    @Body() body: { budgetCredits?: number },
  ) {
    const cur = await this.svc.getBatch(batchUuid);
    if (Number.isFinite(Number(body?.budgetCredits)) && Number(body.budgetCredits) > 0) {
      await this.svc.updateBatchPolicy(batchUuid, {
        ...cur.policy, budgetCredits: Number(body.budgetCredits),
      });
    }
    // force:手动续跑是明确的用户意图,队列里残留的同 id 任务(上一轮进程留下的
    // active 僵尸)必须被踢掉,否则 BullMQ 静默跳过、接口却回 enqueued:true。
    const jobId = await this.orchestrator.startBatch(
      batchUuid, cur.dramaUuid, Number(cur.userId), { force: true },
    );
    // 入队成功后立刻把状态推到 running:worker 是异步接手的,
    // 不改的话接口返回时批次仍是 paused,客户端无法判断"到底续跑成功了没有"。
    const updated = await this.svc.setBatchStatus(batchUuid, 'running', {
      epNo: cur.cursorEp, step: cur.cursorStep,
    });
    return { ...updated, enqueued: true, jobId };
  }

  /** 取消:worker 在每集/每步开始前检查状态并收尾 */
  @Post('batches/:batchUuid/cancel')
  async cancelBatch(@Param('batchUuid') batchUuid: string) {
    return this.svc.setBatchStatus(batchUuid, 'cancelled');
  }

  @Post('batches/:batchUuid/log')
  async appendBatchLog(
    @Param('batchUuid') batchUuid: string,
    @Body() body: { ep: number; step: number; ok: boolean; msg?: string; credits?: number; assetIds?: string[] },
  ) {
    return this.svc.appendBatchLog(batchUuid, body);
  }

  // ── 剧 ──
  @Post()
  async create(
    @Req() req: Request,
    @Body() body: {
      title?: string; topic?: string; logline?: string; synopsis?: string;
      genre?: string; agentId?: number; storyMode?: string;
      styleSpec?: Record<string, any>; bible?: Record<string, any>;
    },
  ) {
    return this.svc.createDrama({ ...body, userId: this.userId(req) });
  }

  @Get()
  async list(@Req() req: Request) {
    return this.svc.listDramas(this.userId(req));
  }

  @Get(':uuid')
  async detail(@Param('uuid') uuid: string) {
    return this.svc.getDrama(uuid);
  }

  @Patch(':uuid')
  async update(
    @Param('uuid') uuid: string,
    @Body() body: {
      title?: string; logline?: string; synopsis?: string; coverUrl?: string;
      status?: string; bible?: Record<string, any>; storyMode?: string;
    },
  ) {
    return this.svc.updateDrama(uuid, body);
  }

  /** 改风格圣经:返回与新签名不一致的资产数,前端据此提示"是否重制" */
  @Put(':uuid/style')
  async updateStyle(@Param('uuid') uuid: string, @Body() body: Record<string, any>) {
    return this.svc.updateStyleSpec(uuid, body);
  }

  @Post(':uuid/arc')
  async setArc(@Param('uuid') uuid: string, @Body() body: { storyArc: any[] }) {
    return this.svc.setStoryArc(uuid, body.storyArc);
  }

  /**
   * 剧级定妆第 1 步:LLM 出美术设计 → 建 pending 资产(不烧图像配额)。
   * 幂等,可反复点;同名同类已存在会跳过。
   */
  @Post(':uuid/setup/design')
  async setupDesign(
    @Param('uuid') uuid: string,
    @Body() body: { hint?: string },
  ) {
    return this.svc.generateDesign(uuid, body?.hint);
  }

  /**
   * 剧级定妆第 2 步:给单个资产出参考图并落地本地。
   * 逐资产触发而非一把梭 —— 角色四视图要 1~2 分钟,全剧一起跑必然超 HTTP 时限,
   * 而且单张失败不该拖垮整批。
   */
  @Post(':uuid/assets/:id/portrait')
  async assetPortrait(
    @Param('uuid') uuid: string, @Param('id') id: string,
    @Body() body: { force?: boolean },
  ) {
    // 默认增量:只补失败/缺失的角度;force=true 才整套重画(会重烧已成功的配额)
    return this.svc.generatePortrait(uuid, id, body?.force === true);
  }

  /**
   * 一致性试机:同一句画面描述,带参考图 / 不带参考图 各出一帧对照。
   * 开跑整集前用一张图的成本验证"这套参考图锁不锁得住脸",
   * 也顺带把实际使用的 prompt 与 ref_urls 回给前端,便于排查漂移来源。
   */
  @Post(':uuid/keyframe/preview')
  async previewKeyframe(
    @Param('uuid') uuid: string,
    @Body() body: {
      description: string; shot_type?: string; camera_motion?: string;
      assetSlugs?: string[]; useReference?: boolean;
    },
  ) {
    return this.svc.previewKeyframe(uuid, body);
  }

  @Delete(':uuid')
  async remove(@Param('uuid') uuid: string) {
    return this.svc.deleteDrama(uuid);
  }

  // ── 资产库 ──
  @Get(':uuid/assets')
  async listAssets(
    @Param('uuid') uuid: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.svc.listAssets(uuid, { kind, status, keyword: q });
  }

  @Post(':uuid/assets')
  async createAsset(
    @Param('uuid') uuid: string,
    @Body() body: {
      kind: string; slug?: string; name: string; aliases?: string[];
      descVisual: string; descPersona?: string; refs?: any[]; variants?: any[];
      source?: string; sourceEp?: number; status?: string; locked?: boolean;
    },
  ) {
    return this.svc.createAsset(uuid, body);
  }

  /**
   * 批量定妆进度。GET 与 POST 共用静态段 `portrait-batch`,
   * **必须声明在下面 `:uuid/assets/:id` 之前** —— Nest 按声明顺序匹配,
   * 否则这条会被参数路由吃掉(把 'portrait-batch' 当成资产 id 去查)。
   */
  @Get(':uuid/assets/portrait-batch')
  async portraitBatchState(@Param('uuid') uuid: string) {
    return this.portraits.getState(uuid);
  }

  /**
   * 一键定妆:把该剧所有还没定妆的资产(非停用、非锁定、refs 无可用图)排队生成。
   * 立即返回,不等图 —— 角色四视图 ×N 项是分钟级,绝不能吊在 HTTP 里。
   * 幂等:已在跑就直接回现状,不重复烧配额。
   */
  @Post(':uuid/assets/portrait-batch')
  async startPortraitBatch(@Param('uuid') uuid: string) {
    const state = await this.portraits.start(uuid, 'manual');
    return { enqueued: state.status === 'running', state };
  }

  /**
   * 2026-09-16:资产库分类 chip 的数量 badge 数据源。
   * **必须声明在 `:uuid/assets/:id` 之前** —— Nest 按声明顺序匹配,
   * 否则 kind-counts 会被当成 :id 吞掉(与 portrait-batch 同款坑)。
   */
  @Get(':uuid/assets/kind-counts')
  async assetKindCounts(@Param('uuid') uuid: string) {
    return this.svc.assetKindCounts(uuid);
  }

  @Get(':uuid/assets/:id')
  async getAsset(@Param('uuid') uuid: string, @Param('id') id: string) {
    return this.svc.getAsset(uuid, id);
  }

  @Patch(':uuid/assets/:id')
  async updateAsset(
    @Param('uuid') uuid: string,
    @Param('id') id: string,
    @Body() body: {
      name?: string; descVisual?: string; descPersona?: string;
      aliases?: string[]; refs?: any[]; status?: string;
    },
  ) {
    return this.svc.updateAsset(uuid, id, body);
  }

  @Post(':uuid/assets/:id/canonical')
  async setCanonical(
    @Param('uuid') uuid: string, @Param('id') id: string,
    @Body() body: { angle: string },
  ) {
    return this.svc.setCanonicalRef(uuid, id, body.angle);
  }

  @Post(':uuid/assets/:id/lock')
  async lock(
    @Param('uuid') uuid: string, @Param('id') id: string,
    @Body() body: { locked: boolean },
  ) {
    return this.svc.setLocked(uuid, id, body.locked !== false);
  }

  @Post(':uuid/assets/:id/confirm')
  async confirmAsset(@Param('uuid') uuid: string, @Param('id') id: string) {
    return this.svc.confirmAsset(uuid, id);
  }

  @Post(':uuid/assets/:id/variants')
  async addVariant(
    @Param('uuid') uuid: string, @Param('id') id: string,
    @Body() body: { label: string; descDelta?: string; fromEp?: number; refs?: any[] },
  ) {
    return this.svc.addVariant(uuid, id, body);
  }

  @Get(':uuid/assets/:id/usage')
  async assetUsage(@Param('uuid') uuid: string, @Param('id') id: string) {
    return this.svc.assetUsage(uuid, id);
  }

  /** 软删除;有引用时返回 409 */
  @Delete(':uuid/assets/:id')
  async deprecateAsset(@Param('uuid') uuid: string, @Param('id') id: string) {
    return this.svc.deprecateAsset(uuid, id);
  }

  // ── 分集 ──
  @Get(':uuid/episodes')
  async listEpisodes(@Param('uuid') uuid: string) {
    const d = await this.svc.getDrama(uuid);
    return d.episodes;
  }

  /** 下一集的前情提要(必须声明在 /episodes/:epNo 之前) */
  @Get(':uuid/episodes/continuity')
  async continuity(@Param('uuid') uuid: string) {
    return this.svc.continuityBrief(uuid);
  }

  @Post(':uuid/episodes')
  async createEpisode(
    @Param('uuid') uuid: string,
    @Body() body: { epNo?: number; title?: string; brief?: string },
  ) {
    return this.svc.createEpisode(uuid, body);
  }

  /** 删除某一集;已有成片时需 force,并把该集成片目录移进回收 */
  @Delete(':uuid/episodes/:epNo')
  async deleteEpisode(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string,
    @Query('force') force?: string,
  ) {
    return this.svc.deleteEpisode(uuid, Number(epNo), force === '1' || force === 'true');
  }

  @Get(':uuid/episodes/:epNo')
  async getEpisode(@Param('uuid') uuid: string, @Param('epNo') epNo: string) {
    return this.svc.getEpisode(uuid, Number(epNo));
  }

  /**
   * 生成集内某一步(0 承接大纲 / 1 资产预检 / 2 分镜 / 3 关键帧 / 4 分镜视频 / 5 成片回写)。
   *
   * 时限说明:0~2 是文本步,几十秒内;3~4 是图像/视频步,整集跑完要几分钟以上,
   * 因此两步支持 input.shotIdx 逐镜推进(前端可以边跑边刷新)。
   * 真正的后台队列编排在 M4 接 BullMQ 后替换掉这里的同步等待。
   */
  @Post(':uuid/episodes/:epNo/steps/:step/generate')
  async generateEpisodeStep(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string, @Param('step') step: string,
    @Body() body: any,
  ) {
    return this.svc.generateEpisodeStep(uuid, Number(epNo), Number(step), body || {});
  }

  @Put(':uuid/episodes/:epNo/steps/:step/output')
  async updateStepOutput(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string, @Param('step') step: string,
    @Body() body: { output: any },
  ) {
    return this.svc.updateStepOutput(uuid, Number(epNo), Number(step), body.output);
  }

  @Post(':uuid/episodes/:epNo/steps/:step/confirm')
  async confirmStep(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string, @Param('step') step: string,
    @Body() body: { output?: any },
  ) {
    return this.svc.confirmStep(uuid, Number(epNo), Number(step), body?.output);
  }

  @Delete(':uuid/episodes/:epNo/steps/:step/output')
  async deleteStepOutput(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string, @Param('step') step: string,
  ) {
    return this.svc.deleteStepOutput(uuid, Number(epNo), Number(step));
  }

  // ── 资产预检 ──
  @Post(':uuid/episodes/:epNo/precheck')
  async precheck(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string,
    @Body() body: { needs: AssetNeed[] },
  ) {
    return this.svc.precheckAssets(uuid, Number(epNo), body.needs);
  }

  @Post(':uuid/episodes/:epNo/precheck/resolve')
  async resolvePrecheck(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string,
    @Body() body: {
      decisions: Array<{
        index: number; assetId?: string; asVariantLabel?: string;
        slug?: string; refs?: any[];
      }>,
    },
  ) {
    return this.svc.resolvePrecheck(uuid, Number(epNo), body.decisions);
  }

  /**
   * 2026-09-16(批3 透明工作台):改字幕 → 重烧(复用 concat.mp4,不重烧视频配额)。
   * edits 按 shotIdx 定位 cue;字数变化超阈值时响应带 needsRealign=true 提醒
   * "语义窗未重算,精确对齐需重跑分镜视频"。
   */
  @Post(':uuid/episodes/:epNo/subtitles/reburn')
  async reburnSubtitles(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string,
    @Body() body: {
      edits?: Array<{ shotIdx: number; text?: string; speaker?: string | null }>;
    },
  ) {
    return this.svc.reburnEpisodeSubtitles(uuid, Number(epNo), body?.edits || []);
  }

  // ── 逐集承接:状态回写 ──
  @Post(':uuid/episodes/:epNo/writeback')
  async writeback(
    @Param('uuid') uuid: string, @Param('epNo') epNo: string,
    @Body() body: {
      hookOut?: string; establishedFacts?: string[];
      characterStates?: Record<string, any>; openHooks?: string[];
      finalUrl?: string; posterUrl?: string; durationSec?: number; shotCount?: number;
    },
  ) {
    return this.svc.writeBackSnapshot(uuid, Number(epNo), body);
  }

  // ── 连集 ──
  @Get(':uuid/batches')
  async listBatches(@Param('uuid') uuid: string) {
    const d = await this.svc.getDrama(uuid);
    return d.batches;
  }

  /**
   * 建一批连集并**立即入队**。
   * 队列不可用(Redis 没起)时不静默降级:批次仍落库为 queued,
   * 但把"未入队、需手动逐集"的原因一并回传,前端能直接显示给用户。
   */
  @Post(':uuid/batches')
  async createBatch(
    @Req() req: Request,
    @Param('uuid') uuid: string,
    @Body() body: { fromEp: number; toEp: number; policy?: Record<string, any> },
  ) {
    const batch = await this.svc.createBatch(uuid, this.userId(req), body);
    try {
      const jobId = await this.orchestrator.startBatch(
        batch.uuid, uuid, this.userId(req),
      );
      return { ...batch, enqueued: true, jobId };
    } catch (e: any) {
      return { ...batch, enqueued: false, reason: e?.message || String(e) };
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Novel2Drama 对齐账本层(P1,最终方案 v6.0 §5.2/§6.1)
  // 数据层 4 张表(dramas_novel_ledger/beats/gates/snaps);
  // n2d-core 桥接见 novel-ledger.service.ts。
  // ══════════════════════════════════════════════════════════════════════

  /** 上传/生成小说 → 摄入建账本(入口 A 传 source=generated + novelGenTaskUuid;
   *  B 传 source=uploaded + novelText 正文) */
  @Post(':uuid/novel/ingest')
  async ingestNovel(
    @Req() req: Request,
    @Param('uuid') uuid: string,
    @Body() body: {
      novelText?: string; title: string; novelGenTaskUuid?: string;
      source?: 'generated' | 'uploaded'; epTargetSec?: number;
    },
  ) {
    const drama = await this.svc.getDrama(uuid);
    // 入口 A:按生成任务 uuid 从服务端读产物(正文可不出 DB 二次传输)
    let novelText = body.novelText;
    if ((novelText == null || !novelText.trim()) && body.novelGenTaskUuid) {
      novelText = await this.novelGen.readGeneratedNovel(
        BigInt(this.userId(req)), body.novelGenTaskUuid,
      );
    }
    if (novelText == null || !novelText.trim()) {
      throw new BadRequestException('缺少小说正文(novelText 或 novelGenTaskUuid)');
    }
    return this.novelLedger.createFromNovel(
      BigInt(this.userId(req)), BigInt(drama.id),
      novelText, body.title, body.source ?? 'uploaded',
      body.epTargetSec ?? 120,
    );
  }

  /** 读账本(含审批门状态) */
  @Get(':uuid/novel/ledger')
  async getLedger(@Req() req: Request, @Param('uuid') uuid: string) {
    const drama = await this.svc.getDrama(uuid);
    return this.novelLedger.getByDrama(BigInt(this.userId(req)), BigInt(drama.id));
  }

  /** 读账本里的原文全文(入口 B 上传的小说也能读;只读,不给保存)
   *  ⚠️ 必须声明在 /:uuid/novel/ledger 之后、且路径段不同,不会互相吞掉 */
  @Get(':uuid/novel/text')
  async getLedgerNovelText(
    @Req() req: Request,
    @Param('uuid') uuid: string,
    @Query('format') format?: string,
  ) {
    const fmt = format === 'txt' ? 'txt' : 'md';
    return this.novelGen.getNovelByDrama(this.userId(req), uuid, fmt);
  }

  /** 跑校验:which=budget|coverage;coverage 需带 stage */
  @Post(':uuid/novel/check/:which')
  async runCheck(
    @Req() req: Request,
    @Param('uuid') uuid: string, @Param('which') which: 'budget' | 'coverage',
    @Body() body: { stage?: string },
  ) {
    if (which !== 'budget' && which !== 'coverage') {
      throw new BadRequestException('which 必须是 budget 或 coverage');
    }
    const drama = await this.svc.getDrama(uuid);
    return this.novelLedger.runCheck(
      BigInt(this.userId(req)), BigInt(drama.id), which,
      (body.stage as any) ?? 'ingest',
    );
  }

  /** S1 beats 回填(LLM 抽取产物;quote 锚点硬校验在 service 层) */
  @Post(':uuid/novel/beats')
  async appendBeats(
    @Req() req: Request,
    @Param('uuid') uuid: string,
    @Body() body: { beats: Array<Record<string, unknown>> },
  ) {
    const drama = await this.svc.getDrama(uuid);
    return this.novelLedger.appendBeats(BigInt(this.userId(req)), BigInt(drama.id), body.beats);
  }

  /** 审批门决策(passed/rejected)。passed 时后台拉起对应生产阶段:
   *  ①→设定 ②→剧本 ③→连集批次(HTTP 立即返回,进度写进门 payload) */
  @Post(':uuid/novel/gates/:gate/decide')
  async decideGate(
    @Req() req: Request,
    @Param('uuid') uuid: string, @Param('gate') gate: string,
    @Body() body: { decision: 'passed' | 'rejected'; note?: string },
  ) {
    const drama = await this.svc.getDrama(uuid);
    return this.pipeline.decideAndAdvance(
      BigInt(this.userId(req)), BigInt(drama.id), uuid, gate, body.decision, body.note,
    );
  }

  /** 重拉门②/③对应的生成阶段(失败重试;或历史剧「门已过但没产物」恢复) */
  @Post(':uuid/novel/gates/:gate/retry')
  async retryGate(
    @Req() req: Request,
    @Param('uuid') uuid: string, @Param('gate') gate: string,
  ) {
    const drama = await this.svc.getDrama(uuid);
    return this.pipeline.retry(BigInt(this.userId(req)), BigInt(drama.id), uuid, gate);
  }

  /**
   * 解除驳回:把门从 rejected 改回 waiting。
   * 没有它的话「驳回」是终态 —— 用户点错一次,整部剧连同账本与已生成资产全废。
   * 2026-09-15 实测剧 42 就卡死在这里。
   */
  @Post(':uuid/novel/gates/:gate/reopen')
  async reopenGate(
    @Req() req: Request,
    @Param('uuid') uuid: string, @Param('gate') gate: string,
  ) {
    const drama = await this.svc.getDrama(uuid);
    return this.pipeline.reopen(BigInt(this.userId(req)), BigInt(drama.id), uuid, gate);
  }
}
