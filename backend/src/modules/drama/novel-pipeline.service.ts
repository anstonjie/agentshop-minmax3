// ============================================================================
// NovelPipelineService —— Novel2Drama 审批门驱动的 Stage 2 编排层
// ----------------------------------------------------------------------------
// 补齐 2026-09-14 之前的断链:此前 decideGate 只把门状态写库,门①通过后
// 什么也不发生(工作台停在「生产管线推进中(Stage 2 接入后解锁)」死按钮)。
//
// 本服务把三道门接成真正的流水线(全部复用既有能力,不另写第二套生成逻辑):
//   门① 报价通过 → 设定阶段:用账本剧集播种 storyArc、用小说圣经播种
//                  logline/bible(入口 A),再走 DramaService.generateDesign
//                  (genStep2Design 定妆设计,新建角色/场景/道具资产)
//                  → 产物摘要写进 gate2_design.payload,等用户审
//   门② 设定通过 → 剧本阶段:逐集 ensureEpisode + generateEpisodeStep(0)
//                  (承接大纲,LLM)→ 每集标题/场数/钩子写进 gate3_script.payload
//   门③ 剧本通过 → 生产阶段:createBatch + DramaOrchestrator.startBatch
//                  (BullMQ 连集:0 承接/1 预检/2 分镜/3 关键帧/4 视频/5 成片,
//                   已完成的第 0 步会被幂等跳过),batchUuid 写进 payload,
//                  前端轮询 /dramas/batches/:uuid 看进度
//
// payload 状态机(前端唯一进度来源,轮询账本即可):
//   {}(未开始)→ {state:'generating'} → {state:'ready'|'failed'}
//   门③ 通过后追加 {state:'producing', batchUuid}
//   失败/历史遗留(门已过但 payload 空)可用 retry 端点重新拉起对应阶段。
//
// 与 novel-gen 同范式:HTTP 决策接口立即返回,重活后台 async 跑,
// 每个进度节点落库(payload),进程重启后靠 retry 恢复(不做自动重拉,
// 因为设定/剧本阶段无断点游标,重跑整段比错误续跑诚实)。
//
// 2026-09-15 补「中断态自愈」:上面的"靠 retry 恢复"只说了怎么恢复,没说
// **谁来发现**。实测(drama 69,2026-09-14 22:54)是:进程被 kill 时阶段循环
// 直接消失,payload 永远停在 generating —— 因为只有**抛异常**才走 catch 写
// failed,被 SIGTERM 杀掉时连 catch 都不会执行。前端于是显示一个永远转的圈。
// 现在启动时扫一遍(sweepInterruptedStages),把陈旧的 generating 落成
// failed + 原因,让工作台露出「重试本阶段」按钮。
// ============================================================================

