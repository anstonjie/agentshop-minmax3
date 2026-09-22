// generation-flags.spec.ts —— P1-b/P2-b/P1-a/P2-a 四个 flag 门控规划模块的纯函数单测
// 共同纪律:flag 默认关时,决策层必须回退到"与现状一致/空计划",保证零行为变化。
import { planCompose, xfadeOffsets } from './transition-plan';
import { planShotRelay } from './relay-plan';
import { groupIntoChains } from './relay-plan';
import { planDegradedRetry } from './degraded-retry';
import { planEpisodeBoundaries, chapterGoodEndingHints, repackLedgerEpisodes } from './episode-boundary';

describe('P1-b transition-plan —— 默认关=裸拼,开=xfade', () => {
  it('disabled → concat-copy,args 与现状逐字一致', () => {
    const p = planCompose({ segments: ['a.mp4', 'b.mp4'], durations: [4, 4], listFile: 'L.txt', out: 'o.mp4' });
    expect(p.mode).toBe('concat-copy');
    expect((p as any).args).toEqual(['-y', '-f', 'concat', '-safe', '0', '-i', 'L.txt', '-c', 'copy', 'o.mp4']);
  });

  it('单片段即使 enabled 也退回裸拼(无需转场)', () => {
    const p = planCompose({ segments: ['a.mp4'], durations: [4], enabled: true, out: 'o.mp4' });
    expect(p.mode).toBe('concat-copy');
  });

  it('xfadeOffsets 链式公式:offset_k = sum(d[0..k]) - (k+1)*t', () => {
    // d=[4,4,4], t=0.5 → [4-0.5, 8-1.0] = [3.5, 7.0]
    expect(xfadeOffsets([4, 4, 4], 0.5).offsets).toEqual([3.5, 7.0]);
  });

  it('xfadeOffsets 跳过太短的段(不造负 offset)', () => {
    // 中间段 0.3 < t → 两个接缝都放不下转场
    expect(xfadeOffsets([4, 0.3, 4], 0.5).offsets).toEqual([]);
  });

  it('enabled + 可转场 → xfade,filter_complex 链式,总时长扣掉重叠', () => {
    const p = planCompose({
      segments: ['a.mp4', 'b.mp4', 'c.mp4'], durations: [4, 4, 4],
      enabled: true, transitionSec: 0.5, out: 'o.mp4',
    });
    expect(p.mode).toBe('xfade');
    const x = p as any;
    expect(x.filterComplex).toContain('xfade=transition=fade:duration=0.5:offset=3.5');
    expect(x.filterComplex).toContain('[v1][2:v]xfade');
    expect(x.filterComplex).toContain('[vout]');
    expect(x.totalSec).toBeCloseTo(11.0, 3); // 12 - 2*0.5
    expect(x.args).toContain('-filter_complex');
  });

  it('enabled 但所有接缝太短 → 安全退回裸拼', () => {
    const p = planCompose({
      segments: ['a.mp4', 'b.mp4', 'c.mp4'], durations: [4, 0.3, 4],
      enabled: true, transitionSec: 0.5, listFile: 'L.txt', out: 'o.mp4',
    });
    expect(p.mode).toBe('concat-copy');
  });
});

describe('P1-a relay-plan —— 默认关=空计划(保持并行现状)', () => {
  const S = (idx: number, o: any = {}) => ({ idx, ...o });

  it('disabled → sequential=false, 无 pairs', () => {
    const r = planShotRelay([S(1, { location_id: 'a' }), S(2, { location_id: 'a' })]);
    expect(r.enabled).toBe(false);
    expect(r.sequential).toBe(false);
    expect(r.pairs).toEqual([]);
  });

  it('enabled + 同场景 → same-location 接力,顺序生成', () => {
    const r = planShotRelay([S(1, { location_id: 'a' }), S(2, { location_id: 'a' })], { enabled: true });
    expect(r.sequential).toBe(true);
    expect(r.pairs[0]).toMatchObject({ from: 1, to: 2, why: 'same-location' });
  });

  it('enabled + 异场景但有 handoff → handoff 接力', () => {
    const r = planShotRelay(
      [S(1, { location_id: 'a' }), S(2, { location_id: 'b', handoff: 'A 把信递给 B' })],
      { enabled: true },
    );
    expect(r.pairs[0].why).toBe('handoff');
  });

  it('enabled + 异场景无交接但共享角色 → shared-cast', () => {
    const r = planShotRelay(
      [S(1, { location_id: 'a', characters: ['c1'] }), S(2, { location_id: 'b', characters: ['c1', 'c2'] })],
      { enabled: true },
    );
    expect(r.pairs[0].why).toBe('shared-cast');
  });

  it('enabled + 异场景无交接无共享角色 → 硬切(不接力)', () => {
    const r = planShotRelay(
      [S(1, { location_id: 'a', characters: ['c1'] }), S(2, { location_id: 'b', characters: ['c9'] })],
      { enabled: true },
    );
    expect(r.pairs).toEqual([]);
    expect(r.hardCuts).toEqual([{ from: 1, to: 2 }]);
  });
});

