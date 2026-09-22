// ============================================================================
// 连集时间线心跳回归锁(2026-09-15)
// ----------------------------------------------------------------------------
// 起因:用户点了「一键连集」后前端显示「0 / 3600 积分 · 时间线 0 条」,
// 判定为卡死来报障。实际是在跑 —— 单集视频步骤被 Agnes 429 按住,
// 每次固定退避 65s、重试 3 轮,再叠上 63s 的创建窗口排队,一个步骤能静默
// 7 分钟;而时间线只在「某步完成」时追加条目,这 7 分钟里就是纯空白。
//
// 这里锁的是心跳的不变量,它们各自对应一种会被重新引入的坏实现:
//  1. **每个 ep/step 各占一条** —— 若改成逐条追加,一次步骤重试上百次会把
//     log 的 500 条上限吃满,真实进度被 slice(-500) 截掉,可见性反而毁掉数据。
//     (2026-09-15 由「整批只占一条」改来:集间流水线让两集同时在飞,共用槽位
//      会互相覆盖,用户看到的「正在等待」在两句话之间来回跳。)
//  2. **永远在数组末尾** —— 工作台页取的是 `log.last`,不在末尾等于没显示。
//  3. **真实进度落地即清除本集心跳** —— 残留心跳会让前端把"已完成"显示成"还在等";
//     但只能清本集,一刀切会把并行另一集的实时进度也抹掉。
//  4. **镜头级进度(done/total)必须透出** —— 只有「已等 N 分钟」时用户无法
//     判断是"快完了"还是"才开头",实测被理解成卡死。
// 外加并发读改写的串行化:15 镜并发上报时,不串行就会互相覆盖丢写。
// ============================================================================

import { DramaService } from './drama.service';
import {
  BATCH_HEARTBEAT_KIND, runInBatchScope, reportUpstreamBackoff, reportShotProgress,
  currentBatchScope,
} from '../../common/upstream-heartbeat';

type Entry = Record<string, unknown>;

/** 内存版 DramaBatch:按 SQL 特征分派,UPDATE 真把 log 写回内存,才能验证不变量 */
function fakeBatch(initial: Entry[] = []) {
  const log: Entry[] = [...initial];
  const writes: string[] = [];
  const prisma = {
    async $queryRawUnsafe(sql: string): Promise<unknown> {
      if (sql.includes('SELECT * FROM `DramaBatch`')) {
        return [{
          id: 1n, uuid: 'b1', dramaId: 72n, userId: 15n, fromEp: 1, toEp: 5,
          policy: JSON.stringify({ budgetCredits: 3600 }), status: 'running',
          cursorEp: 1, cursorStep: 0, rootJobId: null,
          log: JSON.stringify(log), error: null,
          createdAt: new Date(), updatedAt: new Date(),
        }];
      }
      if (sql.includes('SELECT `id`,`log` FROM `DramaBatch`')) {
        return [{ id: 1n, log: JSON.stringify(log) }];
      }
      if (sql.includes('FROM `Drama`')) return [{ uuid: 'd-1' }];
      throw new Error(`未预期的 SQL: ${sql.slice(0, 90)}`);
    },
    async $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
      if (sql.includes('UPDATE `DramaBatch` SET `log`')) {
        writes.push(String(params[0]));
        const next = JSON.parse(String(params[0])) as Entry[];
        log.length = 0;
        log.push(...next);
        return 1;
      }
      return 0;
    },
  };
  return { prisma, log, writes };
}

const svcWith = (prisma: unknown) => new DramaService(prisma as never, {} as never);
const settle = () => new Promise((r) => setTimeout(r, 10));
const beats = (log: Entry[]) => log.filter((e) => e.kind === BATCH_HEARTBEAT_KIND);
const reals = (log: Entry[]) => log.filter((e) => e.kind !== BATCH_HEARTBEAT_KIND);

