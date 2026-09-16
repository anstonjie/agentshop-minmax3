// ============================================================================
// timeline 单测 —— 钉住「语义锚点时间轴」的结构不变量
// ----------------------------------------------------------------------------
// 这层是字幕/音效/图形多轨共用的地基,又是"词为锚"的核心判定,
// 没有测试的话很容易被"顺手改成按镜头时长线性分配"给退回去。
// 断言的是**行为**(时间窗从哪来、降级成什么、交叠怎么切),不是逐字文案。
// ============================================================================
import {
  applyTextEdits,
  assignWordsToWindows,
  assLayout,
  buildTimeline,
  DEFAULT_PRESENTATION,
  formatAssTime,
  formatSrtTime,
  hexToAssColor,
  parseDialogueLine,
  resolveDisplay,
  shotWindows,
  snapToFrameSec,
  speakerColorMap,
  timelineToAss,
  timelineToSrt,
  wrapCueText,
  Cue,
  WordTiming,
} from './timeline';

describe('parseDialogueLine 说话人解析', () => {
  it('「角色名：台词」解析出说话人,文本剥掉前缀', () => {
    const r = parseDialogueLine('洛烛：白帝最后通牒已到。');
    expect(r.speaker).toBe('洛烛');
    expect(r.kind).toBe('speech');
    expect(r.text).toBe('白帝最后通牒已到。');
  });

  it('说话人带括注「洛烛（冷笑）：…」只取名字', () => {
    expect(parseDialogueLine('洛烛（冷笑）：你也配？').speaker).toBe('洛烛');
  });

  it('半角冒号同样识别', () => {
    expect(parseDialogueLine('秦烈:果然是你。').speaker).toBe('秦烈');
  });

  it('括号表演提示不当作说话人: "(少女轻声) 老板，还没睡啊？"', () => {
    const r = parseDialogueLine('(少女轻声) 老板，还没睡啊？');
    expect(r.speaker).toBeNull();
    expect(r.text).toContain('老板，还没睡啊');
    expect(r.kind).toBe('speech');
  });

  it('「…低声道：」这类动词结尾不当作名字', () => {
    expect(parseDialogueLine('秦烈低声道：果然…是我身边人。').speaker).toBeNull();
  });

  it('旁白/画外音归 voiceover 类', () => {
    expect(parseDialogueLine('旁白：三十年前的那场大雪。').kind).toBe('voiceover');
  });

  it('纯音效描述判 ambient(不上屏)', () => {
    expect(parseDialogueLine('(叮咚——门铃声)').kind).toBe('ambient');
    expect(parseDialogueLine('(脚步声，关门的咔哒声)').kind).toBe('ambient');
    expect(parseDialogueLine('(无对白，只有罗盘指针摩擦的尖锐声)').kind).toBe('ambient');
  });

  it('空台词 → none', () => {
    expect(parseDialogueLine('').kind).toBe('none');
    expect(parseDialogueLine('   ').kind).toBe('none');
  });
});

describe('shotWindows 镜头基准线', () => {
  it('按时长累加', () => {
    const w = shotWindows([{ duration_sec: 5 }, { duration_sec: 3 }, { duration_sec: 4 }]);
    expect(w[0]).toEqual({ startSec: 0, endSec: 5 });
    expect(w[1]).toEqual({ startSec: 5, endSec: 8 });
    expect(w[2]).toEqual({ startSec: 8, endSec: 12 });
  });

  it('实测时长(ffprobe)优先于 shot.duration_sec', () => {
    const w = shotWindows([{ duration_sec: 5 }, { duration_sec: 5 }], [5.17, 4.83]);
    expect(w[0].endSec).toBeCloseTo(5.17, 2);
    expect(w[1].endSec).toBeCloseTo(10.0, 2);
  });

  it('缺失/非法时长回退 3 秒,不产出 NaN', () => {
    const w = shotWindows([{} as any, { duration_sec: 0 }, { duration_sec: NaN }]);
    for (const x of w) {
      expect(Number.isFinite(x.startSec)).toBe(true);
      expect(Number.isFinite(x.endSec)).toBe(true);
      expect(x.endSec - x.startSec).toBeGreaterThan(0);
    }
  });
});

