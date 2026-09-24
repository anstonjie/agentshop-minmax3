// ============================================================================
// NovelLedgerService —— Novel2Drama 对齐账本层（P1）
// ----------------------------------------------------------------------------
// 最终方案 v6.0 §5.2/§6.1。数据层 4 张表(migration 20260913150000):
//   dramas_novel_ledger / dramas_novel_beats / dramas_gates / dramas_snaps
//
// 与 DramaService 同套路:全用 $queryRawUnsafe(query_engine.dll 被锁),
// schema.prisma 对应段是数据契约文档。
//
// n2d-core 桥接:对齐引擎本体在 tool/n2d-core(独立 npm 工程,smoke 全绿)。
// P1 采用「CLI 子进程桥接」——backend 通过 child_process 调 dist/cli.js,
// 账本 JSON 全程经 DB 过手(n2d-core 不直连 MySQL)。P2 若性能有需要再
// 把 n2d-core 源码 vendor 进 modules/drama/core/(接口签名已对齐,迁移零改)。
//
// 2026-09-24:tool/n2d-core 源码丢失,引擎按生产账本标定重建为库内纯函数
//   (./n2d-engine,原 P2 vendor 路线提前执行),子进程桥接同时下线 ——
//   少一个构建产物、少 Windows spawn 坑,行为全单测锁定(n2d-engine.spec)。
//
// M0/P1 范围:账本 CRUD、ingest(调 n2d-core init)、beats 投影同步、
//           校验(check:budget/coverage 结果落审计并同步 beats 表)、
//           审批门状态机、快照记录(时间机器读侧)。
// 生成服务(agnes 全模态)在 P2 接 skill 派发,本文件不含生成逻辑。
// ============================================================================

import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException, Optional,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenMontageService } from '../open-montage/open-montage.service';
import {
  DEFAULT_UNIT_PRICES, estimateBatchCredits, estimateWallMinutes, shotsPerEpisodeFor,
} from './drama-pricing';
import { dramaNovelDir } from '../../common/paths';
import {
  buildBeatExtractPrompt, parseBeats, reconcileBeats, reconcileForeshadowPairs, type ExtractedBeat,
} from './beat-extract';
import { chapterGoodEndingHints, repackLedgerEpisodes } from './episode-boundary';
import { planEpisodeBudgets } from './episode-budget';
import { normalizeLf } from './novel-anchor';
import { buildLedgerJson, checkLedgerJson } from './n2d-engine';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

  // ── n2d-core CLI 桥接 ────────────────────────────────────────────────
  // 2026-09-24:子进程桥接下线(源码丢失后引擎库内化,见 ./n2d-engine)。
  //   runN2D/resolveN2dCli/exportToTmp 同步删除;两处调用改为库内直调。

/** 校验结果(n2d-core CheckResult 的 JSON 形态) */
export interface CheckOutcome {
  checker: string;
  stage: string;
  passed: boolean;
  violations: Array<{
    rule: string; level: 'error' | 'warn'; target: string;
    message: string; userMessage?: string;
  }>;
}

/** 账本行(DB 存储形态) */
interface LedgerRow {
  id: bigint; uuid: string; dramaId: bigint; userId: bigint;
  novelSource: string; novelTitle: string; totalChars: bigint;
  totalMinutes: any; kEff: any; episodeCount: number; stage: string;
  ledgerVersion: number; ledgerJson: any; novelStorageKey: string | null;
  snapshotPool: string | null; createdAt: Date; updatedAt: Date;
}

interface BeatRow {
  id: bigint; ledgerId: bigint; beatKey: string; chapterKey: string;
  chapterNo: number; type: string; summary: string; quote: string;
  mustShow: number; foreshadowPair: string | null; status: string;
  coveredBy: string | null; createdAt: Date;
}

interface GateRow {
  id: bigint; uuid: string; dramaId: bigint; gate: string; status: string;
  payload: any; userMessage: string | null; decidedBy: bigint | null;
  decidedAt: Date | null; autoMode: number; createdAt: Date; updatedAt: Date;
}

/** 三道审批门的先后顺序 —— 唯一真相源(assertGateName / listActiveProjects 共用)。
 *  「第一道未 passed 的门 = 项目当前卡在哪」这个判定到处要用,散落会漂。 */
const GATE_ORDER = ['gate1_budget', 'gate2_design', 'gate3_script'] as const;

// ── BigInt/Decimal JSON 序列化辅助(与 DramaService 同套路) ──
function jsonify<T>(rows: T[]): unknown[] {
  return JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
}

