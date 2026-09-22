// ============================================================================
// timeline.ts —— 语义锚点时间轴（纯函数，无副作用）
// ----------------------------------------------------------------------------
// 解决什么问题（2026-09-15 立，方法论来源：hypit-ai/hypit 的「以词为锚」）：
//   旧的 buildSrt 是「按镜头 duration_sec 线性累加」——整句一块字幕，起点是
//   估算的。而现在台词是 Agnes 视频模型**现场念出来的**，它什么时候开口、
//   说多久，脚本完全不可控。实测证据（shot5.mp4，词级对齐）：
//
//     我们现在：  00:00:00,000 → 00:00:05,000   「老板还没睡啊」
//     真实语音：  1.22s         才开始说话
//     → 字幕起点比人声早 1.22 秒，且整句糊在一起。
//
//   时间轴的解法是换一个「锚」：
//     不再问「这一镜有多长」（秒为锚，估算）
//     而是问「这几个词什么时候被念出来」（词为锚，实测）
//
// ── 借鉴 hypit 的三层时间模型（2026-09-15 调研结论）────────────────────────
//   hypit 把时间分三层，我们照着建（见 docs/zh/guide/studio-temporal-windows）：
//
//     选择层  Script 的 Segment / Selection / Moment（作者语义身份）
//        ↓   投影：TemporalInstant / TemporalWindow（每个端点带 authority）
//     投影层  Instant/Window —— **只读**，来自语义与声学证据
//        ↓
//     消费层  Track（字幕 / Media / Text / Audio）共享**同一个 Timeline**
//
//   抄过来最有价值的一条（原话）：
//     「字幕 Cue 保持独立：直接从 Semantic token evidence 得到**只读** Cue 时间，
//      不伪装成可拖动的 TemporalWindow……只有 Fine 的 lead、tail、handoff
//      作为普通参数允许修改。」
//
//   → 所以本文件把 **证据** 与 **调优** 拆成两层：
//       · `window`       = 语义投影，只读（来自词级证据或降级估算，带 source 标签）
//       · `presentation` = 可调呈现参数（lead / tail / handoff）
//       · `display`      = 两者合成后的实际显示窗（派生，渲染只看它）
//     改"字幕早 0.1 秒出现"这类调优**不动证据**，证据永远不会被调参污染。
//
//   抄过来的另外三条：
//     · **归一化先于对齐**：先建立客观媒体事实（ffprobe 真实时长/帧率）再做 ASR，
//       顺序反了会把编码偏差当成语音偏差。
//     · **落在精确帧上**：时间位置按 fps 吸附，避免逐帧抖动（`snapToFrameSec`）。
//     · **拒绝而非静默修复**：越界/零宽/交叠这些情况我们**必须**自动兜底（生产
//       链路不能因为一条坏字幕整单失败），但**一律记进 `diagnostics`** ——
//       兜底可以，装作没发生不行。
//
//   ⚠️ 许可证红线：hypit 是「改进版 Apache 2.0」，明确禁止用于多租户/SaaS。
//      agentshop 正是多租户平台 → **不搬它的任何代码**。这里只借鉴机制，
//      词级对齐能力直接来自独立的 WhisperX/faster-whisper（BSD-2）。
//
// 为什么做成纯函数：
//   这一层是「字幕/音效/图形」共用的地基（多轨），必须可单测、可重放。
//   与 video-prompt.ts / keyframe-plan.ts / concept-art.ts 同一路数：
//   把易回退的判定逻辑钉死在单测里。
//
// 设计铁律（踩过，勿回退）：
//   · 时间窗来源必须**可审计**（source: 'asr' | 'estimated'）——ASR 不可用时
//     降级成估算，但绝不假装是实测。
//   · 无台词的镜头**不产出 cue**（不上屏），只推进时间轴。空字幕烧进画面
//     是一片空白块，还掩盖了"LLM 漏写台词"的事实（2026-09-15 已修过一轮）。
//   · 渲染只用 `display`，不要绕过它直接读 `window` —— 否则 lead/tail/handoff
//     全部失效，调优形同虚设。
// ============================================================================

import { sanitizeDialogue } from './dialogue-sanitizer';

// ── 基础类型 ────────────────────────────────────────────────────────────────

/** 词级时间戳（ASR 产出，秒） */
export interface WordTiming {
  word: string;
  startSec: number;
  endSec: number;
}

/** 时间窗（秒） */
export interface TimeWindow {
  startSec: number;
  endSec: number;
}

/** 台词类型：speech=角色对白 / voiceover=旁白画外音 / ambient=纯音效（不上屏） */
export type CueKind = 'speech' | 'voiceover' | 'ambient';

/**
 * 时间窗来源。'asr' = 有词级声学证据；'estimated' = ASR 缺失，按镜头时长估算。
 * 这个字段是「可信度标签」，不要为了整齐把它抹平。
 */
export type WindowSource = 'asr' | 'estimated';

/** 语义锚点 —— 一句可上屏文本的身份（对应 hypit 的「选择层」） */
export interface CueAnchor {
  /** 属于哪一镜（脚本层锚点，跨模块对齐用） */
  shotIdx: number;
  /** 说话人（从 "角色名：台词" 解析；解析不出为 null = 未署名） */
  speaker: string | null;
  kind: CueKind;
  /** 上屏文本（已剥离说话人前缀） */
  text: string;
}

