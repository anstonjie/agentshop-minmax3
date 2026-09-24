// ============================================================================
// n2d-engine.spec —— 对齐引擎(重建)的契约测试
// ----------------------------------------------------------------------------
// 背景(2026-09-24):tool/n2d-core(独立 npm 工程,子进程桥接)源码丢失,
//   按 DB 里 36 部剧的真实产出 + 调用方契约在库内重建(原路线图 P2 vendor 提前)。
// 标定依据(生产账本 a1b8008e + novel.txt,1188 字):
//   fold={cps:4.5, charsPerBeat:200, actionSecPerBeat:2.5},
//   budget=对白字数/4.5+叙述字数/200*2.5,总 106s,total_minutes=1.77,
//   章节 ^第.+章 行切分,offsets 连续覆盖全文,char_offset 为 LF 归一化域。
//   dialogue_ratio 含引号标记(0.541 精确复现);budget_sec 取 floor
//   (ch3 有 1s 残差 56vs57,原口径未知细节,注记,不影响下游 clamp 45-240)。
// ============================================================================
import {
  N2D_FOLD,
  splitChapters,
  foldChapter,
  buildLedgerJson,
  checkLedgerJson,
  N2dLedgerJson,
} from './n2d-engine';

describe('splitChapters 切章', () => {
  it('^第.+章 行切分,标题取整行,offsets 连续覆盖全文', () => {
    const text = '第一章 雨夜来客\n林越推门。\n第二章 蝎影追杀\n杀手至。';
    const chs = splitChapters(text);
    expect(chs).toHaveLength(2);
    expect(chs[0].title).toBe('第一章 雨夜来客');
    expect(chs[0].start).toBe(0);
    expect(chs[1].start).toBe(chs[0].end);
    expect(chs[1].end).toBe(text.length);
    expect(chs[0].id).toBe('ch_0001');
  });

  it('CRLF 先归一化,offsets 落在 LF 域(与 novel-anchor 同口径)', () => {
    const chs = splitChapters('第一章 A\r\n正文。\r\n第二章 B\r\n尾。');
    expect(chs).toHaveLength(2);
    expect(chs[0].end).toBe(chs[1].start);
    // LF 域总长 = raw - CRLF 数
    expect(chs[1].end).toBe('第一章 A\n正文。\n第二章 B\n尾。'.length);
  });

  it('无章节标题 → 整篇一章(标题"正文",不断尾)', () => {
    const chs = splitChapters('只有正文,没有标题。');
    expect(chs).toHaveLength(1);
    expect(chs[0].title).toBe('正文');
    expect(chs[0].start).toBe(0);
  });

  it('空输入 → 空数组(调用方据此抛"空小说",不造假账本)', () => {
    expect(splitChapters('')).toEqual([]);
    expect(splitChapters('   \n  ')).toEqual([]);
  });
});

describe('foldChapter 折时', () => {
  it('折时常量与生产账本一致', () => {
    expect(N2D_FOLD).toEqual({ cps: 4.5, charsPerBeat: 200, actionSecPerBeat: 2.5 });
  });

  it('对白span 两种引号都认(直引号 + 「」),标记计入对白字数', () => {
    const body = 'x'.repeat(200) + '"今晚的事"她说。' + '「跟我来」';
    const f = foldChapter(body);
    // 对白 = "今晚的事"(6) + 「跟我来」(5) = 11;叙述 = len-11
    const D = 11;
    const N = body.length - D;
    expect(f.dialogueChars).toBe(D);
    // dialogue_ratio 存 3 位小数(生产账本 0.34/0.21/0.541 同口径)
    expect(f.dialogueRatio).toBe(Math.round((D / body.length) * 1000) / 1000);
    expect(f.budgetSec).toBe(Math.round(D / 4.5 + (N * 2.5) / 200));
  });

  it('纯叙述200字 = 2.5s round → 3s(生产口径是 round 非 floor);纯对白45字 = 10s', () => {
    expect(foldChapter('x'.repeat(200)).budgetSec).toBe(3);
    expect(foldChapter('"' + 'y'.repeat(43) + '"').budgetSec).toBe(10);
  });

  it('空章节 budget 0(不拦,装箱时合并)', () => {
    expect(foldChapter('').budgetSec).toBe(0);
  });
});

