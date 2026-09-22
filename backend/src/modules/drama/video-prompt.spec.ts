// ============================================================================
// video-prompt 单测 —— 钉住「运动语言」提示词的结构不变量
// ----------------------------------------------------------------------------
// 这套规则是踩坑调出来的(分镜 description 直接丢给视频模型 → 人物原地漂移/
// 镜头无故跳变)。没有测试的话,任何人"顺手优化一下"就能把调优悄悄退回去。
// 这里断言结构,不是逐字节文案。
// ============================================================================
import { buildShotVideoPrompt, cameraMotionEn, shotCharacterCount, shotTypeEn } from './video-prompt';

describe('buildShotVideoPrompt 运动语言', () => {
  it('运镜中文映射为英文强权重运动词', () => {
    const p = buildShotVideoPrompt({ description: '角色走向窗边', camera_motion: '推' });
    expect(p).toContain('dolly-in');
    expect(cameraMotionEn('推')).toContain('dolly-in');
    expect(cameraMotionEn('拉')).toContain('dolly-out');
    expect(cameraMotionEn('跟')).toContain('follows');
    expect(cameraMotionEn('静止')).toContain('static locked-off');
    expect(cameraMotionEn('环绕')).toContain('orbiting');
  });

  it('景别中文映射为英文镜头语言', () => {
    const p = buildShotVideoPrompt({ description: '街景', shot_type: '特写' });
    expect(p).toContain('extreme close-up');
    expect(shotTypeEn('远景')).toContain('extreme wide');
    expect(shotTypeEn('中景')).toContain('medium shot');
    expect(shotTypeEn('空镜')).toContain('no characters');
  });

  it('固定追加真实性底线词(压制 morphing/flicker/跳切)', () => {
    const p = buildShotVideoPrompt({ description: '任意画面' });
    expect(p).toContain('smooth natural motion');
    expect(p).toContain('physically plausible');
    expect(p).toContain('no morphing');
    expect(p).toContain('no flickering');
    expect(p).toContain('no sudden cuts');
    expect(p).toContain('temporal consistency');
  });

  it('未知运镜/景别不产生空段或 undefined', () => {
    const p = buildShotVideoPrompt({ description: '画面', camera_motion: '火星运镜', shot_type: '未知景别' });
    expect(p).not.toContain('undefined');
    expect(p).not.toMatch(/,\s*,/);
    expect(p).toContain('smooth natural motion');
  });

  it('description 为空时回退 fallback,仍带运动底线词', () => {
    const p = buildShotVideoPrompt({ } as any, { fallback: '关键帧兜底描述' });
    expect(p).toContain('关键帧兜底描述');
    expect(p).toContain('smooth natural motion');
  });

  it('description 与 fallback 都为空时仍有景别/运镜/底线(不返回空串)', () => {
    const p = buildShotVideoPrompt({ shot_type: '中景', camera_motion: '摇' });
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain('medium shot');
    expect(p).toContain('panning');
  });

  it('styleTail 注入全剧统一风格', () => {
    const p = buildShotVideoPrompt(
      { description: '画面' },
      { styleTail: '冷色调胶片质感' },
    );
    expect(p).toContain('冷色调胶片质感');
  });

  it('referenceMode 带图 → 用 <Picture 1> 锁定首帧与角色', () => {
    const p = buildShotVideoPrompt(
      { description: '画面' },
      { referenceMode: true, refImageCount: 1, refAudioCount: 0 },
    );
    expect(p).toContain('<Picture 1>');
    expect(p).toContain('starting frame');
  });

  it('referenceMode 带音频 → 用 <Audio 1> 对齐节奏氛围', () => {
    const p = buildShotVideoPrompt(
      { description: '画面' },
      { referenceMode: true, refImageCount: 1, refAudioCount: 1 },
    );
    expect(p).toContain('<Audio 1>');
    expect(p).toContain('rhythm');
  });

  it('referenceMode 但素材数为 0 → 不产生空的 <Picture>/<Audio> 引用', () => {
    const p = buildShotVideoPrompt(
      { description: '画面' },
      { referenceMode: true, refImageCount: 0, refAudioCount: 0 },
    );
    expect(p).not.toContain('<Picture');
    expect(p).not.toContain('<Audio');
  });

  it('铁律:不复述人物长相 —— 输出不含 face/hairstyle/wardrobe 等外貌词', () => {
    // 图生视频下首帧锁定人脸,prompt 写外貌 = 两个矛盾信号 → 换脸。
    // 这里保证构造器自身不会引入外貌词(description 由上游禁写长相)。
    const p = buildShotVideoPrompt(
      { description: '角色走向窗边', shot_type: '近景', camera_motion: '跟' },
      { styleTail: '电影质感' },
    );
    expect(p).not.toMatch(/hairstyle|wardrobe|facial features|same face/i);
  });
});

