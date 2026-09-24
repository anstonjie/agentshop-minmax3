// ============================================================================
// n2d-engine.ts —— 小说→分集账本的对齐引擎(纯函数,无 DB/无进程)
// ----------------------------------------------------------------------------
// 来历(2026-09-24):原 tool/n2d-core 是独立 npm 工程,经子进程桥接
//   (novel-ledger.service runN2D)。源码丢失后,按 DB 里 36 部剧的真实产出 +
//   调用方契约在库内重建 —— 这本就是路线图 P2 定的 vendor 方向,提前执行。
//   子进程桥接同时下线:少一个构建产物、少 Windows spawn 坑,行为全单测锁定。
//
// 标定依据(生产账本 a1b8008e + novel.txt,1188 字,单测钉住):
//   · fold={cps:4.5, charsPerBeat:200, actionSecPerBeat:2.5} 直接来自账本
//     meta.budget.fold(单一事实源,不另起常量);
//   · 章 budget_sec = round(对白字数/4.5 + 叙述字数/200*2.5),三章 30/20/56
//     全部精确复现(29.99→30、20.08→20、55.80→56);
//   · 章节按 ^第.+章 行切分,offsets 连续覆盖全文,char_offset 为 LF 归一化域
//     (归一化复用 novel-anchor.normalizeLf,单一来源);
//   · dialogue_ratio 含引号标记、存 3 位小数(与生产同形;绝对值有 ±0.015 级残差,
//     原 span 细节不可考 —— dialogue_ratio 只有展示消费(plan 表),无逻辑依赖)。
// 恢复不了的(诚实注记,均为展示/字面量,不影响任何逻辑):
//   · k_eff 原公式未知。现定义为 total_minutes*10000/total_chars(展示用;
//     前端估算走自带 8.35 常量,不读它);
//   · k_band/eps_total/eps_chapter 原字面量(疑似装箱容差)。只保留有实据的
//     装箱容差 PACK_EPS=0.02,其余不 cargo-cult,新账本不再写。
// ============================================================================

import { normalizeLf } from './novel-anchor';

/** 折时常量 —— 与生产账本 meta.budget.fold 一致,改这里等于改全链路口径 */
export const N2D_FOLD = {
  /** 对白语速(字/秒) */
  cps: 4.5,
  /** 多少叙述字算一个动作节拍 */
  charsPerBeat: 200,
  /** 一个动作节拍几秒 */
  actionSecPerBeat: 2.5,
} as const;

/** 装箱容差:acc+ch 超过 target*(1+PACK_EPS) 才另起一集(恢复的字面量) */
export const N2D_PACK_EPS = 0.02;

/** 章节标题判定:行首"第"+短词缀+章/节/回,且整行 ≤40 字(防正文"第三个人…"误切) */
const CHAPTER_HEAD_RE = /^第\S{1,8}[章节回]/;
const CHAPTER_HEAD_MAX_LEN = 40;

export interface N2dChapter {
  id: string;
  title: string;
  char_offset: [number, number];
  budget_sec: number;
  dialogue_ratio: number;
  episode_ids: string[];
}

export interface N2dEpisode {
  id: string;
  chapters: string[];
  budget_sec: number;
  hook: string;
  cliffhanger: string;
  status: string;
  actual_sec: null;
}

export interface N2dLedgerJson {
  meta: {
    total_chars: number;
    version: number;
    title?: string;
    source?: string;
    budget: {
      total_minutes: number;
      k_eff: number;
      episode_count: number;
      ep_target_sec: number;
      fold: { cps: number; charsPerBeat: number; actionSecPerBeat: number };
    };
  };
  chapters: N2dChapter[];
  episodes: N2dEpisode[];
  beats: unknown[];
  audit_trail: unknown[];
}

export interface N2dChapterSlice {
  id: string;
  title: string;
  start: number;
  end: number;
}

/**
 * 切章:标题行切分,offsets 连续覆盖全文(LF 域)。
 * 无标题行 → 整篇一章(标题"正文");空输入 → [](调用方抛"空小说")。
 */
