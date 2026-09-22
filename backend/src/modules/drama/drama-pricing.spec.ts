// ============================================================================
// drama-pricing 单测 —— 预算闸是连集唯一的失控保护,判定必须钉死
// ============================================================================
import {
  resolvePrices, DEFAULT_UNIT_PRICES, unitsFromStepOutput, addUnits,
  unitsToCredits, checkBudget, estimateBatchCredits,
} from './drama-pricing';

describe('resolvePrices', () => {
  it('无配置时用默认单价', () => {
    expect(resolvePrices({})).toEqual(DEFAULT_UNIT_PRICES);
    expect(resolvePrices(null)).toEqual(DEFAULT_UNIT_PRICES);
  });
  it('允许覆盖单项,其余回落', () => {
    const p = resolvePrices({ unitPrices: { video: 100 } });
    expect(p.video).toBe(100);
    expect(p.image).toBe(DEFAULT_UNIT_PRICES.image);
  });
  it('非法/零/负数单价一律回落,不会被 0 单价架空预算闸', () => {
    expect(resolvePrices({ unitPrices: { image: 0, video: -5, llm: 'abc' } }))
      .toEqual(DEFAULT_UNIT_PRICES);
  });
});

describe('unitsFromStepOutput 只数真实产出', () => {
  it('文本步各记 1 次 LLM', () => {
    expect(unitsFromStepOutput(0, { scenes: [1, 2] })).toEqual({ images: 0, videos: 0, llms: 1 });
    expect(unitsFromStepOutput(2, { shots: [1] })).toEqual({ images: 0, videos: 0, llms: 1 });
  });
  it('预检与合成不消耗上游配额', () => {
    expect(unitsFromStepOutput(1, { summary: { total: 5 } })).toEqual({ images: 0, videos: 0, llms: 0 });
    expect(unitsFromStepOutput(5, { final_url: '/x.mp4' })).toEqual({ images: 0, videos: 0, llms: 0 });
  });
  it('关键帧只数出图成功的,失败的不吃预算', () => {
    const u = unitsFromStepOutput(3, {
      keyframes: [{ url: 'a' }, { url: null, error: '503' }, { url: 'c' }],
    });
    expect(u.images).toBe(2);
  });
  it('沿用上轮的视频不重复计费', () => {
    const u = unitsFromStepOutput(4, {
      shots: [
        { video_url: 'a', reused: true },
        { video_url: 'b' },
        { video_url: null, status: 'failed' },
      ],
    });
    expect(u.videos).toBe(1);
  });
  it('产出缺失时按一次 LLM 记,不当成零消耗放过', () => {
    expect(unitsFromStepOutput(0, null).llms).toBe(1);
    expect(unitsFromStepOutput(3, undefined).llms).toBe(1);
  });
  it('keyframes 不是数组也不崩', () => {
    expect(unitsFromStepOutput(3, { keyframes: 'oops' })).toEqual({ images: 0, videos: 0, llms: 0 });
  });
});

describe('addUnits / unitsToCredits', () => {
  it('累加', () => {
    expect(addUnits({ images: 1, videos: 2, llms: 3 }, { images: 4, videos: 5, llms: 6 }))
      .toEqual({ images: 5, videos: 7, llms: 9 });
  });
  it('折算', () => {
    const c = unitsToCredits({ images: 2, videos: 1, llms: 3 }, { image: 8, video: 40, llm: 2 });
    expect(c).toBe(2 * 8 + 40 + 6);
  });
});

describe('checkBudget 预算闸', () => {
  it('未设预算(≤0)永远放行,由调用方决定是否强制填', () => {
    expect(checkBudget(99999, 0).level).toBe('ok');
    expect(checkBudget(10, NaN).level).toBe('ok');
  });
  it('80% 预警,100% 拦截', () => {
    expect(checkBudget(79, 100).level).toBe('ok');
    expect(checkBudget(80, 100).level).toBe('warn');
    expect(checkBudget(99, 100).level).toBe('warn');
    expect(checkBudget(100, 100).level).toBe('block');
    expect(checkBudget(180, 100).level).toBe('block');
  });
  it('预警线可配置', () => {
    expect(checkBudget(60, 100, 0.5).level).toBe('warn');
    expect(checkBudget(60, 100, 0.9).level).toBe('ok');
  });
  it('block 时带上 used/budget 供前端直接显示', () => {
    const v = checkBudget(120, 100);
    expect(v.used).toBe(120);
    expect(v.budget).toBe(100);
    expect(v.ratio).toBeCloseTo(1.2);
  });
});

describe('estimateBatchCredits 开跑前预估', () => {
  it('按集数与每集镜数折算,并给出镜头数便于用户判断耗时', () => {
    const e = estimateBatchCredits(2, DEFAULT_UNIT_PRICES, { shotsPerEpisode: 15 });
    expect(e.shots).toBe(30);
    expect(e.videos).toBe(30);
    expect(e.images).toBe(30);
    expect(e.llms).toBe(4);
    expect(e.credits).toBe(30 * 8 + 30 * 40 + 4 * 2);
  });
  it('新资产按四视图计入', () => {
    const withAssets = estimateBatchCredits(1, DEFAULT_UNIT_PRICES, { shotsPerEpisode: 10, newAssets: 2 });
    const plain = estimateBatchCredits(1, DEFAULT_UNIT_PRICES, { shotsPerEpisode: 10 });
    expect(withAssets.images - plain.images).toBe(8); // 2 项 × 4 视图
  });
});
