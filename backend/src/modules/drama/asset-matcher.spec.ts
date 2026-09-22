// ============================================================================
// asset-matcher 单测 —— 资产预检是连集自动化的裁判,判定错会串脸或撑爆资产库,
// 所以这条链路的规则必须钉死在测试里。
// ============================================================================
import {
  normalizeName, similarity, matchAssets, summarize, applyDecision, suggestSlug,
  classifyRefState, refGapMessage,
  AUTO_HIT_THRESHOLD, AMBIGUOUS_THRESHOLD,
  type AssetNeed, type AssetRecord,
} from './asset-matcher';

function asset(p: Partial<AssetRecord> & { slug: string; name: string; kind: string }): AssetRecord {
  return {
    id: p.id ?? `id_${p.slug}`,
    uuid: p.uuid ?? `u_${p.slug}`,
    kind: p.kind,
    slug: p.slug,
    name: p.name,
    aliases: p.aliases ?? [],
    descVisual: p.descVisual ?? '',
    refs: p.refs ?? [],
    variants: p.variants ?? [],
    locked: p.locked ?? false,
    status: p.status ?? 'confirmed',
  };
}

function need(p: Partial<AssetNeed> & { name: string; kind?: AssetNeed['kind'] }): AssetNeed {
  return { kind: p.kind ?? 'character', name: p.name, ...p };
}

describe('normalizeName / similarity', () => {
  it('去空白、去标点、全角转半角', () => {
    expect(normalizeName('林 越')).toBe('林越');
    expect(normalizeName('林越（青年）')).toBe('林越青年');
    // 空白一律移除(含全角转半角后的空格):英文名空格差异不该影响匹配
    expect(normalizeName('Ｄｅｔｅｃｔｉｖｅ ｉｎ')).toBe('detectivein');
    expect(normalizeName('Detective Lin')).toBe(normalizeName('DetectiveLin'));
    expect(normalizeName('')).toBe('');
  });

  it('包含关系比纯字面重合更能反映"同一角色的补充叫法"', () => {
    expect(similarity('陈默队长', '陈默')).toBeGreaterThan(similarity('陈默', '沉默寡言'));
  });

  it('两个不同的短中文名不应被判为相似', () => {
    expect(similarity('林越', '林月')).toBeLessThan(AMBIGUOUS_THRESHOLD);
  });
});

describe('matchAssets 精确命中', () => {
  const library = [
    asset({
      kind: 'character', slug: 'char_linyue', name: '林越',
      variants: [{ id: 'v1', label: '战斗负伤', descDelta: '左颊血痕' }],
    }),
    asset({ kind: 'character', slug: 'char_chenmo', name: '陈默', aliases: ['陈老师', '老陈'] }),
    asset({ kind: 'location', slug: 'loc_lighthouse_room', name: '灯塔控制室' }),
  ];

  it('slugHint 命中 → hit,score 1', () => {
    const r = matchAssets([need({ name: '随便写的名字', slugHint: 'char_linyue' })], library)[0];
    expect(r.verdict).toBe('hit');
    expect(r.slug).toBe('char_linyue');
    expect(r.score).toBe(1);
  });

  it('名称精确命中 → hit', () => {
    const r = matchAssets([need({ name: '林越' })], library)[0];
    expect(r.verdict).toBe('hit');
    expect(r.assetId).toBe('id_char_linyue');
  });

  it('别名命中 → hit,并说明命中了哪个别名', () => {
    const r = matchAssets([need({ name: '老陈' })], library)[0];
    expect(r.verdict).toBe('hit');
    expect(r.slug).toBe('char_chenmo');
    expect(r.reason).toContain('别名命中');
  });

  it('标点/空白写法差异不影响精确命中', () => {
    const r = matchAssets([need({ name: '林 越（女主）'.replace('（女主）', '') })], library)[0];
    expect(r.verdict).toBe('hit');
  });
});

