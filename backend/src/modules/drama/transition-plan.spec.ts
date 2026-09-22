import { planCompose, xfadeOffsets } from './transition-plan';

/**
 * transition-plan 是合成路径上最容易算错的纯函数,而且它改的是**正在工作的**
 * 出片链路 —— 错了就是"整集没成片"或"成片没声音"。这里锁三件事:
 *   ① offset 数学(链式 xfade 的经典坑)
 *   ② 接缝被跳过时**不能丢镜头**(2026-09-22 修的真 bug)
 *   ③ 音轨必须真的进成片(用户反馈"视频没声音"的根因)
 */

const seg = (n: number) => Array.from({ length: n }, (_, i) => `seg_${i}.mp4`);

describe('xfadeOffsets 偏移数学', () => {
  it('三段等长 4s / 转场 0.5s → offset=[3.5, 7]', () => {
    // 验算:两个转场各重叠 0.5s → 总时长 12-1=11s,第三段从 11-4=7s 开始。
    // ⚠ 常见错法是 `acc - k*t`(得 6.5):会让每次转场多叠 0.5s,越往后偏得越多。
    const { offsets, transitions } = xfadeOffsets([4, 4, 4], 0.5);
    expect(offsets).toEqual([3.5, 7]);
    expect(transitions).toEqual([0, 1]);
  });

  it('时长不足转场时该接缝被跳过(不产生负 offset)', () => {
    // d[0]=0.3 < t=0.5 → 接缝 0 跳过;接缝 1 两边都够 → 保留
    const { offsets, transitions } = xfadeOffsets([0.3, 4, 4], 0.5);
    expect(transitions).toEqual([1]);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]).toBeGreaterThan(0);
  });

  it('单段无接缝', () => {
    expect(xfadeOffsets([4], 0.5)).toEqual({ offsets: [], transitions: [] });
  });
});

describe('planCompose 默认路径(转场关)', () => {
  it('enabled=false → 与历史行为逐字一致的 concat -c copy', () => {
    const p = planCompose({ segments: seg(3), durations: [3, 3, 3], out: 'o.mp4', listFile: 'l.txt' });
    expect(p.mode).toBe('concat-copy');
    expect(p.args).toEqual(['-y', '-f', 'concat', '-safe', '0', '-i', 'l.txt', '-c', 'copy', 'o.mp4']);
  });

  it('片段不足 2 段 → 走 concat', () => {
    const p = planCompose({ segments: seg(1), durations: [3], enabled: true, out: 'o.mp4' });
    expect(p.mode).toBe('concat-copy');
  });
});

