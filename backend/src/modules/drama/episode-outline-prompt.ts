// ============================================================================
// episode-outline-prompt.ts —— 「逐集承接」大纲提示词(纯函数)
// ----------------------------------------------------------------------------
// 连续剧的"连"不能靠人脑记忆。每集生成前必须把剧级事实编译进提示词:
//   世界观圣经 + 上一集结尾的世界状态快照 + 本集要接住的钩子 + 全季故事线里
//   本集的使命与指定结尾钩子 + 资产库索引(让 LLM 复用已有角色而不是凭空造新人)。
//
// 输出契约里刻意要求 needs_assets 与 hook_out:
//   前者喂给资产预检(命中即复用,未命中才生成新资产并回流),
//   后者成为下一集的 hookIn,形成硬链接。
//
// 另一条硬规则:description 不许写人物长相。长相由定妆参考图决定,
// 文字再写一遍会和参考图打架 —— 实测带参考图时复述外貌反而让脸往文字漂。
// ============================================================================

export interface EpisodeOutlineInput {
  dramaTitle: string;
  logline?: string;
  synopsis?: string;
  bible?: Record<string, any>;
  styleSpec?: Record<string, any>;
  snapshot?: Record<string, any>;
  storyArcItem?: Record<string, any> | null;
  hookIn?: string | null;
  epNo: number;
  totalEpisodes?: number;
  assetIndex?: Array<{ slug: string; name: string; kind: string; variants?: string[] }>;
  userBrief?: string;
  targetSec?: number;
  /** P0-b:本集覆盖章节的**原文摘录**(按账本 char_offset 从小说正文切回)。让编剧看着原著写,而不是凭章节标题编剧情。 */
  chapterExcerpt?: string;
  /** P0-b:本集 beats 原文锚点(逐字 quote + 必拍标记,已格式化);P0-a 回填后才有,为空则不渲染。 */
  beatsAnchor?: string;
}

export interface EpisodeOutlinePrompt {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
}

/** 已确立事实最多带这么多条,防止长剧集把提示词撑爆 */
export const MAX_ESTABLISHED_FACTS = 30;
/** 资产索引最多带这么多项 */
export const MAX_ASSET_INDEX = 40;

const KIND_LABEL: Record<string, string> = {
  character: '角色', location: '场景', prop: '道具', vehicle: '载具', wardrobe: '服装',
};

/** needs_assets.kind 白名单 —— 与 DramaService.ASSET_KINDS 对齐;非法 kind 到 createAsset 抛 400 会让 resolvePrecheck 中途断 */
export const OUTLINE_ASSET_KINDS = ['character', 'location', 'prop', 'vehicle', 'wardrobe'];