describe('matchAssets 变体优先于新建(换装不该撑爆资产库)', () => {
  const library = [
    asset({
      kind: 'character', slug: 'char_linyue', name: '林越',
      variants: [{ id: 'v1', label: '战斗负伤', descDelta: '左颊血痕' }],
    }),
  ];

  it('造型提示命中已有变体 → variant 且带 variantId', () => {
    const r = matchAssets([need({ name: '林越', variantHint: '战斗负伤' })], library)[0];
    expect(r.verdict).toBe('variant');
    expect(r.variantId).toBe('v1');
    expect(r.reason).toContain('已有变体');
  });

  it('造型提示是新造型 → variant 并建议在该角色下加变体,而不是新建资产', () => {
    const r = matchAssets([need({ name: '林越', variantHint: '婚纱造型' })], library)[0];
    expect(r.verdict).toBe('variant');
    expect(r.variantId).toBeUndefined();
    expect(r.variantLabel).toBe('婚纱造型');
    expect(r.assetId).toBe('id_char_linyue');
  });

  it('场景的同地不同时刻也走 variant 语义', () => {
    const lib = [asset({ kind: 'location', slug: 'loc_dock', name: '码头', variants: [{ id: 'vn', label: '雨夜' }] })];
    const r = matchAssets(
      [need({ kind: 'location', name: '码头', variantHint: '雨夜' })],
      lib,
    )[0];
    // location 当前只按名称精确命中(变体降级只对 character 开),确认命中后可由前端加变体
    expect(['hit', 'variant']).toContain(r.verdict);
    expect(r.assetId).toBe('id_loc_dock');
  });
});

