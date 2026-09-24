// ============================================================================
// concept-art 单测 —— 钉住 v3 定妆提示词的结构不变量
// ----------------------------------------------------------------------------
// 这四视图提示词是踩坑调出来的(背面画成正面 / turnaround 画成多人合影 /
// 抽象负向词压不住脸部先验)。没有测试的话,任何人"顺手优化一下"就能把
// 整套调优悄悄退回去。这里断言的是结构,不是逐字节文案。
// ============================================================================
import {
  ANGLE_CONFIGS, CONCEPT_SIZES, planAssetShots, planPortraitGeneration,
  buildCharacterViewPrompt, buildScenePrompt, buildPropPrompt, buildWardrobePrompt,
  buildVehiclePrompt,
  WARDROBE_NEGATIVE, VEHICLE_NEGATIVE, PROP_NEGATIVE, LOCATION_NEGATIVE,
  refFileTag, portraitFileTag,
} from './concept-art';

describe('ANGLE_CONFIGS 四视图结构', () => {
  it('恰好四个角度,顺序为 正面/侧面/背面/全身姿势', () => {
    expect(ANGLE_CONFIGS.map((a) => a.label)).toEqual(['正面', '侧面', '背面', '全身姿势']);
  });

  it('T-pose 只允许出现在正面 —— 否则背面/侧面会被模型拉回正面站姿', () => {
    const tpose = ANGLE_CONFIGS.filter((a) => a.pose.includes('T-pose') && !a.pose.includes('NOT T-pose'));
    expect(tpose.map((a) => a.label)).toEqual(['正面']);
  });

  it('每个角度的强权重关键词前置在提示词最开头', () => {
    for (const ac of ANGLE_CONFIGS) {
      expect(ac.en).toMatch(/^\([a-z -]+:\d\.\d\)/);
      const prompt = buildCharacterViewPrompt('某角色外貌', ac, '电影质感');
      expect(prompt.startsWith(ac.en)).toBe(true);
    }
  });

  it('所有角度都带单人约束,防 turnaround 被画成多人合影', () => {
    for (const ac of ANGLE_CONFIGS) {
      const prompt = buildCharacterViewPrompt('某角色外貌', ac, '电影质感');
      expect(prompt).toContain('single character only');
      expect(prompt).toContain('no other people');
    }
  });

  it('背面的负向词列具体面部特征而非抽象词,且声明只看到后脑勺', () => {
    const back = ANGLE_CONFIGS.find((a) => a.label === '背面')!;
    expect(back.negative).toMatch(/face/i);
    expect(back.negative).toMatch(/eyes/i);
    expect(back.negative).toMatch(/mouth/i);
    expect(back.en).toContain('ONLY back of head');
  });

  it('侧面与动态姿势的负向词都排除 T-pose 与正脸', () => {
    for (const label of ['侧面', '全身姿势']) {
      const ac = ANGLE_CONFIGS.find((a) => a.label === label)!;
      expect(ac.negative).toContain('T-pose');
    }
  });
});

