// ============================================================================
// 僵尸连集槽位巡检单测
// ----------------------------------------------------------------------------
// 这是个**纯静默失效**的功能:判错方向不同的后果完全不同 ——
//   · 漏判 → 队列被僵尸占死,之后所有批次"入队成功、一步不跑",用户干等;
//   · 误判 → 正在跑的批次被摘锁,重入队后从断点重跑(白烧一轮配额)。
// 所以三条判据(本进程在跑 / 宽限窗口 / 进度还在更新)和两个动作
// (清理 / 清理后是否续跑)必须逐条钉死,不能靠"看起来对"。
// ============================================================================
import {
  DramaOrchestrator, ZOMBIE_GRACE_MS, ZOMBIE_ACTIVE_FRESH_MS, AUTO_RESUME_COOLDOWN_MS,
} from './drama-orchestrator.service';

const mkQueue = (over: Record<string, any> = {}) => ({
  dramaQueueAvailable: true,
  listDramaActiveJobs: jest.fn().mockResolvedValue([]),
  purgeDramaJob: jest.fn().mockResolvedValue(true),
  enqueueDramaBatch: jest.fn().mockResolvedValue('batch:x'),
  ...over,
} as any);

/** batch 传 null 表示"批次记录不存在"(getBatch 抛 NotFound) */
const mkSvc = (batch: any) => ({
  getBatch: jest.fn().mockImplementation(async () => {
    if (!batch) throw new Error('批任务不存在');
    return batch;
  }),
  appendBatchLog: jest.fn().mockResolvedValue(null),
} as any);

const mkOrch = (queue: any, svc: any) =>
  new DramaOrchestrator(svc, queue, {} as any, {} as any);

/** 一条 active job。agoMs 越大表示越久以前被 worker 接手 */
const job = (batchUuid: string, processedAgoMs = 60 * 60 * 1000) => ({
  jobId: `batch:${batchUuid}`,
  batchUuid,
  timestamp: Date.now() - processedAgoMs - 1000,
  processedOn: Date.now() - processedAgoMs,
});

const runningBatch = (updatedAgoMs: number) => ({
  uuid: 'b1', status: 'running', dramaUuid: 'd1', userId: 7,
  cursorEp: 3, cursorStep: 2,
  updatedAt: new Date(Date.now() - updatedAgoMs),
});

describe('sweepZombieDramaSlots —— 什么情况下不碰', () => {
  it('队列不可用(Redis 未起)→ 直接返回 0,不调 purge', async () => {
    const q = mkQueue({ dramaQueueAvailable: false });
    const o = mkOrch(q, mkSvc(null));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
    expect(q.purgeDramaJob).not.toHaveBeenCalled();
  });

  it('队列里没有 active 任务 → 返回 0', async () => {
    const q = mkQueue();
    const o = mkOrch(q, mkSvc(null));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
    expect(q.purgeDramaJob).not.toHaveBeenCalled();
  });

  it('本进程正在跑的批次 → 是活的,绝不摘锁', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-live')]) });
    const o = mkOrch(q, mkSvc(runningBatch(60 * 60 * 1000)));
    (o as any).running.set('b-live', { cancel: false });
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
    expect(q.purgeDramaJob).not.toHaveBeenCalled();
  });

  it('worker 刚接手(宽限窗口内)→ 竞态,不动', async () => {
    const q = mkQueue({
      listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-fresh', ZOMBIE_GRACE_MS - 10_000)]),
    });
    const o = mkOrch(q, mkSvc(runningBatch(0)));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
    expect(q.purgeDramaJob).not.toHaveBeenCalled();
  });

  it('批次 3 分钟内还有进度写入 → 有活的执行者(可能是别的进程),不动', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-busy')]) });
    const o = mkOrch(q, mkSvc(runningBatch(ZOMBIE_ACTIVE_FRESH_MS - 30_000)));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
    expect(q.purgeDramaJob).not.toHaveBeenCalled();
  });

  it('updatedAt 缺失时不能当成"最近有更新" → 仍然清理(否则僵尸永久免疫)', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-nots')]) });
    const b = runningBatch(0); delete b.updatedAt;
    const o = mkOrch(q, mkSvc(b));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(1);
    expect(q.purgeDramaJob).toHaveBeenCalledWith('batch:b-nots');
  });
});