@Injectable()
export class NovelLedgerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NovelLedgerService.name);

  /** 本进程启动时刻(sweepStaleRepacking 判据:早于它的 repacking 只可能是上个进程的遗留)。 */
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    /**
     * 只用来读 key 池大小,给报价单算"要等多久"。
     * 标 @Optional():本服务的单测直接 `new NovelLedgerService(fakePrisma)`,
     * 不传时预估退化为按 1 把 key 计算(偏保守,不会算出过于乐观的数字)。
     */
    @Optional() private readonly montage?: OpenMontageService,
  ) {}

  // ── n2d 对齐引擎(库内直调,见 ./n2d-engine) ─────────────────────────────
  // 2026-09-24:子进程桥接(runN2D/resolveN2dCli/exportToTmp)下线,两处调用
  //   (ingest/check)改为库内纯函数直调。删得干净,不留转接层。

  // ── 账本 CRUD ────────────────────────────────────────────────────────

  /** ingest:上传原文 → 临时文件 → n2d-core init → 账本入库 + beats 投影 */
  async createFromNovel(
    userId: bigint, dramaId: bigint,
    novelText: string, title: string, source: 'generated' | 'uploaded',
    epTargetSec = 120,
  ): Promise<unknown> {
    // 0. Drama 归属校验
    const drama = await this.prisma.$queryRawUnsafe<{ id: bigint }[]>(
      'SELECT id FROM `Drama` WHERE id = ? AND userId = ?', dramaId, userId,
    );
    if (!drama.length) throw new NotFoundException('剧不存在或不属于当前用户');

    // 1. 原文落 uploads(内容寻址:novel/<sha256>.txt)
    const { createHash } = require('crypto') as typeof import('crypto');
    const sha = createHash('sha256').update(novelText, 'utf-8').digest('hex');
    // 2026-09-15 修复:原来这里写 path.resolve(__dirname, '../../../../../../backend/uploads'),
    //   从 dist/src/modules/drama 上溯 6 级会落到 <repo 的上一级>,快照全被写到项目外
    //   (实测 D:\ai369\backend\uploads),静态路由 /uploads/... 必然 404。
    //   改用共享 helper(向上找 backend 根),src/dist 两种布局都对。
    const novelDir = dramaNovelDir();
    fs.mkdirSync(novelDir, { recursive: true });
    const novelPath = path.join(novelDir, `${sha}.txt`);
    fs.writeFileSync(novelPath, novelText, 'utf-8');

    // 2. 对齐引擎建账本(库内直调;原 tool/n2d-core init 子进程已下线,见 ./n2d-engine)
    let ledgerJson: any;
    try {
      ledgerJson = buildLedgerJson({ novelText, title, source, epTargetSec });
    } catch (e: any) {
      throw new BadRequestException(`账本生成失败:${e?.message || e}`.slice(0, 400));
    }

    // 3. 入库(一部剧一份,已存在则拒)
    const exists = await this.prisma.$queryRawUnsafe<{ c: number }[]>(
      'SELECT COUNT(*) AS c FROM dramas_novel_ledger WHERE dramaId = ?', dramaId,
    );
    if (exists[0].c > 0) throw new ConflictException('该剧已有对齐账本(回退/重建走快照流程)');

    const meta = ledgerJson.meta;
    await this.prisma.$queryRawUnsafe(
      `INSERT INTO dramas_novel_ledger
         (uuid, dramaId, userId, novelSource, novelTitle, totalChars,
          totalMinutes, kEff, episodeCount, stage, ledgerVersion, ledgerJson, novelStorageKey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingest', ?, ?, ?)`,
      randomUUID(), dramaId, userId, source, title, Number(meta.total_chars),
      Number(meta.budget.total_minutes), Number(meta.budget.k_eff),
      ledgerJson.episodes.length, meta.version,
      JSON.stringify(ledgerJson), `drama-novel/${sha}.txt`,
    );

    // 4. beats 投影(此时 beats 为空,ingest 只落账本;beats 在 S1 后由 syncBeats 落表)
    // 5. 建三道审批门(①预算等待用户确认)
    //
    // 2026-09-15:报价单**必须有价格**。之前这里只回时长/集数/字数(注释里写着
    // "P2 接 CostEstimator"),用户被要求"确认报价"却看不到要花多少 —— 实测
    // gate1_budget 里 waiting 25 / passed 9,四分之三的项目卡在这一格没人点。
    // 现在复用 drama-pricing 的纯函数把积分与墙钟两个数字都算出来。
    const shotsPerEp = shotsPerEpisodeFor(epTargetSec);
    const est = estimateBatchCredits(ledgerJson.episodes.length, DEFAULT_UNIT_PRICES, {
      shotsPerEpisode: shotsPerEp,
    });
    const estMinutes = estimateWallMinutes(
      ledgerJson.episodes.length, shotsPerEp, this.montage?.agnesKeyCount ?? 0,
    );
    const quotePayload = JSON.stringify({
      totalMinutes: Number(meta.budget.total_minutes),
      episodeCount: ledgerJson.episodes.length,
      novelChars: Number(meta.total_chars),
      kEff: Number(meta.budget.k_eff),
      // 用户在表单里选的单集目标时长 —— 报价与生成链路现在共用同一个值
      epTargetSec,
      // 成本与耗时预估(开跑前让用户心里有数)
      estimatedCredits: est.credits,
      estimatedShots: est.shots,
      shotsPerEpisode: shotsPerEp,
      estimatedWallMinutes: estMinutes,
      unitPrices: DEFAULT_UNIT_PRICES,
      keyCount: this.montage?.agnesKeyCount ?? 0,
      // P2-a:ingest 只是**临时装箱**;后台 runBeatsAndRepack 会抽 beats 按章节节拍重排分集
      //   并重算此报价。repacking=true 期间 decideGate 拒绝确认门①,防止用户对着旧报价拍板。
      //   repackingAt 供 ① 启动自愈识别「旧进程遗留」(见 sweepStaleRepacking)② decideGate
      //   的 409 文案估算「已等多久、还要多久」。没有它,重启后标志永驻,门①永远点不动。
      repacking: true,
      repackingAt: new Date().toISOString(),
    });
    for (const gate of GATE_ORDER) {
      await this.prisma.$queryRawUnsafe(
        `INSERT INTO dramas_gates (uuid, dramaId, gate, status, payload)
         VALUES (?, ?, ?, 'waiting', ?)`,
        randomUUID(), dramaId, gate,
        gate === 'gate1_budget' ? quotePayload : JSON.stringify({}),
      );
    }

    // P2-a:后台异步抽 beats + 按节拍重排分集 + 重算门①报价(慢操作,绝不阻塞 ingest 响应)。
    //   runBeatsAndRepack 内部全程降级安全,finally 里必清 repacking 标志,不会把用户永久卡在门①。
    this.runBeatsAndRepack(userId, dramaId)
      .catch((e: any) => this.logger.warn(`[ingest] 后台 beats/重排失败(不阻断): ${e?.message}`));

    return this.getByDrama(userId, dramaId);
  }

  /** 读账本(含 gates 状态;BigInt 转 string) */
  async getByDrama(userId: bigint, dramaId: bigint): Promise<unknown> {
    const rows = await this.prisma.$queryRawUnsafe<LedgerRow[]>(
      'SELECT * FROM dramas_novel_ledger WHERE dramaId = ? AND userId = ?', dramaId, userId,
    );
    if (!rows.length) throw new NotFoundException('该剧没有对齐账本');
    const gates = await this.prisma.$queryRawUnsafe<GateRow[]>(
      'SELECT * FROM dramas_gates WHERE dramaId = ? ORDER BY gate', dramaId,
    );
    const out = {
      ...(jsonify(rows)[0] as Record<string, unknown>),
      gates: jsonify(gates),
    };
    this.backfillQuote((out as any).gates, Number((out as any).episodeCount));
    return out;
  }

  /**
   * 罗列整部剧的逐集时长计划:能出多少集、每集内容多长、clamp 后实际生成多长、
   * 总时长/总字数。纯读账本、无副作用。用于报价/工作台展示"内容驱动的集数与时长"。
   * 没建过账本 → 抛 NotFound(与 getByDrama 一致)。
   */
  async planForDrama(userId: bigint, dramaId: bigint) {
    const rows = await this.prisma.$queryRawUnsafe<{ ledgerJson: any }[]>(
      'SELECT `ledgerJson` FROM `dramas_novel_ledger` WHERE `dramaId` = ? AND `userId` = ? LIMIT 1',
      dramaId, userId,
    );
    if (!rows.length) throw new NotFoundException('该剧没有对齐账本');
    // ledgerJson 列经 Prisma 可能是对象也可能是字符串(视驱动/列类型),两种都吃
    const ljRaw = rows[0].ledgerJson;
    const lj: any = typeof ljRaw === 'string'
      ? (() => { try { return JSON.parse(ljRaw); } catch { return null; } })()
      : ljRaw;
    return planEpisodeBudgets(lj);
  }

  /**
   * 读时补算 gate1 报价。
   *
   * 2026-09-15 之前建的账本,gate1 payload 里没有价格(当时只有时长/集数/字数),
   * 于是那 25 个 waiting 的报价门在用户眼里依旧是"没有价格的报价单"。
   * 这里按**当前**单价口径现算一份补上,但**不写库**:
   *   - 只读路径不该有副作用;
   *   - 报价口径以后还会调,读时算永远用最新口径,不会留一堆过期数字。
   * 补算出来的会带 `quoteEstimated: true`,前端据此提示"该项目建立较早,
   * 价格为当前口径估算"。
   */
  private backfillQuote(gates: any[], episodeCount: number): void {
    const g1 = (gates || []).find((g) => g?.gate === 'gate1_budget');
    if (!g1) return;
    const p = this.parsePayload(g1 as GateRow);
    if (Number(p.estimatedCredits) > 0) return;
    const eps = Math.max(1, Number(episodeCount) || 1);
    const targetSec = Number(p.epTargetSec) > 0 ? Number(p.epTargetSec) : 120;
    const shotsPerEp = shotsPerEpisodeFor(targetSec);
    const est = estimateBatchCredits(eps, DEFAULT_UNIT_PRICES, { shotsPerEpisode: shotsPerEp });
    const keys = this.montage?.agnesKeyCount ?? 0;
    g1.payload = {
      ...p,
      epTargetSec: targetSec,
      estimatedCredits: est.credits,
      estimatedShots: est.shots,
      shotsPerEpisode: shotsPerEp,
      estimatedWallMinutes: estimateWallMinutes(eps, shotsPerEp, keys),
      unitPrices: DEFAULT_UNIT_PRICES,
      keyCount: keys,
      quoteEstimated: true,
    };
  }

  /** 校验:库内直调 check → 结果写回 audit_trail + 版本号 */
  async runCheck(
    userId: bigint, dramaId: bigint,
    which: 'budget' | 'coverage', stage = 'ingest',
  ): Promise<CheckOutcome & { ledgerVersion: number }> {
    const ledger = await this.loadLedgerForWrite(userId, dramaId);
    const ljRaw = (ledger as any).ledgerJson;
    const ljParsed: any = typeof ljRaw === 'string'
      ? (() => { try { return JSON.parse(ljRaw); } catch { return null; } })()
      : ljRaw;
    if (!ljParsed || typeof ljParsed !== 'object') {
      throw new BadRequestException('账本 JSON 损坏,无法校验');
    }
    const checked = checkLedgerJson(ljParsed, which, stage);
    const updated = checked.ledgerJson;

    // 结果写回 DB(账本 JSON 已被 check 更新:audit_trail + version)
    const outcome: CheckOutcome = {
      checker: which === 'budget' ? 'check_budget' : 'check_coverage',
      stage: which === 'budget' ? 'ingest' : stage,
      passed: !checked.failed,
      violations: (((updated.audit_trail[updated.audit_trail.length - 1] as any)?.violations ?? []) as string[])
        .map((line: string) => this.parseAuditLine(line)),
    };
    await this.prisma.$queryRawUnsafe(
      `UPDATE dramas_novel_ledger
         SET ledgerJson = ?, ledgerVersion = ?, stage = ?
       WHERE id = ?`,
      JSON.stringify(updated), updated.meta.version, stage, ledger.id,
    );

    // coverage 时同步 beats 投影(状态可能变化)
    if (which === 'coverage') await this.syncBeats(ledger.id, updated);

    return { ...outcome, ledgerVersion: updated.meta.version };
  }

  /** beats 回填(S1 LLM 抽取后):merge 进账本 → 投影落表 */
  async appendBeats(userId: bigint, dramaId: bigint, beats: unknown[]): Promise<unknown> {
    if (!Array.isArray(beats) || !beats.length) throw new BadRequestException('beats 数组为空');
    const ledger = await this.loadLedgerForWrite(userId, dramaId);
    const lj = ledger.ledgerJson;

    // 最小校验:必填字段 + quote 非空(防幻觉锚点是硬门槛)
    for (const b of beats as Array<Record<string, unknown>>) {
      if (!b.id || !b.chapter || !b.quote || !b.type) {
        throw new BadRequestException('beat 缺少 id/chapter/quote/type 之一');
      }
      if (typeof b.quote !== 'string' || b.quote.trim().length < 5) {
        throw new BadRequestException(`beat ${b.id} 的 quote 过短(防幻觉锚点必须 ≥5 字)`);
      }
      if (!lj.chapters.some((c: { id: string }) => c.id === b.chapter)) {
        throw new BadRequestException(`beat ${b.id} 引用不存在的章节 ${b.chapter}`);
      }
    }
    lj.beats.push(...(beats as object[]));
    lj.meta.version += 1;

    await this.prisma.$queryRawUnsafe(
      `UPDATE dramas_novel_ledger SET ledgerJson = ?, ledgerVersion = ? WHERE id = ?`,
      JSON.stringify(lj), lj.meta.version, ledger.id,
    );
    await this.syncBeats(ledger.id, lj);
    return { beatsTotal: lj.beats.length, ledgerVersion: lj.meta.version };
  }

  /**
   * P0-a:ingest 后用 LLM 把每章正文抽成 beats(逐字 quote 锚点)回填账本,
   * 让"忠于原著"的 check:coverage 与下游大纲原文锚点真正通电(诊断断点①:
   * beats 表全程为空、appendBeats 只挂手动端点、自动化流水线从不调)。
   *
   * 幂等:账本已有 beats 就跳过(force 可强制重抽)。
   * 降级安全:montage 不可用 / 无正文 / 单章 LLM 失败一律记录并继续,整体不抛错、不阻断流水线。
   * 防幻觉:每条 beat 的 quote 必须逐字命中章节原文(reconcileBeats),命中不了直接丢弃。
   */
  async extractBeatsForDrama(
    userId: bigint, dramaId: bigint, opts?: { force?: boolean },
  ): Promise<{ extracted: number; rejected: number; skipped?: string }> {
    if (!this.montage) return { extracted: 0, rejected: 0, skipped: 'MONTAGE_UNAVAILABLE' };
    const montage = this.montage;
    try {
      const row = await this.getLedgerRow(userId, dramaId);
      const lj = row.ledgerJson;
      const existing = Array.isArray(lj?.beats) ? lj.beats.length : 0;
      if (existing > 0 && !opts?.force) {
        return { extracted: 0, rejected: 0, skipped: 'ALREADY_HAS_BEATS' };
      }
      const chapters: any[] = Array.isArray(lj?.chapters) ? lj.chapters : [];
      if (!chapters.length) return { extracted: 0, rejected: 0, skipped: 'NO_CHAPTERS' };
      if (!row.novelStorageKey) return { extracted: 0, rejected: 0, skipped: 'NO_NOVEL_TEXT' };

      const novelPath = path.join(dramaNovelDir(), path.basename(row.novelStorageKey));
      if (!fs.existsSync(novelPath)) return { extracted: 0, rejected: 0, skipped: 'NOVEL_FILE_MISSING' };
      const novel = normalizeLf(fs.readFileSync(novelPath, 'utf-8'));

      const drows = await this.prisma.$queryRawUnsafe<Array<{ agentId: bigint }>>(
        'SELECT agentId FROM `Drama` WHERE id = ?', dramaId,
      );
      const ctx = { userId: Number(userId), agentId: Number(drows[0]?.agentId ?? 0) };

      const allKept: ExtractedBeat[] = [];
      let rejectedCount = 0;
      for (const ch of chapters) {
        const off = ch?.char_offset;
        if (!Array.isArray(off) || off.length !== 2) continue;
        const s = Math.max(0, Math.floor(Number(off[0]) || 0));
        const e = Math.min(novel.length, Math.ceil(Number(off[1]) || 0));
        const body = e > s ? novel.slice(s, e) : '';
        if (body.trim().length < 20) continue; // 太短的章节不值得抽
        const prompt = buildBeatExtractPrompt(String(ch.title || ''), body);
        let raw = '';
        try {
          raw = await montage.callLlm(ctx, prompt.system, prompt.user, prompt.temperature, prompt.maxTokens);
        } catch (e2: any) {
          this.logger.warn(`[beats] 章节 ${ch.id} LLM 抽取失败(跳过该章,不阻断): ${e2?.message}`);
          continue;
        }
        const beats = parseBeats(raw, String(ch.id), (s2) => montage.parseJsonSafe(s2));
        const { kept, rejected } = reconcileBeats(beats, body);
        rejectedCount += rejected.length;
        // 2026-09-22 伏笔配对键自愈:LLM 只给"埋伏"一边写键、不给 reveal 一边同键 → check:coverage I3 全 warn。
        //   在 appendBeats 之前清掉单边/同型配对键,落库的就是真配对。
        const pairResult = reconcileForeshadowPairs(kept);
        if (pairResult.deduped) {
          this.logger.warn(`[beats] 章节 ${ch.id} 配对键自愈:清掉 ${pairResult.deduped} 个单边/同型键`);
        }
        allKept.push(...pairResult.beats);
        if (rejected.length) {
          this.logger.warn(`[beats] 章节 ${ch.id} 丢弃 ${rejected.length} 条 quote 未逐字命中原文的 beat(防幻觉)`);
        }
      }

      if (!allKept.length) return { extracted: 0, rejected: rejectedCount, skipped: 'NO_BEATS_KEPT' };
      await this.appendBeats(userId, dramaId, allKept);
      this.logger.log(`[beats] 回填 ${allKept.length} 条 beats(丢弃 ${rejectedCount} 条疑似幻觉)`);
      return { extracted: allKept.length, rejected: rejectedCount };
    } catch (e: any) {
      this.logger.warn(`[beats] 抽取回填失败(降级不阻断): ${e?.message}`);
      return { extracted: 0, rejected: 0, skipped: `ERROR:${e?.message}` };
    }
  }

  /**
   * P2-a 后台阶段:抽 beats(P0-a)→ 按章节节拍重排分集 → 重算门①报价 → 清 repacking。
   * 全程降级安全;finally 里必清 repacking 标志,无论成败都放行门①,绝不把用户永久卡住。
   */
  async runBeatsAndRepack(userId: bigint, dramaId: bigint): Promise<void> {
    try {
      await this.extractBeatsForDrama(userId, dramaId);    // 幂等;内部已降级
      await this.repackEpisodesWithBeats(userId, dramaId); // 内部已降级
    } catch (e: any) {
      this.logger.warn(`[beats-repack] 后台阶段异常(不阻断): ${e?.message}`);
    } finally {
      await this.clearRepackingFlag(dramaId);
    }
  }

  /**
   * P2-a:用 beats 收尾信号重排 ledgerJson.episodes(装箱改造),持久化 + 重算门①报价。
   * 只在 ingest 之后、design/script 之前跑 —— 此时还没有 DramaEpisode 行,重排零下游对账成本。
   */
  async repackEpisodesWithBeats(
    userId: bigint, dramaId: bigint,
  ): Promise<{ changed: boolean; reason?: string; from: number; to: number }> {
    try {
      const ledger = await this.loadLedgerForWrite(userId, dramaId);
      const lj = ledger.ledgerJson;
      const beats = Array.isArray(lj?.beats) ? lj.beats : [];
      const from = Array.isArray(lj?.episodes) ? lj.episodes.length : 0;
      if (!beats.length) return { changed: false, reason: 'NO_BEATS', from, to: from };
      const hints = chapterGoodEndingHints(beats);
      const epTarget = Number(lj?.meta?.budget?.ep_target_sec) || 120;
      const r = repackLedgerEpisodes(lj, hints, epTarget);
      if (!r.changed) return { changed: false, reason: r.reason, from: r.fromEpisodeCount, to: r.toEpisodeCount };

      const newVersion = Number(r.ledgerJson?.meta?.version ?? 1) + 1;
      r.ledgerJson.meta = { ...(r.ledgerJson.meta || {}), version: newVersion };
      await this.prisma.$executeRawUnsafe(
        'UPDATE dramas_novel_ledger SET ledgerJson = ?, ledgerVersion = ?, episodeCount = ? WHERE id = ?',
        JSON.stringify(r.ledgerJson), newVersion, r.toEpisodeCount, ledger.id,
      );
      await this.refreshGate1Quote(dramaId, r.ledgerJson, epTarget);
      this.logger.log(`[repack] 剧 ${dramaId} 分集按节拍重排 ${r.fromEpisodeCount}→${r.toEpisodeCount} 集`);
      return { changed: true, from: r.fromEpisodeCount, to: r.toEpisodeCount };
    } catch (e: any) {
      this.logger.warn(`[repack] 重排失败(保留临时装箱,不阻断): ${e?.message}`);
      return { changed: false, reason: `ERROR:${e?.message}`, from: 0, to: 0 };
    }
  }

  /** 重算门①报价(集数可能变)并清 repacking 标志。复用 createFromNovel 同款定价纯函数。 */
  private async refreshGate1Quote(dramaId: bigint, lj: any, epTargetSec: number): Promise<void> {
    const episodeCount = Array.isArray(lj?.episodes) ? lj.episodes.length : 0;
    const shotsPerEp = shotsPerEpisodeFor(epTargetSec);
    const est = estimateBatchCredits(episodeCount, DEFAULT_UNIT_PRICES, { shotsPerEpisode: shotsPerEp });
    const estMinutes = estimateWallMinutes(episodeCount, shotsPerEp, this.montage?.agnesKeyCount ?? 0);
    const rows = await this.prisma.$queryRawUnsafe<GateRow[]>(
      "SELECT * FROM dramas_gates WHERE dramaId = ? AND gate = 'gate1_budget'", dramaId,
    );
    const prev = rows.length ? this.parsePayload(rows[0]) : {};
    const payload = {
      ...prev,
      totalMinutes: Number(lj?.meta?.budget?.total_minutes ?? prev.totalMinutes ?? 0),
      episodeCount,
      novelChars: Number(lj?.meta?.total_chars ?? prev.novelChars ?? 0),
      kEff: Number(lj?.meta?.budget?.k_eff ?? prev.kEff ?? 0),
      epTargetSec,
      estimatedCredits: est.credits,
      estimatedShots: est.shots,
      shotsPerEpisode: shotsPerEp,
      estimatedWallMinutes: estMinutes,
      unitPrices: DEFAULT_UNIT_PRICES,
      keyCount: this.montage?.agnesKeyCount ?? 0,
      repacked: true,
      repacking: false,
      repackingAt: null,
    };
    await this.prisma.$executeRawUnsafe(
      "UPDATE dramas_gates SET payload = CAST(? AS JSON), updatedAt = NOW(3) WHERE dramaId = ? AND gate = 'gate1_budget'",
      JSON.stringify(payload), dramaId,
    );
  }

  /** 兜底:无论 beats/重排成败,都清掉门① repacking 标志,绝不把用户永久卡在门①。 */
  private async clearRepackingFlag(dramaId: bigint): Promise<void> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<GateRow[]>(
        "SELECT * FROM dramas_gates WHERE dramaId = ? AND gate = 'gate1_budget'", dramaId,
      );
      if (!rows.length) return;
    const cur = this.parsePayload(rows[0]);
    if (cur.repacking !== true) return; // 已被 refreshGate1Quote 清过
    cur.repacking = false;
    cur.repackingAt = null;
      await this.prisma.$executeRawUnsafe(
        "UPDATE dramas_gates SET payload = CAST(? AS JSON), updatedAt = NOW(3) WHERE dramaId = ? AND gate = 'gate1_budget'",
        JSON.stringify(cur), dramaId,
      );
    } catch (e: any) {
      this.logger.warn(`[repack] 清 repacking 标志失败: ${e?.message}`);
    }
  }

  /**
   * repacking 期间的 409 文案:给真实的时间预期。
   *
   * 节奏来自 2026-09-21 日志实测:beats 抽取每章一次 LLM 调用约 100 秒(主模型
   * agnes-3.0-flash 失败还要降级重试,更慢)。所以按「每章 90~120 秒」估总时长,
   * 减去 repackingAt 至今已等的时间,报「还需约 N 分钟」——比一句「稍候几秒」
   * (实际十几分钟)靠谱得多。章节数拿不到时退化为不带数字的保守文案。
   */
  private async _repackingWaitHint(
    dramaId: bigint, userId: bigint, gateRow: GateRow,
  ): Promise<string> {
    const p = this.parsePayload(gateRow);
    const startedAt = p.repackingAt ? Date.parse(String(p.repackingAt)) : NaN;
    const waitedMin = Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 60000) : 0;
    let detail = '每章约 1-2 分钟';
    try {
      const rows = await this.prisma.$queryRawUnsafe<LedgerRow[]>(
        'SELECT * FROM dramas_novel_ledger WHERE dramaId = ? AND userId = ?', dramaId, userId,
      );
      // ledgerJson 列经 Prisma 可能是对象也可能是字符串(视驱动/列类型),两种都吃
      const ljRaw = rows[0]?.ledgerJson;
      const lj: any = typeof ljRaw === 'string'
        ? (() => { try { return JSON.parse(ljRaw); } catch { return null; } })()
        : ljRaw;
      const chapters = Array.isArray(lj?.chapters) ? (lj.chapters as unknown[]).length : 0;
      if (chapters > 0) {
        const totalMin = (chapters * 105) / 60; // 每章 105 秒(实测 100s + 降级余量)
        const remainMin = Math.max(1, Math.round(totalMin - waitedMin));
        detail = `共 ${chapters} 章,已等待约 ${Math.round(waitedMin)} 分钟,预计还需约 ${remainMin} 分钟`;
      }
    } catch { /* 拿不到章节数就用保守文案,不阻断 */ }
    return `正在按章节节拍优化分集并重算报价(${detail}),请稍候再确认;完成后本提示自动消失`;
  }

  /**
   * 启动自愈:清掉**旧进程遗留**的 repacking 标志。
   *
   * 背景(2026-09-21 实测事故):后台 beats/重排任务活在后端进程内存里,
   * `nest --watch` 重启 / 进程崩溃后 `finally` 里的 clearRepackingFlag 不会跑,
   * DB 里 gate1 永远 repacking=true,decideGate 一律 409 —— 用户点「确认报价」
   * 永远得到「正在按章节节拍优化分集」,项目卡死在门①,界面没有任何逃生口。
   * sweepInterruptedStages 只扫门②/③ 的 generating,没人管门①这个标志。
   *
   * 判据用 startedAt 而不是固定超时:
   *   - 本进程启动后 ingest 的任务,repackingAt 必晚于 startedAt,绝不会被误清;
   *   - 早于 startedAt 的只可能是上个进程的遗留 —— 它已经死了,finally 永远等不到。
   * 单实例部署下零误伤;多实例下最坏是提前放行门①(用户对着旧报价拍板),
   * 也好过永久卡死。清掉时记 repackSweptAt 留痕。
   */
  async sweepStaleRepacking(now: number = Date.now()): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<GateRow[]>(
      "SELECT * FROM dramas_gates WHERE gate = 'gate1_budget'",
    );
    let swept = 0;
    for (const row of rows) {
      const p = this.parsePayload(row);
      if (p.repacking !== true) continue;
      const at = p.repackingAt ? Date.parse(String(p.repackingAt)) : 0;
      if (Number.isFinite(at) && at >= this.startedAt) continue; // 本进程自己的任务,别动
      const prevAt = p.repackingAt ?? '未知';
      p.repacking = false;
      p.repackingAt = null;
      p.repackSweptAt = new Date(now).toISOString();
      await this.prisma.$executeRawUnsafe(
        'UPDATE dramas_gates SET payload = CAST(? AS JSON), updatedAt = NOW(3) WHERE id = ?',
        JSON.stringify(p), row.id,
      );
      swept++;
      this.logger.warn(
        `[repack] 清扫陈旧 repacking 标志:剧 ${row.dramaId}(开始于 ${prevAt}),门①已放行`,
      );
    }
    return swept;
  }

  /** 启动即扫:旧进程遗留的 repacking 不放任何用户过门。失败只警告,不阻断启动。 */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const swept = await this.sweepStaleRepacking();
      if (swept > 0) {
        this.logger.warn(`[repack] 启动自愈:清理 ${swept} 个旧进程遗留的 repacking 标志`);
      }
    } catch (e: any) {
      this.logger.warn(`[repack] 启动自愈失败(不阻断启动): ${e?.message}`);
    }
    // 历史账本的欠账(单边伏笔键 / 未回填的覆盖状态)只在"重新抽 beats"时才会被修,
    // 存量剧永远修不好。启动即扫一次,不用等 5 分钟后的定时巡检。
    try {
      const r = await this.sweepLedgerDebts();
      if (r.ledgers) {
        this.logger.warn(
          `[账本自愈] 启动:修 ${r.ledgers} 份账本(清 ${r.pairsCleared} 个伏笔键,回填 ${r.beatsCovered} 个覆盖)`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[账本自愈] 启动自愈失败(不阻断启动): ${e?.message}`);
    }
  }

  /** 审批门:决策(passed/rejected)与 --auto 直通 */
  async decideGate(
    userId: bigint, dramaId: bigint, gate: string,
    decision: 'passed' | 'rejected', note?: string,
  ): Promise<unknown> {
    this.assertGateName(gate);
    const rows = await this.prisma.$queryRawUnsafe<GateRow[]>(
      'SELECT * FROM dramas_gates WHERE dramaId = ? AND gate = ?', dramaId, gate,
    );
    if (!rows.length) throw new NotFoundException('审批门不存在');
    if (rows[0].status !== 'waiting') {
      // 说清"现在能做什么" —— 只抛 ConflictException 的话,前端拿到一句
      // "已决策(rejected)" 也无从下手,用户就卡在这里了。
      throw new ConflictException(
        rows[0].status === 'rejected'
          ? `门 ${gate} 已被驳回。可先调 gates/${gate}/reopen 改回待确认,再重新决策。`
          : `门 ${gate} 已决策(${rows[0].status})`,
      );
    }
    // P2-a:门①报价可能正在被后台 beats/重排刷新,此时确认会对着旧集数/旧报价拍板。
    // 文案必须给**真实**的时间预期:2026-09-21 实测 beats 抽取每章 LLM 约 100 秒
    // (主模型失败还要降级重试),原来写「稍候几秒」用户等到天荒地老,反复白点。
    if (gate === 'gate1_budget' && this.parsePayload(rows[0]).repacking === true) {
      throw new ConflictException(await this._repackingWaitHint(dramaId, userId, rows[0]));
    }

    // 驳回时把原因一并写进 payload:reopen 之后用户还能看到自己当时为什么否掉,
    // 否则"改回待确认"会丢掉唯一一条上下文。
    const payload = decision === 'rejected'
      ? {
        ...this.parsePayload(rows[0]),
        rejectedAt: new Date().toISOString(),
        ...(note ? { rejectedNote: note } : {}),
      }
      : this.parsePayload(rows[0]);

    await this.prisma.$executeRawUnsafe(
      `UPDATE dramas_gates
         SET status = ?, decidedBy = ?, decidedAt = NOW(3), userMessage = ?,
             payload = CAST(? AS JSON), updatedAt = NOW(3)
       WHERE dramaId = ? AND gate = ?`,
      decision, userId, note ?? null, JSON.stringify(payload), dramaId, gate,
    );
    return this.getByDrama(userId, dramaId);
  }

  /**
   * 把「已驳回」的门改回 `waiting`(解除驳回)。
   *
   * 为什么必须有它(2026-09-15):`decideGate` 对非 waiting 的状态直接抛
   * `ConflictException`,而全仓库没有任何 un-reject 入口 —— 于是「驳回」实际是
   * **终态**,用户点错一次就把整部剧连同账本、已生成的设定资产一起废掉。
   * 实测剧 42 停在 gate2_design=rejected,任何界面都救不回来。
   *
   * 只允许 rejected → waiting:
   *  - waiting 幂等返回(前端可能重试);
   *  - passed 的回退是另一件事(要连带把下游阶段产物作废),语义完全不同,
   *    这里显式拒绝,避免"悄悄把已过的门退回去"造成状态错乱。
   *
   * payload **原样保留** —— 驳回时门里通常已经躺着可用产物(设定/剧本的 ready 摘要),
   * 用户"改回待确认"的常见诉求就是"我刚才点错了,让我重新决定",不该顺手把产物清掉。
   * 只追加 reopenedAt / reopenedFrom 两个审计字段。
   */
  async reopenGate(userId: bigint, dramaId: bigint, gate: string): Promise<unknown> {
    this.assertGateName(gate);
    const rows = await this.prisma.$queryRawUnsafe<GateRow[]>(
      'SELECT * FROM dramas_gates WHERE dramaId = ? AND gate = ?', dramaId, gate,
    );
    if (!rows.length) throw new NotFoundException('审批门不存在');
    const cur = rows[0];
    if (cur.status === 'waiting') return this.getByDrama(userId, dramaId); // 幂等
    if (cur.status !== 'rejected') {
      throw new ConflictException(
        `门 ${gate} 当前是 ${cur.status},只有「已驳回」可以改回待确认`,
      );
    }

    const prev = this.parsePayload(cur);
    await this.prisma.$executeRawUnsafe(
      `UPDATE dramas_gates
          SET status = 'waiting', decidedBy = NULL, decidedAt = NULL,
              userMessage = NULL,
              payload = CAST(? AS JSON), updatedAt = NOW(3)
        WHERE dramaId = ? AND gate = ?`,
      JSON.stringify({
        ...prev,
        reopenedAt: new Date().toISOString(),
        reopenedFrom: 'rejected',
        ...(prev.rejectedNote ? { rejectedNote: prev.rejectedNote } : {}),
      }),
      dramaId, gate,
    );
    this.logger.log(`[ledger] 剧 ${dramaId} 门 ${gate} 已从 rejected 改回 waiting`);
    return this.getByDrama(userId, dramaId);
  }

  /**
   * 覆写某道门的 payload(不改 status)。
   * NovelPipelineService 用它把「设定/剧本生成进度与产物摘要」写进门②③,
   * 前端轮询账本即可看到 generating → ready/failed 的推进。
   */
  async setGatePayload(dramaId: bigint, gate: string, payload: unknown): Promise<void> {
    this.assertGateName(gate);
    await this.prisma.$executeRawUnsafe(
      `UPDATE dramas_gates SET payload = CAST(? AS JSON), updatedAt = NOW(3)
        WHERE dramaId = ? AND gate = ?`,
      JSON.stringify(payload ?? {}), dramaId, gate,
    );
  }

  /**
   * 批次到达终态时,把「指向这个批次」的 producing 门一并收尾。
   *
   * 为什么需要它:门③ 通过后 pipeline 只负责把 payload 写成
   * `{state:'producing', batchUuid}`,之后批次跑完(BullMQ 那边 status=done)
   * **没有任何人回来改这个 payload** —— 门会永远停在 producing。
   * 后果有二:前端 `_stageActive` 恒为真、4s 轮询永远停不下来;
   * 门的 payload 不再反映事实,排查时看不出批次其实早就结束了。
   * 2026-09-15 剧 59 就是这样空转了近 3 小时(批次 20:14 就 done 了)。
   *
   * 只改 state 仍为 producing 的行,避免覆盖用户后续的重试/驳回结果。
   */
  async settleProducingGateForBatch(
    batchUuid: string, patch: Record<string, unknown>,
  ): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      dramaId: bigint; gate: string; payload: unknown;
    }>>(
      `SELECT dramaId, gate, payload FROM dramas_gates
        WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.batchUuid')) = ?`, batchUuid,
    );
    let settled = 0;
    for (const r of rows) {
      const cur = typeof r.payload === 'string'
        ? (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })()
        : ((r.payload as Record<string, unknown>) || {});
      if (cur?.state !== 'producing') continue;
      await this.setGatePayload(r.dramaId, r.gate, { ...cur, ...patch });
      settled++;
    }
    return settled;
  }

  /** 读单门当前状态(decideGate 之外的只读入口,pipeline 前置校验用) */
  async getGate(dramaId: bigint, gate: string): Promise<GateRow | null> {
    this.assertGateName(gate);
    const rows = await this.prisma.$queryRawUnsafe<GateRow[]>(
      'SELECT * FROM dramas_gates WHERE dramaId = ? AND gate = ?', dramaId, gate,
    );
    return rows[0] ?? null;
  }

  /** 读账本原始行(含 ledgerJson;pipeline 取集数/章节用) */
  async getLedgerRow(userId: bigint, dramaId: bigint): Promise<{ ledgerJson: any; novelSource: string; novelStorageKey: string | null; novelTitle: string; episodeCount: number }> {
    const row = await this.loadLedgerForWrite(userId, dramaId);
    return {
      ledgerJson: row.ledgerJson,
      novelSource: row.novelSource,
      novelStorageKey: row.novelStorageKey,
      novelTitle: row.novelTitle,
      episodeCount: row.episodeCount,
    };
  }

  /**
   * 未完成项目清单 —— 工作台「继续上次的项目」的唯一数据源。
   *
   * 为什么必须有它(2026-09-15):建剧之后的一切进度(_dramaUuid / _ledger / _batch)
   * 只活在 NovelDramaWorkbenchPage 的内存字段里,页面一离开或浏览器一刷新就全丢,
   * 而全 App 没有任何入口能按 dramaUuid 回到某道门上。实测后果:
   *   dramas_gates 里堆着 gate1 waiting ×25 / gate2 waiting ×28 / gate3 waiting ×30,
   *   二十几个项目停在某道门等人点「通过」,但界面上一个都打不开;
   *   用户只能重跑,同名剧被重复建出 6-7 份。
   * 服务端断点续跑其实早就齐了(gates/:gate/decide、gates/:gate/retry、
   * batches/:uuid/resume),缺的只是把 dramaUuid 重新交到前端手上。
   *
   * 判定「未完成」:该剧有账本,且
   *   ① 按 gate1_budget → gate2_design → gate3_script 顺序存在第一道未 passed 的门
   *      → 停在 currentGate,reason 取门的 status + payload.state;
   *   ② 三道门全 passed → 看最新批次:queued/running 算 producing,
   *      cancelled 算 stopped(可 resume),done 才算真完成并排除。
   *
   * 只回摘要不回 payload 全文(报价/设定/剧本产物由 /dramas/:uuid/novel/ledger 细读),
   * 否则一次列表要把几十个 JSON 大对象拖过网络。
   */
  async listActiveProjects(userId: number, limit = 20): Promise<unknown[]> {
    const ledgers = await this.prisma.$queryRawUnsafe<Array<{
      dramaId: bigint; dramaUuid: string; title: string; dramaStatus: string;
      novelSource: string; episodeCount: number; totalChars: bigint;
      ledgerStage: string; updatedAt: Date;
    }>>(
      `SELECT l.dramaId, d.uuid AS dramaUuid, d.title, d.status AS dramaStatus,
              l.novelSource, l.episodeCount, l.totalChars,
              l.stage AS ledgerStage, l.updatedAt
         FROM dramas_novel_ledger l
         JOIN \`Drama\` d ON d.id = l.dramaId
        WHERE l.userId = ?
        ORDER BY l.updatedAt DESC
        LIMIT 80`,
      userId,
    );
    if (!ledgers.length) return [];

    const ids = ledgers.map((l) => l.dramaId);
    const ph = ids.map(() => '?').join(', ');
    const gates = await this.prisma.$queryRawUnsafe<GateRow[]>(
      `SELECT id, uuid, dramaId, gate, status, payload, userMessage, decidedBy,
              decidedAt, autoMode, createdAt, updatedAt
         FROM dramas_gates WHERE dramaId IN (${ph})`,
      ...ids,
    );
    // 每部剧只看「最新一次」批次:多次重跑批次时旧批次的 done 不该盖住新批次的 running
    const batches = await this.prisma.$queryRawUnsafe<Array<{
      dramaId: bigint; uuid: string; status: string;
      fromEp: number; toEp: number; cursorEp: number; cursorStep: number;
    }>>(
      `SELECT b.dramaId, b.uuid, b.status, b.fromEp, b.toEp, b.cursorEp, b.cursorStep
         FROM dramabatch b
         JOIN (SELECT dramaId, MAX(id) AS mid FROM dramabatch
                WHERE userId = ? GROUP BY dramaId) t ON t.mid = b.id`,
      userId,
    );

    const gateByKey = new Map<string, GateRow>();
    for (const g of gates) gateByKey.set(`${String(g.dramaId)}:${g.gate}`, g);
    const batchByDrama = new Map<string, (typeof batches)[number]>();
    for (const b of batches) batchByDrama.set(String(b.dramaId), b);

    const out: unknown[] = [];
    for (const l of ledgers) {
      const key = String(l.dramaId);
      const ordered = GATE_ORDER
        .map((name) => gateByKey.get(`${key}:${name}`))
        .filter((g): g is GateRow => !!g);
      // 账本有、门没有(早期手工建账本的脏数据):没有可续的环节,跳过
      if (!ordered.length) continue;

      const open = ordered.find((g) => g.status !== 'passed');
      const batch = batchByDrama.get(key);
      let currentGate: string | null = null;
      let gateStatus: string | null = null;
      let gateState: string | null = null;
      let reason: string;

      if (open) {
        currentGate = open.gate;
        gateStatus = open.status;
        const st = this.parsePayload(open).state;
        gateState = typeof st === 'string' ? st : null;
        if (open.status === 'rejected') reason = 'rejected';
        else if (gateState === 'generating') reason = 'generating';
        else if (gateState === 'failed') reason = 'failed';
        else if (gateState === 'producing') reason = 'producing';
        else reason = 'await_decision'; // waiting 且无 state:① 报价单待确认 / ②③ 产物 ready 待过门
      } else if (!batch) {
        // 三道门都过了却没有批次:入队失败或后端版本差异,归到「生产未启动」
        currentGate = 'gate3_script';
        gateStatus = 'passed';
        reason = 'not_started';
      } else if (batch.status === 'done') {
        continue; // 真·已完成,不进未完成清单
      } else if (batch.status === 'cancelled') {
        reason = 'stopped';
      } else {
        reason = 'producing';
      }

      out.push({
        dramaUuid: l.dramaUuid,
        title: l.title,
        dramaStatus: l.dramaStatus,
        novelSource: l.novelSource,
        episodeCount: Number(l.episodeCount) || 0,
        totalChars: Number(l.totalChars) || 0,
        ledgerStage: l.ledgerStage,
        currentGate,
        gateStatus,
        gateState,
        reason,
        batch: batch
          ? {
              uuid: batch.uuid,
              status: batch.status,
              fromEp: Number(batch.fromEp),
              toEp: Number(batch.toEp),
              cursorEp: Number(batch.cursorEp),
              cursorStep: Number(batch.cursorStep),
            }
          : null,
        updatedAt: l.updatedAt,
      });
      if (out.length >= limit) break;
    }
    return jsonify(out);
  }

  /** 门 payload 容错:mysql2 的 JSON 列可能是已解析对象,也可能是字符串 */
  private parsePayload(gate: GateRow): Record<string, unknown> {
    const p = gate.payload;
    if (typeof p === 'string') {
      try {
        return JSON.parse(p) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return (p as Record<string, unknown>) || {};
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────

  private assertGateName(gate: string): void {
    if (!(GATE_ORDER as readonly string[]).includes(gate)) {
      throw new BadRequestException(`gate 必须是 ${GATE_ORDER.join('/')}`);
    }
  }

  /** 装载账本并校验归属(写路径统一入口) */
  private async loadLedgerForWrite(userId: bigint, dramaId: bigint): Promise<LedgerRow> {
    const rows = await this.prisma.$queryRawUnsafe<LedgerRow[]>(
      'SELECT * FROM dramas_novel_ledger WHERE dramaId = ? AND userId = ?', dramaId, userId,
    );
    if (!rows.length) throw new NotFoundException('该剧没有对齐账本');
    return rows[0];
  }

  /** audit_trail 行解析回 Violation 形态(含 userMessage 翻译) */
  private parseAuditLine(line: string): CheckOutcome['violations'][number] {
    // 形态:[RULE] target: message |U: userMessage
    const m = /^\[(\S+)\]\s*([^:]+):\s*(.*?)(?:\s*\|U:\s*(.*))?$/.exec(line);
    if (!m) return { rule: 'UNKNOWN', level: 'warn', target: '-', message: line };
    return { rule: m[1], level: 'warn', target: m[2].trim(), message: m[3], userMessage: m[4] };
  }

  /**
   * 本剧**已经真正生产完成**的集号集合('ep_001' 形态)。
   *
   * ⚠ 判据必须是"已完成",不能是账本里的计划分集:账本 chapters.episode_ids 记录的是
   * **打算**让哪一集拍这一章,不是"已经拍了"。给没拍的集回填 covered 就是造假 ——
   * 校验器会因此对一部还没开拍的剧报"全部覆盖",比漏报更糟。
   */
  private async producedEpisodeIds(dramaId: bigint): Promise<Map<string, string | null>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      epNo: number; step: number; status: string; hookOut: string | null;
    }>>(
      'SELECT `epNo`, `step`, `status`, `hookOut` FROM `DramaEpisode` WHERE `dramaId` = ?', dramaId,
    ).catch(() => []);
    const out = new Map<string, string | null>();
    for (const r of rows || []) {
      // step 5 = 成片完成;status done 是编排器收尾态,两者任一都算"拍出来了"
      if (String(r.status) === 'done' || Number(r.step) >= 5) {
        out.set(`ep_${String(Number(r.epNo)).padStart(3, '0')}`, r.hookOut ?? null);
      }
    }
    return out;
  }

  /**
   * 账本欠账自愈(**幂等**,可反复跑)。两类欠账都源自"只有生成流程写账本,没有收尾流程回填":
   *
   * ① 伏笔配对(I3):LLM 只给"埋伏"那一边写 foreshadow_pair,不给 reveal 一边同键 →
   *    校验器报"伏笔配对 xxx 不存在"。自愈清掉单边/同型的键。
   *    ⚠ 这个自愈原本只在**重新抽 beats** 时跑到,历史账本永远修不好
   *    (实测剧 83 的账本 v14 一直挂着 30 条 warn)。这里补上回溯。
   *
   * ② 覆盖回填(COV-1):从来没有任何流程写过"这个 beat 被第几集拍了",于是
   *    must_show beat 的 status 永远是 pending,校验器把 94 条全报成"还没安排上镜"
   *    —— 片子早就拍完了,校验器还在说没拍。这里按"已完成集 ↔ 章节"回填。
   *
   * ③ 集尾卡点(I6):账本 episodes[].cliffhanger 有时被 LLM 抽成空串,而集**实际**
   *    生成的 hookOut(`DramaEpisode.hookOut`)是有的。用真实产出回填空值 ——
   *    这不是编造,是把已经生成的东西回流到账本。
   *
   * 为什么做成定时 sweep 而不是一次性脚本:新完成的集每时每刻都在产生新的待回填数据,
   * 一次性脚本修完就过期,会退化成"要人记得去点"的手工方案。
   */
  async sweepLedgerDebts(): Promise<{
    ledgers: number; pairsCleared: number; beatsCovered: number; cliffhangersFixed: number;
  }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: bigint; dramaId: bigint; ledgerJson: any;
    }>>('SELECT `id`, `dramaId`, `ledgerJson` FROM dramas_novel_ledger');

    let ledgers = 0, pairsCleared = 0, beatsCovered = 0, cliffhangersFixed = 0;
    for (const row of rows || []) {
      let lj: any;
      try {
        lj = typeof row.ledgerJson === 'string' ? JSON.parse(row.ledgerJson) : row.ledgerJson;
      } catch { continue; }
      if (!lj || !Array.isArray(lj.beats) || !lj.beats.length) continue;

      // ① 伏笔配对自愈(复用抽取流程同一份实现,不另写一套口径)
      const rec = reconcileForeshadowPairs(lj.beats as any);
      const cleared = rec.deduped || 0;

      // ② 覆盖回填 + ③ 集尾卡点:都只认已生产完成的集
      let covered = 0, fixedHook = 0;
      const doneEps = await this.producedEpisodeIds(row.dramaId);
      // ③ cliffhanger 空 → 用真实产出的 hookOut 补
      for (const ep of lj.episodes || []) {
        if (String(ep?.cliffhanger ?? '').trim()) continue;
        const hook = doneEps.get(String(ep?.id));
        if (!hook || !String(hook).trim()) continue;
        ep.cliffhanger = hook;
        fixedHook++;
      }
      if (doneEps.size) {
        const chToEp = new Map<string, string>();
        for (const c of lj.chapters || []) {
          const hit = (c?.episode_ids || []).find((e: string) => doneEps.has(e));
          if (hit) chToEp.set(String(c.id), hit);
        }
        for (const b of lj.beats) {
          if (b?.status === 'covered' && b?.covered_by) continue; // 幂等:已回填的跳过
          const ep = chToEp.get(String(b?.chapter));
          if (!ep) continue;
          b.status = 'covered';
          b.covered_by = ep;
          covered++;
        }
      }

      if (!cleared && !covered && !fixedHook) continue; // 干净 → 不写
      lj.meta = lj.meta || {};
      lj.meta.version = Number(lj.meta.version || 0) + 1;
      await this.prisma.$executeRawUnsafe(
        'UPDATE dramas_novel_ledger SET ledgerJson = ?, ledgerVersion = ? WHERE id = ?',
        JSON.stringify(lj), lj.meta.version, row.id,
      );
      // ③ 只改 episodes(不动 beats)时投影其实没变,但仍要同步:
      //    投影是 DELETE+INSERT 全量重写,不同步会让表里 status 停在旧值。
      await this.syncBeats(row.id, lj);
      ledgers++; pairsCleared += cleared; beatsCovered += covered; cliffhangersFixed += fixedHook;
      this.logger.warn(
        `[账本自愈] 剧 ${row.dramaId}(v${lj.meta.version}):清 ${cleared} 个伏笔单边键,` +
        `回填 ${covered} 个 beat 的覆盖集,补 ${fixedHook} 个集尾卡点(已完成集 ${doneEps.size} 集)`,
      );
    }
    return { ledgers, pairsCleared, beatsCovered, cliffhangersFixed };
  }

  /** beats 投影同步:ledgerJson.beats → dramas_novel_beats(全量重写该账本的行) */
  private async syncBeats(ledgerId: bigint, ledgerJson: any): Promise<void> {
    const beats: Array<Record<string, unknown>> = ledgerJson.beats ?? [];
    const chapterNo = new Map<string, number>(
      (ledgerJson.chapters as Array<{ id: string }>).map((c, i) => [c.id, i + 1]),
    );
    await this.prisma.$queryRawUnsafe('DELETE FROM dramas_novel_beats WHERE ledgerId = ?', ledgerId);
    if (!beats.length) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const b of beats) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        ledgerId, b.id, b.chapter, chapterNo.get(String(b.chapter)) ?? 0,
        b.type, String(b.summary).slice(0, 120), String(b.quote).slice(0, 240),
        b.must_show ? 1 : 0, b.foreshadow_pair ?? null,
        b.status ?? 'pending', b.covered_by ?? null,
      );
    }
    await this.prisma.$queryRawUnsafe(
      `INSERT INTO dramas_novel_beats
         (ledgerId, beatKey, chapterKey, chapterNo, type, summary, quote, mustShow,
          foreshadowPair, status, coveredBy)
       VALUES ${placeholders.join(', ')}`,
      ...values,
    );
  }
}