describe('planAssetShots 每类资产出几张图', () => {
  it('角色 = 4 张,竖幅全身画幅,首张是正面', () => {
    const shots = planAssetShots('character', { name: '林越', appearance: '短发女性' }, '冷色调');
    expect(shots).toHaveLength(4);
    expect(shots[0].angle).toBe('正面');
    for (const sh of shots) {
      expect(sh.size).toBe(CONCEPT_SIZES.character);
      expect(sh.negative.length).toBeGreaterThan(0);
      expect(sh.prompt).toContain('短发女性');
      expect(sh.prompt).toContain('full body from head to toe visible');
      expect(sh.prompt).toContain('冷色调');
    }
  });

  // 2026-09-23 批5:场景参考图带路人会经图生图带进关键帧 → 空景约束 + 负向词
  it('场景 = 1 张横幅 establishing shot,空景无人且带负向词', () => {
    const shots = planAssetShots('location', { name: '码头', description: '雨夜木栈桥' }, '写实');
    expect(shots).toHaveLength(1);
    expect(shots[0].size).toBe(CONCEPT_SIZES.location);
    expect(shots[0].prompt).toContain('wide establishing shot');
    expect(shots[0].prompt).toMatch(/empty scene|no people/i);
    expect(shots[0].negative).toBe(LOCATION_NEGATIVE);
    expect(shots[0].negative).toMatch(/people|person/i);
  });

  // 2026-09-23 批5:product shot 语料常带手持/人手 → 道具必须带负向词
  it('道具 = 1 张方图白底产品图,带禁人物/手持的负向词', () => {
    const shots = planAssetShots('prop', { name: '钥匙', description: '黄铜老钥匙' }, '写实');
    expect(shots).toHaveLength(1);
    expect(shots[0].size).toBe(CONCEPT_SIZES.prop);
    expect(shots[0].prompt).toContain('centered on white background');
    expect(shots[0].negative).toBe(PROP_NEGATIVE);
    expect(shots[0].negative).toMatch(/hand|people/i);
    expect(shots[0].prompt).toMatch(/not held|no people|no hands/i);
  });

  // 2026-09-23 批5:载具落 prop 兜底会画成方图 "prop design",还可能带司机/乘客
  it('载具 = 1 张横幅专用提示词,禁驾驶员与人物,不落道具兜底', () => {
    const shots = planAssetShots('vehicle', { name: '渔船', description: '木质拖网船' }, '写实');
    expect(shots).toHaveLength(1);
    expect(shots[0].size).toBe(CONCEPT_SIZES.vehicle);
    expect(shots[0].prompt).toContain('木质拖网船');
    expect(shots[0].prompt).toMatch(/no driver/i);
    expect(shots[0].prompt).not.toContain('prop design');
    expect(shots[0].negative).toBe(VEHICLE_NEGATIVE);
    expect(shots[0].negative).toMatch(/driver/i);
    expect(shots[0].negative).toMatch(/people|person/i);
  });

  // 2026-09-23 回归:服装落道具兜底会画出"模特上身图"(资产库里出现人的头像)
  it('服装 = 1 张,专用提示词禁人物,且带负向词(不再落道具兜底)', () => {
    const shots = planAssetShots('wardrobe', { name: '亚麻衬衫', description: '米白色亚麻衬衫,小翻领' }, '写实');
    expect(shots).toHaveLength(1);
    expect(shots[0].size).toBe(CONCEPT_SIZES.wardrobe);
    expect(shots[0].prompt).toContain('clothing only');
    expect(shots[0].prompt).toContain('no model');
    expect(shots[0].prompt).toContain('米白色亚麻衬衫');
    expect(shots[0].prompt).not.toContain('prop design');
    expect(shots[0].negative).toBe(WARDROBE_NEGATIVE);
    expect(shots[0].negative).toMatch(/face/i);
  });

  it('角色缺 appearance 时回落 description 再回落 name,不产空提示词', () => {
    const shots = planAssetShots('character', { name: '陈默' }, '写实');
    expect(shots[0].prompt).toContain('陈默');
    expect(shots[0].prompt).not.toContain(', ,');
  });

  it('未识别的 kind 按道具兜底,而不是静默产 0 张图', () => {
    const shots = planAssetShots('gadget', { name: '仪器', description: '黄铜仪器' }, '写实');
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].prompt).toContain('黄铜仪器');
    expect(shots[0].prompt).toContain('prop design');
  });
});

// 2026-09-23 批5:refs 顺序错乱 bug —— 复用与待生成交错时,旧实现先 push 复用、
// 后 push 新画结果,refs 顺序 ≠ shots 顺序 → QC 取 shots[qcIdx] 提示词错位、
// portraitFileTag(qcIdx) 文件名错、重画用错提示词。必须按下标回填。
describe('planPortraitGeneration refs 按位回填(防 QC/文件名错位)', () => {
  const shots = ANGLE_CONFIGS.map((ac) => ({
    angle: ac.label, prompt: `p-${ac.label}`, negative: '', size: '864x1152',
  }));

  it('复用(正面/背面)与待生成(侧面/全身)交错时 slots 仍与 shots 顺序对齐', () => {
    const prevRefs = [
      { angle: '正面', url: '/uploads/a/1-正面.png', alive: true },
      { angle: '背面', url: '/uploads/a/3-背面.png', alive: true },
    ];
    const { slots, pending } = planPortraitGeneration(shots, prevRefs, false, 1700000000000);
    expect(slots.map((s) => s?.angle ?? null)).toEqual(['正面', null, '背面', null]);
    expect(slots[0].url).toBe('/uploads/a/1-正面.png');
    expect(pending.map((p) => p.idx)).toEqual([1, 3]);
    expect(pending[0].sh.angle).toBe('侧面');
    expect(pending[1].sh.angle).toBe('全身姿势');
    // 待生成槽位拿到的 tag 必须是**该下标自己**的角度(而不是复用交错后的错位角度)
    expect(pending[0].tag).toBe(portraitFileTag(1, '侧面', false));
    expect(pending[1].tag).toBe(portraitFileTag(3, '全身姿势', false));
  });

  it('复用的槽位带 angle 且 canonical 置 false(canonical 由上层统一回填)', () => {
    const prevRefs = [{ angle: '侧面', url: '/u/2.png', alive: true }];
    const { slots } = planPortraitGeneration(shots, prevRefs, false, 1);
    expect(slots[1].angle).toBe('侧面');
    expect(slots[1].canonical).toBe(false);
    expect(slots[0]).toBeNull();
  });

  it('force 时全部待生成,prev 仍带回供失败兜底', () => {
    const prevRefs = [{ angle: '正面', url: '/u/1.png', alive: true }];
    const { slots, pending } = planPortraitGeneration(shots, prevRefs, true, 1700000000000);
    expect(slots.every((s) => s === null)).toBe(true);
    expect(pending).toHaveLength(4);
    expect(pending[0].prev?.url).toBe('/u/1.png');
    expect(pending[0].tag).toMatch(/-1700000000000$/); // force 换名防缓存
  });

  it('alive=false 的旧图不复用(进 pending 补画)', () => {
    const prevRefs = [{ angle: '正面', url: '/u/1.png', alive: false }];
    const { slots, pending } = planPortraitGeneration(shots, prevRefs, false, 1);
    expect(slots[0]).toBeNull();
    expect(pending.map((p) => p.idx)).toContain(0);
  });
});