// ============================================================================
// 2026-09-14 增补(drama-skills 方法论):多人物守卫 / 交接 / 起止状态 / 无字幕
// ----------------------------------------------------------------------------
// 跨镜穿帮多数不是脸变了,是身份融合、手部持物漂移、视线断裂 —— 这些要在
// 文字端显式声明。以下断言锁住四个新维度的行为边界。
// ============================================================================

describe('buildShotVideoPrompt 多人物与状态链(2026-09-14)', () => {
  it('characters > 1 人 → 追加多人物守卫(身份区隔/手部/持物/视线)', () => {
    const p = buildShotVideoPrompt({
      description: '两人在餐桌对坐',
      characters: ['char_1', 'char_2'],
    });
    expect(p).toContain('identity blending');
    expect(p).toContain('correct hand and finger count');
    expect(p).toContain('held props stay stable');
    expect(p).toContain('eyelines');
  });

  it('单人或无 characters → 不追加多人物守卫(不白白稀释 prompt)', () => {
    const solo = buildShotVideoPrompt({ description: '一人独行', characters: ['char_1'] });
    expect(solo).not.toContain('identity blending');
    const none = buildShotVideoPrompt({ description: '空镜街景' });
    expect(none).not.toContain('identity blending');
  });

  it('characterCount 选项兜底(characters 数组缺失时按数字触发)', () => {
    const p = buildShotVideoPrompt({ description: '对峙' }, { characterCount: 3 });
    expect(p).toContain('identity blending');
  });

  it('shotCharacterCount 忽略空元素/空串,数组优先于选项', () => {
    expect(shotCharacterCount({ characters: ['a', '', null as any, 'b'] })).toBe(2);
    expect(shotCharacterCount({}, { characterCount: 2.7 })).toBe(2);
    expect(shotCharacterCount({})).toBe(0);
  });

  it('handoff 原样进 prompt(动作/持物/视线交接,中文不翻译)', () => {
    const p = buildShotVideoPrompt({
      description: '递出文件',
      handoff: 'A 把文件递给 B,B 的视线从桌面移到 A 脸上',
    });
    expect(p).toContain('A 把文件递给 B,B 的视线从桌面移到 A 脸上');
  });

  it('start_state:非 reference 模式进 prompt,reference 模式刻意跳过(起点归首帧图)', () => {
    const bare = buildShotVideoPrompt({
      description: '画面',
      start_state: 'B 低头合着文件夹坐在桌前',
    });
    expect(bare).toContain('begin exactly from this visible state');
    expect(bare).toContain('B 低头合着文件夹坐在桌前');

    const referenced = buildShotVideoPrompt(
      { description: '画面', start_state: 'B 低头合着文件夹坐在桌前' },
      { referenceMode: true, refImageCount: 1 },
    );
    expect(referenced).not.toContain('begin exactly from');
    expect(referenced).not.toContain('B 低头合着文件夹');
  });

  it('end_state 始终进 prompt(下一镜从这里继续,含 reference 模式)', () => {
    for (const opts of [{}, { referenceMode: true, refImageCount: 1 }]) {
      const p = buildShotVideoPrompt(
        { description: '画面', end_state: 'B 抬头看向门口' },
        opts,
      );
      expect(p).toContain('end at this visible state');
      expect(p).toContain('B 抬头看向门口');
    }
  });

  it('无字幕护栏默认追加;textOverlay:true 时关闭(剧情字卡场景)', () => {
    const def = buildShotVideoPrompt({ description: '画面' });
    expect(def).toContain('no subtitles');
    expect(def).toContain('no dialogue text overlays');

    const withText = buildShotVideoPrompt({ description: '黑屏字卡' }, { textOverlay: true });
    expect(withText).not.toContain('no subtitles');
  });

  it('状态链齐全时的完整顺序:主体 → 状态链 → 景别 → 运镜 → 多人守卫 → 风格 → 底线 → 无字幕', () => {
    const p = buildShotVideoPrompt(
      {
        description: '两人在餐桌对坐',
        characters: ['char_1', 'char_2'],
        handoff: 'A 把文件推过桌面',
        end_state: 'B 拿起文件',
        shot_type: '中景',
        camera_motion: '推',
      },
      { styleTail: '冷色调' },
    );
    const idx = (s: string) => p.indexOf(s);
    expect(idx('两人在餐桌对坐')).toBeLessThan(idx('A 把文件推过桌面'));
    expect(idx('A 把文件推过桌面')).toBeLessThan(idx('end at this visible state'));
    expect(idx('medium shot')).toBeLessThan(idx('dolly-in'));
    expect(idx('dolly-in')).toBeLessThan(idx('identity blending'));
    expect(idx('identity blending')).toBeLessThan(idx('冷色调'));
    expect(idx('冷色调')).toBeLessThan(idx('smooth natural motion'));
    expect(idx('smooth natural motion')).toBeLessThan(idx('no subtitles'));
  });

  it('多人物守卫不违反外貌铁律(不含 hairstyle/wardrobe/facial features/same face)', () => {
    const p = buildShotVideoPrompt({
      description: '三人争吵',
      characters: ['char_1', 'char_2', 'char_3'],
    });
    expect(p).not.toMatch(/hairstyle|wardrobe|facial features|same face/i);
  });

  // ── 2026-09-15:台词进 prompt(此前完全没接 dialogue,成片听不到剧本台词) ──
  // ── 2026-09-15 再修:台词先净化 —— 人名/括注不再粘进要念的文本(否则配音会念「洛烛：」) ──
  it('台词进 prompt 且要求"说出来、不许画成文字"', () => {
    const p = buildShotVideoPrompt({
      description: '两人对坐交谈',
      dialogue: '洛烛：白帝最后通牒已到。',
      shot_type: '中景',
    });
    expect(p).toContain('spoken line');
    expect(p).toContain('say it aloud in Chinese');
    // 净化后:台词正文进 prompt,说话人单独声明,不再把「洛烛：」粘进要念的文本
    expect(p).toContain('白帝最后通牒已到。');
    expect(p).toContain('the character 洛烛 speaks');
    expect(p).not.toContain('洛烛：白帝');
    // 与末尾无字幕护栏配套:台词要"被听见",不能变成画面文字
    expect(p).toContain('never render it as on-screen text');
    expect(p).toContain('no subtitles');
  });

  it('表演括注不进要念的台词,转成情绪指令(配音不会念「(咬牙)」)', () => {
    const p = buildShotVideoPrompt({
      description: '特写',
      dialogue: '陈明:(咬牙)稳住...时间核...',
    });
    expect(p).toContain('spoken line');
    expect(p).toContain('稳住...时间核...');
    // 「咬牙」不再作为要念的文本出现,而是进 performed with 情绪指令
    expect(p).not.toContain(': (咬牙)');
    expect(p).not.toContain('陈明:(咬牙)');
    expect(p).toContain('performed with');
  });

  it('环境音描述不当作台词念(含"无对白/只有…声" → ambient)', () => {
    const p = buildShotVideoPrompt({
      description: '空镜',
      dialogue: '(无对白，只有罗盘指针摩擦的尖锐声)',
    });
    expect(p).toContain('ambient sound only, no speech');
    expect(p).not.toContain('spoken line');
  });

  it('纯音效括号(门铃/脚步/雨声)判为 ambient,不念出来', () => {
    for (const ambient of ['(叮咚——门铃声)', '(脚步声，关门的咔哒声)', '(雨声轰鸣，掩盖了深夜的寂静)']) {
      const p = buildShotVideoPrompt({ description: '店内', dialogue: ambient });
      expect(p).toContain('ambient sound only, no speech');
      expect(p).not.toContain('spoken line');
    }
  });

  it('括号里带"说话线索"的仍当台词(不因有括号就判 ambient)', () => {
    const p = buildShotVideoPrompt({ description: '便利店', dialogue: '(少女轻声) 老板，还没睡啊？' });
    expect(p).toContain('spoken line');
    expect(p).toContain('老板，还没睡啊？');
    expect(p).not.toContain('ambient sound only');
  });

  it('旁白走画外音指令,不走角色对白', () => {
    const p = buildShotVideoPrompt({ description: '战场全景', dialogue: '(旁白)金书预言已现，内患必反。' });
    expect(p).toContain('voice-over narration');
    expect(p).not.toContain('spoken line');
  });

  it('无台词时不追加任何声音指令', () => {
    const p = buildShotVideoPrompt({ description: '空镜', dialogue: '' });
    expect(p).not.toContain('spoken line');
    expect(p).not.toContain('ambient sound');
    expect(p).not.toContain('voice-over');
  });

  it('台词段落位于起止状态之后、景别之前', () => {
    const p = buildShotVideoPrompt({
      description: '两人对坐',
      end_state: '女子点头',
      dialogue: '男：你好。',
      shot_type: '中景',
    });
    const idx = (s: string) => p.indexOf(s);
    expect(idx('end at this visible state')).toBeLessThan(idx('spoken line'));
    expect(idx('spoken line')).toBeLessThan(idx('medium shot'));
  });
});