describe('assignWordsToWindows 词分派', () => {
  const windows = [{ startSec: 0, endSec: 5 }, { startSec: 5, endSec: 10 }];

  it('按词起点归属窗口', () => {
    const words: WordTiming[] = [
      { word: '甲', startSec: 1, endSec: 1.5 },
      { word: '乙', startSec: 6, endSec: 6.5 },
    ];
    const b = assignWordsToWindows(words, windows);
    expect(b[0].map((w) => w.word)).toEqual(['甲']);
    expect(b[1].map((w) => w.word)).toEqual(['乙']);
  });

  it('窗口外的词挂到最近的窗口(不丢词)', () => {
    const words: WordTiming[] = [{ word: '尾', startSec: 12, endSec: 12.4 }];
    const b = assignWordsToWindows(words, windows);
    expect(b[1].map((w) => w.word)).toEqual(['尾']);
  });

  it('桶内按起点排序', () => {
    const words: WordTiming[] = [
      { word: '后', startSec: 3, endSec: 3.4 },
      { word: '前', startSec: 1, endSec: 1.4 },
    ];
    expect(assignWordsToWindows(words, windows)[0].map((w) => w.word)).toEqual(['前', '后']);
  });
});

describe('buildTimeline 装配', () => {
  // 真实证据(2026-09-15 实测 shot5.mp4):整句 1.22s 才开口,旧的线性分配写 0→5s
  const shot5Words: WordTiming[] = [
    { word: '老', startSec: 1.22, endSec: 2.14 },
    { word: '板', startSec: 2.14, endSec: 2.62 },
    { word: '还', startSec: 2.62, endSec: 3.06 },
    { word: '没', startSec: 3.06, endSec: 3.28 },
    { word: '睡', startSec: 3.28, endSec: 3.46 },
    { word: '啊', startSec: 3.46, endSec: 4.32 },
  ];

  it('有 ASR 词 → 时间窗来自首词起点~末词终点(不是镜头起点)', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '老板还没睡啊？', duration_sec: 5 }], shot5Words);
    expect(tl.cues).toHaveLength(1);
    expect(tl.cues[0].source).toBe('asr');
    expect(tl.cues[0].window.startSec).toBeCloseTo(1.22, 2);
    expect(tl.cues[0].window.endSec).toBeCloseTo(4.32, 2);
    expect(tl.stats.asr).toBe(1);
    expect(tl.stats.estimated).toBe(0);
  });

  it('没有词 → 降级为 estimated,窗口在镜头窗内缩', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '你好。', duration_sec: 4 }], []);
    expect(tl.cues[0].source).toBe('estimated');
    expect(tl.cues[0].window.startSec).toBeGreaterThan(0);
    expect(tl.cues[0].window.startSec).toBeLessThan(4);
    expect(tl.stats.estimated).toBe(1);
  });

  it('无台词/纯音效镜头不产出 cue,只记 skipped', () => {
    const tl = buildTimeline([
      { idx: 1, dialogue: '' },
      { idx: 2, dialogue: '(叮咚——门铃声)' },
      { idx: 3, dialogue: '真有人吗？' },
    ], []);
    expect(tl.cues).toHaveLength(1);
    expect(tl.cues[0].anchor.shotIdx).toBe(3);
    expect(tl.stats.skipped).toBe(2);
  });

  it('相邻 cue 交叠时取中点切开(任意时刻只显示一条)', () => {
    const tl = buildTimeline(
      [
        { idx: 1, dialogue: '甲说的一句话。', duration_sec: 4 },
        { idx: 2, dialogue: '乙说的一句话。', duration_sec: 4 },
      ],
      [
        { word: '甲', startSec: 0.5, endSec: 1.0 },
        { word: '话', startSec: 5.0, endSec: 5.5 },
      ],
    );
    expect(tl.cues).toHaveLength(2);
    expect(tl.cues[0].window.endSec).toBeLessThanOrEqual(tl.cues[1].window.startSec + 1e-6);
  });

  it('极短窗口被撑到最短显示时长', () => {
    const tl = buildTimeline(
      [{ idx: 1, dialogue: '嗯。', duration_sec: 5 }],
      [{ word: '嗯', startSec: 2.0, endSec: 2.05 }],
      { minCueSec: 0.8 },
    );
    // 浮点加法有 1e-16 级误差,给容差
    const dur = tl.cues[0].window.endSec - tl.cues[0].window.startSec;
    expect(dur).toBeGreaterThan(0.79);
  });

  it('统计说话人(按首次出现排序,去重)', () => {
    const tl = buildTimeline(
      [
        { idx: 1, dialogue: '洛烛：一。' },
        { idx: 2, dialogue: '苏清歌：二。' },
        { idx: 3, dialogue: '洛烛：三。' },
      ],
      [],
    );
    expect(tl.stats.speakers).toEqual(['洛烛', '苏清歌']);
  });

  it('总时长 = 全部镜头时长之和(含无台词镜)', () => {
    const tl = buildTimeline([
      { idx: 1, dialogue: '一。', duration_sec: 3 },
      { idx: 2, dialogue: '', duration_sec: 4 },
    ], []);
    expect(tl.durationSec).toBeCloseTo(7, 2);
  });
});

