// ============================================================================
// video-prompt.ts —— 分镜视频(图生视频)提示词的「运动语言」构造器(纯函数)
// ----------------------------------------------------------------------------
// 为什么单独成文件:step6 之前把分镜的 shot.description 直接丢给视频模型,
//   但 description 是**给图像关键帧写的构图描述**(还刻意禁写了人物长相,
//   因为脸由首帧参考图锁定)。视频模型最吃的恰恰是它没给的东西:
//     · 镜头怎么动(推/拉/摇/移/跟)
//     · 主体怎么动(物理合理的运动)
//     · 画面稳定性(不闪烁/不形变/不跳切)
//   缺这些 → 人物"原地漂移"、镜头无故跳变、画面塑料感。这是视频"不真实"
//   的头号成因。这里把 shot_type/camera_motion 翻译成英文运动语言并补真实性
//   底线词,与 keyframe-plan.ts 一样做成纯函数 + 单测,防止"顺手优化"退回。
//
// 设计铁律(踩过,勿回退):
//   · 图生视频下首帧已锁定构图与人脸,prompt **不再复述画面内容/人物长相**,
//     只描述"从这一帧开始如何运动"。复述长相 = 给模型两个矛盾信号 → 换脸。
//   · 运镜/景别用英文强权重词(模型对英文运动术语响应更稳)。
//   · 真实性底线词固定追加,压住 morphing/flicker/distortion。
//
// 2026-09-24(飞书《各种运镜提示词》):运镜中英词表与 rhythm 兜底收到
//   camera-motion.ts 单一来源;本文件只保留视频 prompt 结构组装。
//
// 2026-09-14 增补(方法论来源:zenstory-ai/drama-skills,MIT,
//   skills/short-drama-video-prompts/SKILL.md + docs/character-consistency-across-shots.md):
//   · **多人物守卫**:>1 人同框时追加身份区隔护栏词。跨镜穿帮多数不是脸变了,
//     是人物融合/换脸串位、手部与持物漂移、视线断裂 —— 这些必须在文字端显式声明,
//     不能赌模型自觉。
//   · **注意/持物交接(handoff)**:多人与道具镜头把"谁把什么交给谁、视线从哪
//     转到哪"写成一句状态描述,原样进 prompt(只写动作状态,禁写长相,与铁律一致)。
//   · **起止状态链**:start_state/end_state 让每镜"从可见起点开始、以可验证终点
//     结束",下一镜从上一镜终点继续。reference 模式下 start_state 刻意**不进**
//     prompt —— 起点归首帧参考图所有,文字再描一遍就是两个矛盾信号(drama-skills
//     的所有权划分:静态身份归参考帧,运动提示词只拥有"起点→终点的变化")。
//   · **无字幕护栏**:AI 视频模型经常自作主张糊上字幕/对白文字,每镜显式声明
//     不生成画外字幕(画内标牌等剧情文字属 description/垫图管辖,不在此禁)。
// ============================================================================

import { sanitizeDialogue } from './dialogue-sanitizer';
import {
  CAMERA_MOTION_EN,
  cameraMotionEn as cameraMotionEnShared,
  motionForRhythm,
  SHOT_TYPE_EN,
  shotTypeEn as shotTypeEnShared,
} from './camera-motion';

// 运镜/景别词表单一来源在 camera-motion.ts;此处 re-export 保持旧 import 路径不破。
export { CAMERA_MOTION_EN, SHOT_TYPE_EN };

// 景别词表见 camera-motion.ts(SHOT_TYPE_EN 单一来源),此处不再复刻。

/**
 * 视频真实性底线词 —— 固定追加,压制图生视频最常见的崩坏:
 *   形变(morphing)、闪烁(flicker)、多余肢体、跳切、塑料感、面部漂移。
 */
const REALISM_TAIL =
  'smooth natural motion, physically plausible movement, consistent lighting and shadows across frames, ' +
  'stable coherent camera, no morphing, no flickering, no sudden cuts, no distortion, ' +
  'realistic textures, cinematic film-like motion, high temporal consistency';

/**
 * 多人物守卫底线词 —— 镜头内 >1 人时追加(2026-09-14,drama-skills 方法论)。
 * 压制多人镜头三大崩坏:身份融合/互换(face swapping)、身体合并或复制、
 * 手部数量与持物漂移;并要求视线自然、动作有明确的先后轮转。
 */
const MULTI_CHARACTER_TAIL =
  'multiple distinct characters on screen, each keeping a separate consistent identity, ' +
  'no identity blending or swapping between characters, no merged or duplicated bodies, ' +
  'correct hand and finger count for every character, held props stay stable and consistent across frames, ' +
  'natural eyelines, clear turn-taking in movement and attention';

