// ============================================================================
// episode-budget 单测 —— 逐集"动态时长"是替代"整剧写死 120s"的唯一决策点,
// clamp / 回退优先级 / 罗列口径都必须钉死(改默认行为,回归代价高)。
// ============================================================================
import {
  clampEpisodeSec, resolveEpisodeTargetSec, planEpisodeBudgets, findLedgerEpisode,
  EP_SEC_FLOOR_DEFAULT, EP_SEC_CEIL_DEFAULT, EP_SEC_FALLBACK,
} from './episode-budget';

/** 造一份最小账本:2 集,集 1 覆盖 ch1+ch2(内容 149s),集 2 只 ch3(内容 24s) */
function ledger(over: any = {}) {
  return {
    meta: { total_chars: 7619, budget: { total_minutes: 2.88, ep_target_sec: 120, k_eff: 20.9 } },
    chapters: [
      { id: 'ch_001', title: '第一章', budget_sec: 19, dialogue_ratio: 0.3 },
      { id: 'ch_002', title: '第二章', budget_sec: 130, dialogue_ratio: 0.42 },
      { id: 'ch_003', title: '第三章', budget_sec: 24, dialogue_ratio: 0.1 },
    ],
    episodes: [
      { id: 'ep_001', chapters: ['ch_001', 'ch_002'], budget_sec: 149, status: 'pending', actual_sec: null },
      { id: 'ep_002', chapters: ['ch_003'], budget_sec: 24, status: 'pending', actual_sec: null },
    ],
    ...over,
  };
}

describe('clampEpisodeSec —— 柔性区间(默认 45–240)', () => {
  it('区间内原样返回(四舍五入)', () => {
    expect(clampEpisodeSec(120)).toBe(120);
    expect(clampEpisodeSec(149.4)).toBe(149);
  });
  it('低于下界抬到 min,高于上界压到 max', () => {
    expect(clampEpisodeSec(20)).toBe(EP_SEC_FLOOR_DEFAULT);
    expect(clampEpisodeSec(500)).toBe(EP_SEC_CEIL_DEFAULT);
  });
  it('0/负/NaN 视为"无估时",返回 0 让调用方走回退', () => {
    expect(clampEpisodeSec(0)).toBe(0);
    expect(clampEpisodeSec(-30)).toBe(0);
    expect(clampEpisodeSec(NaN)).toBe(0);
  });
  it('显式 opts 覆盖边界', () => {
    expect(clampEpisodeSec(300, { maxSec: 300 })).toBe(300);
    expect(clampEpisodeSec(10, { minSec: 60 })).toBe(60);
  });
  it('env 可调护栏(测后还原)', () => {
    const oldMin = process.env.DRAMA_EP_MIN_SEC, oldMax = process.env.DRAMA_EP_MAX_SEC;
    process.env.DRAMA_EP_MIN_SEC = '60'; process.env.DRAMA_EP_MAX_SEC = '360';
    try {
      expect(clampEpisodeSec(50)).toBe(60);
      expect(clampEpisodeSec(400)).toBe(360);
    } finally {
      if (oldMin === undefined) delete process.env.DRAMA_EP_MIN_SEC; else process.env.DRAMA_EP_MIN_SEC = oldMin;
      if (oldMax === undefined) delete process.env.DRAMA_EP_MAX_SEC; else process.env.DRAMA_EP_MAX_SEC = oldMax;
    }
  });
});

describe('findLedgerEpisode —— epNo 优先按 id 命中,再退数组下标', () => {
  it('id 精确命中优先', () => {
    expect(findLedgerEpisode(ledger(), 2)?.budget_sec).toBe(24);
  });
  it('id 缺失时按 episodes[epNo-1]', () => {
    const lj = ledger();
    lj.episodes.forEach((e: any) => delete e.id);
    expect(findLedgerEpisode(lj, 1)?.budget_sec).toBe(149);
  });
  it('越界/无账本返回 null', () => {
    expect(findLedgerEpisode(ledger(), 99)).toBeNull();
    expect(findLedgerEpisode(null, 1)).toBeNull();
  });
});