describe('wrapCueText 分行', () => {
  it('短句不折行', () => {
    expect(wrapCueText('你好。', 18, 2)).toEqual(['你好。']);
  });

  it('长句在标点处断行', () => {
    const lines = wrapCueText('白帝的最后通牒已经到了，我们必须立刻离开这座城市，否则就来不及了。', 18, 3);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length > 0)).toBe(true);
    expect(lines.join('')).toContain('白帝的最后通牒');
  });

  it('超出行数上限时均分重排,不产出超宽末行(2026-09-16 修字幕超屏)', () => {
    const long = '甲'.repeat(120);
    const lines = wrapCueText(long, 18, 2);
    expect(lines).toHaveLength(2);
    expect(lines.join('').length).toBe(120);
    // 均分:每行 60 字(旧实现末行 = 102 字超宽,是字幕出屏根因之一)
    expect(lines[0].length).toBe(60);
    expect(lines[1].length).toBe(60);
  });
});

describe('assLayout 竖屏画布(2026-09-16)', () => {
  it('不传分辨率回退旧 512×288 校准(老向导零行为变化)', () => {
    const l = assLayout();
    expect(l).toMatchObject({
      playResX: 512, playResY: 288, fontSize: 12, marginLR: 16, marginV: 36, maxChars: 18,
    });
  });

  it('竖屏 720×1280:字号≈屏宽 5%,每行字数由像素宽推导', () => {
    const l = assLayout({ videoWidth: 720, videoHeight: 1280 });
    expect(l.fontSize).toBe(36);
    expect(l.marginLR).toBe(36);
    expect(l.maxChars).toBe(Math.floor((720 - 2 * 36) / 36));
    expect(l.playResY).toBe(1280);
  });

  it('timelineToAss 竖屏:PlayRes 跟分辨率,超宽行带 {\\fs} 缩字标签', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '甲'.repeat(40), duration_sec: 3 }], []);
    const ass = timelineToAss(tl, { videoWidth: 720, videoHeight: 1280 });
    expect(ass).toContain('PlayResX: 720');
    expect(ass).toContain('PlayResY: 1280');
    expect(ass).toContain('{\\fs'); // 40 字 > 2 行×18 字,触发缩字兜底
  });

  it('timelineToAss 老路径:无分辨率 PlayRes 仍 512×288', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '你好', duration_sec: 2 }], []);
    expect(timelineToAss(tl)).toContain('PlayResX: 512');
  });

  it('timelineToSrt 前缀预算:说话人名计入折行,首行不超 maxChars', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '洛烛：' + '乙'.repeat(20), duration_sec: 3 }], []);
    const srt = timelineToSrt(tl, { showSpeakerName: true, videoWidth: 720, videoHeight: 1280 });
    // SRT 行首可能带说话人色覆盖标签 {\c...&},断言前剥掉
    const firstLine = srt.split('\n')[2].replace(/^\{\\c[^}]*\}/, '');
    expect(firstLine.startsWith('洛烛：')).toBe(true);
    expect(firstLine.length).toBeLessThanOrEqual(18);
  });
});

describe('配色', () => {
  it('#RRGGBB → ASS &H00BBGGRR&', () => {
    expect(hexToAssColor('#FFD700')).toBe('&H0000D7FF');
    expect(hexToAssColor('87CEEB')).toBe('&H00EBCE87');
    expect(hexToAssColor('乱码')).toBe('&H00FFFFFF');
  });

  it('说话人按出现顺序取色,超出调色板循环', () => {
    const map = speakerColorMap(['A', 'B'], ['#111111', '#222222']);
    expect(map.A).toBe('#111111');
    expect(map.B).toBe('#222222');
    const cyc = speakerColorMap(['A', 'B', 'C'], ['#111111', '#222222']);
    expect(cyc.C).toBe('#111111');
  });
});

