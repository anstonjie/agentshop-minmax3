// ============================================================================
// camera-motion.ts —— 运镜中英词表 + rhythm→默认运镜 的单一来源(纯函数)
// ----------------------------------------------------------------------------
// 为什么单独成文件:此前 CAMERA_MOTION_EN 在 video-prompt.ts 与 keyframe-plan.ts
//   各抄一份,genStep4 只教「推拉摇跟移」—— 飞书《各种运镜提示词（待增加）》
//   约 38 条运镜与 rhythm 角色都没接上,分镜运镜长期同质化。
//
// 单一事实源纪律:
//   · video-prompt.cameraMotionEn / keyframe-plan 查表都必须走这里,禁止再抄第二份;
//   · 中文键与 genStep4 可输出的 camera_motion 字段对齐(短词,LLM 好选);
//   · 英文值只取运动核心短语,不带场景细节(场景归 description/storyBeat 管)。
//
// 关键帧安全子集 KEYFRAME_SAFE_MOTIONS:静图只能表达构图/机位,纯时间类
//   (焦点切换/穿拍/冲击变焦)写进文生图会误导,step5 关键帧应跳过。
//
// 方法论来源:飞书 wiki token G8vfdukQeogWHAxpj…《各种运镜提示词（待增加）》
//   (SSR 抽取 2026-09-24);场景用途说明映射到 rhythm 8 角色(reelbench)。
// ============================================================================

import { normalizeRhythm, type RhythmRole } from './rhythm-guard';

/**
 * 运镜(中文)→ 英文运动语言。
 * 旧 10 键保留原值(不回归);新键来自飞书文档归一,只留运动核心。
 */
export const CAMERA_MOTION_EN: Record<string, string> = {
  // ── 旧 10 键(genStep4 历史契约,值勿改) ──
  静止: 'static locked-off camera, no camera movement',
  推: 'slow smooth dolly-in, camera gradually pushes toward the subject',
  拉: 'slow smooth dolly-out, camera gradually pulls back to reveal the scene',
  摇: 'smooth horizontal panning shot',
  移: 'lateral tracking shot, camera glides sideways',
  跟: 'camera follows the moving subject, keeping it framed',
  升: 'slow crane-up / rising camera move',
  降: 'slow crane-down / descending camera move',
  甩: 'fast whip pan',
  环绕: 'orbiting camera circling around the subject',

  // ── 文档扩词(飞书 38 条归一,短键) ──
  快推: 'FAST DOLLY IN / rapid push toward the subject, aggressive urgent camera',
  过肩: 'over-the-shoulder shot from behind a foreground person framing the subject',
  俯拍: 'top-down high-angle shot looking down at the subject from above',
  仰拍: 'low-angle tilt up from below looking up at the subject',
  手持: 'handheld camera with natural documentary shake, uncontrolled practical feel',
  荷兰角: 'Dutch angle roll, camera tilted on its axis, unease and imbalance',
  冲击变焦: 'snap zoom / crash zoom straight into the subject, no smooth transition',
  焦点切换: 'rack focus / focus pull shifting attention from foreground to background',
  半环绕: 'half-orbit shot, camera arcs 180 degrees around the subject',
  第一人称: 'first-person POV camera advances with gentle walking sway',
  上帝视角: 'bird\'s-eye top-down rotating view, subject centered below',
  遮挡显露: 'lateral wipe reveal from behind an occluder, camera trucks sideways',
  穿拍: 'cinematic fly-through as the camera passes through a window or doorway',
  鱼眼: 'fisheye lens wide distortion, edges bowing outward, voyeur mood',
  摇臂升: 'crane up rising high-angle reveal, camera lifts above the subject',
  摇臂降: 'crane down descending onto the subject, landing into focus',
  FPV俯冲: 'aggressive FPV drone dive plunging toward the subject',
  无人机揭示: 'epic drone reveal rising to expose the full landscape and subject',
  弧形环绕: 'slow cinematic arc shot gliding along a curve around the subject',
  侧跟: 'parallel side-tracking camera trucks alongside the subject',
  引导跟: 'camera glides backward leading the subject, holding constant framing',
  光学推近: 'smooth optical zoom-in, lens magnifies while camera stays still',
  光学拉远: 'smooth optical zoom-out, wider field of view revealed',
  眩晕: 'dolly zoom (zolly): camera moves while zooming opposite, background warps',
  甩移: 'whip pan into a lateral truck, motion-blur transition into the new frame',
};

