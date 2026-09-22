// ============================================================================
// drama-pricing.ts —— 连集预算的单位成本(纯函数,可单测)
// ----------------------------------------------------------------------------
// ⚠ 这不是计费系统,是**失控保护用的记账口径**。
//   现状:剧集生成走 callImage / callImageWithKey,不经 AgentUsageTask,
//   所以平台的 creditsPerUse × mode 倍率那条链路**根本不会触发扣费**
//   (SkillDispatcher 只路由不结算)。连集一旦自动化,真正的风险是
//   "无人值守地把上游配额和积分烧穿",这个模块的职责是让预算闸有牙齿。
//
//   单价默认值取自设计评审时给用户的预估(1 张定妆图 ≈ 8 积分),
//   上线前应由平台方按 Agnes 实际报价核对;核对前请勿把它当账单。
// ============================================================================

export interface UnitPrices {
  /** 一次图像生成(定妆 1 视图 / 关键帧 1 张) */
  image: number;
  /** 一次视频创建(单镜 i2v) */
  video: number;
  /** 一次 LLM 调用(大纲 / 分镜 / 预检文本步) */
  llm: number;
}

/** 默认单价(积分 / 单元)。video 按 image 的 5 倍估,待平台方核对。 */
export const DEFAULT_UNIT_PRICES: UnitPrices = { image: 8, video: 40, llm: 2 };

/** 从 batch.policy 里取单价,缺项回落默认 */
export function resolvePrices(policy: any): UnitPrices {
  const p = policy?.unitPrices || {};
  const num = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    image: num(p.image, DEFAULT_UNIT_PRICES.image),
    video: num(p.video, DEFAULT_UNIT_PRICES.video),
    llm: num(p.llm, DEFAULT_UNIT_PRICES.llm),
  };
}

/** 某一步实际消耗了多少生成单元 */
export interface StepUnits { images: number; videos: number; llms: number }

export const ZERO_UNITS: StepUnits = { images: 0, videos: 0, llms: 0 };

/**
 * 从步骤产出里数真实消耗。
 * 只数"确实产出成功"的单元:失败的图不该计入预算,否则重试几次就把预算
 * 吃光而手里一个产物都没有。
 */
export function unitsFromStepOutput(step: number, output: any): StepUnits {
  if (!output || typeof output !== 'object') return { ...ZERO_UNITS, llms: 1 };
  switch (step) {
    case 0: // 承接大纲(LLM)
      return { ...ZERO_UNITS, llms: 1 };
    case 1: // 预检(纯匹配,无外部调用)
      return { ...ZERO_UNITS };
    case 2: // 分镜(LLM)
      return { ...ZERO_UNITS, llms: 1 };
    case 3: { // 关键帧:只数成功出图的
      const arr = Array.isArray(output.keyframes) ? output.keyframes : [];
      const ok = arr.filter((k: any) => k?.url).length;
      return { images: ok, videos: 0, llms: 0 };
    }
    case 4: { // 分镜视频:沿用上轮的不重复计
      const arr = Array.isArray(output.shots) ? output.shots : [];
      const done = arr.filter((s: any) => s?.video_url && s?.reused !== true);
      return { images: 0, videos: done.length, llms: 0 };
    }
    case 5: // 合成(本地 ffmpeg,无上游配额)
      return { ...ZERO_UNITS };
    default:
      return { ...ZERO_UNITS };
  }
}

export function addUnits(a: StepUnits, b: StepUnits): StepUnits {
  return { images: a.images + b.images, videos: a.videos + b.videos, llms: a.llms + b.llms };
}

export function unitsToCredits(u: StepUnits, prices: UnitPrices): number {
  return u.images * prices.image + u.videos * prices.video + u.llms * prices.llm;
}

/** 预算档位:ok 继续 / warn 提示 / block 自动暂停 */
export type BudgetLevel = 'ok' | 'warn' | 'block';

export interface BudgetVerdict {
  level: BudgetLevel;
  used: number;
  budget: number;
  ratio: number;
  /** 80% 预警线 */
  warnAt: number;
}

/**
 * 预算闸:到 100% 自动暂停(不是报错),到 80% 给预警。
 * budget <= 0 视为"未设预算"→ 永远 ok,由调用方决定是否要强制填。
 */
