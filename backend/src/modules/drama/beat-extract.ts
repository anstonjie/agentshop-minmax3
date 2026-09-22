// ============================================================================
// beat-extract.ts —— P0-a「ingest 后 LLM 回填 beats」的纯函数层
// ----------------------------------------------------------------------------
// 诊断断点①:beats 逐字锚点表(Beat.quote/must_show/foreshadow_pair)全程为空,
// appendBeats 只挂手动端点,自动化流水线从不调 → check:coverage 永远空表假通过,
// 忠于原著的闸门是死的。P0-a 就是把它通电:每章正文跑一次 LLM 抽 beats 落库。
//
// reelbench 纪律在此体现为**防幻觉对账**:beat.quote 必须是章节原文的逐字子串,
// 命中不了就丢弃这条 beat —— 宁可少一条,也不要一条编造的"原文锚点"污染下游大纲。
//
// 纯函数(可单测,不碰 LLM/DB):buildBeatExtractPrompt / parseBeats / reconcileBeats。
// LLM 调用与落库在 NovelLedgerService.extractBeatsForDrama 里做(降级不阻塞)。
// ============================================================================

/** 与 n2d-core types.Beat / appendBeats 校验对齐的字段 */
export interface ExtractedBeat {
  id: string;
  chapter: string;
  type: string;
  summary: string;
  quote: string;
  must_show: boolean;
  foreshadow_pair: string | null;
}

const BEAT_TYPES = ['plot', 'action', 'dialogue', 'emotion', 'foreshadow', 'reveal', 'scene'];

/** 抽取提示词:强调 quote 必须逐字摘自原文、summary ≤30 字、标 must_show。 */
export function buildBeatExtractPrompt(chapterTitle: string, chapterBody: string): {
  system: string; user: string; temperature: number; maxTokens: number;
} {
  const system = `你是小说拆条编辑。把给定的章节正文拆成若干"剧情拍(beat)",供下游短剧改编做忠于原著的核销。
硬性要求:
- 严格输出 JSON,不要 markdown 包裹
- 每个 beat 的 quote **必须是原文里逐字连续出现的一句/一段**(≥5 字),用于防幻觉核销;禁止改写、禁止拼接、禁止杜撰
- summary ≤30 字,概括这一拍发生了什么
- must_show=true 表示"不拍就会让剧情断裂/失忠于原著"的关键拍(主线转折、关键信息、伏笔或其回收);支离琐碎的过渡拍设 false
- type 从 [${BEAT_TYPES.join(', ')}] 里选一个
- 若这一拍是伏笔或伏笔的回收,foreshadow_pair 写一个自拟的配对键(同一对伏笔↔回收用同一个键),否则 null
- 只输出确有内容的拍,一章通常 3-10 条,不要为凑数硬拆`;
  const user = `章节标题:${chapterTitle || '(无标题)'}

章节正文:
"""
${chapterBody}
"""

输出 JSON 结构:
{
  "beats": [
    { "type": "plot", "summary": "≤30字概括", "quote": "原文逐字摘录(≥5字)",
      "must_show": true, "foreshadow_pair": null }
  ]
}`;
  return { system, user, temperature: 0.2, maxTokens: 4096 };
}

/** 归一化空白,用于 quote 逐字对账(原文与 LLM 返回都归一后比子串) */
function normForMatch(s: string): string {
  return String(s || '').replace(/\s+/g, '');
}

/**
 * 解析 LLM 返回为 beats[],补 id/chapter,归一 type/must_show/foreshadow_pair。
 * 解析不出 / 无 beats → 返回 []。不抛错。
 */
