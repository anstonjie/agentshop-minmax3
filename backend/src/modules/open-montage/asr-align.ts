// ============================================================================
// asr-align.ts —— 词级对齐的 Node 侧封装（调用 tool/asr-align.py）
// ----------------------------------------------------------------------------
// 职责边界：只负责「把一段媒体 → 词级时间戳」这件事，不做时间轴装配
//   （装配在 drama/timeline.ts，纯函数、可单测）。这样拆开的好处是：
//   换 ASR 实现（WhisperX/云端 API/别家）不影响时间轴逻辑。
//
// 为什么用 Python 子进程而不是纯 Node：
//   本机实测 Windows 沙箱**禁掉了 PowerShell 的 Add-Type 与 cscript**（都是
//   安全策略），SAPI/TTS 那条「零依赖」的路走不通；而 Python + faster-whisper
//   是可用且开源的（BSD-2，与 hypit 的许可证无关，可放心用于多租户平台）。
//
// 关键设计：
//   · **优雅降级**：ASR 不可用（依赖缺失/超时/任何异常）不抛到底 —— 返回
//     available:false，让合成链路回退到"按镜头时长估算"的字幕，
//     绝不因为对齐失败而出不了片。
//   · **缓存**：按 (文件大小, mtime) 命中 `<媒体文件>.asr.json`。
//     重跑 step7（改台词后重新合成）时同一段音频不必再跑一次模型。
//   · **代理清理**：ASR 要访问 hf-mirror，必须清掉 HTTP_PROXY 之类的环境变量
//     （本机代理会把 localhost/镜像访问也拦住，踩过）。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { WordTiming } from '../drama/timeline';

export interface AsrAlignOptions {
  /** Python 解释器；缺省按 ASR_PYTHON → 托管 venv → PATH 顺序探测 */
  pythonPath?: string;
  /** 模型规模 tiny/base/small/medium；缺省 ASR_MODEL → tiny */
  model?: string;
  /** 超时（毫秒）；短视频默认 10 分钟足够（首次含模型下载会更久） */
  timeoutMs?: number;
  /** 跳过缓存强制重算 */
  noCache?: boolean;
  /**
   * 缓存键覆盖。默认用 media 自身的 (size, mtime)；但合成链路里 media 是
   * **每次重新 concat 出来的**(mtime 必然变化)，用默认键等于永远命中不了。
   * 所以调用方改用「分镜文件指纹」当键 —— 分镜没换就不必重跑模型。
   */
  cacheKey?: string;
  /** 缓存文件路径覆盖(默认 `<media>.asr.json`) */
  cacheFile?: string;
  /** 日志出口（Nest Logger 兼容） */
  warn?: (msg: string) => void;
}

export interface AsrAlignResult {
  /** 是否真的拿到了词级证据。false → 上游应回退到估算 */
  available: boolean;
  words: WordTiming[];
  language?: string;
  durationSec?: number;
  /** 未命中原因（available=false 时） */
  reason?: string;
}

/** ASR_DISABLE=1 时彻底关闭（比如某些部署环境不装 Python） */
export function asrDisabled(): boolean {
  const v = String(process.env.ASR_DISABLE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * 定位 tool/asr-align.py。
 * 从 __dirname 逐级上溯，找第一个含 `tool/asr-align.py` 的目录 —— 这样
 * dev(src/…/open-montage) 与 prod(dist/src/…/open-montage) 都能命中，
 * 不需要写死上溯层数（两者的层数并不相同）。
 */
export function resolveAsrScript(): string | null {
  const override = process.env.ASR_SCRIPT;
  if (override && fs.existsSync(override)) return override;

  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'tool', 'asr-align.py');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 按优先级探测可用的 Python 解释器 */
export function resolvePython(): string | null {
  const candidates: string[] = [];
  const fromEnv = String(process.env.ASR_PYTHON || '').trim();
  if (fromEnv) candidates.push(fromEnv);

  // 本项目在开发机上用的托管 venv（装了 faster-whisper）
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    candidates.push(
      path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'),
      path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python'),
    );
  }
  candidates.push('python', 'python3');

  for (const c of candidates) {
    if (!c) continue;
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    // 非绝对路径交给 spawn 走 PATH，不预检（预检反而会误杀）
    return c;
  }
  return null;
}

/** 清理代理相关环境变量（ASR 要连镜像，代理会拦） */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.HF_ENDPOINT = env.HF_ENDPOINT || 'https://hf-mirror.com';
  env.HF_HUB_DISABLE_XET = env.HF_HUB_DISABLE_XET || '1';
  return env;
}