describe('timelineToSrt 输出', () => {
  // 镜头窗 [0,4] / [4,10];词按各自的镜头窗归属:白/到→镜1,我/知→镜2
  const tl = buildTimeline(
    [
      { idx: 1, dialogue: '洛烛：白帝最后通牒已到。', duration_sec: 4 },
      { idx: 2, dialogue: '苏清歌：我知道。', duration_sec: 6 },
    ],
    [
      { word: '白', startSec: 0.5, endSec: 0.8 },
      { word: '到', startSec: 3.0, endSec: 3.2 },
      { word: '我', startSec: 5.5, endSec: 5.8 },
      { word: '知', startSec: 8.0, endSec: 8.2 },
    ],
  );

  it('时间码为 SRT 格式且序号连续', () => {
    const srt = timelineToSrt(tl);
    expect(srt).toContain('00:00:00,500 --> 00:00:03,200');
    expect(srt.startsWith('1\n')).toBe(true);
    expect(srt).toContain('\n2\n');
  });

  it('两个以上说话人时自动加「名字：」前缀', () => {
    const srt = timelineToSrt(tl);
    expect(srt).toContain('洛烛：');
    expect(srt).toContain('苏清歌：');
  });

  it('showSpeakerName=false 时不加前缀', () => {
    const srt = timelineToSrt(tl, { showSpeakerName: false });
    expect(srt).not.toContain('洛烛：');
  });

  it('formatSrtTime 边界正确', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
  });
});

