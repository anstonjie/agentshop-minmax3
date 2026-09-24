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

  // 2026-09-23 回归:服装卡里出现人的头像(应只有衣服本身)
  it('服装 kind 标签是「服装」,且质检问题点名"出现人物即硬伤"', () => {
    const q = buildVisualQcQuestion('米白衬衫', 'wardrobe');
    expect(q).toContain('服装');
    expect(q).toContain('米白衬衫');
    expect(q).toContain('出现任何人物');
    expect(VISUAL_QC_SYS).toContain('服装设定图中出现人物');
  });

  it('载具 kind 标签是「载具」,不再误标成道具', () => {
    expect(buildVisualQcQuestion('渔船', 'vehicle')).toContain('载具');
  });

  // 2026-09-23 批5:QC 只检第 1 张视图且不带 angle → 背面画成正面检不出
  it('带 angle 时点名视图,背面图出现正脸五官判硬伤', () => {
    const q = buildVisualQcQuestion('洛烛', 'character', '背面');
    expect(q).toContain('背面');
    expect(q).toContain('正脸');
  });

  it('不带 angle 仍可用(向后兼容,不出现 undefined 字样)', () => {
    const q = buildVisualQcQuestion('洛烛', 'character');
    expect(q).not.toContain('undefined');
    expect(q).not.toContain('「」');
  });

  // 2026-09-23 批5:turnaround 多人合影是历史坑,QC 一直检不出
  it('角色质检要求恰好一名角色,多人合影判硬伤', () => {
    const q = buildVisualQcQuestion('洛烛', 'character');
    expect(q).toContain('恰好一名');
    expect(VISUAL_QC_SYS).toContain('合影');
  });

  // 2026-09-23 批5:场景路人 / 载具司机经资产参考图带进关键帧,QC 一直检不出
  it('场景/载具质检:出现人物(路人/司机乘客)即硬伤', () => {
    expect(buildVisualQcQuestion('雨夜码头', 'location')).toContain('路人');
    expect(buildVisualQcQuestion('渔船', 'vehicle')).toContain('驾驶员');
    expect(VISUAL_QC_SYS).toContain('载具');
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
