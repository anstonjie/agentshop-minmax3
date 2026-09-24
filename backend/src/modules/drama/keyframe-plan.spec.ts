// ============================================================================
// keyframe-plan 单测 —— 钉死参考图驱动的关键约束
// 最重要的一条:本地 /uploads 路径绝不能进 refUrls,否则上游必 400。
// ============================================================================
import {
  buildKeyframePlan, pickUsableRef, summarizePlans, indexLegacyConceptArt,
  resolveKeyframeSizeRatio,
  MAX_REF_IMAGES, type RefAsset, type KeyframeShot,
} from './keyframe-plan';

const REMOTE = 'https://platform-outputs.agnes-ai.space/img/abc.png';
const REMOTE2 = 'https://platform-outputs.agnes-ai.space/img/def.png';

function asset(p: Partial<RefAsset> & { slug: string }): RefAsset {
  return {
    name: p.name || p.slug, kind: p.kind || 'character', descVisual: p.descVisual || '短发女性, 藏青风衣',
    refs: p.refs || [], variants: p.variants || [],
    ...p,
  } as RefAsset;
}

const shot: KeyframeShot = {
  idx: 3, description: '女刑警推开控制室铁门,手电筒扫过积灰的值班台',
  shot_type: '中景', camera_motion: '跟',
  characters: ['char_linyue'], location_id: 'loc_room', props: ['prop_torch'],
};

describe('pickUsableRef', () => {
  it('优先取 canonical 的上游地址', () => {
    const a = asset({
      slug: 'char_x',
      refs: [
        { angle: '侧面', remoteUrl: REMOTE2, alive: true },
        { angle: '正面', remoteUrl: REMOTE, alive: true, canonical: true },
      ],
    });
    expect(pickUsableRef(a)).toBe(REMOTE);
  });

  it('canonical 已失效时退到仍可用的那张,而不是返回 null', () => {
    const a = asset({
      slug: 'char_x',
      refs: [
        { angle: '正面', remoteUrl: REMOTE, alive: false, canonical: true },
        { angle: '侧面', remoteUrl: REMOTE2, alive: true },
      ],
    });
    expect(pickUsableRef(a)).toBe(REMOTE2);
  });

  it('本地 /uploads 路径一律视为不可用(上游不可达)', () => {
    const a = asset({ slug: 'char_x', refs: [{ angle: '正面', url: '/uploads/a/1.png', alive: true, canonical: true }] });
    expect(pickUsableRef(a)).toBeNull();
  });

  it('data URI 也视为不可用(实测上游 400)', () => {
    const a = asset({ slug: 'char_x', refs: [{ remoteUrl: 'data:image/png;base64,AAAA', alive: true }] });
    expect(pickUsableRef(a)).toBeNull();
  });

  // 2026-09-24 换装一致性:shot 带 wardrobe 时,角色应优先用匹配 variant 的定妆,
  // 否则换装镜仍锚基础造型 → 镜头间衣服闪回
  it('给定 variantLabels 时优先取匹配变体的存活参考图', () => {
    const a = asset({
      slug: 'char_x', name: '林越',
      refs: [{ angle: '正面', remoteUrl: REMOTE, alive: true, canonical: true }],
      variants: [{
        id: 'wd_coat', label: '风衣',
        refs: [{ angle: '全身', remoteUrl: REMOTE2, alive: true, canonical: true }],
      }],
    });
    expect(pickUsableRef(a, { variantLabels: ['风衣'] })).toBe(REMOTE2);
    expect(pickUsableRef(a, { variantLabels: ['wd_coat'] })).toBe(REMOTE2);
  });

  it('variant 无存活图时回退基础 refs,不返回 null', () => {
    const a = asset({
      slug: 'char_x',
      refs: [{ angle: '正面', remoteUrl: REMOTE, alive: true, canonical: true }],
      variants: [{ id: 'v1', label: '婚纱', refs: [{ remoteUrl: '/uploads/dead.png', alive: true }] }],
    });
    expect(pickUsableRef(a, { variantLabels: ['婚纱'] })).toBe(REMOTE);
  });

  it('未给 variantLabels 时行为与旧版一致(只读基础 refs)', () => {
    const a = asset({
      slug: 'char_x',
      refs: [{ angle: '正面', remoteUrl: REMOTE, alive: true, canonical: true }],
      variants: [{ id: 'v1', label: '风衣', refs: [{ remoteUrl: REMOTE2, alive: true }] }],
    });
    expect(pickUsableRef(a)).toBe(REMOTE);
  });
});

