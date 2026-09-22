// ============================================================================
// transition-plan.ts —— P1-b 转场规划(借 reelbench 转场枚举:cut/dissolve/fade…)
// ----------------------------------------------------------------------------
// 诊断根因 B:genStep7Compose 是 `concat -c copy` 裸硬拼,镜头间零过渡 = 破碎感来源。
// 本模块把"用裸拼还是叠化"做成纯函数决策,由 flag 门控(默认关 = 完全保持现状)。
//
// ⚠️ 改的是正在工作的合成路径,故默认关:DRAMA_COMPOSE_TRANSITIONS=1 才启用 xfade。
//   xfade 需要重编码 + 各片段同分辨率/帧率/像素格式(咱们的 i2v 片段满足),
//   启用后务必先跑一集真实验证再放量。
// ============================================================================

export type TransitionKind = 'cut' | 'fade' | 'dissolve' | 'wipe';

export interface TransitionPlanInput {
  /** 进入成片的片段路径(有序) */
  segments: string[];
  /** 每片段实测时长(秒),与 segments 同序;compose 已量好 */
  durations: Array<number | null>;
  /** flag:是否启用转场(默认 false = 裸 concat -c copy,零行为变化) */
  enabled?: boolean;
  /** 每个转场的时长(秒),默认 0.4 */
  transitionSec?: number;
  /** 转场类型,默认 fade(xfade 的 fade 最通用) */
  kind?: TransitionKind;
  /** concat demuxer 列表文件路径(enabled=false 时用) */
  listFile?: string;
  /** 输出路径 */
  out: string;
  /**
   * 2026-09-22:归一化目标(宽/高/帧率)。
   * xfade 要求各输入分辨率、帧率、像素格式完全一致 —— 上游偶发返回降档尺寸
   * (实测一集里 704x1280 与 704x960 混着),链式 xfade 直接报
   * "input link main parameters do not match",整集合成失败(concat.mp4 0 字节)。
   * 给了这个值就在每个输入前插 scale+pad+setsar(+fps),把尺寸补边对齐(不裁内容)。
   */
  normalize?: { w: number; h: number; fps?: number };
  /**
   * 2026-09-22:每个片段是否**真的有音轨**(由调用方 ffprobe 探测后传入)。
   *
   * Agnes 的 i2v 片段实测带 AAC 立体声(台词音轨就在里面),但 xfade 分支原本只
   * `-map [vout]` —— 视频滤镜图里根本没有音频,输出成片**零音轨**。
   * 用户反馈"生成的视频没有声音"的根因就是这个(4 集成品 probe 只有 h264 一路)。
   *
   * 为什么必须由调用方探测而不是这里假定有:acrossfade/concat 的输入流必须齐全,
   * 片段没音轨时要改用等长静音补位(见下方音频链),不能盲目引 `[i:a]`。
   * 未传、或长度不足、或**一个都没有** → 退化为不加音频链(与修复前行为一致)。
   */
  hasAudio?: Array<boolean>;
}

export type TransitionPlan =
  | { mode: 'concat-copy'; args: string[] }
  | {
    mode: 'xfade'; args: string[]; filterComplex: string; totalSec: number;
    /** 真的带音轨的片段数(音频链没挂上时为 0 —— 用于日志核对"有没有把声音带上") */
    audioTracks: number;
    /** 因缺音轨被补静音的片段数(音频链没挂上时为 0) */
    silentPadded: number;
  };

/**
 * 计算链式 xfade 的 offset 序列(纯函数,最易算错的部分,单测重点)。
 * N 段有 N-1 个转场;第 k 个转场(0基,合并 seg k 与 k+1)的 offset:
 *   offset_k = sum(d[0..k]) - (k+1)*t
 * 例:d=[4,4,4], t=0.5 → offset=[3.5, 7]。
 *   验算:两个转场各重叠 0.5s → 总时长 12-1=11s,第三段从 11-4=7s 开始。
 * ⚠ 这里容易写成 `acc - k*t`(得 6.5),那会让**每次转场多叠 0.5s**、
 *   第三段提前 0.5s 进场,越往后偏得越多(第 N 段累计偏 (N-1)*t/2)。
 *   2026-09-22 核对:实现正确,原文档例子写错(6.5),已改。
 * 时长不足(某段 < t)时该转场跳过(退化为 cut),避免 xfade 负 offset 报错。
 */
