// ============================================================================
// NovelGenService —— 小说生成引擎(入口 A:标题 → 完本小说)
// ----------------------------------------------------------------------------
// 最终方案 v6.0 §四′ 五级瀑布(全 LLM 走平台 Agnes,用户零 API Key):
//   L1 题材解析   标题+期望规格 → concept.json(题材/冲突/受众/卖点/章数规模)
//   L2 世界观蓝图 concept → story_bible(世界观/力量体系/规则) + 角色卡(≤12)
//   L3 分卷大纲   bible → volume_outlines(每卷三幕结构,卷间强钩子)
//   L4 章节细纲   滚动式:只提前生成当前卷的章纲(伏笔埋设/回收登记)
//   L5 滚动写作   写手→章末钩子硬性;每章带 上章摘要+本章纲+未回收伏笔
//                 → novel.txt(整本)+ chapters.json + foreshadow_ledger.json
//
// 编排形态(公众号助手同范式,但全程 auto 无刹车):
//   - 任务表 novel_gen_tasks 落库(游标 stage/chapters_done/断点字段),
//     后台 async 循环逐章推进,失败章节重试 2 次,重启可续跑(onModuleInit 恢复)。
//   - 前端轮询 GET /api/novel-gen/tasks/:uuid 拿进度(当前卷/章/字数/试读段落)。
//   - 完成后调用方(前端或 orchestrator)拿着 novel.txt 走既有
//     POST /api/dramas/:uuid/novel/ingest(source='generated')进对齐引擎,
//     之后三道审批门 → 分镜 → I2V 成片,与本智能体 Stage 2 链路汇合。
//
// 现实约束(方案 §风险册 + 裁决 G):
//   - 百万字级 = 数百次 LLM 调用 × 每章 30-60s,全程 10h+ 量级;
//     默认规格按裁决 G 压到 80 万字,UI 档位 2万/20万/80万。
//   - 三层记忆的 SQLite/FTS5 属 P6 完全体;本文件 P1 版用
//     「滚动摘要 + 伏笔总账(JSON) + 最近 N 章原文」的轻量记忆,
//     已能支撑中长篇连贯性,重排到 P6 再升级。
// ============================================================================

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { dramaNovelDir } from '../../common/paths';
import { OpenMontageService } from '../open-montage/open-montage.service';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** 任务行(novel_gen_tasks;$queryRawUnsafe,BigInt 出参转 string) */
interface TaskRow {
  id: bigint; uuid: string; userId: bigint; agentId: bigint;
  title: string; genre: string; targetChars: number;
  status: string;           // running / completed / failed
  stage: string;            // l1_concept / l2_bible / l3_volumes / l4_blueprint / l5_writing / done
  chaptersDone: number; chaptersTotal: number; charsDone: number;
  bibleJson: any;           // {concept, storyBible, characters, volumes, foreshadows}
  novelStorageKey: string | null;
  error: string | null;
  createdAt: Date; updatedAt: Date;
  /** DATE_FORMAT 出来的本地时间字符串(见 TASK_COLS):MySQL 存的就是本地时间,
   *  直接走 JS Date 会被当 UTC 再 +8h,展示时间会跳到第二天。 */
  createdAtLocal?: string; updatedAtLocal?: string;
}

/** 任务行查询列:`*` + 本地时间字符串别名(展示用,避开 Date 时区偏移) */
const TASK_COLS =
  '*, DATE_FORMAT(createdAt, "%Y-%m-%d %H:%i") AS createdAtLocal, ' +
  'DATE_FORMAT(updatedAt, "%Y-%m-%d %H:%i") AS updatedAtLocal';

/** 规格档位(裁决 G:默认 80 万) */
export const SIZE_TIERS = [
  { key: 'demo',    label: '试写 2 万字',  chars: 20_000,   chapterChars: 2_000 },
  { key: 'novella', label: '中篇 20 万字', chars: 200_000,  chapterChars: 2_500 },
  { key: 'full',    label: '长篇 80 万字', chars: 800_000,  chapterChars: 3_000 },
] as const;

const STAGES = ['l1_concept', 'l2_bible', 'l3_volumes', 'l4_blueprint', 'l5_writing', 'done'] as const;

@Injectable()
export class NovelGenService {
  private readonly logger = new Logger(NovelGenService.name);
  /** uuid → 运行中的生成循环(防重复启动) */
  private running = new Set<string>();

  /** novel 产物目录(repo 内 uploads,与 novel-ledger 的 drama-novel 池同区) */
  private get novelDir(): string {
    // 2026-09-15:路径口径收口到 common/paths(向上找 backend 根),
    //   不再各自按 __dirname 上溯 N 级 —— 那正是账本快照被写到项目外的原因。
    return dramaNovelDir();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly montage: OpenMontageService,
  ) {}

  // ===========================================================================
  // 对外 API
  // ===========================================================================