/**
 * 呈现参数 —— 唯一允许外部修改的层（hypit: lead / tail / handoff）。
 * 与只读的语义 `window` 彻底分离，保证"调优不动证据"。
 */
export interface CuePresentation {
  /** 提前出现（秒）：字幕略早于人声，观感更跟手 */
  leadSec: number;
  /** 延后消失（秒） */
  tailSec: number;
  /**
   * 与相邻 cue 的交接方式：
   *   cut     = 交叠处取中点切开，任意时刻只显示一条（默认，字幕用）
   *   overlap = 保留双方包络，允许同框（贴纸/音效轨用）
   */
  handoff: 'cut' | 'overlap';
}

export const DEFAULT_PRESENTATION: CuePresentation = { leadSec: 0, tailSec: 0, handoff: 'cut' };

/** 一条字幕 cue = 锚点 + 只读语义窗 + 可调呈现 + 词级证据 */
export interface Cue {
  /** 稳定身份（来自作者声明，不是随机 id）：`shot{N}` */
  id: string;
  anchor: CueAnchor;
  /** 【只读】语义投影时间窗 —— 来自词级证据或降级估算；不要直接改它 */
  window: TimeWindow;
  /** 【可调】呈现参数 */
  presentation: CuePresentation;
  /** 【派生】实际显示窗 = window ± lead/tail，经交接与帧吸附；渲染只看这个 */
  display: TimeWindow;
  /** 落在本窗内的 ASR 词（source==='asr' 时非空） */
  words: WordTiming[];
  source: WindowSource;
  /** 文本被外部改过但音频未重新生成 → 时间窗可能已不匹配（需重跑 step4/5） */
  stale?: boolean;
}

/** 自动兜底的记录 —— 兜底可以，装作没发生不行 */
export type DiagnosticCode =
  | 'NO_ASR_EVIDENCE'      // 该句没有词级证据，时间窗靠估算
  | 'TOO_SHORT_EXTENDED'   // 证据窗过短，被撑到最短显示时长
  | 'OVERLAP_RESOLVED'     // 与相邻 cue 交叠，取中点切开
  | 'CLAMPED_TO_DURATION'  // 明显越界，被裁到片长
  | 'WORD_OUTSIDE_WINDOW'  // 有词落在所有镜头窗之外，被挂到最近镜头
  | 'TEXT_EDITED_STALE';   // 台词被改且字数变化大 → 语义窗可能与新文本不匹配

export interface TimelineDiagnostic {
  level: 'info' | 'warn';
  code: DiagnosticCode;
  shotIdx: number;
  detail: string;
}

/** 轨道类型 —— 长期扩展位：sfx(音效) / overlay(贴纸) 与 subtitle 共享同一批 cue 时间 */
export type TrackKind = 'subtitle' | 'sfx' | 'overlay';

export interface TimelineTrack {
  kind: TrackKind;
  /** 消费的 cue 身份列表（引用，不复制） */
  cueIds: string[];
}

/** 时间轴 = 一个成片的全部 cue + 多轨视图 + 总时长 + 装配统计 + 诊断 */
export interface Timeline {
  /** 来源身份（hypit 的 narrativeId）：跨模块校验"这条时间轴属于哪部剧" */
  narrativeId: string | null;
  /** 帧率（时间位置按它吸附；0 = 不吸附） */
  fps: number;
  cues: Cue[];
  /** 多轨视图 —— 目前只有 subtitle；sfx/overlay 是预留位，共享同一批 cue 时间 */
  tracks: TimelineTrack[];
  durationSec: number;
  stats: {
    total: number;
    /** 时间窗来自词级对齐的条数 */
    asr: number;
    /** 时间窗靠估算的条数（ASR 缺失/该句没被识别出来） */
    estimated: number;
    /** 无台词被跳过的镜头数 */
    skipped: number;
    /** 出现过的说话人（去重，按首次出现排序） */
    speakers: string[];
  };
  diagnostics: TimelineDiagnostic[];
}

/** 参与装配的最小镜头信息（不依赖 ShotForVideo，避免跨层耦合） */
export interface ShotForTimeline {
  idx?: number;
  dialogue?: string;
  duration_sec?: number;
}

// ── ① 帧吸附（归一化先于对齐的落地）─────────────────────────────────────────

/** 时间按 fps 吸附到精确帧（hypit: "位置须落在精确帧上"）。fps<=0 → 原样返回 */
export function snapToFrameSec(sec: number, fps: number): number {
  if (!Number.isFinite(sec)) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return sec;
  return Math.round(sec * fps) / fps;
}

// ── ② 说话人解析 ────────────────────────────────────────────────────────────

