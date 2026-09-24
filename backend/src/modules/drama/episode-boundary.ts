// ============================================================================
// episode-boundary.ts —— P2-a 分集边界优先落叙事完整点(修根因 A)
// ----------------------------------------------------------------------------
// 诊断根因 A:n2d-core 的 binPackingEpisodes 纯按 foldSeconds 秒数装箱,边界只落章节边,
// 一个完整场景常被从中间劈到两集 → 叙事断裂。P2-a:在秒数约束内,优先把分集边界
// 落在"叙事收得住"的章节尾(该章最后一个 beat 是 turn/reveal/foreshadow,或自带钩子),
// 而不是随便哪一章够秒数就切。
//
// ⚠️ 实际装箱在**独立编译的 tool/n2d-core(dist)**,改它要重建 dist 且影响全链路,
//   风险最高,故 DRAMA_EPISODE_BOUNDARY **默认关**(=1 才启用),且本模块只做**纯顾问**
//   (给出建议边界);是否回写账本由调用方决定。注意:repackLedgerEpisodes 目前
//   **硬编码 enabled:true** 做收尾重排(见下方 planEpisodeBoundaries 调用),与本 flag
//   解耦 —— flag 只挡"纯顾问"路径。启用前务必对已有剧做前后对比验证。
// ============================================================================

export interface BoundaryChapterLike {
  id: string;
  title?: string;
  /** n2d-core fold 估时(秒) */
  budget_sec?: number;
  /** 该章最后一个 beat 的类型(有 beats 时才准;P0-a 回填后可用) */
  lastBeatType?: string;
  /** 该章是否自带集尾钩子候选 */
  hasHook?: boolean;
}

export interface BoundaryPlan {
  enabled: boolean;
  /** 建议的分集:每集是有序的 chapter id 列表 */
  episodes: string[][];
  /** 相对"纯秒数装箱"调整过的边界(落在收得住的章节尾) */
  adjustedBoundaries: number[];
  /** 拿不到叙事信号(beats 未回填)时为 true —— 此时建议退回纯秒数装箱 */
  lowConfidence: boolean;
}

/** 收得住的章节尾:这些 beat 类型天然适合当集尾卡点 */
const GOOD_ENDING_BEATS = new Set(['turn', 'reveal', 'foreshadow', 'cliffhanger', 'payoff']);

function isGoodEnding(ch: BoundaryChapterLike): boolean {
  if (ch.hasHook) return true;
  return !!ch.lastBeatType && GOOD_ENDING_BEATS.has(String(ch.lastBeatType).toLowerCase());
}

/**
 * 规划分集边界。enabled=false(默认)→ 空计划,调用方沿用 n2d-core 的纯秒数装箱。
 * enabled=true → 贪心装箱到 epTargetSec,但在关闭一集时:若当前章不是"收得住的尾"
 * 且再加一章不显著超时(≤tolerance),则延后到下一个收得住的章尾再切。
 * 没有任何叙事信号(beats 未回填 / 无 hasHook)→ lowConfidence=true,建议退回现状。
 */
