// ============================================================================
// 账本欠账自愈 sweepLedgerDebts 单测
// ----------------------------------------------------------------------------
// 这里的每一条都是**静默失效型**,且判错方向代价不对等:
//   · 漏清伏笔键 → I3 一直挂 30 条 warn,用户以为账本有问题
//   · 误清成对键 → 丢掉真实的伏笔↔回收关系(不可逆的语义损失)
//   · 给没拍的集回填 covered → 校验器对一部没开拍的剧报"全部覆盖",
//     比漏报更糟(它会让"完全对齐小说"这个验收变成假的)
// 所以"该不该动"和"动多少"必须逐条钉死。
// ============================================================================

import { NovelLedgerService } from './novel-ledger.service';

type Row = Record<string, unknown>;

interface Recorder {
  updates: Array<{ sql: string; args: unknown[] }>;
  syncCalls: number;
}

/** 按 SQL 特征分派的假 prisma;ledgerJson 用函数返回,便于断言写回内容 */
function fakePrisma(
  ledgerRows: Row[],
  episodes: Row[],
): { prisma: any; rec: Recorder } {
  const rec: Recorder = { updates: [], syncCalls: 0 };
  const prisma = {
    async $queryRawUnsafe(sql: string, ...args: unknown[]): Promise<unknown> {
      rec.updates.push({ sql, args }); // syncBeats 的 DELETE 走的是 query,也要记
      // 取全部账本(sweep 入口)
      if (sql.includes('FROM dramas_novel_ledger')) return ledgerRows;
      // 查已生产完成的集
      if (sql.includes('FROM `DramaEpisode`')) return episodes;
      // syncBeats 的清空与重写(DML 走的是 queryRawUnsafe,不是 execute)
      if (sql.includes('DELETE FROM dramas_novel_beats')) return [];
      if (sql.includes('INSERT INTO dramas_novel_beats')) return [];
      throw new Error(`未预期的查询 SQL: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> {
      rec.updates.push({ sql, args });
      if (sql.includes('dramas_novel_beats')) rec.syncCalls++;
      return 1;
    },
  };
  return { prisma, rec };
}

const ledgerRow = (dramaId: bigint, lj: any): Row => ({
  id: 43n, dramaId, ledgerJson: lj,
});

/** 已生产完成的集(step5 成片 / status=done) */
const epDone = (epNo: number, hookOut: string | null = null) => ({ epNo, step: 5, status: 'done', hookOut });
const epPending = (epNo: number) => ({ epNo, step: 2, status: 'keyframe' });

const baseLedger = (beats: any[], chapters?: any[]): any => ({
  meta: { version: 14 },
  chapters: chapters || [
    { id: 'ch_0001', episode_ids: ['ep_001'] },
    { id: 'ch_0002', episode_ids: ['ep_001'] },
  ],
  episodes: [{ id: 'ep_001', chapters: ['ch_0001', 'ch_0002'] }],
  beats,
});

/**
 * "有没有真的写账本"。
 * ⚠ 不能用 updates.length:producedEpisodeIds 查集是只读查询,也会进 updates。
 */
const ledgerWrites = (rec: Recorder) =>
  rec.updates.filter((u) => u.sql.includes('UPDATE dramas_novel_ledger')).length;

const beat = (id: string, over: any = {}) => ({
  id, chapter: 'ch_0001', type: 'plot', quote: '一句足够长的原文锚点',
  summary: '摘要', must_show: true, foreshadow_pair: null, ...over,
});

describe('sweepLedgerDebts —— 伏笔配对自愈(I3)', () => {
  it('单边键(只出现一次)→ 清掉', async () => {
    const lj = baseLedger([beat('b1', { foreshadow_pair: 'memory_bet' })]);
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], []);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.pairsCleared).toBe(1);
    expect(lj.beats[0].foreshadow_pair).toBeNull();
    expect(ledgerWrites(rec)).toBe(1); // 写回账本 + 投影同步
  });

  it('同型键(两边都是 foreshadow)→ 也清掉(缺 reveal 那一半)', async () => {
    const lj = baseLedger([
      beat('b1', { type: 'foreshadow', foreshadow_pair: 'blank_key' }),
      beat('b2', { type: 'foreshadow', foreshadow_pair: 'blank_key' }),
    ]);
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], []);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.pairsCleared).toBe(2);
    expect(lj.beats.every((b: any) => b.foreshadow_pair === null)).toBe(true);
  });

  it('⚠ type 不止一种但没凑齐 foreshadow+reveal(如 reveal+emotion)→ 也要清', async () => {
    // 2026-09-22 实测漏网:第一版只判"type ≥2 种"就保留,校验器照样报 I3。
    // 剧 83 的 fake_memory 就是 reveal + emotion。
    const lj = baseLedger([
      beat('b1', { type: 'reveal', foreshadow_pair: 'fake_memory' }),
      beat('b2', { type: 'emotion', foreshadow_pair: 'fake_memory' }),
    ]);
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], []);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.pairsCleared).toBe(2);
    expect(lj.beats.every((b: any) => b.foreshadow_pair === null)).toBe(true);
  });

  it('⚠ 埋在收之后(reveal 排在 foreshadow 前面)→ 清,顺序也是判据', async () => {
    // 校验器原文案:「埋伏笔的章节反而出现在回收之后」
    const lj = baseLedger([
      beat('b1', { type: 'reveal', foreshadow_pair: 'guardian_instruction' }),
      beat('b2', { type: 'foreshadow', foreshadow_pair: 'guardian_instruction' }),
    ]);
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], []);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.pairsCleared).toBe(2);
  });

  it('成对(foreshadow + reveal)→ 必须保留,清掉就是不可逆的语义损失', async () => {
    const lj = baseLedger([
      beat('b1', { type: 'foreshadow', foreshadow_pair: 'real_pair' }),
      beat('b2', { type: 'reveal', foreshadow_pair: 'real_pair' }),
    ]);
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], []);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.pairsCleared).toBe(0);
    expect(lj.beats.map((b: any) => b.foreshadow_pair)).toEqual(['real_pair', 'real_pair']);
    // 没有欠账就不该写库(避免每 5 分钟无谓重写账本)
    expect(ledgerWrites(rec)).toBe(0);
  });
});

describe('sweepLedgerDebts —— 覆盖回填(COV-1)', () => {
  it('已生产完成的集 → 回填它覆盖章节的 beat', async () => {
    const lj = baseLedger([beat('b1'), beat('b2', { chapter: 'ch_0002' })]);
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], [epDone(1)]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.beatsCovered).toBe(2);
    expect(lj.beats[0]).toMatchObject({ status: 'covered', covered_by: 'ep_001' });
    expect(lj.beats[1]).toMatchObject({ status: 'covered', covered_by: 'ep_001' });
  });

  it('⚠ 计划分集 ≠ 已拍摄:没完成的集一律不回填(不能造假)', async () => {
    const lj = baseLedger([beat('b1')]);
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], [epPending(1)]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.beatsCovered).toBe(0);
    expect(lj.beats[0].status).toBeUndefined();
    expect(ledgerWrites(rec)).toBe(0);
  });

  it('该集还没拍出来(章节映射到未完成的集)→ 不回填', async () => {
    // ch_0002 只被 ep_002 覆盖,而 ep_002 还在跑
    const lj = baseLedger(
      [beat('b1'), beat('b2', { chapter: 'ch_0002' })],
      [
        { id: 'ch_0001', episode_ids: ['ep_001'] },
        { id: 'ch_0002', episode_ids: ['ep_002'] },
      ],
    );
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], [epDone(1), epPending(2)]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.beatsCovered).toBe(1);
    expect(lj.beats[0]).toMatchObject({ status: 'covered', covered_by: 'ep_001' });
    expect(lj.beats[1].status).toBeUndefined();
  });

  it('幂等:已回填的 beat 不重复计数、不重复写', async () => {
    const lj = baseLedger([beat('b1', { status: 'covered', covered_by: 'ep_001' })]);
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], [epDone(1)]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.beatsCovered).toBe(0);
    expect(ledgerWrites(rec)).toBe(0);
  });

  it('写回时 ledgerVersion 必须 +1(前端靠它判断账本变了)', async () => {
    const lj = baseLedger([beat('b1', { foreshadow_pair: 'x' }), beat('b2')]);
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], [epDone(1)]);
    const svc = new NovelLedgerService(prisma as any);
    await svc.sweepLedgerDebts();
    expect(lj.meta.version).toBe(15);
    const upd = rec.updates.find((u) => u.sql.includes('UPDATE dramas_novel_ledger'));
    expect(upd?.args[1]).toBe(15);
  });

  it('投影必须跟着同步,否则校验器读的还是旧数据(之前就栽在这)', async () => {
    const lj = baseLedger([beat('b1')]);
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], [epDone(1)]);
    const svc = new NovelLedgerService(prisma as any);
    await svc.sweepLedgerDebts();
    expect(rec.updates.some((u) => u.sql.includes('DELETE FROM dramas_novel_beats'))).toBe(true);
    expect(rec.updates.some((u) => u.sql.includes('INSERT INTO dramas_novel_beats'))).toBe(true);
  });
});


describe('sweepLedgerDebts —— 集尾卡点(I6)', () => {
  it('cliffhanger 为空 → 用该集真实产出的 hookOut 补(不是编造)', async () => {
    const lj = baseLedger([beat('b1')]);
    lj.episodes = [{ id: 'ep_001', chapters: ['ch_0001'], cliffhanger: '' }];
    const { prisma } = fakePrisma(
      [ledgerRow(83n, lj)],
      [epDone(1, '顾言低语誓言，眼神转为疯狂与坚毅')],
    );
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.cliffhangersFixed).toBe(1);
    expect(lj.episodes[0].cliffhanger).toBe('顾言低语誓言，眼神转为疯狂与坚毅');
  });

  it('该集没拍完 → 不补(没拍出来的集不该有集尾卡点)', async () => {
    const lj = baseLedger([beat('b1')]);
    lj.episodes = [{ id: 'ep_001', chapters: ['ch_0001'], cliffhanger: '' }];
    const { prisma, rec } = fakePrisma(
      [ledgerRow(83n, lj)],
      [{ epNo: 1, step: 2, status: 'keyframe', hookOut: '不存在的卡点' }],
    );
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.cliffhangersFixed).toBe(0);
    expect(lj.episodes[0].cliffhanger).toBe('');
    expect(ledgerWrites(rec)).toBe(0);
  });

  it('已有 cliffhanger 的集不动(幂等,也不覆盖人工编辑)', async () => {
    const lj = baseLedger([beat('b1')]);
    lj.episodes = [{ id: 'ep_001', chapters: ['ch_0001'], cliffhanger: '人工写的卡点' }];
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], [epDone(1, '机器生成的卡点')]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.cliffhangersFixed).toBe(0);
    expect(lj.episodes[0].cliffhanger).toBe('人工写的卡点');
  });

  it('hookOut 也是空 → 无从补起,保持空(不能凭空造)', async () => {
    const lj = baseLedger([beat('b1')]);
    lj.episodes = [{ id: 'ep_001', chapters: ['ch_0001'], cliffhanger: '' }];
    // 注意:这条里 beat 仍会被 COV-1 回填,所以账本**会**被写 ——
    // 这里要断言的是 cliffhanger 没被凭空编出来,不是"没写库"。
    const { prisma } = fakePrisma([ledgerRow(83n, lj)], [epDone(1, null)]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.cliffhangersFixed).toBe(0);
    expect(lj.episodes[0].cliffhanger).toBe('');
  });
});

describe('sweepLedgerDebts —— 边界与健壮性', () => {
  it('没有 beats 的账本跳过,不写库', async () => {
    const lj = { meta: { version: 1 }, chapters: [], episodes: [], beats: [] };
    const { prisma, rec } = fakePrisma([ledgerRow(83n, lj)], [epDone(1)]);
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.ledgers).toBe(0);
    expect(ledgerWrites(rec)).toBe(0);
  });

  it('ledgerJson 是坏 JSON → 跳过,不能把整个巡检带崩', async () => {
    const { prisma } = fakePrisma([{ id: 1n, dramaId: 9n, ledgerJson: '{not json' }], []);
    const svc = new NovelLedgerService(prisma as any);
    await expect(svc.sweepLedgerDebts()).resolves.toEqual({
      ledgers: 0, pairsCleared: 0, beatsCovered: 0, cliffhangersFixed: 0,
    });
  });

  it('多份账本分别统计', async () => {
    const lj1 = baseLedger([beat('b1', { foreshadow_pair: 'solo' })]);
    const lj2 = baseLedger([beat('b1'), beat('b2')]);
    const { prisma } = fakePrisma(
      [ledgerRow(83n, lj1), ledgerRow(84n, lj2)],
      [epDone(1)],
    );
    const svc = new NovelLedgerService(prisma as any);
    const r = await svc.sweepLedgerDebts();
    expect(r.ledgers).toBe(2);
    expect(r.pairsCleared).toBe(1);
    expect(r.beatsCovered).toBe(3); // 1 + 2
  });
});