describe('resolveEpisodeTargetSec —— 每集走自己内容估时,不再写死 120', () => {
  it('① 主源:本集 budget_sec 落在区间内就用它', () => {
    expect(resolveEpisodeTargetSec(ledger(), 1, undefined)).toBe(149);
  });
  it('本集太短(24s)被抬到 floor 45', () => {
    expect(resolveEpisodeTargetSec(ledger(), 2, undefined)).toBe(EP_SEC_FLOOR_DEFAULT);
  });
  it('本集超长(300s)被压到 ceil 240', () => {
    const lj = ledger();
    lj.episodes[0].budget_sec = 300;
    expect(resolveEpisodeTargetSec(lj, 1, undefined)).toBe(EP_SEC_CEIL_DEFAULT);
  });
  it('② 无本集估时 → 用调用方入参(批次全局值退居次位)', () => {
    expect(resolveEpisodeTargetSec(null, 1, 90)).toBe(90);
    const emptyEps = { meta: { budget: {} }, episodes: [] };
    expect(resolveEpisodeTargetSec(emptyEps, 1, 90)).toBe(90);
  });
  it('③ 无本集估时也无入参 → 回退账本 meta.budget.ep_target_sec', () => {
    const noEps = { meta: { budget: { ep_target_sec: 180 } }, episodes: [] };
    expect(resolveEpisodeTargetSec(noEps, 1, undefined)).toBe(180);
  });
  it('④ 什么都没有 → 120 兜底(历史行为)', () => {
    expect(resolveEpisodeTargetSec(null, 1, undefined)).toBe(EP_SEC_FALLBACK);
    expect(resolveEpisodeTargetSec(undefined, 1, 0)).toBe(EP_SEC_FALLBACK);
  });
  it('入参超区间也会被 clamp(不让批次把某集顶到 500s)', () => {
    expect(resolveEpisodeTargetSec({ episodes: [] }, 1, 500)).toBe(EP_SEC_CEIL_DEFAULT);
  });
});

describe('planEpisodeBudgets —— 罗列逐集计划', () => {
  it('空/无账本 → 空计划,计数为 0', () => {
    expect(planEpisodeBudgets(null).episodeCount).toBe(0);
    expect(planEpisodeBudgets({}).episodes).toEqual([]);
  });
  it('逐集给出 contentSec(原文折时) 与 genTargetSec(clamp 后),并标注抬/压', () => {
    const p = planEpisodeBudgets(ledger());
    expect(p.episodeCount).toBe(2);
    const [e1, e2] = p.episodes;
    expect(e1).toMatchObject({ epNo: 1, contentSec: 149, genTargetSec: 149, raised: false, capped: false, chapterCount: 2 });
    expect(e2).toMatchObject({ epNo: 2, contentSec: 24, genTargetSec: EP_SEC_FLOOR_DEFAULT, raised: true, capped: false });
    // 镜头数与时长同向,且给了 step4 的 5–9s 区间
    expect(e1.plannedShots).toBeGreaterThanOrEqual(e2.plannedShots);
    expect(e1.shotMin).toBeLessThanOrEqual(e1.plannedShots);
    expect(e1.shotMax).toBeGreaterThanOrEqual(e1.plannedShots);
  });
  it('总计:内容折时之和 vs 实际生成目标之和分列;总时长取账本 total_minutes', () => {
    const p = planEpisodeBudgets(ledger());
    expect(p.totalContentSec).toBe(149 + 24);
    expect(p.totalGenSec).toBe(149 + EP_SEC_FLOOR_DEFAULT); // 短集被抬
    expect(p.totalMinutes).toBe(2.88);
    expect(p.novelChars).toBe(7619);
    expect(p.binTargetSec).toBe(120);
  });
  it('章节明细带回 title + 对白占比;缺 chapter 记录也不炸', () => {
    const p = planEpisodeBudgets(ledger());
    expect(p.episodes[0].chapters[1]).toEqual({ id: 'ch_002', title: '第二章', budgetSec: 130, dialogueRatio: 0.42 });
    const orphan = ledger();
    orphan.episodes[1].chapters = ['ch_missing'];
    expect(() => planEpisodeBudgets(orphan)).not.toThrow();
    expect(planEpisodeBudgets(orphan).episodes[1].chapters[0].title).toBe('ch_missing');
  });
  it('已产出集回读 actual_sec', () => {
    const lj = ledger();
    lj.episodes[0].actual_sec = 152.6;
    expect(planEpisodeBudgets(lj).episodes[0].actualSec).toBe(153);
  });
});
