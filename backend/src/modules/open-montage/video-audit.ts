// ============================================================================
// video-audit.ts —— P1-c「成片拉片质检门」
// ----------------------------------------------------------------------------
// 借鉴 github.com/eternityspring/reelbench-skills(Apache-2.0)的核心纪律:
//   「能量的都由代码量,模型不参与质检;每条判断都能被代码当场对账。」
// 出片后用 ffmpeg/ffprobe 客观量三维,把"感觉支离破碎"变成数字 + 门:
//   ① 镜长 / 切次        —— 复用 compose 已实测的 durations[]
//   ② 段内运动量(死镜)  —— signalstats 逐帧 YDIF 的中位数(两端剔除,避切点尖峰)
//   ③ 接缝跳变(破碎)    —— 相邻片段 尾帧↔首帧 的灰度平均绝对差
//
// 阈值不是拍脑袋:2026-09-16 用仓库里 13 段真实分镜标定过(见 DEFAULT_THRESHOLDS
// 注释与 spec)。标定发现「接缝绝对像素差」区分力弱(每镜本就是不同构图,连本集相邻
// 镜头都有 0.14~0.39 的差),所以接缝只做**按本集自身分布的离群检测**,不设绝对带。
//
// 分层(与 reelbench 一致:测量是 I/O,判定是纯函数,便于无 ffmpeg 单测):
//   纯函数:medianTrimmed / parseYdif / parseFreezeRatio / meanAbsDiffNorm /
//           quartiles / aggregateAudit   ← spec 只测这些,不碰 ffmpeg
//   I/O:    measureSegments / extractSeams / auditCompose  ← 全部降级不抛错
//
// MVP 边界:**只测量 + 暴露,不硬拦、不自动回炉**。verdict 只会是 'ok' | 'review',
// 成片照常交付,质检结论写进 stepData['7'].output.audit 供前端展示与后续重生打靶。
// ============================================================================

import * as fs from 'fs';

/** 质检阈值(全部可被 config 覆盖;默认值来自 2026-09-16 真实片段标定) */
export interface AuditThresholds {
  /**
   * 段内 YDIF 中位数低于此值 = 近静止「死镜」。
   * 标定:13 段真实分镜 YDIFmed 分布 min0.59 / p25 1.07 / p50 1.94 / p75 4.44 / max6.89,
   * 取 1.0 命中最静的 ~23%(0.59/0.63/1.04 附近),这些正是"单张静止首帧 i2v 出来的死视频"。
   */
  staticMaxMotion: number;
  /** freezedetect 冻结时长占比超过此值 = 硬冻(比 YDIF 更保守的地板,只兜真正冻结)。 */
  freezeMinRatio: number;
  /** 接缝跳变离群系数:seamDiff > 中位数 + max(K×1.4826×MAD, 绝对地板) 才标「硬跳接缝」。用 MAD 而非 IQR,避免离群值污染自己的判定线。 */
  seamOutlierK: number;
  /** 接缝离群的绝对地板:MAD≈0(接缝几乎一样)时,仍要求高出中位数这么多才算硬跳,防微小波动误报。 */
  seamOutlierAbsFloor: number;
  /** 平均镜长提示带(导演判断,只提示不拦)。低于 min 提示切太快,高于 max 提示镜太长。 */
  pacingAdvisoryMinSec: number;
  pacingAdvisoryMaxSec: number;
}

export const DEFAULT_THRESHOLDS: AuditThresholds = {
  staticMaxMotion: 1.0,
  freezeMinRatio: 0.6,
  seamOutlierK: 2.0,
  seamOutlierAbsFloor: 0.10,
  // 咱们现状每镜 4~12s、每分钟 6~7 切;reelbench AI 短片基准 3.83s / 15.7 切。
  // 提示带刻意宽松,只对"极端"给提示,不把导演判断当错误。
  pacingAdvisoryMinSec: 1.5,
  pacingAdvisoryMaxSec: 15,
};

export interface SegmentMotion {
  /** 片段序号(0基) */
  idx: number;
  /** 段内 YDIF 中位数(两端剔除);测不到为 null */
  ydifMedian: number | null;
  /** freezedetect 冻结时长占比 0~1;无冻结为 0;测不到为 null */
  frozenRatio: number | null;
  /** 实测时长(秒),来自 compose 已量的 durations[] */
  durationSec: number | null;
}

export interface SeamMeasure {
  /** 接缝位置:片段 at 与 at+1 之间(0基,at 从 0 起) */
  at: number;
  /** 尾帧↔首帧 灰度平均绝对差,归一化 0~1;测不到为 null */
  diff: number | null;
}

