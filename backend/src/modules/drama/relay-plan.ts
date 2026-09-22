// ============================================================================
// relay-plan.ts —— P1-a 尾帧接力规划(修根因 B:镜头间无画面承接)
// ----------------------------------------------------------------------------
// 诊断:genStep6ShotVideos 每镜从**各自独立生成的首帧静止图** i2v,彼此孤立;
// genStep7Compose 裸拼 → 破碎。reelbench 用"首尾双关键帧 + a/b 对照"看运镜,
// 咱们反过来用:把第 N 镜的**真实尾帧**当第 N+1 镜的首帧参考,形成画面接力链。
//
// ⚠️ 这会改动正在工作的并行生成路径(需改成链式/顺序),故 flag 默认关:
//   DRAMA_SHOT_RELAY=1 才启用。启用后务必先跑一集真实验证(需视频生成额度 + 分钟级)。
// 本模块只做**纯决策**:哪些接缝该接力、生成顺序如何。真正的尾帧抽取/i2v 重排在
// genStep6 里按本 plan 执行。
// ============================================================================

export interface RelayShotLike {
  idx: number;
  /** 场景 id;同场景相邻镜更该接力(硬跳切才自然) */
  location_id?: string | null;
  /** 出场角色 slug */
  characters?: string[];
  /** step4 LLM 写的交接提示(有内容说明本就想承接) */
  handoff?: string;
}

export interface RelayPair {
  /** 前一镜 idx(提供尾帧) */
  from: number;
  /** 后一镜 idx(用尾帧当首帧参考) */
  to: number;
  /** 接力强度理由 */
  why: 'same-location' | 'handoff' | 'shared-cast' | 'sequential';
}

export interface RelayPlan {
  enabled: boolean;
  /** 启用时必须顺序生成(不能并行),因为 N+1 依赖 N 的尾帧 */
  sequential: boolean;
  pairs: RelayPair[];
  /** 不接力的接缝(场景切换 → 硬切本就自然,强行接力反而糊) */
  hardCuts: Array<{ from: number; to: number }>;
}

function sameSet(a?: string[], b?: string[]): boolean {
  const sa = new Set((a || []).map(String));
  const sb = new Set((b || []).map(String));
  if (!sa.size || !sb.size) return false;
  for (const x of sa) if (sb.has(x)) return true; // 有交集即算共享角色
  return false;
}

/**
 * 规划尾帧接力。enabled=false(默认)→ 空计划,genStep6 保持现状(并行、各自首帧)。
 * enabled=true → 顺序生成 + 逐接缝判定接力/硬切:
 *   同场景 或 有 handoff 或 共享角色 → 接力(尾帧当下一镜首帧参考);
 *   场景切换且无交接 → 硬切(不接力,避免把两个不同空间糊在一起)。
 */
export function planShotRelay(shots: RelayShotLike[], opts?: { enabled?: boolean }): RelayPlan {
  const enabled = !!opts?.enabled;
  const ordered = [...(shots || [])].sort((a, b) => Number(a.idx) - Number(b.idx));
  if (!enabled || ordered.length < 2) {
    return { enabled, sequential: false, pairs: [], hardCuts: [] };
  }
  const pairs: RelayPair[] = [];
  const hardCuts: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], cur = ordered[i];
    const sameLoc = prev.location_id && cur.location_id && prev.location_id === cur.location_id;
    const hasHandoff = !!String(cur.handoff || prev.handoff || '').trim();
    const sharedCast = sameSet(prev.characters, cur.characters);
    if (sameLoc) pairs.push({ from: prev.idx, to: cur.idx, why: 'same-location' });
    else if (hasHandoff) pairs.push({ from: prev.idx, to: cur.idx, why: 'handoff' });
    else if (sharedCast) pairs.push({ from: prev.idx, to: cur.idx, why: 'shared-cast' });
    else hardCuts.push({ from: prev.idx, to: cur.idx });
  }
  return { enabled, sequential: true, pairs, hardCuts };
}

/**
 * 把有序镜头按接力对分组成"链":被 relay pair(from→to)相连的相邻镜头进同一条链,
 * 断开处(硬切)另起一链。**链间并行、链内顺序** —— 这样只有同场景的镜头受 63s/key
 * 限速串行,不同场景链仍跨 key 并行,把顺序化的代价压到"最长链长×63s"而非"全片×63s"。
 * 纯函数,单测覆盖。
 *
 * 2026-09-21: 支持 maxChainLength(默认 3, 读 DRAMA_SHOT_RELAY_MAX_CHAIN)。
 * 避免整集由于共享主角被串成 12 镜单链导致完全单线程排队。切短链后多链跨 key 并行。
 */
export function groupIntoChains(
  shotIdxs: number[],
  pairs: RelayPair[],
  opts?: { maxChainLength?: number },
): number[][] {
  const ordered = [...(shotIdxs || [])].map(Number).sort((a, b) => a - b);
  const linked = new Set((pairs || []).map((p) => `${p.from}->${p.to}`));

  let maxLen = 3;
  if (opts?.maxChainLength != null) {
    maxLen = opts.maxChainLength > 0 ? Math.floor(opts.maxChainLength) : Infinity;
  } else {
    const envMax = Number(process.env.DRAMA_SHOT_RELAY_MAX_CHAIN);
    if (Number.isFinite(envMax)) {
      maxLen = envMax > 0 ? Math.floor(envMax) : Infinity;
    }
  }

  const chains: number[][] = [];
  let cur: number[] = [];
  for (const id of ordered) {
    if (cur.length === 0) {
      cur = [id];
      continue;
    }
    const prev = cur[cur.length - 1];
    if (linked.has(`${prev}->${id}`) && cur.length < maxLen) {
      cur.push(id);
    } else {
      chains.push(cur);
      cur = [id];
    }
  }
  if (cur.length) chains.push(cur);
  return chains;
}