  /** 启动生成:建任务行 → 后台跑五级瀑布 */
  async start(userId: number, agentId: number, body: {
    title: string; tier?: string; genre?: string;
  }): Promise<unknown> {
    const title = (body.title || '').trim();
    if (title.length < 2) throw new BadRequestException('标题至少 2 个字');
    const tier = SIZE_TIERS.find(t => t.key === (body.tier || 'full')) ?? SIZE_TIERS[2];
    const uuid = randomUUID();
    const dir = this.novelDir;
    fs.mkdirSync(dir, { recursive: true });

    // 章数 = 目标字数 ÷ 单章字数(向上取整)
    const chaptersTotal = Math.max(3, Math.ceil(tier.chars / tier.chapterChars));

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO novel_gen_tasks
         (uuid, userId, agentId, title, genre, targetChars, status, stage,
          chaptersDone, chaptersTotal, charsDone, bibleJson, novelStorageKey)
       VALUES (?, ?, ?, ?, ?, ?, 'running', 'l1_concept', 0, ?, 0, CAST(? AS JSON), NULL)`,
      uuid, userId, agentId, title, body.genre || '', tier.chars, chaptersTotal,
      JSON.stringify({}),
    );
    this.runPipeline(uuid).catch(e => this.logger.error(`[novel-gen ${uuid}] pipeline crashed: ${e?.message}`));
    return this.getTask(uuid, userId);
  }

  /** 任务详情(前端轮询进度) */
  async getTask(uuid: string, userId: number): Promise<unknown> {
    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      'SELECT * FROM novel_gen_tasks WHERE uuid = ? AND userId = ?', uuid, userId,
    );
    if (!rows.length) throw new NotFoundException('生成任务不存在');
    const r = rows[0];
    const bible = typeof r.bibleJson === 'string' ? JSON.parse(r.bibleJson) : (r.bibleJson || {});
    return {
      uuid: r.uuid, title: r.title, genre: r.genre,
      targetChars: Number(r.targetChars),
      status: r.status, stage: r.stage,
      stageLabel: this.stageLabel(r.stage),
      chaptersDone: Number(r.chaptersDone), chaptersTotal: Number(r.chaptersTotal),
      charsDone: Number(r.charsDone),
      percent: this.percent(r),
      novelStorageKey: r.novelStorageKey,
      error: r.error,
      // 试读:最近完成章的结尾段(生成中也可看)
      preview: this.readTailPreview(r),
      bible: {
        logline: bible?.concept?.logline,
        characters: (bible?.characters || []).slice(0, 12).map((c: any) => c.name),
        volumes: (bible?.volumes || []).length,
      },
    };
  }

  /** 读生成产物正文(入口 A 的 ingest 用:按任务 uuid 读 uploads/drama-novel/<uuid>.txt) */
  async readGeneratedNovel(userId: bigint, taskUuid: string): Promise<string> {    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      'SELECT * FROM novel_gen_tasks WHERE uuid = ? AND userId = ?', taskUuid, userId,
    );
    if (!rows.length) throw new NotFoundException('生成任务不存在或不属于当前用户');
    const r = rows[0];
    if (r.status !== 'completed') {
      throw new BadRequestException(`小说尚未生成完成(当前状态 ${r.status}/${r.stage})`);
    }
    const p = path.join(this.novelDir, `${taskUuid}.txt`);
    if (!fs.existsSync(p)) throw new NotFoundException('生成产物文件缺失,请重新生成');
    return fs.readFileSync(p, 'utf-8');
  }

  // ===========================================================================
  // 2026-09-14 新增:全文阅读 / 编辑 / 导出(「我的小说」书架 + 阅读器)
  // ---------------------------------------------------------------------------
  // 背景:此前页面只有 getTask 里的 400 字试读,读全文只能去开
  //   uploads/drama-novel/<uuid>.txt 文件。这里补齐
  //   「列表 → 读全文(txt/md) → 编辑保存 → 下载」。
  //
  // 单一真相源是 <uuid>.txt(生成中每章 append 就在长,所以进行中也能读);
  // <uuid>.md 是由 txt 派生的漂亮排版(标题/简介/章节小标题/分隔线),
  // 每次读取或保存都重刷一遍,因此 /uploads/drama-novel/<uuid>.md 可直接下载。
  // ===========================================================================

  /** 我的小说列表(全部生成任务:进行中 / 已完成 / 失败;hasText=正文是否已可读) */
  async listTasks(userId: number): Promise<unknown[]> {
    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      `SELECT ${TASK_COLS} FROM novel_gen_tasks WHERE userId = ? ORDER BY id DESC LIMIT 200`,
      userId,
    );
    return rows.map((r) => ({
      uuid: r.uuid, title: r.title, genre: r.genre,
      status: r.status, stage: r.stage, stageLabel: this.stageLabel(r.stage),
      targetChars: Number(r.targetChars),
      chaptersDone: Number(r.chaptersDone), chaptersTotal: Number(r.chaptersTotal),
      charsDone: Number(r.charsDone), percent: this.percent(r),
      hasText: fs.existsSync(path.join(this.novelDir, `${r.uuid}.txt`)),
      error: r.error,
      // 与 listLedgerNovels 对齐同一形态:生成任务可编辑,账本快照只读
      source: 'task',
      editable: true,
      dramaUuid: null,
      createdAt: r.createdAtLocal ?? r.createdAt,
      updatedAt: r.updatedAtLocal ?? r.updatedAt,
    }));
  }

  /**
   * 已入库小说列表 —— 覆盖入口 B(用户上传)与入口 A 走完 ingest 的剧。
   *
   * 这些小说没有 novel_gen_tasks 行,只存在于剧的账本里(dramas_novel_ledger),
   * 所以「我的小说」书架单靠 listTasks 会漏掉它们。本方法把它们并成同一形态,
   * 前端可直接复用同一张卡片;source 区分来源,editable 恒为 false(只读快照)。
   */
  async listLedgerNovels(userId: number): Promise<unknown[]> {
    const rows = await this.prisma.$queryRawUnsafe<{
      dramaUuid: string; novelTitle: string; novelSource: string;
      novelStorageKey: string | null; totalChars: number;
      episodeCount: number; updatedAtLocal: string;
    }[]>(
      `SELECT d.uuid AS dramaUuid, l.novelTitle, l.novelSource, l.novelStorageKey,
              l.totalChars, l.episodeCount,
              DATE_FORMAT(l.updatedAt, "%Y-%m-%d %H:%i") AS updatedAtLocal
         FROM dramas_novel_ledger l
         JOIN \`Drama\` d ON d.id = l.dramaId
        WHERE l.userId = ? AND l.novelStorageKey IS NOT NULL
        ORDER BY l.id DESC LIMIT 200`,
      userId,
    );
    // 去重:同一本书被多部剧 ingest 过就会有 N 行,存储键是内容 sha256 ——
    // 按它去重正好等价于「同一本书只出现一次」。ORDER BY id DESC 保证留最新那部剧。
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const r of rows) {
      // 存储键只取文件名 —— 与 getNovelByDrama 同一套「不可信输入」处理
      const rel = path.basename(String(r.novelStorageKey));
      if (seen.has(rel)) continue;
      seen.add(rel);
      const exists = fs.existsSync(path.join(this.novelDir, rel));
      out.push({
        uuid: r.dramaUuid,
        title: r.novelTitle || '未命名小说',
        genre: '',
        status: 'ingested',
        stage: 'done',
        stageLabel: '已入库',
        chaptersDone: 0,
        chaptersTotal: 0,
        charsDone: Number(r.totalChars) || 0,
        percent: 100,
        episodeCount: Number(r.episodeCount) || 0,
        hasText: exists,
        error: exists ? null : '原文快照文件缺失',
        // 关键:列表卡片据此走 dramaUuid 通路(只读),而不是任务 uuid
        dramaUuid: r.dramaUuid,
        source: r.novelSource === 'generated' ? 'ledger-generated' : 'ledger-uploaded',
        editable: false,
        createdAt: r.updatedAtLocal,
        updatedAt: r.updatedAtLocal,
      });
    }
    return out;
  }

  /** 读全文(format=md 走漂亮排版,=txt 回原始正文;生成中也能读) */
  async getNovel(userId: number, uuid: string, format: 'txt' | 'md' = 'md'): Promise<unknown> {
    const n = await this.loadNovel(userId, uuid);
    return this.novelPayload(n.row, n.meta, format, format === 'txt' ? n.raw : n.md);
  }

  /** 保存编辑后的正文(只改 txt 源;md 随即重刷,下载链接同步更新) */
  async saveNovel(userId: number, uuid: string, content: string): Promise<unknown> {
    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      'SELECT * FROM novel_gen_tasks WHERE uuid = ? AND userId = ?', uuid, userId,
    );
    if (!rows.length) throw new NotFoundException('小说不存在或不属于当前用户');
    if (typeof content !== 'string' || !content.trim()) {
      throw new BadRequestException('正文不能为空');
    }
    const p = path.join(this.novelDir, `${uuid}.txt`);
    fs.writeFileSync(p, content, 'utf8');
    await this.prisma.$executeRawUnsafe(
      `UPDATE novel_gen_tasks SET charsDone = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE uuid = ?`,
      Buffer.byteLength(content, 'utf8'), uuid,
    );
    this.logger.log(`[novel-gen ${uuid}] 正文已人工编辑保存(${Buffer.byteLength(content, 'utf8')} 字节)`);
    return this.getNovel(userId, uuid, 'md');
  }

  /**
   * 按剧 uuid 读原文 —— 覆盖入口 B(用户上传的小说)与任意已 ingest 的剧。
   * 数据源是对齐账本的 novelStorageKey(内容寻址快照 uploads/drama-novel/<sha256>.txt)。
   *
   * ⚠️ 只读:文件名就是内容的 sha256,原地改写会让「文件名 = 内容指纹」这个
   *   不变量失效(快照池/回滚都依赖它)。所以这里不提供保存,前端也要隐藏编辑入口。
   */
  async getNovelByDrama(
    userId: number, dramaUuid: string, format: 'txt' | 'md' = 'md',
  ): Promise<unknown> {
    const rows = await this.prisma.$queryRawUnsafe<{
      novelTitle: string; novelSource: string; novelStorageKey: string | null;
      totalChars: number; updatedAtLocal: string;
    }[]>(
      `SELECT l.novelTitle, l.novelSource, l.novelStorageKey, l.totalChars,
              DATE_FORMAT(l.updatedAt, "%Y-%m-%d %H:%i") AS updatedAtLocal
         FROM dramas_novel_ledger l
         JOIN \`Drama\` d ON d.id = l.dramaId
        WHERE d.uuid = ? AND l.userId = ?`,
      dramaUuid, userId,
    );
    if (!rows.length) throw new NotFoundException('该剧还没有小说原文(未 ingest)');
    const r = rows[0];
    if (!r.novelStorageKey) throw new NotFoundException('账本里没有原文文件记录');

    // 只取文件名,杜绝 ../ 穿越(存储键来自 DB,仍按不可信输入处理)
    const rel = path.basename(String(r.novelStorageKey));
    const txtPath = path.join(this.novelDir, rel);
    if (!fs.existsSync(txtPath)) throw new NotFoundException('原文文件缺失');

    const raw = fs.readFileSync(txtPath, 'utf8');
    const chapters = this.splitChapters(raw);
    const meta = {
      chars: raw.replace(/\s/g, '').length,
      bytes: Buffer.byteLength(raw, 'utf8'),
      chapterCount: chapters.length,
      chapters: chapters.map((c) => ({
        no: c.no, title: c.title, chars: c.body.replace(/\s/g, '').length,
      })),
    };
    const md = this.buildMarkdown(
      { title: r.novelTitle, updatedAtLocal: r.updatedAtLocal },
      chapters, {}, meta,
    );
    const mdRel = rel.replace(/\.txt$/i, '.md');
    try {
      fs.writeFileSync(path.join(this.novelDir, mdRel), md, 'utf8');
    } catch { /* md 落盘失败不影响在线阅读 */ }

    return {
      uuid: dramaUuid, title: r.novelTitle, genre: '',
      status: 'ingested', stage: 'done', stageLabel: '已入库',
      percent: 100, format,
      content: format === 'txt' ? raw : md,
      chars: meta.chars, bytes: meta.bytes,
      chapterCount: meta.chapterCount, chapters: meta.chapters,
      downloadTxt: `drama-novel/${rel}`,
      downloadMd: `drama-novel/${mdRel}`,
      bible: { logline: null, characters: [], volumes: 0 },
      // 前端据此隐藏「编辑正文」(见上方只读说明)
      source: r.novelSource === 'generated' ? 'ledger-generated' : 'ledger-uploaded',
      editable: false,
      dramaUuid,
      createdAt: r.updatedAtLocal, updatedAt: r.updatedAtLocal,
    };
  }

  /** 内部:定位任务 + 读 txt + 派生 md(顺带把 md 落盘,便于静态直链下载) */
  private async loadNovel(userId: number, uuid: string) {
    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      `SELECT ${TASK_COLS} FROM novel_gen_tasks WHERE uuid = ? AND userId = ?`, uuid, userId,
    );
    if (!rows.length) throw new NotFoundException('小说不存在或不属于当前用户');
    const row = rows[0];
    const txtPath = path.join(this.novelDir, `${uuid}.txt`);
    if (!fs.existsSync(txtPath)) {
      throw new NotFoundException('正文还没落盘(生成刚启动,稍等片刻再读)');
    }
    const raw = fs.readFileSync(txtPath, 'utf8');
    const bible = this.parseBible(row);
    const chapters = this.splitChapters(raw);
    const meta = {
      chars: raw.replace(/\s/g, '').length,
      bytes: Buffer.byteLength(raw, 'utf8'),
      chapterCount: chapters.length,
      chapters: chapters.map((c) => ({
        no: c.no, title: c.title, chars: c.body.replace(/\s/g, '').length,
      })),
    };
    const md = this.buildMarkdown(
      { title: row.title, genre: row.genre, updatedAtLocal: row.updatedAtLocal, updatedAt: row.updatedAt },
      chapters, bible, meta,
    );
    try {
      fs.writeFileSync(path.join(this.novelDir, `${uuid}.md`), md, 'utf8');
    } catch { /* md 落盘失败不影响在线阅读 */ }
    return { row, raw, bible, chapters, meta, md };
  }

  private novelPayload(row: TaskRow, meta: any, format: 'txt' | 'md', content: string) {
    const bible = this.parseBible(row);
    return {
      uuid: row.uuid, title: row.title, genre: row.genre,
      status: row.status, stage: row.stage, stageLabel: this.stageLabel(row.stage),
      format, content,
      chars: meta.chars, bytes: meta.bytes,
      chapterCount: meta.chapterCount, chapters: meta.chapters,
      percent: this.percent(row),
      // 下载直链(uploads 已静态托管在 /uploads,见 main.ts)
      downloadTxt: `drama-novel/${row.uuid}.txt`,
      downloadMd: `drama-novel/${row.uuid}.md`,
      bible: {
        logline: bible?.concept?.logline ?? null,
        characters: (bible?.characters || []).slice(0, 12)
          .map((c: any) => c.name).filter(Boolean),
        volumes: (bible?.volumes || []).length,
      },
      createdAt: row.createdAtLocal ?? row.createdAt,
      updatedAt: row.updatedAtLocal ?? row.updatedAt,
      // 前端据此决定是否给「编辑正文」入口(生成任务可改 txt 源;账本快照只读)
      source: 'task',
      editable: true,
      taskUuid: row.uuid,
    };
  }

  /** 正文 → 章节切分。txt 形态:`第0001章 章名` 独占一行,正文段落空行分隔 */
  private splitChapters(raw: string): { no: number; title: string; body: string }[] {
    const text = (raw || '').replace(/\r\n/g, '\n');
    const re = /^[ \t]*第\s*(\d+)\s*章[ \t]*(.*)$/gm;
    const marks: { no: number; title: string; start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      marks.push({
        no: Number(m[1]), title: (m[2] || '').trim(),
        start: m.index, end: m.index + m[0].length,
      });
    }
    // 没有章节标记(空文件 / 用户手改没了)→ 整篇当一章,避免阅读器白屏
    if (!marks.length) return [{ no: 1, title: '', body: text.trim() }];
    return marks.map((mk, i) => ({
      no: mk.no, title: mk.title,
      body: text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim(),
    }));
  }

  /** 章节数组 → 漂亮 Markdown(书名 H1 + 简介引用块 + 每章 H2 + 分隔线) */
  private buildMarkdown(
    head: { title: string; genre?: string; updatedAtLocal?: string; updatedAt?: Date | string },
    chapters: { no: number; title: string; body: string }[],
    bible: any,
    meta: { chars: number; chapterCount: number },
  ): string {
    const out: string[] = [];
    out.push(`# 《${(head.title || '未命名').trim()}》`, '');

    const logline = bible?.concept?.logline;
    if (logline) out.push(`> ${this.mdEscapeLine(String(logline))}`, '>');
    const wan = (meta.chars / 10000).toFixed(1);
    out.push(`> **${meta.chapterCount} 章** · 约 ${wan} 万字 · ${this.fmtTime(head.updatedAtLocal ?? head.updatedAt ?? '')}`, '');
    if (head.genre) out.push(`**题材**:${head.genre}`, '');
    const names = (bible?.characters || []).slice(0, 12)
      .map((c: any) => c.name).filter(Boolean);
    if (names.length) out.push(`**主要角色**:${names.join('、')}`, '');
    out.push('---', '');

    for (const ch of chapters) {
      out.push(`## 第${ch.no}章${ch.title ? ` ${ch.title}` : ''}`, '');
      const paras = ch.body.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      if (!paras.length) {
        out.push('*（本章暂无正文）*', '');
      } else {
        // 中文长文阅读习惯:段首两格全角缩进(在 md 里用 U+3000,下载下来也好看)
        for (const p of paras) out.push(`　　${this.mdEscapeLine(p)}`, '');
      }
      out.push('---', '');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  /** 正文行 → Markdown 安全行(防正文里的 1. / - / # / * 被当成语法渲染) */
  private mdEscapeLine(line: string): string {
    let s = (line || '').trim();
    if (/^[#>+\-*]\s/.test(s)) s = `\\${s}`;
    else if (/^\d+\.\s/.test(s)) s = s.replace(/^(\d+)\.\s/, '$1\\. ');
    return s.replace(/([*_`\[\]])/g, '\\$1');
  }

  private fmtTime(d: Date | string): string {
    // DATE_FORMAT 出来的 'YYYY-MM-DD HH:mm' 已是本地时间,原样返回
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(d)) {
      return d.slice(0, 16);
    }
    const t = new Date(d as any);
    if (isNaN(t.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  }

  /** 失败/中断任务从断点重拉(单章重试 3 次仍败的兜底:人工修因后 resume) */
  async resumeTask(uuid: string, userId: number): Promise<unknown> {
    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      'SELECT * FROM novel_gen_tasks WHERE uuid = ? AND userId = ?', uuid, userId,
    );
    if (!rows.length) throw new NotFoundException('生成任务不存在');
    const r = rows[0];
    if (r.status === 'completed') throw new BadRequestException('任务已完成,无需恢复');
    if (this.running.has(uuid)) return this.getTask(uuid, userId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE novel_gen_tasks SET status = 'running', error = NULL,
         updatedAt = CURRENT_TIMESTAMP(3) WHERE uuid = ?`, uuid,
    );
    this.runPipeline(uuid).catch(e => this.logger.error(`[novel-gen ${uuid}] resume crashed: ${e?.message}`));
    return this.getTask(uuid, userId);
  }

  /** 重启恢复:把 running 且未完成的任务重新拉起(断点续跑) */
  // 2026-09-14 10:50 touch:触发 watch 重启,拉起 085cff4a(已置回 running)
  onModuleInit() {    (async () => {
      const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
        "SELECT * FROM novel_gen_tasks WHERE status = 'running'",
      );
      for (const r of rows) {
        if (this.running.has(r.uuid)) continue;
        this.logger.log(`[novel-gen] 恢复中断任务 ${r.uuid}(${r.title},stage=${r.stage},已 ${r.chaptersDone}/${r.chaptersTotal} 章)`);
        this.runPipeline(r.uuid).catch(e => this.logger.error(`[novel-gen ${r.uuid}] resume crashed: ${e?.message}`));
      }
    })().catch(() => {/* DB 不可用时不阻塞启动 */});
  }

  // ===========================================================================
  // 五级瀑布(后台循环)
  // ===========================================================================

  private async runPipeline(uuid: string): Promise<void> {
    if (this.running.has(uuid)) return;
    this.running.add(uuid);
    try {
      await this.advance(uuid);
    } finally {
      this.running.delete(uuid);
    }
  }

  /** 从当前游标推进到终态(每步落库,任何一步失败置 failed 可人工重试) */
  private async advance(uuid: string): Promise<void> {
    const task = await this.loadTask(uuid);
    const ctx = { userId: Number(task.userId), agentId: Number(task.agentId) };
    const tier = this.tierOf(Number(task.targetChars));
    const dir = this.novelDir;
    const novelPath = path.join(dir, `${uuid}.txt`);
    const biblePath = path.join(dir, `${uuid}.bible.json`);
    let bible = this.parseBible(task);

    try {
      // ── L1 题材解析 ──
      if (task.stage === 'l1_concept') {
        bible.concept = await this.genConcept(ctx, task, tier);
        await this.saveStage(uuid, 'l2_bible', bible);
      }
      // ── L2 世界观蓝图 + 角色卡 ──
      if (this.stageIdx((await this.loadStage(uuid))) < this.stageIdx('l3_volumes')) {
        const wb = await this.genBible(ctx, bible.concept, task, tier);
        bible.storyBible = wb.storyBible; bible.characters = wb.characters;
        await this.saveStage(uuid, 'l3_volumes', bible);
      }
      // ── L3 分卷大纲 ──
      if (this.stageIdx((await this.loadStage(uuid))) < this.stageIdx('l4_blueprint')) {
        bible.volumes = await this.genVolumes(ctx, bible, task, tier);
        // 2026-09-14 修复:LLM 分卷的 chapters 区间会幻觉越界(实测 10 章给了 1-50),
        //   落库前 clamp 到 [1, chaptersTotal],卷间缝隙由 volumeOf 兜底。
        const total = Number(task.chaptersTotal);
        bible.volumes = (bible.volumes || []).map((v: any) => {
          const m = String(v?.chapters || '').match(/(\d+)\s*[-~]\s*(\d+)/);
          if (m) {
            const s = Math.max(1, Math.min(total, Number(m[1])));
            const e = Math.max(s, Math.min(total, Number(m[2])));
            v.chapters = `${s}-${e}`;
          }
          return v;
        });
        await this.saveStage(uuid, 'l4_blueprint', bible);
      }
      // ── L4 章节细纲 + L5 滚动写作(逐章推进,每章落库可断点) ──
      const stageNow = await this.loadStage(uuid);
      if (this.stageIdx(stageNow) <= this.stageIdx('l5_writing')) {
        // 首次进入:生成全书章纲(轻量版:每卷一次 LLM 出该卷章纲,滚动接龙)
        bible.blueprints = bible.blueprints || [];
        const chaptersDone = Number((await this.loadCounters(uuid)).chaptersDone);
        const novelExists = fs.existsSync(novelPath);

        // 逐章生成到 chaptersTotal
        for (let ch = chaptersDone + 1; ch <= Number(task.chaptersTotal); ch++) {
          // 4.1 该章所属卷 → 章纲缺失则补(每卷批量出,防 LLM 次数爆炸)
          const vol = this.volumeOf(bible, ch, Number(task.chaptersTotal));
          if (!bible.blueprints[ch - 1]) {
            let fromCh = Math.max(1, this.volumeStartCh(bible, vol, Number(task.chaptersTotal), ch));
            let toCh = Math.min(Number(task.chaptersTotal), this.volumeEndCh(bible, vol, Number(task.chaptersTotal), ch));
            // 2026-09-14 修复:L3 分卷的 chapters 区间是 LLM 生成,会幻觉越界
            //   (实测 demo 档 10 章被给了「1-50」区间,L4 一次要 50 条必超 flash
            //   稳定产出上限,3 次重试全败)。双保险:clamp 到实际章数 + 单批上限 20 章,
            //   超出部分拆到下一批(每写完一章检查一次,自然滚动续上)。
            const BP_BATCH_MAX = 20;
            if (toCh - fromCh + 1 > BP_BATCH_MAX) toCh = fromCh + BP_BATCH_MAX - 1;
            const seg = await this.genBlueprints(ctx, bible, task, fromCh, toCh, novelExists ? this.tailSummary(novelPath) : '');
            // 防御:过滤掉 ch 越界项后如果数量不足,用占位章纲补齐(LLM 偶发漏章,
            // 之前直接 splice 会让 blueprints 错位,后续章全拿错纲要 → 连锁失败)
            const segMap = new Map(seg.map((s: any) => [Number(s.ch), s]));
            for (let c = fromCh; c <= toCh; c++) {
              if (!segMap.has(c)) segMap.set(c, { ch: c, title: `第${c}章`, outline: '', foreshadow: [], hook: '' });
            }
            bible.blueprints.splice(fromCh - 1, toCh - fromCh + 1, ...Array.from(segMap.values()).sort((a: any, b: any) => a.ch - b.ch));
            await this.saveStage(uuid, 'l5_writing', bible, { chaptersDone: ch - 1 });
          }
          // 4.2 写本章(单章失败重试 2 次:LLM 偶发截断/拒答;重试降温度压波动)
          let chapter: any = null;
          let chErr: any = null;
          for (let attempt = 0; attempt < 3 && !chapter; attempt++) {
            try {
              chapter = await this.genChapter(
                ctx, bible, task, ch,
                novelExists ? this.tailSummary(novelPath) : '',
                attempt, // attempt 透传:第 2/3 次降 temperature
              );
            } catch (e: any) {
              chErr = e;
              this.logger.warn(`[novel-gen ${uuid}] 第 ${ch} 章第 ${attempt + 1} 次尝试失败:${(e?.message || '').slice(0, 120)}`);
              await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            }
          }
          if (!chapter) {
            throw new BadRequestException(`第 ${ch} 章生成失败(已重试 3 次):${(chErr?.message || '').slice(0, 200)}`);
          }
          const text = this.renderChapter(ch, chapter, bible.blueprints?.[ch - 1]?.title);
          fs.appendFileSync(novelPath, text, 'utf8');
          // 滚动摘要(轻量三层记忆:只保留最近 1 章 300 字摘要,卷级摘要在伏笔总账里)
          bible.rollingSummary = chapter.summary || '';
          // 伏笔登记
          for (const f of chapter.foreshadows || []) {
            bible.foreshadows = bible.foreshadows || [];
            bible.foreshadows.push({ id: bible.foreshadows.length + 1, ch, ...f, status: 'open' });
          }
          // 伏笔回收核销(兼容数字 id 与文本内容两种返回形态:
          //   genChapter 的 resolved 已改为按伏笔内容回收,prompt 不再喂 id)
          for (const rv of chapter.resolved || []) {
            const f = (bible.foreshadows || []).find((x: any) =>
              typeof rv === 'number' ? x.id === rv
              : typeof rv === 'string' ? (x.id === Number(rv)) || (rv.length >= 4 && String(x.content || '').includes(rv))
              : false);
            if (f) { f.status = 'resolved'; f.resolvedCh = ch; }
          }
          const novelText = fs.readFileSync(novelPath, 'utf8');
          // 2026-09-22 修正:之前用 fs.statSync(novelPath).size(字节数)和
          //   Buffer.byteLength(..., 'utf8') 都把中文按 3 字节算 → 同一份小说
          //   charsDone ≈ 实际字数 × 3,进度条永远虚高 3 倍。改按字符计。
          //   Array.from(s).length 拿到的是 UTF-16 code units,对 BMP 中文 1 字 = 1,
          //   emoji/扩展平面 1 字 = 2(误差远小于原 3× 偏差,可接受)。
          const charsDone = Array.from(novelText).length;
          await this.saveStage(uuid, 'l5_writing', bible, {
            chaptersDone: ch, charsDone,
          });
        }
        // 完成:落 bible 与完成态(注意:charsDone 取的是 for 循环最后一次更新,
        //   这里再次确认值与写入字段一致——避免循环作用域外的编译错误)
        fs.writeFileSync(biblePath, JSON.stringify(bible, null, 2), 'utf8');
        const finalChars = fs.existsSync(novelPath)
          ? Array.from(fs.readFileSync(novelPath, 'utf8')).length : 0;
        await this.prisma.$executeRawUnsafe(
          `UPDATE novel_gen_tasks SET status = 'completed', stage = 'done',
             novelStorageKey = ?, charsDone = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE uuid = ?`,
          `drama-novel/${uuid}.txt`, finalChars, uuid,
        );
        this.logger.log(`[novel-gen ${uuid}] 完成:${Number(task.chaptersTotal)} 章 ${finalChars} 字`);
      }
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 500);
      this.logger.error(`[novel-gen ${uuid}] stage=${(await this.loadStage(uuid).catch(() => '?'))} 失败:${msg}`);
      await this.prisma.$executeRawUnsafe(
        `UPDATE novel_gen_tasks SET status = 'failed', error = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE uuid = ?`,
        msg, uuid,
      );
      throw e;
    }
  }

  // ===========================================================================
  // L1-L5 各级 LLM 提示词
  // ===========================================================================

  private async genConcept(ctx: any, task: TaskRow, tier: any): Promise<any> {
    const sys = '你是资深网文策划。根据标题输出题材概念 JSON,不要 markdown 包裹。';
    const usr = `标题:《${task.title}》${task.genre ? `\n指定类型:${task.genre}` : ''}
目标规模:约 ${tier.chars} 字 / ${Number(task.chaptersTotal)} 章。
输出 JSON 字段:
{"genre":"题材(玄幻/都市/悬疑/古言/科幻等)","logline":"一句话核心冲突","protagonist":"主角设定一句话","antagonist":"对手/阻力一句话","hook":"开篇钩子(第一章抓人的具体事件)","selling_points":["3-5 个爽点/卖点"],"tone":"叙事基调"}`;
    const parsed = this.montage.parseJsonSafe(await this.montage.callLlm(ctx, sys, usr, 0.9, 2048));
    if (!parsed?.logline) throw new BadRequestException('L1 题材解析失败(LLM 返回不可解析)');
    return parsed;
  }

  private async genBible(ctx: any, concept: any, task: TaskRow, tier: any): Promise<any> {
    const sys = '你是网文世界观架构师。输出世界观圣经 + 角色卡 JSON,不要 markdown 包裹。';
    const usr = `题材概念:${JSON.stringify(concept)}
标题:《${task.title}》规模:${tier.chars} 字长篇。
输出 JSON:
{"story_bible":{"world":"世界观 300 字","power_system":"力量/规则体系 150 字","rules":["3 条不可违反的世界规则"]},
"characters":[{"name":"","role":"主角/女主/对手/盟友/长辈…","appearance":"外貌 60 字","personality":"性格 60 字","goal":"人物目标","arc":"人物成长弧"}]}
角色 6-10 个,主角必须能撑起 ${Number(task.chaptersTotal)} 章的持续冲突。`;
    const parsed = this.montage.parseJsonSafe(await this.montage.callLlm(ctx, sys, usr, 0.8, 4096));
    if (!parsed?.characters?.length) throw new BadRequestException('L2 世界观生成失败');
    return { storyBible: parsed.story_bible, characters: parsed.characters };
  }

  private async genVolumes(ctx: any, bible: any, task: TaskRow, tier: any): Promise<any[]> {
    const volCount = this.volumeCount(Number(task.chaptersTotal));
    const sys = '你是长篇网文结构师。把全书切成卷,每卷三幕结构,卷间强钩子。只输出一个 JSON 数组,顶层必须直接是 [ 开头,禁止包 volumes/data 等任何包裹键。';
    const usr = `世界观与角色:${JSON.stringify({ bible: bible.storyBible, chars: (bible.characters || []).map((c: any) => ({ n: c.name, g: c.goal, a: c.arc })) })}
核心冲突:${bible.concept?.logline || task.title}
全书 ${Number(task.chaptersTotal)} 章,分 ${volCount} 卷。
输出 JSON:
[{"vol":1,"title":"卷名","acts":["起:开局事件","承:升级冲突","合:卷末爆发+钩子"],"chapters":"本卷章数区间,如 1-30"}]
每卷"合"幕必须留一个 unresolved 钩子把读者推进下一卷;最后一卷必须回收主线。`;
    const parsed = this.montage.parseJsonSafe(await this.montage.callLlm(ctx, sys, usr, 0.7, 3072));
    const vols = this.unwrapArray(parsed);
    if (!vols || !vols.length) throw new BadRequestException('L3 分卷生成失败');
    return vols;
  }

  /** 一次生成 fromCh..toCh 的章纲(通常一卷一批);LLM 解析失败重试 3 次(降温) */
  private async genBlueprints(ctx: any, bible: any, task: TaskRow, fromCh: number, toCh: number, tailSummary: string): Promise<any[]> {
    let items: any[] | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3 && !(items && items.length); attempt++) {
      const sys = '你是网文章节策划。输出章纲 JSON 数组:顶层直接以 [ 开头,禁止包 blueprints/chapters/data 等任何包裹键,不要 markdown 包裹。';
      const usr = `${tailSummary ? `上批概要:${tailSummary}\n` : ''}全书设定:${JSON.stringify({
        logline: bible.concept?.logline, world: bible.storyBible?.world,
        characters: (bible.characters || []).map((c: any) => c.name + ':' + c.goal),
        volumes: bible.volumes,
      })}
为第 ${fromCh}-${toCh} 章输出逐章纲要,每章 ${this.tierOf(Number(task.targetChars)).chapterChars} 字:
[{"ch":${fromCh},"title":"章名","outline":"本章 120 字剧情推进","foreshadow":[{"id":1,"content":"伏笔内容","recycle_vol":2}],"resolve":[],"hook":"章末钩子一句话"}]
要求:foreshadow 的 id 全书唯一递增;resolve 数组列本章要回收的既有伏笔 id;每章必须有 hook;恰好输出 ${toCh - fromCh + 1} 个对象,一个不多一个不少。${attempt > 0 ? '\n注意:上一次输出无法解析为数组,这次必须以 [ 开头、以 ] 结尾。' : ''}`;
      try {
        const parsed = this.montage.parseJsonSafe(await this.montage.callLlm(ctx, sys, usr, Math.max(0.55, 0.75 - attempt * 0.1), 8192));
        items = this.unwrapArray(parsed) || [];
        items = items.filter(p => p && p.ch >= fromCh && p.ch <= toCh);
        if (!items.length || items.length < toCh - fromCh + 1) {
          lastErr = new Error(`返回 ${items.length}/${toCh - fromCh + 1} 条`);
          items = null; // 数量不足视为失败,进入下一次重试
        }
      } catch (e: any) {
        lastErr = e;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (!items || !items.length) {
      throw new BadRequestException(`L4 章纲生成失败(${fromCh}-${toCh},${lastErr?.message || 'LLM 返回不可解析'})`);
    }
    return items;
  }

  private async genChapter(ctx: any, bible: any, task: TaskRow, ch: number, tailSummary: string, attempt = 0): Promise<any> {
    const bp = bible.blueprints?.[ch - 1] || {};
    const openForeshadows = (bible.foreshadows || []).filter((f: any) => f.status === 'open').slice(-8);
    // 重试升温:0.85 → 0.7 → 0.55,降低 LLM 截断/跑题概率
    const temperature = Math.max(0.55, 0.85 - attempt * 0.15);
    const sys = `你是顶尖网文写手。写第 ${ch} 章,${this.tierOf(Number(task.targetChars)).chapterChars} 字,正文中文。输出 JSON。`;
    // 2026-09-13 修复:章纲禁止以 JSON 形态进 prompt ——
    //   实测 LLM 会把输入里占主导的结构化样式当模板回显(返回了 ch/title/outline
    //   同构 JSON 而非正文,导致"正文过短:0 字");拍平成自然语言描述后不再诱导。
    //   重试(attempt>0)时进一步去掉 foreshadow/hook 字段,只留剧情推进。
    const bpFlat = attempt > 0
      ? `写第 ${ch} 章,推进剧情:${bp.outline || '(章纲缺失,按前文合理推进)'}。`
      : `写第 ${ch} 章,推进剧情:${bp.outline || '(章纲缺失,按前文合理推进)'}。章名:${bp.title || ''}。未回收伏笔(能自然回收的按剧情回收):${(openForeshadows.map((f: any) => f.content).join(';') || '无')}。章末必须落在钩子上:${bp.hook || '自拟悬念钩子'}。`;
    const usr = `${tailSummary ? `上一章结尾(必须无缝衔接):\n${tailSummary}\n\n` : ''}
${bpFlat}
主角团:${(bible.characters || []).slice(0, 4).map((c: any) => `${c.name}(${c.appearance||''},${c.personality||''})`).join(';')}
输出 JSON:
{"text":"本章正文(纯正文,${this.tierOf(Number(task.targetChars)).chapterChars} 字上下,含自然分段)","summary":"120 字本章摘要(供下一章衔接)","resolved":["回收的伏笔内容,没有则空数组"]}
铁律:正文必须推进上述全部剧情点;开头直接进入剧情,不要出现"第X章"或章名;text 必须是完整的一章,不许截断;只输出这一个 JSON 对象。`;
    // 2026-09-15:键名规范化(normalizeKeys)已下沉到 montage.parseJsonSafe 出口,
    //   这里不再重复包裹(避免两份实现分叉)。
    const parsed = this.montage.parseJsonSafe(await this.montage.callLlm(ctx, sys, usr, temperature, 12288));
    // 2026-09-14 调试(保留):正文过短时把解析产物落盘,定位 LLM 回显/空返回形态。
    //   raw 变量已随 normalizeKeys 重构移除,此处只记 parsed 形态。
    if (!parsed?.text || parsed.text.length < 200) {
      try {
        const dbgPath = path.join(this.novelDir, `${task.uuid}.debug-ch${ch}-a${attempt}.txt`);
        fs.writeFileSync(dbgPath,
          `=== usr prompt(前600) ===\n${usr.slice(0, 600)}\n\n=== parsed keys=${parsed ? Object.keys(parsed).join(',') : 'NULL'} text.length=${parsed?.text?.length ?? 'undefined'}\n\n=== parsed 全文(前2000) ===\n${JSON.stringify(parsed).slice(0, 2000)}`, 'utf8');
        this.logger.warn(`[novel-gen ${task.uuid}] 第 ${ch} 章正文过短(attempt ${attempt}),parsed 已落盘 ${dbgPath}`);
      } catch { /* 落盘失败不掩盖原错误 */ }
    }
    if (!parsed?.text || parsed.text.length < 200) throw new BadRequestException(`第 ${ch} 章生成失败(正文过短:${parsed?.text?.length ?? 0} 字)`);

    // 2026-09-13 修复:LLM 偶发回显章纲(ch/title/outline 同构)而非正文 —— 
    // resolved 字段在此错误形态下无意义,改为按伏笔内容匹配核销
    if (!Array.isArray(parsed.resolved)) parsed.resolved = [];
    if (!parsed.text || typeof parsed.text !== 'string') parsed.text = '';
    return { ...parsed, foreshadows: bp.foreshadow || [] };
  }

  // ===========================================================================
  // 工具
  // ===========================================================================

  /**
   * LLM 数组解包:期望顶层数组的接口,LLM 偶发自作主张包一层 key
   * (实测形态:{"volumes":[...]}/{"blueprints":[...]}/{"data":[...]}等)。
   * 规则:是数组直接回;是 object 则找第一个数组值(优先常见键名);找不到回 null。
   */
  private unwrapArray(parsed: any): any[] | null {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const prefer = ['volumes', 'blueprints', 'chapters', 'blueprint', 'list', 'data', 'items', 'results'];
      for (const k of prefer) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v)) return v;
      }
    }
    return null;
  }

  private renderChapter(ch: number, c: any, bpTitle?: string): string {
    const name = bpTitle || c.title || '';
    return `\n\n第${String(ch).padStart(4, '0')}章${name ? ' ' + name : ''}\n\n${(c.text || '').trim()}\n`;
  }

  private stageLabel(stage: string): string {
    return ({
      l1_concept: '解析题材', l2_bible: '构建世界观', l3_volumes: '规划分卷',
      l4_blueprint: '排章纲', l5_writing: '逐章写作', done: '已完成',
    } as Record<string, string>)[stage] || stage;
  }

  private percent(r: TaskRow | { stage: string; chaptersDone: number; chaptersTotal: number }): number {
    const weights: Record<string, number> = { l1_concept: 2, l2_bible: 6, l3_volumes: 10, l4_blueprint: 14, l5_writing: 68, done: 100 };
    const base = weights[r.stage] ?? 0;
    if (r.stage === 'l5_writing' && Number(r.chaptersTotal) > 0) {
      return Math.min(99, base + Math.round((Number(r.chaptersDone) / Number(r.chaptersTotal)) * (100 - 14 - 2)));
    }
    return Math.min(100, base + (r.stage === 'done' ? 0 : 2));
  }

  private stageIdx(s: string): number { return STAGES.indexOf(s as any); }

  private async loadTask(uuid: string): Promise<TaskRow> {
    const rows = await this.prisma.$queryRawUnsafe<TaskRow[]>(
      'SELECT * FROM novel_gen_tasks WHERE uuid = ?', uuid,
    );
    if (!rows.length) throw new NotFoundException('任务不存在');
    return rows[0];
  }

  private async loadStage(uuid: string): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<{ stage: string }[]>(
      'SELECT stage FROM novel_gen_tasks WHERE uuid = ?', uuid,
    );
    return rows[0]?.stage || 'l1_concept';
  }

  private async loadCounters(uuid: string): Promise<{ chaptersDone: number }> {
    const rows = await this.prisma.$queryRawUnsafe<{ chaptersDone: number }[]>(
      'SELECT chaptersDone FROM novel_gen_tasks WHERE uuid = ?', uuid,
    );
    return rows[0] || { chaptersDone: 0 };
  }

  private parseBible(task: TaskRow): any {
    if (typeof task.bibleJson === 'string') { try { return JSON.parse(task.bibleJson); } catch { return {}; } }
    return task.bibleJson || {};
  }

  /** 每步落库(断点:bibleJson 整体覆写,游标 stage/chaptersDone 前进) */
  private async saveStage(
    uuid: string, stage: string, bible: any,
    counters?: { chaptersDone?: number; charsDone?: number },
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE novel_gen_tasks SET stage = ?, bibleJson = CAST(? AS JSON),
         chaptersDone = COALESCE(?, chaptersDone), charsDone = COALESCE(?, charsDone),
         updatedAt = CURRENT_TIMESTAMP(3) WHERE uuid = ?`,
      stage, JSON.stringify(bible),
      counters?.chaptersDone ?? null, counters?.charsDone ?? null, uuid,
    );
  }

  private tierOf(targetChars: number) {
    return SIZE_TIERS.find(t => t.chars === targetChars) ?? SIZE_TIERS[2];
  }

  private volumeCount(chaptersTotal: number): number {
    return Math.max(2, Math.min(10, Math.round(chaptersTotal / 30) || 2));
  }

  private volumeOf(bible: any, ch: number, total: number): number {
    const vols = bible?.volumes || [];
    if (!vols.length) return Math.min(vols.length || 1, Math.ceil(ch / (total / this.volumeCount(total))));
    for (let i = 0; i < vols.length; i++) {
      const m = String(vols[i].chapters || '').match(/(\d+)\s*[-~]\s*(\d+)/);
      if (m && ch >= Number(m[1]) && ch <= Number(m[2])) return i + 1;
    }
    return vols.length;
  }

  private volumeStartCh(bible: any, vol: number, total: number, ch: number): number {
    const vols = bible?.volumes || [];
    const m = String(vols[vol - 1]?.chapters || '').match(/(\d+)\s*[-~]\s*(\d+)/);
    return m ? Number(m[1]) : Math.max(1, ch - (ch % Math.ceil(total / this.volumeCount(total))));
  }

  private volumeEndCh(bible: any, vol: number, total: number, ch: number): number {
    const vols = bible?.volumes || [];
    const m = String(vols[vol - 1]?.chapters || '').match(/(\d+)\s*[-~]\s*(\d+)/);
    return m ? Number(m[2]) : Math.min(total, ch + Math.ceil(total / this.volumeCount(total)) - (ch % Math.ceil(total / this.volumeCount(total))));
  }

  /** 最近一章的结尾 300 字(供下一章无缝衔接) */
  private tailSummary(novelPath: string): string {
    try {
      const text = fs.readFileSync(novelPath, 'utf8');
      return text.slice(-300);
    } catch { return ''; }
  }

  /** 试读:最近完成章的结尾 400 字 */
  private readTailPreview(r: TaskRow): string | null {
    try {
      if (!r.novelStorageKey && r.stage !== 'l5_writing' && r.stage !== 'done') return null;
      const p = path.join(this.novelDir, `${r.uuid}.txt`);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8').slice(-400);
    } catch { return null; }
  }
}