/**
 * 把一条 dialogue 拆成「说话人 + 类型 + 上屏文本」。
 *
 * 2026-09-15 起委托给 `dialogue-sanitizer.sanitizeDialogue` —— 旧实现只认
 * 「角色名：台词」一种格式，其余 6 种表演脚本写法全部原样上屏（字幕里出现
 * 「(咬牙)」「(陈明低沉地喘息)」「(旁白)」「苏微无声的口型解析：」这类脏文本），
 * 而且尾部音效括号里的「只有/声」会让整条被误判成 ambient、把真台词整条丢掉。
 * 净化器统一处理这些，并保证字幕与视频配音吃同一份干净文本。
 *
 * @param raw        原始 dialogue
 * @param knownNames 资产库角色名表（可空）。有名单时能在「××地说」「愤怒的××」
 *                   里精确认出角色名、并拆分一镜多说话人；无名单时保守处理
 *                   （「秦烈低声道：」→ speaker=null，与旧行为一致）。
 *
 * 实测分镜写法（genStep4Shots 产出）：
 *   "洛烛：白帝最后通牒已到。"        → speaker=洛烛
 *   "洛烛（冷笑）：你也配？"          → speaker=洛烛（括注去掉）
 *   "(少女轻声) 老板，还没睡啊？"      → speaker=null（括号是**表演提示**，不是名字）
 *   "秦烈低声道：果然…是我身边人。"    → 无名单 speaker=null；有名单 speaker=秦烈
 *   "(叮咚——门铃声)"                 → kind=ambient（不上屏）
 *   "旁白：三十年前的那场大雪…"        → kind=voiceover
 */
export function parseDialogueLine(
  raw: string,
  knownNames: string[] = [],
): { speaker: string | null; kind: CueKind | 'none'; text: string } {
  const s = sanitizeDialogue(raw, knownNames);
  return { speaker: s.speaker, kind: s.kind, text: s.text };
}

// ── ③ 时间窗：镜头基准线 ────────────────────────────────────────────────────

/**
 * 由镜头时长累加出每个镜头的**名义时间窗**（估算基准线）。
 *
 * durations 可传实测时长（ffprobe）覆盖 shot.duration_sec —— Agnes 返回的
 * duration_sec 是请求值，与实际编码时长可能差几十到几百毫秒，累加后误差会
 * 放大（第 15 镜可能偏 1 秒以上）。有实测值就优先用实测值。
 */
export function shotWindows(shots: ShotForTimeline[], durations?: number[]): TimeWindow[] {
  const out: TimeWindow[] = [];
  let cursor = 0;
  for (let i = 0; i < shots.length; i++) {
    const measured = durations?.[i];
    const raw = Number.isFinite(measured as number) && (measured as number) > 0
      ? (measured as number)
      : Number(shots[i]?.duration_sec);
    const dur = Number.isFinite(raw) && raw > 0 ? raw : 3;
    out.push({ startSec: cursor, endSec: cursor + dur });
    cursor += dur;
  }
  return out;
}

// ── ④ 词 → 镜头的分派 ───────────────────────────────────────────────────────

/**
 * 把整片 ASR 词流按名义时间窗分派给各镜头。
 *
 * 边界规则：按词的**起点**归属窗口（词跨窗时归它开始的那一窗）。
 * 落在所有窗口之外（片头静音、片尾拖尾、编码偏移）的词不丢弃 —— 挂到
 * 距离最近的窗口，宁可多给不可漏掉（漏词 = 字幕缺字），但会记一条诊断。
 */
export function assignWordsToWindows(words: WordTiming[], windows: TimeWindow[]): WordTiming[][] {
  const buckets: WordTiming[][] = windows.map(() => []);
  if (!windows.length) return buckets;

  for (const w of words || []) {
    if (!w || !Number.isFinite(w.startSec)) continue;
    let target = -1;
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      if (w.startSec >= win.startSec && w.startSec < win.endSec) { target = i; break; }
    }
    if (target < 0) {
      // 窗口外：挂到最近的窗口（按到窗口区间的距离）
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i];
        const d = w.startSec < win.startSec
          ? win.startSec - w.startSec
          : (w.startSec > win.endSec ? w.startSec - win.endSec : 0);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      target = best;
    }
    buckets[target].push(w);
  }
  // 每桶内按起点排序（ASR 正常有序，但降级/合并时可能乱）
  for (const b of buckets) b.sort((a, z) => a.startSec - z.startSec);
  return buckets;
}

// ── ⑤ 装配时间轴 ────────────────────────────────────────────────────────────

export interface BuildTimelineOptions {
  /** 来源身份（剧 uuid），写进 Timeline.narrativeId 供跨模块校验 */
  narrativeId?: string | null;
  /** 实测镜头时长（ffprobe），与 shots 一一对应；缺省回退 shot.duration_sec */
  durations?: number[];
  /** 帧率（帧吸附用；0/缺省 = 不吸附） */
  fps?: number;
  /** 字幕最短显示时长（秒）。过短会闪；默认 0.8 */
  minCueSec?: number;
  /** estimated 窗口相对镜头窗的内缩比例（两侧各留，避免贴边）；默认 0.06 */
  estimatedInset?: number;
  /** estimated 窗口最多占镜头时长比例（留白给下一句）；默认 0.9 */
  estimatedMaxRatio?: number;
  /** 每条 cue 的默认呈现参数（可后续单条覆盖） */
  presentation?: Partial<CuePresentation>;
  /** 资产库角色名表 —— 供净化器精确认出说话人（剥「××地说」「愤怒的××」、拆一镜多说话人）。
   *  缺省时净化器保守处理（不猜名字），字幕仍干净，只是 speaker 可能为 null。 */
  knownNames?: string[];
}

