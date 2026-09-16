// ============================================================================
// dialogue-sanitizer 单测 —— 钉死「字幕脏文本」的 6 种泄漏模式 + 丢台词 bug
// ----------------------------------------------------------------------------
// 证据来自本机 DB 10 部剧 / 51 集真实 dialogue 原文。没有这套测试，
// 任何人"顺手把净化器简化掉"就会让「(咬牙)」「(旁白)」「苏微无声的口型解析」
// 重新爬回字幕和配音。断言的是行为（speaker/text/kind/剥掉了什么），不是逐字文案。
// ============================================================================
import { sanitizeDialogue } from './dialogue-sanitizer';

// 真实剧目的角色名表（来自 DB 样本）
const NAMES = ['陈明', '林岩', '苏微', '林雅', '陈刚', '张晖', '智核-AI', '洛烛', '苏清歌', '秦烈', '李明'];

describe('sanitizeDialogue —— 6 种泄漏模式（DB 真实样本）', () => {
  it('① body 里的表演括注要剥掉，speaker 保留', () => {
    const r = sanitizeDialogue('陈明:(咬牙)稳住...时间核...别让它碎了...', NAMES);
    expect(r.speaker).toBe('陈明');
    expect(r.text).toBe('稳住...时间核...别让它碎了...');
    expect(r.text).not.toContain('咬牙');
    expect(r.performance).toContain('咬牙');
    expect(r.kind).toBe('speech');
  });

  it('② 开头「(人名+表演)」前缀剥掉，speaker 仍记为人名', () => {
    const r = sanitizeDialogue('(陈明低沉地喘息) 这是……第几次循环了？为什么空气里全是铁锈味。', NAMES);
    expect(r.speaker).toBe('陈明');
    expect(r.text).toBe('这是……第几次循环了？为什么空气里全是铁锈味。');
    expect(r.text).not.toContain('陈明');
    expect(r.text).not.toContain('喘息');
    expect(r.performance.join('')).toContain('低沉地喘息');
  });

  it('③ 开头「(人名)」纯人名前缀剥掉', () => {
    const r = sanitizeDialogue('(陈明) 空间坐标偏移严重。', NAMES);
    expect(r.speaker).toBe('陈明');
    expect(r.text).toBe('空间坐标偏移严重。');
    expect(r.text).not.toContain('(陈明)');
  });

  it('④「(旁白)」标记剥掉，kind 判 voiceover，正文不含「旁白」', () => {
    const r = sanitizeDialogue('(旁白) 他的视线无法控制地被那道影子吸引。', NAMES);
    expect(r.kind).toBe('voiceover');
    expect(r.text).toBe('他的视线无法控制地被那道影子吸引。');
    expect(r.text).not.toContain('旁白');
  });

  it('⑤ 括注内含冒号不能被误判成 speaker（「苏微无声的口型解析」不上屏）', () => {
    const r = sanitizeDialogue("(苏微无声的口型解析: '去... 中心... 锚点...')", NAMES);
    expect(r.speaker).not.toBe('苏微无声的口型解析');
    expect(r.text).not.toContain('口型解析');
    // 整条括注、无台词正文 → 归 ambient，不上屏
    expect(r.kind).toBe('ambient');
  });

  it('⑥ 一镜多说话人：第二个名字不能夹在主段正文里', () => {
    const r = sanitizeDialogue('张晖:"按住伤口！别松手！"陈刚:"该死……这地方怎么全是它们！"', NAMES);
    expect(r.speaker).toBe('张晖');
    expect(r.text).not.toContain('陈刚');
    expect(r.extraSpeakers.some((x) => x.speaker === '陈刚')).toBe(true);
  });

  it('⑦ `/` 分隔的音效描述归 ambient，真台词不被误杀（修丢台词 bug）', () => {
    const r = sanitizeDialogue('陈明：别动！我感觉那股力量在往我身体里钻，好冷。/（只有电流滋滋声和风声）', NAMES);
    expect(r.speaker).toBe('陈明');
    expect(r.text).toContain('别动！');
    expect(r.text).not.toContain('电流');
    expect(r.text).not.toContain('只有');
    expect(r.ambient.join('')).toContain('电流');
    expect(r.kind).toBe('speech'); // 关键：不再被整条误判成 ambient
  });

  it('⑧ body 尾巴的表演提示剥掉', () => {
    const r = sanitizeDialogue('林雅:这是...备用通道的缓存文件？(语气疑惑)', NAMES);
    expect(r.speaker).toBe('林雅');
    expect(r.text).toBe('这是...备用通道的缓存文件？');
    expect(r.performance).toContain('语气疑惑');
  });

  it('⑨ body 尾巴的音效描述剥掉', () => {
    const r = sanitizeDialogue('陈刚:滚开！别碰她！(沉闷的金属撞击声与力场嗡嗡声)', NAMES);
    expect(r.text).toBe('滚开！别碰她！');
    expect(r.ambient.join('')).toContain('金属撞击');
  });

  it('⑩「××地说：」动词尾巴剥掉（有名单时认出名字）', () => {
    const r = sanitizeDialogue('李明愤怒地说：你怎么敢！', NAMES);
    expect(r.speaker).toBe('李明');
    expect(r.text).toBe('你怎么敢！');
  });

  it('⑪ 前置情绪修饰剥掉（有名单时后缀匹配）', () => {
    const r = sanitizeDialogue('愤怒的李明：你怎么敢！', NAMES);
    expect(r.speaker).toBe('李明');
    expect(r.text).toBe('你怎么敢！');
    expect(r.performance.join('')).toContain('愤怒');
  });

  it('⑫「陈明：（旁白）这就是守恒定律」—— body 开头的旁白标记剥掉', () => {
    const r = sanitizeDialogue('陈明：（旁白）这就是守恒定律……他在吸我的记忆填补裂缝', NAMES);
    expect(r.text).not.toContain('旁白');
    expect(r.text).toContain('这就是守恒定律');
  });
});

