// ============================================================================
// visual-qc.ts —— 定妆图视觉质检门(纯函数,2026-09-16 批4)
// ----------------------------------------------------------------------------
// 诊断(七问题之问题4):generatePortrait 只判「图是否下载落地」(alive=!!local),
//   多条胳膊/手指畸形/脸部崩坏照判 ok 入库,用户肉眼发现时已经进了关键帧与成片。
//
// 门的语义:
//   · 只查**硬伤**(多余/缺失肢体、手指畸形、多头、身体部件错位),不评美感/相似度 ——
//     美感是导演判断,硬伤才是废图;
//   · 判定由平台 LLM 网关的多模态通道给出(visual-qc 只负责提示词与解析);
//   · 通道不可用/返回不可解析 → parseVisualQcVerdict 返 null = **降级不拦**,
//     绝不让质检把定妆链路打死(与全管线"任何降级必须显式但不阻断"纪律一致)。
// ============================================================================

export interface VisualQcVerdict {
  ok: boolean;
  issues: string[];
}

/** 质检员人设:只挑硬伤,不评美感 —— 防止把"画得不好看"误判成废图 */
export const VISUAL_QC_SYS = `你是严格的影视美术质检员,只检查人物/场景/道具/载具/服装设定图的**解剖与结构硬伤**:
多余或缺失的肢体(如三条胳膊)、手指畸形(多于五指/融合)、多个头、五官错位、身体部件穿模错位、物体悬空无支撑。
角色设定图必须**恰好一名角色** —— 出现两人及以上(合影/镜像/多人合影)属于硬伤。
场景设定图应为空景 —— 出现路人/人物属于硬伤。
载具设定图不得有驾驶员/乘客/任何人物 —— 出现即为硬伤。
服装设定图中出现人物(头像/脸/穿着者/模特)也属于硬伤 —— 服装图只能有衣服本身。
**不评价**美感、风格、与描述的相似度、构图。没有硬伤就必须判 ok=true。
只输出 JSON,无 markdown:{"ok": true|false, "issues": ["硬伤描述,≤20字/条,最多4条"]}`;

/** 针对单个资产构造质检问题(带资产名与类别,让模型有参照) */
export function buildVisualQcQuestion(assetName: string, kind: string, angle?: string): string {
  const kindLabel = kind === 'character' ? '角色'
    : kind === 'location' ? '场景'
      : kind === 'wardrobe' ? '服装'
        : kind === 'vehicle' ? '载具' : '道具';
  const extra = kind === 'wardrobe'
    ? '这是服装设定图:画面里出现任何人物/头像/脸/穿着者即为硬伤(除非幽灵模特且完全不可见人形面孔)。'
    : kind === 'character'
      ? '这是角色设定图:画面必须恰好一名角色,出现两人及以上(合影/分身/多人)即为硬伤。'
      : kind === 'location'
        ? '这是场景设定图:画面应为空景,出现任何路人/人物即为硬伤。'
        : kind === 'vehicle'
          ? '这是载具设定图:不得出现驾驶员/乘客/任何人物,出现即为硬伤。'
          : '';
  // 2026-09-23 批5:质检必须带角度 —— 只检第一张且不带角度时,"背面画成正面"
  // 结构上检不出来(正面看起来毫无硬伤)
  const angleBit = angle
    ? `本张是「${angle}」视图:方向/视角必须与该角度一致(如背面图出现正脸五官即为硬伤)。`
    : '';
  return `检查这张${kindLabel}设定图「${assetName}」是否存在解剖/结构硬伤。` +
    `角色图重点数肢体与手指数量;场景/道具/载具图重点看物体悬空与部件错位。${angleBit}${extra}` +
    `无硬伤输出 {"ok": true, "issues": []}。`;
}

/**
 * 解析质检返回。null = 通道不可用/不可解析(调用方据此降级,不拦)。
 * 容忍 markdown 围栏与多余字段;issues 截断 4 条防提示词注入式超长文本进库。
 */
export function parseVisualQcVerdict(raw: string | null | undefined): VisualQcVerdict | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const stripped = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(stripped.slice(start, end + 1));
    if (typeof j?.ok !== 'boolean') return null;
    const issues = Array.isArray(j.issues)
      ? j.issues.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 4)
      : [];
    return { ok: j.ok, issues };
  } catch {
    return null;
  }
}

/** 质检重试上限:自动重画最多 2 次,仍坏打 suspect 标入库(人工可一键重生成) */
export const VISUAL_QC_MAX_REDRAW = 2;