/**
 * 装配时间轴（选择层 → 投影层）。
 *
 * 一句话的时间窗优先级：
 *   ① 该镜窗口内**有 ASR 词** → 用首词起点 ~ 末词终点（source='asr'，实测）
 *   ② 没有词（静音镜 / 模型没念 / ASR 漏识） → 镜头窗内缩（source='estimated'）
 *   ③ 无台词 / 纯音效 → 不产出 cue（只推进时间轴）
 *
 * 交叠处理（对应 hypit 的 handoff）：
 *   · handoff==='cut'（默认） → 中点切开，任意时刻只显示一条
 *   · handoff==='overlap'     → 保留双方包络（贴纸/音效轨用）
 *
 * 所有自动兜底（撑长/裁剪/切分/挂词）都记入 diagnostics。
 */
export function buildTimeline(
  shots: ShotForTimeline[],
  words: WordTiming[],
  opts: BuildTimelineOptions = {},
): Timeline {
  const minCueSec = opts.minCueSec ?? 0.8;
  const inset = opts.estimatedInset ?? 0.06;
  const maxRatio = opts.estimatedMaxRatio ?? 0.9;
  const fps = Number.isFinite(opts.fps as number) ? Math.max(0, Number(opts.fps)) : 0;
  const defaultPresentation: CuePresentation = { ...DEFAULT_PRESENTATION, ...(opts.presentation || {}) };

  const list = Array.isArray(shots) ? shots : [];
  const windows = shotWindows(list, opts.durations);
  const buckets = assignWordsToWindows(words || [], windows);
  const durationSec = windows.length ? windows[windows.length - 1].endSec : 0;

  const cues: Cue[] = [];
  const diagnostics: TimelineDiagnostic[] = [];
  const speakers: string[] = [];
  let skipped = 0;
  let asrCount = 0;
  let estCount = 0;

  for (let i = 0; i < list.length; i++) {
    const shotIdx = Number.isFinite(Number(list[i]?.idx)) ? Number(list[i].idx) : i + 1;
    const parsed = parseDialogueLine(String(list[i]?.dialogue || ''), opts.knownNames || []);
    if (parsed.kind === 'none' || parsed.kind === 'ambient' || !parsed.text) { skipped++; continue; }

    const nominal = windows[i];
    const bucket = buckets[i] || [];
    let window: TimeWindow;
    let source: WindowSource;

    if (bucket.length) {
      window = { startSec: bucket[0].startSec, endSec: bucket[bucket.length - 1].endSec };
      source = 'asr';
      asrCount++;
    } else {
      const span = Math.max(0, nominal.endSec - nominal.startSec);
      const pad = span * inset;
      // 2026-09-21: 基于台词字数估算合理的展示时长(每字约0.28s + 0.8s首尾缓冲)
      // 避免3个字"小心点"在12秒镜头中霸屏11秒, 严重伤害观感
      const charCount = (parsed.text || '').replace(/\s+/g, '').length;
      const speechEstSec = Math.max(minCueSec, Math.min(span * maxRatio, charCount * 0.28 + 0.8));
      const usable = Math.max(minCueSec, Math.min(span - pad * 2, speechEstSec));
      window = { startSec: nominal.startSec + pad, endSec: nominal.startSec + pad + usable };
      source = 'estimated';
      estCount++;
      diagnostics.push({
        level: 'info', code: 'NO_ASR_EVIDENCE', shotIdx,
        detail: `本镜无词级证据,时间窗按镜头时长估算(${window.startSec.toFixed(2)}~${window.endSec.toFixed(2)}s)`,
      });
    }

    // 兜底：时长过短 → 向后撑到最短显示时长（记诊断,不静默）
    if (window.endSec - window.startSec < minCueSec) {
      const before = window.endSec - window.startSec;
      window = { startSec: window.startSec, endSec: window.startSec + minCueSec };
      diagnostics.push({
        level: 'info', code: 'TOO_SHORT_EXTENDED', shotIdx,
        detail: `证据窗仅 ${before.toFixed(2)}s,撑到最短显示时长 ${minCueSec}s`,
      });
    }

    if (parsed.speaker && !speakers.includes(parsed.speaker)) speakers.push(parsed.speaker);

    cues.push({
      id: `shot${shotIdx}`,
      anchor: { shotIdx, speaker: parsed.speaker, kind: parsed.kind, text: parsed.text },
      window,
      presentation: { ...defaultPresentation },
      display: { ...window },   // 先与语义窗一致,稍后由 resolveDisplay 应用 lead/tail/handoff
      words: bucket,
      source,
    });
  }

  const resolved = resolveDisplay(cues, durationSec, fps, diagnostics);
  // 词落在所有镜头窗之外 → 补一条诊断(不阻断,词已挂到最近镜头)
  const strayWords = (words || []).filter((w) => w
    && Number.isFinite(w.startSec)
    && !windows.some((win) => w.startSec >= win.startSec && w.startSec < win.endSec));
  if (strayWords.length) {
    diagnostics.push({
      level: 'info', code: 'WORD_OUTSIDE_WINDOW', shotIdx: 0,
      detail: `${strayWords.length} 个词落在镜头窗之外(片头静音/编码偏移),已挂到最近镜头`,
    });
  }

  return {
    narrativeId: opts.narrativeId ?? null,
    fps,
    cues: resolved,
    // 多轨视图：目前只有字幕消费；sfx/overlay 是预留位，共享同一批 cue 身份
    tracks: [{ kind: 'subtitle', cueIds: resolved.map((c) => c.id) }],
    durationSec,
    stats: { total: resolved.length, asr: asrCount, estimated: estCount, skipped, speakers },
    diagnostics,
  };
}