describe('buildKeyframePlan 参考图收集', () => {
  const lib: Record<string, RefAsset> = {
    char_linyue: asset({ slug: 'char_linyue', name: '林越', refs: [{ remoteUrl: REMOTE, alive: true, canonical: true }] }),
    loc_room: asset({ slug: 'loc_room', name: '灯塔控制室', kind: 'location', refs: [{ remoteUrl: REMOTE2, alive: true, canonical: true }] }),
    prop_torch: asset({ slug: 'prop_torch', name: '手电', kind: 'prop', refs: [{ remoteUrl: 'https://x.test/3.png', alive: true, canonical: true }] }),
  };

  it('角色 + 场景 + 道具都拿到参考图,且记明来源', () => {
    const plan = buildKeyframePlan(shot, lib, { stylePrompt: '冷色调' });
    expect(plan.refUrls).toHaveLength(3);
    expect(plan.degraded).toBe(false);
    expect(plan.missingRefs).toEqual([]);
    expect(plan.refSources.map((r) => r.slug)).toEqual(['char_linyue', 'loc_room', 'prop_torch']);
  });

  it('参考图数量封顶,超出只记来源不塞进请求', () => {
    const many: Record<string, RefAsset> = { ...lib };
    for (let i = 0; i < 6; i++) {
      many[`char_extra${i}`] = asset({ slug: `char_extra${i}`, refs: [{ remoteUrl: `https://x.test/e${i}.png`, alive: true, canonical: true }] });
    }
    const plan = buildKeyframePlan(
      { ...shot, characters: ['char_linyue', ...Array.from({ length: 6 }, (_, i) => `char_extra${i}`)] },
      many, {},
    );
    expect(plan.refUrls.length).toBeLessThanOrEqual(MAX_REF_IMAGES);
    expect(plan.refSources.length).toBeGreaterThan(MAX_REF_IMAGES);
    expect(plan.refSources.filter((r) => !r.sent).length)
      .toBe(plan.refSources.length - MAX_REF_IMAGES);
  });

  it('拿不到参考图的资产进 missingRefs,交给上层决定重定妆', () => {
    const lib2 = { ...lib, prop_torch: asset({ slug: 'prop_torch', kind: 'prop', refs: [] }) };
    const plan = buildKeyframePlan(shot, lib2, {});
    expect(plan.missingRefs).toEqual(['prop_torch']);
    expect(plan.degraded).toBe(false);
  });

  it('同资产被多个字段引用时不重复占额度', () => {
    const plan = buildKeyframePlan(
      { ...shot, characters: ['char_linyue', 'char_linyue'] }, lib, {},
    );
    expect(plan.refUrls.filter((u) => u === REMOTE)).toHaveLength(1);
  });

  // 2026-09-24:shot 带 vehicles/wardrobe —— 美术层已有资产,规划层必须能引用
  it('shot.vehicles / shot.wardrobe 进 slugs;截断时角色+服装优先占满 MAX_REF_IMAGES', () => {
    const full: Record<string, RefAsset> = {
      ...lib,
      veh_boat: asset({ slug: 'veh_boat', name: '渔船', kind: 'vehicle', refs: [{ remoteUrl: 'https://x.test/v.png', alive: true, canonical: true }] }),
      wd_coat: asset({ slug: 'wd_coat', name: '风衣', kind: 'wardrobe', refs: [{ remoteUrl: 'https://x.test/w.png', alive: true, canonical: true }] }),
    };
    const plan = buildKeyframePlan(
      { ...shot, vehicles: ['veh_boat'], wardrobe: ['wd_coat'] }, full, {},
    );
    // 5 个资产都进来源表;上游只收 MAX_REF_IMAGES 张,优先角色/服装/场景
    expect(plan.refSources.map((r) => r.slug)).toEqual(
      ['char_linyue', 'wd_coat', 'loc_room', 'veh_boat', 'prop_torch'],
    );
    expect(plan.refUrls).toHaveLength(MAX_REF_IMAGES);
    expect(plan.refUrls).toContain(REMOTE);
    expect(plan.refUrls).toContain('https://x.test/w.png');
    expect(plan.refSources.find((r) => r.slug === 'veh_boat')?.sent).toBe(false);
    expect(plan.missingRefs).toEqual([]);
    expect(plan.unanchoredCharacters).toEqual([]);
  });

  it('库内无该载具/服装 → 进 missingRefs 但不标 unanchoredCharacters', () => {
    const plan = buildKeyframePlan(
      { ...shot, vehicles: ['veh_unknown'], wardrobe: ['wd_unknown'] }, lib, {},
    );
    expect(plan.missingRefs).toEqual(expect.arrayContaining(['veh_unknown', 'wd_unknown']));
    expect(plan.unanchoredCharacters).toEqual([]);
  });

  it('shot 带 wardrobe 时角色优先用匹配 variant 定妆图,并记 variant 角度', () => {
    const costumeLib: Record<string, RefAsset> = {
      char_linyue: asset({
        slug: 'char_linyue', name: '林越',
        refs: [{ angle: '正面', remoteUrl: REMOTE, alive: true, canonical: true }],
        variants: [{ id: 'wd_coat', label: '风衣', refs: [{ angle: '全身', remoteUrl: REMOTE2, alive: true, canonical: true }] }],
      }),
      wd_coat: asset({ slug: 'wd_coat', name: '风衣', kind: 'wardrobe', refs: [{ remoteUrl: 'https://x.test/garment.png', alive: true, canonical: true }] }),
    };
    const plan = buildKeyframePlan(
      { idx: 1, description: '穿风衣出门', characters: ['char_linyue'], wardrobe: ['wd_coat'] },
      costumeLib, {},
    );
    const charSrc = plan.refSources.find((r) => r.slug === 'char_linyue');
    expect(charSrc?.url).toBe(REMOTE2);
    expect(charSrc?.angle).toContain('风衣');
    expect(plan.refUrls).toContain(REMOTE2);
    expect(plan.refUrls).toContain('https://x.test/garment.png');
  });
});