describe('P2-b degraded-retry —— 默认关=不重生(现状)', () => {
  const P = (shotIdx: number, degraded: boolean, retries = 0) => ({ shotIdx, degraded, retries, missingRefs: degraded ? ['c1'] : [] });

  it('disabled → retry 空,degraded 全进 giveUp(仅标记,不改现状)', () => {
    const r = planDegradedRetry([P(1, true), P(2, false)]);
    expect(r.enabled).toBe(false);
    expect(r.retry).toEqual([]);
    expect(r.giveUp).toEqual([1]);
    expect(r.degradedRatio).toBeCloseTo(0.5, 5);
  });

  it('enabled + 未达重试上限 → retry 点名', () => {
    const r = planDegradedRetry([P(1, true, 0), P(2, true, 0)], { enabled: true, maxRetry: 1 });
    expect(r.retry).toEqual([1, 2]);
    expect(r.giveUp).toEqual([]);
  });

  it('enabled + 已达上限 → giveUp(不再烧额度)', () => {
    const r = planDegradedRetry([P(1, true, 1)], { enabled: true, maxRetry: 1 });
    expect(r.retry).toEqual([]);
    expect(r.giveUp).toEqual([1]);
  });

  it('无 degraded → 都空,ratio 0', () => {
    const r = planDegradedRetry([P(1, false), P(2, false)], { enabled: true });
    expect(r.retry).toEqual([]);
    expect(r.degradedRatio).toBe(0);
  });
});