describe('buildLedgerJson 装箱', () => {
  const novel = '第一章 A\n' + 'x'.repeat(400) + '\n第二章 B\n' + 'y'.repeat(400);

  it('episodes id ep_001 起,章节 id ch_0001 起,episode_ids 回填', () => {
    const lj = buildLedgerJson({ novelText: novel, title: 'T', source: 'uploaded', epTargetSec: 120 });
    expect(lj.episodes.length).toBeGreaterThanOrEqual(1);
    expect(lj.episodes[0].id).toBe('ep_001');
    expect(lj.chapters[0].id).toBe('ch_0001');
    const covered = new Set(lj.episodes.flatMap((e) => e.chapters));
    expect(covered.size).toBe(lj.chapters.length);
    for (const c of lj.chapters) {
      expect(c.episode_ids.length).toBe(1);
      expect(covered.has(c.id)).toBe(true);
    }
  });

  it('贪心装箱:超 ep_target*(1+eps) 才另起一集,章永不拆散', () => {
    const big = '第一章 A\n' + 'x'.repeat(2000) + '\n第二章 B\n' + 'y'.repeat(2000);
    const lj = buildLedgerJson({ novelText: big, title: 'T', source: 'uploaded', epTargetSec: 30 });
    expect(lj.episodes.length).toBe(2);
    expect(lj.meta.budget.episode_count).toBe(2);
  });

  it('meta 形状:total_chars/total_minutes/k_eff/episode_count/ep_target_sec/version=1', () => {
    const lj = buildLedgerJson({ novelText: novel, title: 'T', source: 'uploaded', epTargetSec: 120 });
    expect(lj.meta.total_chars).toBe(novel.length);
    expect(lj.meta.version).toBe(1);
    expect(lj.meta.budget.ep_target_sec).toBe(120);
    const sum = lj.chapters.reduce((s, c) => s + c.budget_sec, 0);
    expect(lj.meta.budget.total_minutes).toBeCloseTo(sum / 60, 2);
    expect(lj.beats).toEqual([]);
    expect(lj.audit_trail).toEqual([]);
  });

  it('空小说抛错(不造假账本)', () => {
    expect(() => buildLedgerJson({ novelText: '  ', title: 'T', source: 'uploaded', epTargetSec: 120 }))
      .toThrow();
  });
});

describe('checkLedgerJson 校验', () => {
  function led(): N2dLedgerJson {
    return buildLedgerJson({
      novelText: '第一章 A\n' + 'x'.repeat(300) + '\n第二章 B\n' + 'y'.repeat(300),
      title: 'T', source: 'uploaded', epTargetSec: 500,
    });
  }

  it('健康账本 budget+coverage 全过,version+1,有审计条目', () => {
    const r = checkLedgerJson(led(), 'budget', 'ingest');
    expect(r.failed).toBe(false);
    expect(r.ledgerJson.meta.version).toBe(2);
    expect(r.ledgerJson.audit_trail.length).toBeGreaterThan(0);
    const last = r.ledgerJson.audit_trail[r.ledgerJson.audit_trail.length - 1] as any;
    expect(last.check).toBe('check_budget');
    const r2 = checkLedgerJson(led(), 'coverage', 'ingest');
    expect(r2.failed).toBe(false);
  });

  it('episode_count 对不上 episodes.length → error 级 failed', () => {
    const lj = led();
    (lj.meta.budget as any).episode_count = 99;
    const r = checkLedgerJson(lj, 'budget', 'ingest');
    expect(r.failed).toBe(true);
    expect(r.violations.some((v) => v.includes('B-COUNT'))).toBe(true);
  });

  it('beat 引用不存在的章节 → error 级 failed', () => {
    const lj = led();
    (lj as any).beats = [{ id: 'ch1-b1', chapter: 'ch_9999', quote: 'abcdefghij', type: 'action' }];
    const r = checkLedgerJson(lj, 'coverage', 'ingest');
    expect(r.failed).toBe(true);
    expect(r.violations.some((v) => v.includes('C-REF'))).toBe(true);
  });

  it('伏笔单边键 → I3 warn(不 failed,历史 30 warns 仍可用)', () => {
    const lj = led();
    (lj as any).beats = [{
      id: 'ch1-b1', chapter: 'ch_0001', quote: 'abcdefghij',
      type: 'foreshadow', foreshadow_pair: 'solo-key',
    }];
    const r = checkLedgerJson(lj, 'coverage', 'ingest');
    expect(r.failed).toBe(false);
    expect(r.violations.some((v) => v.includes('I3'))).toBe(true);
  });

  it('伏笔 foreshadow 在前 reveal 在后同键 → I3 通过', () => {
    const lj = led();
    (lj as any).beats = [
      { id: 'b1', chapter: 'ch_0001', quote: 'abcdefghij', type: 'foreshadow', foreshadow_pair: 'k1' },
      { id: 'b2', chapter: 'ch_0002', quote: 'abcdefghij', type: 'reveal', foreshadow_pair: 'k1' },
    ];
    const r = checkLedgerJson(lj, 'coverage', 'ingest');
    expect(r.violations.some((v) => v.includes('I3'))).toBe(false);
  });

  it('集 cliffhanger 为空 → I6 warn;must_show 未 covered → COV-1 warn', () => {
    const lj = led();
    (lj as any).beats = [{
      id: 'ch1-b1', chapter: 'ch_0001', quote: 'abcdefghij',
      type: 'action', must_show: true, status: 'pending',
    }];
    const r = checkLedgerJson(lj, 'coverage', 'ingest');
    expect(r.failed).toBe(false);
    expect(r.violations.some((v) => v.includes('I6'))).toBe(true);
    expect(r.violations.some((v) => v.includes('COV-1'))).toBe(true);
  });

  it('审计行格式兼容 service.parseAuditLine([RULE] target: msg |U: user)', () => {
    const r = checkLedgerJson(led(), 'budget', 'ingest');
    // 健康账本也应有汇总行(零违规时 violations 为空数组,last entry 仍是对象)
    const last = r.ledgerJson.audit_trail[r.ledgerJson.audit_trail.length - 1] as any;
    expect(Array.isArray(last.violations)).toBe(true);
    // 造一条 error 看格式
    const bad = led();
    (bad.meta.budget as any).episode_count = -1;
    const r2 = checkLedgerJson(bad, 'budget', 'ingest');
    expect(r2.violations[0]).toMatch(/^\[\S+\]\s*[^:]+:.+/);
  });
});