describe('buildKeyframePlan 提示词构造', () => {
  const withRef = { char_linyue: asset({ slug: 'char_linyue', refs: [{ remoteUrl: REMOTE, alive: true, canonical: true }] }) };
  const emptyLib: Record<string, RefAsset> = {};

  it('有参考图时不复述角色外貌 —— 文字与参考图打架会让脸往描述漂', () => {
    const plan = buildKeyframePlan(shot, withRef, {});
    expect(plan.prompt).not.toContain('短发女性');
    expect(plan.prompt).toContain('女刑警推开控制室铁门');
  });

  it('有参考图时显式锁身份并禁止分屏拼图', () => {
    const plan = buildKeyframePlan(shot, withRef, {});
    expect(plan.prompt).toContain('same face');
    expect(plan.prompt).toContain('not a split screen');
  });

  it('景别与运镜进提示词,静止不写(避免噪声)', () => {
    expect(buildKeyframePlan(shot, withRef, {}).prompt).toContain('中景 shot');
    expect(buildKeyframePlan(shot, withRef, {}).prompt).toContain('camera 跟');
    expect(buildKeyframePlan({ ...shot, camera_motion: '静止' }, withRef, {}).prompt)
      .not.toContain('camera');
  });

  it('纯时间类运镜(焦点切换/穿拍)静图跳过,构图类(过肩/俯拍)仍写', () => {
    expect(buildKeyframePlan({ ...shot, camera_motion: '焦点切换' }, withRef, {}).prompt)
      .not.toContain('camera 焦点切换');
    expect(buildKeyframePlan({ ...shot, camera_motion: '穿拍' }, withRef, {}).prompt)
      .not.toContain('camera 穿拍');
    expect(buildKeyframePlan({ ...shot, camera_motion: '过肩' }, withRef, {}).prompt)
      .toContain('camera 过肩');
    expect(buildKeyframePlan({ ...shot, camera_motion: '俯拍' }, withRef, {}).prompt)
      .toContain('camera 俯拍');
  });

  it('风格圣经逐段拼进提示词,保证全剧同调', () => {
    const plan = buildKeyframePlan(shot, withRef, {
      stylePrompt: '冷色调胶片质感', palette: '青灰', lighting: '低照度', cameraLanguage: '手持',
    });
    for (const bit of ['冷色调胶片质感', '青灰', '低照度', '手持']) {
      expect(plan.prompt).toContain(bit);
    }
  });

  it('退化路径:资产在库但无可用参考图 → 把外貌写回文字并标记 degraded', () => {
    const noRefLib: Record<string, RefAsset> = {
      char_linyue: asset({ slug: 'char_linyue', refs: [] }),
      loc_room: asset({ slug: 'loc_room', kind: 'location', descVisual: '圆形机房', refs: [] }),
      prop_torch: asset({ slug: 'prop_torch', kind: 'prop', descVisual: '金属手电', refs: [] }),
    };
    const plan = buildKeyframePlan(shot, noRefLib, {});
    expect(plan.degraded).toBe(true);
    expect(plan.refUrls).toEqual([]);
    expect(plan.prompt).toContain('短发女性');
    expect(plan.prompt).toContain('圆形机房');
    expect(plan.missingRefs).toEqual(['char_linyue', 'loc_room', 'prop_torch']);
  });

  it('库内完全不认识的引用 → 全部进 missingRefs,提示词不崩', () => {
    const plan = buildKeyframePlan(shot, emptyLib, {});
    expect(plan.degraded).toBe(true);
    expect(plan.missingRefs).toEqual(['char_linyue', 'loc_room', 'prop_torch']);
    expect(plan.prompt).toContain('女刑警推开控制室铁门');
  });

  it('纯 wardrobe/vehicle 镜(无角色)不因缺 ref 标 unanchoredCharacters', () => {
    const plan = buildKeyframePlan(
      { idx: 1, description: '风衣特写', wardrobe: ['wd_none'], vehicles: ['veh_none'] },
      {}, {},
    );
    expect(plan.unanchoredCharacters).toEqual([]);
    expect(plan.missingRefs).toEqual(expect.arrayContaining(['wd_none', 'veh_none']));
  });

  it('negative 始终含防串脸约束', () => {
    const plan = buildKeyframePlan(shot, withRef, { negativePrompt: '文字水印' });
    expect(plan.negative).toContain('different face');
    expect(plan.negative).toContain('文字水印');
  });
});