describe('timelineToAss 输出', () => {
  const tl = buildTimeline(
    [{ idx: 1, dialogue: '洛烛：白帝最后通牒已到。' }],
    [
      { word: '白', startSec: 1.2, endSec: 1.5 },
      { word: '到', startSec: 3.0, endSec: 3.2 },
    ],
  );

  it('含完整 ASS 头与 Events 段', () => {
    const ass = timelineToAss(tl);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 512');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('[Events]');
    expect(ass).toContain('Style: Default,Microsoft YaHei,12');
  });

  it('画布/字号/边距与旧 force_style 对齐(换 ASS 不回退视觉)', () => {
    const ass = timelineToAss(tl);
    expect(ass).toContain('PlayResY: 288');
    expect(ass).toContain(',12,');
    // BorderStyle=1, Outline=2, Shadow=1, Alignment=2, MarginL/R=16, MarginV=36
    expect(ass).toMatch(/,1,2,1,2,16,16,36,1/);
  });

  it('时间码为 H:MM:SS.cc', () => {
    const ass = timelineToAss(tl);
    expect(ass).toContain('Dialogue: 0,0:00:01.20,0:00:03.20,Default');
    expect(formatAssTime(3661.5)).toBe('1:01:01.50');
  });

  it('说话人颜色以内联覆盖标签写入', () => {
    const ass = timelineToAss(tl, { speakerColors: { 洛烛: '#FFD700' } });
    expect(ass).toContain('{\\c&H0000D7FF&}');
  });

  it('karaoke 模式输出 \\k 逐词标签', () => {
    const ass = timelineToAss(tl, { karaoke: true });
    expect(ass).toMatch(/\\k\d+/);
    expect(ass).toContain(',Karaoke,');
  });

  it('转义保留字符,避免破坏覆盖标签区', () => {
    const bad = buildTimeline([{ idx: 1, dialogue: '{危险} 文本\\带反斜杠' }], []);
    const ass = timelineToAss(bad);
    const body = ass.split('\n').find((l) => l.startsWith('Dialogue:')) || '';
    expect(body).not.toMatch(/\{[^\\]/);   // 没有非覆盖标签的大括号
    expect(body).toContain('（危险）');
  });
});

describe('applyTextEdits 重排', () => {
  const tl = buildTimeline(
    [{ idx: 1, dialogue: '洛烛：白帝最后通牒已到。' }, { idx: 2, dialogue: '苏清歌：我知道。' }],
    [
      { word: '白', startSec: 0.5, endSec: 0.8 },
      { word: '到', startSec: 3.0, endSec: 3.2 },
      { word: '我', startSec: 5.5, endSec: 5.8 },
      { word: '知', startSec: 8.0, endSec: 8.2 },
    ],
  );

  it('等长替换:窗口不动,不标 stale', () => {
    const { timeline, needsRealign } = applyTextEdits(tl, [{ shotIdx: 1, text: '白帝最后通牒已至。' }]);
    expect(timeline.cues[0].window).toEqual(tl.cues[0].window);
    expect(timeline.cues[0].stale).toBeFalsy();
    expect(needsRealign).toBe(false);
  });

  it('字数变化大:标 stale 并要求重新对齐', () => {
    const { timeline, needsRealign } = applyTextEdits(tl, [
      { shotIdx: 1, text: '白帝的最后通牒已经到了，我们必须立刻离开这座城，否则一切都来不及了。' },
    ]);
    expect(timeline.cues[0].stale).toBe(true);
    expect(needsRealign).toBe(true);
  });

  it('未命中的 shotIdx 原样保留', () => {
    const { timeline } = applyTextEdits(tl, [{ shotIdx: 999, text: '无关' }]);
    expect(timeline.cues[1].anchor.text).toBe('我知道。');
  });
});

// ============================================================================
// 借鉴 hypit 的三层时间模型后新增的行为:
//   · 证据(window)只读 / 调优(presentation)可写 / 显示(display)派生
//   · handoff = cut | overlap
//   · 帧吸附
//   · 兜底一律记 diagnostics(兜底可以,装作没发生不行)
// ============================================================================
describe('呈现层与证据层分离(借鉴 hypit: lead/tail/handoff 可调,证据只读)', () => {
  const mk = (opts: Record<string, unknown> = {}) =>
    buildTimeline(
      [{ idx: 1, dialogue: '洛烛：白帝最后通牒已到。', duration_sec: 5 }],
      [
        { word: '白', startSec: 1.2, endSec: 1.5 },
        { word: '到', startSec: 3.0, endSec: 3.2 },
      ],
      opts as any,
    );

  it('默认无 lead/tail 时 display 与语义 window 一致', () => {
    const tl = mk();
    expect(tl.cues[0].presentation).toEqual(DEFAULT_PRESENTATION);
    expect(tl.cues[0].display).toEqual(tl.cues[0].window);
  });

  it('lead/tail 只改 display,语义 window 纹丝不动', () => {
    const tl = mk({ presentation: { leadSec: 0.3, tailSec: 0.5 } });
    const c = tl.cues[0];
    expect(c.window).toEqual({ startSec: 1.2, endSec: 3.2 });      // 证据未污染
    expect(c.display.startSec).toBeCloseTo(0.9, 2);
    expect(c.display.endSec).toBeCloseTo(3.7, 2);
  });

  it('渲染用 display,不是 window(否则调优失效)', () => {
    const tl = mk({ presentation: { leadSec: 0.3, tailSec: 0.5 } });
    expect(timelineToSrt(tl)).toContain('00:00:00,900 --> 00:00:03,700');
  });

  it('lead 不会把起点拉到负数', () => {
    const tl = buildTimeline(
      [{ idx: 1, dialogue: '嗯。', duration_sec: 5 }],
      [{ word: '嗯', startSec: 0.1, endSec: 0.3 }],
      { presentation: { leadSec: 2 } },
    );
    expect(tl.cues[0].display.startSec).toBeGreaterThanOrEqual(0);
  });

  // 真实交叠数据:镜1 的词 3.0→4.5(跨过镜界),镜2 的词 4.2 起 —— 两窗天然交叠
  const OVERLAP_SHOTS = [
    { idx: 1, dialogue: '甲的一句话。', duration_sec: 4 },
    { idx: 2, dialogue: '乙的一句话。', duration_sec: 4 },
  ];
  const OVERLAP_WORDS = [
    { word: '甲', startSec: 3.0, endSec: 4.5 },
    { word: '话', startSec: 4.2, endSec: 5.0 },
  ];

  it('handoff=overlap 时保留双方包络(不切分)', () => {
    const tl = buildTimeline(OVERLAP_SHOTS, OVERLAP_WORDS);
    tl.cues[0].presentation = { ...tl.cues[0].presentation, handoff: 'overlap' };
    tl.cues[1].presentation = { ...tl.cues[1].presentation, handoff: 'overlap' };
    const out = resolveDisplay(tl.cues, tl.durationSec, 0, []);
    const [a, b] = [...out].sort((x, y) => x.window.startSec - y.window.startSec);
    expect(a.display.endSec).toBeGreaterThan(b.display.startSec);
  });

  it('handoff=cut(默认) 任一方要求就切开', () => {
    const tl = buildTimeline(OVERLAP_SHOTS, OVERLAP_WORDS);
    const [a, b] = [...tl.cues].sort((x, y) => x.window.startSec - y.window.startSec);
    expect(a.display.endSec).toBeLessThanOrEqual(b.display.startSec + 1e-9);
  });
});

describe('帧吸附(借鉴 hypit: 位置须落在精确帧上)', () => {
  it('snapToFrameSec 按 fps 取整', () => {
    expect(snapToFrameSec(1.234, 30)).toBeCloseTo(Math.round(1.234 * 30) / 30, 6);
    expect(snapToFrameSec(1.234, 0)).toBeCloseTo(1.234, 6);   // 0 = 不吸附
  });

  it('fps 生效后所有显示窗都落在帧上', () => {
    const tl = buildTimeline(
      [{ idx: 1, dialogue: '一句话。', duration_sec: 5 }],
      [{ word: '一', startSec: 1.2137, endSec: 3.2071 }],
      { fps: 25, presentation: { leadSec: 0.13 } },
    );
    const d = tl.cues[0].display;
    expect((d.startSec * 25) % 1).toBeCloseTo(0, 6);
    expect((d.endSec * 25) % 1).toBeCloseTo(0, 6);
  });
});

describe('诊断日志(兜底必须留痕)', () => {
  it('无词级证据 → NO_ASR_EVIDENCE', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '你好。', duration_sec: 4 }], []);
    expect(tl.diagnostics.map((d) => d.code)).toContain('NO_ASR_EVIDENCE');
  });

  it('证据窗过短被撑长 → TOO_SHORT_EXTENDED', () => {
    const tl = buildTimeline(
      [{ idx: 1, dialogue: '嗯。', duration_sec: 5 }],
      [{ word: '嗯', startSec: 2.0, endSec: 2.05 }],
    );
    expect(tl.diagnostics.map((d) => d.code)).toContain('TOO_SHORT_EXTENDED');
  });

  it('交叠被切分 → OVERLAP_RESOLVED 且带 shotIdx', () => {
    const tl = buildTimeline(
      [
        { idx: 1, dialogue: '甲的一句话。', duration_sec: 4 },
        { idx: 2, dialogue: '乙的一句话。', duration_sec: 4 },
      ],
      [
        { word: '甲', startSec: 3.0, endSec: 4.5 },   // 跨过镜界,与下一句交叠
        { word: '话', startSec: 4.2, endSec: 5.0 },
      ],
    );
    const d = tl.diagnostics.find((x) => x.code === 'OVERLAP_RESOLVED');
    expect(d).toBeTruthy();
    expect(d!.shotIdx).toBe(2);
  });

  it('台词大改 → TEXT_EDITED_STALE', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '短句。', duration_sec: 4 }], []);
    const { timeline } = applyTextEdits(tl, [{ shotIdx: 1, text: '一句被大幅改写的很长很长的台词内容。' }]);
    expect(timeline.diagnostics.map((d) => d.code)).toContain('TEXT_EDITED_STALE');
  });

  it('无异常时诊断为空(不刷噪音)', () => {
    const tl = buildTimeline(
      [{ idx: 1, dialogue: '一句话。', duration_sec: 5 }],
      [{ word: '一', startSec: 1.0, endSec: 3.0 }],
    );
    expect(tl.diagnostics).toHaveLength(0);
  });
});

