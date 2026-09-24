// ============================================================================
// episode-outline-prompt 单测 —— 承接提示词是"集集连起来"的唯一入口,
// 漏喂一条既定事实,下一集就可能让死人复活。
// ============================================================================
import {
  buildEpisodeOutlinePrompt, normalizeEpisodeOutline,
  MAX_ESTABLISHED_FACTS,
} from './episode-outline-prompt';

describe('buildEpisodeOutlinePrompt 承接信息注入', () => {
  const base = {
    dramaTitle: '雾港灯塔', epNo: 3,
    bible: { world: '1990s 渔港', era: '1990s', genre: '悬疑', tone: '压抑', rules: ['灯塔必须有人值守'] },
    snapshot: {
      establishedFacts: ['林越发现第七任守塔人登记簿', '钥匙不见了'],
      characterStates: { char_linyue: '受伤,在灯塔' },
      openHooks: ['谁搬走了灯芯'],
    },
    storyArcItem: { purpose: '揭示守塔人身份反转', cliffhanger: '电话亭录像', mustHave: ['海底隧道'] },
    hookIn: '钥匙不见了',
    assetIndex: [
      { slug: 'char_linyue', name: '林越', kind: 'character', variants: ['战斗负伤'] },
      { slug: 'loc_room', name: '控制室', kind: 'location' },
    ],
  };

  it('系统提示写死两条铁律:不得违反既定事实、不得用文字描述长相', () => {
    const { system } = buildEpisodeOutlinePrompt(base as any);
    expect(system).toContain('不得与「已确立事实」冲突');
    expect(system).toContain('禁止写人物长相与服装');
    expect(system).toContain('开场必须自然接住');
  });

  it('用户提示逐条注入既定事实 / 角色状态 / 未解悬念', () => {
    const { user } = buildEpisodeOutlinePrompt(base as any);
    expect(user).toContain('- 林越发现第七任守塔人登记簿');
    expect(user).toContain('- 钥匙不见了');
    expect(user).toContain('角色当前状态');
    expect(user).toContain('谁搬走了灯芯');
  });

  it('注入本集使命、必须出现项、指定结尾钩子与开场钩子', () => {
    const { user } = buildEpisodeOutlinePrompt(base as any);
    expect(user).toContain('本集使命:揭示守塔人身份反转');
    expect(user).toContain('必须出现:海底隧道');
    expect(user).toContain('指定结尾钩子:电话亭录像');
    expect(user).toContain('本集开场要接住:钥匙不见了');
  });

  it('资产索引带 slug 与变体,让 LLM 复用而非另造', () => {
    const { user } = buildEpisodeOutlinePrompt(base as any);
    expect(user).toContain('[角色] 林越 (slug: char_linyue)|变体:战斗负伤');
    expect(user).toContain('[场景] 控制室 (slug: loc_room)');
  });

  it('第一集没有既定事实与前置钩子时给出明确占位,不留空洞', () => {
    const { user } = buildEpisodeOutlinePrompt({
      dramaTitle: '新剧', epNo: 1, snapshot: {}, assetIndex: [],
    } as any);
    expect(user).toContain('本剧第一集,尚无既定事实');
    expect(user).toContain('资产库为空');
    expect(user).not.toContain('本集开场要接住');
  });

  it('既定事实过多时截断,防止长剧集撑爆提示词', () => {
    const many = Array.from({ length: MAX_ESTABLISHED_FACTS + 25 }, (_, i) => `事实${i}`);
    const { user } = buildEpisodeOutlinePrompt({
      dramaTitle: '长剧', epNo: 9, snapshot: { establishedFacts: many },
    } as any);
    expect(user).toContain(`事实${MAX_ESTABLISHED_FACTS + 24}`);
    expect(user).not.toContain('- 事实0\n');
    for (const line of user.split('\n')) {
      if (line.startsWith('- 事实')) expect(Number(line.replace('- 事实', '')))
        .toBeGreaterThanOrEqual(25);
    }
  });

  it('用户额外要求与目标时长透传', () => {
    const { user } = buildEpisodeOutlinePrompt({
      ...base, userBrief: '本集不要出现新角色', targetSec: 180,
    } as any);
    expect(user).toContain('用户额外要求:本集不要出现新角色');
    expect(user).toContain('目标时长:约 180 秒');
  });

  it('输出契约要求 needs_assets 与 hook_out,否则下游预检和承接会断链', () => {
    const { user } = buildEpisodeOutlinePrompt(base as any);
    expect(user).toContain('"needs_assets"');
    expect(user).toContain('"hook_out"');
    expect(user).toContain('"established_facts_new"');
    expect(user).toContain('"character_states"');
  });

  // 2026-09-24:场景契约补 vehicles/wardrobe —— 大纲层不给字段,
  // collectNeeds / 分镜永远扫不到载具与服装
  it('scenes 输出契约带 vehicles/wardrobe 数组', () => {
    const { user } = buildEpisodeOutlinePrompt(base as any);
    expect(user).toContain('"vehicles"');
    expect(user).toContain('"wardrobe"');
  });

  // 2026-09-23 批5:契约只写 character|location|prop,LLM 照契约给不出
  // vehicle/wardrobe → 载具/服装需求在大纲层就断了
  it('needs_assets kind 契约覆盖全部五类(含 vehicle/wardrobe)', () => {
    const { system, user } = buildEpisodeOutlinePrompt(base as any);
    expect(user).toContain('character|location|prop|vehicle|wardrobe');
    expect(system).toContain('服装只写衣服本身');
  });

  // ── 2026-09-23 叙事对齐:禁凑戏 + beat_ids 1:1 映射 ──
  it('system 禁止为凑时长发明新主线,只允许深化已有拍点', () => {
    const { system } = buildEpisodeOutlinePrompt(base as any);
    expect(system).toContain('禁止发明与原文、使命无关的新主线来凑秒数');
    expect(system).toContain('深化已有场景/拍点');
    expect(system).not.toContain('内容不够就把场景写足、把冲突写透,而不是交一个比目标短一半的本子');
  });

  it('有原文锚点时 system 要求 beat_ids 且 [必拍] 全覆盖', () => {
    const { system, user } = buildEpisodeOutlinePrompt({
      ...base,
      beatsAnchor: '- {ch1-b1} [必拍] 林越发现登记簿:「第七任守塔人是谁」',
      chapterExcerpt: '原文摘录……',
    } as any);
    expect(system).toContain('beat 1:1 映射');
    expect(system).toContain('beat_ids');
    expect(system).toContain('把已有拍点写深');
    expect(system).toContain('禁止为凑时长发明锚点/摘录里没有的新主线情节');
    expect(user).toContain('"beat_ids"');
    expect(user).toContain('本集原文锚点');
  });

  it('无锚点时不渲染 beat_ids 硬规则(避免误导纯原创集)', () => {
    const { system } = buildEpisodeOutlinePrompt(base as any);
    expect(system).not.toContain('beat 1:1 映射');
  });
});

