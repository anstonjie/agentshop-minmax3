// ============================================================================
// 连集编排器的判定函数单测
// ----------------------------------------------------------------------------
// 这里三个判定都属于**静默失效型**:判错了不会抛异常,只会表现为
//   ① 失败镜头永远不被补做 → 成片缺镜而用户毫无感知
//   ② 关键帧全在换脸还继续烧视频配额 → 一集 12 镜 × 40 分 = 480 分换一部废片
//   ③ 墙钟预估差一个数量级 → 用户被 10 小时的批次套住才发现
// 所以边界值必须钉死在测试里,不能靠"看起来对"。
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import {
  hasFailedShots, shouldBlockOnDegraded, degradedReason, DEGRADED_RATIO_BLOCK,
} from './drama-orchestrator.service';
import {
  shotsPerEpisodeFor, estimateWallMinutes, VIDEO_CREATE_INTERVAL_MS,
} from './drama-pricing';

describe('hasFailedShots —— 决定 step4 是否要重进一次', () => {
  it('全部拿到视频 → 不需要重进(避免白等一轮限流窗口)', () => {
    expect(hasFailedShots({
      shots: [{ status: 'completed', video_url: 'a' }, { status: 'completed', video_url: 'b' }],
    })).toBe(false);
  });

  it('有 failed 镜头 → 必须重进,否则那几镜是永久死账', () => {
    expect(hasFailedShots({
      shots: [{ status: 'completed', video_url: 'a' }, { status: 'failed', error: '429' }],
    })).toBe(true);
  });

  it('pending 也算没拿到(上一轮被中断时留下的状态)', () => {
    expect(hasFailedShots({ shots: [{ status: 'pending' }] })).toBe(true);
  });

  it('只有 skipped 不算 —— 没有关键帧可作首帧,重跑还是 skipped', () => {
    expect(hasFailedShots({
      shots: [{ status: 'skipped' }, { status: 'completed', video_url: 'a' }],
    })).toBe(false);
  });

  it('产出缺失/空数组一律 false,不误触发重跑', () => {
    expect(hasFailedShots(null)).toBe(false);
    expect(hasFailedShots({})).toBe(false);
    expect(hasFailedShots({ shots: [] })).toBe(false);
    expect(hasFailedShots({ shots: 'oops' })).toBe(false);
    expect(hasFailedShots({ shots: [null, undefined] })).toBe(false);
  });
});

describe('shouldBlockOnDegraded —— 退化到什么程度才拦下本集', () => {
  const kf = (n: number, degraded: number) => ({
    keyframes: [
      ...Array.from({ length: n - degraded }, () => ({ url: 'u', degraded: false })),
      ...Array.from({ length: degraded }, () => ({ url: 'u', degraded: true })),
    ],
  });

  it('阈值就是 0.5(与 DEGRADED_RATIO_BLOCK 同源)', () => {
    expect(DEGRADED_RATIO_BLOCK).toBe(0.5);
  });

  it('恰好一半退化 → 拦(比例判断用 >=,不是 >)', () => {
    expect(shouldBlockOnDegraded(kf(10, 5))).toBe(true);
  });

  it('4/10 退化 → 放行(少数镜头退化是正常的:新角色首次出场、空镜)', () => {
    expect(shouldBlockOnDegraded(kf(10, 4))).toBe(false);
  });

  it('全部有参考图 → 放行', () => {
    expect(shouldBlockOnDegraded(kf(10, 0))).toBe(false);
  });

  it('一张图都没出 → 不拦(那是"生成失败",不是"退化",走失败重试路径)', () => {
    expect(shouldBlockOnDegraded({ keyframes: [] })).toBe(false);
    expect(shouldBlockOnDegraded({ keyframes: [{ url: null, error: '503' }] })).toBe(false);
    expect(shouldBlockOnDegraded(null)).toBe(false);
  });

  it('分母只算真的出图了的镜头 —— 失败镜头不该把比例算歪', () => {
    // 6 张出图里 3 张退化 = 0.5 → 拦;若把 4 张失败也算进分母就是 3/10 → 漏放
    const out = {
      keyframes: [
        { url: 'a', degraded: true }, { url: 'b', degraded: true }, { url: 'c', degraded: true },
        { url: 'd', degraded: false }, { url: 'e', degraded: false }, { url: 'f', degraded: false },
        { url: null, degraded: true }, { url: null, degraded: true },
        { url: null, degraded: true }, { url: null, degraded: true },
      ],
    };
    expect(shouldBlockOnDegraded(out)).toBe(true);
  });

  it('degraded 字段缺失按"没退化"算,不误拦', () => {
    expect(shouldBlockOnDegraded({ keyframes: [{ url: 'a' }, { url: 'b' }] })).toBe(false);
  });
});

