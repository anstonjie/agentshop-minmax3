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
  variants?: Array<{ id?: string; label?: string; refs?: unknown[] }>;
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
  refSources: Array<{ slug: string; name: string; angle: string; url: string; sent: boolean }>;
  /** 该镜引用了、但拿不到可用参考图的资产 —— 上层据此触发重定妆 */
  missingRefs: string[];
  /** true = 一张参考图都没有,只能退回纯文生图(一致性无保障) */
  degraded: boolean;
}

const IDENTITY_LOCK =
  'keep the exact same face, hairstyle, body proportions and wardrobe as the reference image; ' +
  'same character identity across frames; do not redesign, do not restyle the character';

/** 参考图队列下,反向约束走 negative_prompt(不像纯文生图队列那样被拒) */
const IDENTITY_NEGATIVE =
  'different face, different person, changed hairstyle, extra people, duplicate character, ' +
  'anime style shift, blurry face, deformed hands, extra fingers, distorted limbs, bad anatomy, ' +
  'plastic skin, oversaturated, low resolution, mutation, watermark';

/** 电影级质感正向增强词 —— 提升光影纵深与皮肤材质,消灭塑料感 */
const CINEMATIC_BOOSTERS =
  '8k resolution, cinematic lighting, volumetric light, photorealistic, masterpiece, highly detailed skin texture, shallow depth of field';

const CAMERA_MOTION_EN: Record<string, string> = {
  推: 'slow smooth dolly-in, camera pushes toward the subject',
  拉: 'slow smooth dolly-out, camera pulls back',
  摇: 'smooth horizontal panning shot',
  移: 'lateral tracking shot',
  跟: 'camera follows the moving subject',
  升: 'rising crane-up camera move',
  降: 'descending crane-down camera move',
  甩: 'whip pan',
  环绕: 'orbiting camera around the subject',
};

const SHOT_TYPE_EN: Record<string, string> = {
  远景: 'extreme wide shot',
  全景: 'wide establishing shot',
  中景: 'medium shot',
  近景: 'close-up shot',
  特写: 'extreme close-up',
  空镜: 'empty scenic shot, no characters',
};

function isPublicHttp(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/')) return false;              // 本地相对路径,上游不可达
  return /^https?:\/\//i.test(url);
}

/**
 * 取一个资产当前可用的参考图 URL。
 * 优先级:canonical 且 alive 的 remoteUrl > 任一 alive 的 remoteUrl > 无。
 * 本地 url 一律不参与 —— 它只用于展示与持久化。
 */
export function pickUsableRef(asset: RefAsset): string | null {
  const refs = Array.isArray(asset.refs) ? asset.refs : [];
  const usable = refs.filter((r) => r.alive !== false && isPublicHttp(r.remoteUrl));
  if (!usable.length) return null;
  const canon = usable.find((r) => r.canonical === true) || usable[0];
  return String(canon.remoteUrl);
}

/** 该资产是否曾试图以本地路径为准(用于诊断"为什么这一镜没参考图") */
function describeAngle(asset: RefAsset, url: string): string {
  const hit = (asset.refs || []).find((r) => r.remoteUrl === url);
  return String(hit?.angle || '参考');
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
  const slugs: string[] = [
    ...(shot.characters || []),
    ...(shot.location_id ? [shot.location_id] : []),
    ...(shot.props || []),
  ];

  const refUrls: string[] = [];
  const refSources: KeyframePlan['refSources'] = [];
  const missingRefs: string[] = [];
  const usedAssets = new Set<string>();

  for (const slug of slugs) {
    const a = assetsBySlug[slug];
    if (!a) { missingRefs.push(slug); continue; }
    const url = pickUsableRef(a);
    if (!url) { missingRefs.push(slug); continue; }
    if (usedAssets.has(a.slug)) continue;          // 同资产不重复占额度
    usedAssets.add(a.slug);
    const sent = refUrls.length < MAX_REF_IMAGES;
    if (sent) refUrls.push(url);
    refSources.push({
      slug: a.slug, name: a.name, angle: describeAngle(a, url), url, sent,
    });
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
  if (shot.camera_motion && shot.camera_motion !== '静止') {
    const en = CAMERA_MOTION_EN[shot.camera_motion];
    parts.push(en ? `camera ${shot.camera_motion}, ${en}` : `camera ${shot.camera_motion}`);
  }
  if (styleBits) parts.push(styleBits);
  parts.push(CINEMATIC_BOOSTERS);

  if (!degraded) {
    parts.push(IDENTITY_LOCK);
    // 明确告知这是连续镜头中的一帧,避免模型把它画成独立插画(分屏/拼图)
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
 * step3:{ characters:[{id,name,views:[{angle,url,prompt}]}], locations:[{id,name,url}], props:[{id,name,url}] }
 * step2:{ characters:[{id,name,appearance}], locations:[{id,description}], props:[{id,description}] }
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
  return out;
}
