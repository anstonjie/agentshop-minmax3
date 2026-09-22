// ============================================================================
// asset-matcher — 资产预检匹配器(纯函数,无 DB / 无 Nest 依赖)
// ----------------------------------------------------------------------------
// 职责:把「本集剧本需要的资产清单」和「剧级资产库」做一次 diff,
//       输出三类结论 —— 命中复用 / 疑似同角色新造型(变体) / 需要用户裁决 / 全新资产。
//
// 设计原则(重要,别改):
//  1. **只有精确命中才允许自动复用**。模糊相似度最高只能到 0.80,永远跨不过
//     AUTO_HIT_THRESHOLD=0.88。理由:连续剧里把「林越」错认成「林月」会造成
//     跨集串脸,这种错误比多问用户一次昂贵得多。
//  2. **换装/负伤不建新资产**。带 variantHint 且已命中角色时,判为 variant,
//     否则资产库会被同一角色的第 N 套衣服撑爆。
//  3. **kind 不同一律不比**。角色不会匹配到场景。
//  4. 用户裁决完要把结果回写 aliases(见 applyDecision),下次同一写法即可精确命中。
//  5. (2026-09-14)**参考图三态显式暴露**:命中/变体资产按 REF/IMG/PLAN 标注
//     定妆图就绪度(方法论来源:zenstory-ai/drama-skills MIT,
//     docs/character-consistency-across-shots.md「第二层:参考图的三种状态」)。
//     「提示词条目不是已有图片的证明」—— 复用判定通过 ≠ 垫图可用;缺图的资产
//     必须在预检报告里列出来,对齐「任何降级必须显式告诉用户」的管线纪律,
//     而不是等 step5 静默退化文生图、成片换脸了才发现。
// ============================================================================

/** 资产类别(与 DramaAsset.kind 对齐) */
export type AssetKind = 'character' | 'location' | 'prop' | 'vehicle' | 'wardrobe';

/** LLM 在剧本阶段产出的「本集需要某个资产」 */
export interface AssetNeed {
  kind: AssetKind;
  /** 中文名,来自 LLM 输出 */
  name: string;
  /** LLM 若能沿用库内 slug 会带上;有值则优先按 slug 精确命中 */
  slugHint?: string;
  /** 视觉描述(图像生成用) */
  descVisual?: string;
  /** 人设 / 场景氛围 / 道具用途 */
  descPersona?: string;
  /** 造型差异提示,如「婚纱」「战斗负伤」「雨夜」——触发 variant 判定 */
  variantHint?: string;
  /** 本集出现的镜号,用于回写 usedAssets */
  appearsIn?: number[];
}

/** 资产库里的一条记录(已格式化,不含 BigInt) */
export interface AssetRecord {
  id: string;
  uuid: string;
  kind: string;
  slug: string;
  name: string;
  aliases: string[];
  descVisual?: string;
  /** DramaAsset.refs(fmtAsset 透传);三态判定只读存活图片与提示词两类字段 */
  refs?: AssetRefEntry[];
  variants: VariantRecord[];
  locked: boolean;
  status: string;
}

export interface VariantRecord {
  id: string;
  label: string;
  descDelta?: string;
  fromEp?: number;
  /** 该造型自己的参考图(DramaAsset.variants[].refs,fmtAsset 透传) */
  refs?: AssetRefEntry[];
}

/** DramaAsset.refs / variants[].refs 的单条(与 schema 注释字段对齐) */
export interface AssetRefEntry {
  angle?: string | null;
  /** 本地落地路径 */
  url?: string | null;
  remoteUrl?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  seed?: number | null;
  /** false = 已被标记死图(生成失败/弃用),不算真实参考图 */
  alive?: boolean | null;
  canonical?: boolean | null;
}

/**
 * 参考图三态(drama-skills 方法论,2026-09-14):
 *   REF : 确有已落地、存活的定妆图(url/remoteUrl 且 alive≠false),可做垫图/参考;
 *   IMG : 只有文字条目(refs[].prompt 或 descVisual),图还没出 —— 提示词不是图片的证明;
 *   PLAN: 图文皆无,待补(需要先生成或用户上传素材)。
 */
export type AssetRefState = 'REF' | 'IMG' | 'PLAN';

/**
 * 三态判定(纯函数)。变体传自己的 refs;资产传 DramaAsset.refs。
 * alive 显式为 false 的死图不算 REF;其余字段缺失一律按最保守处理。
 */
