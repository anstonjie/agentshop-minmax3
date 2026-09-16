// ============================================================================
// PortraitBatchService 回归锁(2026-09-15)
// ----------------------------------------------------------------------------
// 为什么单独锁这个服务:它是「定妆图找不到入口」这条投诉的正解。
// 此前定妆只有单资产接口,入口藏在资产卡片详情抽屉最底部,12 项资产要点 12 次;
// 现在改成门②通过后自动开跑 + 资产库一键补妆。跑批器一旦判错,代价是双向的:
//   · 少跑 → 关键帧退化成纯文生图,主角跨镜换脸(用户最恨的事故)
//   · 多跑 → 把已定妆的资产再烧一遍图像配额
// 所以「什么算已定妆」「单资产失败该记成什么」「重复点会不会双跑」这三件事
// 必须钉死在测试里,不能靠肉眼验收。
//
// 只测编排逻辑,不碰 DB 与图像上游:SQL 按字符串特征分派到固定返回值,
// generatePortrait 用 jest.fn 桩掉。
// ============================================================================

import {
  PortraitBatchService, assetHasPortrait, parsePortraitBatch, refUsable,
  shouldSkipAsset, usableViewCount,
} from './portrait-batch.service';

type Row = Record<string, unknown>;

/** 可变内存库:findDrama 必须读到最新落库状态,否则防双跑与自愈都测不出来 */
interface FakeDb {
  drama: { id: bigint; uuid: string; portraitBatch: any } | null;
  assets: Row[];
  saves: any[];
}

function fakePrisma(db: FakeDb) {
  return {
    async $queryRawUnsafe(sql: string, ...args: any[]): Promise<unknown> {
      if (sql.includes('JSON_EXTRACT')) {
        const st = parsePortraitBatch(db.drama?.portraitBatch);
        return st.status === 'running' ? [{ uuid: db.drama!.uuid }] : [];
      }
      if (sql.includes('FROM `DramaAsset`')) return db.assets;
      if (sql.includes('FROM `Drama`')) {
        if (!db.drama || (args[0] && args[0] !== db.drama.uuid)) return [];
        return [{ ...db.drama }];
      }
      throw new Error(`未预期的 SQL: ${sql.slice(0, 90)}`);
    },
    async $executeRawUnsafe(sql: string, ...args: any[]): Promise<number> {
      if (sql.includes('UPDATE `Drama`')) {
        const state = JSON.parse(String(args[0]));
        db.saves.push(state);
        if (db.drama) db.drama.portraitBatch = state;
        return 1;
      }
      return 0;
    },
  };
}

const asset = (over: Row = {}): Row => ({
  id: 1n, name: '张辉', kind: 'character', refs: [], status: 'confirmed',
  locked: 0, useCount: 0, ...over,
});

function build(assets: Row[], drama: Row | null = { id: 7n, uuid: 'd-7', portraitBatch: {} }) {
  const db: FakeDb = {
    drama: drama ? { id: drama.id as bigint, uuid: drama.uuid as string, portraitBatch: drama.portraitBatch } : null,
    assets,
    saves: [],
  };
  const generatePortrait = jest.fn(async (_uuid: string, id: string) => {
    const a = db.assets.find((x) => String(x.id) === String(id));
    return { id: Number(id), name: a?.name, refs: [{ angle: '正面', url: `/u/${id}.png`, alive: true }] };
  });
  const svc = new PortraitBatchService(fakePrisma(db) as never, { generatePortrait } as never);
  return { svc, db, generatePortrait };
}

// ── 纯函数:判据必须与前端 _hasRefImage / 后端 refAssetIndex 一致 ──────────

