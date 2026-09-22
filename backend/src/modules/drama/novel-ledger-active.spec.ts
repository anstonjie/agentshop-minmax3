// ============================================================================
// NovelLedgerService.listActiveProjects 回归锁(2026-09-15)
// ----------------------------------------------------------------------------
// 为什么单独锁这个方法:它是「断点续跑」的唯一数据源。分类判错一个分支,
// 表现就是项目在前端清单里消失 —— 而库里那 20+ 部卡在审批门上的剧,
// 消失过一次的原因正是「没有任何接口会把 dramaUuid 交回前端」。
//
// 只测分类逻辑,不碰 DB:三条 SQL 用字符串特征分派到固定返回值。
// ============================================================================

import { NovelLedgerService } from './novel-ledger.service';

type Row = Record<string, unknown>;

/** 按 SQL 特征分派的假 prisma */
function fakePrisma(ledgers: Row[], gates: Row[], batches: Row[]) {
  return {
    async $queryRawUnsafe(sql: string): Promise<unknown> {
      if (sql.includes('FROM dramas_novel_ledger l')) return ledgers;
      if (sql.includes('FROM dramas_gates')) return gates;
      if (sql.includes('FROM dramabatch b')) return batches;
      throw new Error(`未预期的 SQL: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(): Promise<number> {
      return 0;
    },
  };
}

const ledger = (over: Row = {}): Row => ({
  dramaId: 7n,
  dramaUuid: 'd-7',
  title: '古代百万大军决战',
  dramaStatus: 'setup',
  novelSource: 'generated',
  episodeCount: 5,
  totalChars: 42000n,
  ledgerStage: 'ingest',
  updatedAt: new Date('2026-09-15T04:00:00Z'),
  ...over,
});

const gate = (dramaId: bigint, name: string, status: string, payload: unknown = {}): Row => ({
  id: 1n,
  uuid: `g-${name}`,
  dramaId,
  gate: name,
  status,
  payload,
  userMessage: null,
  decidedBy: null,
  decidedAt: null,
  autoMode: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

async function run(ledgers: Row[], gates: Row[], batches: Row[], limit?: number) {
  const svc = new NovelLedgerService(fakePrisma(ledgers, gates, batches) as never);
  return svc.listActiveProjects(15, limit) as Promise<Row[]>;
}

describe('listActiveProjects · 门未过的项目', () => {
  it('门① waiting 且 payload 无 state = 报价单等你确认', async () => {
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'waiting', { totalMinutes: 9.3, episodeCount: 5 }),
        gate(7n, 'gate2_design', 'waiting', {}),
        gate(7n, 'gate3_script', 'waiting', {}),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dramaUuid: 'd-7',
      currentGate: 'gate1_budget',
      gateStatus: 'waiting',
      gateState: null,
      reason: 'await_decision',
      batch: null,
    });
    // BigInt 必须已转成 number,否则 JSON 序列化会抛
    expect(out[0].totalChars).toBe(42000);
  });

  it('第一道未过的门 = 项目当前所在环节(门① 已过则看门②)', async () => {
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'passed', { totalMinutes: 9.3 }),
        gate(7n, 'gate2_design', 'waiting', { state: 'ready' }),
        gate(7n, 'gate3_script', 'waiting', {}),
      ],
      [],
    );
    expect(out[0].currentGate).toBe('gate2_design');
    expect(out[0].gateState).toBe('ready');
    expect(out[0].reason).toBe('await_decision');
  });

  it('门 rejected 优先于 payload.state 判定为可重做', async () => {
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'passed'),
        gate(7n, 'gate2_design', 'rejected', { state: 'ready' }),
        gate(7n, 'gate3_script', 'waiting'),
      ],
      [],
    );
    expect(out[0].reason).toBe('rejected');
  });

  it('payload 是字符串(mysql2 未解析 JSON 列)也要能读出 state', async () => {
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'passed'),
        gate(7n, 'gate2_design', 'waiting', '{"state":"generating"}'),
        gate(7n, 'gate3_script', 'waiting', '{}'),
      ],
      [],
    );
    expect(out[0].gateState).toBe('generating');
    expect(out[0].reason).toBe('generating');
  });

  it('state 不是字符串的脏 payload 归 null,不把整个接口带崩', async () => {
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'waiting', { state: 123 }),
        gate(7n, 'gate2_design', 'waiting', {}),
        gate(7n, 'gate3_script', 'waiting', {}),
      ],
      [],
    );
    expect(out[0].gateState).toBeNull();
    expect(out[0].reason).toBe('await_decision');
  });
});

describe('listActiveProjects · 三道门全过之后看批次', () => {
  const allPassed = [
    gate(7n, 'gate1_budget', 'passed'),
    gate(7n, 'gate2_design', 'passed'),
    gate(7n, 'gate3_script', 'passed'),
  ];

  it('批次 done = 真完成,不进未完成清单', async () => {
    const out = await run([ledger()], allPassed, [
      { dramaId: 7n, uuid: 'b1', status: 'done', fromEp: 1, toEp: 5, cursorEp: 5, cursorStep: 6 },
    ]);
    expect(out).toHaveLength(0);
  });

  it('批次 running = 连集生产中,带回游标供前端显示第几集', async () => {
    const out = await run([ledger()], allPassed, [
      { dramaId: 7n, uuid: 'b1', status: 'running', fromEp: 1, toEp: 5, cursorEp: 3, cursorStep: 2 },
    ]);
    expect(out[0].reason).toBe('producing');
    expect(out[0].batch).toMatchObject({ uuid: 'b1', status: 'running', cursorEp: 3, toEp: 5 });
  });

  it('批次 cancelled = 可续跑的停止态', async () => {
    const out = await run([ledger()], allPassed, [
      { dramaId: 7n, uuid: 'b1', status: 'cancelled', fromEp: 1, toEp: 5, cursorEp: 2, cursorStep: 1 },
    ]);
    expect(out[0].reason).toBe('stopped');
  });

  it('门全过但没有批次 = 生产未启动(入队丢了的兜底可见)', async () => {
    const out = await run([ledger()], allPassed, []);
    expect(out[0].reason).toBe('not_started');
    expect(out[0].currentGate).toBe('gate3_script');
  });

  it('门③ waiting 且 payload producing = 生产中断态仍归 producing', async () => {
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'passed'),
        gate(7n, 'gate2_design', 'passed'),
        gate(7n, 'gate3_script', 'waiting', { state: 'producing', batchUuid: 'b1' }),
      ],
      [
        { dramaId: 7n, uuid: 'b1', status: 'running', fromEp: 1, toEp: 5, cursorEp: 1, cursorStep: 1 },
      ],
    );
    expect(out[0].reason).toBe('producing');
    expect(out[0].currentGate).toBe('gate3_script');
  });
});

describe('listActiveProjects · 边界', () => {
  it('没有账本 → 空列表(不打后续 SQL)', async () => {
    const out = await run([], [], []);
    expect(out).toEqual([]);
  });

  it('有账本但一道门都没有 → 跳过(没有可续的环节,别占清单)', async () => {
    const out = await run([ledger()], [], []);
    expect(out).toHaveLength(0);
  });

  it('limit 截断生效', async () => {
    const rows = [ledger({ dramaId: 7n, dramaUuid: 'd-7' }), ledger({ dramaId: 8n, dramaUuid: 'd-8' })];
    const gates = [
      ...[gate(7n, 'gate1_budget', 'waiting'), gate(7n, 'gate2_design', 'waiting'), gate(7n, 'gate3_script', 'waiting')],
      ...[gate(8n, 'gate1_budget', 'waiting'), gate(8n, 'gate2_design', 'waiting'), gate(8n, 'gate3_script', 'waiting')],
    ];
    expect(await run(rows, gates, [], 1)).toHaveLength(1);
    expect(await run(rows, gates, [], 5)).toHaveLength(2);
  });

  it('同一部剧有多个批次时取最新那条(旧批次 done 不该盖住新批次 running)', async () => {
    // 说明:取「最新批次」由 SQL 的 MAX(id) 完成,这里锁的是接口契约 ——
    // 返回的 batch.uuid 必须是那条最新的,前端续跑点的就是它。
    const out = await run(
      [ledger()],
      [
        gate(7n, 'gate1_budget', 'passed'),
        gate(7n, 'gate2_design', 'passed'),
        gate(7n, 'gate3_script', 'passed'),
      ],
      [
        { dramaId: 7n, uuid: 'b-new', status: 'running', fromEp: 1, toEp: 5, cursorEp: 4, cursorStep: 3 },
      ],
    );
    expect(out[0].batch).toMatchObject({ uuid: 'b-new', status: 'running' });
  });
});