describe('normalizeEpisodeOutline', () => {
  it('补齐场景序号/时长/引用数组,给前端稳定结构', () => {
    const { outline, warnings } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ summary: 'a' }, { summary: 'b' }],
    });
    expect(outline.scenes[0].idx).toBe(1);
    expect(outline.scenes[1].idx).toBe(2);
    expect(outline.scenes[0].estimated_sec).toBe(30);
    expect(outline.scenes[0].characters).toEqual([]);
    expect(outline.scenes[0].props).toEqual([]);
    expect(outline.scenes[0].vehicles).toEqual([]);
    expect(outline.scenes[0].wardrobe).toEqual([]);
    expect(outline.established_facts_new).toEqual([]);
    expect(outline.character_states).toEqual({});
    expect(warnings.some((w) => w.includes('结尾钩子'))).toBe(true);
  });

  // 2026-09-24:场景引用归一 —— 与 characters/props 同路径,供 collectNeeds 扫
  it('normalize:场景 vehicles/wardrobe 归一为字符串数组、去重', () => {
    const { outline } = normalizeEpisodeOutline({
      scenes: [{ idx: 1, vehicles: ['veh_boat', 'veh_boat', ''], wardrobe: ['wd_coat', 5] }],
    });
    expect(outline.scenes[0].vehicles).toEqual(['veh_boat']);
    expect(outline.scenes[0].wardrobe).toEqual(['wd_coat', '5']);
  });

  it('完全没有场景时告警,不静默返回可用假象', () => {
    const { warnings } = normalizeEpisodeOutline({ title: 'T' });
    expect(warnings).toContain('LLM 未返回任何场景,本集大纲不可用');
  });

  it('needs_assets 缺 slug 时补临时 slug 并告警提示改名', () => {
    const { outline, warnings } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ idx: 1 }],
      needs_assets: [{ kind: 'character', name: '老周', descVisual: '独眼老船工' }],
    });
    expect(outline.needs_assets[0].slug).toMatch(/^charac?_auto_\d$|^char_auto_\d$/);
    expect(warnings.some((w) => w.includes('临时使用'))).toBe(true);
  });

  it('slug 重复时自动改名并告警,避免资产库唯一键冲突', () => {
    const { outline, warnings } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ idx: 1 }],
      needs_assets: [
        { kind: 'prop', name: '钥匙', slug: 'prop_key' },
        { kind: 'prop', name: '另一把钥匙', slug: 'prop_key' },
      ],
    });
    expect(outline.needs_assets[0].slug).toBe('prop_key');
    expect(outline.needs_assets[1].slug).not.toBe('prop_key');
    expect(warnings.some((w) => w.includes('slug 重复'))).toBe(true);
  });

  it('缺 kind 或 name 的需求被跳过并告警,不污染资产库', () => {
    const { outline, warnings } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ idx: 1 }],
      needs_assets: [{ kind: 'prop' }, { name: '没类别' }, { kind: 'prop', name: '正常道具', slug: 'prop_ok' }],
    });
    expect(outline.needs_assets).toHaveLength(1);
    expect(outline.needs_assets[0].slug).toBe('prop_ok');
    expect(warnings.filter((w) => w.includes('跳过')).length).toBe(2);
  });

  it('slug 大小写/中文/连字符统一压成小写下划线', () => {
    const { outline } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ idx: 1 }],
      needs_assets: [{ kind: 'character', name: '林越', slug: 'Char-Lin Yue' }],
    });
    expect(outline.needs_assets[0].slug).toBe('char_lin_yue');
  });

  it('variantHint 与 descPersona 透传给预检', () => {
    const { outline } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ idx: 1 }],
      needs_assets: [{
        kind: 'character', name: '林越', slug: 'char_linyue',
        descPersona: '刑警', variantHint: '婚纱造型',
      }],
    });
    expect(outline.needs_assets[0].variantHint).toBe('婚纱造型');
    expect(outline.needs_assets[0].descPersona).toBe('刑警');
  });

  // 2026-09-23 批5:非法 kind 流到 createAsset 抛 400 → resolvePrecheck 中途断,
  // 已应用的裁决无事务回滚。normalize 层先拦。
  it('白名单外的 kind 被丢弃并告警,vehicle/wardrobe 合法保留', () => {
    const { outline, warnings } = normalizeEpisodeOutline({
      title: 'T', scenes: [{ idx: 1 }],
      needs_assets: [
        { kind: 'vehicle', name: '渔船', slug: 'veh_boat', descVisual: '木质拖网船' },
        { kind: 'wardrobe', name: '风衣', slug: 'wd_coat', descVisual: '卡其风衣' },
        { kind: 'weapon', name: '长刀', slug: 'wx_knife', descVisual: '刃有缺口' },
        { kind: 'CHARACTER', name: '配角', slug: 'char_x', descVisual: '络腮胡' },
      ],
    });
    expect(outline.needs_assets.map((n: any) => n.kind))
      .toEqual(['vehicle', 'wardrobe', 'character']);
    expect(warnings.some((w) => w.includes('weapon'))).toBe(true);
  });

  it('LLM 返回完全不可解析时不崩', () => {
    expect(() => normalizeEpisodeOutline(null)).not.toThrow();
    expect(() => normalizeEpisodeOutline(undefined)).not.toThrow();
    expect(() => normalizeEpisodeOutline('not json')).not.toThrow();
  });
});