/**
 * 单人身份尾巴 —— 镜头内恰好 1 人时追加(2026-09-23 身份硬伤)。
 * 多人已有 MULTI_CHARACTER_TAIL;单人跨镜/镜内变性别、换人没有文字护栏,
 * 只靠首帧参考图在兜底路径(无 ref / relay 尾帧漂移)会失守。
 * 措辞刻意避开 "same face"(既有铁律测试禁止该字样)。
 */
const SINGLE_CHAR_IDENTITY_TAIL =
  'keep the exact same person from the first frame throughout the shot; ' +
  'do not change gender, age, or identity mid-shot';

/**
 * 无字幕护栏 —— 默认追加(2026-09-14,drama-skills 要求每镜显式声明)。
 * 只禁画外文字叠加(字幕/caption/对白文字);画内剧情文字(标牌/屏幕)由
 * description 与垫图管辖,不在这里一刀切。剧情需要字卡时 opts.textOverlay=true 关闭。
 */
const NO_TEXT_TAIL =
  'no subtitles, no captions, no dialogue text overlays at any moment';

export interface ShotForVideo {
  idx?: number;
  description?: string;
  shot_type?: string;
  camera_motion?: string;
  /** 本镜出场角色 id 列表(genStep4Shots 契约已有字段)——长度 >1 时追加多人物守卫 */
  characters?: string[];
  /** 本镜注意/持物/视线交接一句话(只写动作状态,禁写长相);原样进 prompt */
  handoff?: string;
  /** 起点状态(镜头开始时的可见状态);reference 模式下刻意不进 prompt(起点归首帧图所有) */
  start_state?: string;
  /** 终点状态(镜头结束时的可见状态,下一镜从这里继续) */
  end_state?: string;
  /**
   * 本镜台词/旁白/音效描述(genStep4Shots 契约已有字段)。
   * 2026-09-15 之前这里**没有接**:视频模型因此不知道要说什么,只能自由发挥
   * 含糊人声,成片听不到剧本文本 → 观感"没有对话"。
   */
  dialogue?: string;
  /** 节奏角色(hook/setup/…或中文别名);camera_motion 缺失/静止时运镜兜底用 */
  rhythm?: string;
}

/** 台词类型:speech=角色对白 / voiceover=旁白画外音 / ambient=纯环境音(不说话) */
type DialogueKind = 'speech' | 'voiceover' | 'ambient' | 'none';

/**
 * 判据一:显式声明"这是音效不是台词"。
 * 例:分镜里常写 "(无对白，只有罗盘指针摩擦的尖锐声)" / "(环境音:远处闷雷)"。
 */
const AMBIENT_HINTS = ['无对白', '无台词', '没有对白', '音效', '环境音', '只有', '静音', '沉默', '无声', '不需要台词'];

/**
 * 判据二:"说话"线索词 —— 出现任何一个,说明括号里讲的是人声而不是音效。
 * 实测分镜写法: "(少女轻声) 老板，还没睡啊？" / "(秦烈低声)果然...是我身边人。"
 */
const SPEECH_HINTS = ['说', '道', '喊', '问', '答', '低语', '轻声', '独白', '旁白', '台词', '对白', '吼', '喃', '唤', '笑'];

/** 把分镜的 dialogue 文本分类 */
export function classifyDialogue(raw: string): { kind: DialogueKind; text: string } {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'none', text: '' };
  if (AMBIENT_HINTS.some((h) => text.includes(h))) return { kind: 'ambient', text };
  if (/旁白|画外音|内心独白/.test(text)) return { kind: 'voiceover', text };
  // 整条被括号包裹且没有任何"说话"线索 → 纯音效描述,别当台词念。
  //   例 "(叮咚——门铃声)" / "(脚步声，关门的咔哒声)" / "(雨声轰鸣，掩盖了深夜的寂静)"
  //   反例 "(少女轻声) 老板，还没睡啊？" 含"轻声" → 仍按台词处理(括号外还有正文)。
  const wrapped = /^[(（\[【][\s\S]*[)）\]】]$/.test(text);
  if (wrapped && !SPEECH_HINTS.some((h) => text.includes(h))) return { kind: 'ambient', text };
  return { kind: 'speech', text };
}