export function splitChapters(normalizedOrRaw: string): N2dChapterSlice[] {
  const norm = normalizeLf(normalizedOrRaw);
  if (!norm.trim()) return [];
  const lines = norm.split('\n');
  // 行首偏移表(标题行判定用行内容,切片用偏移)
  const starts: number[] = [];
  let pos = 0;
  for (const ln of lines) {
    starts.push(pos);
    pos += ln.length + 1; // +\n
  }
  const headIdx: number[] = [];
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t && t.length <= CHAPTER_HEAD_MAX_LEN && CHAPTER_HEAD_RE.test(t)) headIdx.push(i);
  });
  if (!headIdx.length) {
    return [{ id: 'ch_0001', title: '正文', start: 0, end: norm.length }];
  }
  // 标题行到下一标题行(不含)为一章;末章收到文末。标题行计入本章开头。
  return headIdx.map((li, k) => {
    const start = starts[li];
    const end = k + 1 < headIdx.length ? starts[headIdx[k + 1]] : norm.length;
    const title = lines[li].trim();
    return { id: `ch_${String(k + 1).padStart(4, '0')}`, title, start, end };
  });
}

const DIALOGUE_RES = [/"[^"\n]*"/g, /「[^「」\n]*」/g];

export interface FoldResult {
  budgetSec: number;
  dialogueRatio: number;
  dialogueChars: number;
  totalChars: number;
}

/**
 * 折时:budget=round(对白/4.5 + 叙述/200*2.5)。
 * 对白 = 直引号/「」span(含标记,生产口径);其余全算叙述。
 * round(非 floor):生产三章 29.99→30、20.08→20、55.80→56 全部精确命中。
 */
export function foldChapter(body: string): FoldResult {
  const text = String(body || '');
  const totalChars = text.length;
  if (!totalChars) return { budgetSec: 0, dialogueRatio: 0, dialogueChars: 0, totalChars: 0 };
  let dialogueChars = 0;
  for (const re of DIALOGUE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(text)) !== null) dialogueChars += m[0].length;
  }
  dialogueChars = Math.min(dialogueChars, totalChars);
  const narration = totalChars - dialogueChars;
  const budgetSec = Math.round(
    dialogueChars / N2D_FOLD.cps + (narration / N2D_FOLD.charsPerBeat) * N2D_FOLD.actionSecPerBeat,
  );
  return {
    budgetSec: Math.max(0, budgetSec),
    dialogueRatio: Math.round((dialogueChars / totalChars) * 1000) / 1000,
    dialogueChars,
    totalChars,
  };
}

export interface BuildLedgerInput {
  novelText: string;
  title?: string;
  source?: string;
  epTargetSec?: number;
}

/**
 * 装箱(init 等价):切章 → 逐章折时 → 贪心按集装(章永不拆散)。
 * 超 target*(1+PACK_EPS) 才另起一集;单章超长也独占一集(不切章)。
 */