export function buildEpisodeOutlinePrompt(
  input: EpisodeOutlineInput,
): EpisodeOutlinePrompt {
  const bible = input.bible || {};
  const snap = input.snapshot || {};
  const arc = input.storyArcItem || {};
  const facts = (Array.isArray(snap.establishedFacts) ? snap.establishedFacts : [])
    .slice(-MAX_ESTABLISHED_FACTS);
  const openHooks = Array.isArray(snap.openHooks) ? snap.openHooks : [];
  const charStates = snap.characterStates && typeof snap.characterStates === 'object'
    ? snap.characterStates : {};
  const assetIndex = (input.assetIndex || []).slice(0, MAX_ASSET_INDEX);
  const hasAnchor = !!(input.beatsAnchor || input.chapterExcerpt);

  const system = `你是资深短剧编剧,负责一部连续剧的第 ${input.epNo} 集。
硬性要求:
- 严格输出 JSON,不要 markdown 包裹,不要复述设定内容
- **不得与「已确立事实」冲突**:已经死掉的人不能复活、已经拿到的证据不能又找不到、已经知道秘密的人不能突然不知道
${hasAnchor ? `- **忠于原著(最高优先)**:下面给了本集的「原文锚点/原文摘录」,scenes 必须据此改编 —— 覆盖所有标 [必拍] 的点,不得凭空另编主线、不得与原文既定情节矛盾;锚点里用「」括起的台词是原文逐字,改编时优先保留其含义
- **beat 1:1 映射**:每个 scene 必须给 beat_ids(本场覆盖的拍点 id,见锚点行首 {id});所有 [必拍] 拍点必须被至少一个 scene 的 beat_ids 覆盖。**禁止为凑时长发明锚点/摘录里没有的新主线情节** —— 内容不够就把已有拍点写深(动作/冲突/反应/后果),而不是另编剧情` : ''}${hasAnchor ? `
- **逐字引用(quotes 字段)**:每个 scene 必须给 quotes:本场改编自的 1-3 条**原文逐字句**(从锚点「」内或摘录原文里原样抄录,不许改写);纯衔接场确无对应原文才允许空数组。quotes 是分镜/字幕回溯原著的唯一载体,缺了它下游就只能凭 50 字摘要重编` : ''}- 开场必须自然接住「本集要接住的钩子」,不许另起炉灶忽略它
- 结尾必须留下「本集结尾钩子」,它是下一集的开场
- 出场人物、场景、道具**优先复用资产索引里已有的 slug**;确有必要才新增,新增时在 needs_assets 里写清视觉描述
- needs_assets 每项必须给 kind/name/slug(英文小写下划线)/descVisual;kind 只能是 ${OUTLINE_ASSET_KINDS.join('|')};
  角色 descVisual 写长相发型服装,场景写光线材质氛围(空景,不写路人),道具/载具写外观结构,服装只写衣服本身的版型/颜色/面料(禁止写谁在穿)
- scenes 3-6 个,每个给 estimated_sec 与 summary(50 字内)
- **所有 scene 的 estimated_sec 之和 + total_estimated_sec 必须接近本集目标时长**,
  上下浮动不超过 15%。时长不够时**只允许深化已有场景/拍点(写透冲突与反应),禁止发明与原文、使命无关的新主线来凑秒数**;
  宁可场景节奏放慢,也不要交一个比目标短一半、或东拼西凑看不懂的本子
- 每个 scene 的 description 只写构图/动作/环境/光线,**禁止写人物长相与服装**(那由定妆图决定)
- 不要出现旁白解释前情,用画面和动作承接`;

    const user = [
      `剧名:${input.dramaTitle}`,
      bible.world ? `世界观:${bible.world}` : '',
      bible.era ? `时代:${bible.era}` : '',
      bible.genre ? `类型:${bible.genre}` : '',
      bible.tone ? `基调:${bible.tone}` : '',
      Array.isArray(bible.rules) && bible.rules.length ? `世界规则:${bible.rules.join(' / ')}` : '',
      Array.isArray(bible.relationships) && bible.relationships.length
        ? `人物关系:${JSON.stringify(bible.relationships)}` : '',
      input.logline ? `全剧一句话:${input.logline}` : '',
      input.synopsis ? `全剧梗概:${input.synopsis}` : '',
      '\n',
      `=== 到上一集为止已确立的事实(不可违反)===`,
      facts.length ? facts.map((f: string) => `- ${f}`).join('\n') : '(本剧第一集,尚无既定事实)',
      Object.keys(charStates).length
        ? `角色当前状态:${JSON.stringify(charStates)}` : '',
      openHooks.length ? `仍未解决的悬念:${openHooks.join(' / ')}` : '',
      '\n',
      `=== 本集任务 ===`,
      `集数:第 ${input.epNo} 集${input.totalEpisodes ? `(共 ${input.totalEpisodes} 集)` : ''}`,
      arc.purpose ? `本集使命:${arc.purpose}` : '',
      Array.isArray(arc.mustHave) && arc.mustHave.length
        ? `必须出现:${arc.mustHave.join(' / ')}` : '',
      arc.cliffhanger ? `指定结尾钩子:${arc.cliffhanger}` : '(请自行设计结尾钩子)',
      input.hookIn ? `本集开场要接住:${input.hookIn}` : '(第一集,无前置钩子)',
      input.targetSec ? `目标时长:约 ${input.targetSec} 秒(硬性,不足要写足内容补齐)` : '目标时长:2-3 分钟(微短剧单集)',
      input.userBrief ? `用户额外要求:${input.userBrief}` : '',
      '\n',
      hasAnchor ? `=== 本集原文锚点(据此改编,不得凭空另编主线)===` : '',
      input.beatsAnchor ? `逐字锚点([必拍] 不可省,「」内为原文台词):\n${input.beatsAnchor}` : '',
      input.chapterExcerpt ? `原文摘录:\n${input.chapterExcerpt}` : '',
      hasAnchor ? '\n' : '',
      `=== 资产索引(优先复用这些 slug,不要凭空另造同名角色)===`,
      assetIndex.length
        ? assetIndex.map((a) => {
            const kind = KIND_LABEL[a.kind] || a.kind;
            const vs = a.variants && a.variants.length ? `|变体:${a.variants.join(',')}` : '';
            return `- [${kind}] ${a.name} (slug: ${a.slug})${vs}`;
          }).join('\n')
        : '(资产库为空,本集需要设计的所有资产都写进 needs_assets)',
      '\n',
      `输出 JSON 结构:`,
      `{
  "title": "本集标题",
  "logline": "本集一句话",
  "synopsis": "本集剧情梗概(100-200字)",
  "hook_out": "本集结尾留下的钩子(一句话)",
  "established_facts_new": ["本集新确立、后续集不得违反的事实"],
  "character_states": { "<角色slug>": "本集结尾该角色的位置/状态/持有物" },
  "total_estimated_sec": ${Number(input.targetSec) > 0 ? Math.round(Number(input.targetSec)) : 120},
  "scenes": [
    { "idx": 1, "location": "地点", "summary": "50字内", "estimated_sec": 30,
      "characters": ["<角色slug>"], "props": ["<道具slug>"],
      "vehicles": ["<载具slug>,本场出现时才写,可省略"],
      "wardrobe": ["<服装slug>,本场特殊造型时才写,可省略"],
      "beat_ids": ["锚点行首的拍点id;无锚点时省略或空数组"],
      "quotes": ["本场改编自的原文逐字句(从锚点原样抄录,1-3条;纯衔接场可空)"] }
  ],
  "needs_assets": [
    { "kind": "character|location|prop|vehicle|wardrobe", "name": "中文名", "slug": "english_slug",
      "descVisual": "视觉描述(供定妆)", "descPersona": "人设或用途",
      "variantHint": "若是已有角色的新造型,写造型名,否则留空" }
  ]
}`,
    ].filter((l) => l !== '').join('\n');

  return { system, user, temperature: 0.75, maxTokens: 8192 };
}