describe('sanitizeDialogue —— 向后兼容（旧 parseDialogueLine 已测试的行为不能退）', () => {
  it('干净的「角色名：台词」不受影响', () => {
    const r = sanitizeDialogue('洛烛：白帝最后通牒已到。', NAMES);
    expect(r.speaker).toBe('洛烛');
    expect(r.kind).toBe('speech');
    expect(r.text).toBe('白帝最后通牒已到。');
    expect(r.performance).toHaveLength(0);
  });

  it('说话人带括注「洛烛（冷笑）：…」只取名字', () => {
    expect(sanitizeDialogue('洛烛（冷笑）：你也配？', NAMES).speaker).toBe('洛烛');
  });

  it('半角冒号同样识别', () => {
    expect(sanitizeDialogue('秦烈:果然是你。', NAMES).speaker).toBe('秦烈');
  });

  it('括号表演提示不当作说话人："(少女轻声) 老板，还没睡啊？"', () => {
    const r = sanitizeDialogue('(少女轻声) 老板，还没睡啊？', NAMES);
    expect(r.speaker).toBeNull();
    expect(r.text).toContain('老板，还没睡啊');
    expect(r.kind).toBe('speech');
  });

  it('无名单时「…低声道：」动词结尾不敢当名字（speaker=null，保持旧行为）', () => {
    const r = sanitizeDialogue('秦烈低声道：果然…是我身边人。');
    expect(r.speaker).toBeNull();
    // 但正文仍取冒号后的 body，不把「秦烈低声道」整条上屏
    expect(r.text).toBe('果然…是我身边人。');
  });

  it('有名单时「秦烈低声道：」能认出秦烈', () => {
    const r = sanitizeDialogue('秦烈低声道：果然…是我身边人。', NAMES);
    expect(r.speaker).toBe('秦烈');
    expect(r.text).toBe('果然…是我身边人。');
  });

  it('旁白/画外音归 voiceover 类', () => {
    expect(sanitizeDialogue('旁白：三十年前的那场大雪。', NAMES).kind).toBe('voiceover');
  });

  it('纯音效描述判 ambient（不上屏）', () => {
    expect(sanitizeDialogue('(叮咚——门铃声)', NAMES).kind).toBe('ambient');
    expect(sanitizeDialogue('(脚步声，关门的咔哒声)', NAMES).kind).toBe('ambient');
    expect(sanitizeDialogue('(无对白，只有罗盘指针摩擦的尖锐声)', NAMES).kind).toBe('ambient');
  });

  it('「（无）」判 ambient', () => {
    expect(sanitizeDialogue('（无）', NAMES).kind).toBe('ambient');
  });

  it('空台词 → none', () => {
    expect(sanitizeDialogue('', NAMES).kind).toBe('none');
    expect(sanitizeDialogue('   ', NAMES).kind).toBe('none');
  });

  it('「智核-AI:检测到逻辑悖论」带连字符的名字正常识别', () => {
    const r = sanitizeDialogue('智核-AI:检测到逻辑悖论...错误代码-深渊-7...', NAMES);
    expect(r.speaker).toBe('智核-AI');
    expect(r.text).toContain('检测到逻辑悖论');
  });
});