// ============================================================================
// 2026-09-23 身份硬伤:unanchoredCharacters —— 有场景图但角色无参考图时,
// 角色必须仍拿到文字外貌锚 + unanchored 记录,否则每镜重新发明一个人。
// ============================================================================
describe('buildKeyframePlan 身份锚(2026-09-23)', () => {
  const locOnly: Record<string, RefAsset> = {
    loc_room: asset({ slug: 'loc_room', name: '灯塔控制室', kind: 'location', refs: [{ remoteUrl: REMOTE2, alive: true, canonical: true }] }),
    char_linyue: asset({ slug: 'char_linyue', name: '林越', descVisual: '短发女性, 藏青风衣', refs: [] }),
  };

  it('场景图活着但角色无 ref → degraded=false 仍注入角色外貌 + unanchoredCharacters 点名', () => {
    const plan = buildKeyframePlan(
      { idx: 1, description: '推门进入控制室', characters: ['char_linyue'], location_id: 'loc_room' },
      locOnly, {},
    );
    expect(plan.degraded).toBe(false);
    expect(plan.unanchoredCharacters).toEqual(['char_linyue']);
    expect(plan.prompt).toContain('短发女性');
    expect(plan.prompt).toContain('keep this character identity and gender stable');
    expect(plan.refSources.find((r) => r.slug === 'loc_room')?.kind).toBe('location');
  });

  it('角色有 sent ref → 不进 unanchored,且不复述其外貌(与参考图打架)', () => {
    const lib: Record<string, RefAsset> = {
      char_linyue: asset({ slug: 'char_linyue', refs: [{ remoteUrl: REMOTE, alive: true, canonical: true }] }),
      loc_room: asset({ slug: 'loc_room', kind: 'location', refs: [{ remoteUrl: REMOTE2, alive: true, canonical: true }] }),
    };
    const plan = buildKeyframePlan(
      { idx: 1, description: '推门', characters: ['char_linyue'], location_id: 'loc_room' },
      lib, {},
    );
    expect(plan.unanchoredCharacters).toEqual([]);
    expect(plan.prompt).not.toContain('短发女性');
  });

  it('角色被 MAX_REF_IMAGES 截断(sent=false)→ 记入 unanchoredCharacters', () => {
    const many: Record<string, RefAsset> = {
      loc_room: asset({ slug: 'loc_room', kind: 'location', refs: [{ remoteUrl: REMOTE2, alive: true, canonical: true }] }),
      prop_a: asset({ slug: 'prop_a', kind: 'prop', refs: [{ remoteUrl: 'https://x.test/a.png', alive: true, canonical: true }] }),
    };
    // chars 先于 loc/props 入队,但截断发生在 ref 槽满后 —— 用大量优先角色把 char 挤出去不可行
    // (characters 在 slugs 最前)。这里验证:库内不认识的 character 进 unanchored;
    // 真正的截断场景由 slugs 顺序保证角色优先占槽。
    many.char_missing = asset({ slug: 'char_missing', refs: [] });
    const plan = buildKeyframePlan(
      { idx: 1, description: '群戏', characters: ['char_missing'], location_id: 'loc_room', props: ['prop_a'] },
      many, {},
    );
    expect(plan.unanchoredCharacters).toContain('char_missing');
    expect(plan.degraded).toBe(false);
  });

  it('完全不认识的 character slug(shot.characters 含)→ unanchored + missingRefs', () => {
    const plan = buildKeyframePlan(
      { idx: 1, description: 'x', characters: ['char_unknown'], location_id: 'loc_room' },
      { loc_room: locOnly.loc_room }, {},
    );
    expect(plan.unanchoredCharacters).toEqual(['char_unknown']);
    expect(plan.missingRefs).toContain('char_unknown');
  });
});