/**
 * 由「只读语义窗 + 可调呈现参数」导出**实际显示窗**（投影层 → 消费层之间那一步）。
 *
 * 这一步是 hypit 设计里最值得抄的地方：
 *   · lead/tail 让字幕略早出现/略晚消失，而**不动证据**
 *   · handoff='cut' 在交叠处取中点切开；'overlap' 保留双方包络
 *   · 最后按 fps 吸附到精确帧，避免逐帧抖动
 *
 * 原地写 `cue.display` 并返回新数组（cues 本身已是新对象，不改入参引用语义）。
 */
export function resolveDisplay(
  cues: Cue[],
  durationSec: number,
  fps: number,
  diagnostics?: TimelineDiagnostic[],
): Cue[] {
  const sorted = [...cues].sort((a, b) => a.window.startSec - b.window.startSec);

  // ① 应用 lead/tail，按帧吸附
  for (const c of sorted) {
    const p = c.presentation || DEFAULT_PRESENTATION;
    let start = c.window.startSec - (p.leadSec || 0);
    let end = c.window.endSec + (p.tailSec || 0);
    if (start < 0) start = 0;
    start = snapToFrameSec(start, fps);
    end = snapToFrameSec(end, fps);
    if (end <= start) end = snapToFrameSec(start + 0.2, fps);
    c.display = { startSec: start, endSec: end };
  }

  // ② 越界裁剪（只裁"明显越界">1s 的尾巴，小幅越界保留 —— 裁掉的是真在说的话）
  for (const c of sorted) {
    if (durationSec > 0 && c.display.endSec > durationSec + 1) {
      diagnostics?.push({
        level: 'warn', code: 'CLAMPED_TO_DURATION', shotIdx: c.anchor.shotIdx,
        detail: `显示窗终点 ${c.display.endSec.toFixed(2)}s 明显越界,裁到片长 ${durationSec.toFixed(2)}s`,
      });
      c.display.endSec = snapToFrameSec(durationSec, fps);
    }
  }

  // ③ 交接处理：任一方要求 cut 就切开（保守策略,可预测）
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const wantsCut = prev.presentation.handoff === 'cut' || cur.presentation.handoff === 'cut';
    if (!wantsCut) continue;
    if (prev.display.endSec > cur.display.startSec) {
      const mid = snapToFrameSec((prev.display.endSec + cur.display.startSec) / 2, fps);
      diagnostics?.push({
        level: 'info', code: 'OVERLAP_RESOLVED', shotIdx: cur.anchor.shotIdx,
        detail: `与上一句显示窗交叠,在 ${mid.toFixed(2)}s 取中点切开`,
      });
      prev.display.endSec = mid;
      cur.display.startSec = mid;
    }
  }

  // ④ 极端兜底：切分后可能倒挂，保 0.2s
  for (const c of sorted) {
    if (c.display.endSec <= c.display.startSec) {
      c.display.endSec = snapToFrameSec(c.display.startSec + 0.2, fps);
    }
  }

  // 保持原 cues 数组顺序（渲染不关心顺序，但 srt 序号要稳定）
  const byId = new Map(sorted.map((c) => [c.id, c]));
  return cues.map((c) => byId.get(c.id) || c);
}

// ── ⑥ 说话人配色 ────────────────────────────────────────────────────────────

/**
 * 默认说话人调色板（# 开头的 RGB）。挑的都是**亮色**：字幕压在画面上，
 * 描边是黑，底色越亮越清晰。
 */
export const DEFAULT_SPEAKER_COLORS = [
  '#FFD700', // 金
  '#87CEEB', // 天蓝
  '#FFB6C1', // 浅粉
  '#90EE90', // 浅绿
  '#FFA500', // 橙
  '#DDA0DD', // 梅红
  '#F0E68C', // 卡其
];

/** #RRGGBB → ASS 的 &H00BBGGRR& */
export function hexToAssColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return '&H00FFFFFF';
  const rr = m[1].slice(0, 2);
  const gg = m[1].slice(2, 4);
  const bb = m[1].slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

/** 按出现顺序给说话人分配颜色（超出调色板则循环） */
export function speakerColorMap(speakers: string[], palette?: string[]): Record<string, string> {
  const p = palette && palette.length ? palette : DEFAULT_SPEAKER_COLORS;
  const map: Record<string, string> = {};
  (speakers || []).forEach((s, i) => { map[s] = p[i % p.length]; });
  return map;
}

