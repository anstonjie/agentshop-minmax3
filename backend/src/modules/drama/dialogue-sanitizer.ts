// ============================================================================
// dialogue-sanitizer.ts —— 分镜台词净化器（纯函数，无副作用，自包含）
// ----------------------------------------------------------------------------
// 解决什么问题（2026-09-15 立，证据来自本机 DB 10 部剧 / 51 集真实 dialogue）：
//   genStep4Shots 的提示词同时教 LLM 写「角色名:台词」和「(只有雨声)」两种格式，
//   LLM 实际产出的是**表演脚本格式** —— 含人名前缀、括注表情、音效描述、
//   一镜多说话人、`/` 分隔符。旧 timeline.parseDialogueLine 只认「角色名：台词」
//   一种，其余全部**原样上屏**，于是字幕里出现：
//     · 「陈明：(咬牙)稳住...」          —— body 里的表演括注不剥
//     · 「(陈明低沉地喘息) 这是……」       —— 无冒号 → 整条上屏，人名+表演全进字幕
//     · 「苏微无声的口型解析：'去...'」   —— 括注内冒号被误判成说话人
//     · 「张晖:"按住伤口！"陈刚:"该死"」  —— 一镜两说话人，第二个名字夹在正文
//     · 「(旁白) 他的视线...」            —— 旁白标记泄漏
//   更糟的是同一条脏文本还被 video-prompt.dialogueInstruction 原样塞进视频模型
//   prompt → **配音也会把「（咬牙）」「（旁白）」念出来**（音画双脏）。
//
// 还修掉一个更隐蔽的丢台词 bug：
//   旧 classifyDialogue 对**整条原文**做子串匹配判 ambient，台词里只要出现
//   「只有 / 声 / 音效」等词（哪怕只在尾部音效括号里），整条会被误判成 ambient
//   → 真台词被**整条丢弃**（不上屏、也不念）。实测样本：
//     「陈明：别动！...好冷，像冰水灌进血管。/（只有电流滋滋声和风声）」
//   含「只有」→ 旧逻辑判 ambient → 「别动！...」这句主角台词彻底消失。
//   本净化器改为**先清洗（拆 `/`、剥括注）再分类**，台词段与音效段分开处理，
//   既不让音效描述上屏，也不会把真台词误杀。
//
// 设计铁律（踩过，勿回退）：
//   · **一处净化，两处消费** —— timeline.renderCueText（字幕）与
//     video-prompt.dialogueInstruction（配音指令）必须吃同一份净化后的文本。
//     只修字幕不修 prompt，观众还是会在音轨里听到「（旁白）」。
//   · **净化不丢信息** —— 剥掉的表演提示归 performance、音效描述归 ambient，
//     供视频模型做情绪/音效指令，而不是直接扔掉。
//   · **先清洗再分类** —— 绝不对含混合内容的原文整体做 ambient 子串匹配。
//   · **knownNames 可选** —— 无名单时保守（不敢把「××地说」当名字，保持旧行为
//     speaker=null）；有名单时精确（动词尾巴/前置情绪修饰里也能认出角色名）。
//   · 纯函数 + 单测 —— 与 keyframe-plan / video-prompt / timeline 同一套纪律。
// ============================================================================

/** 台词类型：speech=角色对白 / voiceover=旁白画外音 / ambient=纯音效（不上屏）/ none=空 */
export type DialogueKind = 'speech' | 'voiceover' | 'ambient' | 'none';

export interface SanitizedDialogue {
  /** 说话人（净化后，不含情绪修饰/动词尾巴）；未署名为 null */
  speaker: string | null;
  /** 类型 */
  kind: DialogueKind;
  /** 上屏 / 念出来的纯净台词（不含括注、人名前缀、音效描述） */
  text: string;
  /** 剥掉的表演提示（供视频模型做情绪指令，不上屏） */
  performance: string[];
  /** 剥掉的音效描述（供视频模型做 ambient 指令，不上屏） */
  ambient: string[];
  /** 一镜多说话人时，第 2+ 段（每段各自净化；主段留在 speaker/text） */
  extraSpeakers: Array<{ speaker: string | null; text: string }>;
}

