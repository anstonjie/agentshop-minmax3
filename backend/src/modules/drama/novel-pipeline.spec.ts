// novel-pipeline 纯函数回归锁:预算估算 / 任务 uuid 提取 / 账本→故事线 / 圣经补丁
// + 2026-09-15 新增:启动时清理"上次进程被杀留下的 generating"(drama 69 事故)
import {
  estimateBudgetCredits, extractTaskUuid, arcFromLedger, bibleFromNovelBible,
  GATE_STAGE_MAP, STAGE_RESULT_GATE, STAGE_INTERRUPT_MS, payloadOf,
  NovelPipelineService,
} from './novel-pipeline.service';

describe('estimateBudgetCredits', () => {
  it('单集不低于下限 1000', () => {
    expect(estimateBudgetCredits(1)).toBe(1000);
  });
  it('每集 600×1.2=720 向上取整', () => {
    expect(estimateBudgetCredits(8)).toBe(5760);
    expect(estimateBudgetCredits(100)).toBe(72000);
  });
  it('非法输入兜底为 1 集', () => {
    expect(estimateBudgetCredits(0)).toBe(1000);
    expect(estimateBudgetCredits(NaN)).toBe(1000);
    expect(estimateBudgetCredits(-5)).toBe(1000);
  });
});

describe('extractTaskUuid', () => {
  it('从 novelStorageKey 提取任务 uuid', () => {
    const u = '0cc24801-1436-4847-a88f-162e655077c8';
    expect(extractTaskUuid(`drama-novel/${u}.txt`)).toBe(u);
  });
  it('非生成来源/异常形态返回 null', () => {
    expect(extractTaskUuid(null)).toBeNull();
    expect(extractTaskUuid('')).toBeNull();
    expect(extractTaskUuid('drama-novel/sha256content.txt')).toBeNull();
    expect(extractTaskUuid('other-dir/0cc24801-1436-4847-a88f-162e655077c8.txt')).toBeNull();
  });
});

describe('arcFromLedger', () => {
  const ledger = {
    chapters: [
      { id: 'c1', title: '第1章 坠落' },
      { id: 'c2', title: '第2章 觉醒' },
      { id: 'c3', title: '第3章 重逢' },
    ],
    episodes: [
      { id: 'e1', chapters: ['c1', 'c2'], cliffhanger: '谁是内鬼?' },
      { id: 'e2', chapters: ['c3'], cliffhanger: '' },
    ],
  };

  it('每集 purpose = 覆盖章节标题拼接,cliffhanger 透传', () => {
    const arc = arcFromLedger(ledger);
    expect(arc).toHaveLength(2);
    expect(arc[0]).toEqual({ ep: 1, purpose: '第1章 坠落 / 第2章 觉醒', cliffhanger: '谁是内鬼?' });
    expect(arc[1]).toEqual({ ep: 2, purpose: '第3章 重逢', cliffhanger: '' });
  });
  it('有 beats 时 purpose 拼 beats summary(批2:大纲锚点看得到剧情)', () => {
    const arc = arcFromLedger({
      ...ledger,
      beats: [
        { chapter: 'c1', summary: '陈明坠崖捡到罗盘' },
        { chapter: 'c2', summary: '罗盘能力觉醒' },
      ],
    });
    expect(arc[0].purpose).toContain('第1章 坠落');
    expect(arc[0].purpose).toContain('陈明坠崖捡到罗盘');
    expect(arc[0].purpose).toContain('罗盘能力觉醒');
    expect(arc[1].purpose).toBe('第3章 重逢'); // c3 无 beats → 降级标题
  });
  it('空账本安全返回空数组', () => {
    expect(arcFromLedger(null)).toEqual([]);
    expect(arcFromLedger({})).toEqual([]);
  });
  it('引用不存在的章节只过滤不报错', () => {
    const arc = arcFromLedger({ chapters: [], episodes: [{ chapters: ['x'] }] });
    expect(arc[0].purpose).toBe('');
  });
});

describe('bibleFromNovelBible', () => {
  it('从小说圣经提炼 world/genre/tone/rules/relationships', () => {
    const patch = bibleFromNovelBible({
      concept: { logline: 'x', genre: '玄幻', tone: '热血' },
      storyBible: { world: '九州大陆', rules: ['灵气守恒'] },
      characters: [{ name: '林凡', role: '主角' }, { name: '', role: '' }],
    });
    expect(patch).toEqual({
      world: '九州大陆', genre: '玄幻', tone: '热血',
      rules: ['灵气守恒'], relationships: ['林凡:主角'],
    });
  });
  it('无 concept/storyBible 返回 null(入口 B 或空圣经)', () => {
    expect(bibleFromNovelBible(null)).toBeNull();
    expect(bibleFromNovelBible({})).toBeNull();
    expect(bibleFromNovelBible({ characters: [] })).toBeNull();
  });
});