/**
 * 校验并补齐 LLM 返回的本集大纲。
 * 重点是 needs_assets:缺 slug 的补不上就丢弃该项并记警告,
 * 因为预检靠 slug 做稳定引用,没有它整条复用链就断了。
 */
export function normalizeEpisodeOutline(raw: any): { outline: any; warnings: string[] } {
  const warnings: string[] = [];
  const out = { ...(raw || {}) };

  out.scenes = Array.isArray(out.scenes) ? out.scenes : [];
  out.scenes.forEach((s: any, i: number) => {
    if (typeof s.idx !== 'number') s.idx = i + 1;
    if (typeof s.estimated_sec !== 'number') s.estimated_sec = 30;
    if (!Array.isArray(s.characters)) s.characters = [];
    if (!Array.isArray(s.props)) s.props = [];
    // 2026-09-24:载具/服装与 characters/props 同路径归一 —— collectNeeds / 分镜靠它扫
    if (!Array.isArray(s.vehicles)) s.vehicles = [];
    s.vehicles = Array.from(new Set(
      s.vehicles.map((v: any) => String(v || '').trim()).filter((v: string) => v),
    ));
    if (!Array.isArray(s.wardrobe)) s.wardrobe = [];
    s.wardrobe = Array.from(new Set(
      s.wardrobe.map((w: any) => String(w || '').trim()).filter((w: string) => w),
    ));
    // 2026-09-16(批2):quotes 归一 —— 逐字锚点的唯一载体,下游分镜/coverage 都靠它
    if (!Array.isArray(s.quotes)) s.quotes = [];
    s.quotes = Array.from(new Set(
      s.quotes.map((q: any) => String(q || '').trim()).filter((q: string) => q),
    )).slice(0, 3);
    // 2026-09-23:beat_ids 归一 —— 场景↔原文拍点 1:1 映射,coverage/分镜回溯用
    if (!Array.isArray(s.beat_ids)) s.beat_ids = [];
    s.beat_ids = Array.from(new Set(
      s.beat_ids.map((b: any) => String(b || '').trim()).filter((b: string) => b),
    )).slice(0, 8);
  });
  if (!out.scenes.length) warnings.push('LLM 未返回任何场景,本集大纲不可用');

  const needs: any[] = [];
  const seenSlug = new Set<string>();
  for (const n of Array.isArray(out.needs_assets) ? out.needs_assets : []) {
    let kind = String(n.kind || '').trim().toLowerCase();
    const name = String(n.name || '').trim();
    let slug = String(n.slug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!kind || !name) { warnings.push(`跳过一条缺 kind/name 的资产需求:${JSON.stringify(n).slice(0, 60)}`); continue; }
    // 2026-09-23 批5:非法 kind 流到 createAsset 会抛 400,resolvePrecheck 中途断且
    // 已应用的裁决无事务回滚 —— 在 normalize 层先拦下并告警
    if (!OUTLINE_ASSET_KINDS.includes(kind)) {
      warnings.push(`跳过 kind「${kind}」不在白名单(${OUTLINE_ASSET_KINDS.join('/')})的资产需求「${name}」`);
      continue;
    }
    if (!slug) {
      // 不静默丢弃:补一个可追溯的临时 slug,同时告警,让前端能提示改写
      slug = `${kind.slice(0, 4)}_auto_${needs.length + 1}`;
      warnings.push(`「${name}」未提供英文 slug,临时使用 ${slug},建议在资产库里改名`);
    }
    if (seenSlug.has(slug)) {
      slug = `${slug}_${needs.length + 1}`;
      warnings.push(`slug 重复,已改为 ${slug}`);
    }
    seenSlug.add(slug);
    needs.push({
      kind, name, slug,
      descVisual: String(n.descVisual || name),
      descPersona: n.descPersona ? String(n.descPersona) : undefined,
      variantHint: n.variantHint ? String(n.variantHint) : undefined,
    });
  }
  out.needs_assets = needs;

  out.established_facts_new = Array.isArray(out.established_facts_new)
    ? out.established_facts_new.map(String) : [];
  out.character_states = out.character_states && typeof out.character_states === 'object'
    ? out.character_states : {};
  out.hook_out = out.hook_out ? String(out.hook_out) : '';
  if (!out.hook_out) warnings.push('本集未设计结尾钩子,下一集将没有可承接的开场');

  return { outline: out, warnings };
}

