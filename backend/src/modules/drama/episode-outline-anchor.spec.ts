// episode-outline-anchor.spec.ts —— P0-b 大纲提示词渲染原文锚点的单测
import { buildEpisodeOutlinePrompt } from './episode-outline-prompt';

const base = { dramaTitle: '测试剧', epNo: 2, targetSec: 120 };

describe('buildEpisodeOutlinePrompt —— 原文锚点接入(P0-b)', () => {
  it('给了 chapterExcerpt → user 里出现"原文摘录"与正文', () => {
    const p = buildEpisodeOutlinePrompt({
      ...base, chapterExcerpt: '主角推开木门,屋内烛火摇曳。',
    });
    expect(p.user).toContain('本集原文锚点');
    expect(p.user).toContain('原文摘录');
    expect(p.user).toContain('主角推开木门');
  });

  it('给了 beatsAnchor → user 里出现"逐字锚点"与必拍标记', () => {
    const p = buildEpisodeOutlinePrompt({
      ...base, beatsAnchor: '- [必拍] 拔剑:「寒光一闪」',
    });
    expect(p.user).toContain('逐字锚点');
    expect(p.user).toContain('[必拍]');
    expect(p.user).toContain('寒光一闪');
  });

  it('有锚点 → system 里出现"忠于原著(最高优先)"硬约束', () => {
    const p = buildEpisodeOutlinePrompt({ ...base, chapterExcerpt: '正文若干字' });
    expect(p.system).toContain('忠于原著');
  });

  it('无锚点(旧行为)→ 不渲染锚点段,system 不含忠于原著约束(向后兼容)', () => {
    const p = buildEpisodeOutlinePrompt({ ...base });
    expect(p.user).not.toContain('本集原文锚点');
    expect(p.user).not.toContain('原文摘录');
    expect(p.system).not.toContain('忠于原著');
  });

  it('锚点段排在"本集任务"之后、"资产索引"之前', () => {
    const p = buildEpisodeOutlinePrompt({
      ...base, chapterExcerpt: '正文', assetIndex: [{ slug: 'char_1', name: '主角', kind: 'character' }],
    });
    const iTask = p.user.indexOf('本集任务');
    const iAnchor = p.user.indexOf('本集原文锚点');
    const iAsset = p.user.indexOf('资产索引');
    expect(iTask).toBeLessThan(iAnchor);
    expect(iAnchor).toBeLessThan(iAsset);
  });
});