/**
 * 关键帧(静图)安全运镜:能表达构图/机位的进文生图;
 * 纯时间类运镜静图表达不了,写进去只会干扰,step5 应跳过。
 */
export const KEYFRAME_SAFE_MOTIONS: ReadonlySet<string> = new Set([
  '推', '拉', '摇', '移', '跟', '升', '降', '甩', '环绕',
  '快推', '过肩', '俯拍', '仰拍', '手持', '荷兰角',
  '半环绕', '第一人称', '上帝视角', '遮挡显露',
  '鱼眼', '摇臂升', '摇臂降', '弧形环绕', '侧跟', '引导跟',
  '光学推近', '光学拉远',
  // 刻意排除:焦点切换 / 穿拍 / 冲击变焦 / FPV俯冲 / 无人机揭示 / 眩晕 / 甩移
]);

/** 运镜中文 → 英文;未知返回空串(不产生 undefined)。 */
export function cameraMotionEn(motion: unknown): string {
  return CAMERA_MOTION_EN[String(motion ?? '').trim()] || '';
}

/**
 * 景别(中文)→ 英文镜头语言(单一来源;video-prompt 与 keyframe-plan 共用,
 * 之前各抄一份,值完全一致 —— 再抄第三份之前先看这里)。
 */
export const SHOT_TYPE_EN: Record<string, string> = {
  远景: 'extreme wide shot',
  全景: 'wide establishing shot',
  中景: 'medium shot',
  近景: 'close-up shot',
  特写: 'extreme close-up',
  空镜: 'empty scenic shot, no characters',
};

/** 景别中文 → 英文;未知返回空串 */
export function shotTypeEn(shotType: unknown): string {
  return SHOT_TYPE_EN[String(shotType ?? '').trim()] || '';
}

/**
 * rhythm 角色 → 默认运镜中文键。
 * 未知/空 rhythm 返回 ''(调用方保持原 camera_motion,不瞎覆盖)。
 * 默认绝不返回「静止」—— 静止是死镜风险,只有 LLM 显式写才用。
 */
const RHYTHM_DEFAULT_MOTION: Record<RhythmRole, string> = {
  hook: '快推',
  setup: '推',
  build: '移',
  beat: '快推',
  turn: '穿拍',
  payoff: '环绕',
  breath: '拉',
  close: '拉',
};

export function motionForRhythm(rhythm: unknown): string {
  const role = normalizeRhythm(rhythm);
  if (!role) return '';
  return RHYTHM_DEFAULT_MOTION[role] || '';
}

/**
 * genStep4 分镜 sys 用的运镜指南片段(拼进 open-montage 的 sys 提示)。
 * 含:旧优先词 + 文档扩词候选 + rhythm 配对 + 防静止。
 */
export function cameraMotionGuide(): string {
  const byCategory: Array<[string, string[]]> = [
    ['基础机位运动', ['推', '拉', '摇', '移', '跟', '升', '降', '甩', '环绕', '静止']],
    ['对话/构图', ['过肩', '侧跟', '引导跟', '弧形环绕', '半环绕']],
    ['揭示/转场', ['穿拍', '遮挡显露', '焦点切换', '甩移', '上帝视角', '俯拍', '仰拍']],
    ['情绪重音', ['快推', '冲击变焦', '眩晕', '荷兰角', '手持']],
    ['空间大场面', ['无人机揭示', 'FPV俯冲', '摇臂升', '摇臂降', '光学推近', '光学拉远', '第一人称', '鱼眼']],
  ];
  const lines = byCategory.map(([cat, keys]) => `  ${cat}: ${keys.join('/')}`).join('\n');
  const rhythmPairs = [
    'hook/beat → 快推|甩|冲击变焦',
    'setup → 推|过肩',
    'build → 移|跟|侧跟',
    'turn → 穿拍|遮挡显露|焦点切换|甩',
    'payoff → 环绕|快推|摇臂升',
    'breath/close → 拉|摇|光学拉远|俯拍',
  ].join('; ');
  return (
    `- camera_motion 从下列候选选(勿自造词):\n${lines}\n` +
    `- 优先使用 推/拉/摇/跟/移, 严禁过多使用"静止"(静止容易在视频模型中沦为无动效死镜)\n` +
    `- rhythm 与运镜配对(缺省时后端会按 rhythm 兜底): ${rhythmPairs}\n` +
    `- 特写/近景慎用无人机/FPV/上帝视角; 空间大场面才放开航拍类`
  );
}