describe('assetHasPortrait · 已定妆判据', () => {
  it('本地落地或只有远端地址都算已定妆', () => {
    expect(assetHasPortrait([{ angle: '正面', url: '/u/a.png' }])).toBe(true);
    expect(assetHasPortrait([{ angle: '正面', url: '', remoteUrl: 'https://x/a.png' }])).toBe(true);
  });

  it('alive=false 的失效图不算(否则永远补不上)', () => {
    expect(assetHasPortrait([{ url: '/u/a.png', alive: false }])).toBe(false);
    expect(assetHasPortrait([{ url: '', alive: false }, { url: '/u/b.png' }])).toBe(true);
  });

  it('空 refs / 非数组 / 无地址的脏条目都不算', () => {
    expect(assetHasPortrait([])).toBe(false);
    expect(assetHasPortrait(null)).toBe(false);
    expect(assetHasPortrait([{ angle: '正面', url: '', remoteUrl: '' }])).toBe(false);
    expect(usableViewCount([{ url: '/a' }, { alive: false, url: '/b' }])).toBe(1);
  });

  it('refUsable 对 null / 字符串成员不抛错', () => {
    expect(refUsable(null)).toBe(false);
    expect(refUsable('正面')).toBe(false);
  });
});

describe('shouldSkipAsset · 跳过判据', () => {
  it('停用与锁定都给出可读原因,锁定兼容 0/1 与 boolean 两种驱动表示', () => {
    expect(shouldSkipAsset({ status: 'deprecated' })).toContain('停用');
    expect(shouldSkipAsset({ status: 'confirmed', locked: 1 })).toContain('锁定');
    expect(shouldSkipAsset({ status: 'confirmed', locked: true })).toContain('锁定');
    expect(shouldSkipAsset({ status: 'pending', locked: 0 })).toBeNull();
  });
});

describe('parsePortraitBatch · 脏数据归一', () => {
  it('字符串 / null / 非法 status 一律退回 idle,不抛错', () => {
    expect(parsePortraitBatch(null).status).toBe('idle');
    expect(parsePortraitBatch('{坏 JSON').status).toBe('idle');
    expect(parsePortraitBatch({ status: 'whatever' }).status).toBe('idle');
    expect(parsePortraitBatch(JSON.stringify({ status: 'running', total: 2 })).total).toBe(2);
  });

  it('items 里缺字段的条目被补齐,未知 state 退回 pending', () => {
    const st = parsePortraitBatch({
      status: 'done', total: 1, items: [{ assetId: '3', name: '林雅', state: '怪' }],
    });
    expect(st.items[0]).toEqual({ assetId: 3, name: '林雅', kind: '', state: 'pending' });
    expect(st.skipped).toBe(0);
  });
});

// ── 跑批编排 ────────────────────────────────────────────────────────────────

