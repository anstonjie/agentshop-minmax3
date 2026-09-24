// ============================================================================
// novel-anchor.ts —— P0-b「把小说正文接回大纲阶段」的纯函数层
// ----------------------------------------------------------------------------
// 诊断根因:buildEpisodeOutlinePrompt 的逐集锚点 arc.purpose 只是**章节标题拼接**,
// LLM 写每集大纲时根本看不到小说正文,于是凭标题编剧情 → "视频对不上小说"。
//
// 本模块把"该集覆盖章节的原文"按账本的 char_offset 切回来,喂进大纲提示词。
// 全部纯函数,便于单测;不做 I/O(读文件/查库在 drama.service 里做)。
//
// 口径对齐:char_offset 定义在 **LF 归一化域**(n2d-core ingest.normalizeLf),
// 而落盘的 novel.txt 可能是 CRLF。所以切片前必须做同样的归一化,否则偏移错位。
// ============================================================================

/** 账本里的章节(只取本模块需要的字段,与 n2d-core types.Chapter 对齐) */
export interface LedgerChapterLike {
  id: string;
  title?: string;
  char_offset?: [number, number] | number[];
}

/** beats 投影行(与 dramas_novel_beats / ledgerJson.beats 对齐;P0-a 回填后才有) */
export interface BeatAnchorLike {
  /** 拍点 id(如 ch1-b1)—— 锚点行首 {id},供大纲 scenes[].beat_ids 引用 */
  id?: string;
  summary?: string;
  quote?: string;
  must_show?: boolean | number;
  type?: string;
  chapter?: string;
}

/** 与 ingest.normalizeLf 完全一致,保证 char_offset 域对齐 */
export function normalizeLf(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 默认原文预算(字符)。大纲提示词还要装世界观/既定事实/资产索引,正文只作"锚点"不整篇照搬。 */
export const DEFAULT_EXCERPT_BUDGET = 6000;

/**
 * 切出某一集覆盖章节的原文摘录。
 * @param novelText      落盘的小说全文(内部会做 LF 归一化)
 * @param chapters       账本 chapters 数组
 * @param epChapterIds   本集覆盖的 chapter id(有序)
 * @param budgetChars    超预算时的截断上限
 *
 * 截断策略(与方案文档一致):超预算时保**头 70% + 尾 30%**,中间用省略标记 ——
 * 开头交代场景/人物、结尾往往是钩子,都是大纲最需要的;中段可省。
 * 返回 '' 表示拿不到任何原文(调用方据此降级回旧的标题锚点,不阻断)。
 */
export function sliceEpisodeExcerpt(
  novelText: string,
  chapters: LedgerChapterLike[],
  epChapterIds: string[],
  budgetChars = DEFAULT_EXCERPT_BUDGET,
): string {
  if (!novelText || !Array.isArray(chapters) || !Array.isArray(epChapterIds) || !epChapterIds.length) {
    return '';
  }
  const norm = normalizeLf(novelText);
  const byId = new Map<string, LedgerChapterLike>(chapters.map((c) => [String(c.id), c]));

  const parts: string[] = [];
  for (const cid of epChapterIds) {
    const ch = byId.get(String(cid));
    if (!ch) continue;
    const off = ch.char_offset;
    let body = '';
    if (Array.isArray(off) && off.length === 2) {
      const s = Math.max(0, Math.floor(Number(off[0]) || 0));
      const e = Math.min(norm.length, Math.ceil(Number(off[1]) || 0));
      if (e > s) body = norm.slice(s, e).trim();
    }
    if (!body) continue;
    const title = String(ch.title || '').trim();
    parts.push(title ? `【${title}】\n${body}` : body);
  }
  if (!parts.length) return '';

  const full = parts.join('\n\n');
  if (full.length <= budgetChars) return full;

  const head = Math.floor(budgetChars * 0.7);
  const tail = budgetChars - head;
  return `${full.slice(0, head)}\n…(中略 ${full.length - budgetChars} 字)...\n${full.slice(full.length - tail)}`;
}

/**
 * 把 beats 投影行格式化成大纲提示词里的"原文锚点"块。
 * must_show 的排在前、标 [必拍];quote 逐字用「」包起来,强调不可改写。
 * 没有 beats 时返回 ''(P0-a 未回填时的常态,调用方据此不渲染该块)。
 */
export function formatBeatsAnchor(beats: BeatAnchorLike[]): string {
  if (!Array.isArray(beats) || !beats.length) return '';
  const isMust = (b: BeatAnchorLike) => b.must_show === true || b.must_show === 1;
  const line = (b: BeatAnchorLike): string => {
    const summary = String(b.summary || '').trim();
    const quote = String(b.quote || '').trim();
    if (!summary && !quote) return '';
    const tag = isMust(b) ? '[必拍] ' : '';
    const id = String(b.id || '').trim();
    const idBit = id ? `{${id}} ` : '';
    const q = quote ? `:「${quote}」` : '';
    return `- ${idBit}${tag}${summary}${q}`;
  };
  // 必拍排前(稳定:各自保持原相对顺序),让大纲优先核销不可省的剧情点
  const ordered = [...beats].sort((a, b) => Number(isMust(b)) - Number(isMust(a)));
  const rows = ordered.map(line).filter(Boolean);
  return rows.join('\n');
}

/**
 * 综合:优先 beats 锚点(逐字、带必拍标记),没有 beats 时回落到原文摘录。
 * 两者都拿不到返回 ''。这样 P0-b 不依赖 P0-a:beats 未回填时,正文摘录照样能喂进去。
 */
export function buildEpisodeAnchor(input: {
  beats?: BeatAnchorLike[];
  novelText?: string;
  chapters?: LedgerChapterLike[];
  epChapterIds?: string[];
  budgetChars?: number;
}): { beatsAnchor: string; excerpt: string } {
  const beatsAnchor = formatBeatsAnchor(input.beats || []);
  const excerpt = sliceEpisodeExcerpt(
    input.novelText || '', input.chapters || [], input.epChapterIds || [], input.budgetChars,
  );
  return { beatsAnchor, excerpt };
}