describe('sweepZombieDramaSlots —— 什么情况下清理', () => {
  it('批次记录已不存在 → 清', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-gone')]) });
    const o = mkOrch(q, mkSvc(null));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(1);
    expect(q.purgeDramaJob).toHaveBeenCalledWith('batch:b-gone');
    expect(q.enqueueDramaBatch).not.toHaveBeenCalled(); // 没有批次可续跑
  });

  it.each(['done', 'failed', 'cancelled'])('批次已 %s → 清,且不重新拉起', async (st) => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-x')]) });
    const o = mkOrch(q, mkSvc({ ...runningBatch(60 * 60 * 1000), status: st }));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(1);
    expect(q.purgeDramaJob).toHaveBeenCalled();
    expect(q.enqueueDramaBatch).not.toHaveBeenCalled(); // 尊重用户意图,不复活
  });

  it('DB 仍是 running 但本进程没有执行者 → 清(上一轮进程被杀)', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-orphan')]) });
    const o = mkOrch(q, mkSvc(runningBatch(60 * 60 * 1000)));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(1);
    expect(q.purgeDramaJob).toHaveBeenCalledWith('batch:b-orphan');
  });

  it('purge 失败 → 不计入清理数,也不续跑(下个周期再试)', async () => {
    const q = mkQueue({
      listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-stuck')]),
      purgeDramaJob: jest.fn().mockResolvedValue(false),
    });
    const o = mkOrch(q, mkSvc(runningBatch(60 * 60 * 1000)));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
    expect(q.enqueueDramaBatch).not.toHaveBeenCalled();
  });

  it('孤儿条目(列表里有但 job 读不出来)也要清 —— 它同样占着位置', async () => {
    // 真实形态:active 列表里躺着 `<queueName>:<jobId>` 这类历史残留,
    // BullMQ 的 getJobs 会把它解析成 undefined。修复前整个巡检在这里抛异常
    // (异常又被上层 catch 掉)→ 表现为"有僵尸却永远清不掉"。
    const q = mkQueue({
      listDramaActiveJobs: jest.fn().mockResolvedValue([{
        jobId: 'batch:b-ghost', member: 'horizon:usage:drama-batch:batch:b-ghost',
        orphan: true, batchUuid: 'b-ghost', timestamp: 0, processedOn: null,
      }]),
    });
    const o = mkOrch(q, mkSvc({ ...runningBatch(60 * 60 * 1000), status: 'cancelled' }));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(1);
    expect(q.purgeDramaJob).toHaveBeenCalledWith('batch:b-ghost');
  });

  it('listDramaActiveJobs 抛异常 → 吞掉返回 0,不能把整个巡检周期带崩', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockRejectedValue(new Error('redis down')) });
    const o = mkOrch(q, mkSvc(null));
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(0);
  });
});

describe('sweepZombieDramaSlots —— 清理后的续跑', () => {
  it('批次仍是 running → 用 force 重新入队,带上正确的集/步断点', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-resume')]) });
    const o = mkOrch(q, mkSvc(runningBatch(60 * 60 * 1000)));
    await o.sweepZombieDramaSlots();
    expect(q.enqueueDramaBatch).toHaveBeenCalledTimes(1);
    const [data, opts] = q.enqueueDramaBatch.mock.calls[0];
    expect(data).toEqual({ batchUuid: 'b-resume', dramaUuid: 'd1', userId: 7 });
    expect(opts).toEqual({ force: true }); // 不 force 会被同 id 去重成 no-op
  });

  it('续跑会写一条可见日志(否则用户看不到"为什么突然又动了")', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-resume')]) });
    const svc = mkSvc(runningBatch(60 * 60 * 1000));
    const o = mkOrch(q, svc);
    await o.sweepZombieDramaSlots();
    expect(svc.appendBatchLog).toHaveBeenCalledWith('b-resume', expect.objectContaining({
      ep: 3, step: 2, ok: true,
    }));
  });

  it('冷却:同一批次 30 分钟内不会被反复拉起(防卡住→重入→又卡住)', async () => {
    const q = mkQueue({ listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-loop')]) });
    const o = mkOrch(q, mkSvc(runningBatch(60 * 60 * 1000)));
    await o.sweepZombieDramaSlots();
    await o.sweepZombieDramaSlots();
    expect(q.enqueueDramaBatch).toHaveBeenCalledTimes(1);

    // 过了冷却期后可以再拉一次
    (o as any).autoResumedAt.set('b-loop', Date.now() - AUTO_RESUME_COOLDOWN_MS - 1000);
    await o.sweepZombieDramaSlots();
    expect(q.enqueueDramaBatch).toHaveBeenCalledTimes(2);
  });

  it('续跑入队失败 → 写一条失败日志,而不是静默吞掉', async () => {
    const q = mkQueue({
      listDramaActiveJobs: jest.fn().mockResolvedValue([job('b-fail')]),
      enqueueDramaBatch: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    const svc = mkSvc(runningBatch(60 * 60 * 1000));
    const o = mkOrch(q, svc);
    await expect(o.sweepZombieDramaSlots()).resolves.toBe(1); // 清理本身成功了
    expect(svc.appendBatchLog).toHaveBeenCalledWith('b-fail', expect.objectContaining({
      ok: false,
    }));
  });
});
