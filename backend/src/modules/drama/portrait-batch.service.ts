// ============================================================================
// PortraitBatchService —— 剧级「批量定妆」跑批器
// ----------------------------------------------------------------------------
// 补的是 2026-09-15 之前的一条断链:定妆图只有单资产接口
//   POST /api/dramas/:uuid/assets/:id/portrait
// 而且那颗按钮藏在资产卡片详情抽屉的最底部(要点头部卡片 → 弹抽屉 → 往下滚过
// 参考视图/锚定描述/来源/变体/引用才看得见)。门②「确认设定」通过后,12 项资产
// 意味着 12 次同样的操作,实测没人找得到入口 —— 于是直接进生产,关键帧退化成
// 纯文生图,主角跨镜换脸。
//
// 这里把它变成一次动作:
//   · 门② 通过时由 NovelPipelineService 自动开跑(trigger='gate2')
//   · 资产库顶部「一键定妆剩余 N 项」手动补跑(trigger='manual')
//
// 为什么是进程内后台任务而不是 BullMQ:
//   连集批次要队列,是因为一批能跑几十分钟到几小时、且有逐集逐步的游标语义。
//   定妆一批是分钟级,而且**状态天然幂等** —— generatePortrait 默认增量,
//   已成功的资产与角度直接复用不重烧配额。所以进程重启后只要把 DB 里
//   status='running' 的孤儿重新开一遍就是正确行为,不需要游标,也不会双烧。
//   为此 onApplicationBootstrap 做自愈扫描。
//
// 三条硬约束:
//  1. **单资产失败不拖垮整批**:逐项 try/catch,失败原因原样写进 items[].error,
//     前端要能点开看到具体是哪一项、为什么挂(用户验收口径)。
//  2. **不重跑已定妆的**:判据与前端 `_hasRefImage`、后端 `refAssetIndex` 逐字对齐
//     —— alive !== false 且 url/remoteUrl 非空。锁定资产跳过(它明确拒绝被自动流程覆盖)。
//  3. **进度必须落库**:每个状态迁移都写 Drama.portraitBatch,刷新页面/换端都能
//     接着看到 x/N,而不是只剩一个转圈。
// ============================================================================

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DramaService } from './drama.service';

export type PortraitItemState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface PortraitItem {
  assetId: number;
  name: string;
  kind: string;
  state: PortraitItemState;
  /** 成功时已可用的参考视图张数(角色四视图 / 场景道具单图) */
  views?: number;
  /** 失败 / 跳过原因,前端直接展示,不做二次包装 */
  error?: string;
}

export interface PortraitBatchState {
  status: 'idle' | 'running' | 'done' | 'failed';
  trigger?: 'gate2' | 'manual';
  total: number;
  done: number;
  failed: number;
  /** 锁定 / 停用而被跳过的项数;不计入 done/failed,否则进度条会卡在 x/N */
  skipped: number;
  startedAt?: string;
  /** 由 JS 写的真 UTC,前端算「多久没动」只认这个字段,不认 DB updatedAt */
  progressAt?: string;
  finishedAt?: string;
  items: PortraitItem[];
}

/** 同时定妆的资产数:每项内部已按角度并行 + 多 key 轮询,再放大就会撞上游图像队列限流 */
const ASSET_CONCURRENCY = 2;

/** 空状态常量(从未跑过批量定妆的剧) */
export const IDLE_STATE: PortraitBatchState = {
  status: 'idle', total: 0, done: 0, failed: 0, skipped: 0, items: [],
};

// ── 纯函数(可单测) ──────────────────────────────────────────────────────

/** 一张参考视图是否真的可用:没被标死且至少有一个地址 */
export function refUsable(r: any): boolean {
  if (!r || typeof r !== 'object') return false;
  if (r.alive === false) return false;
  return !!(String(r.url || '') || String(r.remoteUrl || ''));
}

/** 资产是否已定妆(与前端 _hasRefImage / 后端 refAssetIndex 同一判据) */
export function assetHasPortrait(refs: any): boolean {
  return Array.isArray(refs) && refs.some((r) => refUsable(r));
}

/** 已定妆资产里可用的视图张数 */
export function usableViewCount(refs: any): number {
  return Array.isArray(refs) ? refs.filter((r: any) => refUsable(r)).length : 0;
}

