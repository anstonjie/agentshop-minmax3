// novel-anchor.spec.ts —— P0-b「把小说正文接回大纲」纯函数单测
import {
  normalizeLf, sliceEpisodeExcerpt, formatBeatsAnchor, buildEpisodeAnchor,
  DEFAULT_EXCERPT_BUDGET,
} from './novel-anchor';

const c1 = '主角推开木门,屋内烛火摇曳,桌上摊着一封未拆的信。';
const c2 = '他抽出剑,寒光一闪,门外脚步声骤然逼近。';
const novelLF = `第一章\n${c1}\n第二章\n${c2}`;
const norm = normalizeLf(novelLF);
const s1 = norm.indexOf(c1), e1 = s1 + c1.length;
const s2 = norm.indexOf(c2), e2 = s2 + c2.length;
const chapters = [
  { id: 'ch1', title: '第一章', char_offset: [s1, e1] as [number, number] },
  { id: 'ch2', title: '第二章', char_offset: [s2, e2] as [number, number] },
];

describe('normalizeLf —— 与 ingest 口径对齐', () => {
  it('CRLF / CR 都归一化为 LF', () => {
    expect(normalizeLf('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('sliceEpisodeExcerpt —— 按 char_offset 切回本集原文', () => {
  it('切出指定章节正文,带标题', () => {
    const out = sliceEpisodeExcerpt(novelLF, chapters, ['ch1']);
    expect(out).toContain(c1);
    expect(out).not.toContain(c2);
    expect(out).toContain('第一章');
  });
  it('多章按顺序拼接', () => {
    const out = sliceEpisodeExcerpt(novelLF, chapters, ['ch1', 'ch2']);
    expect(out.indexOf(c1)).toBeLessThan(out.indexOf(c2));
  });
  it('CRLF 原文也能按 LF 域偏移正确切回(偏移不错位)', () => {
    const crlf = novelLF.replace(/\n/g, '\r\n');
    const out = sliceEpisodeExcerpt(crlf, chapters, ['ch2']);
    expect(out).toContain(c2);
  });
  it('无章节 id / 空正文 → 返回空串(调用方据此降级)', () => {
    expect(sliceEpisodeExcerpt('', chapters, ['ch1'])).toBe('');
    expect(sliceEpisodeExcerpt(novelLF, chapters, [])).toBe('');
  });
  it('未知 chapter id 被跳过,不报错', () => {
    expect(sliceEpisodeExcerpt(novelLF, chapters, ['nope'])).toBe('');
  });
  it('超预算 → 保头尾 + 中略标记', () => {
    const out = sliceEpisodeExcerpt(novelLF, chapters, ['ch1', 'ch2'], 30);
    expect(out).toContain('中略');
    expect(out.length).toBeLessThan(norm.length);
  });
  it('默认预算足够时不截断', () => {
    const out = sliceEpisodeExcerpt(novelLF, chapters, ['ch1', 'ch2'], DEFAULT_EXCERPT_BUDGET);
    expect(out).not.toContain('中略');
    expect(out).toContain(c1);
    expect(out).toContain(c2);
  });
});

describe('formatBeatsAnchor —— beats 逐字锚点', () => {
  it('空 → 空串', () => {
    expect(formatBeatsAnchor([])).toBe('');
  });
  it('必拍排前 + [必拍] 标记 + 「」包 quote', () => {
    const out = formatBeatsAnchor([
      { summary: '主角犹豫', quote: '我该怎么办', must_show: false },
      { summary: '拔剑', quote: '寒光一闪', must_show: true },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toContain('[必拍]');
    expect(lines[0]).toContain('「寒光一闪」');
    expect(lines[1]).not.toContain('[必拍]');
  });
  it('must_show=1(数字)也认', () => {
    expect(formatBeatsAnchor([{ summary: 'x', must_show: 1 }])).toContain('[必拍]');
  });
  it('summary 与 quote 都空的行被丢弃', () => {
    expect(formatBeatsAnchor([{ summary: '', quote: '' }])).toBe('');
  });

  // 2026-09-23:beat id 上锚点行首 —— 大纲 scenes[].beat_ids 引用的唯一来源
  it('带 id 的拍点在行首输出 {id},供大纲 beat_ids 引用', () => {
    const out = formatBeatsAnchor([
      { id: 'ch1-b2', summary: '拔剑', quote: '寒光一闪', must_show: true },
      { id: 'ch1-b1', summary: '犹豫', must_show: false },
    ]);
    expect(out).toContain('{ch1-b2}');
    expect(out.split('\n')[0]).toMatch(/^- \{ch1-b2\} \[必拍\]/);
    expect(out).toContain('{ch1-b1}');
  });

  it('无 id 时行首不出现空花括号(向后兼容旧数据)', () => {
    const out = formatBeatsAnchor([{ summary: '旧拍点', must_show: false }]);
    expect(out).toBe('- 旧拍点');
    expect(out).not.toContain('{}');
  });
});

describe('buildEpisodeAnchor —— beats 优先,无 beats 回落正文', () => {
  it('有 beats → beatsAnchor 非空', () => {
    const r = buildEpisodeAnchor({
      beats: [{ summary: '拔剑', quote: '寒光一闪', must_show: true }],
      novelText: novelLF, chapters, epChapterIds: ['ch1'],
    });
    expect(r.beatsAnchor).toContain('寒光一闪');
    expect(r.excerpt).toContain(c1);
  });
  it('无 beats(P0-a 未回填)→ 仍有正文摘录,不依赖 beats', () => {
    const r = buildEpisodeAnchor({ novelText: novelLF, chapters, epChapterIds: ['ch1', 'ch2'] });
    expect(r.beatsAnchor).toBe('');
    expect(r.excerpt).toContain(c1);
  });
  it('两者都拿不到 → 都空(调用方退回旧标题锚点)', () => {
    const r = buildEpisodeAnchor({});
    expect(r.beatsAnchor).toBe('');
    expect(r.excerpt).toBe('');
  });
});