describe('P2-a episode-boundary —— 默认关=空计划(沿用 n2d-core 装箱)', () => {
  const C = (id: string, sec: number, o: any = {}) => ({ id, budget_sec: sec, ...o });

  it('disabled → episodes 空,调用方沿用现状', () => {
    const r = planEpisodeBoundaries([C('c1', 60), C('c2', 60), C('c3', 60)]);
    expect(r.enabled).toBe(false);
    expect(r.episodes).toEqual([]);
  });

  it('enabled 无叙事信号 → lowConfidence=true(建议退回纯秒数)', () => {
    const r = planEpisodeBoundaries([C('c1', 60), C('c2', 60)], { enabled: true, epTargetSec: 120 });
    expect(r.lowConfidence).toBe(true);
  });

  it('enabled 有钩子信号 → 在收得住的章尾切', () => {
    // 目标 120s: c1(60)+c2(60)=120 到点,c2 有 turn → 在此切; c3+c4 第二集
    const r = planEpisodeBoundaries(
      [C('c1', 60), C('c2', 60, { lastBeatType: 'turn' }), C('c3', 60), C('c4', 60, { hasHook: true })],
      { enabled: true, epTargetSec: 120 },
    );
    expect(r.lowConfidence).toBe(false);
    expect(r.episodes[0]).toEqual(['c1', 'c2']);
    expect(r.episodes[1]).toEqual(['c3', 'c4']);
  });

  it('enabled 到点但当前章收不住且下一章不超时 → 延后到好的章尾', () => {
    // c1(60)+c2(60)=120 到点,但 c2 无好尾;加 c3(30) 不超 120*1.25 → 延后;c3 有 reveal → 切
    const r = planEpisodeBoundaries(
      [C('c1', 60), C('c2', 60), C('c3', 30, { lastBeatType: 'reveal' }), C('c4', 30)],
      { enabled: true, epTargetSec: 120, tolerance: 0.25 },
    );
    expect(r.episodes[0]).toEqual(['c1', 'c2', 'c3']);
  });

  it('硬顶守卫(真实 drama75 回归):小+小+大章 不把单集撑过 hardCap', () => {
    // c1(53)+c2(12)=65,加 c3(112)=177 > 150(=120×1.25)→ 先切,c3 单独成集
    const r = planEpisodeBoundaries(
      [C('c1', 53, { hasHook: true }), C('c2', 12), C('c3', 112)],
      { enabled: true, epTargetSec: 120, tolerance: 0.25 },
    );
    expect(r.episodes).toEqual([['c1', 'c2'], ['c3']]);
    // 关键不变量:任何一集都不超硬顶 150s(修前会出 177s 的集)
    const secOf: Record<string, number> = { c1: 53, c2: 12, c3: 112 };
    for (const ep of r.episodes) {
      expect(ep.reduce((s, id) => s + secOf[id], 0)).toBeLessThanOrEqual(150);
    }
  });

  it('所有章节归入某一集(不丢章)', () => {
    const r = planEpisodeBoundaries(
      [C('c1', 50), C('c2', 50, { hasHook: true }), C('c3', 50), C('c4', 50, { hasHook: true })],
      { enabled: true, epTargetSec: 100 },
    );
    const flat = r.episodes.flat();
    expect(flat.sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});

describe('P1-a groupIntoChains —— 链间并行、链内顺序', () => {
  it('全被接力对相连 → 单链', () => {
    const chains = groupIntoChains([1, 2, 3], [
      { from: 1, to: 2, why: 'same-location' }, { from: 2, to: 3, why: 'same-location' },
    ]);
    expect(chains).toEqual([[1, 2, 3]]);
  });
  it('中间硬切 → 断成两链', () => {
    const chains = groupIntoChains([1, 2, 3, 4], [
      { from: 1, to: 2, why: 'same-location' }, { from: 3, to: 4, why: 'handoff' },
    ]);
    expect(chains).toEqual([[1, 2], [3, 4]]);
  });
  it('无接力对 → 每镜各自一链(完全并行,等价现状)', () => {
    expect(groupIntoChains([1, 2, 3], [])).toEqual([[1], [2], [3]]);
  });
  it('乱序输入按 idx 排序后分链,不丢镜', () => {
    const chains = groupIntoChains([3, 1, 2], [
      { from: 1, to: 2, why: 'same-location' }, { from: 2, to: 3, why: 'same-location' },
    ]);
    expect(chains).toEqual([[1, 2, 3]]);
    expect(chains.flat().sort()).toEqual([1, 2, 3]);
  });
  it('最长链决定顺序化代价:多短链优于一条长链', () => {
    // 6 镜,3 条各 2 镜的链 → 最长链 2(≈2×63s),而非 6 镜全顺序(≈6×63s)
    const chains = groupIntoChains([1, 2, 3, 4, 5, 6], [
      { from: 1, to: 2, why: 'same-location' },
      { from: 3, to: 4, why: 'same-location' },
      { from: 5, to: 6, why: 'same-location' },
    ]);
    expect(chains.length).toBe(3);
    expect(Math.max(...chains.map((c) => c.length))).toBe(2);
  });
  it('maxChainLength 限制超长链: 12 镜全相连时按默认 maxChainLength=3 切割为 4 链', () => {
    const allShots = Array.from({ length: 12 }, (_, i) => i + 1);
    const allPairs = allShots.slice(0, -1).map((s) => ({ from: s, to: s + 1, why: 'same-location' as const }));
    const chains = groupIntoChains(allShots, allPairs, { maxChainLength: 3 });
    expect(chains).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ]);
    expect(chains.flat()).toEqual(allShots);
  });
  it('maxChainLength=0 或 Infinity 时不限制链长', () => {
    const shots = [1, 2, 3, 4, 5];
    const pairs = shots.slice(0, -1).map((s) => ({ from: s, to: s + 1, why: 'shared-cast' as const }));
    const chains = groupIntoChains(shots, pairs, { maxChainLength: 0 });
    expect(chains).toEqual([[1, 2, 3, 4, 5]]);
  });
});

describe('P2-a chapterGoodEndingHints —— beats→每章收尾信号', () => {
  it('取每章最后一拍(按 -bN 序号)的 type 判 hasHook', () => {
    const h = chapterGoodEndingHints([
      { id: 'ch1-b1', chapter: 'ch1', type: 'plot' },
      { id: 'ch1-b2', chapter: 'ch1', type: 'turn' },   // 最后一拍=turn → hasHook
      { id: 'ch2-b1', chapter: 'ch2', type: 'action' }, // 收不住
    ]);
    expect(h.get('ch1')).toEqual({ lastBeatType: 'turn', hasHook: true, lastBeatSummary: '' });
    expect(h.get('ch2')).toEqual({ lastBeatType: 'action', hasHook: false, lastBeatSummary: '' });
  });
  it('乱序 beats 也按 -bN 定序取最后一拍', () => {
    const h = chapterGoodEndingHints([
      { id: 'ch1-b3', chapter: 'ch1', type: 'reveal' },
      { id: 'ch1-b1', chapter: 'ch1', type: 'plot' },
      { id: 'ch1-b2', chapter: 'ch1', type: 'action' },
    ]);
    expect(h.get('ch1')!.lastBeatType).toBe('reveal');
    expect(h.get('ch1')!.hasHook).toBe(true);
  });
  it('空 beats → 空 Map', () => {
    expect(chapterGoodEndingHints([]).size).toBe(0);
  });
});

describe('P2-a repackLedgerEpisodes —— 装箱改造(护栏 + 不变更输入)', () => {
  const mkLedger = () => ({
    chapters: [
      { id: 'ch1', title: '一', budget_sec: 60, episode_ids: ['ep_001'] },
      { id: 'ch2', title: '二', budget_sec: 50, episode_ids: ['ep_001'] },
      { id: 'ch3', title: '三', budget_sec: 30, episode_ids: ['ep_002'] },
      { id: 'ch4', title: '四', budget_sec: 30, episode_ids: ['ep_002'] },
    ],
    episodes: [
      { id: 'ep_001', chapters: ['ch1', 'ch2'], budget_sec: 110, hook: '', cliffhanger: '', status: 'pending', actual_sec: null },
      { id: 'ep_002', chapters: ['ch3', 'ch4'], budget_sec: 60, hook: '', cliffhanger: '', status: 'pending', actual_sec: null },
    ],
    meta: { budget: { episode_count: 2, total_minutes: 2.83, ep_target_sec: 120 } },
  });

  it('无 beat 信号(lowConfidence)→ 不重排,保留原装箱', () => {
    const lj = mkLedger();
    const r = repackLedgerEpisodes(lj, new Map(), 120);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('LOW_CONFIDENCE_NO_BEAT_SIGNAL');
    expect(r.ledgerJson.episodes.length).toBe(2);
  });

  it('有信号 → 边界移到收得住的章尾(ch3=reveal),覆盖全部章节', () => {
    const lj = mkLedger();
    const hints = chapterGoodEndingHints([
      { id: 'ch3-b1', chapter: 'ch3', type: 'reveal' }, // ch3 收得住
    ]);
    const r = repackLedgerEpisodes(lj, hints, 120);
    expect(r.changed).toBe(true);
    // 贪心:ch1(60)+ch2(50)=110 到点但 ch2 收不住,加 ch3(30) 不超 120×1.25 → 延到 ch3(reveal)才切
    expect(r.ledgerJson.episodes[0].chapters).toEqual(['ch1', 'ch2', 'ch3']);
    expect(r.ledgerJson.episodes[1].chapters).toEqual(['ch4']);
    const flat = r.ledgerJson.episodes.flatMap((e: any) => e.chapters);
    expect(flat.sort()).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
  });

  it('重排后 chapters[].episode_ids 与 meta.budget.episode_count 同步', () => {
    const lj = mkLedger();
    const hints = chapterGoodEndingHints([{ id: 'ch3-b1', chapter: 'ch3', type: 'reveal' }]);
    const r = repackLedgerEpisodes(lj, hints, 120);
    const ch3 = r.ledgerJson.chapters.find((c: any) => c.id === 'ch3');
    expect(ch3.episode_ids).toEqual([r.ledgerJson.episodes[0].id]);
    expect(r.ledgerJson.meta.budget.episode_count).toBe(r.toEpisodeCount);
  });

  it('不变更入参对象(原 ledgerJson 保持原装箱)', () => {
    const lj = mkLedger();
    const hints = chapterGoodEndingHints([{ id: 'ch3-b1', chapter: 'ch3', type: 'reveal' }]);
    repackLedgerEpisodes(lj, hints, 120);
    expect(lj.episodes[0].chapters).toEqual(['ch1', 'ch2']); // 原样
    expect(lj.chapters[2].episode_ids).toEqual(['ep_002']);   // 原样
  });

  it('集数漂移超 [0.6×,1.6×] → 护栏拦下不重排', () => {
    // 4 章各自都收得住 + epTarget 很小 → 想切成 4 集,原 2 集,4 > floor(2×1.6)=3 → 拦
    const lj = mkLedger();
    const hints = chapterGoodEndingHints([
      { id: 'ch1-b1', chapter: 'ch1', type: 'turn' },
      { id: 'ch2-b1', chapter: 'ch2', type: 'turn' },
      { id: 'ch3-b1', chapter: 'ch3', type: 'turn' },
      { id: 'ch4-b1', chapter: 'ch4', type: 'turn' },
    ]);
    const r = repackLedgerEpisodes(lj, hints, 40);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('EPISODE_COUNT_DRIFT');
  });
});
