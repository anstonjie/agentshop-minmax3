import {
  evaluateComposeGate,
  composeGateEnabled,
  composeGateMaxRounds,
  composeGateMinDurationSec,
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
    expect(composeGateEnabled({ DRAMA_COMPOSE_GATE: '1' } as any)).toBe(true);
    expect(composeGateMaxRounds({} as any)).toBe(2);
    expect(composeGateMaxRounds({ DRAMA_COMPOSE_GATE_ROUNDS: '0' } as any)).toBe(0);
    expect(composeGateMaxRounds({ DRAMA_COMPOSE_GATE_ROUNDS: 'x' } as any)).toBe(2);
  });
});