/**
 * 是否该跳过这项资产。
 * deprecated 是软删,不该再烧图;locked 是用户明确「这张脸别动」,
 * 后端 generatePortrait 对它直接 409,提前跳过后原因写得比 409 清楚。
 */
export function shouldSkipAsset(a: { status?: string; locked?: any }): string | null {
  if (String(a.status || '') === 'deprecated') return '资产已停用';
  if (a.locked === true || Number(a.locked) === 1) return '资产已锁定(需先解锁)';
  return null;
}

/** 把 DB 里可能是字符串/对象/null 的 portraitBatch 归一成状态对象 */
export function parsePortraitBatch(raw: unknown): PortraitBatchState {
  let v: any = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { ...IDLE_STATE }; }
  }
  if (!v || typeof v !== 'object') return { ...IDLE_STATE };
  const items = Array.isArray(v.items)
    ? v.items.filter((x: any) => x && typeof x === 'object').map((x: any) => ({
        assetId: Number(x.assetId) || 0,
        name: String(x.name || ''),
        kind: String(x.kind || ''),
        state: (['pending', 'running', 'ok', 'failed', 'skipped'].includes(x.state)
          ? x.state : 'pending') as PortraitItemState,
        ...(Number.isFinite(Number(x.views)) ? { views: Number(x.views) } : {}),
        ...(x.error ? { error: String(x.error).slice(0, 300) } : {}),
      }))
    : [];
  const status = (['running', 'done', 'failed'].includes(v.status) ? v.status : 'idle') as PortraitBatchState['status'];
  return {
    status,
    ...(v.trigger ? { trigger: v.trigger === 'gate2' ? 'gate2' : 'manual' } : {}),
    total: Number(v.total) || 0,
    done: Number(v.done) || 0,
    failed: Number(v.failed) || 0,
    skipped: Number(v.skipped) || 0,
    ...(v.startedAt ? { startedAt: String(v.startedAt) } : {}),
    ...(v.progressAt ? { progressAt: String(v.progressAt) } : {}),
    ...(v.finishedAt ? { finishedAt: String(v.finishedAt) } : {}),
    items,
  };
}

// ── 服务 ──────────────────────────────────────────────────────────────────

interface DramaRow {
  id: bigint; uuid: string; portraitBatch?: unknown;
}
interface AssetRow {
  id: bigint; name: string; kind: string; refs: unknown;
  status: string; locked: number | boolean;
}

