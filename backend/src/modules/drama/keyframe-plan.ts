// ============================================================================
// keyframe-plan.ts —— 分镜关键帧的「参考图驱动」规划器(纯函数)
// ----------------------------------------------------------------------------
// 为什么需要它:旧 step5 把设定图的 **prompt 文字**拼回去做纯文生图,
// 于是换集就换脸 —— 文字描述永远锁不住一张脸。正确做法是把角色定妆图
// 当参考图喂给图生图队列。
//
// 一条必须守住的硬约束(踩过):图生图队列只收**上游可达的公网 http(s) URL**。
//   本地落盘路径 /uploads/... 对 Agnes 服务器不可达,传过去必 400;
//   data URI 实测也 400。所以 refs[].url(本地,给人看、防过期)与
//   refs[].remoteUrl(上游,给模型看)是两条不同用途的字段,绝不能混用。
//   本地 OSS 未配置时,参考图的可用窗口 = 上游 remoteUrl 未过期的那段时间。
//   因此这里把「没有可用参考图」显式算出来交给上层决定重定妆,而不是静默退化。
// ============================================================================

import { cameraMotionEn, KEYFRAME_SAFE_MOTIONS, SHOT_TYPE_EN } from './camera-motion';

/** 上游单次请求最多带几张参考图(超出后按 主角 > 场景 > 道具 优先级截断) */
export const MAX_REF_IMAGES = 3;

/** Agnes 图像 API 档位制合法比例(与 open-montage.callImageWithKey 的 LEGAL_RATIOS 对齐) */
export const LEGAL_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/**
 * 解析关键帧的 size + ratio。
 *
 * 2026-09-15:旧实现硬编码 '1280x720'(横屏)且不带 ratio,而视频默认 9:16(竖屏)——
 *   横屏首帧喂给竖屏视频任务,上游必然裁切/拉伸,构图在首帧就偏了。现在:
 *   · styleSpec.aspectRatio 是合法比例 → 走**档位制**(size='2K' + ratio),画幅与视频
 *     严格一致,且分辨率比旧的 720p 更高(用户反馈"画面质量差"的直接改善);
 *   · 否则回退旧的精确像素 size(不带 ratio),保证未传 aspectRatio 的调用方零变化。
 */
export function resolveKeyframeSizeRatio(
  styleSpec: Record<string, any> = {},
): { size: string; ratio?: string } {
  const aspect = String(styleSpec.aspectRatio || '').trim();
  if (LEGAL_RATIOS.includes(aspect)) {
    const tier = /^(1|2|3|4)K$/i.test(String(styleSpec.keyframeTier || ''))
      ? String(styleSpec.keyframeTier).toUpperCase()
      : '2K';
    return { size: tier, ratio: aspect };
  }
  return { size: String(styleSpec.keyframeSize || '1280x720') };
}

export interface KeyframeShot {
  idx: number;
  description: string;
  shot_type?: string;
  camera_motion?: string;
  characters?: string[];
  location_id?: string;
  props?: string[];
  /** 2026-09-24:分镜可引用的载具 slug(step4 契约 + designFromLibrary 放行后) */
  vehicles?: string[];
  /** 2026-09-24:本镜特殊造型的服装 slug;命中角色 variant 时优先用变体定妆 */
  wardrobe?: string[];
}

/** 资产库里可被引用的字段(与 DramaService.fmtAsset 输出对齐) */
export interface RefAsset {
  slug: string;
  name: string;
  kind: string;
  descVisual: string;
  refs: Array<{
    angle?: string;
    url?: string | null;
    remoteUrl?: string | null;
    prompt?: string;
    negativePrompt?: string;
    alive?: boolean;
    canonical?: boolean;
  }>;
  variants?: Array<{
    id?: string;
    label?: string;
    refs?: Array<{
      angle?: string;
      url?: string | null;
      remoteUrl?: string | null;
      prompt?: string;
      negativePrompt?: string;
      alive?: boolean;
      canonical?: boolean;
    }>;
  }>;
}

export interface KeyframePlan {
  shotIdx: number;
  prompt: string;
  negative: string;
  size: string;
  /** Agnes 档位制比例(如 '9:16')。size 为档位('1K'-'4K')时配套使用,让关键帧画幅
   *  与视频 aspect_ratio 一致 —— 否则横屏关键帧喂给竖屏视频任务会被上游裁切/拉伸,
   *  首帧构图就偏了,后续运动只会更歪。undefined = 走精确像素 size,不带 ratio。 */
  ratio?: string;
  /** 真正交给图生图队列的公网 URL */
  refUrls: string[];
  /** 每张参考图来自哪个资产、什么角度,便于事后排查"这张脸是谁给的";
   *  sent=false 表示该资产想当参考但超出上限,本轮没送进请求 */
  refSources: Array<{ slug: string; name: string; kind: string; angle: string; url: string; sent: boolean }>;
  /** 该镜引用了、但拿不到可用参考图的资产 —— 上层据此触发重定妆 */
  missingRefs: string[];
  /** true = 一张参考图都没有,只能退回纯文生图(一致性无保障) */
  degraded: boolean;
  /**
   * 有出场角色但**该角色没有 sent 参考图**的 slug 列表(2026-09-23 身份硬伤)。
   * 旧实现只在"整镜零参考图"时 degraded —— 场景图活着、角色定妆死了/被截断时,
   * 角色既无图锚也无文字外貌,模型每镜重新发明一个人 → 跨场景变性别/换人。
   */
  unanchoredCharacters: string[];
}