export function buildLedgerJson(input: BuildLedgerInput): N2dLedgerJson {
  const norm = normalizeLf(input?.novelText || '');
  if (!norm.trim()) throw new Error('空小说无法建账本');
  const target = Number(input?.epTargetSec) > 0 ? Math.round(Number(input.epTargetSec)) : 120;
  const slices = splitChapters(norm);
  if (!slices.length) throw new Error('空小说无法建账本');

  const chapters: N2dChapter[] = slices.map((s) => {
    const body = norm.slice(s.start, s.end);
    const f = foldChapter(body);
    return {
      id: s.id,
      title: s.title,
      char_offset: [s.start, s.end],
      budget_sec: f.budgetSec,
      dialogue_ratio: f.dialogueRatio,
      episode_ids: [],
    };
  });

  const episodes: N2dEpisode[] = [];
  let acc: N2dChapter[] = [];
  let accSec = 0;
  const flush = () => {
    if (!acc.length) return;
    const id = `ep_${String(episodes.length + 1).padStart(3, '0')}`;
    const budget = acc.reduce((s, c) => s + c.budget_sec, 0);
    for (const c of acc) c.episode_ids = [id];
    episodes.push({
      id, chapters: acc.map((c) => c.id), budget_sec: budget,
      hook: '', cliffhanger: '', status: 'pending', actual_sec: null,
    });
    acc = [];
    accSec = 0;
  };
  for (const c of chapters) {
    if (acc.length && accSec + c.budget_sec > target * (1 + N2D_PACK_EPS)) flush();
    acc.push(c);
    accSec += c.budget_sec;
  }
  flush();

  const totalContentSec = chapters.reduce((s, c) => s + c.budget_sec, 0);
  const totalMinutes = Math.round((totalContentSec / 60) * 100) / 100;
  return {
    meta: {
      total_chars: norm.length,
      version: 1,
      ...(input?.title ? { title: String(input.title) } : {}),
      ...(input?.source ? { source: String(input.source) } : {}),
      budget: {
        total_minutes: totalMinutes,
        k_eff: norm.length > 0 ? Math.round(((totalMinutes * 10000) / norm.length) * 100) / 100 : 0,
        episode_count: episodes.length,
        ep_target_sec: target,
        fold: { ...N2D_FOLD },
      },
    },
    chapters,
    episodes,
    beats: [],
    audit_trail: [],
  };
}

export type CheckLevel = 'error' | 'warn';

export interface N2dCheckViolation {
  rule: string;
  level: CheckLevel;
  target: string;
  message: string;
  userMessage?: string;
}

export interface CheckLedgerResult {
  ledgerJson: N2dLedgerJson;
  /** 审计行(与 service.parseAuditLine 同格式,可直接进 audit_trail) */
  violations: string[];
  /** 有 error 级即 true(对应原 CLI 退出码 2) */
  failed: boolean;
}

function auditLine(v: N2dCheckViolation): string {
  const base = `[${v.rule}] ${v.target}: ${v.message}`;
  return v.userMessage ? `${base} |U: ${v.userMessage}` : base;
}

/**
 * 校验(check:budget/check:coverage 等价)。
 * 规则来源:调用方既有注释与可观测行为 ——
 *   error(结构坏,failed=true):B-COUNT 集数对不上、B-SUM 章节/分集求和漂移、
 *     B-POS 空集/非正预算、B-TARGET 非正目标、C-REFS 引用不存在的章节;
 *   warn(内容质量,failed=false):I3 伏笔单边/缺foreshadow-reveal对(口径与
 *     beat-extract.reconcileForeshadowPairs 同:同键须凑齐 foreshadow 在前+
 *     reveal 在后)、I6 集 cliffhanger 为空、COV-1 must_show 未 covered。
 * 版本恒 +1,审计条目追加(末条为汇总对象,service 按 violations 回读)。
 */
