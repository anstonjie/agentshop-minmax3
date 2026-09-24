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

/** 各类定妆图的画幅 —— 角色竖幅全身,场景/载具横幅,道具/服装方图 */
export const CONCEPT_SIZES = {
  character: '864x1152',
  location: '1280x720',
  prop: '1024x1024',
  wardrobe: '1024x1024',
  vehicle: '1280x720',
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

/**
 * 场景定妆负向词(2026-09-23 批5)。
 * 根因:场景参考图带路人会经图生图原样带进关键帧(资产参考图是身份/环境的
 * 锚,路人会被模型当成"这个场景就该有人"),空景约束必须正负两侧同时钉。
 */
export const LOCATION_NEGATIVE =
  'people, person, human, crowd, pedestrians, figures in the scene, characters, silhouettes of people, anyone';

export function buildScenePrompt(locDesc: string, style: string): string {
  return `${locDesc}, empty scene, no people, no pedestrians, no characters in frame,
scene concept art, environment design, wide establishing shot, ${style}`;
}

/**
 * 道具定妆负向词(2026-09-23 批5)。
 * 根因:"product shot" 语料常带手持/人手特写,道具卡里冒出半只手/一个人。
 */
export const PROP_NEGATIVE =
  'person, people, human, hands holding the object, hand, fingers, face, head, model, anyone';

export function buildPropPrompt(propDesc: string, style: string): string {
  return `${propDesc}, prop design, object concept art, isolated object on white background,
centered on white background, clean background,
product shot, not held by any hands, no people, no hands in frame, ${style}`;
}

/**
 * 载具定妆提示词(2026-09-23 批5)。
 * 根因:载具之前落道具兜底 —— 方图 + "prop design" 语料,且不带任何
 * 人物排除词,画出来常带司机/乘客(载具参考图再把这些人在关键帧里锚回去)。
 */
export const VEHICLE_NEGATIVE =
  'driver, passenger, people, person, human, face, hands on the wheel, pedestrians, crowd, anyone inside or around the vehicle';

export function buildVehiclePrompt(vehicleDesc: string, style: string): string {
  return `${vehicleDesc}, vehicle design sheet, isolated vehicle on white background,
no driver, no passengers, no people inside or around the vehicle, empty vehicle,
side three-quarter view, transport concept art, product shot of the vehicle alone,
clean background, highly detailed, professional concept art, sharp focus,
single subject centered in frame, ${style}`;
}

/**
 * 服装定妆提示词(2026-09-23)。
 * 根因:服装 kind 之前落到道具兜底 buildPropPrompt —— "product shot" 语料里
 * 服装品类几乎全是模特上身图,加上 descVisual 常写"某某穿的衬衫",
 * 于是资产库服装卡里出现人的头像(应只有衣服本身)。
 * 语义:平铺或隐形模特(ghost mannequin)空心衣形,明确排除人物/人脸/穿着者;
 * 负向词同步列具体排除项(与角色四视图同一纪律:抽象负向词压不住脸部先验)。
 */
export const WARDROBE_NEGATIVE =
  'person, people, human, model wearing clothes, man, woman, face, head, hair, hands, arms, legs, body, portrait, character, anyone wearing the garment';

export function buildWardrobePrompt(wardrobeDesc: string, style: string): string {
  return `clothing only, garment without any person, ${wardrobeDesc},
wardrobe concept art, clothing design sheet, product shot of the garment alone,
laid flat or on invisible ghost mannequin (empty garment, no visible person),
no human, no model, no face, no head, no hands, not worn by anyone,
centered on white background, clean background,
highly detailed, professional concept art, sharp focus, single subject centered in frame,
${style}`;
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
      negative: LOCATION_NEGATIVE,
      size: CONCEPT_SIZES.location,
    }];
  }
  // 2026-09-23:服装必须走专用提示词 —— 落道具兜底会画出"模特上身图"(见 buildWardrobePrompt 注释)
  if (kind === 'wardrobe') {
    const desc = item.description || item.appearance || item.name || '';
    return [{
      angle: '主视图',
      prompt: buildWardrobePrompt(desc, style),
      negative: WARDROBE_NEGATIVE,
      size: CONCEPT_SIZES.wardrobe,
    }];
  }
  // 2026-09-23 批5:载具走专用横幅提示词(在道具兜底之前),禁驾驶员/乘客
  if (kind === 'vehicle') {
    const desc = item.description || item.appearance || item.name || '';
    return [{
      angle: '主视图',
      prompt: buildVehiclePrompt(desc, style),
      negative: VEHICLE_NEGATIVE,
      size: CONCEPT_SIZES.vehicle,
    }];
  }
  const desc = item.description || item.name || '';
  return [{
    angle: '主视图',
    prompt: buildPropPrompt(desc, style),
    negative: PROP_NEGATIVE,
    size: CONCEPT_SIZES.prop,
  }];
}

/**
 * 定妆 refs 的**按位回填计划**(2026-09-23 批5)。
 *
 * 根因:旧实现在一个循环里先 push 复用的旧图、再在另一个循环里 push 并行
 * 生成的新图 —— 复用与待生成交错时 refs 顺序 ≠ shots 顺序。下游 QC 用
 * shots[qcIdx] 取提示词、portraitFileTag(qcIdx, ...) 取文件名,索引一错位,
 * 质检重画就用错提示词/覆盖错文件(纯函数化以便单测钉住顺序不变量)。
 *
 * 返回:slots 与 shots 逐位对齐(复用位填 ref,待生成位为 null);
 * pending 带 idx/tag/prev,生成完成后按 idx 写回 slots。
 */
export function planPortraitGeneration(
  shots: Array<{ angle: string }>,
  prevRefs: any[],
  force: boolean,
  now: number = Date.now(),
): {
  slots: Array<any | null>;
  pending: Array<{ idx: number; sh: any; tag: string; prev: any }>;
} {
  const slots: Array<any | null> = shots.map(() => null);
  const pending: Array<{ idx: number; sh: any; tag: string; prev: any }> = [];
  const prev = Array.isArray(prevRefs) ? prevRefs : [];
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    const tag = portraitFileTag(i, sh.angle, force, now);
    const hit = prev.find((r) => String(r?.angle) === sh.angle);
    const prevUsable = hit && hit.url && hit.alive !== false;
    if (!force && prevUsable) {
      slots[i] = { ...hit, angle: sh.angle, canonical: false };
    } else {
      pending.push({ idx: i, sh, tag, prev: hit || null });
    }
  }
  return { slots, pending };
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
