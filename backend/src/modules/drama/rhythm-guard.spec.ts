// rhythm-guard.spec.ts —— P1-d 节奏角色门(借 reelbench)单测
import {
  normalizeRhythm, checkEpisodeRhythm, rhythmPromptGuide, RHYTHM_ROLES, FLAT_RUN,
} from './rhythm-guard';

const shot = (idx: number, rhythm: string, dur = 10) => ({ idx, rhythm, duration_sec: dur });

describe('normalizeRhythm —— 枚举 + 中文别名归一', () => {
  it('标准枚举原样认', () => {
    for (const r of RHYTHM_ROLES) expect(normalizeRhythm(r)).toBe(r);
  });
  it('中文别名映射', () => {
    expect(normalizeRhythm('钩子')).toBe('hook');
    expect(normalizeRhythm('兑现')).toBe('payoff');
    expect(normalizeRhythm('换气')).toBe('breath');
  });
  it('大小写无关 + 认不出返回 null', () => {
    expect(normalizeRhythm('HOOK')).toBe('hook');
    expect(normalizeRhythm('乱写')).toBeNull();
    expect(normalizeRhythm('')).toBeNull();
    expect(normalizeRhythm(undefined)).toBeNull();
  });
});

describe('checkEpisodeRhythm —— 三条整集校验(只提示不拦)', () => {
  it('全都没标 → 视为不做节奏分析,无提示', () => {
    const r = checkEpisodeRhythm([shot(1, ''), shot(2, '')]);
    expect(r.tagged).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('半张表(标一部分)→ 提示标全', () => {
    const r = checkEpisodeRhythm([shot(1, 'hook'), shot(2, ''), shot(3, 'build')]);
    expect(r.warnings.join(' ')).toMatch(/半张表/);
    expect(r.untagged).toEqual([2]);
  });

  it('击穿①:开篇无 hook → 提示', () => {
    const r = checkEpisodeRhythm([shot(1, 'setup', 5), shot(2, 'build', 5), shot(3, 'payoff', 5)]);
    expect(r.warnings.join(' ')).toMatch(/没有 hook/);
  });

  it('开篇有 hook → 不提示钩子', () => {
    const r = checkEpisodeRhythm([shot(1, 'hook', 3), shot(2, 'setup', 5), shot(3, 'payoff', 5)]);
    expect(r.warnings.join(' ')).not.toMatch(/没有 hook/);
  });

  it('击穿②:payoff 前无 setup/build → 提示缺铺垫', () => {
    const r = checkEpisodeRhythm([shot(1, 'hook', 3), shot(2, 'payoff', 5)]);
    expect(r.warnings.join(' ')).toMatch(/缺少铺垫/);
  });

  it('payoff 前有 setup → 不提示铺垫', () => {
    const r = checkEpisodeRhythm([shot(1, 'hook', 3), shot(2, 'setup', 5), shot(3, 'payoff', 5)]);
    expect(r.warnings.join(' ')).not.toMatch(/缺少铺垫/);
  });

  it(`击穿③:连续 ${FLAT_RUN} 镜同角色 → 提示节奏平`, () => {
    const shots = [shot(1, 'hook', 3)];
    for (let i = 2; i <= FLAT_RUN + 1; i++) shots.push(shot(i, 'build', 5));
    const r = checkEpisodeRhythm(shots);
    expect(r.warnings.join(' ')).toMatch(/节奏发平/);
  });

  it('连续不足 FLAT_RUN → 不误报节奏平', () => {
    const r = checkEpisodeRhythm([shot(1, 'hook', 3), shot(2, 'build', 5), shot(3, 'build', 5), shot(4, 'payoff', 5)]);
    expect(r.warnings.join(' ')).not.toMatch(/节奏发平/);
  });

  it('distribution 统计各角色数', () => {
    const r = checkEpisodeRhythm([shot(1, 'hook'), shot(2, 'build'), shot(3, 'build')]);
    expect(r.distribution.hook).toBe(1);
    expect(r.distribution.build).toBe(2);
  });

  it('空数组不抛错', () => {
    expect(checkEpisodeRhythm([]).warnings).toEqual([]);
  });
});

describe('rhythmPromptGuide —— 提示词指南', () => {
  it('含全部 8 角色 + 三条整集要求', () => {
    const g = rhythmPromptGuide();
    for (const r of RHYTHM_ROLES) expect(g).toContain(r);
    expect(g).toContain('hook');
    expect(g).toContain(String(FLAT_RUN));
  });
});

import { checkEpisodeEndHook, END_HOOK_ROLES } from './rhythm-guard';

describe('checkEpisodeEndHook —— 集尾钩子镜头硬门(2026-09-16 批2)', () => {
  it('末镜 turn/payoff/hook = 过', () => {
    for (const r of END_HOOK_ROLES) {
      const v = checkEpisodeEndHook([{ idx: 1, rhythm: 'setup' }, { idx: 2, rhythm: r }]);
      expect(v.ok).toBe(true);
    }
  });

  it('末镜 close/breath = 不过,给原因与末镜 idx', () => {
    const v = checkEpisodeEndHook([{ idx: 1, rhythm: 'hook' }, { idx: 2, rhythm: 'close' }]);
    expect(v.ok).toBe(false);
    expect(v.reason || '').toContain('收口');
    expect(v.lastIdx).toBe(2);
    const v2 = checkEpisodeEndHook([{ idx: 7, rhythm: 'breath' }]);
    expect(v2.ok).toBe(false);
    expect(v2.reason || '').toContain('换气');
  });

  it('整集没标 rhythm = 拦(2026-09-23 空过作废,否则集尾钩子门形同虚设)', () => {
    const v = checkEpisodeEndHook([{ idx: 1 }, { idx: 2 }]);
    expect(v.ok).toBe(false);
    expect(v.reason || '').toContain('未标 rhythm');
    expect(v.lastIdx).toBe(2);
    // 空列表/无输入仍是"无事可查",不拦
    expect(checkEpisodeEndHook([]).ok).toBe(true);
    expect(checkEpisodeEndHook(null as any).ok).toBe(true);
  });
});
