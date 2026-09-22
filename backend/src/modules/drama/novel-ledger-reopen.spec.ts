// ============================================================================
// NovelLedgerService.reopenGate 回归锁(2026-09-15)
// ----------------------------------------------------------------------------
// 为什么单独锁这一个方法:它是「驳回死锁」的唯一出口。
//
// 背景:`decideGate` 对非 waiting 状态直接抛 ConflictException,而在此之前
// 全链路没有任何 un-reject 入口 —— 于是「驳回」实际是**终态**。用户手滑点一次,
// 整部剧连同账本、已生成的角色/场景资产一起废掉,唯一出路是删项目重来。
// 实测剧 42 停在 gate2_design=rejected,任何界面都救不回来。
//
// 这里钉死四件事:
//   ① rejected → waiting 成功,且**payload 原样保留**(里面常躺着 ready 产物)
//   ② waiting 幂等(前端重试不该报错)
//   ③ passed 必须拒绝(那是"回退已完成的阶段",要连带作废下游产物,语义不同)
//   ④ 不存在的门抛 NotFound,不要静默成功
// ============================================================================

import { NovelLedgerService } from './novel-ledger.service';

type Row = Record<string, unknown>;

/** 记录下所有 UPDATE 的假 prisma,按 SQL 特征分派读取 */
function fakePrisma(ledgerRows: Row[], gateRows: Row[]) {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  return {
    updates,
    async $queryRawUnsafe(sql: string): Promise<unknown> {
      // 顺序要紧:`ORDER BY gate` 是 getByDrama 的读法,单门查询没有 ORDER BY
      if (sql.includes('FROM dramas_gates') && sql.includes('ORDER BY gate')) {
        return gateRows;
      }
      if (sql.includes('FROM dramas_gates')) {
        // WHERE dramaId = ? AND gate = ?
        return gateRows;
      }
      if (sql.includes('FROM dramas_novel_ledger')) return ledgerRows;
      throw new Error(`未预期的 SQL: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> {
      updates.push({ sql, args });
      return 1;
    },
  };
}

const gateRow = (status: string, payload: unknown = {}): Row => ({
  id: 1n,
  uuid: 'g-gate2',
  dramaId: 42n,
  gate: 'gate2_design',
  status,
  payload,
  userMessage: null,
  decidedBy: 15n,
  decidedAt: new Date('2026-09-14T10:00:00Z'),
  autoMode: 0,
  createdAt: new Date('2026-09-13T10:00:00Z'),
  updatedAt: new Date('2026-09-14T10:00:00Z'),
});

const ledgerRow = (): Row => ({
  id: 1n,
  uuid: 'l-1',
  dramaId: 42n,
  userId: 15n,
  novelTitle: '被驳回的剧',
  novelSource: 'generated',
  episodeCount: 5,
  totalChars: 14000n,
  totalMinutes: 11.6,
  kEff: 8.35,
  stage: 'ingest',
  ledgerVersion: 1,
  ledgerJson: JSON.stringify({ episodes: [{ epNo: 1 }, { epNo: 2 }], meta: {} }),
  novelStorageKey: 'uploads/x.txt',
  createdAt: new Date(),
  updatedAt: new Date(),
});

function build(ledgerRows: Row[], gateRows: Row[]) {
  const prisma = fakePrisma(ledgerRows, gateRows);
  const svc = new NovelLedgerService(prisma as never);
  return { svc, prisma };
}

describe('reopenGate · 驳回不再是终态', () => {
  it('rejected → waiting:写回 status=waiting 并清掉决策人/决策时间', async () => {
    const { svc, prisma } = build([ledgerRow()], [gateRow('rejected')]);
    const out = await svc.reopenGate(15n, 42n, 'gate2_design');

    expect(prisma.updates).toHaveLength(1);
    const { sql, args } = prisma.updates[0];
    expect(sql).toContain("status = 'waiting'");
    expect(sql).toContain('decidedBy = NULL');
    expect(sql).toContain('decidedAt = NULL');
    expect(sql).toContain('userMessage = NULL');
    expect(args[1]).toBe(42n);
    expect(args[2]).toBe('gate2_design');
    // 返回值是整份账本(前端直接拿它刷界面)。BigInt 列经 jsonify 出来是字符串。
    expect(out).toMatchObject({ dramaId: '42' });
  });

  it('payload 原样保留 —— 驳回时门里常躺着 ready 产物,不该被顺手清掉', async () => {
    const payload = {
      state: 'ready',
      characters: [{ name: '林雅' }],
      createdCount: 3,
      rejectedAt: '2026-09-14T10:00:00.000Z',
      rejectedNote: '角色画风不对',
    };
    const { svc, prisma } = build([ledgerRow()], [gateRow('rejected', payload)]);
    await svc.reopenGate(15n, 42n, 'gate2_design');

    const written = JSON.parse(String(prisma.updates[0].args[0]));
    expect(written.characters).toEqual([{ name: '林雅' }]);
    expect(written.state).toBe('ready');
    expect(written.createdCount).toBe(3);
    // 驳回备注保留:reopen 之后用户还能看见自己当初为什么否掉
    expect(written.rejectedNote).toBe('角色画风不对');
    // 追加审计字段
    expect(written.reopenedFrom).toBe('rejected');
    expect(typeof written.reopenedAt).toBe('string');
  });

  it('没有驳回备注时不凭空造一个 rejectedNote 字段', async () => {
    const { svc, prisma } = build([ledgerRow()], [gateRow('rejected', { state: 'ready' })]);
    await svc.reopenGate(15n, 42n, 'gate2_design');
    const written = JSON.parse(String(prisma.updates[0].args[0]));
    expect('rejectedNote' in written).toBe(false);
  });

  it('waiting 幂等:不写库,直接回账本(前端重试不该报错)', async () => {
    const { svc, prisma } = build([ledgerRow()], [gateRow('waiting')]);
    const out = await svc.reopenGate(15n, 42n, 'gate2_design');
    expect(prisma.updates).toHaveLength(0);
    expect(out).toMatchObject({ dramaId: '42' });
  });

  it('passed 必须拒绝 —— 回退已通过的门是另一件事,会连带作废下游产物', async () => {
    const { svc, prisma } = build([ledgerRow()], [gateRow('passed')]);
    await expect(svc.reopenGate(15n, 42n, 'gate2_design')).rejects.toThrow(/passed/);
    expect(prisma.updates).toHaveLength(0);
  });

  it('门不存在 → NotFound,不能静默成功', async () => {
    const { svc } = build([ledgerRow()], []);
    await expect(svc.reopenGate(15n, 42n, 'gate2_design')).rejects.toThrow();
  });

  it('非法门名在碰库之前就被拦下', async () => {
    const { svc, prisma } = build([ledgerRow()], [gateRow('rejected')]);
    await expect(svc.reopenGate(15n, 42n, 'gate9_fake')).rejects.toThrow();
    expect(prisma.updates).toHaveLength(0);
  });
});

describe('decideGate · 驳回时的错误信息要指路', () => {
  it('已驳回的门再决策 → 报错里带上 reopen 的调用方式', async () => {
    const { svc } = build([ledgerRow()], [gateRow('rejected')]);
    await expect(svc.decideGate(15n, 42n, 'gate2_design', 'passed'))
      .rejects.toThrow(/reopen/);
  });

  it('已通过的门再决策 → 报错说明当前状态', async () => {
    const { svc } = build([ledgerRow()], [gateRow('passed')]);
    await expect(svc.decideGate(15n, 42n, 'gate2_design', 'passed'))
      .rejects.toThrow(/passed/);
  });

  it('驳回时把 rejectedAt 落进 payload,reopen 后仍可见', async () => {
    const { svc, prisma } = build([ledgerRow()], [gateRow('waiting', { state: 'ready' })]);
    await svc.decideGate(15n, 42n, 'gate2_design', 'rejected', '角色画风不对');
    const written = JSON.parse(String(prisma.updates[0].args[3]));
    expect(written.rejectedNote).toBe('角色画风不对');
    expect(typeof written.rejectedAt).toBe('string');
    expect(written.state).toBe('ready'); // 产物不动
  });
});

describe('backfillQuote · 老报价单读时补价,不写库', () => {
  it('缺价格的旧报价单会被补上积分/镜头/耗时,并标记 quoteEstimated', async () => {
    const oldQuote = { totalMinutes: 11.6, episodeCount: 6, novelChars: 14000 };
    const { svc, prisma } = build(
      [ledgerRow()],
      [{
        ...gateRow('waiting', oldQuote),
        gate: 'gate1_budget',
      }],
    );
    const out = await svc.getByDrama(15n, 42n) as { gates: Row[] };
    const payload = out.gates[0].payload as Row;
    expect(payload.quoteEstimated).toBe(true);
    expect(Number(payload.estimatedCredits)).toBeGreaterThan(0);
    expect(Number(payload.estimatedShots)).toBeGreaterThan(0);
    expect(Number(payload.shotsPerEpisode)).toBeGreaterThan(0);
    expect(Number(payload.estimatedWallMinutes)).toBeGreaterThan(0);
    // 只读路径不能有副作用
    expect(prisma.updates).toHaveLength(0);
  });

  it('已有价格的报价单不覆盖(口径以落库那一刻为准)', async () => {
    const goodQuote = {
      totalMinutes: 11.6, episodeCount: 6, novelChars: 14000,
      estimatedCredits: 1234, estimatedShots: 30,
      shotsPerEpisode: 5, estimatedWallMinutes: 99, epTargetSec: 120,
    };
    const { svc } = build(
      [ledgerRow()],
      [{ ...gateRow('waiting', goodQuote), gate: 'gate1_budget' }],
    );
    const out = await svc.getByDrama(15n, 42n) as { gates: Row[] };
    const payload = out.gates[0].payload as Row;
    expect(Number(payload.estimatedCredits)).toBe(1234);
    expect(payload.quoteEstimated).toBeUndefined();
  });
});