/**
 * 把台词翻译成视频模型能执行的声音指令。
 *
 * 2026-09-15 修复(实测依据):Agnes video 2.5-flash **会输出带人声的音轨**
 *   (ffprobe 实测 video+audio 双流,aac 双声道)。对照实验:
 *   prompt 写明"小狗说：你是谁，小猫说：我是小猫呀" → 生成的视频里 1-2s / 3-4s
 *   各有一段语音包络,ASR 可识别出对应句子;反过来不写台词,模型只会给含糊人声。
 *   → 所以"台词必须进 prompt"是让成片**真能听见剧本台词**的关键一步。
 *
 * 2026-09-15 再修(音画双脏):旧实现把 classifyDialogue(raw).text —— **整条原文**
 *   (含「洛烛：」人名前缀、“(咬牙)”表演括注)—— 直接塞进 prompt,模型会把这些
 *   一并念出来(观众听到「陈明，咬牙，稳住……」)。与字幕脏文本同根。现在改吃
 *   sanitizeDialogue 的产物:text 才是要念的干净台词,performance 转成情绪/语气
 *   指令(影响演绎、不作为文本念出),ambient 转成环境音指令;说话人用
 *   "the character X speaks" 单独声明,绝不把「X：」粘进要念的台词。
 *
 * 同时保留"不许画成文字"的约束:模型常把引号内容渲染成画面字幕,
 *   这与我们后期烧录的字幕会打架(且 AI 写字常糊/错字)。
 */
export function dialogueInstruction(raw: string, knownNames: string[] = []): string | null {
  const s = sanitizeDialogue(raw, knownNames);
  if (s.kind === 'none') return null;
  // 表演提示 → 情绪/语气演绎指令(不作为台词文本念出)
  const perf = s.performance.length ? `, performed with: ${s.performance.join('; ')}` : '';
  if (s.kind === 'ambient') {
    const sfx = s.ambient.join('; ') || s.performance.join('; ');
    return sfx ? `ambient sound only, no speech: ${sfx}` : null;
  }
  if (s.kind === 'voiceover') {
    return `voice-over narration, spoken aloud in Chinese, off-screen (never render it as on-screen text): ${s.text}${perf}`;
  }
  // speech:谁在说 + 说什么 + 怎么演,但人名不粘进要念的台词
  const who = s.speaker ? `the character ${s.speaker} speaks` : 'a character speaks';
  return `spoken line, ${who}, say it aloud in Chinese with natural lip movement (never render it as on-screen text): ${s.text}${perf}`;
}

export interface VideoPromptOptions {
  /** 关键帧兜底 prompt(shot.description 为空时用) */
  fallback?: string;
  /** 额外风格尾巴(全剧统一风格,如 styleSpec.stylePrompt) */
  styleTail?: string;
  /** reference 模式(带音频参考)时,prompt 需用 <Picture N>/<Audio N> 指代素材 */
  referenceMode?: boolean;
  /** reference 模式下参考图张数(用于生成 <Picture N> 引导) */
  refImageCount?: number;
  /** reference 模式下参考音频条数 */
  refAudioCount?: number;
  /** 出场人物数兜底(shot.characters 缺失时由调用方直接给数字;>1 触发多人物守卫) */
  characterCount?: number;
  /** 剧情需要画内文字/字卡时置 true,跳过无字幕护栏(默认 false = 追加护栏) */
  textOverlay?: boolean;
  /** 资产库角色名表 —— 供 dialogueInstruction 精确认出说话人(剥「××地说」「愤怒的××」、
   *  拆一镜多说话人)。缺省时净化器保守处理,台词仍干净,只是 speaker 可能为 null。 */
  knownNames?: string[];
  /**
   * 本场故事锚点(2026-09-23 叙事对齐):scene summary + 原文 quote 一句话。
   * 之前 5-10s 视频 prompt 纯运动指令零剧情,模型不知道这段在讲什么 → 东一棒槌西一棒槌。
   */
  storyBeat?: string;
  /** 上一镜 end_state(拼进因果链,让本镜从可见前情继续) */
  prevEndState?: string;
  /** 节奏角色(hook/setup/…或中文别名);camera_motion 缺失或静止时作运镜兜底 */
  rhythm?: string;
}