const IDENTITY_LOCK =
  'keep the exact same face, hairstyle, body proportions and wardrobe as the character reference image(s) ' +
  '(bind identity to the person, not the background); same character identity and gender across frames; ' +
  'do not redesign, do not restyle, do not swap the character into a different person';

/** 参考图队列下,反向约束走 negative_prompt(不像纯文生图队列那样被拒) */
const IDENTITY_NEGATIVE =
  'different face, different person, changed hairstyle, extra people, duplicate character, ' +
  'anime style shift, blurry face, deformed hands, extra fingers, distorted limbs, bad anatomy, ' +
  'plastic skin, oversaturated, low resolution, mutation, watermark, wrong gender, gender swap, ' +
  'same person turned into a different gender';

/** 电影级质感正向增强词 —— 提升光影纵深与皮肤材质,消灭塑料感 */
const CINEMATIC_BOOSTERS =
  '8k resolution, cinematic lighting, volumetric light, photorealistic, masterpiece, highly detailed skin texture, shallow depth of field';

function isPublicHttp(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/')) return false;              // 本地相对路径,上游不可达
  return /^https?:\/\//i.test(url);
}

function pickFromRefs(refs: unknown): string | null {
  const list = Array.isArray(refs) ? refs : [];
  const usable = list.filter((r: any) => r?.alive !== false && isPublicHttp(r?.remoteUrl));
  if (!usable.length) return null;
  const canon = usable.find((r: any) => r?.canonical === true) || usable[0];
  return String(canon.remoteUrl);
}

/**
 * 取一个资产当前可用的参考图 URL。
 * 优先级:匹配 variantLabels 的变体 ref > canonical 且 alive 的 remoteUrl > 任一 alive > 无。
 * 本地 url 一律不参与 —— 它只用于展示与持久化。
 *
 * variantLabels(2026-09-24 换装):shot.wardrobe 里的 slug/名称会传进来,
 * 角色若有对应造型变体,优先锚变体定妆 —— 否则换装镜仍锚基础造型,衣服会闪回。
 */