// ── ⑦ 排版：分行 ────────────────────────────────────────────────────────────

/**
 * 把长台词切成 ≤maxLines 行，每行尽量贴近 maxCharsPerLine。
 * 优先在标点处断（读起来自然），标点不够密时按字数硬断。
 */
export function wrapCueText(text: string, maxCharsPerLine = 18, maxLines = 2): string[] {
  const t = String(text || '').trim();
  if (!t) return [];
  const limit = Math.max(4, Math.floor(maxCharsPerLine));
  const hardMax = Math.max(1, Math.floor(maxLines));
  if (t.length <= limit) return [t];

  const chunks: string[] = [];
  const PUNCT = '。！？；…，、,.!?;';
  let rest = t;
  while (rest.length > 0) {
    if (rest.length <= limit) { chunks.push(rest); break; }
    // 在 [limit*0.6, limit] 区间内找最后一个标点
    const lo = Math.floor(limit * 0.6);
    let cut = -1;
    for (let i = Math.min(limit, rest.length) - 1; i >= lo; i--) {
      if (PUNCT.includes(rest[i])) { cut = i + 1; break; }
    }
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (chunks.length <= hardMax) return chunks;
  // 2026-09-16:超出行数上限**不再无限并入末行** —— 旧做法让末行宽度无上限,
  //   是"字幕超出屏幕"的直接根因之一。改为按 hardMax 行均分重排(标点优先断),
  //   行宽均匀;若均分后仍超宽,由 timelineToAss 的 {\fs} 缩字标签兜底
  //   (SRT 无缩字能力,尽力而为)。
  const per = Math.ceil(t.length / hardMax);
  const rebalanced: string[] = [];
  let rest2 = t;
  for (let i = 0; i < hardMax; i++) {
    if (i === hardMax - 1 || rest2.length <= per) { rebalanced.push(rest2); break; }
    let cut = per;
    for (let j = Math.min(per, rest2.length) - 1; j >= Math.floor(per * 0.6); j--) {
      if (PUNCT.includes(rest2[j])) { cut = j + 1; break; }
    }
    rebalanced.push(rest2.slice(0, cut));
    rest2 = rest2.slice(cut);
  }
  return rebalanced;
}

// ── ⑧ 输出：SRT ─────────────────────────────────────────────────────────────

export interface SubtitleStyleOptions {
  /** 是否显示"说话人："前缀。'auto' = 有两个以上说话人时才显示（默认） */
  showSpeakerName?: boolean | 'auto';
  /** 说话人 → #RRGGBB。缺省用 DEFAULT_SPEAKER_COLORS 按序分配 */
  speakerColors?: Record<string, string>;
  /** 每行字数上限，默认 18（传了 videoWidth 时缺省由像素宽推导） */
  maxCharsPerLine?: number;
  /** 最多行数，默认 2 */
  maxLines?: number;
  /** 逐词高亮（仅 ASS 支持；SRT 下忽略） */
  karaoke?: boolean;
  /**
   * 2026-09-16:成片真实分辨率(像素)。传了则 ASS 画布/字号/边距/每行字数
   * 全部按它推导 —— 旧实现硬编码 PlayRes 512×288(16:9),竖屏 9:16 成片被
   * libass 按高度放大近一倍,18 字远超屏宽(用户反馈"字幕超出屏幕"根因)。
   * 不传 = 维持旧 512×288 画布(老向导路径零行为变化)。
   */
  videoWidth?: number;
  videoHeight?: number;
}

/** ASS 画布布局参数(由成片分辨率推导;无分辨率时回退旧 512×288 校准值) */
export interface AssLayout {
  playResX: number;
  playResY: number;
  fontSize: number;
  marginLR: number;
  marginV: number;
  maxChars: number;
}

/**
 * 推导 ASS 画布布局。
 * 竖屏 720×1280 实测目标:字号 ≈ 屏宽 5%(36px)、左右安全边 ≈ 屏宽 5%、
 * 每行字数 = (宽 - 2×边) / 字号 ≈ 18 —— 与旧 16:9 校准的视觉密度对齐。
 */
export function assLayout(opts: SubtitleStyleOptions = {}): AssLayout {
  const w = Number(opts.videoWidth) > 0 ? Math.round(Number(opts.videoWidth)) : 0;
  const h = Number(opts.videoHeight) > 0 ? Math.round(Number(opts.videoHeight)) : 0;
  if (!w || !h) {
    return {
      playResX: 512, playResY: 288, fontSize: 12, marginLR: 16, marginV: 36,
      maxChars: opts.maxCharsPerLine ?? 18,
    };
  }
  const fontSize = Math.max(16, Math.round(w * 0.05));
  const marginLR = Math.max(16, Math.round(w * 0.05));
  const marginV = Math.max(24, Math.round(h * 0.1));
  const maxChars = opts.maxCharsPerLine
    ?? Math.max(10, Math.floor((w - 2 * marginLR) / fontSize));
  return { playResX: w, playResY: h, fontSize, marginLR, marginV, maxChars };
}

/** 秒 → SRT 时间码 HH:MM:SS,mmm */
export function formatSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const mm = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(mm, 3)}`;
}

function shouldShowSpeaker(tl: Timeline, opt: boolean | 'auto' | undefined): boolean {
  if (opt === true) return true;
  if (opt === false) return false;
  return (tl.stats?.speakers?.length || 0) >= 2;
}

/** 组装一条字幕的显示文本（含说话人前缀与换行） */
function renderCueText(c: Cue, opts: SubtitleStyleOptions, tl: Timeline): string {
  const showSpeaker = shouldShowSpeaker(tl, opts.showSpeakerName);
  const prefix = showSpeaker && c.anchor.speaker ? `${c.anchor.speaker}：` : '';
  // 2026-09-16:前缀计入折行预算 —— 旧实现先折行再拼前缀,首行 = 人名 + 满额正文,
  //   必超宽。现在正文按 (maxChars - 前缀长) 折,前缀只占首行预算。
  const layout = assLayout(opts);
  const maxChars = opts.maxCharsPerLine ?? layout.maxChars;
  const budget = Math.max(6, maxChars - prefix.length);
  const lines = wrapCueText(c.anchor.text, budget, opts.maxLines ?? 2);
  if (prefix && lines.length) lines[0] = prefix + lines[0];
  return lines.join('\n');
}

/** 渲染取 display（不是 window）—— 否则 lead/tail/handoff 全部失效 */
function cueDisplay(c: Cue): TimeWindow {
  return c.display || c.window;
}

export function timelineToSrt(tl: Timeline, opts: SubtitleStyleOptions = {}): string {
  const cues = tl?.cues || [];
  const colors = opts.speakerColors || speakerColorMap(tl?.stats?.speakers || []);
  const out: string[] = [];
  let seq = 0;
  for (const c of cues) {
    const text = renderCueText(c, opts, tl);
    if (!text.trim()) continue;
    const d = cueDisplay(c);
    out.push(String(++seq));
    out.push(`${formatSrtTime(d.startSec)} --> ${formatSrtTime(d.endSec)}`);
    // libass 在 SRT 里也认覆盖标签：给整行染说话人色（描边仍走 style）
    const hex = c.anchor.speaker ? colors[c.anchor.speaker] : null;
    out.push(hex ? `{\\c${hexToAssColor(hex)}&}${text}` : text);
    out.push('');
  }
  return out.join('\n');
}

// ── ⑨ 输出：ASS（长期主用） ──────────────────────────────────────────────────

/** 秒 → ASS 时间码 H:MM:SS.cc（厘秒） */
export function formatAssTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(c, 2)}`;
}