export function planEpisodeBoundaries(
  chapters: BoundaryChapterLike[],
  opts?: { enabled?: boolean; epTargetSec?: number; tolerance?: number },
): BoundaryPlan {
  const list = Array.isArray(chapters) ? chapters : [];
  const enabled = !!opts?.enabled;
  const target = Number(opts?.epTargetSec) > 0 ? Number(opts.epTargetSec) : 120;
  const tolerance = Number(opts?.tolerance) > 0 ? Number(opts.tolerance) : 0.25;

  const hasSignal = list.some((c) => c.hasHook || c.lastBeatType);
  if (!enabled || list.length < 2) {
    return { enabled, episodes: [], adjustedBoundaries: [], lowConfidence: !hasSignal };
  }

  const sec = (c: BoundaryChapterLike) => (Number(c.budget_sec) > 0 ? Number(c.budget_sec) : 0);
  const episodes: string[][] = [];
  const adjustedBoundaries: number[] = [];
  let cur: string[] = [];
  let curSec = 0;

  const hardCap = target * (1 + tolerance);
  const softTarget = target * (1 - tolerance);
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    // 硬顶前置守卫(修真实数据暴露的 over-stuff):当前集非空且加入本章会超硬顶 → 先切,
    //   绝不把单集撑爆。n2d-core 原装箱也是"加之前先判",此处对齐,避免"小+小+大章"撑出 177s 的集。
    if (cur.length && curSec + sec(ch) > hardCap) {
      episodes.push(cur); adjustedBoundaries.push(i - 1); cur = []; curSec = 0;
    }
    cur.push(ch.id);
    curSec += sec(ch);
    const isLast = i === list.length - 1;
    if (isLast) { episodes.push(cur); cur = []; curSec = 0; break; }
    if (curSec < softTarget) continue; // 未到软目标,继续装

    // 到点了:优先在"收得住的章尾"切
    if (isGoodEnding(ch)) {
      episodes.push(cur); cur = []; curSec = 0;
      adjustedBoundaries.push(i);
      continue;
    }
    // 当前章收不住:下一章加进来不超硬顶就延后一章再找收得住的尾,否则在此切
    const next = list[i + 1];
    if (next && curSec + sec(next) <= hardCap) continue;
    episodes.push(cur); cur = []; curSec = 0;
    adjustedBoundaries.push(i);
  }
  if (cur.length) episodes.push(cur);

  return { enabled, episodes, adjustedBoundaries, lowConfidence: !hasSignal };
}

/** 从 beats 投影算每章的"收尾信号":最后一拍的类型 + 是否适合当集尾。 */
export interface ChapterEndingHint {
  lastBeatType: string;
  hasHook: boolean;
  /** 2026-09-16(批2):最后一拍的 summary —— repack 改边界后回填 hook/cliffhanger 文本用 */
  lastBeatSummary: string;
}

/**
 * beats(逐字锚点,P0-a 回填)→ 每章收尾信号。
 * 取该章"最后一拍"(按 beat.id 的 -bN 序号,取不到序号则按数组顺序)的 type;
 * type ∈ 收得住集合(turn/reveal/foreshadow/cliffhanger/payoff)→ hasHook=true。
 * 纯函数,可单测。没有 beats 的章节不进 Map(视为无信号)。
 */
export function chapterGoodEndingHints(
  beats: Array<{ id?: string; chapter?: string; type?: string; summary?: string }>,
): Map<string, ChapterEndingHint> {
  const byChapter = new Map<string, Array<{ order: number; type: string; summary: string }>>();
  (Array.isArray(beats) ? beats : []).forEach((b, i) => {
    const cid = String(b?.chapter ?? '');
    if (!cid) return;
    // id 形如 `${chapter}-b${n}`,用 n 定序;取不到则用数组下标
    const m = /-b(\d+)$/.exec(String(b?.id ?? ''));
    const order = m ? Number(m[1]) : i;
    const arr = byChapter.get(cid) || [];
    arr.push({
      order,
      type: String(b?.type ?? '').toLowerCase(),
      summary: String(b?.summary ?? '').trim(),
    });
    byChapter.set(cid, arr);
  });
  const hints = new Map<string, ChapterEndingHint>();
  for (const [cid, arr] of byChapter) {
    if (!arr.length) continue;
    arr.sort((a, b) => a.order - b.order);
    const last = arr[arr.length - 1];
    hints.set(cid, {
      lastBeatType: last.type,
      hasHook: GOOD_ENDING_BEATS.has(last.type),
      lastBeatSummary: last.summary,
    });
  }
  return hints;
}

export interface RepackResult {
  changed: boolean;
  reason?: string;
  ledgerJson: any;
  fromEpisodeCount: number;
  toEpisodeCount: number;
}

/**
 * 用 beats 收尾信号重排 ledgerJson.episodes(装箱改造),偏好把集边界落在收得住的章尾。
 * 安全护栏(任一不满足 → changed:false,保留原装箱):
 *   ① 无叙事信号(lowConfidence);② 重排后未覆盖全部章节;③ 集数漂移超出 [0.6×, 1.6×] 原集数。
 * 不改动入参对象(拷贝 episodes/chapters/meta 后返回新 ledgerJson)。
 */