export function pickUsableRef(
  asset: RefAsset,
  opts?: { variantLabels?: string[] },
): string | null {
  const labels = (opts?.variantLabels || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (labels.length && Array.isArray(asset.variants)) {
    for (const label of labels) {
      const hit = asset.variants.find((v) =>
        v && (String(v.label || '').trim() === label || String(v.id || '').trim() === label));
      if (!hit) continue;
      const url = pickFromRefs(hit.refs);
      if (url) return url;
    }
  }
  return pickFromRefs(asset.refs);
}

/** 该资产是否曾试图以本地路径为准(用于诊断"为什么这一镜没参考图") */
function describeAngle(asset: RefAsset, url: string): string {
  const hit = (asset.refs || []).find((r) => r.remoteUrl === url);
  if (hit) return String(hit.angle || '参考');
  for (const v of asset.variants || []) {
    const vh = (v.refs || []).find((r: any) => r?.remoteUrl === url);
    if (vh) {
      const label = String(v.label || v.id || '变体');
      return `${label}·${String(vh.angle || '参考')}`;
    }
  }
  return '参考';
}

/**
 * 关键帧提示词。
 * 有参考图时**刻意不再复述角色外貌**:图生图下再写一遍长相,
 * 等于给模型两个互相矛盾的信号,反而把参考图带偏(实测角色会往文字描述漂)。
 * 只描述「这个镜头在发生什么 + 怎么拍 + 全剧统一风格」。
 */
export function buildKeyframePlan(
  shot: KeyframeShot,
  assetsBySlug: Record<string, RefAsset>,
  styleSpec: Record<string, any> = {},
): KeyframePlan {
  const wardrobeSlugs = (shot.wardrobe || []).map((s) => String(s || '').trim()).filter(Boolean);
  // 变体匹配键:服装 slug + 服装名 —— 角色 variants[].id/label 任一命中即用该变体定妆
  const variantLabels: string[] = [...wardrobeSlugs];
  for (const w of wardrobeSlugs) {
    const wa = assetsBySlug[w];
    if (wa?.name) variantLabels.push(String(wa.name).trim());
  }
  // 优先级:角色 > 服装(换装身份)> 场景 > 载具 > 道具 —— MAX_REF_IMAGES 截断时保脸保衣服
  const slugs: string[] = [
    ...(shot.characters || []),
    ...wardrobeSlugs,
    ...(shot.location_id ? [shot.location_id] : []),
    ...(shot.vehicles || []),
    ...(shot.props || []),
  ];

  const refUrls: string[] = [];
  const refSources: KeyframePlan['refSources'] = [];
  const missingRefs: string[] = [];
  const unanchoredCharacters: string[] = [];
  const usedAssets = new Set<string>();

  for (const slug of slugs) {
    const a = assetsBySlug[slug];
    if (!a) {
      missingRefs.push(slug);
      if ((shot.characters || []).includes(slug)) unanchoredCharacters.push(slug);
      continue;
    }
    const url = pickUsableRef(
      a,
      a.kind === 'character' && variantLabels.length ? { variantLabels } : undefined,
    );
    if (!url) {
      missingRefs.push(slug);
      if (a.kind === 'character') unanchoredCharacters.push(slug);
      continue;
    }
    if (usedAssets.has(a.slug)) continue;          // 同资产不重复占额度
    usedAssets.add(a.slug);
    const sent = refUrls.length < MAX_REF_IMAGES;
    if (sent) refUrls.push(url);
    // 2026-09-23:kind 必须带上 —— 上层 fallback_to_ref 只允许 character,拒绝场景图当身份锚
    refSources.push({
      slug: a.slug, name: a.name, kind: a.kind,
      angle: describeAngle(a, url), url, sent,
    });
    // 想当参考但被 MAX_REF_IMAGES 截断的角色 = 无图锚,必须记 unanchored
    if (a.kind === 'character' && !sent) unanchoredCharacters.push(slug);
  }

  const styleBits = [
    styleSpec.stylePrompt, styleSpec.palette, styleSpec.lighting, styleSpec.cameraLanguage,
  ].filter((x) => typeof x === 'string' && x.trim()).join(', ');

  const degraded = refUrls.length === 0;

  const parts: string[] = [];
  parts.push(shot.description || '');
  if (shot.shot_type) {
    const en = SHOT_TYPE_EN[shot.shot_type];
    parts.push(en ? `${shot.shot_type} shot, ${en}` : `${shot.shot_type} shot`);
  }
  // 静止不写(避免噪声);纯时间类运镜(焦点切换/穿拍等)静图表达不了,跳过
  if (shot.camera_motion && shot.camera_motion !== '静止'
    && KEYFRAME_SAFE_MOTIONS.has(shot.camera_motion)) {
    const en = cameraMotionEn(shot.camera_motion);
    parts.push(en ? `camera ${shot.camera_motion}, ${en}` : `camera ${shot.camera_motion}`);
  }
  if (styleBits) parts.push(styleBits);
  parts.push(CINEMATIC_BOOSTERS);

  // 无参考图角色的文字外貌兜底 —— 即使整镜有其他参考图(场景图等)也必须注入,
  // 否则该角色既无图锚也无文字锚,每镜重新发明一个人(跨场景变性别/换人的主因)
  const unanchoredAppearance = unanchoredCharacters
    .map((s) => assetsBySlug[s])
    .filter(Boolean)
    .map((a) => `${a.name}: ${a.descVisual}`)
    .join('; ');

  if (!degraded) {
    parts.push(IDENTITY_LOCK);
    if (unanchoredAppearance) {
      parts.push(unanchoredAppearance);
      parts.push('keep this character identity and gender stable across all frames');
    }
    parts.push('single continuous cinematic frame, not a collage, not a split screen');
  } else {
    // 兜底:没有参考图时,把引用到的资产外貌写回文字,聊胜于无
    const appearance = slugs
      .map((s) => assetsBySlug[s])
      .filter(Boolean)
      .map((a) => `${a.name}: ${a.descVisual}`)
      .join('; ');
    if (appearance) parts.push(appearance);
    parts.push('single continuous cinematic frame, not a collage, not a split screen');
  }

  const prompt = parts.filter((p) => p && String(p).trim()).join(', ');
  const negative = [
    IDENTITY_NEGATIVE,
    typeof styleSpec.negativePrompt === 'string' ? styleSpec.negativePrompt : '',
  ].filter(Boolean).join(', ');

  // 画幅跟随视频 aspect_ratio(档位制),不再硬编码横屏 1280x720 被上游裁切/拉伸
  const { size, ratio } = resolveKeyframeSizeRatio(styleSpec);

  return {
    shotIdx: shot.idx,
    prompt,
    negative,
    size,
    ratio,
    refUrls,
    refSources,
    missingRefs: Array.from(new Set(missingRefs)),
    degraded,
    unanchoredCharacters: Array.from(new Set(unanchoredCharacters)),
  };
}

/** 一批分镜的规划汇总,给上层决定"要不要先重定妆再开跑" */
export function summarizePlans(plans: KeyframePlan[]): {
  total: number; withRef: number; degraded: number;
  needReportrait: string[];
} {
  const need = new Set<string>();
  let withRef = 0, degraded = 0;
  for (const p of plans) {
    if (p.degraded) degraded++; else withRef++;
    for (const m of p.missingRefs) need.add(m);
  }
  return { total: plans.length, withRef, degraded, needReportrait: Array.from(need) };
}

/**
 * 把 open-montage step3 的产出形状归一化成 RefAsset 字典。
 * step3:{ characters:[{id,name,views:[{angle,url,prompt}]}], locations:[{id,name,url}],
 *         props:[{id,name,url}], vehicles:[{id,name,url}], wardrobe:[{id,name,url}] }
 * step2:{ characters:[{id,appearance}], locations:[{description}], props:[{description}],
 *         vehicles:[{description}], wardrobe:[{description}] }
 *
 * 关键:step3 里的 url 是**上游公网地址**,必须落到 remoteUrl(给模型看),
 * 本地 url 留空 —— 否则会把不可达地址塞进图生图请求。
 */
export function indexLegacyConceptArt(
  conceptArt: any, design: any,
): Record<string, RefAsset> {
  const out: Record<string, RefAsset> = {};
  const designChars: any[] = design?.characters || [];
  const designLocs: any[] = design?.locations || [];
  const designProps: any[] = design?.props || [];
  const designVehicles: any[] = design?.vehicles || [];
  const designWardrobe: any[] = design?.wardrobe || [];
  const findDesc = (list: any[], id: string, keys: string[]): string => {
    const hit = list.find((x) => String(x.id) === String(id));
    if (!hit) return '';
    for (const k of keys) if (hit[k]) return String(hit[k]);
    return '';
  };

  for (const c of conceptArt?.characters || []) {
    const views = Array.isArray(c.views) ? c.views : [];
    out[String(c.id)] = {
      slug: String(c.id), name: String(c.name || c.id), kind: 'character',
      descVisual: findDesc(designChars, c.id, ['appearance', 'description'])
        || String(views[0]?.prompt || ''),
      refs: views.map((v: any, i: number) => ({
        angle: String(v.angle || `视图${i + 1}`),
        url: null,
        remoteUrl: v.url || null,
        prompt: v.prompt || '',
        negativePrompt: v.negative_prompt || '',
        alive: !!v.url,
        canonical: i === 0 || v.angle === '正面',
      })),
    };
  }
  for (const l of conceptArt?.locations || []) {
    out[String(l.id)] = {
      slug: String(l.id), name: String(l.name || l.id), kind: 'location',
      descVisual: findDesc(designLocs, l.id, ['description']) || String(l.prompt || ''),
      refs: [{
        angle: '全景', url: null, remoteUrl: l.url || null,
        prompt: l.prompt || '', alive: !!l.url, canonical: true,
      }],
    };
  }
  for (const pr of conceptArt?.props || []) {
    out[String(pr.id)] = {
      slug: String(pr.id), name: String(pr.name || pr.id), kind: 'prop',
      descVisual: findDesc(designProps, pr.id, ['description']) || String(pr.prompt || ''),
      refs: [{
        angle: '主视图', url: null, remoteUrl: pr.url || null,
        prompt: pr.prompt || '', alive: !!pr.url, canonical: true,
      }],
    };
  }
  // 2026-09-23 批5:vehicles/wardrobe 之前被静默丢弃 —— step2 会生成它们,
  // step3 也出图,索引漏掉等于这批资产永远"库内不认识"
  for (const v of conceptArt?.vehicles || []) {
    out[String(v.id)] = {
      slug: String(v.id), name: String(v.name || v.id), kind: 'vehicle',
      descVisual: findDesc(designVehicles, v.id, ['description', 'appearance']) || String(v.prompt || ''),
      refs: [{
        angle: '主视图', url: null, remoteUrl: v.url || null,
        prompt: v.prompt || '', negativePrompt: v.negative_prompt || '',
        alive: !!v.url, canonical: true,
      }],
    };
  }
  for (const w of conceptArt?.wardrobe || []) {
    out[String(w.id)] = {
      slug: String(w.id), name: String(w.name || w.id), kind: 'wardrobe',
      descVisual: findDesc(designWardrobe, w.id, ['description', 'appearance']) || String(w.prompt || ''),
      refs: [{
        angle: '主视图', url: null, remoteUrl: w.url || null,
        prompt: w.prompt || '', negativePrompt: w.negative_prompt || '',
        alive: !!w.url, canonical: true,
      }],
    };
  }
  return out;
}