describe('degradedReason —— 给用户的说明必须能指导下一步', () => {
  it('说清比例、后果、以及下一步该做什么', () => {
    const msg = degradedReason({
      keyframes: [
        { url: 'a', degraded: true }, { url: 'b', degraded: true },
        { url: 'c', degraded: false }, { url: 'd', degraded: false },
      ],
    });
    expect(msg).toContain('2/4');
    expect(msg).toContain('定妆');   // 下一步动作
    expect(msg).toContain('配额');   // 为什么不继续
  });
});

describe('shotsPerEpisodeFor —— 镜数由目标时长反推', () => {
  it('按每镜 10 秒折算(8-12 秒策略的中值)', () => {
    expect(shotsPerEpisodeFor(120)).toBe(12);
    expect(shotsPerEpisodeFor(60)).toBe(6);
    expect(shotsPerEpisodeFor(180)).toBe(18);
  });

  it('向上取整,保证内容量不低于目标', () => {
    expect(shotsPerEpisodeFor(90)).toBe(9);
    expect(shotsPerEpisodeFor(95)).toBe(10);
  });

  it('缺省/非法值回落 120 秒,不返回 0 镜', () => {
    expect(shotsPerEpisodeFor(0)).toBe(12);
    expect(shotsPerEpisodeFor(NaN)).toBe(12);
    expect(shotsPerEpisodeFor(-30)).toBe(12);
  });
});

describe('estimateWallMinutes —— 视频通道是全链路瓶颈', () => {
  it('镜数决定排队轮数,key 数决定每轮多快:10 集 12 镜 6 路 key ≈ 71 分钟', () => {
    // rounds = ceil(12/6) = 2 → 每集 2×63s + 150s 渲染 + 150s 其他 = 426s
    expect(estimateWallMinutes(10, 12, 6)).toBe(71);
  });

  it('只有 1 路 key 时慢一倍以上 —— 扩 key 是最直接的提速手段', () => {
    const many = estimateWallMinutes(10, 12, 6);
    const one = estimateWallMinutes(10, 12, 1);
    expect(one).toBeGreaterThan(many * 2);
  });

  it('对集数与镜数单调不减', () => {
    const base = estimateWallMinutes(5, 12, 6);
    expect(estimateWallMinutes(10, 12, 6)).toBeGreaterThan(base);
    expect(estimateWallMinutes(5, 24, 6)).toBeGreaterThan(base);
  });

  it('key 数缺失时按 1 路保守估,不返回 0 分钟骗人', () => {
    expect(estimateWallMinutes(3, 10, 0)).toBeGreaterThan(0);
    expect(estimateWallMinutes(3, 10, -2)).toBe(estimateWallMinutes(3, 10, 1));
  });

  it('非法集数至少按 1 集算', () => {
    expect(estimateWallMinutes(0, 12, 6)).toBe(estimateWallMinutes(1, 12, 6));
    expect(estimateWallMinutes(NaN, 12, 6)).toBeGreaterThan(0);
  });
});

describe('限流常量与 open-montage 必须一致', () => {
  it('drama-pricing 的 63 秒 == open-montage 里那个私有常量', () => {
    // 两处不能互相 import(open-montage 被 drama 依赖,反向引用会成环),
    // 所以只能靠这个测试兜住"改了一边忘了另一边" —— 一旦不一致,
    // 开跑前的墙钟预估会系统性偏乐观或偏悲观。
    const src = fs.readFileSync(
      path.join(__dirname, '../open-montage/open-montage.service.ts'), 'utf8',
    );
    const m = src.match(/VIDEO_CREATE_INTERVAL_MS\s*=\s*([\d_]+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ''))).toBe(VIDEO_CREATE_INTERVAL_MS);
  });
});