export function checkLedgerJson(
  ledgerJson: N2dLedgerJson,
  which: 'budget' | 'coverage',
  stage = 'ingest',
): CheckLedgerResult {
  const lj = (ledgerJson || {}) as N2dLedgerJson;
  const chapters = Array.isArray(lj.chapters) ? lj.chapters : [];
  const episodes = Array.isArray(lj.episodes) ? lj.episodes : [];
  const beats = Array.isArray(lj.beats) ? lj.beats : [];
  const vs: N2dCheckViolation[] = [];
  const err = (rule: string, target: string, message: string, userMessage?: string) =>
    vs.push({ rule, level: 'error', target, message, userMessage });
  const warn = (rule: string, target: string, message: string, userMessage?: string) =>
    vs.push({ rule, level: 'warn', target, message, userMessage });

  if (which === 'budget') {
    const declared = Number((lj.meta as any)?.budget?.episode_count);
    if (!episodes.length) {
      err('B-EMPTY', 'episodes', '分集为空,无法报价', '账本没有分集,先重建账本');
    } else {
      if (!Number.isFinite(declared) || declared !== episodes.length) {
        err('B-COUNT', 'meta.budget.episode_count',
          `声明 ${String((lj.meta as any)?.budget?.episode_count)} 集,实际 ${episodes.length} 集`,
          '集数声明与实际分集不一致');
      }
      const sumCh = chapters.reduce((s, c) => s + (Number((c as any)?.budget_sec) || 0), 0);
      const sumEp = episodes.reduce((s, e) => s + (Number((e as any)?.budget_sec) || 0), 0);
      const tol = Math.max(1, sumCh * N2D_PACK_EPS);
      if (Math.abs(sumCh - sumEp) > tol) {
        err('B-SUM', 'episodes',
          `章节求和 ${sumCh}s 与分集求和 ${sumEp}s 漂移超 ${tol.toFixed(1)}s`,
          '时长账对不上,分集可能已损坏');
      }
      for (const e of episodes) {
        if (!(Number((e as any)?.budget_sec) > 0)) {
          err('B-POS', String((e as any)?.id || 'episode'), '存在 0/负时长分集', '有空集,先重建账本');
          break;
        }
      }
    }
    const target = Number((lj.meta as any)?.budget?.ep_target_sec);
    if (!(target > 0)) err('B-TARGET', 'meta.budget.ep_target_sec', '装箱目标缺失或非正', '目标集长丢失');
  } else {
    const chIds = new Set(chapters.map((c) => String((c as any)?.id)));
    for (const e of episodes) {
      const chs = Array.isArray((e as any)?.chapters) ? (e as any).chapters : [];
      for (const cid of chs) {
        if (!chIds.has(String(cid))) {
          err('C-REFS', String((e as any)?.id || 'episode'), `引用不存在的章节 ${cid}`, '分集引用了不存在的章节');
        }
      }
      if (!String((e as any)?.cliffhanger || '').trim()) {
        warn('I6', String((e as any)?.id || 'episode'), '集尾 cliffhanger 为空', '本集缺少钩子,成片结尾可能泄气');
      }
    }
    for (const b of beats as any[]) {
      if (!b || typeof b !== 'object') continue;
      if (!chIds.has(String((b as any).chapter))) {
        err('C-REFS', String((b as any).id || 'beat'), `引用不存在的章节 ${(b as any).chapter}`, '拍点引用了不存在的章节');
      }
    }
    // I3:同 reconcileForeshadowPairs 口径(只读版)—— 同键须凑齐 foreshadow 在前 + reveal 在后
    const byKey = new Map<string, any[]>();
    for (const b of beats as any[]) {
      if (!b || !(b as any).foreshadow_pair) continue;
      const k = String((b as any).foreshadow_pair);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(b);
    }
    for (const [k, group] of byKey) {
      const fsIdx = group.findIndex((b) => b?.type === 'foreshadow');
      const rvIdx = group.findIndex((b) => b?.type === 'reveal');
      if (group.length < 2 || fsIdx < 0 || rvIdx < 0 || fsIdx > rvIdx) {
        warn('I3', `foreshadow_pair:${k}`, '伏笔配对不存在(单边/缺foreshadow-reveal对/顺序反)', '有伏笔没回收,观众会觉得坑没填');
      }
    }
    for (const b of beats as any[]) {
      const mustShow = (b as any)?.must_show === true || (b as any)?.must_show === 1;
      const covered = (b as any)?.status === 'covered' && !!(b as any)?.covered_by;
      if (mustShow && !covered) {
        warn('COV-1', String((b as any)?.id || 'beat'), '必拍拍点未被任何集覆盖', '有必拍戏还没安排上镜');
      }
    }
  }

  const lines = vs.map(auditLine);
  const failed = vs.some((v) => v.level === 'error');
  const at = new Date().toISOString();
  const audit = Array.isArray((lj as any).audit_trail) ? [...(lj as any).audit_trail] : [];
  audit.push(...lines);
  audit.push({
    check: which === 'budget' ? 'check_budget' : 'check_coverage',
    stage, at, passed: !failed, violations: lines,
  });
  const next = {
    ...(lj as any),
    meta: { ...((lj as any).meta || {}), version: Number((lj as any)?.meta?.version || 0) + 1 },
    audit_trail: audit,
  };
  return { ledgerJson: next as N2dLedgerJson, violations: lines, failed };
}