/** 括注：中英文圆括号 / 方括号（全局匹配用） */
const PAREN_GLOBAL = /[(（\[【][^)）\]】]*[)）\]】]/g;
/** 开头括注前缀 */
const LEADING_PAREN = /^[(（\[【]([^)）\]】]*)[)）\]】]\s*/;
/** 整条被括号包裹 */
const WHOLE_PAREN = /^[(（\[【][\s\S]*[)）\]】]$/;
/** 取括注「内」的文字（捕获组）。
 *  ⚠ 不要用 `s.replace(PAREN_GLOBAL,'')` 取内容 —— PAREN_GLOBAL 匹配的是整个括注组
 *  （含内容），replace 会把内容一起删光得到空串（曾据此丢光 performance/ambient）。 */
const PAREN_INNER = /^[(（\[【]([\s\S]*)[)）\]】]$/;
function parenInner(s: string): string {
  const m = PAREN_INNER.exec(String(s).trim());
  return m ? m[1].trim() : String(s).trim();
}

/** 音效关键词（括注内含这些、且不含表演词 → 归 ambient） */
const SFX_HINTS = [
  '声', '音', '轰鸣', '嗡嗡', '滋滋', '咔哒', '脚步', '雨声', '风声', '雷声',
  '警报', '电流', '金属', '撞击', '摩擦', '脉冲', '心跳', '噪音', '白噪音',
  '门铃', '枪声', '爆炸', '嘶吼', '喘息声',
];

/** 表演提示关键词（括注内含这些 → 归 performance，即使也含「声」字） */
const PERF_HINTS = [
  '咬牙', '皱眉', '冷笑', '怒吼', '低语', '轻声', '颤抖', '急促', '震惊', '疑惑',
  '愤怒', '悲伤', '喜悦', '恐惧', '喘息', '叹气', '停顿', '沉默', '口型', '语气',
  '语速', '低声', '大喊', '喃喃', '哽咽', '苦笑', '大笑', '冷笑', '嗤笑', '深吸',
];

/** 旁白/画外音标记 */
const VOICEOVER_RE = /旁白|画外音|内心独白|独白/;

/** 说话动词结尾（「××地说/道/喊」→ 整段不是名字） */
const SPEECH_VERB_TAIL = /(说|道|喊|问|答|吼|叫|嘀咕|喃|唤|笑道|怒道|低声道|轻声说|大声说|冷冷道|缓缓道)$/;

/** 前置情绪修饰（无名单时通配剥「××的」，如「愤怒的李明」→「李明」） */
const LEADING_EMOTION = /^(.{1,6}?的)(?=\S{1,8}$)/;