import {
  BadRequestException, Injectable, Logger, NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { DramaService } from './drama.service';
import { DramaOrchestrator } from './drama-orchestrator.service';
import { NovelLedgerService } from './novel-ledger.service';
import { PortraitBatchService } from './portrait-batch.service';

/** 阶段键:防重复启动(running 集合的元素) */
export type PipelineStage = 'design' | 'script' | 'production';

/** 门与阶段的映射:某门通过后启动的阶段,和该阶段产物写入的门 */
export const GATE_STAGE_MAP: Record<string, PipelineStage> = {
  gate1_budget: 'design',       // ①过 → 生成设定,产物进②
  gate2_design: 'script',       // ②过 → 生成剧本,产物进③
  gate3_script: 'production',   // ③过 → 连集生产
};
export const STAGE_RESULT_GATE: Record<PipelineStage, string> = {
  design: 'gate2_design',
  script: 'gate3_script',
  production: 'gate3_script',
};

/**
 * 阶段中断判定阈值:payload 停在 `generating` 且超过这个时长没再落库,就认为
 * 持有它的进程已经没了(逐集大纲 20~40s 就会落一次库,3 分钟足够区分)。
 *
 * 只在**启动时**判定,不做定时扫描:正在跑的阶段中途也可能几十秒到几分钟不
 * 落库,定时扫描会把活着的阶段误判成失败,而用户一旦点了「重试」就会重复跑
 * 一整段。启动时不可能有本进程的阶段在跑,判定是安全的。
 */
export const STAGE_INTERRUPT_MS = 3 * 60 * 1000;

/**
 * 孤儿 producing 门的定时扫描周期(5 分钟)。
 * 见 `NovelPipelineService.scheduledGateSweep()` 的说明 —— 启动时跑一次不够。
 */
export const GATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 批次"多久没更新"算疑似卡死(分钟)。
 * 只用于日志巡检,不改任何状态 —— 所以可以取得比自愈阈值保守得多。
 * 视频步骤在等限流窗口时会每 63 秒落一次心跳,30 分钟无更新基本可以断定异常。
 */
export const STALLED_BATCH_MINUTES = 30;

/** payload 可能是对象或 JSON 字符串(驱动差异),统一取对象 */
export function payloadOf(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return typeof raw === 'object' ? (raw as Record<string, any>) : {};
}

// ── 纯函数(可单测) ──────────────────────────────────────────────────────

/**
 * 连集生产预算(积分)。这是**失控保护口径**不是账单(drama-pricing.ts 注明
 * 该链路不经 credits 结算)。单集经验值:~12 镜 → 关键帧 12×8 + 视频 12×40
 * + LLM ~5×2 ≈ 600 分,乘 1.2 安全系数;下限 1000 保证小剧也能跑完。
 */
export function estimateBudgetCredits(episodeCount: number): number {
  const n = Math.max(1, Math.floor(Number(episodeCount) || 1));
  return Math.max(1000, Math.ceil(n * 600 * 1.2));
}

/** 从 novel_gen_tasks.novelStorageKey('drama-novel/<uuid>.txt')提取任务 uuid */
export function extractTaskUuid(storageKey: string | null): string | null {
  const m = /^drama-novel\/([0-9a-fA-F-]{36})\.txt$/.exec(String(storageKey || ''));
  return m ? m[1] : null;
}

/**
 * 账本剧集 → storyArc(全季故事线)。
 * 2026-09-16(批2):purpose 旧实现是章节标题拼接("第7章 / 第8章"),大纲锚点
 *   看不到任何剧情内容(诊断断点③);改为拼**该集覆盖章节的 beats summary**
 *   (章节标题作前缀),无 beats(未回填)时降级回标题拼接,保持旧行为与旧单测。
 *   cliffhanger 透传账本值(ingest 时通常为空,大纲阶段会再产)。
 */
export function arcFromLedger(ledgerJson: any): Array<{ ep: number; purpose: string; cliffhanger: string }> {
  const chapters = new Map<string, any>(
    (ledgerJson?.chapters || []).map((c: any) => [String(c.id), c]),
  );
  const beatsByChapter = new Map<string, any[]>();
  for (const b of Array.isArray(ledgerJson?.beats) ? ledgerJson.beats : []) {
    const k = String(b?.chapter || '');
    if (!k) continue;
    const arr = beatsByChapter.get(k) || [];
    arr.push(b);
    beatsByChapter.set(k, arr);
  }
  return (ledgerJson?.episodes || []).map((ep: any, i: number) => {
    const cids = (ep.chapters || []).map((c: any) => String(c));
    const beatParts: string[] = [];
    for (const cid of cids) {
      for (const b of beatsByChapter.get(cid) || []) {
        const s = String(b?.summary || '').trim();
        if (s && !beatParts.includes(s)) beatParts.push(s);
      }
    }
    const titles = cids.map((cid: string) => chapters.get(cid)?.title).filter(Boolean);
    const purpose = beatParts.length
      ? `${titles.join(' / ')}:${beatParts.slice(0, 6).join(';')}`.slice(0, 240)
      : titles.join(' / ');
    return { ep: i + 1, purpose, cliffhanger: String(ep.cliffhanger || '') };
  });
}

/** 从小说圣经提炼 drama.bible 补丁(入口 A 专属;只覆盖空字段) */
export function bibleFromNovelBible(bible: any): Record<string, any> | null {
  const sb = bible?.storyBible;
  const concept = bible?.concept;
  if (!sb && !concept) return null;
  return {
    world: String(sb?.world || ''),
    genre: String(concept?.genre || ''),
    tone: String(concept?.tone || ''),
    rules: Array.isArray(sb?.rules) ? sb.rules : [],
    relationships: (bible?.characters || [])
      .slice(0, 8)
      .map((c: any) => `${c.name || ''}:${c.role || ''}`)
      .filter((s: string) => s.length > 1),
  };
}

@Injectable()
export class NovelPipelineService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NovelPipelineService.name);
  /** 运行中的阶段:`${dramaUuid}:${stage}`,防重复启动 */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: NovelLedgerService,
    private readonly svc: DramaService,
    private readonly orchestrator: DramaOrchestrator,
    private readonly portraits: PortraitBatchService,
  ) {}

  // ===========================================================================
  // 启动自愈:上一次进程被杀时留下的"假进行中"状态
  // ===========================================================================

  async onApplicationBootstrap(): Promise<void> {
    await this.sweepInterruptedStages().catch((e: any) =>
      this.logger.warn(`[pipeline] 中断阶段清理失败(不影响启动): ${e?.message}`));
    await this.sweepOrphanedProducingGates().catch((e: any) =>
      this.logger.warn(`[pipeline] 孤儿 producing 门清理失败(不影响启动): ${e?.message}`));
  }

  /** 定时扫描的重入保护:单次扫描若超过周期,不能叠加执行 */
  private sweepingGates = false;

  /**
   * 孤儿 producing 门的**周期**清理(每 5 分钟)。
   *
   * 为什么不能只在启动时跑一次:门 payload 停在 `producing` 有两种来源 ——
   *   ① 批次收尾时进程恰好被杀,`settleGate()` 没执行;
   *   ② 历史存量(2026-09-15 之前 `settleGate` 还不存在)。
   * 两种都只有"下次 API 重启"才会被修。实测剧 59/65/75 的批次分别 done 于
   * 1435 / 459 / 165 分钟前,门 payload 仍是 `producing` —— 账本对外一直宣称
   * "正在生产",而实际上早就跑完了。前端靠直拉批次详情侥幸显示正确,任何
   * 从账本读状态的路径(比如「未完成的项目」判定)都会被误导。
   *
   * 每 5 分钟一次:比 4s 的前端轮询粗得多,不会造成额外负载;而 5 分钟的延迟
   * 对"账本说实话"这件事完全够用。
   */
  @Interval(GATE_SWEEP_INTERVAL_MS)
  async scheduledGateSweep(): Promise<void> {
    if (this.sweepingGates) return;
    this.sweepingGates = true;
    try {
      const n = await this.sweepOrphanedProducingGates();
      if (n) this.logger.log(`[pipeline] 定时扫描收尾 ${n} 个孤儿 producing 门`);
      await this.reportStalledGates();
    } catch (e: any) {
      this.logger.warn(`[pipeline] 定时门扫描失败(不影响服务): ${e?.message}`);
    } finally {
      this.sweepingGates = false;
    }
  }

  /**
   * 只读巡检:批次既没到终态、又很久没动过的 producing 门,打一条 warn 日志。
   *
   * 刻意**不改 payload**:这种情况(批次卡在 queued/running)的原因可能是
   * Redis 掉了、worker 没注册、上游长时间退避,擅自把门改成 failed 会误导用户
   * 去点「重试」而重复入队。日志足够让运维发现,用户侧仍可用既有的
   * 「长时间无响应?点此重新拉起」逃生口。
   */
  async reportStalledGates(): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      dramaId: bigint; gate: string; batchStatus: string | null; idleMin: number;
    }>>(
      `SELECT g.dramaId, g.gate, b.status AS batchStatus,
              TIMESTAMPDIFF(MINUTE, b.updatedAt, NOW(3)) AS idleMin
         FROM dramas_gates g
         JOIN \`DramaBatch\` b
           ON b.uuid = JSON_UNQUOTE(JSON_EXTRACT(g.payload, '$.batchUuid'))
        WHERE JSON_UNQUOTE(JSON_EXTRACT(g.payload, '$.state')) = 'producing'
          AND b.status IN ('queued', 'running')
          AND TIMESTAMPDIFF(MINUTE, b.updatedAt, NOW(3)) >= ?`,
      STALLED_BATCH_MINUTES,
    );
    for (const r of rows) {
      this.logger.warn(
        `[pipeline] 门 ${r.gate} 剧 ${r.dramaId} 的批次已 ${r.batchStatus} ${r.idleMin} 分钟无更新,`
        + '疑似 worker 未消费或上游长退避,请检查队列',
      );
    }
    return rows.length;
  }

  /**
   * 清理「批次早就跑完、门却还在 producing」的孤儿门,返回处理条数。
   *
   * 这是启动自愈的第二类:与 generating 不同,producing 的门不依赖进程内存,
   * 它依赖"批次收尾时回来改 payload"这个动作。2026-09-15 之前没有任何代码做
   * 这件事,于是批次 done 了门还挂着 —— 前端 4s 轮询永远停不下来。
   * 现在 `DramaOrchestrator.settleGate()` 会在收尾时处理,这里只兜历史存量。
   */
  async sweepOrphanedProducingGates(): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      dramaId: bigint; gate: string; payload: unknown; batchStatus: string | null;
      batchError: string | null;
    }>>(
      `SELECT g.dramaId, g.gate, g.payload, b.status AS batchStatus, b.error AS batchError
         FROM dramas_gates g
         LEFT JOIN \`DramaBatch\` b
                ON b.uuid = JSON_UNQUOTE(JSON_EXTRACT(g.payload, '$.batchUuid'))
        WHERE JSON_UNQUOTE(JSON_EXTRACT(g.payload, '$.state')) = 'producing'`,
    );
    let swept = 0;
    for (const r of rows) {
      const p = payloadOf(r.payload);
      if (p.state !== 'producing') continue; // 双保险
      // 批次还在跑 / 暂停(可续跑) / 行已不存在 → 都不是孤儿,不动
      const st = r.batchStatus;
      if (st !== 'done' && st !== 'failed' && st !== 'cancelled') continue;
      if (p.batchStatus === st) continue; // 已收尾过,幂等跳过
      await this.setGatePayload(r.dramaId, r.gate, {
        ...p,
        batchStatus: st,
        settledAt: new Date().toISOString(),
        ...(st === 'failed' && r.batchError ? { batchError: r.batchError } : {}),
        ...(st === 'done' ? {} : {
          error: `批次已 ${st}${r.batchError ? `:${r.batchError}` : ''}。可在剧集详情页从断点续跑。`,
        }),
      });
      swept++;
      this.logger.warn(
        `[pipeline] 收尾孤儿 producing 门:剧 ${r.dramaId} 门 ${r.gate} → 批次已 ${st}`,
      );
    }
    if (swept) this.logger.warn(`[pipeline] 共收尾 ${swept} 个孤儿 producing 门,轮询已可停`);
    return swept;
  }

  /**
   * 把"上一个进程留下的 generating"落成 failed(带原因),返回处理条数。
   *
   * 为什么必须做:阶段循环只在进程内存里,被 kill 时连 catch 都不执行,
   * payload 会永久停在 generating,而前端在 generating 分支只画转圈 ——
   * 用户既看不到失败也点不到重试。这里至少让状态诚实。
   *
   * ⚠ 陈旧判定交给 MySQL 做(`updatedAt < NOW(3) - INTERVAL n MINUTE`),
   * 不能在 JS 里拿 `new Date()` 去减 —— 这几张表的 `updatedAt` 是 `NOW(3)`
   * 写的**本地时间**(本机 GMT+8),Prisma 读出来却按 UTC 解释,于是同一时刻
   * 在 JS 里会变成"8 小时后"。JS 侧相减恒为负 → 这条自愈会静默失效。
   */
  async sweepInterruptedStages(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      dramaId: bigint; gate: string; payload: unknown; updatedAt: Date; staleMs: number;
    }>>(
      `SELECT dramaId, gate, payload, updatedAt,
              TIMESTAMPDIFF(SECOND, updatedAt, NOW(3)) * 1000 AS staleMs
         FROM dramas_gates
        WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.state')) = 'generating'
          AND TIMESTAMPDIFF(SECOND, updatedAt, NOW(3)) * 1000 >= ?`,
      STAGE_INTERRUPT_MS,
    );
    let swept = 0;
    for (const r of rows) {
      const p = payloadOf(r.payload);
      if (p.state !== 'generating') continue; // 双保险:只动 generating
      const at = r.updatedAt ? new Date(r.updatedAt) : null;
      const staleMs = Number(r.staleMs) > 0 ? Number(r.staleMs) : STAGE_INTERRUPT_MS;
      const mins = Math.max(1, Math.round(staleMs / 60_000));
      await this.setGatePayload(r.dramaId, r.gate, {
        state: 'failed',
        error: `阶段中断:上次生成过程中后端进程被重启,进度停在 ${
          r.gate === 'gate2_design' ? '设定' : '剧本'
        }阶段(最后更新在 ${mins} 分钟前)。点「重试本阶段」重新拉起。`,
        interruptedAt: at ? at.toISOString() : null,
        interruptedFrom: p, // 保留现场(episodesDone 等),便于排查
        failedAt: now.toISOString(),
      });
      swept++;
      this.logger.warn(
        `[pipeline] 清理中断阶段:剧 ${r.dramaId} 门 ${r.gate} 停在 generating ${mins} 分钟 → 标 failed`,
      );
    }
    if (swept) this.logger.warn(`[pipeline] 共清理 ${swept} 个中断阶段,工作台已可点「重试本阶段」`);
    return swept;
  }

  // ===========================================================================
  // 对外:决策入口(控制器调这里,不再直调 novelLedger.decideGate)
  // ===========================================================================

  /** 审批门决策 + 通过时后台拉起对应生产阶段(立即返回,不吊 HTTP) */
  async decideAndAdvance(
    userId: bigint, dramaId: bigint, dramaUuid: string,
    gate: string, decision: 'passed' | 'rejected', note?: string,
  ): Promise<unknown> {
    const outcome = await this.ledger.decideGate(userId, dramaId, gate, decision, note);
    if (decision === 'passed') {
      const stage = GATE_STAGE_MAP[gate];
      if (stage) this.kick(dramaUuid, dramaId, stage);
    }
    return outcome;
  }

  /**
   * 重拉某阶段(失败重试 / 门已过但 payload 为空的历史剧恢复)。
   * gate 参数 = 要重跑的「结果门」:gate2_design → 设定阶段,
   * gate3_script → 剧本或生产阶段(按门状态:waiting 重跑剧本,passed 重拉生产)。
   */
  async retry(userId: bigint, dramaId: bigint, dramaUuid: string, gate: string): Promise<unknown> {
    if (!['gate2_design', 'gate3_script'].includes(gate)) {
      throw new BadRequestException('retry 只支持 gate2_design / gate3_script');
    }
    const prevGate = gate === 'gate2_design' ? 'gate1_budget' : 'gate2_design';
    const prev = await this.ledger.getGate(dramaId, prevGate);
    if (!prev) throw new NotFoundException('审批门不存在');
    if (prev.status !== 'passed') {
      throw new BadRequestException(`前置门 ${prevGate} 尚未通过,不能启动本阶段`);
    }
    let stage: PipelineStage;
    if (gate === 'gate2_design') {
      stage = 'design';
    } else {
      const g3 = await this.ledger.getGate(dramaId, 'gate3_script');
      stage = g3?.status === 'passed' ? 'production' : 'script';
    }
    this.kick(dramaUuid, dramaId, stage);
    return this.ledger.getByDrama(userId, dramaId);
  }

  /**
   * 解除驳回:把门从 `rejected` 改回 `waiting`,让项目重新可决策。
   *
   * 与 retry 的分工(两者正交,前端可以连着用):
   *   - `reopen` 只改门状态,不动产物 —— 适用"我刚才点错了/产物其实能用";
   *   - `retry`  重跑生成阶段 —— 适用"产物不行,重新生成一份"。
   * 典型组合:reopen → retry(重新生成) → 产物 ready → decide(passed)。
   *
   * 注意 retry 的前置校验是「前一道门必须 passed」,所以对 gate2_design 而言
   * 只要求 gate1_budget 已过 —— 门② 自己是不是 rejected 不影响,可以放心先
   * reopen 再 retry,顺序反过来也行。
   */
  async reopen(
    userId: bigint, dramaId: bigint, dramaUuid: string, gate: string,
  ): Promise<unknown> {
    if (!['gate1_budget', 'gate2_design', 'gate3_script'].includes(gate)) {
      throw new BadRequestException('gate 只支持 gate1_budget / gate2_design / gate3_script');
    }
    const out = await this.ledger.reopenGate(userId, dramaId, gate);
    this.logger.log(`[pipeline] ${dramaUuid} 门 ${gate} 已解除驳回,等待重新决策`);
    return out;
  }

  private kick(dramaUuid: string, dramaId: bigint, stage: PipelineStage): void {
    const key = `${dramaUuid}:${stage}`;
    if (this.running.has(key)) {
      this.logger.log(`[pipeline] ${key} 已在运行,跳过重复启动`);
      return;
    }
    this.running.add(key);
    const run = stage === 'design' ? () => this.runDesignStage(dramaUuid, dramaId)
      : stage === 'script' ? () => this.runScriptStage(dramaUuid, dramaId)
      : () => this.runProductionStage(dramaUuid, dramaId);
    run()
      .catch((e: any) => this.logger.error(`[pipeline] ${key} 失败: ${e?.message}`))
      .finally(() => this.running.delete(key));
  }

  // ===========================================================================
  // 阶段一:设定(门①通过后)
  // ===========================================================================

  private async runDesignStage(dramaUuid: string, dramaId: bigint): Promise<void> {
    const userId = await this.dramaUserId(dramaId);
    await this.setGatePayload(dramaId, 'gate2_design',
      {
        state: 'generating',
        startedAt: new Date().toISOString(),
        // 同 gate3:前端"多久没动"只认 JS 写的 UTC 时间戳,不认 DB updatedAt
        progressAt: new Date().toISOString(),
      });
    try {
      const ledger = await this.ledger.getLedgerRow(userId, dramaId);

      // P0-a:回填 beats(逐字原文锚点),让忠于原著的 coverage 与下游大纲锚点通电。
      //   幂等 + 降级安全:已有 beats / montage 不可用 / LLM 失败都不阻断设计阶段。
      await this.ledger.extractBeatsForDrama(userId, dramaId)
        .then((r) => this.logger.log(`[pipeline] beats 回填: ${JSON.stringify(r)}`))
        .catch((e: any) => this.logger.warn(`[pipeline] beats 回填失败(不阻断): ${e?.message}`));

      // 1. 入口 A:用小说圣经播种 drama 的 logline/synopsis/bible,
      //    让定妆设计与大纲贴着原著走(入口 B 无圣经,跳过)
      // 2026-09-16(批2)修死分支:ledger key 可能是 64 位 sha256(内容寻址),
      //   extractTaskUuid 只认 36 位 uuid → 恒 null → 播种永不执行(诊断断点)。
      //   改 uuid OR novelStorageKey 双键查找,两种 key 都能命中任务行。
      const taskUuid = ledger.novelSource === 'generated'
        ? extractTaskUuid(ledger.novelStorageKey) : null;
      if (ledger.novelSource === 'generated' && (taskUuid || ledger.novelStorageKey)) {
        const rows = await this.prisma.$queryRawUnsafe<{ bibleJson: any }[]>(
          'SELECT bibleJson FROM novel_gen_tasks WHERE uuid = ? OR novelStorageKey = ? LIMIT 1',
          taskUuid || '', ledger.novelStorageKey || '',
        );
        const bible = typeof rows[0]?.bibleJson === 'string'
          ? JSON.parse(rows[0].bibleJson) : (rows[0]?.bibleJson || null);
        const patch = bibleFromNovelBible(bible);
        if (patch) {
          await this.svc.updateDrama(dramaUuid, {
            ...(bible?.concept?.logline ? { logline: String(bible.concept.logline) } : {}),
            ...(bible?.storyBible?.world ? { synopsis: String(bible.storyBible.world) } : {}),
            bible: patch,
          });
        }
      }

      // 2. 账本剧集 → storyArc(逐集大纲提示词会按 ep 取用 purpose)
      const arc = arcFromLedger(ledger.ledgerJson);
      if (arc.length) await this.svc.setStoryArc(dramaUuid, arc);

      // 3. 定妆设计(角色/场景/道具 → DramaAsset,pending 态)
      const hint = [ledger.novelTitle, arc[0]?.purpose].filter(Boolean).join(' ');
      const { created, skipped, design } = await this.svc.generateDesign(dramaUuid, hint || undefined);

      const names = (coll: string) =>
        (Array.isArray((design as any)?.[coll]) ? (design as any)[coll] : [])
          .map((x: any) => ({
            name: String(x.name || ''),
            desc: String(x.appearance || x.description || '').slice(0, 80),
          }))
          .filter((x: any) => x.name);
      await this.setGatePayload(dramaId, 'gate2_design', {
        state: 'ready',
        generatedAt: new Date().toISOString(),
        createdCount: created?.length || 0,
        skippedCount: skipped?.length || 0,
        characters: names('characters'),
        locations: names('locations'),
        props: names('props'),
      });
      this.logger.log(`[pipeline] ${dramaUuid} 设定完成:新建 ${created?.length || 0} 项`);
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 400);
      await this.setGatePayload(dramaId, 'gate2_design',
        { state: 'failed', error: msg, failedAt: new Date().toISOString() })
        .catch(() => null);
      throw e;
    }
  }

  // ===========================================================================
  // 阶段二:剧本(门②通过后,逐集承接大纲)
  // ===========================================================================

  private async runScriptStage(dramaUuid: string, dramaId: bigint): Promise<void> {
    const userId = await this.dramaUserId(dramaId);
    let total = 1;
    // 单集目标时长:剧本阶段也要带 —— 逐集大纲的 prompt 里有"目标时长"一栏,
    // 不带就会退回"2-3 分钟"的兜底文案,和用户在表单里的选择脱节。
    let epTargetSec = 120;
    try {
      const ledger = await this.ledger.getLedgerRow(userId, dramaId);
      total = Math.max(1, Number(ledger.episodeCount) || (ledger.ledgerJson?.episodes || []).length || 1);
      if (Number(ledger.ledgerJson?.meta?.budget?.ep_target_sec) > 0) {
        epTargetSec = Math.round(Number(ledger.ledgerJson.meta.budget.ep_target_sec));
      }
    } catch (e: any) {
      await this.setGatePayload(dramaId, 'gate3_script',
        { state: 'failed', error: (e?.message || String(e)).slice(0, 400) })
        .catch(() => null);
      throw e;
    }
    await this.setGatePayload(dramaId, 'gate3_script', {
      state: 'generating', episodesTotal: total, episodesDone: 0,
      startedAt: new Date().toISOString(),
      // progressAt 由 JS 写(真 UTC),给前端算"多久没动"用。
      // 不能拿 DB 的 updatedAt 去减:那是 NOW(3) 写的本地时间,Prisma 按 UTC
      // 读出来会快 8 小时,前端相减恒为负 → 逃生口提示永远不显示。
      progressAt: new Date().toISOString(),
    });

    // 门② 通过 = 用户已确认设定 → 自动开跑批量定妆,与剧本阶段并行。
    // 放在这里而不是设定阶段:设定阶段产物还没经用户确认,提前烧图像配额
    // 等于替用户做决定。剧本阶段是纯 LLM、逐集 20~40s,与定妆(分钟级图像)
    // 时间上正好重叠,等用户审完门③剧本时定妆基本已就绪 —— 关键帧不再退化
    // 成纯文生图,也就不会再出现"主角跨镜换脸"。
    // startForGate2Pass 内部已 catch,定妆起不来不会拖垮剧本阶段。
    await this.portraits.startForGate2Pass(dramaUuid);

    const episodes: Array<Record<string, any>> = [];
    const failedEps: Array<{ ep: number; error: string }> = [];
    try {
      for (let ep = 1; ep <= total; ep++) {
        try {
          await this.svc.ensureEpisode(dramaUuid, ep);
          const out = await this.svc.generateEpisodeStep(dramaUuid, ep, 0, { targetSec: epTargetSec });
          const outline = this.svc.stepOutputOf(out, 0);
          episodes.push({
            epNo: ep,
            title: String(outline?.title || `第 ${ep} 集`),
            scenes: (outline?.scenes || []).length,
            needsAssets: (outline?.needs_assets || []).length,
            hookOut: String(outline?.hook_out || ''),
          });
        } catch (e: any) {
          // 单集大纲失败不停整段:连集批次会在第 0 步重生成(doneSteps 幂等跳过)
          failedEps.push({ ep, error: (e?.message || String(e)).slice(0, 200) });
          this.logger.warn(`[pipeline] ${dramaUuid} EP${ep} 大纲失败: ${e?.message}`);
        }
        await this.setGatePayload(dramaId, 'gate3_script', {
          state: 'generating', episodesTotal: total, episodesDone: ep,
          progressAt: new Date().toISOString(),
        });
      }
      if (!episodes.length) {
        throw new BadRequestException(
          `全部 ${total} 集大纲都生成失败:${failedEps[0]?.error || '未知原因'}`,
        );
      }
      await this.setGatePayload(dramaId, 'gate3_script', {
        state: 'ready',
        generatedAt: new Date().toISOString(),
        episodesTotal: total,
        episodesDone: episodes.length,
        episodes,
        ...(failedEps.length ? { failedEps } : {}),
      });
      this.logger.log(`[pipeline] ${dramaUuid} 剧本完成:${episodes.length}/${total} 集`);
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 400);
      await this.setGatePayload(dramaId, 'gate3_script',
        { state: 'failed', error: msg, failedAt: new Date().toISOString() })
        .catch(() => null);
      throw e;
    }
  }

  // ===========================================================================
  // 阶段三:连集生产(门③通过后,BullMQ 批次)
  // ===========================================================================

  private async runProductionStage(dramaUuid: string, dramaId: bigint): Promise<void> {
    try {
      const userId = await this.dramaUserId(dramaId);
      const ledger = await this.ledger.getLedgerRow(userId, dramaId);
      const total = Math.max(1, Number(ledger.episodeCount) || (ledger.ledgerJson?.episodes || []).length || 1);

      // 防重复烧配额:该剧已有非终态批次(retry/进程重启后重复触发)直接复用,
      // 不再新建。paused 的续跑交给剧集详情页的「提高预算续跑」。
      const existing = await this.prisma.$queryRawUnsafe<Array<{
        uuid: string; status: string; fromEp: number; toEp: number; policy: any;
      }>>(
        `SELECT uuid, status, fromEp, toEp, policy FROM \`DramaBatch\`
          WHERE dramaId = ? ORDER BY id DESC LIMIT 1`, dramaId,
      );
      const ex = existing[0];
      if (ex && ['queued', 'running', 'paused'].includes(ex.status)) {
        const policy = typeof ex.policy === 'string' ? JSON.parse(ex.policy || '{}') : (ex.policy || {});
        await this.setGatePayload(dramaId, 'gate3_script', {
          state: 'producing', batchUuid: ex.uuid,
          fromEp: ex.fromEp, toEp: ex.toEp,
          budgetCredits: Number(policy.budgetCredits) || 0,
          reused: true, startedAt: new Date().toISOString(),
        });
        this.logger.log(`[pipeline] ${dramaUuid} 复用既有批次 ${ex.uuid}(${ex.status}),不重复入队`);
        return;
      }

      const budgetCredits = estimateBudgetCredits(total);

      // 单集目标时长:账本 ingest 时由用户在表单选定的值,存在 meta.budget.ep_target_sec。
      // 必须在这里取出来塞进批次策略 —— 生成链路(大纲/分镜)不看账本,
      // 少了这一步就会退回提示词兜底的"2-3 分钟",成片只有预期的 1/3。
      const epTargetSec = Number(ledger.ledgerJson?.meta?.budget?.ep_target_sec) > 0
        ? Math.round(Number(ledger.ledgerJson.meta.budget.ep_target_sec)) : 120;

      const batch = await this.svc.createBatch(dramaUuid, Number(userId), {
        fromEp: 1, toEp: total,
        policy: { budgetCredits, stopOnFailure: false, epTargetSec },
      });
      await this.orchestrator.startBatch(batch.uuid, dramaUuid, Number(userId));
      // 与 resumeBatch 同套路:入队即置 running,前端才能判定拉起成功
      await this.svc.setBatchStatus(batch.uuid, 'running', { epNo: batch.fromEp, step: 0 });

      await this.setGatePayload(dramaId, 'gate3_script', {
        state: 'producing',
        batchUuid: batch.uuid,
        fromEp: 1, toEp: total, budgetCredits,
        startedAt: new Date().toISOString(),
      });
      this.logger.log(
        `[pipeline] ${dramaUuid} 连集生产已入队:batch=${batch.uuid} EP1-${total} budget=${budgetCredits}`,
      );
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 400);
      await this.setGatePayload(dramaId, 'gate3_script',
        { state: 'failed', error: msg, failedAt: new Date().toISOString() })
        .catch(() => null);
      throw e;
    }
  }

  // ===========================================================================
  // 工具
  // ===========================================================================

  private async setGatePayload(dramaId: bigint, gate: string, payload: any): Promise<void> {
    await this.ledger.setGatePayload(dramaId, gate, payload);
  }

  private async dramaUserId(dramaId: bigint): Promise<bigint> {
    const rows = await this.prisma.$queryRawUnsafe<{ userId: bigint }[]>(
      'SELECT userId FROM `Drama` WHERE id = ? LIMIT 1', dramaId,
    );
    if (!rows.length) throw new NotFoundException(`剧集不存在: ${dramaId}`);
    return rows[0].userId;
  }
}