describe('PortraitBatchService.start', () => {
  it('没有待定妆资产 → 直接写 done(total 0),一次图都不烧', async () => {
    const { svc, db, generatePortrait } = build([
      asset({ id: 1n, refs: [{ angle: '正面', url: '/u/1.png', qc: { ok: true, issues: [] } }] }),
      asset({ id: 2n, refs: [{ angle: '正面', remoteUrl: 'https://x/2.png', qc: { ok: true, issues: [] } }] }),
    ]);
    const st = await svc.start('d-7', 'gate2');
    expect(st).toMatchObject({ status: 'done', total: 0, done: 0, failed: 0 });
    expect(generatePortrait).not.toHaveBeenCalled();
    expect(db.saves[db.saves.length - 1].status).toBe('done');
  });

  it('立即返回 running 并落库,跑完后每项状态与计数都对', async () => {
    const { svc, db, generatePortrait } = build([
      asset({ id: 1n, name: '张辉' }),
      asset({ id: 2n, name: '林雅' }),
      asset({ id: 3n, name: '智核-AI' }),
      asset({ id: 4n, name: '飞船指挥舱', kind: 'location', refs: [{ url: '/u/4.png', qc: { ok: true, issues: [] } }] }),
    ]);
    const st = await svc.start('d-7', 'gate2');
    expect(st.status).toBe('running');
    expect(st.total).toBe(3);            // 已定妆且已质检的第 4 项不进批
    await svc.waitUntilSettled('d-7');
    expect(generatePortrait).toHaveBeenCalledTimes(3);
    const fin = parsePortraitBatch(db.drama!.portraitBatch);
    expect(fin).toMatchObject({ status: 'done', total: 3, done: 3, failed: 0, skipped: 0, trigger: 'gate2' });
    expect(fin.finishedAt).toBeTruthy();
    expect(svc.isRunning('d-7')).toBe(false);
  });

  it('单资产失败不拖垮整批,原因原样落进 items 供前端点开看', async () => {
    const { svc, db } = build([asset({ id: 1n, name: '张辉' }), asset({ id: 2n, name: '林雅' })]);
    (svc as any).svc.generatePortrait = jest.fn(async (_u: string, id: string) => {
      if (id === '1') throw new Error('text image queue is full');
      return { refs: [{ url: `/u/${id}.png`, alive: true }] };
    });
    await svc.start('d-7', 'manual');
    await svc.waitUntilSettled('d-7');
    const fin = parsePortraitBatch(db.drama!.portraitBatch);
    expect(fin.status).toBe('done');
    expect(fin.done).toBe(1);
    expect(fin.failed).toBe(1);
    expect(fin.items.find((i) => i.assetId === 1)).toMatchObject({ state: 'failed', name: '张辉' });
    expect(fin.items.find((i) => i.assetId === 1)!.error).toContain('queue is full');
  });

  it('全部失败才标 failed;跑批中被锁定的资产记 skipped 不记 failed', async () => {
    const { svc, db } = build([asset({ id: 1n, name: '张辉' }), asset({ id: 2n, name: '林雅' })]);
    (svc as any).svc.generatePortrait = jest.fn(async (_u: string, id: string) => {
      if (id === '2') throw new Error('资产已锁定,先解锁再重生成');
      throw new Error('上游 503');
    });
    await svc.start('d-7', 'manual');
    await svc.waitUntilSettled('d-7');
    const fin = parsePortraitBatch(db.drama!.portraitBatch);
    expect(fin.status).toBe('failed');
    expect(fin.failed).toBe(1);
    expect(fin.skipped).toBe(1);
    expect(fin.items.find((i) => i.assetId === 2)!.state).toBe('skipped');
  });

  it('开跑时就锁定 / 停用的资产先标 skipped,不占进度条', async () => {
    const { svc, db, generatePortrait } = build([
      asset({ id: 1n, name: '张辉' }),
      asset({ id: 2n, name: '旧角色', status: 'deprecated' }),
      asset({ id: 3n, name: '满意的那张脸', locked: 1 }),
    ]);
    await svc.start('d-7', 'manual');
    await svc.waitUntilSettled('d-7');
    expect(generatePortrait).toHaveBeenCalledTimes(1);
    const fin = parsePortraitBatch(db.drama!.portraitBatch);
    expect(fin).toMatchObject({ total: 3, done: 1, failed: 0, skipped: 2 });
    expect(fin.items.find((i) => i.assetId === 3)!.error).toContain('锁定');
  });

  it('重复点「一键定妆」不会开第二批(防双烧配额)', async () => {
    const { svc, db } = build([asset({ id: 1n })]);
    let release: () => void = () => {};
    const gen = jest.fn(
      () => new Promise<any>((res) => {
        release = () => res({ refs: [{ url: '/u/a.png', alive: true }] });
      }),
    );
    (svc as any).svc.generatePortrait = gen;
    const first = await svc.start('d-7', 'manual');
    // 跑批是 fire-and-forget:先等 worker 真的推进到第一次图像调用,再验防双跑
    for (let i = 0; i < 50 && !gen.mock.calls.length; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const second = await svc.start('d-7', 'manual');
    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    expect(svc.isRunning('d-7')).toBe(true);
    expect(gen).toHaveBeenCalledTimes(1);                 // 第二次的调用被挡在门外
    release();
    await svc.waitUntilSettled('d-7');
    expect(svc.isRunning('d-7')).toBe(false);
    expect(parsePortraitBatch(db.drama!.portraitBatch).status).toBe('done');
  });

  it('剧集不存在时明确报错,而不是静默返回 idle', async () => {
    const { svc } = build([]);
    await expect(svc.start('nope')).rejects.toThrow('剧集不存在');
    await expect(svc.getState('nope')).resolves.toMatchObject({ status: 'idle' });
  });
});

describe('PortraitBatchService.getState · 假活诚实化', () => {
  it('DB 说 running 但本进程没在跑且进度陈旧 → 报 failed 并给未跑项补原因', async () => {
    const old = new Date(Date.now() - 40 * 60_000).toISOString();
    const { svc } = build([asset()], {
      id: 7n, uuid: 'd-7',
      portraitBatch: {
        status: 'running', total: 2, done: 0, failed: 0, skipped: 0, progressAt: old,
        items: [{ assetId: 1, name: '张辉', kind: 'character', state: 'running' },
          { assetId: 9, name: '陈刚', kind: 'character', state: 'pending' }],
      },
    });
    const st = await svc.getState('d-7');
    expect(st.status).toBe('failed');
    expect(st.items.every((i) => i.state === 'failed')).toBe(true);
    expect(st.items[1].error).toContain('中断');
  });

  it('刚有进度(本进程正在跑)时保持 running,不误判成中断', async () => {
    const { svc } = build([asset()], {
      id: 7n, uuid: 'd-7',
      portraitBatch: {
        status: 'running', total: 1, items: [{ assetId: 1, name: '张辉', kind: 'c', state: 'pending' }],
        progressAt: new Date().toISOString(),
      },
    });
    expect((await svc.getState('d-7')).status).toBe('running');
  });
});

describe('PortraitBatchService.resumeOrphans · 进程重启自愈', () => {
  it('把上一轮留下的 running 重新开跑(增量,已定妆项不再进批)', async () => {
    const { svc, db, generatePortrait } = build(
      [asset({ id: 1n }), asset({ id: 2n, refs: [{ url: '/u/2.png', alive: true, qc: { ok: true, issues: [] } }] })],
      {
        id: 7n, uuid: 'd-7',
        portraitBatch: {
          status: 'running', total: 2, done: 1, failed: 0, skipped: 0,
          items: [{ assetId: 1, name: '张辉', kind: 'c', state: 'pending' }],
        },
      },
    );
    expect(await svc.resumeOrphans()).toBe(1);
    await svc.waitUntilSettled('d-7');
    expect(generatePortrait).toHaveBeenCalledTimes(1);   // 只有 1 号还没定妆
    expect(parsePortraitBatch(db.drama!.portraitBatch).status).toBe('done');
  });

  it('2026-09-16 批4:有图但从没质检的资产进批(QC 补齐语义)', async () => {
    const { svc, generatePortrait } = build([
      asset({ id: 1n, refs: [{ url: '/u/1.png', alive: true }] }),                    // 有图无戳 → 进批
      asset({ id: 2n, refs: [{ url: '/u/2.png', alive: true, qc: { ok: true, issues: [] } }] }), // 已检 → 不进
      asset({ id: 3n, refs: [{ url: '/u/3.png', alive: true, qcSkipped: 'channel_unavailable' }] }), // 降级戳 → 不重复空检
    ]);
    const st = await svc.start('d-7', 'manual');
    expect(st.total).toBe(1);
    await svc.waitUntilSettled('d-7');
    expect(generatePortrait).toHaveBeenCalledTimes(1);
  });

  it('onApplicationBootstrap 会挂上自愈', async () => {
    const { svc } = build([asset()], {
      id: 7n, uuid: 'd-7',
      portraitBatch: { status: 'running', total: 1, items: [] },
    });
    const spy = jest.spyOn(svc, 'resumeOrphans');
    await svc.onApplicationBootstrap();
    expect(spy).toHaveBeenCalled();
  });
});