describe('DramaService 连集时间线心跳', () => {
  it('连续多次退避只占一条,且始终排在末尾', async () => {
    const { prisma, log } = fakeBatch([
      { ep: 1, step: 1, ok: true, msg: '复用7 新增0 待裁决0', credits: 0 },
    ]);
    const svc = svcWith(prisma);

    svc.batchHeartbeat('b1', 1, 4, '视频通道 429 限流,65s 后重试(1/3)');
    await settle();
    svc.batchHeartbeat('b1', 1, 4, '视频通道 429 限流,65s 后重试(2/3)');
    await settle();
    svc.batchHeartbeat('b1', 1, 4, '视频通道 429 限流,65s 后重试(3/3)');
    await settle();

    expect(beats(log)).toHaveLength(1);
    expect(beats(log)[0].msg).toBe('视频通道 429 限流,65s 后重试(3/3)');
    // 工作台页读 log.last,不在末尾就等于没显示
    expect(log[log.length - 1].kind).toBe(BATCH_HEARTBEAT_KIND);
    // 真实进度条目不能被心跳挤掉
    expect(reals(log)).toHaveLength(1);
    expect(beats(log)[0].ep).toBe(1);
    expect(beats(log)[0].step).toBe(4);
  });

  it('同一文案 5s 内重复上报被节流,不打穿 DB', async () => {
    const { prisma, log, writes } = fakeBatch();
    const svc = svcWith(prisma);

    // 模拟 15 镜并发同时吃 429,各自上报同一句话
    for (let i = 0; i < 60; i++) {
      svc.batchHeartbeat('b1', 1, 4, '等视频通道限流窗口,约 63s');
    }
    await settle();

    expect(writes).toHaveLength(1);
    expect(beats(log)).toHaveLength(1);
    expect(beats(log)[0].beats).toBe(1);
  });

  it('文案变化立刻写一次,让用户看见重试在推进', async () => {
    const { prisma, writes } = fakeBatch();
    const svc = svcWith(prisma);

    svc.batchHeartbeat('b1', 1, 3, '图像上游 503 限流,退避 5s 后重试(1/2)');
    await settle();
    svc.batchHeartbeat('b1', 1, 3, '图像上游 503 限流,退避 10s 后重试(2/2)');
    await settle();

    expect(writes).toHaveLength(2);
  });

  it('真实进度条目落地时清除残留心跳', async () => {
    const { prisma, log } = fakeBatch();
    const svc = svcWith(prisma);

    svc.batchHeartbeat('b1', 1, 4, '视频渲染中(in_progress),已等 3 分钟');
    await settle();
    expect(beats(log)).toHaveLength(1);

    await svc.appendBatchLog('b1', { ep: 1, step: 4, ok: true, msg: '视频 8 段', credits: 320 });

    expect(beats(log)).toHaveLength(0);
    expect(reals(log)).toHaveLength(1);
    expect(reals(log)[0].msg).toBe('视频 8 段');
  });

  it('并发上报 + 并发追加不丢写(读改写串行化)', async () => {
    const { prisma, log } = fakeBatch();
    const svc = svcWith(prisma);

    // 15 镜并发:心跳与步骤日志交错落库
    await Promise.all([
      ...Array.from({ length: 15 }, (_, i) =>
        Promise.resolve(svc.batchHeartbeat('b1', 1, 4, `视频渲染中,第 ${i} 镜`))),
      ...Array.from({ length: 5 }, (_, i) =>
        svc.appendBatchLog('b1', { ep: 1, step: i, ok: true, msg: `step${i}`, credits: 1 })),
    ]);
    await settle();

    // 5 条真实进度一条都不能少(不串行就会被并发覆盖)
    expect(reals(log).map((e) => e.msg).sort()).toEqual(
      ['step0', 'step1', 'step2', 'step3', 'step4'],
    );
    expect(beats(log).length).toBeLessThanOrEqual(1);
  });

  it('getBatch 把心跳原样透出给前端', async () => {
    const { prisma } = fakeBatch();
    const svc = svcWith(prisma);
    svc.batchHeartbeat('b1', 2, 4, '视频通道 429 限流,65s 后重试(1/3)');
    await settle();

    const out = await svc.getBatch('b1');
    expect(out.log).toHaveLength(1);
    expect(out.log[0].kind).toBe(BATCH_HEARTBEAT_KIND);
    expect(out.log[0].ep).toBe(2);
  });

  // ── 2026-09-15:按 ep/step 分键 + 镜头级进度 ─────────────────────────────
  // 起因:剧 70 的 EP1 视频段与 EP2 的分镜同时在飞,共用一个心跳槽位时
  // 互相覆盖,用户看到的「正在等待」在两句话之间来回跳,两个都读不成完整句子;
  // 且视频段只有「已等 N 分钟」,无从判断还剩几镜。
  it('不同 ep/step 的心跳各占一条,互不覆盖', async () => {
    const { prisma, log } = fakeBatch();
    const svc = svcWith(prisma);

    svc.batchHeartbeat('b1', 1, 4, '3/11 镜已完成 · 视频渲染中(in_progress),已等 19 分钟');
    await settle();
    svc.batchHeartbeat('b1', 2, 3, '图像上游 503 限流,退避 5s 后重试(1/2)');
    await settle();

    expect(beats(log)).toHaveLength(2);
    const byEp = new Map(beats(log).map((e) => [e.ep as number, e]));
    expect(byEp.get(1)?.step).toBe(4);
    expect(byEp.get(2)?.step).toBe(3);
    expect(String(byEp.get(1)?.msg)).toContain('视频渲染中');
    expect(String(byEp.get(2)?.msg)).toContain('图像上游 503');
  });

  it('同一 ep/step 反复上报仍只占一条(不变量在分键后继续成立)', async () => {
    const { prisma, log } = fakeBatch();
    const svc = svcWith(prisma);

    for (let i = 0; i < 30; i++) {
      svc.batchHeartbeat('b1', 1, 4, `视频渲染中,已等 ${i} 分钟`);
      await settle();
    }

    // 逐条追加会把 log 的 500 条上限吃满,真实进度反被 slice(-500) 截掉
    expect(beats(log)).toHaveLength(1);
    expect(log[log.length - 1].kind).toBe(BATCH_HEARTBEAT_KIND);
  });

  it('本集真实进度落地只清本集心跳,另一集的心跳保留', async () => {
    const { prisma, log } = fakeBatch();
    const svc = svcWith(prisma);

    svc.batchHeartbeat('b1', 1, 4, '视频渲染中(in_progress),已等 3 分钟');
    await settle();
    svc.batchHeartbeat('b1', 2, 3, '图像上游 503 限流');
    await settle();
    expect(beats(log)).toHaveLength(2);

    await svc.appendBatchLog('b1', { ep: 1, step: 4, ok: true, msg: '视频 11 段', credits: 320 });

    // 一刀切全清会把 EP2 正在跳的进度也抹掉 —— 那正是本次要解决的问题
    expect(beats(log)).toHaveLength(1);
    expect(beats(log)[0].ep).toBe(2);
  });

  it('镜头级进度(done/total/unit)透出给前端', async () => {
    const { prisma, log } = fakeBatch();
    const svc = svcWith(prisma);

    svc.batchHeartbeat('b1', 1, 4, '5/11 镜已完成', { done: 5, total: 11, unit: '镜已完成' });
    await settle();

    expect(beats(log)[0].done).toBe(5);
    expect(beats(log)[0].total).toBe(11);
    expect(beats(log)[0].unit).toBe('镜已完成');
  });
});

