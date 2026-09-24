import {
  evaluateComposeGate,
  composeGateEnabled,
  composeGateMaxRounds,
  composeGateMinDurationSec,
  failedShotDetails,
  summarizeFailedShots,
  planFrozenRemake,
  COMPOSE_GATE_MIN_RATIO,
} from './compose-gate';

describe('compose-gate 成片门', () => {
  it('drama77 真实形态(11 计划/1 存活/10s)必须不达标', () => {
    const v = evaluateComposeGate(
      { planned_shots: 11, composed_shots: 1, duration_sec: 10 }, 120,
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toHaveLength(2); // 比例 + 时长两条都中
    expect(v.minDurationSec).toBe(48); // 120 × 0.4
  });

  it('满存活 + 足时长 = 达标', () => {
    const v = evaluateComposeGate(
      { planned_shots: 11, composed_shots: 11, duration_sec: 118 }, 120,
    );
    expect(v.passed).toBe(true);
    expect(v.reasons).toHaveLength(0);
  });

  it('比例过线但时长不够 = 不达标(只中时长一条)', () => {
    const v = evaluateComposeGate(
      { planned_shots: 4, composed_shots: 4, duration_sec: 40 }, 120,
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain('40s');
  });

  it('边界:比例恰等于 0.6 判过线(≥ 语义)', () => {
    const v = evaluateComposeGate(
      { planned_shots: 10, composed_shots: 6, duration_sec: 60 }, 120,
    );
    expect(v.ratio).toBeCloseTo(COMPOSE_GATE_MIN_RATIO, 6);
    expect(v.passed).toBe(true);
  });

  it('planned=0 不拦(空集不该触发补做死循环)', () => {
    const v = evaluateComposeGate({ planned_shots: 0, composed_shots: 0, duration_sec: 0 }, 120);
    expect(v.passed).toBe(true);
  });

  it('无目标集长时兜底最短 45s;目标过小时下限 30s', () => {
    expect(composeGateMinDurationSec(0)).toBe(45);
    expect(composeGateMinDurationSec(NaN)).toBe(45);
    expect(composeGateMinDurationSec(50)).toBe(30); // 50×0.4=20 → 下限 30
    expect(composeGateMinDurationSec(120)).toBe(48);
  });

  it('脏输入不炸:缺字段/字符串数字/负数', () => {
    const v = evaluateComposeGate({ planned_shots: '11', composed_shots: '2', duration_sec: '-5' }, 120);
    expect(v.passed).toBe(false);
    expect(v.durationSec).toBe(0);
    expect(evaluateComposeGate(null, 120).passed).toBe(true);
    expect(evaluateComposeGate(undefined, 0).passed).toBe(true);
  });

  it('env 开关与轮数:DRAMA_COMPOSE_GATE=0 关拦截;轮数默认 2 可覆盖', () => {
    expect(composeGateEnabled({} as any)).toBe(true);
    expect(composeGateEnabled({ DRAMA_COMPOSE_GATE: '0' } as any)).toBe(false);
    expect(composeGateEnabled({ DRAMA_COMPOSE_GATE: '1' } as any )).toBe(true);
    expect(composeGateMaxRounds({} as any)).toBe(2);
    expect(composeGateMaxRounds({ DRAMA_COMPOSE_GATE_ROUNDS: '0' } as any)).toBe(0);
    expect(composeGateMaxRounds({ DRAMA_COMPOSE_GATE_ROUNDS: 'x' } as any)).toBe(2);
  });
});

describe('failedShotDetails 缺镜点名(2026-09-24)', () => {
  it('无 video_url 的镜头进清单,带状态与截断短因', () => {
    const out = failedShotDetails([
      { shot_idx: 10, video_url: 'http://x/10.mp4', status: 'completed' },
      { shot_idx: 11, video_url: null, status: 'failed', error: 'Agnes video create HTTP 503: {"code":"video_queue_full","message":"balabala"}' },
      { shot_idx: 12, video_url: null, status: 'skipped', reason: 'no keyframe' },
      { shot_idx: 13, video_url: null, status: 'pending' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].shot_idx).toBe(11);
    expect(out[0].status).toBe('failed');
    expect(out[0].reason).toContain('503');
    expect(out[0].reason.length).toBeLessThanOrEqual(120);
    expect(out[1]).toEqual({ shot_idx: 12, status: 'skipped', reason: 'no keyframe' });
    expect(out[2].status).toBe('pending');
  });

  it('全成功 → 空清单;脏输入不炸', () => {
    expect(failedShotDetails([
      { shot_idx: 1, video_url: 'http://x/1.mp4', status: 'completed' },
    ])).toEqual([]);
    expect(failedShotDetails(null)).toEqual([]);
    expect(failedShotDetails(undefined)).toEqual([]);
    expect(failedShotDetails('nope' as any)).toEqual([]);
    // 无 shot_idx 的条目跳过(下游按镜号补做,没号点不了名)
    expect(failedShotDetails([{ video_url: null, status: 'failed' }])).toEqual([]);
  });

  it('reason 换行/超长被压成一行短因', () => {
    const out = failedShotDetails([
      { shot_idx: 3, video_url: null, status: 'failed', error: 'line1\nline2\n' + 'x'.repeat(500) },
    ]);
    expect(out[0].reason).not.toContain('\n');
    expect(out[0].reason.length).toBeLessThanOrEqual(120);
  });

  it('summarizeFailedShots 压成时间线一句话', () => {
    expect(summarizeFailedShots([])).toBe('');
    const s = summarizeFailedShots([
      { shot_idx: 11, status: 'failed', reason: 'Agnes video create HTTP 503' },
      { shot_idx: 12, status: 'skipped', reason: 'no keyframe' },
    ]);
    expect(s).toContain('#11');
    expect(s).toContain('#12');
    expect(s).toContain('503');
  });
});

describe('planFrozenRemake 硬冻自动回炉(2026-09-24)', () => {
  it('只回炉硬冻(frozen),近静止(static)仅提示不自动烧额度', () => {
    expect(planFrozenRemake({ static: [2, 5], frozen: [7] }, false)).toEqual([7]);
    expect(planFrozenRemake({ static: [2, 5], frozen: [] }, false)).toEqual([]);
  });
  it('本轮已回炉过 → 空(防同集反复烧)', () => {
    expect(planFrozenRemake({ static: [], frozen: [7] }, true)).toEqual([]);
  });
  it('去重排序;脏输入不炸', () => {
    expect(planFrozenRemake({ frozen: [7, 3, 7] }, false)).toEqual([3, 7]);
    expect(planFrozenRemake(null, false)).toEqual([]);
    expect(planFrozenRemake(undefined, false)).toEqual([]);
    expect(planFrozenRemake({}, false)).toEqual([]);
    expect(planFrozenRemake({ frozen: 'x' as any }, false)).toEqual([]);
  });
});
