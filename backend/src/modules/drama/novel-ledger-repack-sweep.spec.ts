// ============================================================================
// NovelLedgerService.sweepStaleRepacking 回归锁(2026-09-21)
// ----------------------------------------------------------------------------
// 为什么单独锁这一个方法:它是「门①永久卡死」的唯一出口。
//
// 背景(2026-09-21 实测事故):ingest 后后台 runBeatsAndRepack 抽 beats/重排分集,
// 期间 gate1 payload repacking=true,decideGate 一律 409「正在按章节节拍优化
// 分集并重算报价」。但该任务活在后端进程内存里 —— nest --watch 重启 / 崩溃后
// finally 里的 clearRepackingFlag 不会跑,标志永驻 true,用户点「确认报价」永远
// 得到同一句提示,项目卡死在门①。sweepInterruptedStages 只扫门②/③ 的
// generating,没人管门①这个标志。
//
// 这里钉死三件事:
//   ① 旧进程遗留(repackingAt 早于本进程 startedAt,含没有 repackingAt 的老数据)
//      → 清 repacking/repackingAt,写 repackSweptAt,返回清扫数
//   ② 本进程自己的任务(repackingAt 晚于 startedAt)→ 一个不动
//   ③ 本来就没在 repacking 的门 → 不产生任何 UPDATE
// ============================================================================

import { NovelLedgerService } from './novel-ledger.service';

type Row = Record<string, unknown>;

function fakePrisma(gateRows: Row[]) {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  return {
    updates,
    async $queryRawUnsafe(sql: string): Promise<unknown> {
      if (sql.includes('FROM dramas_gates')) return gateRows;
      if (sql.includes('FROM dramas_novel_ledger')) return [];
      throw new Error(`未预期的 SQL: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> {
      updates.push({ sql, args });
      return 1;
    },
  };
}

const gate1Row = (payload: unknown): Row => ({
  id: 7n,
  uuid: 'g-gate1',
  dramaId: 42n,
  gate: 'gate1_budget',
  status: 'waiting',
  payload,
  userMessage: null,
  decidedBy: null,
  decidedAt: null,
  autoMode: 0,
  createdAt: new Date('2026-09-21T06:00:00Z'),
  updatedAt: new Date('2026-09-21T06:00:00Z'),
});

describe('sweepStaleRepacking · 重启不再把用户永久卡在门①', () => {
  it('旧进程遗留(repackingAt 早于启动时刻)→ 清标志并记录清扫时间', async () => {
    const stale = new Date(Date.now() - 15 * 60_000).toISOString(); // 15 分钟前
    const prisma = fakePrisma([gate1Row({ repacking: true, repackingAt: stale })]);
    const svc = new NovelLedgerService(prisma as never);

    const swept = await svc.sweepStaleRepacking();

    expect(swept).toBe(1);
    expect(prisma.updates).toHaveLength(1);
    const payload = JSON.parse(String(prisma.updates[0].args[0]));
    expect(payload.repacking).toBe(false);
    expect(payload.repackingAt).toBeNull();
    expect(typeof payload.repackSweptAt).toBe('string');
    expect(prisma.updates[0].args[1]).toBe(7n);
  });

  it('老数据没有 repackingAt(at=0 视为远古遗留)→ 也清,不能永久卡死', async () => {
    const prisma = fakePrisma([gate1Row({ repacking: true })]);
    const svc = new NovelLedgerService(prisma as never);

    expect(await svc.sweepStaleRepacking()).toBe(1);
    const payload = JSON.parse(String(prisma.updates[0].args[0]));
    expect(payload.repacking).toBe(false);
  });

  it('本进程自己的任务(repackingAt 晚于启动时刻)→ 一个不动', async () => {
    const fresh = new Date(Date.now()).toISOString(); // svc 构造之后执行,必然 >= startedAt
    const prisma = fakePrisma([gate1Row({ repacking: true, repackingAt: fresh })]);
    const svc = new NovelLedgerService(prisma as never);

    expect(await svc.sweepStaleRepacking()).toBe(0);
    expect(prisma.updates).toHaveLength(0);
  });

  it('本来就没在 repacking → 不产生任何 UPDATE', async () => {
    const prisma = fakePrisma([gate1Row({ repacking: false, repackingAt: null })]);
    const svc = new NovelLedgerService(prisma as never);

    expect(await svc.sweepStaleRepacking()).toBe(0);
    expect(prisma.updates).toHaveLength(0);
  });

  it('onApplicationBootstrap 自身失败不外抛(不阻断启动)', async () => {
    const prisma = {
      async $queryRawUnsafe(): Promise<unknown> {
        throw new Error('DB 还没就绪');
      },
      async $executeRawUnsafe(): Promise<number> {
        return 1;
      },
    };
    const svc = new NovelLedgerService(prisma as never);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

// ============================================================================
// decideGate 的 repacking 409 文案:必须给真实时间预期(2026-09-21)
// 原来一句「稍候几秒」,实测每章 LLM 约 100 秒,用户等到天荒地老反复白点。
// ============================================================================

describe('decideGate · repacking 期间拒绝确认', () => {
  const buildDecide = (gatePayload: unknown, ledgerJson: unknown) => {
    const updates: Array<{ sql: string; args: unknown[] }> = [];
    const prisma = {
      updates,
      async $queryRawUnsafe(sql: string): Promise<unknown> {
        if (sql.includes('FROM dramas_novel_ledger')) {
          return [{
            id: 1n, dramaId: 42n, userId: 15n,
            ledgerJson, episodeCount: 9,
          }];
        }
        return [{
          id: 7n, dramaId: 42n, gate: 'gate1_budget', status: 'waiting',
          payload: gatePayload,
        }];
      },
      async $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> {
        updates.push({ sql, args });
        return 1;
      },
    };
    return { svc: new NovelLedgerService(prisma as never), prisma };
  };

  it('409 文案带章节数与预估时长,且 repacking 被拒时零写入', async () => {
    const { svc, prisma } = buildDecide(
      { repacking: true, repackingAt: new Date(Date.now() - 2 * 60_000).toISOString() },
      { chapters: [{}, {}, {}, {}, {}, {}, {}, {}] }, // 8 章
    );

    await expect(svc.decideGate(15n, 42n, 'gate1_budget', 'passed'))
      .rejects.toThrow(/正在按章节节拍优化分集并重算报价/);
    const err = await svc.decideGate(15n, 42n, 'gate1_budget', 'passed')
      .catch((e: unknown) => e);
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toContain('共 8 章');
    expect(msg).toContain('已等待约 2 分钟');
    expect(msg).toContain('预计还需约');
    expect(prisma.updates).toHaveLength(0); // 拒绝即拒绝,绝不顺手写库
  });

  it('repacking 已放行 → 正常走决策,不再被 409 拦', async () => {
    const { svc, prisma } = buildDecide(
      { repacking: false, repackingAt: null, estimatedCredits: 5220 },
      { chapters: [{}] },
    );

    await expect(svc.decideGate(15n, 42n, 'gate1_budget', 'passed')).resolves.toBeTruthy();
    expect(prisma.updates.length).toBeGreaterThan(0);
  });
});