describe('门-阶段映射', () => {
  it('门①→设定、门②→剧本、门③→生产', () => {
    expect(GATE_STAGE_MAP.gate1_budget).toBe('design');
    expect(GATE_STAGE_MAP.gate2_design).toBe('script');
    expect(GATE_STAGE_MAP.gate3_script).toBe('production');
  });
  it('阶段产物落回下一道门', () => {
    expect(STAGE_RESULT_GATE.design).toBe('gate2_design');
    expect(STAGE_RESULT_GATE.script).toBe('gate3_script');
    expect(STAGE_RESULT_GATE.production).toBe('gate3_script');
  });
});

describe('payloadOf', () => {
  it('对象直通 / JSON 串解析', () => {
    expect(payloadOf({ state: 'generating' })).toEqual({ state: 'generating' });
    expect(payloadOf('{"state":"ready"}')).toEqual({ state: 'ready' });
  });
  it('空值与坏 JSON 安全兜底为空对象', () => {
    expect(payloadOf(null)).toEqual({});
    expect(payloadOf(undefined)).toEqual({});
    expect(payloadOf('')).toEqual({});
    expect(payloadOf('{坏')).toEqual({});
    expect(payloadOf(42)).toEqual({});
  });
});

describe('sweepInterruptedStages(启动自愈)', () => {
  const NOW = new Date('2026-09-15T02:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  /** 造一个只带 $queryRawUnsafe 的 prisma 桩 + 记录 setGatePayload 的 ledger 桩 */
  function build(rows: any[]) {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };
    const ledger = { setGatePayload: jest.fn().mockResolvedValue(undefined) };
    const svc = new NovelPipelineService(
      prisma as any, ledger as any, {} as any, {} as any,
      // portraits(批量定妆)在本 describe 覆盖的两个自愈方法里不被调用
      { startForGate2Pass: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { svc, ledger, prisma };
  }

  // 注意:陈旧判定已下沉到 SQL(`TIMESTAMPDIFF(SECOND, updatedAt, NOW(3))`),
  // 所以桩行必须自带 staleMs —— 不能再用 `updatedAt` 让 JS 去减:
  // 这几张表的 updatedAt 是 NOW(3) 写的本地时间,Prisma 按 UTC 读会快 8 小时,
  // JS 侧相减恒为负,自愈会静默失效(2026-09-15 实测)。
  it('陈旧 generating → 落成 failed,并保留现场', async () => {
    const progress = { episodesDone: 4, episodesTotal: 5 };
    const { svc, ledger, prisma } = build([
      {
        dramaId: 69n, gate: 'gate3_script', updatedAt: ago(40 * 60_000),
        staleMs: 40 * 60_000,
        payload: { state: 'generating', ...progress },
      },
    ]);
    expect(await svc.sweepInterruptedStages(NOW)).toBe(1);
    // 阈值必须由 SQL 判定,不能退回 JS 比较
    expect(String(prisma.$queryRawUnsafe.mock.calls[0][0])).toContain('TIMESTAMPDIFF');
    const [dramaId, gate, payload] = ledger.setGatePayload.mock.calls[0];
    expect(dramaId).toBe(69n);
    expect(gate).toBe('gate3_script');
    expect(payload.state).toBe('failed');
    expect(payload.interruptedFrom).toEqual({ state: 'generating', ...progress });
    expect(payload.error).toContain('40 分钟前');
    expect(payload.interruptedAt).toBe(ago(40 * 60_000).toISOString());
  });

  it('刚写过的 generating 不动(SQL 侧已被阈值过滤,查不到行)', async () => {
    // 模拟 WHERE 把"刚写过"的行挡在外面 → 结果集为空
    const { svc, ledger } = build([]);
    expect(await svc.sweepInterruptedStages(NOW)).toBe(0);
    expect(ledger.setGatePayload).not.toHaveBeenCalled();
  });

  it('staleMs 缺失/异常时不误伤:按阈值兜底', async () => {
    const { svc, ledger } = build([
      { dramaId: 71n, gate: 'gate3_script', payload: { state: 'generating' }, updatedAt: ago(STAGE_INTERRUPT_MS) },
    ]);
    expect(await svc.sweepInterruptedStages(NOW)).toBe(1);
    expect(ledger.setGatePayload.mock.calls[0][2].error).toContain('3 分钟前');
  });

  it('非 generating 的 payload 一律不动(双保险)', async () => {
    const { svc, ledger } = build([
      { dramaId: 73n, gate: 'gate3_script', payload: { state: 'ready' }, updatedAt: ago(9 * 3600_000) },
      { dramaId: 74n, gate: 'gate2_design', payload: null, updatedAt: ago(9 * 3600_000) },
    ]);
    expect(await svc.sweepInterruptedStages(NOW)).toBe(0);
    expect(ledger.setGatePayload).not.toHaveBeenCalled();
  });

  it('payload 是 JSON 字符串时也能识别', async () => {
    const { svc } = build([
      { dramaId: 75n, gate: 'gate2_design', payload: '{"state":"generating"}', updatedAt: ago(3600_000) },
    ]);
    expect(await svc.sweepInterruptedStages(NOW)).toBe(1);
  });
});

describe('sweepOrphanedProducingGates(启动自愈 · 批次已终态)', () => {
  /** 造一个只带 $queryRawUnsafe 的 prisma 桩 + 记录 setGatePayload 的 ledger 桩 */
  function build(rows: any[]) {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };
    const ledger = { setGatePayload: jest.fn().mockResolvedValue(undefined) };
    const svc = new NovelPipelineService(
      prisma as any, ledger as any, {} as any, {} as any,
      // portraits(批量定妆)在本 describe 覆盖的两个自愈方法里不被调用
      { startForGate2Pass: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { svc, ledger, prisma };
  }

  it('批次已 done 而门仍 producing → 收尾并写入 batchStatus', async () => {
    const { svc, ledger } = build([
      {
        dramaId: 59n, gate: 'gate3_script', batchStatus: 'done', batchError: null,
        payload: {
          state: 'producing', batchUuid: '4ac06134', fromEp: 1, toEp: 7,
          budgetCredits: 5040,
        },
      },
    ]);
    expect(await svc.sweepOrphanedProducingGates()).toBe(1);
    const [dramaId, gate, payload] = ledger.setGatePayload.mock.calls[0];
    expect(dramaId).toBe(59n);
    expect(gate).toBe('gate3_script');
    // state 保持 producing —— 前端靠它选渲染生产卡片;终态另写 batchStatus
    expect(payload.state).toBe('producing');
    expect(payload.batchStatus).toBe('done');
    expect(payload.batchUuid).toBe('4ac06134');
    expect(payload.settledAt).toBeTruthy();
    expect(payload.error).toBeUndefined();
  });

  it('批次 failed → 收尾并带上错误说明', async () => {
    const { svc, ledger } = build([
      {
        dramaId: 60n, gate: 'gate3_script', batchStatus: 'failed',
        batchError: 'EP3 第1步失败:LLM 超时',
        payload: { state: 'producing', batchUuid: 'dead' },
      },
    ]);
    expect(await svc.sweepOrphanedProducingGates()).toBe(1);
    const payload = ledger.setGatePayload.mock.calls[0][2];
    expect(payload.batchStatus).toBe('failed');
    expect(payload.batchError).toContain('LLM 超时');
    expect(payload.error).toContain('从断点续跑');
  });

  it('批次仍在跑 / 暂停 / 行已删 → 都不是孤儿,不动', async () => {
    const { svc, ledger } = build([
      { dramaId: 61n, gate: 'gate3_script', batchStatus: 'running', payload: { state: 'producing', batchUuid: 'a' } },
      { dramaId: 62n, gate: 'gate3_script', batchStatus: 'paused', payload: { state: 'producing', batchUuid: 'b' } },
      // LEFT JOIN 没命中 → batchStatus 为 null(批次行不存在)
      { dramaId: 63n, gate: 'gate3_script', batchStatus: null, payload: { state: 'producing', batchUuid: 'c' } },
    ]);
    expect(await svc.sweepOrphanedProducingGates()).toBe(0);
    expect(ledger.setGatePayload).not.toHaveBeenCalled();
  });

  it('已收尾过(batchStatus 与批次一致)幂等跳过', async () => {
    const { svc, ledger } = build([
      {
        dramaId: 64n, gate: 'gate3_script', batchStatus: 'done', batchError: null,
        payload: { state: 'producing', batchUuid: 'd', batchStatus: 'done' },
      },
    ]);
    expect(await svc.sweepOrphanedProducingGates()).toBe(0);
    expect(ledger.setGatePayload).not.toHaveBeenCalled();
  });

  it('payload 是 JSON 字符串也能处理', async () => {
    const { svc } = build([
      {
        dramaId: 66n, gate: 'gate3_script', batchStatus: 'cancelled', batchError: null,
        payload: '{"state":"producing","batchUuid":"e"}',
      },
    ]);
    expect(await svc.sweepOrphanedProducingGates()).toBe(1);
  });
});
