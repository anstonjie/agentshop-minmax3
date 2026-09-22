// video-audit.spec.ts —— P1-c 成片质检门单测
// 仿 reelbench selftest 纪律:每道门都要有「击穿用例」证明它真的会拦,而不只是跑通。
// 只测纯函数(判定层 + 解析层),不调 ffmpeg;I/O 层只测降级分支(缺 bin / 无片段)。
import {
  medianTrimmed, parseYdif, parseFreezeRatio, meanAbsDiffNorm, quartiles,
  medianAbsDeviation, aggregateAudit, auditCompose, DEFAULT_THRESHOLDS,
} from './video-audit';

describe('medianTrimmed —— 两端剔除取中位数(避切点尖峰)', () => {
  it('空/全非有限 → null', () => {
    expect(medianTrimmed([])).toBeNull();
    expect(medianTrimmed([NaN, Infinity])).toBeNull();
  });
  it('少于3样本不剔除,退化为均值', () => {
    expect(medianTrimmed([2, 4])).toBe(3);
    expect(medianTrimmed([5])).toBe(5);
  });
  it('≥3样本剔除首尾各一个再取中位', () => {
    // [0(首剔),1,2,3,100(尾剔)] → [1,2,3] → 中位2。若不剔除会被 100 带偏。
    expect(medianTrimmed([0, 1, 2, 3, 100])).toBe(2);
  });
  it('剔除后偶数个取两者均值', () => {
    // [0剔,1,2,3,4,9剔] → [1,2,3,4] → (2+3)/2=2.5
    expect(medianTrimmed([0, 1, 2, 3, 4, 9])).toBe(2.5);
  });
});

describe('parseYdif —— 解析 signalstats 逐帧 YDIF', () => {
  it('抽出全部 YDIF 值,忽略杂讯', () => {
    const stdout = [
      'frame:0 pts:100', 'lavfi.signalstats.YDIF=0',
      'frame:1 pts:200', 'lavfi.signalstats.YDIF=1.46441',
      'some noise line', 'lavfi.signalstats.YDIF=0.961372',
    ].join('\n');
    expect(parseYdif(stdout)).toEqual([0, 1.46441, 0.961372]);
  });
  it('无匹配 → 空数组', () => {
    expect(parseYdif('nothing here')).toEqual([]);
  });
});

describe('parseFreezeRatio —— freezedetect 冻结占比', () => {
  it('命令跑通但无冻结 → 0(近静止≠硬冻,标定已证)', () => {
    expect(parseFreezeRatio('frame:0\nlavfi.signalstats.YDIF=1.0\n', 4.5)).toBe(0);
  });
  it('累加 freeze_duration 除以总时长', () => {
    const out = 'lavfi.freezedetect.freeze_duration=2.0\nlavfi.freezedetect.freeze_duration=1.0\n';
    expect(parseFreezeRatio(out, 4.0)).toBeCloseTo(0.75, 5);
  });
  it('占比钳制在 0~1', () => {
    expect(parseFreezeRatio('lavfi.freezedetect.freeze_duration=99', 4.0)).toBe(1);
  });
  it('无时长且有冻结 → 1', () => {
    expect(parseFreezeRatio('lavfi.freezedetect.freeze_duration=2', null)).toBe(1);
  });
});

describe('meanAbsDiffNorm —— 接缝灰度帧差(归一化 0~1)', () => {
  it('完全相同 → 0', () => {
    expect(meanAbsDiffNorm([10, 20, 30], [10, 20, 30])).toBe(0);
  });
  it('最大反差 → 1', () => {
    expect(meanAbsDiffNorm([0, 0], [255, 255])).toBeCloseTo(1, 5);
  });
  it('长度不符 / 空 / null → null', () => {
    expect(meanAbsDiffNorm([1, 2], [1, 2, 3])).toBeNull();
    expect(meanAbsDiffNorm([], [])).toBeNull();
    expect(meanAbsDiffNorm(null, [1])).toBeNull();
  });
});