export interface VideoAudit {
  /** 质检被跳过(ffmpeg 缺失 / 测量异常)时为 true,并给 reason。跳过不是通过,前端要如实显示。 */
  skipped?: boolean;
  reason?: string;
  shotCount: number;
  totalSec: number;
  avgShotSec: number | null;
  minShotSec: number | null;
  maxShotSec: number | null;
  cutsPerMin: number | null;
  motions: SegmentMotion[];
  /** 近静止死镜占比 0~1 */
  staticRatio: number;
  /** 死镜的片段序号 */
  staticShots: number[];
  /** 硬冻的片段序号 */
  frozenShots: number[];
  seams: SeamMeasure[];
  /** 硬跳接缝(离群)的接缝位置 */
  seamOutliers: number[];
  warnings: string[];
  /** MVP 只到 review,不硬拦 */
  verdict: 'ok' | 'review';
  thresholds: AuditThresholds;
}

// ---------------------------------------------------------------------------
// 纯函数层(spec 覆盖,不调 ffmpeg)
// ---------------------------------------------------------------------------

/**
 * 两端剔除后取中位数。剔除两端是为了避开镜头首尾的切点尖峰
 * (第一帧无前帧差分、末帧常因编码收尾跳变),与 reelbench track.json 口径一致。
 * 少于 3 个样本不剔除(样本太少,剔了就没了),退化为均值。
 */
