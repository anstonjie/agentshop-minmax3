// ============================================================================
// rhythm-guard.ts —— P1-d 镜头节奏角色(借 reelbench taxonomy 第五节)
// ----------------------------------------------------------------------------
// 诊断:咱们镜头没有"这一镜为什么留得住人"的概念,是"支离破碎"的叙事层根因。
// reelbench 用 8 个节奏角色按「观众这一刻得到什么」分类,并做三条整集校验
// (开篇有没有钩子 / payoff 前有没有铺垫 / 有没有连着 6 镜节奏发平)。
//
// 全部纯函数:MVP 只出 warnings 不硬拦(节奏是导演判断,不是对错)。
// 与 P0 的衔接:setup→payoff 正对上 beat 的 foreshadow_pair(伏笔↔回收)。
// ============================================================================

/** 8 个节奏角色(reelbench taxonomy.md 第五节) */
export const RHYTHM_ROLES = [
  'hook', 'setup', 'build', 'beat', 'turn', 'payoff', 'breath', 'close',
] as const;
export type RhythmRole = typeof RHYTHM_ROLES[number];

const ROLE_LABEL: Record<RhythmRole, string> = {
  hook: '钩子', setup: '铺垫', build: '递进', beat: '重音',
  turn: '转折', payoff: '兑现', breath: '换气', close: '收口',
};

/** 中文/别名 → 标准枚举。认不出返回 null(调用方据此提示补标)。 */
const ALIAS: Record<string, RhythmRole> = {
  钩子: 'hook', 开场: 'hook', 开篇: 'hook',
  铺垫: 'setup', 交代: 'setup',
  递进: 'build', 推进: 'build', 升级: 'build',
  重音: 'beat', 强调: 'beat', 特写重音: 'beat',
  转折: 'turn', 反转: 'turn',
  兑现: 'payoff', 回收: 'payoff', 爽点: 'payoff',
  换气: 'breath', 留白: 'breath', 停顿: 'breath',
  收口: 'close', 收尾: 'close', 落点: 'close', 结尾: 'close',
};
export function normalizeRhythm(v: unknown): RhythmRole | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if ((RHYTHM_ROLES as readonly string[]).includes(s)) return s as RhythmRole;
  const zh = String(v ?? '').trim();
  return ALIAS[zh] || ALIAS[zh.toLowerCase()] || null;
}

export interface RhythmShotLike {
  idx?: number;
  rhythm?: string;
  duration_sec?: number;
}

export interface RhythmReport {
  /** 标了合法 rhythm 的镜头数 */
  tagged: number;
  /** 未标/标错的镜头 idx */
  untagged: number[];
  /** 各角色分布 */
  distribution: Partial<Record<RhythmRole, number>>;
  warnings: string[];
}

/** 开篇多少秒内该出现钩子(reelbench hookWindowSeconds=5;咱们每镜较长,放宽到首镜或前 8 秒) */
export const HOOK_WINDOW_SEC = 8;
/** 连续多少镜同一角色算"节奏平"(reelbench flatRun=6) */
export const FLAT_RUN = 6;

/**
 * 整集节奏校验(纯函数,只提示不拦)。
 * 三条检查照搬 reelbench:①开篇钩子 ②payoff 前有 setup/build ③连续 FLAT_RUN 镜同角色。
 * 额外:统计未标镜头,提示"整片标或整片不标"(半张表汇总不出节奏曲线)。
 */