export function classifyRefState(refs: unknown, descVisual?: string | null): AssetRefState {
  const list = Array.isArray(refs) ? refs : [];
  const hasRealImage = list.some(
    (r: any) => r && (r.url || r.remoteUrl) && r.alive !== false,
  );
  if (hasRealImage) return 'REF';
  const hasPromptEntry = list.some(
    (r: any) => r && typeof r.prompt === 'string' && r.prompt.trim() !== '',
  );
  if (hasPromptEntry || (typeof descVisual === 'string' && descVisual.trim() !== '')) return 'IMG';
  return 'PLAN';
}

/** 三态 → 人话缺口说明(usermsg 纪律:说"定妆图还没生成",不说"refState=IMG") */
export function refGapMessage(name: string, state: AssetRefState, variantLabel?: string): string {
  const who = variantLabel ? `${name}·${variantLabel}` : name;
  if (state === 'IMG') {
    return `「${who}」只有文字设定,定妆图还没生成;本集用到它的关键帧会退化成文生图,有跑脸风险,建议先补一张参考图`;
  }
  if (state === 'PLAN') {
    return `「${who}」没有参考图也没有视觉描述,投产前需要补齐素材`;
  }
  return '';
}

/** 判定结论 */
export type MatchVerdict =
  | 'hit'        // 精确命中,直接复用
  | 'variant'    // 命中角色但本集是新造型,应在该资产下加/用 variant
  | 'ambiguous'  // 相似但不精确,必须让用户拍板(防串脸)
  | 'new';       // 库内无对应,需生成新资产并回流

export interface MatchCandidate {
  assetId: string;
  slug: string;
  name: string;
  score: number;
  why: string;
}

export interface MatchResult {
  need: AssetNeed;
  verdict: MatchVerdict;
  /** hit / variant / ambiguous 时给出建议复用的资产 */
  assetId?: string;
  slug?: string;
  name?: string;
  score: number;
  /** variant 时给出命中的或建议新建的变体标签 */
  variantId?: string;
  variantLabel?: string;
  /** ambiguous 时列出 top 候选供 UI 二选一 */
  candidates: MatchCandidate[];
  reason: string;
  /**
   * 命中资产的参考图三态(2026-09-14):hit 按资产 refs;variant 按变体自身
   * refs(建议新变体时 = IMG/PLAN,造型图必然还没出);new 固定 PLAN。
   * ambiguous 不给(先裁决归属,再谈图)。
   */
  refState?: AssetRefState;
  /** refState ≠ REF 时的人话缺口说明 */
  refGap?: string;
}

/** 自动复用阈值:只有精确命中才可能跨过它 */
export const AUTO_HIT_THRESHOLD = 0.88;
/** 需要用户裁决的下限:低于它直接判新资产 */
export const AMBIGUOUS_THRESHOLD = 0.62;
/** 模糊相似度的天花板,刻意低于 AUTO_HIT_THRESHOLD */
const FUZZY_CEILING = 0.8;

const SLUG_PREFIX: Record<AssetKind, string> = {
  character: 'char',
  location: 'loc',
  prop: 'prop',
  vehicle: 'veh',
  wardrobe: 'ward',
};

/**
 * 归一化名称:去空白与中英标点、全角转半角、转小写。
 * 「林越(青年)」与「林越 青年」与「林越、青年」归一化后等价。
 */