describe('upstream-heartbeat 作用域', () => {
  it('无批次作用域时静默返回(手动逐集 / 定妆单张不受影响)', async () => {
    expect(currentBatchScope()).toBeUndefined();
    expect(() => reportUpstreamBackoff('图像上游 503')).not.toThrow();
  });

  it('穿透 await 与 Promise.all,深层调用仍能拿到 batchUuid', async () => {
    const seen: string[] = [];
    const deep = async () => {
      await new Promise((r) => setTimeout(r, 1));
      await Promise.all([0, 1, 2].map(async () => {
        reportUpstreamBackoff(`shot retry`);
      }));
    };
    await runInBatchScope(
      { batchUuid: 'bX', ep: 3, step: 4, beat: (m) => seen.push(m) },
      deep,
    );
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe('shot retry');
    // 出作用域后恢复静默
    expect(currentBatchScope()).toBeUndefined();
  });

  it('写入器抛错不能带崩生成主流程', async () => {
    await runInBatchScope(
      { batchUuid: 'bY', ep: 1, step: 4, beat: () => { throw new Error('DB 抖动'); } },
      async () => {
        expect(() => reportUpstreamBackoff('视频通道 429')).not.toThrow();
      },
    );
  });

  // ── 2026-09-15:镜头级进度 ───────────────────────────────────────────────
  it('镜头级进度写进 scope,后续退避消息自动带上它', async () => {
    const seen: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    await runInBatchScope(
      { batchUuid: 'bZ', ep: 1, step: 4, beat: (m, x) => { seen.push({ msg: m, extra: x as never }); } },
      async () => {
        reportShotProgress(5, 11);
        // 退避消息比进度密集得多(每 5s 一次 vs 每镜一次),不合成会把进度挤没
        reportUpstreamBackoff('视频渲染中(in_progress),已等 19 分钟');
      },
    );
    expect(seen[0].msg).toBe('5/11 镜已完成');
    expect(seen[0].extra).toEqual({ done: 5, total: 11, unit: '镜已完成' });
    expect(seen[1].msg).toBe('5/11 镜已完成 · 视频渲染中(in_progress),已等 19 分钟');
    expect(seen[1].extra).toEqual({ done: 5, total: 11, unit: '镜已完成' });
  });

  it('没有镜头级进度时退避消息保持原样(不凭空造分母)', async () => {
    const seen: string[] = [];
    await runInBatchScope(
      { batchUuid: 'bW', ep: 1, step: 3, beat: (m) => { seen.push(m); } },
      async () => {
        reportUpstreamBackoff('图像上游 503,退避 5s 后重试(1/2)');
      },
    );
    expect(seen).toEqual(['图像上游 503,退避 5s 后重试(1/2)']);
  });

  it('scope 隔离:另一集的另一步不该看到本集的进度', async () => {
    const seen: string[] = [];
    const mk = (ep: number, step: number) => ({
      batchUuid: 'bQ', ep, step, beat: (m: string) => { seen.push(m); },
    });
    await runInBatchScope(mk(1, 4), async () => {
      reportShotProgress(3, 11);
      await runInBatchScope(mk(2, 3), async () => {
        reportUpstreamBackoff('图像上游 503');
      });
      reportUpstreamBackoff('视频渲染中');
    });
    expect(seen[0]).toBe('3/11 镜已完成');
    // 内层是另一集的另一步:看不到外层刚写的 3/11,否则会显示错的分母
    expect(seen[1]).toBe('图像上游 503');
    expect(seen[2]).toBe('3/11 镜已完成 · 视频渲染中');
  });

  it('无批次作用域时 reportShotProgress 静默返回', () => {
    expect(currentBatchScope()).toBeUndefined();
    expect(() => reportShotProgress(3, 11)).not.toThrow();
  });

  it('进度上报的写入器抛错也不能带崩生成', async () => {
    await runInBatchScope(
      { batchUuid: 'bV', ep: 1, step: 4, beat: () => { throw new Error('DB 抖动'); } },
      async () => {
        expect(() => reportShotProgress(5, 11)).not.toThrow();
      },
    );
  });
});
