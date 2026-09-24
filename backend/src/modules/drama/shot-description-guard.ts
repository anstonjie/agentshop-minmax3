// ============================================================================
// shot-description-guard.ts —— P0-b 借 reelbench「画面描述要能拿去核对」的门
// ----------------------------------------------------------------------------
// reelbench 纪律:画面描述必须写"看得见的东西",空话(氛围感/高级感…)与废话开头
// ("这个镜头…")一律拦,两镜描述不许一字不差。咱们的 shot.description 是喂给视频模型
// 的视觉指令,写得空 → 生成保真度直接掉。这里做成纯函数校验,MVP 只出 warnings 不硬拦
// (与 P1-c 一致:先暴露,不打断生成)。
// ============================================================================

/** 空话词表(照搬 reelbench taxonomy.md 的中文空话词表,按短视频生成语境微调) */
export const EMPTY_PHRASES = [
  '氛围感', '高级感', '视觉冲击', '令人', '唯美', '美不胜收', '大气磅礴',
  '震撼人心', '画面感十足', '很美', '非常美', '精美绝伦', '赏心悦目', '引人入胜',
  '电影感', '质感拉满', '张力十足',
];

/** 废话开头(镜头表里每行都是镜头,不必再说"这个镜头") */
export const WASTE_PREFIXES = ['这个镜头', '本镜头', '本镜', '此镜头', '镜头中', '画面中我们'];

/**
 * 性别名词词表(2026-09-23 身份硬伤):description 写死"男人/女人"会与定妆图
 * 的性别直接冲突 —— 兜底/文生图路径下模型按文字画,同角色跨镜变性别。
 * 有参考图时文字与图打架也可能把脸带偏。只 warning 不硬拦(风格剧有合法用法)。
 */
export const GENDER_NOUNS = [
  '男人', '女人', '男子', '女子', '男孩', '女孩', '男性', '女性',
  '大叔', '大妈', '帅哥', '美女', '青年男', '青年女', '少年', '少女',
];

/** 中文画面描述最低字数(reelbench minFrameChars=12) */
export const MIN_DESC_CHARS = 12;

export interface ShotDescLike {
  idx?: number;
  description?: string;
}

export interface DescViolation {
  idx: number;
  reason: 'empty' | 'too_short' | 'waste_prefix' | 'duplicate' | 'gender_noun';
  detail: string;
}

/**
 * 校验一组镜头描述。返回违规清单(纯函数,不抛错)。
 * - empty:命中空话词表
 * - too_short:去空白后 < MIN_DESC_CHARS
 * - waste_prefix:以废话开头
 * - duplicate:与前面某镜描述一字不差(归一化空白后比较)
 * - gender_noun:写死性别名词,可能与定妆图/设定冲突(2026-09-23)
 */
export function checkShotDescriptions(shots: ShotDescLike[]): DescViolation[] {
  if (!Array.isArray(shots)) return [];
  const violations: DescViolation[] = [];
  const seen = new Map<string, number>(); // 归一化描述 → 首次出现的 idx

  for (const s of shots) {
    const idx = Number(s?.idx ?? 0);
    const raw = String(s?.description ?? '').trim();
    const norm = raw.replace(/\s+/g, '');

    if (!norm) {
      violations.push({ idx, reason: 'too_short', detail: '描述为空' });
      continue;
    }
    if (norm.length < MIN_DESC_CHARS) {
      violations.push({ idx, reason: 'too_short', detail: `描述仅 ${norm.length} 字(<${MIN_DESC_CHARS}),写不清画面` });
    }
    const hitEmpty = EMPTY_PHRASES.find((p) => raw.includes(p));
    if (hitEmpty) {
      violations.push({ idx, reason: 'empty', detail: `含空话「${hitEmpty}」,改成看得见的具体画面` });
    }
    const hitPrefix = WASTE_PREFIXES.find((p) => raw.startsWith(p));
    if (hitPrefix) {
      violations.push({ idx, reason: 'waste_prefix', detail: `以「${hitPrefix}」开头,直接写画面内容` });
    }
    const hitGender = GENDER_NOUNS.find((g) => raw.includes(g));
    if (hitGender) {
      violations.push({
        idx, reason: 'gender_noun',
        detail: `含性别名词「${hitGender}」,与定妆图性别可能冲突 —— 改用角色名或中性描述`,
      });
    }
    if (seen.has(norm)) {
      violations.push({ idx, reason: 'duplicate', detail: `与镜头 #${seen.get(norm)} 描述一字不差,写出机位/动作进度差别` });
    } else {
      seen.set(norm, idx);
    }
  }
  return violations;
}

/** 把违规清单压成给前端/日志看的 warning 文案(按 reason 聚合,避免刷屏)。 */
export function summarizeDescViolations(violations: DescViolation[]): string[] {
  if (!violations.length) return [];
  const byReason = new Map<string, number[]>();
  for (const v of violations) {
    const arr = byReason.get(v.reason) || [];
    arr.push(v.idx);
    byReason.set(v.reason, arr);
  }
  const label: Record<string, string> = {
    empty: '空话描述', too_short: '描述过短', waste_prefix: '废话开头', duplicate: '描述重复',
    gender_noun: '性别名词硬写',
  };
  return [...byReason.entries()].map(([reason, idxs]) => {
    const uniq = [...new Set(idxs)];
    return `${label[reason] || reason} ${uniq.length} 处(镜头 #${uniq.join(',#')})`;
  });
}
