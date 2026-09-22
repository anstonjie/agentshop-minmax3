// ============================================================================
// episode-budget.ts —— 逐集「动态时长」计划(修:单集写死 120s 与原著对不齐)
// ----------------------------------------------------------------------------
// 背景(2026-09-22 定位):n2d-core 的 budget.ts 早已**按原文体量**折出
//   · 每章 `budget_sec`(对白字数÷cps + 动作字数÷charsPerBeat×beat_sec)
//   · 每集 `episodes[].budget_sec` = 该集覆盖章节的估时之和(**集集不同**)
//   · `episode_count` = 装箱结果(Σfold/ep_target 推导,非用户输入)
//   · `total_minutes` = 全书总时长
// 但生成链路 `drama.service.resolveEpTargetSec` 只读整剧一个
//   `meta.budget.ep_target_sec`(=120,本只是"装箱目标")当每集生成目标,
//   再被 step4 时长硬校准压到 120 → 内容 149s 的集被砍、内容 24s 的集被灌水。
//
// 本模块是**单一决策点**:每集生成目标 = 它自己那集的 `budget_sec`
// (夹持到柔性区间,默认 45–240s,env 可调),拿不到才回退全局/兜底 120。
// 纯函数、可单测,不碰 DB、不碰 n2d-core 口径(避免与引擎折时打架)。
// ============================================================================

/** 柔性下界:低于它一集太碎、撑不起一个叙事单元。env DRAMA_EP_MIN_SEC 覆盖。 */
export const EP_SEC_FLOOR_DEFAULT = 45;
/** 柔性上界:高于它多半是"一章没切开"的病态长集。env DRAMA_EP_MAX_SEC 覆盖。 */
export const EP_SEC_CEIL_DEFAULT = 240;
/** 既无本集估时、也无全局 ep_target_sec 时的最后兜底(历史行为)。 */
export const EP_SEC_FALLBACK = 120;