export function repackLedgerEpisodes(
  ledgerJson: any, hints: Map<string, ChapterEndingHint>, epTargetSec: number,
): RepackResult {
  const lj = ledgerJson || {};
  const chapters: any[] = Array.isArray(lj.chapters) ? lj.chapters : [];
  const oldEpisodes: any[] = Array.isArray(lj.episodes) ? lj.episodes : [];
  const from = oldEpisodes.length;
  const base: RepackResult = { changed: false, ledgerJson: lj, fromEpisodeCount: from, toEpisodeCount: from };

  if (!chapters.length || !from) return { ...base, reason: 'NO_CHAPTERS_OR_EPISODES' };

  const boundaryChapters: BoundaryChapterLike[] = chapters.map((c) => {
    const h = hints.get(String(c.id));
    return {
      id: String(c.id), title: c.title, budget_sec: Number(c.budget_sec) || 0,
      lastBeatType: h?.lastBeatType, hasHook: h?.hasHook,
    };
  });
  const plan = planEpisodeBoundaries(boundaryChapters, { enabled: true, epTargetSec });
  if (plan.lowConfidence) return { ...base, reason: 'LOW_CONFIDENCE_NO_BEAT_SIGNAL' };

  // 护栏②:覆盖全部章节、不重不漏
  const flat = plan.episodes.flat();
  const allIds = chapters.map((c) => String(c.id));
  if (flat.length !== allIds.length || new Set(flat).size !== new Set(allIds).size) {
    return { ...base, reason: 'COVERAGE_MISMATCH' };
  }
  // 护栏③:集数漂移过大(报价/门①会失真)→ 保留原装箱
  const to = plan.episodes.length;
  if (to < Math.ceil(from * 0.6) || to > Math.floor(from * 1.6)) {
    return { ...base, toEpisodeCount: to, reason: 'EPISODE_COUNT_DRIFT' };
  }

  // 重排:拷贝 chapters(重置 episode_ids)+ 重建 episodes + 更新 meta.budget
  const secById = new Map(chapters.map((c) => [String(c.id), Number(c.budget_sec) || 0]));
  const newChapters = chapters.map((c) => ({ ...c, episode_ids: [] as string[] }));
  const chById = new Map(newChapters.map((c) => [String(c.id), c]));
  const newEpisodes = plan.episodes.map((group, i) => {
    const id = `ep_${String(i + 1).padStart(3, '0')}`;
    const budget = group.reduce((s, cid) => s + (secById.get(String(cid)) || 0), 0);
    for (const cid of group) chById.get(String(cid))?.episode_ids.push(id);
    // 保留原同章集合的 hook/cliffhanger(若边界没动);
    // 2026-09-16(批2)边界动了不再置空 —— 用本组末章的收尾拍 summary 回填 hook,
    //   hasHook 时再给 cliffhanger 提示(诊断:重排后置空无回填,逐集承接断一环)。
    const old = oldEpisodes.find((e) =>
      Array.isArray(e.chapters) && e.chapters.length === group.length
      && e.chapters.every((c: string, j: number) => String(c) === String(group[j])));
    const lastHint = hints.get(String(group[group.length - 1] || ''));
    const hookText = old?.hook || lastHint?.lastBeatSummary || '';
    const cliffText = old?.cliffhanger
      || (lastHint?.hasHook
        ? (lastHint.lastBeatSummary || `章尾拍类型=${lastHint.lastBeatType},可作结尾钩子`)
        : '');
    return {
      id, chapters: group.map(String), budget_sec: budget,
      hook: hookText, cliffhanger: cliffText,
      status: 'pending', actual_sec: null,
    };
  });

  const totalSec = newEpisodes.reduce((s, e) => s + e.budget_sec, 0);
  const newLj = {
    ...lj,
    chapters: newChapters,
    episodes: newEpisodes,
    meta: {
      ...(lj.meta || {}),
      budget: {
        ...(lj.meta?.budget || {}),
        episode_count: to,
        total_minutes: Number((totalSec / 60).toFixed(2)),
      },
    },
  };
  return { changed: true, ledgerJson: newLj, fromEpisodeCount: from, toEpisodeCount: to };
}