/** 正则转义 */
function escapeRe(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSfx(inner: string): boolean {
  return SFX_HINTS.some((h) => inner.includes(h));
}
function isPerf(inner: string): boolean {
  return PERF_HINTS.some((h) => inner.includes(h));
}

/** 在 knownNames 里找「以 s 开头」的最长名字（用于「(陈明低沉地喘息)」「陈明低声道」） */
function matchNamePrefix(s: string, knownNames: string[]): string | null {
  let best: string | null = null;
  for (const n of knownNames) {
    if (n && s.startsWith(n) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

/** 在 knownNames 里找「以 s 结尾」的名字（用于「愤怒的李明」→「李明」） */
function matchNameSuffix(s: string, knownNames: string[]): string | null {
  let best: string | null = null;
  for (const n of knownNames) {
    if (n && s.endsWith(n) && s.length > n.length && (!best || n.length > best.length)) best = n;
  }
  return best;
}

const EMPTY: SanitizedDialogue = {
  speaker: null, kind: 'none', text: '', performance: [], ambient: [], extraSpeakers: [],
};

/**
 * 净化一条 dialogue。
 *
 * @param raw        LLM 产出的原始 dialogue 文本
 * @param knownNames 资产库角色名表（用于动词尾巴/前置情绪/多说话人的精确识别）；可空
 */
export function sanitizeDialogue(raw: string, knownNames: string[] = []): SanitizedDialogue {
  const t0 = String(raw ?? '').trim();
  if (!t0) return { ...EMPTY };

  const names = (knownNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  const performance: string[] = [];
  const ambient: string[] = [];
  let speaker: string | null = null;
  let voiceover = false;
  let t = t0;

  // ── ① 拆 `/` 分隔段：台词段保留，纯括注段归 ambient/performance ──
  //    必须在分类之前做 —— 否则尾部音效括号里的「只有/声」会把整条误判成 ambient。
  if (t.includes('/')) {
    const parts = t.split(/\s*\/\s*/).filter((x) => x && x.trim());
    if (parts.length > 1) {
      const lineParts: string[] = [];
      for (const p of parts) {
        const seg = p.trim();
        if (WHOLE_PAREN.test(seg)) {
          const inner = parenInner(seg);
          if (inner) (isSfx(inner) && !isPerf(inner) ? ambient : performance).push(inner);
        } else {
          lineParts.push(seg);
        }
      }
      t = lineParts.join(' ').trim();
    }
  }

  // ── ② 整条被括号包裹（拆完 `/` 后仍如此）→ 纯音效 / 纯表演，不上屏 ──
  if (WHOLE_PAREN.test(t)) {
    const inner = parenInner(t);
    if (VOICEOVER_RE.test(inner)) {
      // 「(旁白)」「(内心独白)」单独成条 → 旁白，但无正文可上屏
      return { ...EMPTY, kind: 'ambient', ambient: inner ? [inner] : [] };
    }
    if (inner && isSfx(inner) && !isPerf(inner)) {
      return { ...EMPTY, kind: 'ambient', ambient: [inner] };
    }
    // 含表演线索但无台词正文（如「(无对白，只有罗盘指针摩擦的尖锐声)」）→ ambient
    return { ...EMPTY, kind: 'ambient', ambient: inner ? [inner] : [], performance };
  }

  // ── ③ 剥掉开头的「(…)」前缀（人名 / 表演 / 旁白标记）──
  const lead = LEADING_PAREN.exec(t);
  if (lead) {
    const inner = lead[1].trim();
    if (VOICEOVER_RE.test(inner)) {
      voiceover = true;
      performance.push(inner);
    } else if (isSfx(inner) && !isPerf(inner)) {
      ambient.push(inner);
    } else {
      // 可能含人名：「(陈明)」「(陈明低沉地喘息)」「(少女轻声)」
      const hit = matchNamePrefix(inner, names);
      if (hit) {
        speaker = hit;
        const rest = inner.slice(hit.length).trim();
        if (rest) performance.push(rest);
      } else {
        performance.push(inner); // 认不出人名 → 整段当表演提示，绝不上屏
      }
    }
    t = t.slice(lead[0].length).trim();
  }

  // ── ④ 剥掉正文里剩余的所有括注 ──
  const remaining = t.match(PAREN_GLOBAL) || [];
  for (const p of remaining) {
    const inner = parenInner(p);
    if (!inner) continue;
    (isSfx(inner) && !isPerf(inner) ? ambient : performance).push(inner);
  }
  t = t.replace(PAREN_GLOBAL, '').replace(/\s{2,}/g, ' ').trim();

  // ── ④½ 无括号「人名+表情副词/说话动词」前缀(2026-09-16 补) ──
  //    用户实测残留格式:「张三愤怒地你怎么能这样」「张三冷冷说道走吧」——
  //    无冒号、无括号,⑤ 的冒号格式与 ⑦ 的「名:台词」都接不住,整条上屏。
  //    有名单时按名单剥「名字 + 副词(…地)/ 说话动词(…道)」,副词归 performance。
  if (names.length && t) {
    const hit = matchNamePrefix(t, names);
    if (hit && t.length > hit.length) {
      const adv = /^(?:([^，。！？、；：:\s]{1,6}地)|([^，。！？、；：:\s]{0,4}(?:说道|喊道|问道|答道|吼道|叫道|低声道|冷冷道|缓缓道|怒道|笑道|苦笑道|冷笑道|喃喃道|嘀咕道|哽咽道|叹道)))/.exec(
        t.slice(hit.length),
      );
      if (adv) {
        const tail = (adv[1] || adv[2] || '').trim();
        if (tail) {
          speaker = speaker || hit;
          performance.push(tail);
          // 剥完前缀可能残留冒号(「秦烈低声道：…」)→ 一并去掉,否则正文以「：」开头
          t = t.slice(hit.length + adv[0].length).replace(/^[：:\s]+/, '').trim();
        }
      }
    }
  }

  // ── ⑤ 处理「角色名：台词」冒号格式 ──
  const colon = /^([^：:\n]{1,14})[：:]\s*([\s\S]+)$/.exec(t);
  if (colon) {
    let head = colon[1].trim();
    const body = colon[2].trim();
    let headTrustworthy = true;

    // 剥「××地说/道/喊」动词尾巴
    if (SPEECH_VERB_TAIL.test(head)) {
      const hit = matchNamePrefix(head, names);
      if (hit) {
        const rest = head.slice(hit.length).replace(SPEECH_VERB_TAIL, '').trim();
        if (rest) performance.push(rest);
        head = hit;
      } else {
        // 无名单 → 不敢把动词短语当名字（保持旧行为：speaker=null），但正文仍取 body
        headTrustworthy = false;
      }
    }

    // 剥前置情绪修饰「愤怒的李明」→「李明」
    if (headTrustworthy) {
      if (names.length) {
        const hit = matchNameSuffix(head, names);
        if (hit && hit !== head) {
          const modifier = head.slice(0, head.length - hit.length).trim();
          if (modifier) performance.push(modifier);
          head = hit;
        }
      } else {
        const m = LEADING_EMOTION.exec(head);
        if (m) { performance.push(m[1]); head = head.slice(m[1].length).trim(); }
      }
    }

    const wrapped = WHOLE_PAREN.test(head);
    const hasTailPunct = /[。！？，、；…]$/.test(head);
    if (headTrustworthy && body && !wrapped && !hasTailPunct && head && head.length <= 12) {
      speaker = head;
      t = body;
    } else if (body) {
      // head 不可信（动词短语/括注/带标点）→ 丢掉 head，只用 body，避免名字泄漏
      t = body;
    }
  }

  // ── ⑥ 旁白复核：speaker 本身就是旁白标记 → 归 voiceover，speaker 清空 ──
  if (speaker && VOICEOVER_RE.test(speaker)) {
    voiceover = true;
    performance.push(speaker);
    speaker = null;
  }

  // ── ⑦ 一镜多说话人：扫正文里残留的「已知名字：台词」──
  const extraSpeakers: Array<{ speaker: string | null; text: string }> = [];
  if (names.length && t) {
    for (const name of names) {
      if (name === speaker) continue;
      const re = new RegExp(`(?:^|[，。！？、；""\\s])${escapeRe(name)}[：:]\\s*([^：:\\n]+)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) {
        const seg = m[1].trim();
        if (seg) extraSpeakers.push({ speaker: name, text: seg });
      }
    }
    if (extraSpeakers.length) {
      // 从主段正文里剥掉这些子段，避免重复上屏
      for (const seg of extraSpeakers) {
        t = t.replace(new RegExp(`${escapeRe(seg.speaker!)}[：:]\\s*${escapeRe(seg.text)}`, 'g'), '');
      }
      t = t.replace(/^[，。！？、；""\s]+/, '').replace(/[，。！？、；""\s]+$/, '').trim();
      // 主段被剥空 → 用第一个子段顶替为主说话人
      if (!t && extraSpeakers.length) {
        const first = extraSpeakers.shift()!;
        speaker = first.speaker;
        t = first.text;
      }
    }
  }

  // ── ½ 行内残留清理(2026-09-16 端到端验收补) ──
  //   多说话人拆段后,正文仍可能残留「。沈昭：」(名字在行内没被拆走)与
  //   「。:」(名字剥了、冒号没剥)两类脏痕 —— 统一收掉,字幕不再出现半截人名。
  if (names.length && t) {
    for (const name of names) {
      t = t.replace(new RegExp(`([。！？；])\\s*${escapeRe(name)}[：:]\\s*`, 'g'), '$1');
    }
  }
  t = t.replace(/([。！？；])\s*[：:]\s*/g, '$1').trim();

  // ── ⑧ 收尾判定 kind ──
  if (!t && !extraSpeakers.length) {
    if (ambient.length) return { speaker: null, kind: 'ambient', text: '', performance, ambient, extraSpeakers: [] };
    return { ...EMPTY, performance, ambient }; // none
  }

  const kind: DialogueKind = voiceover ? 'voiceover' : 'speech';
  return { speaker, kind, text: t, performance, ambient, extraSpeakers };
}