export interface EpisodeBudgetOpts {
  minSec?: number;
  maxSec?: number;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** env 优先、否则默认值;并把非法/倒挂的区间纠正回默认,免得 clamp 反向失效。 */
function bounds(opts: EpisodeBudgetOpts = {}): { min: number; max: number } {
  const envMin = num(process.env.DRAMA_EP_MIN_SEC);
  const envMax = num(process.env.DRAMA_EP_MAX_SEC);
  let min = num(opts.minSec) > 0 ? Number(opts.minSec)
    : envMin > 0 ? envMin : EP_SEC_FLOOR_DEFAULT;
  let max = num(opts.maxSec) > 0 ? Number(opts.maxSec)
    : envMax > 0 ? envMax : EP_SEC_CEIL_DEFAULT;
  if (!(max >= min)) { min = EP_SEC_FLOOR_DEFAULT; max = EP_SEC_CEIL_DEFAULT; }
  return { min, max };
}

/**
 * 把一集的内容估时收进柔性区间。
 * - 传 NaN/≤0 视为"没有估时",原样返回 0(调用方据此走回退,不在这里瞎补)。
 * - 其余四舍五入后 clamp。
 */
export function clampEpisodeSec(sec: number, opts: EpisodeBudgetOpts = {}): number {
  const s = num(sec);
  if (!Number.isFinite(s) || s <= 0) return 0;
  const { min, max } = bounds(opts);
  return Math.min(max, Math.max(min, Math.round(s)));
}

interface RawEpisode {
  id?: string;
  chapters?: string[];
  budget_sec?: number;
  actual_sec?: number | null;
}
interface RawChapter {
  id?: string;
  title?: string;
  budget_sec?: number;
  dialogue_ratio?: number;
}

/** epNo(1 基)→ 账本里的 episode 对象:先按 id `ep_00N` 精确命中,再退回数组下标。 */
export function findLedgerEpisode(ledgerJson: any, epNo: number): RawEpisode | null {
  const eps: RawEpisode[] = Array.isArray(ledgerJson?.episodes) ? ledgerJson.episodes : [];
  if (!eps.length) return null;
  const id = `ep_${String(epNo).padStart(3, '0')}`;
  const byId = eps.find((e) => String(e?.id) === id);
  if (byId) return byId;
  return eps[epNo - 1] ?? null;
}

/**
 * 解析"第 epNo 集"的生成目标时长(秒)。**取代旧的"整剧一个 120 通吃"**。
 *
 * 优先级:
 *   ① 本集内容估时 `episodes[epNo].budget_sec`(夹持到柔性区间)—— 主源
 *   ② 调用方显式入参 fromInput(手动/批次的兜底意图)—— clamp 后采用
 *   ③ 账本 `meta.budget.ep_target_sec`(装箱目标,历史值)—— clamp 后采用
 *   ④ 120 秒兜底
 *
 * 说明:① 优先意味着连集批次透传的"全局 ep_target_sec"不再压过每集内容 ——
 * 这正是用户要的效果。非原著驱动的普通剧(无 ledger/无 episodes)会落到 ②③④,
 * 行为不变,不会回归。
 */
export function resolveEpisodeTargetSec(
  ledgerJson: any, epNo: number, fromInput?: number, opts: EpisodeBudgetOpts = {},
): number {
  const perEp = clampEpisodeSec(num(findLedgerEpisode(ledgerJson, epNo)?.budget_sec), opts);
  if (perEp > 0) return perEp;
  const from = clampEpisodeSec(num(fromInput), opts);
  if (from > 0) return from;
  const globalTarget = clampEpisodeSec(num(ledgerJson?.meta?.budget?.ep_target_sec), opts);
  if (globalTarget > 0) return globalTarget;
  return EP_SEC_FALLBACK;
}

export interface PlannedEpisode {
  epNo: number;
  epId: string;
  chapterCount: number;
  chapters: Array<{ id: string; title: string; budgetSec: number; dialogueRatio: number | null }>;
  /** 该集内容原始折时(未 clamp),审计用 */
  contentSec: number;
  /** 实际生成目标(clamp 后),喂给 step0/step2 */
  genTargetSec: number;
  /** 被护栏抬上来的(内容 < min) */
  raised: boolean;
  /** 被护栏压下去的(内容 > max) */
  capped: boolean;
  /** 计划镜头数:取 step4 的 5–9s 区间中点(与 shotMin/shotMax 同口径,不与粗粒度定价混用) */
  plannedShots: number;
  shotMin: number;
  shotMax: number;
  /** 若已产出,回读到的实际成片秒数 */
  actualSec: number | null;
}

export interface EpisodePlan {
  episodeCount: number;
  totalMinutes: number;
  /** 各集内容折时之和(≈ 全书总时长,秒) */
  totalContentSec: number;
  /** 各集 clamp 后生成目标之和(实际会产出的总时长,秒) */
  totalGenSec: number;
  novelChars: number;
  /** 装箱目标(表单里选的那个"每集大概多长"),仅展示,不再强行套到每集 */
  binTargetSec: number;
  /** 生效的柔性护栏边界(回给前端展示,单一口径,避免前端重复写死 45/240) */
  minSec: number;
  maxSec: number;
  episodes: PlannedEpisode[];
}

/** 与 step4 分镜的每镜 5–9s 口径一致的镜头数区间。 */
function shotRange(genSec: number): { min: number; max: number } {
  const min = Math.max(3, Math.floor(genSec / 9));
  const max = Math.max(min + 1, Math.ceil(genSec / 5));
  return { min, max };
}

/**
 * 罗列整部剧的逐集时长计划:能出多少集、每集多长(内容 vs 实际生成)、总时长。
 * 纯读账本、不写库、无副作用。拿不到 episodes 时返回空计划(调用方据此判断"未 ingest")。
 */
export function planEpisodeBudgets(ledgerJson: any, opts: EpisodeBudgetOpts = {}): EpisodePlan {
  const lj = ledgerJson || {};
  const rawEps: RawEpisode[] = Array.isArray(lj.episodes) ? lj.episodes : [];
  const chapters: RawChapter[] = Array.isArray(lj.chapters) ? lj.chapters : [];
  const chById = new Map(chapters.map((c) => [String(c.id), c]));

  const episodes: PlannedEpisode[] = rawEps.map((e, i) => {
    const epNo = i + 1;
    const contentSec = Math.max(0, Math.round(num(e?.budget_sec) || 0));
    const genTargetSec = clampEpisodeSec(contentSec, opts) || EP_SEC_FALLBACK;
    const ids = Array.isArray(e?.chapters) ? e.chapters.map(String) : [];
    const { min, max } = bounds(opts);
    const rng = shotRange(genTargetSec);
    return {
      epNo,
      epId: String(e?.id ?? `ep_${String(epNo).padStart(3, '0')}`),
      chapterCount: ids.length,
      chapters: ids.map((cid) => {
        const c = chById.get(cid);
        return {
          id: cid,
          title: String(c?.title ?? cid),
          budgetSec: Math.max(0, Math.round(num(c?.budget_sec) || 0)),
          dialogueRatio: Number.isFinite(num(c?.dialogue_ratio)) ? Number(c!.dialogue_ratio) : null,
        };
      }),
      contentSec,
      genTargetSec,
      raised: contentSec > 0 && genTargetSec === min && contentSec < min,
      capped: contentSec > max,
      plannedShots: Math.round((rng.min + rng.max) / 2),
      shotMin: rng.min,
      shotMax: rng.max,
      actualSec: Number.isFinite(num(e?.actual_sec)) && num(e!.actual_sec!) > 0 ? Math.round(num(e!.actual_sec)) : null,
    };
  });

  const totalContentSec = episodes.reduce((s, e) => s + e.contentSec, 0);
  const totalGenSec = episodes.reduce((s, e) => s + e.genTargetSec, 0);
  const { min, max } = bounds(opts);
  return {
    episodeCount: episodes.length,
    totalMinutes: Number((num(lj?.meta?.budget?.total_minutes) > 0
      ? Number(lj.meta.budget.total_minutes) : totalContentSec / 60).toFixed(2)),
    totalContentSec,
    totalGenSec,
    novelChars: Math.max(0, Math.round(num(lj?.meta?.total_chars) || 0)),
    binTargetSec: Math.max(0, Math.round(num(lj?.meta?.budget?.ep_target_sec) || 0)),
    minSec: min,
    maxSec: max,
    episodes,
  };
}