describe('planCompose 接缝被跳过时不丢镜头(回归锁)', () => {
  // 旧实现按 offsets 下标取 seg:一旦有接缝被跳过,offsets.length < seamCount,
  // 循环提前结束 —— 后面的镜头**根本没进成片**。这是最严重的一类回归。
  it('首接缝太短被跳过 → 最后一段仍必须出现在滤镜图里', () => {
    const segs = seg(4); // seg_0..seg_3
    const p = planCompose({
      segments: segs,
      durations: [0.2, 4, 4, 4], // 接缝 0 太短(seg0=0.2 < 0.4)→ 跳过
      enabled: true,
      transitionSec: 0.4,
      out: 'o.mp4',
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    // 4 段 = 3 个接缝,每个接缝都要有一条链式语句
    expect(p.filterComplex.split(';').filter((s) => /xfade=|concat=n=2/.test(s))).toHaveLength(3);
    // 最后一段的输入必须被引用
    expect(p.filterComplex).toContain('[3:v]');
    // 输出标签存在
    expect(p.filterComplex).toContain('[vout]');
  });

  it('全部接缝都被跳过 → 退回 concat -c copy(不硬造负 offset)', () => {
    const p = planCompose({
      segments: seg(3), durations: [0.1, 0.1, 0.1], enabled: true, transitionSec: 0.4, out: 'o.mp4',
    });
    expect(p.mode).toBe('concat-copy');
  });
});

describe('planCompose 音轨(用户反馈"视频没声音"的根因)', () => {
  it('全部片段有音轨 → 滤镜图含音频链,args 映射 [aout] 并编 aac', () => {
    const p = planCompose({
      segments: seg(3),
      durations: [4, 4, 4],
      enabled: true,
      out: 'o.mp4',
      hasAudio: [true, true, true],
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.audioTracks).toBe(3);
    expect(p.silentPadded).toBe(0);
    // 每段的音频输入都被取用并统一格式
    expect(p.filterComplex).toContain('[0:a]');
    expect(p.filterComplex).toContain('[2:a]');
    expect(p.filterComplex).toContain('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    // 转场接缝 → acrossfade
    expect(p.filterComplex).toContain('acrossfade=');
    // args 真的把音频映射出去了(旧实现只 -map [vout])
    expect(p.args).toContain('[aout]');
    expect(p.args).toContain('aac');
  });

  it('每段音频都被截/补到与视频等长(全链定长的关键)', () => {
    const p = planCompose({
      segments: seg(3), durations: [4, 5.5, 6], enabled: true, out: 'o.mp4',
      hasAudio: [true, true, true],
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.filterComplex).toContain('[0:a]aresample=48000,');
    expect(p.filterComplex).toContain('atrim=0:4,apad=whole_dur=4');
    expect(p.filterComplex).toContain('atrim=0:5.5,apad=whole_dur=5.5');
    expect(p.filterComplex).toContain('atrim=0:6,apad=whole_dur=6');
  });

  // 回归锁:第一版用了「全局 apad + -shortest」,实测 ffmpeg 6.0 **永不结束**
  // (产物无 moov atom,文件一直长)。生产后果 = 第 7 步挂死 → 集永远 running
  // → 又攒僵尸槽位。所以这两样必须都不出现。
  it('绝不能出现无限长音源 / -shortest(会把 ffmpeg 挂到永不结束)', () => {
    const p = planCompose({
      segments: seg(3), durations: [4, 4, 4], enabled: true, out: 'o.mp4',
      hasAudio: [true, true, true],
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.args).not.toContain('-shortest');
    // 无参 apad(无限补静音)是挂死的根源;带 whole_dur 的才是定长的
    expect(p.filterComplex).not.toMatch(/apad(?![\w=])/);
    expect(p.filterComplex).not.toMatch(/,\s*apad\s*[;\[]/);
    // 每个 apad 都必须带 whole_dur
    for (const seg of p.filterComplex.split(';')) {
      if (seg.includes('apad')) expect(seg).toMatch(/apad=whole_dur=[\d.]+/);
    }
  });

  it('部分片段缺音轨 → 缺的补等长静音,成片仍有声', () => {
    const p = planCompose({
      segments: seg(3),
      durations: [4, 5, 6],
      enabled: true,
      out: 'o.mp4',
      hasAudio: [true, false, true],
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.audioTracks).toBe(2);
    expect(p.silentPadded).toBe(1);
    // 缺的那段用**它自己的实测时长**生成静音(不是随便给个常数)
    expect(p.filterComplex).toContain('aevalsrc=0:d=5:');
    // 缺音轨的片段绝不能去引 [1:a](不存在的流会让整集合成失败)
    expect(p.filterComplex).not.toContain('[1:a]');
    expect(p.args).toContain('[aout]');
  });

  it('全部片段无音轨 → 不加音频链(降级为无声,至少能出片)', () => {
    const p = planCompose({
      segments: seg(3), durations: [4, 4, 4], enabled: true, out: 'o.mp4',
      hasAudio: [false, false, false],
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.audioTracks).toBe(0);
    expect(p.args).not.toContain('[aout]');
    expect(p.filterComplex).not.toContain('acrossfade=');
  });

  it('未探测(hasAudio 未传)→ 行为与修复前一致,不加音频链', () => {
    const p = planCompose({ segments: seg(3), durations: [4, 4, 4], enabled: true, out: 'o.mp4' });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.audioTracks).toBe(0);
    expect(p.args).not.toContain('[aout]');
  });

  it('hasAudio 长度不足(探测残缺)→ 整体不加音频链,不冒险', () => {
    const p = planCompose({
      segments: seg(3), durations: [4, 4, 4], enabled: true, out: 'o.mp4',
      hasAudio: [true, true], // 少了 1 个
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    // 链没挂上时计数必须为 0 —— 否则日志会打"音轨 2/3"这种误导数字
    expect(p.audioTracks).toBe(0);
    expect(p.silentPadded).toBe(0);
    expect(p.args).not.toContain('[aout]');
  });
});

describe('planCompose 归一化(尺寸不一致)', () => {
  it('给 normalize 时每段插 scale+pad+setsar,输入标签改 n{i}', () => {
    const p = planCompose({
      segments: seg(2), durations: [4, 4], enabled: true, out: 'o.mp4',
      normalize: { w: 704, h: 1280, fps: 30 },
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.filterComplex).toContain('scale=704:1280:force_original_aspect_ratio=decrease');
    expect(p.filterComplex).toContain('pad=704:1280:(ow-iw)/2:(oh-ih)/2');
    expect(p.filterComplex).toContain('setsar=1');
    expect(p.filterComplex).toContain('[0:v]');
    expect(p.filterComplex).toContain('[n0]');
    expect(p.filterComplex).toContain('[n1]');
  });

  it('归一化 + 音轨同时生效时两条链互不干扰', () => {
    const p = planCompose({
      segments: seg(2), durations: [4, 4], enabled: true, out: 'o.mp4',
      normalize: { w: 704, h: 1280, fps: 30 },
      hasAudio: [true, true],
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    // 视频走归一化后的标签,音频仍取原始 [i:a]
    expect(p.filterComplex).toContain('[n0][n1]xfade=');
    expect(p.filterComplex).toContain('[0:a]');
    expect(p.args).toContain('[aout]');
  });
});

describe('planCompose 时长收缩', () => {
  it('totalSec 扣掉每个转场重叠的 t 秒', () => {
    const p = planCompose({
      segments: seg(3), durations: [4, 4, 4], enabled: true, transitionSec: 0.5, out: 'o.mp4',
    });
    expect(p.mode).toBe('xfade');
    if (p.mode !== 'xfade') return;
    expect(p.totalSec).toBe(11); // 12 - 2×0.5
  });
});