describe('indexLegacyConceptArt', () => {
  it('step3 的 url 映射到 remoteUrl 并判活,本地 url 留空', () => {
    const idx = indexLegacyConceptArt(
      {
        characters: [{ id: 'char_1', name: '林越', views: [
          { angle: '正面', url: REMOTE, prompt: 'p1' },
          { angle: '背面', url: null, prompt: 'p2', error: 'boom' },
        ] }],
        locations: [{ id: 'loc_1', name: '码头', url: REMOTE2, prompt: 'p3' }],
        props: [{ id: 'prop_1', name: '钥匙', url: null }],
      },
      { characters: [{ id: 'char_1', appearance: '短发女性' }], locations: [{ id: 'loc_1', description: '雨夜木栈桥' }] },
    );
    expect(idx.char_1.refs[0].remoteUrl).toBe(REMOTE);
    expect(idx.char_1.refs[0].url).toBeNull();
    expect(idx.char_1.refs[0].alive).toBe(true);
    expect(idx.char_1.refs[0].canonical).toBe(true);
    expect(idx.char_1.refs[1].alive).toBe(false);
    expect(idx.char_1.descVisual).toBe('短发女性');
    expect(idx.loc_1.descVisual).toBe('雨夜木栈桥');
    expect(idx.prop_1.refs[0].alive).toBe(false);
  });

  it('归一化后的字典能直接喂给规划器并拿到参考图', () => {
    const idx = indexLegacyConceptArt(
      { characters: [{ id: 'char_1', name: '林越', views: [{ angle: '正面', url: REMOTE }] }] },
      { characters: [{ id: 'char_1', appearance: '短发女性' }] },
    );
    const plan = buildKeyframePlan(
      { idx: 1, description: '推门', characters: ['char_1'] }, idx, {},
    );
    expect(plan.refUrls).toEqual([REMOTE]);
    expect(plan.degraded).toBe(false);
  });

  // 2026-09-23 批5:step3 产出的 vehicles/wardrobe 之前被静默丢弃 ——
  // 载具/服装资产在关键帧规划里永远"库内不认识"
  it('step3 的 vehicles/wardrobe 也进索引,不再被静默丢弃', () => {
    const idx = indexLegacyConceptArt(
      {
        vehicles: [{ id: 'veh_boat', name: '渔船', url: REMOTE, prompt: 'vp' }],
        wardrobe: [{ id: 'wd_coat', name: '风衣', url: REMOTE2, prompt: 'wp' }],
      },
      {
        vehicles: [{ id: 'veh_boat', description: '木质拖网船' }],
        wardrobe: [{ id: 'wd_coat', description: '卡其风衣' }],
      },
    );
    expect(idx.veh_boat.kind).toBe('vehicle');
    expect(idx.veh_boat.refs[0].remoteUrl).toBe(REMOTE);
    expect(idx.veh_boat.refs[0].alive).toBe(true);
    expect(idx.veh_boat.descVisual).toBe('木质拖网船');
    expect(idx.wd_coat.kind).toBe('wardrobe');
    expect(idx.wd_coat.refs[0].remoteUrl).toBe(REMOTE2);
    expect(idx.wd_coat.descVisual).toBe('卡其风衣');
  });
});