export function checkEpisodeRhythm(shots: RhythmShotLike[]): RhythmReport {
  const warnings: string[] = [];
  const distribution: Partial<Record<RhythmRole, number>> = {};
  const untagged: number[] = [];
  const roles: Array<RhythmRole | null> = [];

  if (!Array.isArray(shots) || !shots.length) {
    return { tagged: 0, untagged: [], distribution, warnings };
  }

  for (const s of shots) {
    const r = normalizeRhythm(s?.rhythm);
    roles.push(r);
    if (!r) { untagged.push(Number(s?.idx ?? 0)); continue; }
    distribution[r] = (distribution[r] || 0) + 1;
  }
  const tagged = roles.filter(Boolean).length as number;

  // 半张表:标了一部分又不全 → 汇总不出节奏曲线(reelbench:整片标或整片不标)
  if (tagged > 0 && untagged.length > 0) {
    warnings.push(`节奏只标了 ${tagged}/${shots.length} 镜,未标 #${untagged.join(',#')} —— 半张表看不出节奏曲线,建议整集标全`);
  }
  // 全都没标 → 视为"本集不做节奏分析",不提示(可选字段)
  if (tagged === 0) return { tagged: 0, untagged, distribution, warnings };

  // ① 开篇钩子:前 HOOK_WINDOW_SEC 秒(或首镜)内应有 hook
  let acc = 0, hookInWindow = false;
  for (let i = 0; i < shots.length; i++) {
    if (roles[i] === 'hook') { hookInWindow = true; break; }
    acc += Number(shots[i]?.duration_sec) || 0;
    if (acc > HOOK_WINDOW_SEC) break;
  }
  if (!hookInWindow) warnings.push(`[提示·不拦] 开篇 ${HOOK_WINDOW_SEC}s 内没有 hook 镜头 —— 短视频去留就在前几秒`);

  // ② payoff 前应有 setup/build(兑现的是什么?)
  const firstPayoff = roles.indexOf('payoff');
  if (firstPayoff >= 0) {
    const before = roles.slice(0, firstPayoff);
    if (!before.includes('setup') && !before.includes('build')) {
      warnings.push('[提示·不拦] 第一个 payoff 之前没有 setup/build —— 兑现缺少铺垫');
    }
  }

  // ③ 连续 FLAT_RUN 镜同一角色 = 节奏平
  let run = 1;
  for (let i = 1; i < roles.length; i++) {
    if (roles[i] && roles[i] === roles[i - 1]) run++;
    else run = 1;
    if (run === FLAT_RUN) {
      warnings.push(`[提示·不拦] 第 #${Number(shots[i - FLAT_RUN + 1]?.idx ?? i - FLAT_RUN + 1)}~#${Number(shots[i]?.idx ?? i)} 连续 ${FLAT_RUN} 镜都是「${ROLE_LABEL[roles[i] as RhythmRole]}」,节奏发平,观众最容易在这里划走`);
    }
  }

  return { tagged, untagged, distribution, warnings };
}

/** 给分镜提示词用的节奏角色说明(与 genStep4Shots 的 sys 拼接) */
export function rhythmPromptGuide(): string {
  return `- rhythm(节奏角色,每镜必标一个):${RHYTHM_ROLES.map((r) => `${r}(${ROLE_LABEL[r]})`).join(' / ')}。
  按「观众这一刻得到什么」选:hook=反常/冲突/直接给结果,setup=看懂后面必需的信息,build=压力累加,
  beat=一个动作被单独砸实,turn=事情朝反方向走,payoff=前面埋的给出结果,breath=留白换气,close=结论/金句/落点。
  整集要求:开篇 ${HOOK_WINDOW_SEC}s 内要有 hook;payoff 之前要有 setup/build;不要连续 ${FLAT_RUN} 镜同一角色;
  **最后一镜(集尾钩子镜)的 rhythm 必须是 turn/payoff/hook** —— 集尾要留悬念落点,让下一集开场接得住,
  不许用 close/breath 把集尾收平(连续剧"连"的镜头级载体)`;
}

// ── 集尾钩子镜头硬门(2026-09-16 批2) ────────────────────────────────────────
// 诊断:hookIn/hookOut 只活在大纲文本层,镜头层没有任何强制 —— 每集结尾
// 经常是一个收口/换气镜,悬念没有画面载体,下一集开场自然"接不上"。
// 门语义:最后一镜 rhythm ∈ END_HOOK_ROLES;整集完全没标 rhythm 时不拦
// (可选字段,避免把老数据/降级路径误杀)。

/** 集尾钩子镜允许的节奏角色:转折/兑现/钩子都留得住人;close/breath 会把集尾收平 */
export const END_HOOK_ROLES: RhythmRole[] = ['turn', 'payoff', 'hook'];

export interface EndHookVerdict {
  ok: boolean;
  lastRole: RhythmRole | null;
  lastIdx: number;
  reason: string | null;
}

export function checkEpisodeEndHook(shots: RhythmShotLike[]): EndHookVerdict {
  if (!Array.isArray(shots) || !shots.length) {
    return { ok: true, lastRole: null, lastIdx: -1, reason: null };
  }
  const lastIdx = Number(shots[shots.length - 1]?.idx ?? shots.length - 1);
  const anyTagged = shots.some((s) => normalizeRhythm(s?.rhythm) !== null);
  if (!anyTagged) return { ok: true, lastRole: null, lastIdx, reason: null };
  const role = normalizeRhythm(shots[shots.length - 1]?.rhythm);
  if (role && (END_HOOK_ROLES as readonly string[]).includes(role)) {
    return { ok: true, lastRole: role, lastIdx, reason: null };
  }
  const allowed = END_HOOK_ROLES.map((r) => ROLE_LABEL[r]).join('/');
  return {
    ok: false,
    lastRole: role,
    lastIdx,
    reason: role
      ? `末镜 #${lastIdx} 节奏是「${ROLE_LABEL[role]}」,不是钩子镜(${allowed})`
      : `末镜 #${lastIdx} 未标 rhythm,无法确认集尾钩子`,
  };
}
