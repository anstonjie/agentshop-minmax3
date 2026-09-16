// ============================================================================
// concept-art.ts —— 资产定妆提示词的单一来源
// ----------------------------------------------------------------------------
// 为什么单独成文件:角色四视图的提示词(v3)是踩了三个坑调出来的 ——
//   ① "neutral T-pose" 会被模型当成正面,背面/侧面全跑偏;
//   ② "character turnaround" 会被理解成多人合影;
//   ③ 抽象负向词压不住脸部先验,要列具体面部特征。
// 这套规则一旦有两份实现,迟早一份被改另一份没改,画出来的角色就飘。
// 所以:open-montage 的 step3 与剧级资产定妆 **共用这里的构造函数**。
// 改动请同步更新 concept-art.spec.ts 的结构断言。
// ============================================================================

/** 一个视角的完整定义 */
export interface AngleConfig {
  label: string;   // 中文角度名(存进 refs.angle,前端展示)
  cn: string;      // 中文角度语义
  en: string;      // 英文强权重角度关键词(前置)
  pose: string;    // 该角度独立姿态(T-pose 只给正面)
  negative: string;// 反向约束
}

/**
 * 四视图配置。顺序即 refs 顺序,首项(正面)默认作为 canonical 参考图。
 */
export const ANGLE_CONFIGS: AngleConfig[] = [
  {
    label: '正面',
    cn: '正面全身视角',
    en: '(front view:1.3), (facing the camera directly:1.2), full face visible, front-facing character, looking at viewer',
    pose: 'standing in neutral T-pose, arms extended sideways horizontally, palms forward, character reference stance',
    negative: 'side profile, back of head, from behind, looking away, back view',
  },
  {
    label: '侧面',
    cn: '侧面全身视角(90度侧脸)',
    en: '(side profile view:1.4), (90 degree side angle:1.2), profile shot, character facing sideways, only one side of face visible, full body side profile, looking forward (sideways from camera POV)',
    pose: 'standing upright, arms relaxed hanging at sides, feet shoulder-width apart, natural standing posture, NOT T-pose, NOT arms extended sideways',
    negative: 'front view, facing camera, back view, from behind, T-pose, arms extended sideways, two characters, multiple people, looking at viewer',
  },
  {
    label: '背面',
    cn: '背面全身视角(完全背对镜头,只看到后脑勺和后背)',
    en: '(back view:1.5), (rear view:1.4), (viewed from behind:1.4), character facing AWAY from camera, ONLY back of head and back of body visible, NO face, NO eyes, NO mouth, NO nose, NO front of body, full body seen from behind, hair visible from back',
    pose: 'standing upright, arms relaxed hanging at sides, feet shoulder-width apart, back of head facing camera, NOT T-pose, NOT arms extended sideways',
    negative: 'front view, facing camera, face visible, side profile, T-pose, arms extended sideways, two characters, multiple people, looking at viewer, eyes, mouth, nose, portrait view',
  },
  {
    label: '全身姿势',
    cn: '动态全身姿势(3/4 角度,具体动作)',
    en: '(three-quarter view:1.2), (3/4 angle:1.2), dynamic action pose, full body character in dramatic motion, mid-action stance, one foot forward as if walking or stepping forward, arms in motion (one arm forward, one arm back), NOT static, NOT T-pose',
    pose: 'dynamic walking or action pose, weight shifted to one leg, other leg stepping forward, arms naturally positioned for motion, conveying movement and energy',
    negative: 'static pose, T-pose, arms straight out to sides, robot pose, standing still, facing camera directly, two characters, multiple people, portrait view, looking at viewer',
  },
];

/** 各类定妆图的画幅 —— 角色竖幅全身,场景横幅,道具方图 */
export const CONCEPT_SIZES = {
  character: '864x1152',
  location: '1280x720',
  prop: '1024x1024',
} as const;

/** 单个角色四视图提示词(角度关键词前置,绕开角色描述带来的脸部先验) */
export function buildCharacterViewPrompt(
  charDesc: string, ac: AngleConfig, style: string,
): string {
  return `${ac.en}, single character only, no other people, no crowd,
character reference design,
${charDesc},
${ac.cn},
${ac.pose},
full body from head to toe visible,
white background, clean background,
character concept art, character design sheet,
${style},
highly detailed, professional concept art, sharp focus, single subject centered in frame`;
}

export function buildScenePrompt(locDesc: string, style: string): string {
  return `${locDesc}, scene concept art, environment design, wide establishing shot, ${style}`;
}

