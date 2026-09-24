// ============================================================================
// camera-motion.spec —— 单一运镜词表 + rhythm→运镜 兜底
// ----------------------------------------------------------------------------
// 源:飞书《各种运镜提示词（待增加）》约 38 条,经 e2e-2min 抽取归一。
// 测试锁「键存在且英文非空」「旧 10 键不回归」「rhythm 有默认」「静止仍特殊」。
// ============================================================================
import {
  CAMERA_MOTION_EN,
  KEYFRAME_SAFE_MOTIONS,
  SHOT_TYPE_EN,
  cameraMotionEn,
  motionForRhythm,
  cameraMotionGuide,
  shotTypeEn,
} from './camera-motion';
import { normalizeRhythm } from './rhythm-guard';

describe('CAMERA_MOTION_EN 单一词表', () => {
  it('旧 10 键全部保留且英文非空(不回归)', () => {
    for (const k of ['静止', '推', '拉', '摇', '移', '跟', '升', '降', '甩', '环绕']) {
      expect(CAMERA_MOTION_EN[k]).toBeTruthy();
      expect(cameraMotionEn(k)).toBe(CAMERA_MOTION_EN[k]);
    }
  });

  it('文档扩词可映射(过肩/穿拍/俯拍/手持/荷兰角/冲击变焦等)', () => {
    const cases: Array<[string, RegExp]> = [
      ['过肩', /over-the-shoulder/i],
      ['穿拍', /through|fly-through/i],
      ['俯拍', /top-down|bird/i],
      ['仰拍', /tilt.?up|low.?angle/i],
      ['手持', /handheld/i],
      ['荷兰角', /dutch/i],
      ['冲击变焦', /snap.?zoom|crash.?zoom/i],
      ['焦点切换', /rack focus|focus pull/i],
      ['半环绕', /half.?orbit|180/i],
      ['第一人称', /first-person|POV/i],
      ['上帝视角', /top-down|bird.?s.?eye/i],
      ['快推', /fast|whip|rush|rapid/i],
      ['遮挡显露|reveal|wipe', /lateral|wipe|reveal/i],
    ];
    void cases;
    for (const [key, re] of [
      ['过肩', /over-the-shoulder/i],
      ['穿拍', /through|fly-through/i],
      ['俯拍', /top-down|from above|tilt down/i],
      ['仰拍', /tilt.?up|low.?angle|from below/i],
      ['手持', /handheld/i],
      ['荷兰角', /dutch/i],
      ['冲击变焦', /snap.?zoom|crash.?zoom/i],
      ['焦点切换', /rack focus|focus pull/i],
      ['半环绕', /half.?orbit|180/i],
      ['第一人称', /first-person|POV/i],
      ['上帝视角', /top-down|bird/i],
      ['快推', /fast|rush|rapid/i],
      ['遮挡显露', /reveal|wipe|lateral/i],
      ['眩晕', /dolly.?zoom|zolly/i],
      ['侧跟', /parallel|side.?track|trucks/i],
      ['引导跟', /backward|lead.?track|glides backward/i],
      ['鱼眼', /fisheye/i],
      ['摇臂升', /crane up/i],
      ['摇臂降', /crane down/i],
      ['FPV俯冲', /FPV|dive/i],
      ['无人机揭示', /drone reveal|rising/i],
      ['弧形环绕', /arc shot|slow arc/i],
      ['光学推近', /zoom-in/i],
      ['光学拉远', /zoom-out/i],
    ] as Array<[string, RegExp]>) {
      const en = cameraMotionEn(key);
      expect(en).toBeTruthy();
      expect(en).toMatch(re);
    }
  });

  it('未知键返回空串,不产生 undefined', () => {
    expect(cameraMotionEn('火星运镜')).toBe('');
    expect(cameraMotionEn('')).toBe('');
    expect(cameraMotionEn(undefined as any)).toBe('');
  });

  it('关键帧安全子集不含纯时间类运镜(焦点切换等静图表达不了)', () => {
    expect(KEYFRAME_SAFE_MOTIONS.has('焦点切换')).toBe(false);
    expect(KEYFRAME_SAFE_MOTIONS.has('穿拍')).toBe(false);
    expect(KEYFRAME_SAFE_MOTIONS.has('推')).toBe(true);
    expect(KEYFRAME_SAFE_MOTIONS.has('过肩')).toBe(true);
  });

  it('景别词表单一来源:6 档齐全,未知返回空串', () => {
    expect(SHOT_TYPE_EN['特写']).toBe('extreme close-up');
    expect(SHOT_TYPE_EN['空镜']).toContain('no characters');
    expect(shotTypeEn('中景')).toBe('medium shot');
    expect(shotTypeEn('远景')).toContain('extreme wide');
    expect(shotTypeEn('未知景别')).toBe('');
    expect(shotTypeEn('')).toBe('');
  });
});

describe('motionForRhythm rhythm→默认运镜', () => {
  it('八个节奏角色都有默认运镜', () => {
    for (const r of ['hook', 'setup', 'build', 'beat', 'turn', 'payoff', 'breath', 'close'] as const) {
      const m = motionForRhythm(r);
      expect(m).toBeTruthy();
      expect(cameraMotionEn(m)).toBeTruthy();
    }
  });

  it('hook/beat 偏快节奏运镜;turn 偏转场揭示;close/breath 偏拉开', () => {
    expect(motionForRhythm('hook')).toMatch(/快推|甩|冲击变焦/);
    expect(motionForRhythm('beat')).toMatch(/快推|推|冲击变焦/);
    expect(motionForRhythm('turn')).toMatch(/穿拍|遮挡显露|甩|焦点切换/);
    expect(motionForRhythm('close')).toMatch(/拉|俯拍|光学拉远/);
    expect(motionForRhythm('breath')).toMatch(/拉|摇|环绕|光学拉远/);
  });

  it('中文节奏别名经 normalizeRhythm 后可解析', () => {
    const zh = normalizeRhythm('钩子');
    expect(zh).toBe('hook');
    expect(motionForRhythm(zh!)).toBeTruthy();
    expect(motionForRhythm(normalizeRhythm('转折')!)).toMatch(/穿拍|遮挡显露|甩|焦点切换/);
  });

  it('未知/空 rhythm 返回空串(调用方保持原 camera_motion)', () => {
    expect(motionForRhythm(null)).toBe('');
    expect(motionForRhythm('未知节奏')).toBe('');
    expect(motionForRhythm('')).toBe('');
  });

  it('默认运镜绝不返回静止', () => {
    for (const r of ['hook', 'setup', 'build', 'beat', 'turn', 'payoff', 'breath', 'close'] as const) {
      expect(motionForRhythm(r)).not.toBe('静止');
    }
  });
});

describe('cameraMotionGuide 分镜 sys 用运镜指南', () => {
  it('包含旧优先词与 rhythm 配对提示', () => {
    const g = cameraMotionGuide();
    expect(g).toContain('推');
    expect(g).toContain('rhythm');
    expect(g).toContain('hook');
    expect(g).toContain('严禁过多使用"静止"');
    // 关键:给出扩词候选,不是只 5 个
    expect(g).toMatch(/过肩|穿拍|俯拍/);
  });
});