export function normalizeName(s: string): string {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    // 全角字符 -> 半角
    const half = code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch;
    if (/\s/.test(half)) continue;
    // 去掉常见中英文标点/括号/连接符
    if (/[\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u300a\u300b\u3008\u3009\uff08\uff09\u3010\u3011'"`~!@#$%^&*()_+\-=[\]{};:,.<>?/\\|]/.test(half)) continue;
    out += half;
  }
  return out.toLowerCase();
}

function charSet(s: string): Set<string> {
  return new Set(Array.from(s));
}

function bigramSet(s: string): Set<string> {
  const arr = Array.from(s);
  const set = new Set<string>();
  if (arr.length <= 1) { if (arr.length === 1) set.add(arr[0]); return set; }
  for (let i = 0; i < arr.length - 1; i++) set.add(arr[i] + arr[i + 1]);
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 名称相似度 0..1。取「单字集合 Jaccard」「二元组 Jaccard」「包含关系」三者最大。
 * 中文短名(2~3 字)纯二元组 Jaccard 会过于苛刻,所以补单字集合与包含两个视角。
 */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const charSim = jaccard(charSet(na), charSet(nb));
  const biSim = jaccard(bigramSet(na), bigramSet(nb));
  let containSim = 0;
  if (na.length >= 2 && nb.includes(na)) containSim = 0.8 + 0.15 * (na.length / nb.length);
  else if (nb.length >= 2 && na.includes(nb)) containSim = 0.8 + 0.15 * (nb.length / na.length);
  return Math.max(charSim, biSim, containSim);
}

/** 由中文名生成稳定 slug;非 ASCII 时用 kind 前缀 + 序号兜底(调用方负责去重) */
export function suggestSlug(kind: AssetKind, name: string, fallbackSeq: number): string {
  const pinyinSafe = (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (pinyinSafe && /^[\x00-\x7f]+$/.test(name)) {
    return `${SLUG_PREFIX[kind]}_${pinyinSafe}`.slice(0, 76);
  }
  // 中文名:LLM 通常会在 slugHint 里给英文标识;没给就用序号兜底,
  // 后续 confirm 时允许用户/前端改写 slug,避免 char_1 / char_2 这种无语义标识扩散。
  if (pinyinSafe) return `${SLUG_PREFIX[kind]}_${pinyinSafe}`.slice(0, 76);
  return `${SLUG_PREFIX[kind]}_${fallbackSeq}`;
}

/** 该 variantHint 是否命中资产已有的某个变体 */
function findVariant(asset: AssetRecord, hint: string): VariantRecord | undefined {
  if (!asset.variants?.length) return undefined;
  return asset.variants.find((v) => {
    const s = similarity(hint, v.label || '');
    return s >= 0.62;
  });
}

/**
 * 主入口:对每个 need 给出判定。
 * 纯函数,不查库 —— 调用方负责把 DramaAsset 行格式化成 AssetRecord[]。
 */
export function matchAssets(needs: AssetNeed[], library: AssetRecord[]): MatchResult[] {
  return needs.map((need) => {
    const pool = library.filter((a) => a.kind === need.kind && a.status !== 'deprecated');

    // ── 1. 精确命中(slug / 名称 / 别名) ──
    const nName = normalizeName(need.name);
    const nSlug = normalizeName(need.slugHint || '');
    for (const a of pool) {
      if (nSlug && normalizeName(a.slug) === nSlug) {
        return finish(a, 1, 'hit', need, `slug 精确命中 ${a.slug}`);
      }
    }
    for (const a of pool) {
      if (normalizeName(a.name) === nName) {
        return withVariant(a, 0.95, 'hit', need, `名称精确命中「${a.name}」`);
      }
      const aliasHit = (a.aliases || []).find((al) => normalizeName(al) === nName);
      if (aliasHit) {
        return withVariant(a, 0.92, 'hit', need, `别名命中「${aliasHit}」→ ${a.name}`);
      }
    }

    // ── 2. 模糊相似度(天花板 0.80,永不自动复用) ──
    const scored: MatchCandidate[] = pool
      .map((a) => {
        const nameSim = similarity(need.name, a.name);
        const aliasSim = (a.aliases || []).reduce((m, al) => Math.max(m, similarity(need.name, al)), 0);
        let score = Math.max(nameSim, aliasSim) * FUZZY_CEILING;
        // 描述相似度只做微小加权,用于同分时挑更贴的那个
        if (need.descVisual && a.descVisual) {
          score += Math.min(0.04, similarity(need.descVisual, a.descVisual) * 0.05);
        }
        return {
          assetId: a.id, slug: a.slug, name: a.name,
          score: Number(score.toFixed(4)),
          why: score >= 0.62 ? `名称相近(${(score * 100).toFixed(0)}%)` : '相似度过低',
        };
      })
      .filter((c) => c.score > 0)
      .sort((x, y) => y.score - x.score);

    const top = scored[0];
    if (top && top.score >= AMBIGUOUS_THRESHOLD) {
      const asset = pool.find((a) => a.id === top.assetId)!;
      return {
        need, verdict: 'ambiguous', assetId: asset.id, slug: asset.slug, name: asset.name,
        score: top.score, candidates: scored.slice(0, 4),
        reason: `与「${asset.name}」相似但未精确命中,需确认是同角色新造型、不同角色,还是全新资产`,
      };
    }

      // ── 3. 全新资产 ──
      return {
        need, verdict: 'new', score: top?.score ?? 0,
        candidates: scored.slice(0, 3),
        reason: top ? `库内最接近「${top.name}」仅 ${(top.score * 100).toFixed(0)}% 相似` : '库内无同类候选',
        refState: 'PLAN',
        refGap: refGapMessage(need.name, 'PLAN'),
      };

    /** 名称命中后,若带造型差异提示则降级为 variant(换装不建新资产) */
    function withVariant(a: AssetRecord, score: number, base: MatchVerdict, nd: AssetNeed, reason: string): MatchResult {
      const hint = (nd.variantHint || '').trim();
      if (!hint || nd.kind !== 'character') return finish(a, score, base, nd, reason);
      const v = findVariant(a, hint);
      if (v) {
        // 已有变体:三态按**变体自己**的素材判 —— 身份底图不能证明这套造型的图存在
        // (drama-skills:变体 = 身份不变、造型改变,参考图归变体条目所有)
        const vState = classifyRefState(v.refs, v.descDelta || a.descVisual);
        return {
          need: nd, verdict: 'variant', assetId: a.id, slug: a.slug, name: a.name, score,
          variantId: v.id, variantLabel: v.label, candidates: [],
          reason: `${reason};本集造型「${hint}」已有变体「${v.label}」,直接复用`,
          refState: vState,
          refGap: vState !== 'REF' ? refGapMessage(a.name, vState, v.label) : undefined,
        };
      }
      // 建议的新变体:造型图必然还没出 —— 有文字差异描述算 IMG,否则 PLAN
      const nState = classifyRefState([], hint || a.descVisual);
      return {
        need: nd, verdict: 'variant', assetId: a.id, slug: a.slug, name: a.name, score,
        variantLabel: hint, candidates: [],
        reason: `${reason};本集造型「${hint}」是新造型,建议在该角色下新增变体而非新建资产`,
        refState: nState,
        refGap: refGapMessage(a.name, nState, hint),
      };
    }
  });
}

function finish(
  a: AssetRecord, score: number, verdict: MatchVerdict, need: AssetNeed, reason: string,
): MatchResult {
  const refState = classifyRefState(a.refs, a.descVisual);
  return {
    need, verdict, assetId: a.id, slug: a.slug, name: a.name,
    score: Number(score.toFixed(4)), candidates: [], reason,
    refState,
    refGap: refState !== 'REF' ? refGapMessage(a.name, refState) : undefined,
  };
}

/**
 * 把用户的裁决结果翻译成可回写资产库的动作。
 * 关键:merge 时把本集的写法追加进 aliases —— 下次同样写法就变成精确命中,
 * 裁决只做一次,连集模式才不会反复被同一个问题卡住。
 */
export type DecisionAction =
  | { action: 'reuse'; assetId: string; alias?: string }
  | { action: 'add_alias'; assetId: string; alias: string }
  | { action: 'add_variant'; assetId: string; label: string; descDelta?: string }
  | { action: 'create'; need: AssetNeed };

export function applyDecision(
  need: AssetNeed,
  result: MatchResult,
  choice: { assetId?: string; asVariantLabel?: string },
): DecisionAction {
  const assetId = choice.assetId;
  if (assetId) {
    if (choice.asVariantLabel) {
      return {
        action: 'add_variant', assetId,
        label: choice.asVariantLabel, descDelta: need.variantHint || need.descVisual,
      };
    }
    // 非精确命中下的确认 → 记别名,下次自动命中
    const exact = result.verdict === 'hit' && normalizeName(result.name || '') === normalizeName(need.name);
    return exact
      ? { action: 'reuse', assetId }
      : { action: 'add_alias', assetId, alias: need.name };
  }
  return { action: 'create', need };
}

/** 汇总一份预检报告,给前端直接渲染(命中区 / 新增区 / 待裁决区) */
export interface PrecheckReport {
  hits: MatchResult[];
  variants: MatchResult[];
  ambiguous: MatchResult[];
  news: MatchResult[];
  /**
   * 复用侧(refState ≠ REF)的缺图清单(2026-09-14)—— 命中/变体判定通过但
   * 定妆图未就绪的资产。显式列出让用户在预检阶段就决定补图或接受文生图降级,
   * 不许静默兜过。news 不在这里(全新资产本来就要生成,已计入 newCount)。
   */
  refGaps: MatchResult[];
  summary: {
    total: number;
    reused: number;
    newCount: number;
    needDecision: number;
    /** 复用但缺定妆图的资产数(= refGaps.length) */
    awaitingRefs: number;
  };
}

export function summarize(results: MatchResult[]): PrecheckReport {
  const hits = results.filter((r) => r.verdict === 'hit');
  const variants = results.filter((r) => r.verdict === 'variant');
  const ambiguous = results.filter((r) => r.verdict === 'ambiguous');
  const news = results.filter((r) => r.verdict === 'new');
  const refGaps = [...hits, ...variants].filter((r) => r.refState && r.refState !== 'REF');
  return {
    hits, variants, ambiguous, news, refGaps,
    summary: {
      total: results.length,
      reused: hits.length + variants.length,
      newCount: news.length,
      needDecision: ambiguous.length,
      awaitingRefs: refGaps.length,
    },
  };
}