/**
 * 2026-09-16(批2):大纲 quote 覆盖统计 —— 调用方据此做两件事:
 *   ① 忠实门:有原文锚点却 0 场引用 → 重生成一次;
 *   ② coverage 回写:quotes 与 dramas_novel_beats.quote 对账,标 covered。
 */
export function outlineQuoteStats(outline: any): {
  scenes: number; withQuotes: number; quotes: string[];
} {
  const scenes: any[] = Array.isArray(outline?.scenes) ? outline.scenes : [];
  const quotes: string[] = [];
  let withQuotes = 0;
  for (const s of scenes) {
    const qs: string[] = Array.isArray(s?.quotes) ? s.quotes.map(String).filter(Boolean) : [];
    if (qs.length) withQuotes++;
    for (const q of qs) if (!quotes.includes(q)) quotes.push(q);
  }
  return { scenes: scenes.length, withQuotes, quotes };
}

/**
 * 2026-09-24:场景引用的扁平化口径 —— collectNeeds 的 appearsIn 过滤与
 * 场景级资产扫描共用这一处,避免再出现"只扫 characters/props"的半截实现。
 * 顺序:角色 → 道具 → 载具 → 服装 → 场景 id → 场景自由文本。
 */
export function sceneAssetSlugs(sc: any): string[] {
  if (!sc || typeof sc !== 'object') return [];
  const pick = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  return [
    ...pick(sc.characters),
    ...pick(sc.props),
    ...pick(sc.vehicles),
    ...pick(sc.wardrobe),
    ...(sc.location_id ? [String(sc.location_id).trim()] : []),
    ...(sc.location ? [String(sc.location).trim()] : []),
  ].filter(Boolean);
}
