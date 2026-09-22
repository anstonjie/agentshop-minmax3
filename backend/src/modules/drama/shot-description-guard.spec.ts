// shot-description-guard.spec.ts —— P0-b 画面描述质检门(借 reelbench)单测
import {
  checkShotDescriptions, summarizeDescViolations, EMPTY_PHRASES, MIN_DESC_CHARS,
} from './shot-description-guard';

describe('checkShotDescriptions —— 每道门都有击穿用例', () => {
  it('干净的具体描述 → 无违规', () => {
    const v = checkShotDescriptions([
      { idx: 1, description: '土屋门洞逆光,老太太扶着门框往外冲,灶台在前景糊成虚影' },
    ]);
    expect(v).toEqual([]);
  });

  it('击穿·空话:命中空话词表 → empty', () => {
    const v = checkShotDescriptions([
      { idx: 3, description: '这个画面氛围感很强,充满高级感的电影质感场景' },
    ]);
    expect(v.some((x) => x.reason === 'empty')).toBe(true);
    expect(v.find((x) => x.reason === 'empty')!.detail).toContain(EMPTY_PHRASES[0]);
  });

  it('击穿·过短:去空白后 < 最低字数 → too_short', () => {
    const v = checkShotDescriptions([{ idx: 2, description: '人在说话' }]);
    expect(v.some((x) => x.reason === 'too_short')).toBe(true);
    expect('人在说话'.length).toBeLessThan(MIN_DESC_CHARS);
  });

  it('击穿·空描述 → too_short', () => {
    const v = checkShotDescriptions([{ idx: 1, description: '   ' }]);
    expect(v.some((x) => x.reason === 'too_short')).toBe(true);
  });

  it('击穿·废话开头:"这个镜头…" → waste_prefix', () => {
    const v = checkShotDescriptions([
      { idx: 1, description: '这个镜头里主角站在窗边望着远处的山' },
    ]);
    expect(v.some((x) => x.reason === 'waste_prefix')).toBe(true);
  });

  it('击穿·重复:两镜描述一字不差 → 第二镜 duplicate 并点名首镜', () => {
    const v = checkShotDescriptions([
      { idx: 1, description: '主角站在窗边望着远处的山峦起伏' },
      { idx: 2, description: '主角站在窗边望着远处的山峦起伏' },
    ]);
    const dup = v.find((x) => x.reason === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.idx).toBe(2);
    expect(dup!.detail).toContain('#1');
  });

  it('归一化空白后仍算重复(空格差异不逃逸)', () => {
    const v = checkShotDescriptions([
      { idx: 1, description: '主角 站在 窗边 望着 远处 山峦' },
      { idx: 2, description: '主角站在窗边望着远处山峦' },
    ]);
    expect(v.some((x) => x.reason === 'duplicate')).toBe(true);
  });

  it('非数组 → 空,不抛错', () => {
    expect(checkShotDescriptions(null as any)).toEqual([]);
  });
});

describe('summarizeDescViolations —— 按 reason 聚合去重', () => {
  it('空 → 空数组', () => {
    expect(summarizeDescViolations([])).toEqual([]);
  });
  it('同 reason 多镜聚合成一条,镜号去重', () => {
    const s = summarizeDescViolations([
      { idx: 1, reason: 'empty', detail: '' },
      { idx: 1, reason: 'too_short', detail: '' },
      { idx: 4, reason: 'empty', detail: '' },
    ]);
    expect(s.find((x) => x.includes('空话描述'))).toContain('#1,#4');
    expect(s.find((x) => x.includes('描述过短'))).toContain('#1');
  });
});
