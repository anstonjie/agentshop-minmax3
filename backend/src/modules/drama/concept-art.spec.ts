// ============================================================================
// concept-art 单测 —— 钉住 v3 定妆提示词的结构不变量
// ----------------------------------------------------------------------------
// 这四视图提示词是踩坑调出来的(背面画成正面 / turnaround 画成多人合影 /
// 抽象负向词压不住脸部先验)。没有测试的话,任何人"顺手优化一下"就能把
// 整套调优悄悄退回去。这里断言的是结构,不是逐字节文案。
// ============================================================================
import {
  ANGLE_CONFIGS, CONCEPT_SIZES, planAssetShots,
  buildCharacterViewPrompt, buildScenePrompt, buildPropPrompt,
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

  it('场景 = 1 张横幅 establishing shot,无负向词', () => {
    const shots = planAssetShots('location', { name: '码头', description: '雨夜木栈桥' }, '写实');
    expect(shots).toHaveLength(1);
    expect(shots[0].size).toBe(CONCEPT_SIZES.location);
    expect(shots[0].prompt).toContain('wide establishing shot');
    expect(shots[0].negative).toBe('');
  });

  it('道具 = 1 张方图白底产品图', () => {
    const shots = planAssetShots('prop', { name: '钥匙', description: '黄铜老钥匙' }, '写实');
    expect(shots).toHaveLength(1);
    expect(shots[0].size).toBe(CONCEPT_SIZES.prop);
    expect(shots[0].prompt).toContain('centered on white background');
  });

  it('角色缺 appearance 时回落 description 再回落 name,不产空提示词', () => {
    const shots = planAssetShots('character', { name: '陈默' }, '写实');
    expect(shots[0].prompt).toContain('陈默');
    expect(shots[0].prompt).not.toContain(', ,');
  });

  it('未识别的 kind 按道具兜底,而不是静默产 0 张图', () => {
    const shots = planAssetShots('vehicle', { name: '渔船', description: '木质拖网船' }, '写实');
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].prompt).toContain('木质拖网船');
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

describe('buildScenePrompt / buildPropPrompt 拼接风格锚', () => {
  it('风格词总在末尾,便于全剧统一强拼接', () => {
    expect(buildScenePrompt('机房', '水墨国风').endsWith('水墨国风')).toBe(true);
    expect(buildPropPrompt('钥匙', '水墨国风').endsWith('水墨国风')).toBe(true);
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
