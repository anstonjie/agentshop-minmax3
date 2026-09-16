/**
 * 成片门(compose gate)—— 把"成片短一截而用户完全不知道"变成可拦的门。
 *
 * 背景(2026-09-16 七问题再排查,docs/短视频一键生成-七问题再排查与修复方案):
 *   drama77 七集实测 planned 10-12 镜 / composed 1-3 镜 / 成片 10-35s。
 *   根因是上游 503 video_queue_full 打死镜头 + genStep7Compose 静默丢段
 *   (`if(!sv.video_url) continue`,0 段才报错)。missing_shots 之前只上报不拦截,
 *   编排器照旧把剧集标 done —— 用户拿到 10 秒"成片"。
 *
 * 门的语义:
 *   · 存活镜比例 composed/planned ≥ 0.6
 *   · 成片时长 ≥ max(30, 目标集长 × 0.4)(无目标时兜底 45s)
 *   两条任一不过 = 不达标。编排器据此回 step4 补做失败镜后重合成(≤N 轮),
 *   仍不达标才交片,且 missing_shots 必须在前端露出(批3)。
 *
 * 纯函数,无 IO —— 击穿用例见 compose-gate.spec.ts。
 */

export interface ComposeGateVerdict {
  passed: boolean;
  planned: number;
  composed: number;
  ratio: number;
  durationSec: number;
  minRatio: number;
  minDurationSec: number;
  reasons: string[];
}

export const COMPOSE_GATE_MIN_RATIO = 0.6;

/** 无目标集长时的兜底最短成片秒数 */
export const COMPOSE_GATE_FALLBACK_MIN_SEC = 45;

/** 最短成片秒数:有目标集长按 40% 算(下限 30s),没有则兜底 45s */
export function composeGateMinDurationSec(targetSec: number): number {
  const t = Number(targetSec);
  if (!Number.isFinite(t) || t <= 0) return COMPOSE_GATE_FALLBACK_MIN_SEC;
  return Math.max(30, Math.round(t * 0.4));
}

/**
 * 评估一次合成产出是否达标。
 * @param out genStep7Compose 的产出({planned_shots, composed_shots, duration_sec, ...})
 * @param targetSec 目标集长秒(批次 policy.epTargetSec);0/缺省 = 用兜底最短时长
 */
export function evaluateComposeGate(out: any, targetSec = 0): ComposeGateVerdict {
  const planned = Math.max(0, Math.floor(Number(out?.planned_shots) || 0));
  const composed = Math.max(0, Math.floor(Number(out?.composed_shots) || 0));
  const durationSec = Math.max(0, Number(out?.duration_sec) || 0);
  const minDurationSec = composeGateMinDurationSec(targetSec);
  const ratio = planned > 0 ? composed / planned : 1;

  const reasons: string[] = [];
  if (planned > 0) {
    if (ratio < COMPOSE_GATE_MIN_RATIO) {
      reasons.push(
        `存活镜 ${composed}/${planned}(${Math.round(ratio * 100)}%)低于 ${Math.round(COMPOSE_GATE_MIN_RATIO * 100)}% 门`,
      );
    }
    if (durationSec < minDurationSec) {
      reasons.push(`成片 ${Math.round(durationSec)}s 低于最短 ${minDurationSec}s 门`);
    }
  }
  return {
    passed: reasons.length === 0,
    planned, composed, ratio, durationSec,
    minRatio: COMPOSE_GATE_MIN_RATIO, minDurationSec,
    reasons,
  };
}

/** DRAMA_COMPOSE_GATE=0 可整体关闭拦截(仍会在日志里报 verdict) */
export function composeGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.DRAMA_COMPOSE_GATE || '').trim() !== '0';
}

/** 编排器最多自动补做几轮(回 step4 补失败镜 + 重合成)。DRAMA_COMPOSE_GATE_ROUNDS 覆盖,默认 2 */
export function composeGateMaxRounds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DRAMA_COMPOSE_GATE_ROUNDS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}