describe('quartiles', () => {
  it('空 → 全 null', () => {
    expect(quartiles([])).toEqual({ p25: null, p50: null, p75: null, iqr: null });
  });
  it('iqr = p75 - p25', () => {
    const q = quartiles([0.19, 0.2, 0.2, 0.21, 0.9]);
    expect(q.iqr).toBeCloseTo(q.p75! - q.p25!, 5);
  });
});

describe('aggregateAudit —— 门判定(击穿用例:证明每道门真会拦)', () => {
  const dyn = (idx: number, y: number) => ({ idx, ydifMedian: y, frozenRatio: 0, durationSec: 5 });

  it('全动态镜头 → verdict ok,无死镜告警', () => {
    const a = aggregateAudit({
      durations: [5, 5, 5],
      motions: [dyn(0, 4.4), dyn(1, 6.9), dyn(2, 3.2)],
      seams: [{ at: 0, diff: 0.2 }, { at: 1, diff: 0.21 }],
    });
    expect(a.verdict).toBe('ok');
    expect(a.staticShots).toEqual([]);
    expect(a.staticRatio).toBe(0);
  });

  it('击穿①:出现 YDIF<staticMaxMotion 的镜头 → 判死镜、升 review、点名', () => {
    const a = aggregateAudit({
      durations: [5, 5, 5, 5],
      motions: [dyn(0, 0.59), dyn(1, 6.0), dyn(2, 0.63), dyn(3, 4.4)],
      seams: [],
    });
    expect(a.staticShots).toEqual([0, 2]);
    expect(a.staticRatio).toBeCloseTo(0.5, 5);
    expect(a.verdict).toBe('review');
    expect(a.warnings.join(' ')).toMatch(/死镜/);
    expect(a.warnings.join(' ')).toMatch(/#0,#2/);
  });

  it('击穿②:硬冻镜头(frozenRatio≥freezeMinRatio)→ 点名、升 review', () => {
    const a = aggregateAudit({
      durations: [5, 5],
      motions: [
        { idx: 0, ydifMedian: 3, frozenRatio: 0.8, durationSec: 5 },
        { idx: 1, ydifMedian: 3, frozenRatio: 0.1, durationSec: 5 },
      ],
      seams: [],
    });
    expect(a.frozenShots).toEqual([0]);
    expect(a.verdict).toBe('review');
    expect(a.warnings.join(' ')).toMatch(/硬冻/);
  });

  it('击穿③:接缝离群(>p50+K×IQR)→ 点名硬跳接缝、升 review', () => {
    const a = aggregateAudit({
      durations: [5, 5, 5, 5, 5],
      motions: [dyn(0, 4), dyn(1, 4), dyn(2, 4), dyn(3, 4), dyn(4, 4)],
      seams: [
        { at: 0, diff: 0.20 }, { at: 1, diff: 0.21 },
        { at: 2, diff: 0.19 }, { at: 3, diff: 0.90 }, // 剧变接缝
      ],
    });
    expect(a.seamOutliers).toEqual([3]);
    expect(a.verdict).toBe('review');
    expect(a.warnings.join(' ')).toMatch(/硬跳接缝/);
  });

  it('接缝均匀(iqr≈0)→ 不误报离群', () => {
    const a = aggregateAudit({
      durations: [5, 5, 5, 5],
      motions: [dyn(0, 4), dyn(1, 4), dyn(2, 4), dyn(3, 4)],
      seams: [{ at: 0, diff: 0.2 }, { at: 1, diff: 0.2 }, { at: 2, diff: 0.2 }, { at: 3, diff: 0.2 }],
    });
    expect(a.seamOutliers).toEqual([]);
  });

  it('接缝微小波动(MAD≈0 但略有差)→ 绝对地板兜底,不误报', () => {
    const a = aggregateAudit({
      durations: [5, 5, 5, 5],
      motions: [dyn(0, 4), dyn(1, 4), dyn(2, 4), dyn(3, 4)],
      seams: [{ at: 0, diff: 0.20 }, { at: 1, diff: 0.20 }, { at: 2, diff: 0.20 }, { at: 3, diff: 0.22 }],
    });
    // 0.22 只高出中位数 0.02 < 地板 0.10 → 不算硬跳
    expect(a.seamOutliers).toEqual([]);
  });

  it('镜长提示只提示不升 review(导演判断,不是错误)', () => {
    const a = aggregateAudit({
      durations: [0.8, 0.9, 0.7], // 平均镜长 < pacingAdvisoryMinSec
      motions: [dyn(0, 4), dyn(1, 4), dyn(2, 4)],
      seams: [],
    });
    expect(a.warnings.join(' ')).toMatch(/提示·不拦/);
    expect(a.verdict).toBe('ok'); // 仅提示,不升 review
  });

  it('镜长/切次统计正确', () => {
    const a = aggregateAudit({
      durations: [4, 6, 5],
      motions: [dyn(0, 4), dyn(1, 4), dyn(2, 4)],
      seams: [],
    });
    expect(a.shotCount).toBe(3);
    expect(a.totalSec).toBe(15);
    expect(a.avgShotSec).toBeCloseTo(5, 5);
    expect(a.minShotSec).toBe(4);
    expect(a.maxShotSec).toBe(6);
    // 每分钟切次 = (镜数-1)/(总秒/60) = 2/0.25 = 8
    expect(a.cutsPerMin).toBeCloseTo(8, 5);
  });

  it('阈值可被覆盖', () => {
    const a = aggregateAudit({
      durations: [5, 5],
      motions: [dyn(0, 1.5), dyn(1, 1.5)],
      seams: [],
      thresholds: { staticMaxMotion: 2.0 }, // 抬高死镜线 → 1.5 也算死镜
    });
    expect(a.staticShots).toEqual([0, 1]);
    expect(a.thresholds.staticMaxMotion).toBe(2.0);
  });
});

describe('auditCompose —— I/O 层降级(不抛错)', () => {
  it('ffmpeg 不可用 → skipped,reason=FFMPEG_UNAVAILABLE', () => {
    const a = auditCompose(null, ['x.mp4'], [5]);
    expect(a.skipped).toBe(true);
    expect(a.reason).toBe('FFMPEG_UNAVAILABLE');
    expect(a.verdict).toBe('ok');
  });
  it('无片段 → skipped,reason=NO_SEGMENTS', () => {
    const a = auditCompose('ffmpeg', [], []);
    expect(a.skipped).toBe(true);
    expect(a.reason).toBe('NO_SEGMENTS');
  });
  it('片段文件不存在 → 不抛错,运动量测不到但不崩', () => {
    // 传一个真实存在概率为0的路径 + 假 bin:measureSegmentMotion 内部 spawn 失败会降级,
    // fs.existsSync 为 false 时直接返回 null 字段。整条不抛。
    const a = auditCompose('definitely-not-a-real-ffmpeg-bin', ['/no/such/seg.mp4'], [5]);
    expect(a).toBeDefined();
    expect(a.skipped === true || a.motions.length === 1).toBe(true);
  });
});

describe('DEFAULT_THRESHOLDS —— 标定默认值不被误改(回归锁)', () => {
  it('死镜线 1.0 / 冻结线 0.6 / 接缝离群系数 2.0 / 接缝地板 0.10', () => {
    expect(DEFAULT_THRESHOLDS.staticMaxMotion).toBe(1.0);
    expect(DEFAULT_THRESHOLDS.freezeMinRatio).toBe(0.6);
    expect(DEFAULT_THRESHOLDS.seamOutlierK).toBe(2.0);
    expect(DEFAULT_THRESHOLDS.seamOutlierAbsFloor).toBe(0.10);
  });
});

describe('medianAbsDeviation —— 抗离群(离群值不抬高自己的判定线)', () => {
  it('一个剧变值几乎不影响 MAD', () => {
    const withOutlier = medianAbsDeviation([0.19, 0.20, 0.21, 0.90])!;
    const without = medianAbsDeviation([0.19, 0.20, 0.21, 0.22])!;
    // 0.90 是离群,MAD 应仍很小,与无离群时同量级(远小于 IQR 被污染的情况)
    expect(withOutlier).toBeLessThan(0.05);
    expect(Math.abs(withOutlier - without)).toBeLessThan(0.03);
  });
  it('空 → null', () => {
    expect(medianAbsDeviation([])).toBeNull();
  });
});