export function checkBudget(usedCredits: number, budgetCredits: number, warnAt = 0.8): BudgetVerdict {
  if (!Number.isFinite(budgetCredits) || budgetCredits <= 0) {
    return { level: 'ok', used: usedCredits, budget: 0, ratio: 0, warnAt };
  }
  const ratio = usedCredits / budgetCredits;
  const level: BudgetLevel = ratio >= 1 ? 'block' : (ratio >= warnAt ? 'warn' : 'ok');
  return { level, used: usedCredits, budget: budgetCredits, ratio, warnAt };
}

/**
 * 开跑前的预估:给用户一个"这批大概要多少"的数字。
 * 每集镜数未知时用默认 15 镜 + 每镜 1 关键帧 + 1 视频 + 2 次 LLM。
 */
export function estimateBatchCredits(
  episodeCount: number,
  prices: UnitPrices,
  opts: { shotsPerEpisode?: number; newAssets?: number } = {},
): { credits: number; shots: number; images: number; videos: number; llms: number } {
  const shotsPerEpisode = opts.shotsPerEpisode ?? 15;
  const shots = episodeCount * shotsPerEpisode;
  const newAssetViews = (opts.newAssets ?? 0) * 4; // 角色四视图,场景道具按 1 张估
  const images = shots + newAssetViews;
  const videos = shots;
  const llms = episodeCount * 2;
  const units: StepUnits = { images, videos, llms };
  return {
    credits: unitsToCredits(units, prices),
    shots, images, videos, llms,
  };
}

// ── 墙钟(要等多久)预估 ─────────────────────────────────────────────────
// 与"要花多少"同等重要,但性质不同:积分是钱,分钟数是耐心。用户点下
// "一键生成"之后唯一的预期管理就是那个进度条 —— 缺了预估,10 集的剧跑到
// 第 3 小时他才知道自己被套住了。

/**
 * 单集镜头数的经验值:目标时长 ÷ 单镜平均时长(取 10 秒)。
 *
 * 2026-09-15 单镜策略从 3-4 秒改为 8-12 秒后,120 秒一集约 10-12 镜(旧策略 14-18 镜)。
 * 这个数字同时决定"要花多少"(每个镜头一份关键帧 + 一次视频创建)和
 * "要等多久"(视频通道每 key 每分钟只准建 1 个任务,镜数直接决定排队轮数)。
 */
export function shotsPerEpisodeFor(epTargetSec: number): number {
  const t = Number(epTargetSec) > 0 ? Number(epTargetSec) : 120;
  return Math.max(2, Math.ceil(t / 10));
}

/**
 * 视频通道的硬限流窗口:同一把 key 每 63 秒只准创建 1 个视频任务。
 * ⚠ 与 `open-montage.service.ts` 的 `VIDEO_CREATE_INTERVAL_MS` 必须保持一致
 * (两处不能互相 import:open-montage 被 drama 依赖,反向引用会成环)。
 */
export const VIDEO_CREATE_INTERVAL_MS = 63_000;

/** 单镜从创建到出片的中位额外等待(轮询间隔 5s + 上游渲染),实测约 2-3 分钟 */
const VIDEO_RENDER_OVERHEAD_MS = 150_000;
/** 非视频步骤(大纲/预检/分镜/关键帧/合成)合计的单集耗时,实测约 2.5 分钟 */
const NON_VIDEO_PER_EP_MS = 150_000;

/**
 * 开跑前的墙钟预估(分钟)。
 *
 * 模型:瓶颈是视频通道 —— 每集要排 `ceil(镜数 / key数)` 轮,每轮 63 秒;
 * 其余步骤与视频**串行**发生(连集流水线当前是集内 6 步串行)。
 * 这是量级估计,不是承诺:上游队列满(503 video_queue_full)时会明显更长。
 */
export function estimateWallMinutes(
  episodeCount: number, shotsPerEpisode: number, keyCount: number,
): number {
  const eps = Math.max(1, Math.floor(Number(episodeCount)) || 1);
  const shots = Math.max(1, Math.floor(Number(shotsPerEpisode)) || 1);
  const keys = Math.max(1, Math.floor(Number(keyCount)) || 1);
  const rounds = Math.ceil(shots / keys);
  const perEpMs = rounds * VIDEO_CREATE_INTERVAL_MS + VIDEO_RENDER_OVERHEAD_MS + NON_VIDEO_PER_EP_MS;
  return Math.max(1, Math.round((eps * perEpMs) / 60_000));
}