export function xfadeOffsets(durations: number[], transitionSec: number): {
  offsets: number[]; transitions: number[];
} {
  const offsets: number[] = [];
  const transitions: number[] = []; // 记录哪些接缝真的用了转场(索引 k = seg k↔k+1)
  let acc = 0;
  for (let k = 0; k < durations.length - 1; k++) {
    acc += durations[k];
    const bothLongEnough = durations[k] > transitionSec && durations[k + 1] > transitionSec;
    if (bothLongEnough) {
      const offset = acc - (transitions.length + 1) * transitionSec;
      if (offset > 0) {
        offsets.push(Number(offset.toFixed(3)));
        transitions.push(k);
      }
    }
  }
  return { offsets, transitions };
}

/**
 * 生成合成方案。enabled=false(默认)→ 与现状逐字一致的 concat -c copy;
 * enabled=true → xfade 重编码方案(filter_complex 链式叠化)。
 */
export function planCompose(input: TransitionPlanInput): TransitionPlan {
  const segs = input.segments || [];
  const out = input.out;
  if (!input.enabled || segs.length < 2) {
    // 默认路径:与 genStep7Compose 现状完全一致(concat demuxer + -c copy)
    const listFile = input.listFile || 'concat_list.txt';
    return { mode: 'concat-copy', args: ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out] };
  }
  const t = Number(input.transitionSec) > 0 ? Number(input.transitionSec) : 0.4;
  const kind = input.kind || 'fade';
  const durs = segs.map((_, i) => {
    const d = Number(input.durations?.[i]);
    return Number.isFinite(d) && d > 0 ? d : 3;
  });
  const { offsets, transitions } = xfadeOffsets(durs, t);
  if (!offsets.length) {
    // 所有接缝都太短放不下转场 → 退回裸拼,别硬造负 offset
    const listFile = input.listFile || 'concat_list.txt';
    return { mode: 'concat-copy', args: ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out] };
  }
  // 接缝索引 → 该接缝的 xfade offset。不在表里的接缝 = 太短,退化为硬接(不缩短时长)。
  const offsetByK = new Map<number, number>();
  transitions.forEach((k, i) => offsetByK.set(k, offsets[i]));

  // 2026-09-22:尺寸/帧率归一化前缀。scale 用 decrease 保证不裁画面,
  //   pad 居中补边(黑边),setsar=1 统一像素比例,fps 统一帧率。
  const norm = input.normalize;
  const pre: string[] = [];
  const inLabel = (i: number) => (norm ? `n${i}` : `${i}:v`);
  if (norm && norm.w > 0 && norm.h > 0) {
    for (let i = 0; i < segs.length; i++) {
      const chain = [
        `scale=${norm.w}:${norm.h}:force_original_aspect_ratio=decrease`,
        `pad=${norm.w}:${norm.h}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1',
        ...(norm.fps && norm.fps > 0 ? [`fps=${norm.fps}`] : []),
      ].join(',');
      pre.push(`[${i}:v]${chain}[n${i}]`);
    }
  }

  const seamCount = segs.length - 1;
  const parts: string[] = [];

  // ── 视频链:逐接缝推进 ────────────────────────────────────────────────
  // ⚠ 原实现按 `offsets` 的下标取 seg(`inLabel(k+1)`),一旦某个接缝被跳过,
  //   offsets.length < seamCount,循环就提前结束 —— **后面的镜头根本没进成片**。
  //   现在按接缝索引遍历,保证每段都被接上。
  let prev = inLabel(0);
  for (let k = 0; k < seamCount; k++) {
    const nextIn = inLabel(k + 1);
    const outLabel = k === seamCount - 1 ? 'vout' : `v${k + 1}`;
    const off = offsetByK.get(k);
    parts.push(off != null
      ? `[${prev}][${nextIn}]xfade=transition=${kind}:duration=${t}:offset=${off}[${outLabel}]`
      : `[${prev}][${nextIn}]concat=n=2:v=1:a=0[${outLabel}]`);
    prev = outLabel;
  }

  // ── 音频链:与视频同一套接缝决策 ──────────────────────────────────────
  // 用转场的接缝 → acrossfade(同样重叠 t 秒,时长收缩与视频一致);
  // 硬接的接缝   → concat 直接拼(不收缩)。两边收缩量一致才不会音画错位。
  //
  // 2026-09-22:判据从「全部片段都有音轨才挂链」放宽为「有一个就挂」——
  //   缺音轨的片段按其实测时长补**等长静音**(aevalsrc),而不是让整集失声。
  //   实测 3 部剧 15 集 129 个片段全部带 AAC,所以这条兜底路径基本不触发;
  //   留着是为了上游哪天返回静音片段时不至于"整集突然没声音"。
  const audio = input.hasAudio;
  const withAudio = Array.isArray(audio) && audio.length >= segs.length
    && segs.some((_, i) => audio[i] === true);
  const AUDIO_FMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  // ⚠ 这两个计数**只在音频链真的挂上时**才有意义 —— 探测残缺时链没挂,
  //   报"音轨 2/3"会让日志比不打还误导。所以放在 withAudio 分支里累加。
  let audioTracks = 0;
  let silentPadded = 0;
  if (withAudio) {
    // ⚠⚠ 这里**绝不能**用无限长的音源。
    //   第一版写的是"尾部 [aout]apad 补静音 + -shortest 收尾",实测 ffmpeg 6.0
    //   直接**永不结束**(产物无 moov atom,文件一直长,4 分钟还在写)。
    //   根因:-shortest 在 filter_complex 下不可靠(ffmpeg 官方也标注过),而 apad
    //   无参 = 无限补静音 → 输出流永远不 EOF。
    //   生产后果会是"第 7 步合成挂死 → 集永远 running → 又攒僵尸槽位"。
    //   现在改成**逐段定长**:每段音频 atrim 到实测时长再 apad 补到同一时长,
    //   所有源都有限,合成自然收尾,也不需要 -shortest。
    for (let i = 0; i < segs.length; i++) {
      const d = durs[i];
      if (audio[i] === true) {
        // 统一采样率/声道/采样格式(否则 acrossfade 会因格式不一致失败),
        // 并把该段音频**截/补到与视频等长** —— 这是全链定长的关键。
        audioTracks++;
        pre.push(
          `[${i}:a]aresample=48000,${AUDIO_FMT},atrim=0:${d},apad=whole_dur=${d}[aa${i}]`,
        );
      } else {
        silentPadded++;
        pre.push(`aevalsrc=0:d=${d}:s=48000:c=stereo,${AUDIO_FMT}[aa${i}]`);
      }
    }
    let prevA = 'aa0';
    for (let k = 0; k < seamCount; k++) {
      const nextA = `aa${k + 1}`;
      const outA = k === seamCount - 1 ? 'aout' : `ab${k + 1}`;
      parts.push(offsetByK.has(k)
        ? `[${prevA}][${nextA}]acrossfade=d=${t}:c1=tri:c2=tri[${outA}]`
        : `[${prevA}][${nextA}]concat=n=2:v=0:a=1[${outA}]`);
      prevA = outA;
    }
    // 注意:这里**没有**全局 apad / -shortest。逐段已定长,音视频等长自然收尾。
  }

  const filterComplex = [...pre, ...parts].join(';');
  const args: string[] = ['-y', '-threads', '0'];
  for (const s of segs) args.push('-i', s);
  args.push('-filter_complex', filterComplex, '-map', '[vout]');
  if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  // ⚠ 这里**故意不加 -shortest**:它在 filter_complex 下不可靠,实测会把 ffmpeg
  //   挂到永不结束(见音频链注释)。音视频逐段等长,不需要它。
  args.push(out);
  const totalSec = durs.reduce((a, b) => a + b, 0) - offsets.length * t;
  return {
    mode: 'xfade', args, filterComplex,
    totalSec: Number(totalSec.toFixed(3)),
    audioTracks,
    silentPadded,
  };
}