/** 本镜出场人物数:优先 shot.characters 数组,其次 opts.characterCount */
export function shotCharacterCount(shot: ShotForVideo, opts: VideoPromptOptions = {}): number {
  const fromArr = Array.isArray(shot?.characters)
    ? shot.characters.filter((c) => c != null && String(c).trim() !== '').length
    : 0;
  if (fromArr > 0) return fromArr;
  const n = Number(opts?.characterCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 构造一条图生视频提示词。
 *
 * 输出结构:
 *   ①运动主体描述 ②起止状态链(start/handoff/end,reference 模式下省略 start)
 *   ③景别 ④运镜 ⑤多人物守卫(>1 人) ⑥风格尾巴 ⑦真实性底线 ⑧无字幕护栏
 *   —— 刻意不含"人物长相/服装"(由首帧参考图锁定,写了会换脸)。
 *
 * @param shot      分镜(含 description/shot_type/camera_motion/characters/handoff/起止状态)
 * @param opts      可选项(兜底 prompt / 风格尾巴 / reference 模式素材引用 / textOverlay)
 */
export function buildShotVideoPrompt(
  shot: ShotForVideo,
  opts: VideoPromptOptions = {},
): string {
  const parts: string[] = [];

  // ① 运动主体:优先用分镜画面描述(它已禁写长相,只讲构图/动作/环境)
  const base = String(shot?.description || opts.fallback || '').trim();
  if (base) parts.push(base);

  // ①′ 剧情锚点 + 前情因果(2026-09-23 叙事对齐):5-10s 片段要知道自己在讲哪一场戏、
  //     承接上一镜的可见终点 —— 否则纯运动指令堆叠 = 画面会动但剧情看不懂。
  const storyBeat = String(opts.storyBeat || '').trim();
  if (storyBeat) parts.push(`story beat for this shot: ${storyBeat}`);
  const prevEndState = String(opts.prevEndState || '').trim();
  if (prevEndState) parts.push(`continue from previous shot ending: ${prevEndState}`);

  // reference 模式:显式告诉模型"以参考图/音频为准",避免它把素材当灵感自由发挥
  if (opts.referenceMode) {
    const picRef = opts.refImageCount && opts.refImageCount > 0
      ? `use <Picture 1> as the exact starting frame and character reference`
      : '';
    const audioRef = opts.refAudioCount && opts.refAudioCount > 0
      ? `match the rhythm, pacing and ambient mood of <Audio 1>`
      : '';
    const refBits = [picRef, audioRef].filter(Boolean).join(', and ');
    if (refBits) parts.push(refBits);
  }

  // ② 起止状态链(drama-skills:每镜"从可见起点开始、以可验证终点结束")。
  //    reference 模式下 start_state 刻意跳过 —— 静态起点归首帧参考图所有,
  //    文字再锚一遍起点就是两个矛盾信号(与"不复述构图"同一条理由)。
  const startState = String(shot?.start_state || '').trim();
  if (startState && !opts.referenceMode) {
    parts.push(`begin exactly from this visible state: ${startState}`);
  }
  // handoff(注意/持物/视线交接)原样进 prompt;上游契约已禁写长相
  const handoff = String(shot?.handoff || '').trim();
  if (handoff) parts.push(handoff);
  const endState = String(shot?.end_state || '').trim();
  if (endState) {
    parts.push(`end at this visible state, so the next shot can continue from it: ${endState}`);
  }

  // ②′ 台词(2026-09-15):台词不进 prompt = 成片听不到剧本内容。
  //    Agnes video 2.5-flash 本身会出人声音轨,但"说什么"由 prompt 里的台词决定;
  //    这里同时声明"说出来、别画成文字",与末尾的无字幕护栏配套。
  const dialogue = dialogueInstruction(String(shot?.dialogue || ''), opts.knownNames || []);
  if (dialogue) parts.push(dialogue);

  // ③ 景别
  const stEn = SHOT_TYPE_EN[String(shot?.shot_type || '').trim()];
  if (stEn) parts.push(stEn);

  // ④ 运镜(运动语言的核心)
  //    缺失或「静止」且带 rhythm → 用 rhythm 默认运镜兜底(防死镜);
  //    已写有效运镜时不覆盖 LLM 选择。词表见 camera-motion.ts。
  const rawMotion = String(shot?.camera_motion || '').trim();
  const rhythmKey = String(shot?.rhythm || opts.rhythm || '').trim();
  let effectiveMotion = rawMotion;
  if (!rawMotion || rawMotion === '静止') {
    const fb = motionForRhythm(rhythmKey);
    if (fb && CAMERA_MOTION_EN[fb]) effectiveMotion = fb;
  }
  const cmEn = cameraMotionEnShared(effectiveMotion);
  if (cmEn) parts.push(cmEn);

  // ⑤ 多人物守卫(>1 人同框才追加);恰好 1 人 → 单人身份尾巴(镜内不许变性别/换人)
  const charCount = shotCharacterCount(shot, opts);
  if (charCount > 1) {
    parts.push(MULTI_CHARACTER_TAIL);
  } else if (charCount === 1) {
    parts.push(SINGLE_CHAR_IDENTITY_TAIL);
  }

  // ⑥ 全剧统一风格尾巴
  if (opts.styleTail && opts.styleTail.trim()) parts.push(opts.styleTail.trim());

  // ⑦ 真实性底线(固定)
  parts.push(REALISM_TAIL);

  // ⑧ 无字幕护栏(默认开;剧情字卡场景用 textOverlay:true 关闭)
  if (opts.textOverlay !== true) parts.push(NO_TEXT_TAIL);

  return parts.filter((p) => p && p.trim()).join(', ');
}

/** 运镜中文 → 英文(供测试/调试单独取用;实现走 camera-motion 单一词表) */
export function cameraMotionEn(motion: string): string {
  return cameraMotionEnShared(motion);
}

/** 景别中文 → 英文(实现走 camera-motion 单一词表) */
export function shotTypeEn(shotType: string): string {
  return shotTypeEnShared(shotType);
}