describe('matchAssets 模糊与新建', () => {
  const library = [
    asset({ kind: 'character', slug: 'char_chenmo', name: '陈默' }),
    asset({ kind: 'location', slug: 'loc_lighthouse_room', name: '灯塔控制室' }),
    asset({ kind: 'character', slug: 'char_zhou', name: '老周', status: 'deprecated' }),
  ];

  it('相近但不同名 → ambiguous,必须让用户拍板', () => {
    const r = matchAssets([need({ name: '陈默队长' })], library)[0];
    expect(r.verdict).toBe('ambiguous');
    expect(r.score).toBeGreaterThanOrEqual(AMBIGUOUS_THRESHOLD);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('模糊相似度永远跨不过自动复用阈值', () => {
    const results = matchAssets(
      [need({ name: '陈默队长' }), need({ name: '灯塔' }), need({ name: '完全不搭界的东西' })],
      library,
    );
    for (const r of results) {
      if (r.verdict !== 'hit' && r.verdict !== 'variant') {
        expect(r.score).toBeLessThan(AUTO_HIT_THRESHOLD);
      }
    }
    expect(results.every((r) => r.verdict !== 'hit')).toBe(true);
  });

  it('kind 不同一律不匹配 —— 角色不会撞上场景', () => {
    const r = matchAssets([need({ kind: 'character', name: '灯塔控制室' })], library)[0];
    expect(r.verdict).toBe('new');
  });

  it('软删除(deprecated)资产不进入匹配池', () => {
    const r = matchAssets([need({ name: '老周' })], library)[0];
    expect(r.verdict).toBe('new');
  });

  it('库内无同类 → new', () => {
    const r = matchAssets([need({ kind: 'prop', name: '黄铜钥匙' })], library)[0];
    expect(r.verdict).toBe('new');
    expect(r.assetId).toBeUndefined();
  });
});

describe('summarize', () => {
  it('四类分桶且计数自洽', () => {
    const library = [asset({ kind: 'character', slug: 'char_a', name: '甲' })];
    const results = matchAssets(
      [need({ name: '甲' }), need({ name: '乙乙' }), need({ name: '甲甲甲' })],
      library,
    );
    const rep = summarize(results);
    expect(rep.summary.total).toBe(3);
    expect(rep.hits.length + rep.variants.length + rep.ambiguous.length + rep.news.length).toBe(3);
    expect(rep.summary.reused).toBe(rep.hits.length + rep.variants.length);
  });
});

describe('applyDecision', () => {
  const library = [asset({ kind: 'character', slug: 'char_chenmo', name: '陈默' })];

  it('精确命中后确认 → reuse,不污染别名表', () => {
    const r = matchAssets([need({ name: '陈默' })], library)[0];
    expect(applyDecision(r.need, r, { assetId: r.assetId })).toEqual({ action: 'reuse', assetId: 'id_char_chenmo' });
  });

  it('模糊命中后确认 → add_alias,下次同样写法即精确命中(裁决只做一次)', () => {
    const r = matchAssets([need({ name: '陈默队长' })], library)[0];
    expect(r.verdict).toBe('ambiguous');
    expect(applyDecision(r.need, r, { assetId: 'id_char_chenmo' })).toEqual({
      action: 'add_alias', assetId: 'id_char_chenmo', alias: '陈默队长',
    });
  });

  it('确认成同一角色的新造型 → add_variant', () => {
    const r = matchAssets([need({ name: '陈默队长', variantHint: '婚纱' })], library)[0];
    expect(applyDecision(r.need, r, { assetId: 'id_char_chenmo', asVariantLabel: '婚纱造型' })).toEqual({
      action: 'add_variant', assetId: 'id_char_chenmo', label: '婚纱造型', descDelta: '婚纱',
    });
  });

  it('判定为不同角色 → create', () => {
    const r = matchAssets([need({ name: '陈默队长' })], library)[0];
    expect(applyDecision(r.need, r, {}).action).toBe('create');
  });
});

describe('suggestSlug', () => {
  it('英文名生成带语义 slug', () => {
    expect(suggestSlug('character', 'Detective Lin', 1)).toBe('char_detective_lin');
  });
  it('中文名无英文提示时退回序号 slug(由前端/LLM 补语义)', () => {
    expect(suggestSlug('character', '林越', 3)).toBe('char_3');
    expect(suggestSlug('location', '灯塔', 2)).toBe('loc_2');
    expect(suggestSlug('prop', '钥匙', 7)).toBe('prop_7');
  });
});

// ============================================================================
// 参考图三态 REF/IMG/PLAN(2026-09-14,drama-skills 方法论)
// ----------------------------------------------------------------------------
// 「提示词条目不是已有图片的证明」—— 复用判定通过 ≠ 垫图可用。
// 三态把"命中但缺定妆图"在预检阶段显式暴露,不许静默降级成文生图。
// ============================================================================

describe('classifyRefState 三态判定', () => {
  it('有存活本地图(url)→ REF', () => {
    expect(classifyRefState([{ url: '/uploads/a.png' }])).toBe('REF');
  });

  it('有存活远端图(remoteUrl)→ REF', () => {
    expect(classifyRefState([{ remoteUrl: 'https://cdn/a.png' }])).toBe('REF');
  });

  it('alive:false 的死图不算 REF,只剩提示词 → IMG', () => {
    expect(classifyRefState([{ url: '/uploads/fail.png', alive: false, prompt: 'p' }])).toBe('IMG');
  });

  it('只有提示词条目(图还没出)→ IMG', () => {
    expect(classifyRefState([{ prompt: '黑发少年,束腰长袍' }])).toBe('IMG');
  });

  it('refs 为空但 descVisual 非空 → IMG(有文字可生图)', () => {
    expect(classifyRefState([], '黑发少年,束腰长袍')).toBe('IMG');
  });

  it('图文皆无 → PLAN(待补)', () => {
    expect(classifyRefState([], '')).toBe('PLAN');
    expect(classifyRefState(undefined, null)).toBe('PLAN');
    expect(classifyRefState('坏数据', undefined)).toBe('PLAN');
  });

  it('缺口说明是人话(refGapMessage)', () => {
    expect(refGapMessage('林越', 'IMG')).toContain('定妆图还没生成');
    expect(refGapMessage('林越', 'IMG', '婚纱造型')).toContain('林越·婚纱造型');
    expect(refGapMessage('林越', 'PLAN')).toContain('没有参考图');
    expect(refGapMessage('林越', 'REF')).toBe('');
  });
});

describe('matchAssets / summarize 的三态透出', () => {
  it('hit + 有真图 → refState=REF,无 refGap', () => {
    const lib = [asset({
      kind: 'character', slug: 'char_a', name: '林越', descVisual: '黑发少年',
      refs: [{ url: '/uploads/linyue-front.png', canonical: true }],
    })];
    const r = matchAssets([need({ name: '林越' })], lib)[0];
    expect(r.verdict).toBe('hit');
    expect(r.refState).toBe('REF');
    expect(r.refGap).toBeUndefined();
  });

  it('hit + 只有提示词 → refState=IMG,refGap 说要补定妆图', () => {
    const lib = [asset({
      kind: 'character', slug: 'char_a', name: '林越', descVisual: '黑发少年',
      refs: [{ prompt: '黑发少年三视图' }],
    })];
    const r = matchAssets([need({ name: '林越' })], lib)[0];
    expect(r.refState).toBe('IMG');
    expect(r.refGap).toContain('定妆图');
  });

  it('hit + 死图(alive:false)且无提示词无描述 → PLAN(死图不算图)', () => {
    const lib = [asset({
      kind: 'character', slug: 'char_a', name: '林越',
      refs: [{ url: '/uploads/broken.png', alive: false }],
    })];
    const r = matchAssets([need({ name: '林越' })], lib)[0];
    expect(r.refState).toBe('PLAN');
  });

  it('hit + 死图但留有提示词 → IMG(图废了,提示词还能重生)', () => {
    const lib = [asset({
      kind: 'character', slug: 'char_a', name: '林越',
      refs: [{ url: '/uploads/broken.png', alive: false, prompt: '黑发少年三视图' }],
    })];
    const r = matchAssets([need({ name: '林越' })], lib)[0];
    expect(r.refState).toBe('IMG');
  });

  it('命中已有变体:变体自己有真图 → REF;只有底图不证明造型图存在 → IMG', () => {
    const withImg = [asset({
      kind: 'character', slug: 'char_linyue', name: '林越', descVisual: '黑发少年',
      refs: [{ url: '/uploads/base.png' }],
      variants: [{ id: 'v1', label: '婚纱造型', descDelta: '白纱', refs: [{ url: '/uploads/wedding.png' }] }],
    })];
    const r1 = matchAssets([need({ name: '林越', variantHint: '婚纱' })], withImg)[0];
    expect(r1.verdict).toBe('variant');
    expect(r1.refState).toBe('REF');

    const noVariantImg = [asset({
      kind: 'character', slug: 'char_linyue', name: '林越', descVisual: '黑发少年',
      refs: [{ url: '/uploads/base.png' }], // 身份底图有,但变体自己没图
      variants: [{ id: 'v1', label: '婚纱造型', descDelta: '白纱' }],
    })];
    const r2 = matchAssets([need({ name: '林越', variantHint: '婚纱' })], noVariantImg)[0];
    expect(r2.verdict).toBe('variant');
    expect(r2.refState).toBe('IMG');
    expect(r2.refGap).toContain('婚纱造型');
  });

  it('建议新变体 → 造型图必然没出,最多 IMG', () => {
    const lib = [asset({
      kind: 'character', slug: 'char_linyue', name: '林越', descVisual: '黑发少年',
      refs: [{ url: '/uploads/base.png' }],
    })];
    const r = matchAssets([need({ name: '林越', variantHint: '战斗负伤' })], lib)[0];
    expect(r.verdict).toBe('variant');
    expect(r.refState).toBe('IMG');
    expect(r.variantId).toBeUndefined();
  });

  it('new → PLAN;ambiguous 不预判三态', () => {
    const lib = [asset({ kind: 'character', slug: 'char_chenmo', name: '陈默', descVisual: '中年警官' })];
    const news = matchAssets([need({ kind: 'prop', name: '黄铜钥匙' })], lib)[0];
    expect(news.verdict).toBe('new');
    expect(news.refState).toBe('PLAN');

    const amb = matchAssets([need({ name: '陈默队长' })], lib)[0];
    expect(amb.verdict).toBe('ambiguous');
    expect(amb.refState).toBeUndefined();
  });

  it('summarize:refGaps 只收「复用但缺图」,news 不算进去;awaitingRefs 计数自洽', () => {
    const lib = [
      asset({ kind: 'character', slug: 'char_a', name: '林越', descVisual: '黑发少年', refs: [{ url: '/uploads/a.png' }] }),
      asset({ kind: 'character', slug: 'char_b', name: '陈默', descVisual: '中年警官' }), // 只有文字 → IMG
    ];
    const results = matchAssets(
      [need({ name: '林越' }), need({ name: '陈默' }), need({ kind: 'prop', name: '黄铜钥匙' })],
      lib,
    );
    const rep = summarize(results);
    expect(rep.summary.total).toBe(3);
    expect(rep.summary.awaitingRefs).toBe(1); // 陈默缺图;黄铜钥匙是 new 不计入
    expect(rep.refGaps.length).toBe(1);
    expect(rep.refGaps[0].slug).toBe('char_b');
    // 旧字段不受影响(报告序列化进 stepData,resolvePrecheck 按 hits/variants/ambiguous/news 顺序取数)
    expect(rep.hits.length).toBe(2); // 林越(REF)+ 陈默(IMG)都命中
    expect(rep.news.length).toBe(1);
  });
});