export function parseBeats(raw: string, chapterId: string, parseJson: (s: string) => any): ExtractedBeat[] {
  let parsed: any;
  try {
    parsed = parseJson(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed?.beats) ? parsed.beats
    : Array.isArray(parsed) ? parsed : [];
  const out: ExtractedBeat[] = [];
  arr.forEach((b: any, i: number) => {
    const quote = String(b?.quote ?? '').trim();
    const summary = String(b?.summary ?? '').trim();
    if (!quote) return; // 无 quote 的拍没有防幻觉锚点价值,直接不要
    let type = String(b?.type ?? '').trim().toLowerCase();
    if (!BEAT_TYPES.includes(type)) type = 'plot';
    out.push({
      id: `${chapterId}-b${out.length + 1}`,
      chapter: String(chapterId),
      type,
      summary: summary || quote.slice(0, 30),
      quote,
      must_show: b?.must_show === true || b?.must_show === 'true' || b?.must_show === 1,
      foreshadow_pair: b?.foreshadow_pair ? String(b.foreshadow_pair) : null,
    });
    void i;
  });
  return out;
}

export interface ReconcileResult {
  /** quote 逐字命中原文、可安全落库的 beats */
  kept: ExtractedBeat[];
  /** 被丢弃的(quote 未在原文命中)+ 原因 */
  rejected: Array<{ beat: ExtractedBeat; reason: string }>;
}

/**
 * 防幻觉对账:quote 必须是章节原文的逐字子串(空白归一后)。
 * 命中不了 → 丢弃(宁缺毋滥,不让编造的"原文锚点"进账本污染大纲)。
 * 同时兜 appendBeats 的硬门槛:quote ≥5 字。
 */
export function reconcileBeats(beats: ExtractedBeat[], chapterBody: string): ReconcileResult {
  const hay = normForMatch(chapterBody);
  const kept: ExtractedBeat[] = [];
  const rejected: Array<{ beat: ExtractedBeat; reason: string }> = [];
  for (const b of beats || []) {
    if (normForMatch(b.quote).length < 5) {
      rejected.push({ beat: b, reason: 'quote 归一后 <5 字' });
      continue;
    }
    if (!hay.includes(normForMatch(b.quote))) {
      rejected.push({ beat: b, reason: 'quote 未在原文逐字命中(疑似幻觉)' });
      continue;
    }
    kept.push(b);
  }
  return { kept, rejected };
}

export interface ForeshadowReconcileResult {
  beats: ExtractedBeat[];
  /** 被清成 null 的配对键数(原来有键、自愈后清掉) */
  deduped: number;
}

/**
 * 2026-09-22 伏笔配对键自愈:
 *   LLM 在抽 beats 时会编 foreshadow_pair 键(把"某章埋伏笔"和"另一章回收"用自拟 key 连起来)。
 *   它经常只编了"埋伏笔"那一边的键,却没在 reveal 那边写同 key —— check:coverage(I3)
 *   因此全 30 条 warn,污染对齐报告。
 *   自愈规则(每章内 in-place,不去污其它章已落库的拍):
 *     ① 同一键只在 1 个 beat 里出现(单边)                → 清成 null
 *     ② 缺 foreshadow 或缺 reveal(只埋未收 / 只收未埋)   → 清成 null
 *     ③ foreshadow 排在 reveal 之后(顺序反了)            → 清成 null
 *     ④ 其余(foreshadow 在前、reveal 在后,两者齐备)     → 保留
 *
 *   ②③ 是 2026-09-22 二次修正:第一版只判"键下 type 是否 ≥2 种",实测漏了一批 ——
 *   剧 83 自愈后 I3 仍剩 8 条,那 4 组的 type 是 reveal+emotion / action+foreshadow /
 *   action+reveal / reveal+foreshadow,type 确实不止一种却**没凑齐 foreshadow 与 reveal**,
 *   校验器照样判"伏笔配对不存在"。校验器的原文案是
 *   "埋伏笔的章节反而出现在回收之后"——顺序也是判据的一部分。
 */
export function reconcileForeshadowPairs(beats: ExtractedBeat[]): ForeshadowReconcileResult {
  const byKey = new Map<string, ExtractedBeat[]>();
  for (const b of beats || []) {
    if (!b.foreshadow_pair) continue;
    const k = String(b.foreshadow_pair);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(b);
  }
  let deduped = 0;
  for (const [, group] of byKey) {
    if (group.length < 2) {            // 单边
      for (const b of group) { if (b.foreshadow_pair) { b.foreshadow_pair = null; deduped++; } }
      continue;
    }
    // ⚠ 口径必须与 n2d-core 的 I3 一致,不能按"看起来对"定:
    //   ① 键下必须同时存在 type='foreshadow' 与 type='reveal'(其它 type 不算数)
    //   ② 且「埋」必须在「收」之前(reveal 排在 foreshadow 前面同样不成立)
    const fsIdx = group.findIndex((b) => b.type === 'foreshadow');
    const rvIdx = group.findIndex((b) => b.type === 'reveal');
    if (fsIdx < 0 || rvIdx < 0 || fsIdx > rvIdx) {
      for (const b of group) { if (b.foreshadow_pair) { b.foreshadow_pair = null; deduped++; } }
    }
    // 其余(foreshadow 在前、reveal 在后,两者齐备)保留
  }
  return { beats, deduped };
}