/**
 * 生成 ASS 字幕。
 *
 * 为什么长期走 ASS 而不是 SRT：
 *   · SRT 只能整条一个样式；ASS 能每条独立配色/定位 —— 多说话人一眼分清谁在说
 *   · ASS 有 \k 系列标签 —— 逐词高亮（"词为锚"的最直观体现）
 *   · 后续音效轨/图形轨也用同一份 cue 表驱动（多轨共享时间轴）
 *
 * 画布参数刻意与 burnSubtitlesInto 的旧 force_style **完全对齐**
 *   （PlayRes 512x288 / FontSize 12 / MarginV 36 / Outline 2），
 *   保证换成 ASS 后字幕视觉零回退。
 */
export function timelineToAss(tl: Timeline, opts: SubtitleStyleOptions = {}): string {
  const cues = tl?.cues || [];
  const colors = opts.speakerColors || speakerColorMap(tl?.stats?.speakers || []);
  const showSpeaker = shouldShowSpeaker(tl, opts.showSpeakerName);
  const layout = assLayout(opts);
  const maxChars = opts.maxCharsPerLine ?? layout.maxChars;
  const maxLines = opts.maxLines ?? 2;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',            // 智能换行（不主动折行，交由 \\N 控制）
    'ScaledBorderAndShadow: yes',
    // 2026-09-16:画布跟成片真实分辨率走(竖屏 720×1280 等),不再硬编码 512×288
    `PlayResX: ${layout.playResX}`,
    `PlayResY: ${layout.playResY}`,
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Default:不唱词的白(卡拉OK未启用时的唯一用到的样式)
    `Style: Default,Microsoft YaHei,${layout.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,${layout.marginLR},${layout.marginLR},${layout.marginV},1`,
    // Karaoke:未唱部分用次级色(灰),扫过变主色。仅 karaoke 模式用
    `Style: Karaoke,Microsoft YaHei,${layout.fontSize},&H00FFFFFF,&H00B4B4B4,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,${layout.marginLR},${layout.marginLR},${layout.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  /** 最长行超宽时整行等比缩字(下限 0.6 倍),保证不出安全区 */
  const shrinkTag = (longest: number): string => {
    if (longest <= maxChars) return '';
    const scale = Math.max(0.6, maxChars / longest);
    return `{\\fs${Math.max(10, Math.round(layout.fontSize * scale))}}`;
  };

  const lines: string[] = [];
  for (const c of cues) {
    const text = String(c.anchor.text || '').trim();
    if (!text) continue;

    const d = cueDisplay(c);
    const hex = c.anchor.speaker ? colors[c.anchor.speaker] : null;
    const colorTag = hex ? `{\\c${hexToAssColor(hex)}&}` : '';
    const prefix = showSpeaker && c.anchor.speaker ? `${c.anchor.speaker}：` : '';

    let body: string;
    let style = 'Default';

    if (opts.karaoke && c.words && c.words.length) {
      style = 'Karaoke';
      // \k 的单位是厘秒；每个词按自己的词窗时长扫过。
      const parts = c.words.map((w) => {
        const durCs = Math.max(1, Math.round((w.endSec - w.startSec) * 100));
        return `{\\k${durCs}}${escapeAssText(w.word)}`;
      });
      body = parts.join('');
      // 卡拉OK 时说话人前缀单独用主色（否则会被扫色吃掉）
      if (prefix) body = `{\\c&H00FFFFFF&}${escapeAssText(prefix)}${body}`;
      // 卡拉OK 不折行(单行),按 前缀+全文 字数缩字兜底
      body = shrinkTag(prefix.length + text.length) + body;
    } else {
      const wrapped = wrapCueText(text, maxChars, maxLines).map(escapeAssText);
      const longest = wrapped.reduce(
        (m, l, i) => Math.max(m, l.length + (i === 0 ? prefix.length : 0)), 0,
      );
      body = shrinkTag(longest) + colorTag + escapeAssText(prefix) + wrapped.join('\\N');
    }

    const start = formatAssTime(d.startSec);
    const end = formatAssTime(Math.max(d.endSec, d.startSec + 0.2));
    lines.push(`Dialogue: 0,${start},${end},${style},,0,0,0,,${body}`);
  }

  return `${header}\n${lines.join('\n')}\n`;
}

/** 转义 ASS 文本里的保留字符（大括号会开启覆盖标签区，反斜杠是标签前缀） */
export function escapeAssText(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '＼')
    .replace(/\{/g, '（')
    .replace(/\}/g, '）')
    .replace(/\r?\n/g, '\\N');
}

// ── ⑩ 重排：改台词 → 时间轴重算 ─────────────────────────────────────────────

/**
 * 改台词后的重排。
 *
 * 诚实说明（不要在这里撒谎）：
 *   时间轴的精确性**同时依赖文本与音频**。hypit 走 TTS 现场合成，所以"改一句
 *   台词、时间轴自动重排"天然成立；我们的音频是 Agnes 视频模型念的，改文本
 *   必须重跑 step4/step6 才能改音频。
 *
 *   所以本函数做两件事：
 *     · 文本级替换：语义窗保持不变（音频没变，窗口仍然对），换掉显示文本
 *     · 诚实标记：字数变化超过阈值 → 标 stale=true（需重跑分镜视频），
 *       并在 diagnostics 留痕
 *
 *   要拿到精确的新时间轴，走 `buildTimeline(newShots, newWords)` —— 重新对齐。
 */
export function applyTextEdits(
  tl: Timeline,
  edits: Array<{ shotIdx: number; text?: string; speaker?: string | null }>,
  opts: { staleThreshold?: number } = {},
): { timeline: Timeline; needsRealign: boolean } {
  const threshold = opts.staleThreshold ?? 0.25;
  const byIdx = new Map<number, { text?: string; speaker?: string | null }>();
  for (const e of edits || []) byIdx.set(Number(e.shotIdx), e);

  let needsRealign = false;
  const diagnostics: TimelineDiagnostic[] = [...(tl?.diagnostics || [])];
  const cues = (tl?.cues || []).map((c) => {
    const e = byIdx.get(c.anchor.shotIdx);
    if (!e) return c;
    const nextText = e.text !== undefined ? String(e.text) : c.anchor.text;
    const nextSpeaker = e.speaker !== undefined ? e.speaker : c.anchor.speaker;
    const before = c.anchor.text.length || 1;
    const after = nextText.length;
    const changed = Math.abs(after - before) / before > threshold;
    if (changed) {
      needsRealign = true;
      diagnostics.push({
        level: 'warn', code: 'TEXT_EDITED_STALE', shotIdx: c.anchor.shotIdx,
        detail: `台词字数变化 ${before}→${after},超出 ${Math.round(threshold * 100)}% 阈值;语义窗未重算,需重跑分镜视频后重新对齐`,
      });
    }
    return {
      ...c,
      anchor: { ...c.anchor, text: nextText, speaker: nextSpeaker ?? null },
      stale: c.stale || changed,
    };
  });

  const speakers: string[] = [];
  for (const c of cues) if (c.anchor.speaker && !speakers.includes(c.anchor.speaker)) speakers.push(c.anchor.speaker);

  return {
    timeline: {
      ...tl,
      cues,
      tracks: tl?.tracks?.length ? tl.tracks : [{ kind: 'subtitle', cueIds: cues.map((c) => c.id) }],
      stats: { ...(tl?.stats || { total: 0, asr: 0, estimated: 0, skipped: 0, speakers: [] }), total: cues.length, speakers },
      diagnostics,
    },
    needsRealign,
  };
}
