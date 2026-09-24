// ============================================================================
// upstream-retry.spec —— 视频创建退避/错峰/自适应并发(纯函数)
// ----------------------------------------------------------------------------
// 实测根因(2026-09-24 e2e):14 镜开局 12 路齐发撞上游全局队列 → 503;
//   重试固定 65s 无抖动,12 路下一轮同秒再撞,11 号镜 4 次烧完出局。
// 锁:指数退避+抖动 / 首发错峰 / 503 高压降并发。
// ============================================================================
import {
  RETRYABLE_IMAGE_STATUS,
  RETRYABLE_VIDEO_CREATE_STATUS,
  videoCreateBackoffMs,
  videoCreateStaggerMs,
  adaptI2vConcurrency,
} from './upstream-retry';

describe('重试状态码表不回归', () => {
  it('图像 429/503/504 可重试;视频创建 429/503 可重试', () => {
    expect(RETRYABLE_IMAGE_STATUS.has(429)).toBe(true);
    expect(RETRYABLE_IMAGE_STATUS.has(503)).toBe(true);
    expect(RETRYABLE_IMAGE_STATUS.has(504)).toBe(true);
    expect(RETRYABLE_IMAGE_STATUS.has(400)).toBe(false);
    expect(RETRYABLE_VIDEO_CREATE_STATUS.has(429)).toBe(true);
    expect(RETRYABLE_VIDEO_CREATE_STATUS.has(503)).toBe(true);
    expect(RETRYABLE_VIDEO_CREATE_STATUS.has(400)).toBe(false);
  });
});

describe('videoCreateBackoffMs 指数退避 + 抖动', () => {
  const noJitter = () => 0.5; // 0.8+0.5*0.4 = 1.0 → 无抖动精确值
  it('首轮 ≈65s,逐轮翻倍,5min 封顶', () => {
    expect(videoCreateBackoffMs(1, 65_000, noJitter)).toBe(65_000);
    expect(videoCreateBackoffMs(2, 65_000, noJitter)).toBe(130_000);
    expect(videoCreateBackoffMs(3, 65_000, noJitter)).toBe(260_000);
    expect(videoCreateBackoffMs(9, 65_000, noJitter)).toBe(300_000);
  });
  it('抖动 ±20%:rand=0 → 0.8x;rand=1 → 1.2x', () => {
    expect(videoCreateBackoffMs(1, 65_000, () => 0)).toBe(52_000);
    expect(videoCreateBackoffMs(1, 65_000, () => 1)).toBe(78_000);
  });
  it('脏输入不炸:attempt≤0 按 1 算;NaN base 回落默认', () => {
    expect(videoCreateBackoffMs(0, 65_000, noJitter)).toBe(65_000);
    expect(videoCreateBackoffMs(-3, 65_000, noJitter)).toBe(65_000);
    expect(videoCreateBackoffMs(1, NaN as any, noJitter)).toBe(65_000);
  });
});

describe('videoCreateStaggerMs 首发错峰', () => {
  it('位置 0 几乎不等,往后每镜 +1.5s,12s 封顶(+0~3s 抖动)', () => {
    expect(videoCreateStaggerMs(0, () => 0)).toBe(0);
    expect(videoCreateStaggerMs(1, () => 0)).toBe(1500);
    expect(videoCreateStaggerMs(8, () => 0)).toBe(12000);
    expect(videoCreateStaggerMs(20, () => 0)).toBe(12000);
    expect(videoCreateStaggerMs(0, () => 1)).toBe(3000);
  });
  it('脏输入不炸', () => {
    expect(videoCreateStaggerMs(-1, () => 0)).toBe(0);
    expect(videoCreateStaggerMs(NaN as any, () => 0)).toBe(0);
  });
});

describe('adaptI2vConcurrency 503 高压降并发', () => {
  it('503 过半 → 对半砍(不低于 floor)', () => {
    expect(adaptI2vConcurrency(12, { attempts: 6, e503: 4 }, 12)).toBe(6);
    expect(adaptI2vConcurrency(6, { attempts: 4, e503: 4 }, 12)).toBe(3);
    expect(adaptI2vConcurrency(3, { attempts: 4, e503: 3 }, 12)).toBe(2);
    expect(adaptI2vConcurrency(2, { attempts: 4, e503: 4 }, 12)).toBe(2); // floor 守住
  });
  it('样本不足(<4)不动作;503 未过半不动作', () => {
    expect(adaptI2vConcurrency(12, { attempts: 3, e503: 3 }, 12)).toBe(12);
    expect(adaptI2vConcurrency(12, { attempts: 8, e503: 2 }, 12)).toBe(12);
  });
  it('连续健康(≥8 次零 503)→ 缓慢回升,不超 ceiling', () => {
    expect(adaptI2vConcurrency(6, { attempts: 8, e503: 0 }, 12)).toBe(7);
    expect(adaptI2vConcurrency(12, { attempts: 8, e503: 0 }, 12)).toBe(12);
  });
  it('脏输入不炸:current 越界先 clamp 到 [floor, ceiling]', () => {
    expect(adaptI2vConcurrency(99, { attempts: 0, e503: 0 }, 12)).toBe(12);
    expect(adaptI2vConcurrency(0, { attempts: 0, e503: 0 }, 12)).toBe(2);
    expect(adaptI2vConcurrency(6, null as any, 12)).toBe(6);
  });
});