export function medianTrimmed(values: number[]): number | null {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  if (v.length < 3) return v.reduce((a, b) => a + b, 0) / v.length;
  const s = [...v].sort((a, b) => a - b).slice(1, -1);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 从 signalstats metadata=print 的 stdout 里解析逐帧 YDIF 值。 */
export function parseYdif(stdout: string): number[] {
  const txt = String(stdout || '');
  const out: number[] = [];
  const re = /lavfi\.signalstats\.YDIF=([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * 从 freezedetect metadata=print 输出解析冻结时长占比。
 * freeze_duration 在每段冻结结束时打印一次,累加后除以片段总时长。
 * 没有任何 freeze_duration = 无冻结,返回 0(不是 null:null 表示"没测到")。
 */
export function parseFreezeRatio(output: string, durationSec: number | null): number | null {
  const txt = String(output || '');
  if (!/freezedetect/i.test(txt) && !/freeze_duration/.test(txt)) {
    // 命令跑通但没冻结:freezedetect 无输出是正常的(见标定:近静止≠硬冻)
    // 这里无法区分"没冻结"与"命令没跑",交由调用方决定是否视为 0
    return durationSec && durationSec > 0 ? 0 : null;
  }
  let frozen = 0;
  const re = /lavfi\.freezedetect\.freeze_duration=([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) frozen += v;
  }
  if (!durationSec || durationSec <= 0) return frozen > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, frozen / durationSec));
}

/** 两段等长灰度帧的平均绝对差,归一化到 0~1(除以 255)。长度不符/空返回 null。 */
export function meanAbsDiffNorm(
  a: ArrayLike<number> | null,
  b: ArrayLike<number> | null,
): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

/** 分位数(线性取位,够质检用)。空数组返回全 null。 */
export function quartiles(values: number[]): {
  p25: number | null; p50: number | null; p75: number | null; iqr: number | null;
} {
  const s = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { p25: null, p50: null, p75: null, iqr: null };
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const p25 = at(0.25), p50 = at(0.5), p75 = at(0.75);
  return { p25, p50, p75, iqr: p75 - p25 };
}

/** 已排序数组的中位数(内部工具)。空返回 null。 */
export function medianOf(sorted: number[]): number | null {
  if (!sorted || !sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * 中位绝对偏差(MAD)。比 IQR/标准差更抗离群:一个剧变接缝不会把判定线自己抬高,
 * 从而解决"小样本里离群值污染四分位"的经典问题(击穿③曾踩)。
 */
export function medianAbsDeviation(values: number[]): number | null {
  const s = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const med = medianOf(s);
  if (med == null) return null;
  const devs = s.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  return medianOf(devs);
}

/**
 * 判定层:把测量结果聚合成 VideoAudit。纯函数,不碰 ffmpeg/文件。
 * 门规则(MVP:只提示/标记,不硬拦):
 *   - staticRatio = 死镜数 / 有 YDIF 的镜头数;有死镜就出 warning,verdict 升 review
 *   - 硬冻镜头单独点名
 *   - 接缝离群(> p50 + K×IQR)点名,verdict 升 review
 *   - 镜长/切次仅提示(导演判断,不升 review)
 */
export function aggregateAudit(input: {
  durations: Array<number | null>;
  motions: SegmentMotion[];
  seams: SeamMeasure[];
  thresholds?: Partial<AuditThresholds>;
}): VideoAudit {
  const th: AuditThresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };
  const motions = input.motions || [];
  const seams = input.seams || [];
  const durs = (input.durations || []).map((d) => (Number.isFinite(d as number) && (d as number) > 0 ? (d as number) : null));
  const knownDurs = durs.filter((d): d is number => d != null);
  const shotCount = motions.length || durs.length;
  const totalSec = knownDurs.reduce((a, b) => a + b, 0);

  const avgShotSec = knownDurs.length ? totalSec / knownDurs.length : null;
  const minShotSec = knownDurs.length ? Math.min(...knownDurs) : null;
  const maxShotSec = knownDurs.length ? Math.max(...knownDurs) : null;
  const cutsPerMin = totalSec > 0 ? Math.max(0, shotCount - 1) / (totalSec / 60) : null;

  const withMotion = motions.filter((m) => m.ydifMedian != null);
  const staticShots = withMotion.filter((m) => (m.ydifMedian as number) < th.staticMaxMotion).map((m) => m.idx);
  const staticRatio = withMotion.length ? staticShots.length / withMotion.length : 0;
  const frozenShots = motions
    .filter((m) => m.frozenRatio != null && (m.frozenRatio as number) >= th.freezeMinRatio)
    .map((m) => m.idx);

  const seamVals = seams.filter((s) => s.diff != null).map((s) => s.diff as number);
  const seamOutliers: number[] = [];
  if (seamVals.length >= 4) {
    const MAD_CONSISTENCY = 1.4826; // 正态一致性系数,把 MAD 换算到标准差量纲
    const med = medianOf([...seamVals].sort((a, b) => a - b)) ?? 0;
    const mad = medianAbsDeviation(seamVals) ?? 0;
    const cut = med + Math.max(th.seamOutlierK * MAD_CONSISTENCY * mad, th.seamOutlierAbsFloor);
    for (const s of seams) if (s.diff != null && s.diff > cut) seamOutliers.push(s.at);
  }

  const warnings: string[] = [];
  if (staticShots.length) {
    warnings.push(
      `近静止死镜 ${staticShots.length}/${withMotion.length}(YDIF中位数<${th.staticMaxMotion}):`
      + `片段 #${staticShots.join(',#')} —— 单张静止首帧 i2v 常见,建议回炉或加运镜`,
    );
  }
  if (frozenShots.length) {
    warnings.push(`硬冻镜头(冻结占比≥${th.freezeMinRatio}):片段 #${frozenShots.join(',#')}`);
  }
  if (seamOutliers.length) {
    warnings.push(
      `硬跳接缝 ${seamOutliers.length} 处(接缝差>本集中位数+max(${th.seamOutlierK}×MAD,${th.seamOutlierAbsFloor})):`
      + `位置 ${seamOutliers.map((a) => `${a}→${a + 1}`).join(', ')} —— 破碎感来源,建议加转场/尾帧接力`,
    );
  }
  if (avgShotSec != null && avgShotSec < th.pacingAdvisoryMinSec) {
    warnings.push(`[提示·不拦] 平均镜长 ${avgShotSec.toFixed(2)}s 偏短,切得过碎`);
  } else if (avgShotSec != null && avgShotSec > th.pacingAdvisoryMaxSec) {
    warnings.push(`[提示·不拦] 平均镜长 ${avgShotSec.toFixed(2)}s 偏长,单镜拖沓`);
  }

  const verdict: 'ok' | 'review' =
    (staticShots.length || frozenShots.length || seamOutliers.length) ? 'review' : 'ok';

  return {
    shotCount,
    totalSec,
    avgShotSec,
    minShotSec,
    maxShotSec,
    cutsPerMin,
    motions,
    staticRatio,
    staticShots,
    frozenShots,
    seams,
    seamOutliers,
    warnings,
    verdict,
    thresholds: th,
  };
}

// ---------------------------------------------------------------------------
// I/O 层(调 ffmpeg;全部降级不抛错——质检绝不能拖垮出片)
// ---------------------------------------------------------------------------

const GRAY_W = 64;
const GRAY_H = 36;
const GRAY_BYTES = GRAY_W * GRAY_H;

function spawnFfmpeg(bin: string, args: string[], timeoutMs: number): {
  status: number | null; stdout: Buffer; stderr: string;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process');
    const proc = spawnSync(bin, args, {
      encoding: 'buffer', maxBuffer: 1 << 28, windowsHide: true, timeout: timeoutMs,
    });
    return {
      status: proc.status,
      stdout: (proc.stdout as Buffer) || Buffer.alloc(0),
      stderr: (proc.stderr as Buffer)?.toString('utf8') || '',
    };
  } catch {
    return null;
  }
}

/**
 * 一次 pass 同时量段内运动(YDIF)与硬冻(freezedetect)。
 * 两个 metadata=print 都写 stdout,按各自 key 解析。测不到返回 null 字段。
 */
export function measureSegmentMotion(
  ffmpegBin: string, segPath: string, durationSec: number | null, idx: number,
): SegmentMotion {
  const r = spawnFfmpeg(ffmpegBin, [
    '-hide_banner', '-i', segPath,
    '-vf',
    `scale=${GRAY_W}:${GRAY_H},signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-,`
    + `freezedetect=n=-60dB:d=0.5,metadata=mode=print:file=-`,
    '-f', 'null', '-',
  ], 60_000);
  if (!r) return { idx, ydifMedian: null, frozenRatio: null, durationSec };
  const stdout = r.stdout.toString('utf8');
  const combined = stdout + '\n' + r.stderr;
  const ydifMedian = medianTrimmed(parseYdif(stdout));
  const frozenRatio = parseFreezeRatio(combined, durationSec);
  return { idx, ydifMedian, frozenRatio, durationSec };
}

/** 抽片段首帧灰度(64×36);-frames:v 1 只解一帧,极快。失败返回 null。 */
function firstGrayFrame(ffmpegBin: string, segPath: string): Buffer | null {
  const r = spawnFfmpeg(ffmpegBin, [
    '-hide_banner', '-i', segPath, '-frames:v', '1',
    '-vf', `scale=${GRAY_W}:${GRAY_H},format=gray`, '-f', 'rawvideo', '-',
  ], 30_000);
  return r && r.stdout.length === GRAY_BYTES ? r.stdout : null;
}

/** 抽片段尾帧灰度;-sseof -0.15 从末尾前 0.15s 定位。失败返回 null。 */
function lastGrayFrame(ffmpegBin: string, segPath: string): Buffer | null {
  const r = spawnFfmpeg(ffmpegBin, [
    '-hide_banner', '-sseof', '-0.15', '-i', segPath, '-frames:v', '1',
    '-vf', `scale=${GRAY_W}:${GRAY_H},format=gray`, '-f', 'rawvideo', '-',
  ], 30_000);
  return r && r.stdout.length === GRAY_BYTES ? r.stdout : null;
}

/**
 * 顶层:对一组已下载的分镜片段做质检。任何异常都降级为 skipped,绝不抛错。
 * @param ffmpegBin  ffmpeg 可执行路径(compose 已解析好)
 * @param segPaths   进入成片的片段路径(有序)
 * @param durations  每片段实测时长(compose 已量好,直接复用)
 */
export function auditCompose(
  ffmpegBin: string | null,
  segPaths: string[],
  durations: Array<number | null>,
  thresholds?: Partial<AuditThresholds>,
): VideoAudit {
  const base = {
    shotCount: 0, totalSec: 0, avgShotSec: null, minShotSec: null, maxShotSec: null,
    cutsPerMin: null, motions: [], staticRatio: 0, staticShots: [], frozenShots: [],
    seams: [], seamOutliers: [], warnings: [], verdict: 'ok' as const,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) },
  };
  if (!ffmpegBin) return { ...base, skipped: true, reason: 'FFMPEG_UNAVAILABLE' };
  if (!Array.isArray(segPaths) || segPaths.length === 0) {
    return { ...base, skipped: true, reason: 'NO_SEGMENTS' };
  }
  try {
    // 段内运动:每片段一次 pass
    const motions: SegmentMotion[] = segPaths.map((seg, i) => {
      const dur = Number.isFinite(durations[i] as number) ? (durations[i] as number) : null;
      if (!fs.existsSync(seg)) return { idx: i, ydifMedian: null, frozenRatio: null, durationSec: dur };
      return measureSegmentMotion(ffmpegBin, seg, dur, i);
    });

    // 接缝:尾帧(i)↔首帧(i+1)。首帧缓存复用,避免重复抽。
    const seams: SeamMeasure[] = [];
    let prevLast: Buffer | null = segPaths.length > 1 && fs.existsSync(segPaths[0])
      ? lastGrayFrame(ffmpegBin, segPaths[0]) : null;
    for (let i = 1; i < segPaths.length; i++) {
      const seg = segPaths[i];
      const curFirst = fs.existsSync(seg) ? firstGrayFrame(ffmpegBin, seg) : null;
      seams.push({ at: i - 1, diff: meanAbsDiffNorm(prevLast, curFirst) });
      prevLast = fs.existsSync(seg) ? lastGrayFrame(ffmpegBin, seg) : null;
    }

    return aggregateAudit({ durations, motions, seams, thresholds });
  } catch (e: any) {
    return { ...base, skipped: true, reason: `AUDIT_EXCEPTION:${e?.message || 'unknown'}` };
  }
}