import { outlineQuoteStats } from './episode-outline-prompt';

describe('quotes 逐字锚点(2026-09-16 批2)', () => {
  it('normalize:quotes 归一为字符串数组、去重、上限 3', () => {
    const { outline } = normalizeEpisodeOutline({
      scenes: [{ idx: 1, quotes: ['a', 'a', 'b', 'c', 'd', 5, ''] }],
    });
    expect(outline.scenes[0].quotes).toEqual(['a', 'b', 'c']);
  });

  it('缺 quotes 字段补空数组(纯衔接场合法)', () => {
    const { outline } = normalizeEpisodeOutline({ scenes: [{}] });
    expect(outline.scenes[0].quotes).toEqual([]);
  });

  // 2026-09-23:beat_ids 归一(与 quotes 同路径)
  it('normalize:beat_ids 归一为字符串数组、去重、上限 8', () => {
    const { outline } = normalizeEpisodeOutline({
      scenes: [{ idx: 1, beat_ids: ['ch1-b1', 'ch1-b1', 'ch1-b2', 7, ''] }],
    });
    expect(outline.scenes[0].beat_ids).toEqual(['ch1-b1', 'ch1-b2', '7']);
    expect(outline.scenes[0].beat_ids.length).toBeLessThanOrEqual(8);
  });

  it('缺 beat_ids 字段补空数组(无锚点集合法)', () => {
    const { outline } = normalizeEpisodeOutline({ scenes: [{}] });
    expect(outline.scenes[0].beat_ids).toEqual([]);
  });

  it('outlineQuoteStats 汇总场数/引用场数/扁平 quotes', () => {
    const s = outlineQuoteStats({ scenes: [{ quotes: ['x', 'y'] }, { quotes: [] }, { quotes: ['y'] }] });
    expect(s).toEqual({ scenes: 3, withQuotes: 2, quotes: ['x', 'y'] });
  });

  it('stats 空大纲安全', () => {
    expect(outlineQuoteStats(null)).toEqual({ scenes: 0, withQuotes: 0, quotes: [] });
  });
});

// 2026-09-24:场景资产引用扁平化 —— collectNeeds / 预检共用同一扫描口径
import { sceneAssetSlugs } from './episode-outline-prompt';

describe('sceneAssetSlugs', () => {
  it('汇出 characters/props/vehicles/wardrobe/location 全部引用', () => {
    expect(sceneAssetSlugs({
      characters: ['c1'], props: ['p1'], vehicles: ['v1'], wardrobe: ['w1'],
      location_id: 'loc1', location: '码头',
    })).toEqual(['c1', 'p1', 'v1', 'w1', 'loc1', '码头']);
  });

  it('缺字段不炸,空场景返回空数组', () => {
    expect(sceneAssetSlugs({})).toEqual([]);
    expect(sceneAssetSlugs(null)).toEqual([]);
  });
});