@Injectable()
export class PortraitBatchService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PortraitBatchService.name);
  /** 本进程在跑的剧(dramaUuid),防双跑;也是判断 DB 里 running 是不是孤儿的依据 */
  private readonly running = new Set<string>();
  /** 后台跑批的 promise,供测试与优雅停机等待(不在跑时 waitUntilSettled 立即返回) */
  private readonly runPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: DramaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.resumeOrphans().catch((e: any) =>
      this.logger.warn(`[portrait] 孤儿批次自愈失败(不影响启动): ${e?.message}`));
  }

  /**
   * 启动自愈:上一轮进程被 kill 时留在 running 的批次重新开一遍。
   * 单机部署下,进程刚起来时不可能有自己的批在跑,所以任何 running 都是孤儿。
   * 重开是安全的 —— 已定妆好的资产会被判据过滤掉,剩余的走增量补图。
   */
  async resumeOrphans(): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ uuid: string }[]>(
      `SELECT \`uuid\` FROM \`Drama\`
        WHERE JSON_UNQUOTE(JSON_EXTRACT(\`portraitBatch\`, '$.status')) = 'running'
        LIMIT 50`,
    );
    if (!rows.length) return 0;
    this.logger.warn(`[portrait] 发现 ${rows.length} 个中断的批量定妆,重新开跑(增量补图)`);
    for (const r of rows) {
      try {
        await this.start(r.uuid, 'manual');
      } catch (e: any) {
        this.logger.warn(`[portrait] 续跑失败 ${r.uuid}: ${e?.message}`);
      }
    }
    return rows.length;
  }

  /** 读当前批量定妆状态(从未跑过 → idle) */
  async getState(dramaUuid: string): Promise<PortraitBatchState> {
    const drama = await this.findDrama(dramaUuid);
    const st = parsePortraitBatch(drama?.portraitBatch);
    // 诚实化:DB 说 running 但本进程没在跑(且刚启动自愈也没接住),
    // 说明执行者已经没了 —— 报 interrupted 而不是让前端无限转圈。
    if (st.status === 'running' && !this.running.has(dramaUuid)) {
      const staleMs = this.staleMs(st.progressAt);
      if (staleMs > 5 * 60_000) {
        return {
          ...st,
          status: 'failed',
          items: st.items.map((i) => (i.state === 'running' || i.state === 'pending'
            ? { ...i, state: 'failed' as PortraitItemState, error: i.error || '定妆中断:后端进程被重启' }
            : i)),
        };
      }
    }
    return st;
  }

  /**
   * 开跑一批定妆。已在跑就直接回现状(幂等,不重复烧配额)。
   * 没有待定妆资产时写一个 done(total:0),让前端能明确显示「都已定妆」。
   */
  async start(dramaUuid: string, trigger: 'gate2' | 'manual' = 'manual'): Promise<PortraitBatchState> {
    const drama = await this.findDrama(dramaUuid);
    if (!drama) throw new Error(`剧集不存在: ${dramaUuid}`);
    if (this.running.has(dramaUuid)) {
      this.logger.log(`[portrait] ${dramaUuid} 批量定妆已在运行,跳过重复启动`);
      return parsePortraitBatch(drama.portraitBatch);
    }

    const assets = await this.candidates(drama.id);
    if (!assets.length) {
      const state: PortraitBatchState = {
        status: 'done', trigger, total: 0, done: 0, failed: 0, skipped: 0, items: [],
        startedAt: new Date().toISOString(),
        progressAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await this.save(drama.id, state);
      this.logger.log(`[portrait] ${dramaUuid} 没有待定妆的资产,直接标记完成`);
      return state;
    }

    const items: PortraitItem[] = assets.map((a) => {
      const skip = shouldSkipAsset({ status: a.status, locked: a.locked });
      return {
        assetId: Number(a.id), name: a.name, kind: a.kind,
        state: (skip ? 'skipped' : 'pending') as PortraitItemState,
        ...(skip ? { error: skip } : {}),
      };
    });
    const runnable = items.filter((i) => i.state === 'pending');
    if (!runnable.length) {
      const state: PortraitBatchState = {
        status: 'done', trigger, total: items.length, done: 0,
        failed: 0, skipped: items.filter((i) => i.state === 'skipped').length, items,
        startedAt: new Date().toISOString(),
        progressAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await this.save(drama.id, state);
      return state;
    }

    const now = new Date().toISOString();
    const state: PortraitBatchState = {
      status: 'running', trigger, total: items.length, done: 0, failed: 0,
      skipped: items.length - runnable.length, items,
      startedAt: now, progressAt: now,
    };
    await this.save(drama.id, state);

    this.running.add(dramaUuid);
    // 不在 runPromise 内部 catch:await 一个已 settle 且被 catch 处理过的 promise
    // 会把续体排进微任务队列,而 finally 里的 map.delete 在它之后才执行 ——
    // waitUntilSettled 于是会重新 await 同一个 promise 并永远挂住。
    // 异常统一在下面 .catch 里记日志,语义与原先一致。
    const runPromise = this.run(drama.id, dramaUuid, state)
      .finally(() => {
        this.running.delete(dramaUuid);
        this.runPromises.delete(dramaUuid);
      });
    this.runPromises.set(dramaUuid, runPromise);
    runPromise.catch((e: any) =>
      this.logger.error(`[portrait] ${dramaUuid} 批量定妆异常: ${e?.message}`));

    this.logger.log(
      `[portrait] ${dramaUuid} 批量定妆已开跑:${runnable.length} 项(共 ${items.length} 项,trigger=${trigger})`,
    );
    return state;
  }

  /** 门②通过后调用:失败绝不影响剧本阶段 */
  async startForGate2Pass(dramaUuid: string): Promise<void> {
    try {
      await this.start(dramaUuid, 'gate2');
    } catch (e: any) {
      this.logger.warn(`[portrait] ${dramaUuid} 自动定妆未能启动: ${e?.message}`);
    }
  }

  /** 本进程是否正在跑该剧的批量定妆 */
  isRunning(dramaUuid: string): boolean {
    return this.running.has(dramaUuid);
  }

  /** 等本批跑完(回归测试 / 优雅停机用);本进程没在跑则立即返回 */
  async waitUntilSettled(dramaUuid: string): Promise<void> {
    const p = this.runPromises.get(dramaUuid);
    if (p) await p;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private async run(dramaId: bigint, dramaUuid: string, state: PortraitBatchState): Promise<void> {
    const queue = state.items.filter((i) => i.state === 'pending');
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        item.state = 'running';
        await this.save(dramaId, state);
        try {
          const asset: any = await this.svc.generatePortrait(dramaUuid, String(item.assetId));
          const refs = Array.isArray(asset?.refs) ? asset.refs : [];
          item.views = usableViewCount(refs);
          item.state = item.views > 0 ? 'ok' : 'failed';
          if (item.views === 0) item.error = '生成完成但没有可用的参考图,可重试';
        } catch (e: any) {
          const msg = (e?.message || String(e)).slice(0, 300);
          // generatePortrait 对锁定资产抛 409,那是「按预期跳过」而不是失败
          item.state = /已锁定/.test(msg) ? 'skipped' : 'failed';
          item.error = msg;
          this.logger.warn(`[portrait] ${dramaUuid} 「${item.name}」定妆失败: ${msg}`);
        }
        this.recount(state);
        await this.save(dramaId, state);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ASSET_CONCURRENCY, queue.length) }, () => worker()),
    );

    state.status = state.done === 0 && state.failed > 0 ? 'failed' : 'done';
    const at = new Date().toISOString();
    state.progressAt = at;
    state.finishedAt = at;
    await this.save(dramaId, state);
    this.logger.log(
      `[portrait] ${dramaUuid} 批量定妆收尾:${state.status} 成功 ${state.done} / 失败 ${state.failed} / 跳过 ${state.skipped}`,
    );
  }

  private recount(state: PortraitBatchState): void {
    state.done = state.items.filter((i) => i.state === 'ok').length;
    state.failed = state.items.filter((i) => i.state === 'failed').length;
    state.skipped = state.items.filter((i) => i.state === 'skipped').length;
    state.progressAt = new Date().toISOString();
  }

  /** 待定妆资产:非软删、非锁定、refs 里没有可用图 */
  private async candidates(dramaId: bigint): Promise<AssetRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT \`id\`, \`name\`, \`kind\`, \`refs\`, \`status\`, \`locked\`
         FROM \`DramaAsset\` WHERE \`dramaId\` = ?
        ORDER BY \`kind\` ASC, \`useCount\` DESC, \`id\` ASC`, dramaId,
    );
    return (rows || []).filter((r) => {
      const refs = this.parseJson(r.refs, []);
      // 2026-09-16(批4):跑批 = 定妆补齐 + 质检补齐。已有图但**从没跑过视觉质检门**
      //   (任何 alive ref 上都没有 qc 判定、也没有通道降级戳)的资产也进 pending ——
      //   generatePortrait 增量复用不会重画,但质检门会重检旧图并打标/自动重画,
      //   存量坏图(多条胳膊等)下次跑批即被标出。否则"全定妆"的剧跑批 total=0,
      //   QC 永远没机会跑(实测 drama77 十一资产全 dressed,旧逻辑直接空跑)。
      if (!assetHasPortrait(refs)) return true;
      const list = Array.isArray(refs) ? refs : [];
      return !list.some(
        (x: any) => x && x.alive !== false
          && ((x.qc && typeof x.qc === 'object') || typeof x.qcSkipped === 'string'),
      );
    });
  }

  private async findDrama(uuid: string): Promise<DramaRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<DramaRow[]>(
      'SELECT `id`, `uuid`, `portraitBatch` FROM `Drama` WHERE `uuid` = ? LIMIT 1', uuid,
    );
    return rows[0] || null;
  }

  private async save(dramaId: bigint, state: PortraitBatchState): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        'UPDATE `Drama` SET `portraitBatch` = CAST(? AS JSON), `updatedAt` = CURRENT_TIMESTAMP(3) WHERE `id` = ?',
        JSON.stringify(state), dramaId,
      );
    } catch (e: any) {
      // 进度写库失败不该中断跑批(图已经烧了),但必须留痕
      this.logger.warn(`[portrait] 进度落库失败: ${e?.message}`);
    }
  }

  private staleMs(progressAt?: string): number {
    if (!progressAt) return Number.MAX_SAFE_INTEGER;
    const t = Date.parse(progressAt);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Number.MAX_SAFE_INTEGER;
  }

  private parseJson(raw: unknown, fallback: any): any {
    if (raw == null) return fallback;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch { return fallback; }
  }
}
