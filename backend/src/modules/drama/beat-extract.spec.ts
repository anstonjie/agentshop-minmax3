// beat-extract.spec.ts —— P0-a beats 抽取纯函数 + 防幻觉对账单测
import { buildBeatExtractPrompt, parseBeats, reconcileBeats } from './beat-extract';

const body = '主角推开木门,屋内烛火摇曳。他抽出剑,寒光一闪,门外脚步声骤然逼近。';
// 简易 parseJson:模拟 montage.parseJsonSafe(能剥 ```json 包裹)
const parseJson = (s: string) => {
  const t = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { return null; }
};

describe('buildBeatExtractPrompt —— 强调逐字 quote + must_show', () => {
  it('system 要求 quote 逐字、禁杜撰;user 带正文与 JSON 结构', () => {
    const p = buildBeatExtractPrompt('第一章', body);
    expect(p.system).toContain('逐字');
    expect(p.system).toContain('must_show');
    expect(p.user).toContain(body);
    expect(p.user).toContain('"beats"');
    expect(p.temperature).toBeLessThan(0.5); // 抽取要低温度
  });
});

describe('parseBeats —— 解析 + 归一 + 补 id/chapter', () => {
  it('解析 {beats:[...]} 并补 id/chapter', () => {
    const raw = JSON.stringify({ beats: [
      { type: 'action', summary: '拔剑', quote: '他抽出剑,寒光一闪', must_show: true, foreshadow_pair: 'sword1' },
    ] });
    const beats = parseBeats(raw, 'ch1', parseJson);
    expect(beats).toHaveLength(1);
    expect(beats[0].id).toBe('ch1-b1');
    expect(beats[0].chapter).toBe('ch1');
    expect(beats[0].must_show).toBe(true);
    expect(beats[0].foreshadow_pair).toBe('sword1');
  });
  it('无 quote 的拍被丢弃(没有防幻觉锚点价值)', () => {
    const raw = JSON.stringify({ beats: [{ summary: 'x', quote: '' }, { summary: 'y', quote: '有效引用一句' }] });
    expect(parseBeats(raw, 'ch1', parseJson)).toHaveLength(1);
  });
  it('非法 type 归一为 plot;must_show 认 "true"/1', () => {
    const raw = JSON.stringify({ beats: [{ type: '瞎写', quote: '一段有效引用', must_show: 'true' }] });
    const b = parseBeats(raw, 'ch1', parseJson)[0];
    expect(b.type).toBe('plot');
    expect(b.must_show).toBe(true);
  });
  it('裸数组也能解析', () => {
    const raw = JSON.stringify([{ quote: '一段有效引用', summary: 's' }]);
    expect(parseBeats(raw, 'ch2', parseJson)).toHaveLength(1);
  });
  it('坏 JSON / null → 空数组,不抛错', () => {
    expect(parseBeats('not json', 'ch1', parseJson)).toEqual([]);
    expect(parseBeats('', 'ch1', parseJson)).toEqual([]);
  });
  it('summary 缺失时用 quote 前 30 字兜底', () => {
    const raw = JSON.stringify({ beats: [{ quote: '他抽出剑,寒光一闪' }] });
    expect(parseBeats(raw, 'ch1', parseJson)[0].summary).toContain('他抽出剑');
  });
});

describe('reconcileBeats —— 防幻觉对账(击穿用例:编造的 quote 必被丢)', () => {
  const mk = (quote: string) => ({
    id: 'ch1-b1', chapter: 'ch1', type: 'plot', summary: 's', quote, must_show: false, foreshadow_pair: null,
  });

  it('quote 逐字命中原文 → kept', () => {
    const r = reconcileBeats([mk('他抽出剑,寒光一闪')], body);
    expect(r.kept).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
  });
  it('空白差异不影响命中(归一后子串)', () => {
    const r = reconcileBeats([mk('他抽出剑, 寒光一闪')], body);
    expect(r.kept).toHaveLength(1);
  });
  it('击穿:quote 未在原文出现(幻觉)→ rejected', () => {
    const r = reconcileBeats([mk('他掏出手枪开了一枪')], body);
    expect(r.kept).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toContain('未在原文逐字命中');
  });
  it('击穿:quote 归一后 <5 字 → rejected', () => {
    const r = reconcileBeats([mk('拔剑')], body);
    expect(r.rejected[0].reason).toContain('<5');
  });
  it('混合:命中的留、幻觉的丢', () => {
    const r = reconcileBeats([mk('屋内烛火摇曳'), mk('天上掉下陨石')], body);
    expect(r.kept).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
  });
});