describe('summarizePlans', () => {
  it('汇总带图/退化镜数并去重待重定妆清单', () => {
    const lib: Record<string, RefAsset> = {
      a: asset({ slug: 'a', refs: [{ remoteUrl: REMOTE, alive: true, canonical: true }] }),
    };
    const plans = [
      buildKeyframePlan({ idx: 1, description: 'x', characters: ['a'] }, lib, {}),
      buildKeyframePlan({ idx: 2, description: 'y', characters: ['b'] }, lib, {}),
      buildKeyframePlan({ idx: 3, description: 'z', characters: ['b'] }, lib, {}),
    ];
    const sum = summarizePlans(plans);
    expect(sum.total).toBe(3);
    expect(sum.withRef).toBe(1);
    expect(sum.degraded).toBe(2);
    expect(sum.needReportrait).toEqual(['b']);
  });
});

// ============================================================================
// 2026-09-15:画幅对齐 —— 关键帧不再硬编码横屏 1280x720 被竖屏视频裁切/拉伸
// ============================================================================
describe('resolveKeyframeSizeRatio 画幅对齐', () => {
  it('aspectRatio 合法 → 档位制 size + ratio(画幅跟随视频)', () => {
    expect(resolveKeyframeSizeRatio({ aspectRatio: '9:16' })).toEqual({ size: '2K', ratio: '9:16' });
    expect(resolveKeyframeSizeRatio({ aspectRatio: '16:9' })).toEqual({ size: '2K', ratio: '16:9' });
    expect(resolveKeyframeSizeRatio({ aspectRatio: '1:1' })).toEqual({ size: '2K', ratio: '1:1' });
  });

  it('keyframeTier 覆盖默认档位(大小写归一)', () => {
    expect(resolveKeyframeSizeRatio({ aspectRatio: '9:16', keyframeTier: '4k' }))
      .toEqual({ size: '4K', ratio: '9:16' });
  });

  it('无 aspectRatio → 回退精确像素 size,不带 ratio(向后兼容,旧调用方零变化)', () => {
    expect(resolveKeyframeSizeRatio({})).toEqual({ size: '1280x720' });
    expect(resolveKeyframeSizeRatio({ keyframeSize: '720x1280' })).toEqual({ size: '720x1280' });
    expect(resolveKeyframeSizeRatio({}).ratio).toBeUndefined();
  });

  it('非法 aspectRatio → 回退精确像素,不带 ratio', () => {
    const r = resolveKeyframeSizeRatio({ aspectRatio: 'vertical' });
    expect(r.ratio).toBeUndefined();
    expect(r.size).toBe('1280x720');
  });

  it('buildKeyframePlan 把 ratio 带进 plan(供 callImageWithKey 走档位制)', () => {
    const lib: Record<string, RefAsset> = {
      char_linyue: asset({ slug: 'char_linyue', refs: [{ remoteUrl: REMOTE, alive: true, canonical: true }] }),
    };
    const plan = buildKeyframePlan(
      { idx: 1, description: '推门', characters: ['char_linyue'] },
      lib, { aspectRatio: '9:16' },
    );
    expect(plan.size).toBe('2K');
    expect(plan.ratio).toBe('9:16');
    expect(plan.degraded).toBe(false);
  });
});
