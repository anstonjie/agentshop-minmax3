import {
  VISUAL_QC_SYS, buildVisualQcQuestion, parseVisualQcVerdict, VISUAL_QC_MAX_REDRAW,
} from './visual-qc';

describe('visual-qc —— 定妆图质检门(2026-09-16 批4)', () => {
  it('提示词只查硬伤不评美感,且带资产名参照', () => {
    expect(VISUAL_QC_SYS).toContain('硬伤');
    expect(VISUAL_QC_SYS).toContain('不评价');
    const q = buildVisualQcQuestion('洛烛', 'character');
    expect(q).toContain('洛烛');
    expect(q).toContain('角色');
    expect(buildVisualQcQuestion('苍狼谷', 'location')).toContain('场景');
  });

  it('解析正常 JSON', () => {
    expect(parseVisualQcVerdict('{"ok": false, "issues": ["三条胳膊", "六指"]}'))
      .toEqual({ ok: false, issues: ['三条胳膊', '六指'] });
    expect(parseVisualQcVerdict('{"ok": true, "issues": []}')).toEqual({ ok: true, issues: [] });
  });

  it('容忍 markdown 围栏与前后废话', () => {
    const v = parseVisualQcVerdict('```json\n{"ok": false, "issues": ["多头"]}\n```');
    expect(v).toEqual({ ok: false, issues: ['多头'] });
    expect(parseVisualQcVerdict('判定如下 {"ok": true} 结束')).toEqual({ ok: true, issues: [] });
  });

  it('issues 截断 4 条防超长文本进库', () => {
    const v = parseVisualQcVerdict(
      `{"ok": false, "issues": ["a","b","c","d","e","f"]}`);
    expect(v?.issues).toHaveLength(4);
  });

  it('通道不可用/不可解析 → null(降级不拦,绝不打死定妆链)', () => {
    expect(parseVisualQcVerdict(null)).toBeNull();
    expect(parseVisualQcVerdict('')).toBeNull();
    expect(parseVisualQcVerdict('上游 500 了')).toBeNull();
    expect(parseVisualQcVerdict('{"issues": []}')).toBeNull(); // 缺 ok 字段
    expect(parseVisualQcVerdict('{broken')).toBeNull();
  });

  it('自动重画上限 2 次', () => {
    expect(VISUAL_QC_MAX_REDRAW).toBe(2);
  });
});