export function buildPropPrompt(propDesc: string, style: string): string {
  return `${propDesc}, prop design, object concept art, centered on white background, product shot, ${style}`;
}

/** 一张待生成定妆图的完整计划 */
export interface ConceptShot {
  angle: string;
  prompt: string;
  negative: string;
  size: string;
}

/**
 * 2026-09-16(批4):定妆参考图提示词的**动作子句剥离守卫**。
 *
 * 根因(实测 drama77 林一,三轮 force 重画全坏):descVisual 里抄了小说原句
 * 「但双手敲击键盘时却异常稳定」,与参考图姿态指令(T-pose 双臂平展 / 放松垂放)
 * 自相矛盾 —— 模型只能画出"平展的双臂 + 第三只敲键盘的手"+ 悬空键盘。
 * QC 门能标出坏图但重画永远修不好,因为每轮都用同一份矛盾提示词。
 *
 * 守卫语义:只剥「手 + 动作动词」子句(外貌描述保留),剥过则补一句
 * "双手自然放松不持物" 抵消 hallucination。纯函数,可单测。
 */
const HAND_ACTION_RE =
  /[^，。；;!！?？\n]*(?:双手|单手|两手|左手|右手)[^，。；;!！?？\n]{0,16}(?:敲|握|持|拿|抱|举|提|扶|操作|按|端|拎|牵|推|拉)[^，。；;!！?？\n]*/g;

export function stripActionForRefSheet(desc: string): { text: string; stripped: boolean } {
  const raw = String(desc || '');
  // 注意:不能用 HAND_ACTION_RE.test() —— /g 正则的 test 会推进 lastIndex,
  // 早退路径会把状态留给下一次调用(match 全局匹配无此副作用)
  const stripped = (raw.match(HAND_ACTION_RE) || []).length > 0;
  if (!stripped) return { text: raw, stripped: false };
  const cleaned = raw
    .replace(HAND_ACTION_RE, '')
    .replace(/([，,；;])\s*([。！？])/g, '$2')
    .replace(/[，,；;]{2,}/g, '，')
    .replace(/^[，,；;、\s]+|[，,；;、\s]+$/g, '');
  const text = cleaned
    ? `${cleaned},双手自然放松垂放或张开,不持任何物品`
    : '双手自然放松垂放或张开,不持任何物品';
  return { text, stripped: true };
}

/**
 * 「这个资产需要哪几张图」的唯一答案。
 * kind 未识别时按道具处理(方图单张),避免新类别接入时静默产 0 张图。
 */
export function planAssetShots(
  kind: string,
  item: { name?: string; appearance?: string; description?: string },
  style: string,
): ConceptShot[] {
  if (kind === 'character') {
    // 2026-09-16(批4):参考图是"长相档案"不是"剧照" —— 剥掉手部动作子句,
    //   否则与 T-pose/放松姿态指令打架必出多手坏图(林一三手键盘实测)
    const desc = stripActionForRefSheet(
      item.appearance || item.description || item.name || '',
    ).text;
    return ANGLE_CONFIGS.map((ac) => ({
      angle: ac.label,
      prompt: buildCharacterViewPrompt(desc, ac, style),
      negative: ac.negative,
      size: CONCEPT_SIZES.character,
    }));
  }
  if (kind === 'location') {
    const desc = item.description || item.name || '';
    return [{
      angle: '全景',
      prompt: buildScenePrompt(desc, style),
      negative: '',
      size: CONCEPT_SIZES.location,
    }];
  }
  const desc = item.description || item.name || '';
  return [{
    angle: '主视图',
    prompt: buildPropPrompt(desc, style),
    negative: '',
    size: CONCEPT_SIZES.prop,
  }];
}

/** 落地文件名标签:角度可能含中文/括号,统一压成安全片段 */
export function refFileTag(index: number, angle: string): string {
  const safe = String(angle || '').replace(/[^\w\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '');
  return `${index + 1}-${safe || 'ref'}`;
}

/**
 * 定妆落盘文件名。
 *   · 增量补画 → 稳定的角度名(同一角度重补仍指向同一路径,便于追溯)
 *   · 强制重画 → 必须追加时间戳换名:同名覆盖会让 URL 不变,
 *     前端与浏览器缓存会继续显示旧图,用户以为"重画没生效"。
 * 做成纯函数是为了可单测 —— 不必花真实生成配额去验证一条命名规则。
 */
export function portraitFileTag(
  index: number, angle: string, force: boolean, now: number = Date.now(),
): string {
  const base = refFileTag(index, angle);
  return force ? `${base}-${now}` : base;
}