describe('多轨骨架与来源身份(借鉴 hypit: Track 共享同一 Timeline)', () => {
  it('产出 subtitle 轨,引用 cue 身份', () => {
    const tl = buildTimeline(
      [{ idx: 1, dialogue: '甲：一。' }, { idx: 2, dialogue: '乙：二。' }],
      [],
    );
    expect(tl.tracks).toHaveLength(1);
    expect(tl.tracks[0].kind).toBe('subtitle');
    expect(tl.tracks[0].cueIds).toEqual(tl.cues.map((c) => c.id));
    expect(tl.cues[0].id).toBe('shot1');
  });

  it('narrativeId 写进时间轴,供跨模块校验来源', () => {
    const tl = buildTimeline([{ idx: 1, dialogue: '一。' }], [], { narrativeId: 'drama-uuid-1' });
    expect(tl.narrativeId).toBe('drama-uuid-1');
  });

  it('cue 身份稳定:同一分镜多次装配 id 不变', () => {
    const a = buildTimeline([{ idx: 7, dialogue: '一。' }], []);
    const b = buildTimeline([{ idx: 7, dialogue: '一。' }], [{ word: '一', startSec: 0.2, endSec: 1.4 }]);
    expect(a.cues[0].id).toBe('shot7');
    expect(b.cues[0].id).toBe('shot7');
  });
});
