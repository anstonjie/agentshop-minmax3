// ============================================================================
// degraded-retry.ts —— P2-b degraded 关键帧拦下重生(修画面保真/防换脸)
// ----------------------------------------------------------------------------
// 诊断:buildKeyframePlan 在镜头找不到定妆参考图(refUrls 为空)时 degraded=true,
// 退回**纯文生图** → 跨集换脸。现状 orchestrator 只在 degraded 比例≥0.5 时把整集标
// degraded 跳过后续;但"个别镜头 degraded"会直接进成片,变成换脸镜头。
// P2-b:在关键帧步骤内,对 degraded 的镜头**先尝试补参考图重生一次**,补不上再放行。
//
// ⚠️ 重生要额外图像生成额度,故 flag **默认关**:DRAMA_KEYFRAME_RETRY_DEGRADED=1 才启用。
// 本模块只做纯决策:哪些 degraded 镜头该重生、重生几次。质量优先的实测/演示可临时开。
// ============================================================================

export interface KeyframePlanLike {
  shotIdx: number;
  degraded?: boolean;
  /** 缺失的参考 slug(degraded 的原因);有值说明"补上这些参考图就能救" */
  missingRefs?: string[];
  /** 已经重试过的次数 */
  retries?: number;
}

export interface DegradedRetryPlan {
  enabled: boolean;
  /** 需要重生的镜头 idx(degraded 且重试次数未达上限) */
  retry: number[];
  /** 已放弃(重试到上限仍 degraded)的镜头 idx —— 放行但标记,供门③/前端提示 */
  giveUp: number[];
  /** degraded 占比(0~1),用于与整集阻断阈值对照 */
  degradedRatio: number;
}

/**
 * 规划 degraded 镜头重生。enabled=false(默认)→ 全部不重生(保持现状)。
 * maxRetry 默认 1(补一次参考图重生;再多是浪费额度)。
 */
export function planDegradedRetry(
  plans: KeyframePlanLike[],
  opts?: { enabled?: boolean; maxRetry?: number },
): DegradedRetryPlan {
  const list = Array.isArray(plans) ? plans : [];
  const enabled = !!opts?.enabled;
  const maxRetry = Number(opts?.maxRetry) >= 0 ? Number(opts?.maxRetry) : 1;
  const degraded = list.filter((p) => p?.degraded);
  const degradedRatio = list.length ? degraded.length / list.length : 0;
  if (!enabled) {
    return { enabled, retry: [], giveUp: degraded.map((p) => p.shotIdx), degradedRatio };
  }
  const retry: number[] = [];
  const giveUp: number[] = [];
  for (const p of degraded) {
    if ((Number(p.retries) || 0) < maxRetry) retry.push(p.shotIdx);
    else giveUp.push(p.shotIdx);
  }
  return { enabled, retry, giveUp, degradedRatio };
}
