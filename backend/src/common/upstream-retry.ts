// ============================================================================
// upstream-retry.ts —— 上游媒体接口的可重试状态码(单一来源)
// ----------------------------------------------------------------------------
// 为什么单独放:图像生成有两条调用路径(open-montage 的 key 池直连 与
// SkillDispatcher → agnes.provider),两边各写一份重试条件迟早不一致 ——
// 一条路径重试 504、另一条不重试,就会表现为"定妆能过、关键帧随机失败"。
//
// 实测依据(2026-08-29):
//   429 = Agnes 限流(每 key 每分钟 1 次创建)
//   503 = "text image queue is full, please retry later"
//   504 = Cloudflare 网关超时(图生图连发时出现)
// 三者都是**瞬时**故障,退避后重试有意义;4xx 其余是参数错误,重试只会白烧。
// ============================================================================

/** 图像生成可重试的上游 HTTP 状态码 */
export const RETRYABLE_IMAGE_STATUS = new Set<number>([429, 503, 504]);

/** 视频任务创建可重试的上游 HTTP 状态码(限流为主) */
export const RETRYABLE_VIDEO_CREATE_STATUS = new Set<number>([429, 503]);

// ---------------------------------------------------------------------------
// 2026-09-24:视频创建退避/错峰/自适应并发(纯函数,可单测)
// 实测根因:e2e 14 镜开局 12 路齐发撞上游全局队列(video_queue_full 503);
//   重试固定 65s 无抖动,12 路下一轮同秒再撞,11 号镜 4 次烧完出局。
//   429 是"每 key 每分钟 1 次"(per-key,已有串行窗口),503 是上游全局队列 ——
//   全局拥塞必须用"抖动 + 错峰 + 降并发"解,只靠 per-key 排队不够。
// ---------------------------------------------------------------------------

/** 退避指数上限:单次等待封顶 5 分钟(再久就是上游事故,等也白等) */
export const VIDEO_CREATE_BACKOFF_CAP_MS = 300_000;

/**
 * 创建重试退避:base × 2^(attempt-1),±20% 抖动。
 * 抖动是关键:固定 65s 会让 N 路并发在同一秒集体重试、同秒再撞;
 * 错开后上游队列有机会在间隙里消化。attempt 从 1 起,≤0 按 1 算。
 */
export function videoCreateBackoffMs(
  attempt: number, baseMs = 65_000, rand: () => number = Math.random,
): number {
  const a = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = Number.isFinite(Number(baseMs)) && Number(baseMs) > 0 ? Number(baseMs) : 65_000;
  const exp = Math.min(base * 2 ** (a - 1), VIDEO_CREATE_BACKOFF_CAP_MS);
  const r = Number.isFinite(Number(rand?.())) ? Number(rand()) : 0.5;
  return Math.round(exp * (0.8 + r * 0.4));
}

/**
 * 首发错峰:第 position 个启动的任务先等一小会儿再创建。
 * position×1.5s(12s 封顶)+0~3s 抖动 —— 14 镜开局不再同秒齐发,
 * 但也不把并行压成串行(上限 12s+3s 可忽略,相对单镜分钟级渲染)。
 */
export function videoCreateStaggerMs(position: number, rand: () => number = Math.random): number {
  const p = Math.max(0, Math.floor(Number(position) || 0));
  const r = Number.isFinite(Number(rand?.())) ? Number(rand()) : 0;
  return Math.min(p * 1500, 12_000) + Math.floor(r * 3000);
}

/** 创建结果滑动窗口(调用方维护最近 N 次:attempts 总数,e503 其中 503 数) */
export interface CreateOutcomeWindow {
  attempts: number;
  e503: number;
}

/**
 * 自适应并发:滑动窗口里 503 过半 → 对半砍(不低于 floor);
 * 连续健康(≥8 次零 503) → 每次 +1 缓慢回升(不超 ceiling)。
 * 样本 <4 不动作(刚开局的零星 503 别把并发直接打残)。
 * current 越界先 clamp,保证任何脏状态都收敛到 [floor, ceiling]。
 */
export function adaptI2vConcurrency(
  current: number, window: CreateOutcomeWindow | null | undefined,
  ceiling: number, floor = 2,
): number {
  const lo = Math.max(1, Math.floor(Number(floor) || 2));
  const hi = Math.max(lo, Math.floor(Number(ceiling) || lo));
  let c = Math.floor(Number(current) || lo);
  c = Math.max(lo, Math.min(hi, c));
  const total = Math.max(0, Math.floor(Number(window?.attempts) || 0));
  const e503 = Math.max(0, Math.floor(Number(window?.e503) || 0));
  if (total >= 4 && e503 / total >= 0.5) return Math.max(lo, Math.floor(c / 2));
  if (total >= 8 && e503 === 0) return Math.min(hi, c + 1);
  return c;
}