describe('sanitizeDialogue —— 净化不丢信息（performance/ambient 供视频模型用）', () => {
  it('表演提示进 performance，供配音做情绪指令', () => {
    const r = sanitizeDialogue('陈明:(声音颤抖)能量...在逆流...', NAMES);
    expect(r.performance).toContain('声音颤抖');
    expect(r.text).toBe('能量...在逆流...');
  });

  it('音效描述进 ambient，供视频模型做环境音指令', () => {
    const r = sanitizeDialogue('林岩:咳咳...只有这里了...(喘气声)', NAMES);
    expect(r.ambient.length + r.performance.length).toBeGreaterThan(0);
    expect(r.text).not.toContain('喘气声');
  });

  it('unknown 名字（不在名单）的前置修饰用通配规则剥「××的」', () => {
    const r = sanitizeDialogue('愤怒的路人甲：走开！');
    expect(r.text).toBe('走开！');
    // 无名单时「愤怒的路人甲」整体可能留在 speaker，但正文干净
    expect(r.text).not.toContain('愤怒');
  });

  it('④½ 无括号「人名+表情副词」前缀:人名与副词不上屏(2026-09-16 用户实测格式)', () => {
    const r = sanitizeDialogue('陈明愤怒地你怎么能这样', NAMES);
    expect(r.speaker).toBe('陈明');
    expect(r.text).toBe('你怎么能这样');
    expect(r.performance).toContain('愤怒地');
  });

  it('④½ 无括号「人名+说话动词」前缀同样剥动词尾巴', () => {
    const r = sanitizeDialogue('秦烈冷冷说道走吧别回头', NAMES);
    expect(r.speaker).toBe('秦烈');
    expect(r.text).toBe('走吧别回头');
    expect(r.performance).toContain('冷冷说道');
  });

  it('④½ 无名单时保守:不瞎剥,维持旧行为(整条进正文)', () => {
    const r = sanitizeDialogue('陈明愤怒地你怎么能这样');
    expect(r.text).toBe('陈明愤怒地你怎么能这样');
  });
});

describe('⑦½ 行内残留清理(2026-09-16 端到端验收补)', () => {
  it('孤立「。:」脏冒号收掉(无名单也生效)', () => {
    // 前缀超 14 字 → ⑤ 的「名:台词」规则不接管,残留冒号交给 ⑦½ 收
    const r = sanitizeDialogue(
      '这封邮件里藏着一个隐藏进程，它的底层代码跟天枢的自毁程序完全一样。:这是一个倒计时');
    expect(r.text).toBe('这封邮件里藏着一个隐藏进程，它的底层代码跟天枢的自毁程序完全一样。这是一个倒计时');
  });

  it('行内「。名：」在拆段规则漏掉时被兜底剥净', () => {
    // 陈明在 NAMES 里;⑦ 拆段吃到第二个冒号前,⑦½ 兜底把行内「。名：」收干净
    const r = sanitizeDialogue('Ghost程序在修改日志。陈明：这个:比创始人还高', NAMES);
    expect(r.text).not.toContain('陈明：');
    expect(r.text).toContain('比创始人还高');
  });
});