interface CacheFile {
  key: string;
  model: string;
  words: WordTiming[];
  language?: string;
  durationSec?: number;
}

function cacheKey(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** 缓存文件路径：调用方给了就用它，否则挨着媒体文件放 */
function cachePathFor(file: string, override?: string): string {
  return override || `${file}.asr.json`;
}

/** 缓存键：调用方给了指纹就用它，否则用媒体自身 (size, mtime) */
function cacheKeyFor(file: string, override?: string): string | null {
  if (override) return override;
  return cacheKey(file);
}

function readCache(file: string, model: string, keyOverride?: string, pathOverride?: string): AsrAlignResult | null {
  const p = cachePathFor(file, pathOverride);
  const key = cacheKeyFor(file, keyOverride);
  if (!key) return null;
  try {
    if (!fs.existsSync(p)) return null;
    const data: CacheFile = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.model !== model) return null;
    if (data.key !== key) return null;   // 指纹变了(分镜换过 / 媒体重编码) → 缓存失效
    if (!Array.isArray(data.words) || !data.words.length) return null;
    return { available: true, words: data.words, language: data.language, durationSec: data.durationSec };
  } catch {
    return null;
  }
}

function writeCache(
  file: string, model: string, res: AsrAlignResult, keyOverride?: string, pathOverride?: string,
): void {
  const key = cacheKeyFor(file, keyOverride);
  if (!key) return;
  try {
    const payload: CacheFile = {
      key, model, words: res.words, language: res.language, durationSec: res.durationSec,
    };
    fs.writeFileSync(cachePathFor(file, pathOverride), JSON.stringify(payload), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/**
 * 对一段媒体做词级对齐。
 * **永不抛错**：任何异常都转成 `{available:false, reason}`，由上游决定降级。
 */
export async function alignVideoWords(file: string, opts: AsrAlignOptions = {}): Promise<AsrAlignResult> {
  const warn = opts.warn || (() => { /* 默认静默 */ });
  const model = String(opts.model || process.env.ASR_MODEL || 'tiny');

  if (asrDisabled()) return { available: false, words: [], reason: 'ASR_DISABLE' };
  if (!file || !fs.existsSync(file)) return { available: false, words: [], reason: 'MEDIA_NOT_FOUND' };

  if (!opts.noCache) {
    const hit = readCache(file, model, opts.cacheKey, opts.cacheFile);
    if (hit) return hit;
  }

  const script = resolveAsrScript();
  if (!script) return { available: false, words: [], reason: 'ASR_SCRIPT_NOT_FOUND' };

  const python = resolvePython();
  if (!python) return { available: false, words: [], reason: 'PYTHON_NOT_FOUND' };

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  try {
    const { spawnSync } = require('child_process');
    const started = Date.now();
    const proc = spawnSync(python, [script, file, model, '--json'], {
      encoding: 'utf8',
      env: cleanEnv(),
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });

    // 退出码 2 = faster-whisper 未安装（环境不具备，不是这次的错）
    if (proc.status === 2) {
      return { available: false, words: [], reason: 'FASTER_WHISPER_MISSING' };
    }
    if (proc.status !== 0) {
      const tail = String(proc.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ');
      warn(`[asr] 对齐失败 status=${proc.status}: ${tail.slice(0, 300)}`);
      return { available: false, words: [], reason: `ASR_EXIT_${proc.status}` };
    }

    // stdout 里可能混有 warnings，取最后一个能解析成 JSON 的行（对象含 words 字段）
    const lines = String(proc.stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    let payload: any = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j && Array.isArray(j.words)) { payload = j; break; }
      } catch { /* 不是这一行，继续往前找 */ }
    }
    if (!payload) return { available: false, words: [], reason: 'ASR_BAD_OUTPUT' };

    const words: WordTiming[] = payload.words
      .filter((w: any) => w && typeof w.word === 'string' && Number.isFinite(w.startSec) && Number.isFinite(w.endSec))
      .map((w: any) => ({ word: w.word, startSec: Number(w.startSec), endSec: Number(w.endSec) }));

    if (!words.length) return { available: false, words: [], reason: 'ASR_NO_WORDS' };

    const res: AsrAlignResult = {
      available: true,
      words,
      language: payload.language,
      durationSec: payload.durationSec,
    };
    writeCache(file, model, res, opts.cacheKey, opts.cacheFile);
    warn(`[asr] 对齐完成 ${words.length} 词 / ${payload.durationSec ?? '?'}s, 耗时 ${Math.round((Date.now() - started) / 1000)}s`);
    return res;
  } catch (e: any) {
    const msg = e?.message || String(e);
    warn(`[asr] 对齐异常: ${msg.slice(0, 200)}`);
    return { available: false, words: [], reason: 'ASR_EXCEPTION' };
  }
}

/**
 * 用 ffprobe 探媒体真实时长（秒）。拿不到返回 null。
 *
 * 为什么必须有这一步（对应 hypit 的 `pipeline:Normalize`——
 * "归一化先于语义对齐"）：Agnes 返回的 duration_sec 是**请求值**，
 * 与实际编码时长有偏差；按请求值累加镜头窗，第 15 镜可能偏 1 秒以上，
 * 之后拿这个错窗口去分派 ASR 词，等于把编码偏差当成语音偏差。
 */
export function probeDurationSec(ffprobeBin: string, file: string): number | null {
  try {
    const { spawnSync } = require('child_process');
    const proc = spawnSync(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (proc.status !== 0) return null;
    const v = parseFloat(String(proc.stdout || '').trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 探媒体帧率（取 r_frame_rate，形如 "30/1"）。拿不到返回 null。
 * 帧率用于时间轴把字幕时间吸附到精确帧（hypit：位置须落在精确帧上），
 * 避免同一句话在不同帧上读出不同的毫秒值造成抖动。
 */
export function probeFps(ffprobeBin: string, file: string): number | null {
  try {
    const { spawnSync } = require('child_process');
    const proc = spawnSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (proc.status !== 0) return null;
    const raw = String(proc.stdout || '').trim();
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
    if (m) {
      const v = Number(m[1]) / Number(m[2]);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 探媒体分辨率(宽×高,取第一路视频流)。拿不到返回 null。
 *
 * 2026-09-16:字幕 ASS 画布必须跟**成片真实分辨率**走 —— 旧实现硬编码
 * PlayRes 512×288(16:9),而剧级成片默认 9:16 竖屏,libass 按高度缩放后
 * 字被放大近一倍、18 字远超屏宽(用户反馈"字幕超出屏幕"的根因)。
 */
export function probeResolution(
  ffprobeBin: string, file: string,
): { width: number; height: number } | null {
  try {
    const { spawnSync } = require('child_process');
    const proc = spawnSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (proc.status !== 0) return null;
    const lines = String(proc.stdout || '').trim().split(/\r?\n/);
    const w = parseFloat(lines[0] || '');
    const h = parseFloat(lines[1] || '');
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
      ? { width: Math.round(w), height: Math.round(h) }
      : null;
  } catch {
    return null;
  }
}

/** 由 ffmpeg 路径推出同目录的 ffprobe；找不到返回 null */
export function resolveFfprobeBin(ffmpegBin: string): string | null {
  const fromEnv = String(process.env.FFPROBE_BIN || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates: string[] = [];
  if (ffmpegBin && path.isAbsolute(ffmpegBin)) {
    const dir = path.dirname(ffmpegBin);
    candidates.push(
      path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
      path.join(dir, 'ffprobe'),
    );
  }
  candidates.push(
    'F:\\ffmpeg-8.1.2\\bin\\ffprobe.exe',
    'D:\\metaverse\\chatgpt\\ffmpeg-6.0-full_build\\ffmpeg-6.0-full_build\\bin\\ffprobe.exe',
    'C:\\ffmpeg\\bin\\ffprobe.exe',
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
  );
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}