describe('refFileTag 落地文件名', () => {
  it('中文角度保留,括号等符号压成下划线', () => {
    expect(refFileTag(0, '正面')).toBe('1-正面');
    expect(refFileTag(1, '侧面全身视角(90度侧脸)')).toMatch(/^2-侧面全身视角_90度侧脸_?$/);
  });
  it('空角度回落 ref,不产生非法文件名', () => {
    expect(refFileTag(2, '')).toBe('3-ref');
  });
});

describe('portraitFileTag 换名规则(防缓存假生效)', () => {
  it('增量补画用稳定角度文件名', () => {
    expect(portraitFileTag(0, '正面', false)).toBe('1-正面');
  });
  it('强制重画必须换名 —— 同名覆盖会让 URL 不变,前端继续显示旧图', () => {
    const t = portraitFileTag(0, '正面', true, 1700000000000);
    expect(t).toBe('1-正面-1700000000000');
    expect(t).not.toBe(portraitFileTag(0, '正面', false));
  });
  it('同一秒内不同角度仍互不覆盖', () => {
    const now = 1700000000000;
    const tags = ANGLE_CONFIGS.map((a2, i) => portraitFileTag(i, a2.label, true, now));
    expect(new Set(tags).size).toBe(ANGLE_CONFIGS.length);
  });
});

describe('buildScenePrompt / buildPropPrompt / buildWardrobePrompt / buildVehiclePrompt 拼接风格锚', () => {
  it('风格词总在末尾,便于全剧统一强拼接', () => {
    expect(buildScenePrompt('机房', '水墨国风').endsWith('水墨国风')).toBe(true);
    expect(buildPropPrompt('钥匙', '水墨国风').endsWith('水墨国风')).toBe(true);
    expect(buildWardrobePrompt('米白衬衫', '水墨国风').endsWith('水墨国风')).toBe(true);
    expect(buildVehiclePrompt('渔船', '水墨国风').endsWith('水墨国风')).toBe(true);
  });
});

import { stripActionForRefSheet } from './concept-art';

describe('stripActionForRefSheet —— 定妆提示词动作子句剥离(2026-09-16 批4)', () => {
  it('剥掉「双手敲击键盘」类动作子句,外貌描述保留,并补不持物声明', () => {
    const r = stripActionForRefSheet(
      '戴着厚重的黑框眼镜，穿着宽松的格子衬衫和牛仔裤，体型微胖，表情总是带着怯懦与紧张，但双手敲击键盘时却异常稳定。');
    expect(r.stripped).toBe(true);
    expect(r.text).not.toContain('敲击键盘');
    expect(r.text).toContain('黑框眼镜');
    expect(r.text).toContain('格子衬衫');
    expect(r.text).toContain('双手自然放松垂放或张开,不持任何物品');
  });

  it('无动作子句原样返回(stripped=false)', () => {
    const r = stripActionForRefSheet('短发，黑色风衣，气质冷冽。');
    expect(r.stripped).toBe(false);
    expect(r.text).toBe('短发，黑色风衣，气质冷冽。');
  });

  it('连续调用不受 /g lastIndex 状态污染(早退路径后仍能命中)', () => {
    expect(stripActionForRefSheet('无动作描述').stripped).toBe(false);
    expect(stripActionForRefSheet('双手握刀站立').stripped).toBe(true);
    expect(stripActionForRefSheet('无动作描述').stripped).toBe(false);
  });

  it('planAssetShots 角色参考图 prompt 不含动作子句', () => {
    const shots = planAssetShots('character', {
      name: '林一',
      appearance: '格子衬衫，体型微胖，但双手敲击键盘时却异常稳定。',
    }, '写实');
    for (const s of shots) {
      expect(s.prompt).not.toContain('敲击键盘');
    }
  });
});
