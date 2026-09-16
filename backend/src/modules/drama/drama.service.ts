// ============================================================================
// DramaService —— 微短剧「剧 / 集 / 资产」数据层与业务规则
// ----------------------------------------------------------------------------
// 设计方案:docs/微短剧分集与资产库设计方案_2026-08-28.html
//
// 为什么全用 $queryRawUnsafe:backend 运行中 query_engine.dll 被锁,
//   prisma generate 跑不动(与 open-montage.service.ts 同一约束、同一套路)。
//   schema.prisma 里的 Drama/DramaEpisode/DramaAsset/DramaBatch 是数据层契约文档。
//
// M1 范围:剧 CRUD、资产 CRUD(含锁定/变体/软删)、集 CRUD、
//         资产预检 + 裁决回写、世界状态快照回写(带 epNo 单调守卫)、
//         连集批任务的记录与查询(编排器 M4 接 BullMQ)。
// M2/M3 才接入 LLM / 图像 / 视频生成,本文件不含生成逻辑。
// ============================================================================

import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenMontageService } from '../open-montage/open-montage.service';
import { BATCH_HEARTBEAT_KIND, BeatExtra } from '../../common/upstream-heartbeat';
import {
  matchAssets, summarize, applyDecision, suggestSlug, normalizeName,
  type AssetNeed, type AssetRecord, type MatchResult, type PrecheckReport,
} from './asset-matcher';
import { planAssetShots, portraitFileTag } from './concept-art';
import {
  buildKeyframePlan, type KeyframeShot, type RefAsset,
} from './keyframe-plan';
import {
  buildEpisodeOutlinePrompt, normalizeEpisodeOutline, outlineQuoteStats,
} from './episode-outline-prompt';
import { buildEpisodeAnchor, type LedgerChapterLike, type BeatAnchorLike } from './novel-anchor';
import { applyTextEdits } from './timeline';
import {
  VISUAL_QC_SYS, VISUAL_QC_MAX_REDRAW, buildVisualQcQuestion, parseVisualQcVerdict,
} from './visual-qc';
import { planDegradedRetry } from './degraded-retry';
import { dramaNovelDir } from '../../common/paths';

const DEFAULT_AGENT_ID = 201;

/** 集内 6 步(对齐设计方案第 2 节;区别于旧 8 步向导) */
export const EPISODE_STEP_LABELS = [
  '承接与大纲',
  '资产预检',
  '分镜脚本',
  '分镜关键帧',
  '分镜视频',
  '成片与状态回写',
];

/** 资产类别白名单 */
const ASSET_KINDS = ['character', 'location', 'prop', 'vehicle', 'wardrobe'];

// ── 原始行类型(BigInt 由 Prisma 返回,统一转 string 出参) ──
interface DramaRow {
  id: bigint; uuid: string; userId: bigint; agentId: bigint; title: string;
  logline: string | null; synopsis: string | null; coverUrl: string | null;
  status: string; storyMode: string;
  bible: any; styleSpec: any; storyArc: any; snapshot: any;
  createdAt: Date; updatedAt: Date;
}
interface EpisodeRow {
  id: bigint; uuid: string; dramaId: bigint; epNo: number; title: string;
  logline: string | null; hookIn: string | null; hookOut: string | null;
  status: string; step: number; stepData: any; usedAssets: any; newAssets: any;
  finalUrl: string | null; posterUrl: string | null;
  durationSec: number | null; shotCount: number | null;
  credits: number; refunded: number; error: string | null;
  createdAt: Date; updatedAt: Date;
}
interface AssetRow {
  id: bigint; uuid: string; dramaId: bigint; kind: string; slug: string; name: string;
  aliases: any; descVisual: string; descPersona: string | null;
  refs: any; variants: any; source: string; sourceEp: number | null;
  status: string; locked: number | boolean; styleSig: string | null; useCount: number;
  createdAt: Date; updatedAt: Date;
}
interface BatchRow {
  id: bigint; uuid: string; dramaId: bigint; userId: bigint;
  fromEp: number; toEp: number; policy: any; status: string;
  cursorEp: number; cursorStep: number; rootJobId: string | null;
  log: any; error: string | null; createdAt: Date; updatedAt: Date;
}

@Injectable()
export class DramaService {
  private readonly logger = new Logger(DramaService.name);

  /** 资产参考图本地落盘目录(OSS 未配时的唯一可靠存储;上游 URL 会过期) */
  private readonly assetsDir: string;
  /** 一致性试机帧目录,按剧分组,删剧时一并回收 */
  private readonly previewsDir: string;
  /** 成片落盘根目录:uploads/dramas/{dramaUuid}/ep{N}/final.mp4 */
  private readonly dramasDir: string;

  constructor(
    private readonly prisma: PrismaService,
    // 复用 open-montage 的 LLM / 图像实现:定妆提示词与调用链只有一份。
    // 两条路径各写一套,是角色画飘 + 维护漏改的头号成因。
    private readonly montage: OpenMontageService,
  ) {
    this.assetsDir = path.resolve(process.cwd(), 'uploads', 'drama-assets');
    fs.mkdirSync(this.assetsDir, { recursive: true });
    this.previewsDir = path.resolve(process.cwd(), 'uploads', 'drama-previews');
    fs.mkdirSync(this.previewsDir, { recursive: true });
    this.dramasDir = path.resolve(process.cwd(), 'uploads', 'dramas');
    fs.mkdirSync(this.dramasDir, { recursive: true });
  }

  // ==========================================================================
  // 剧
  // ==========================================================================

  async createDrama(params: {
    userId: number; agentId?: number; title?: string; topic?: string;
    logline?: string; synopsis?: string; genre?: string; storyMode?: string;
    styleSpec?: Record<string, any>; bible?: Record<string, any>;
  }): Promise<any> {
    const uuid = randomUUID();
    const title = (params.title || params.topic || '未命名剧集').trim().slice(0, 200);
    const styleSpec = this.normalizeStyle(params.styleSpec || {});
    const bible = {
      world: params.bible?.world || '',
      era: params.bible?.era || '',
      genre: params.bible?.genre || params.genre || '现代都市',
      tone: params.bible?.tone || '',
      relationships: Array.isArray(params.bible?.relationships) ? params.bible.relationships : [],
      rules: Array.isArray(params.bible?.rules) ? params.bible.rules : [],
    };
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO \`Drama\`
        (\`uuid\`,\`userId\`,\`agentId\`,\`title\`,\`logline\`,\`synopsis\`,\`status\`,\`storyMode\`,
         \`bible\`,\`styleSpec\`,\`storyArc\`,\`snapshot\`,\`createdAt\`,\`updatedAt\`)
       VALUES (?,?,?,?,?,?, 'setup', ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON),
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      uuid, params.userId, params.agentId ?? DEFAULT_AGENT_ID, title,
      params.logline || params.topic || '', params.synopsis || null,
      params.storyMode === 'unit' ? 'unit' : 'serial',
      JSON.stringify(bible), JSON.stringify(styleSpec), JSON.stringify([]), JSON.stringify({}),
    );
    this.logger.log(`[drama] created ${uuid} by user ${params.userId}`);
    return this.getDrama(uuid);
  }

  /** 我的剧集:带分集进度与资产数,给「我的剧集」卡片墙 */
  async listDramas(userId: number): Promise<any[]> {
    const rows = await this.prisma.$queryRawUnsafe<DramaRow[]>(
      `SELECT d.*,
              (SELECT COUNT(*) FROM \`DramaEpisode\` e WHERE e.dramaId = d.id) AS epCount,
              (SELECT COUNT(*) FROM \`DramaEpisode\` e WHERE e.dramaId = d.id AND e.status = 'done') AS doneCount,
              (SELECT COUNT(*) FROM \`DramaAsset\` a WHERE a.dramaId = d.id AND a.status <> 'deprecated') AS assetCount,
              (SELECT MAX(e.epNo) FROM \`DramaEpisode\` e WHERE e.dramaId = d.id) AS maxEpNo,
              (SELECT COUNT(*) FROM \`dramas_novel_ledger\` nl WHERE nl.dramaId = d.id) AS ledgerCount,
              (SELECT g.gate FROM \`dramas_gates\` g
                WHERE g.dramaId = d.id AND g.status <> 'passed'
                ORDER BY g.gate LIMIT 1) AS openGate
         FROM \`Drama\` d
        WHERE d.userId = ?
        ORDER BY d.updatedAt DESC`,
      userId,
    );
    return (rows || []).map((r: any) => ({
      ...this.fmtDrama(r),
      episodeCount: Number(r.epCount ?? 0),
      doneEpisodes: Number(r.doneCount ?? 0),
      assetCount: Number(r.assetCount ?? 0),
      maxEpNo: r.maxEpNo == null ? 0 : Number(r.maxEpNo),
      // 2026-09-15:走没走过 Novel2Drama 对齐链路,决定这张卡要不要给「继续做剧」。
      // 缺这两个字段,剧集列表对一键生成的项目就是死胡同 —— 只看得到分集/资产,
      // 看不出项目其实停在某道审批门上等人确认(库里 20+ 部就是这么堆着的)。
      hasNovelLedger: Number(r.ledgerCount ?? 0) > 0,
      openGate: r.openGate ?? null,
    }));
  }

  async getDrama(uuid: string): Promise<any> {
    const row = await this.requireDrama(uuid);
    const episodes = await this.listEpisodesByDramaId(row.id);
    const assets = await this.listAssetsByDramaId(row.id);
    const batches = await this.listBatchesByDramaId(row.id);
    // 是否已有小说原文快照(账本) —— 前端据此决定要不要给「读原文」入口,
    // 免得没 ingest 的剧点进去必然报错。一次 COUNT,不读文件。
    const ledger = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT COUNT(*) AS n FROM dramas_novel_ledger WHERE dramaId = ? AND novelStorageKey IS NOT NULL',
      row.id,
    );
    return {
      ...this.fmtDrama(row),
      episodeStepLabels: EPISODE_STEP_LABELS,
      episodes,
      assets,
      batches,
      // 下一集该接住的钩子,前端建集时直接展示
      nextHookIn: episodes.length ? (episodes[episodes.length - 1].hookOut || '') : '',
      hasNovelText: Number(ledger?.[0]?.n ?? 0) > 0,
    };
  }

  async updateDrama(uuid: string, patch: {
    title?: string; logline?: string; synopsis?: string; coverUrl?: string;
    status?: string; bible?: Record<string, any>; storyMode?: string;
  }): Promise<any> {
    const row = await this.requireDrama(uuid);
    const sets: string[] = [];
    const args: any[] = [];
    const put = (col: string, val: any) => { sets.push(`\`${col}\` = ?`); args.push(val); };
    if (patch.title !== undefined) put('title', patch.title.trim().slice(0, 200));
    if (patch.logline !== undefined) put('logline', patch.logline);
    if (patch.synopsis !== undefined) put('synopsis', patch.synopsis);
    if (patch.coverUrl !== undefined) put('coverUrl', patch.coverUrl);
    if (patch.status !== undefined) put('status', patch.status);
    if (patch.storyMode !== undefined) put('storyMode', patch.storyMode === 'unit' ? 'unit' : 'serial');
    if (patch.bible !== undefined) {
      sets.push('`bible` = CAST(? AS JSON)');
      args.push(JSON.stringify({ ...this.parseJson(row.bible, {}), ...patch.bible }));
    }
    if (!sets.length) return this.getDrama(uuid);
    args.push(row.id);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`Drama\` SET ${sets.join(',')}, \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      ...args,
    );
    return this.getDrama(uuid);
  }

  /**
   * 改风格圣经。风格是全剧一致性的锚,改动会让已生成资产"穿帮",
   * 所以这里重算 sigHash 并返回与新签名不一致的资产数,让前端提示"是否重制"。
   */
  async updateStyleSpec(uuid: string, styleSpec: Record<string, any>): Promise<any> {
    const row = await this.requireDrama(uuid);
    const next = this.normalizeStyle({ ...this.parseJson(row.styleSpec, {}), ...styleSpec });
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`Drama\` SET \`styleSpec\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(next), row.id,
    );
    const stale = await this.prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM \`DramaAsset\`
        WHERE \`dramaId\` = ? AND \`status\` <> 'deprecated'
          AND (\`locked\` = 0) AND (\`styleSig\` IS NULL OR \`styleSig\` <> ?)`,
      row.id, next.sigHash,
    );
    return { styleSpec: next, staleAssetCount: Number(stale?.[0]?.c ?? 0) };
  }

  /** 全季故事线(人工或 LLM 产出后整体写入) */
  async setStoryArc(uuid: string, arc: any[]): Promise<any> {
    const row = await this.requireDrama(uuid);
    if (!Array.isArray(arc)) throw new BadRequestException('storyArc 必须是数组');
    const norm = arc.map((a, i) => ({
      ep: Number(a.ep ?? i + 1),
      purpose: String(a.purpose || ''),
      mustHave: Array.isArray(a.mustHave) ? a.mustHave : [],
      cliffhanger: String(a.cliffhanger || ''),
      done: a.done === true,
    })).sort((x, y) => x.ep - y.ep);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`Drama\` SET \`storyArc\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(norm), row.id,
    );
    return this.getDrama(uuid);
  }

  /**
   * 删剧:DB 走级联删除,资产参考图目录**移进 uploads/drama-assets/.trash/ 而不是 rm**。
   * 定妆图是不可再生(要再烧一次配额)且用户可能反悔的产物,静默删文件不可接受。
   * 返回回收目录路径,便于运维定期清理或用户找回。
   */
  async deleteDrama(uuid: string): Promise<{ ok: true; trashedDirs: string[] }> {
    const row = await this.requireDrama(uuid);
    const assetRows = await this.prisma.$queryRawUnsafe<{ uuid: string }[]>(
      `SELECT \`uuid\` FROM \`DramaAsset\` WHERE \`dramaId\` = ?`, row.id,
    );
    // 级联删除分集/资产/批任务(建表时已声明 ON DELETE CASCADE)
    await this.prisma.$executeRawUnsafe(`DELETE FROM \`Drama\` WHERE \`id\` = ?`, row.id);

    const trashedDirs: string[] = [];
    const trashRoot = path.join(this.assetsDir, '.trash');
    for (const a of assetRows || []) {
      const src = path.join(this.assetsDir, a.uuid);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(trashRoot, `${a.uuid}-${Date.now()}`);
      try {
        fs.mkdirSync(trashRoot, { recursive: true });
        fs.renameSync(src, dst);
        trashedDirs.push(`uploads/drama-assets/.trash/${path.basename(dst)}`);
      } catch (e: any) {
        this.logger.warn(`[drama] 资产目录回收失败 ${a.uuid}: ${e?.message}`);
      }
    }
    // 成片目录按剧整体回收(uploads/dramas/{uuid}),否则删剧会留下无主视频
    const filmDir = path.join(this.dramasDir, row.uuid);
    if (fs.existsSync(filmDir)) {
      try {
        const filmTrash = path.join(this.dramasDir, '.trash');
        fs.mkdirSync(filmTrash, { recursive: true });
        const fdst = path.join(filmTrash, `${row.uuid}-${Date.now()}`);
        fs.renameSync(filmDir, fdst);
        trashedDirs.push(`uploads/dramas/.trash/${path.basename(fdst)}`);
      } catch (e: any) {
        this.logger.warn(`[drama] 成片目录回收失败: ${e?.message}`);
      }
    }
    // 试机帧按剧目录整体回收
    const prevDir = path.join(this.previewsDir, row.uuid);
    if (fs.existsSync(prevDir)) {
      try {
        const prevTrash = path.join(this.previewsDir, '.trash');
        fs.mkdirSync(prevTrash, { recursive: true });
        const dst = path.join(prevTrash, `${row.uuid}-${Date.now()}`);
        fs.renameSync(prevDir, dst);
        trashedDirs.push(`uploads/drama-previews/.trash/${path.basename(dst)}`);
      } catch (e: any) {
        this.logger.warn(`[drama] 试机目录回收失败: ${e?.message}`);
      }
    }
    this.logger.log(`[drama] deleted ${uuid},回收 ${trashedDirs.length} 个目录`);
    return { ok: true, trashedDirs };
  }

  // ==========================================================================
  // 资产
  // ==========================================================================

  async listAssets(dramaUuid: string, q: { kind?: string; status?: string; keyword?: string } = {}): Promise<any[]> {
    const drama = await this.requireDrama(dramaUuid);
    return this.listAssetsByDramaId(drama.id, q);
  }

  /**
   * 2026-09-16:每个 kind 的资产数(排除软删)—— 资产库分类 chip 的数量 badge。
   * 前端 chip 之前只显示类别名,用户点进去空不空全靠猜;有计数后空类别
   * 直接灰显"本书未涉及",不再误导(七问题之问题5)。
   */
  async assetKindCounts(dramaUuid: string): Promise<Record<string, number>> {
    const drama = await this.requireDrama(dramaUuid);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ kind: string; c: bigint | number }>>(
      `SELECT \`kind\`, COUNT(*) AS c FROM \`DramaAsset\`
        WHERE \`dramaId\` = ? AND \`status\` <> 'deprecated'
        GROUP BY \`kind\``,
      drama.id,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.kind)] = Number(r.c) || 0;
    return out;
  }

  async getAsset(dramaUuid: string, assetIdOrSlug: string): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT * FROM \`DramaAsset\` WHERE \`dramaId\` = ?
         AND (\`id\` = ? OR \`slug\` = ? OR \`uuid\` = ?) LIMIT 1`,
      drama.id, Number.isNaN(Number(assetIdOrSlug)) ? -1 : Number(assetIdOrSlug), assetIdOrSlug, assetIdOrSlug,
    );
    if (!rows.length) throw new NotFoundException(`资产不存在: ${assetIdOrSlug}`);
    return this.fmtAsset(rows[0]);
  }

  async createAsset(dramaUuid: string, input: {
    kind: string; slug?: string; name: string; aliases?: string[];
    descVisual: string; descPersona?: string; refs?: any[]; variants?: any[];
    source?: string; sourceEp?: number; status?: string; locked?: boolean;
  }): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const kind = String(input.kind || '').trim();
    if (!ASSET_KINDS.includes(kind)) {
      throw new BadRequestException(`kind 必须是 ${ASSET_KINDS.join('/')}`);
    }
    const name = String(input.name || '').trim();
    if (!name) throw new BadRequestException('资产名称不能为空');
    if (!String(input.descVisual || '').trim()) {
      throw new BadRequestException('锚定描述(descVisual)不能为空 —— 它是跨集一致性的唯一文字依据');
    }
    const slug = await this.resolveSlug(drama.id, kind, input.slug, name);
    const styleSig = this.parseJson(drama.styleSpec, {}).sigHash || null;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO \`DramaAsset\`
        (\`uuid\`,\`dramaId\`,\`kind\`,\`slug\`,\`name\`,\`aliases\`,\`descVisual\`,\`descPersona\`,
         \`refs\`,\`variants\`,\`source\`,\`sourceEp\`,\`status\`,\`locked\`,\`styleSig\`,\`useCount\`,
         \`createdAt\`,\`updatedAt\`)
       VALUES (?,?,?,?,?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), CAST(? AS JSON),
               ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      randomUUID(), drama.id, kind, slug, name,
      JSON.stringify(Array.isArray(input.aliases) ? input.aliases : []),
      input.descVisual, input.descPersona || null,
      JSON.stringify(Array.isArray(input.refs) ? input.refs : []),
      JSON.stringify(Array.isArray(input.variants) ? input.variants : []),
      input.source || 'manual', input.sourceEp ?? null,
      input.status || 'confirmed', input.locked ? 1 : 0, styleSig,
    );
    return this.getAsset(dramaUuid, slug);
  }

  async updateAsset(dramaUuid: string, assetId: string, patch: {
    name?: string; descVisual?: string; descPersona?: string; aliases?: string[];
    refs?: any[]; status?: string;
  }): Promise<any> {
    const { drama, asset } = await this.requireAsset(dramaUuid, assetId);
    const sets: string[] = [];
    const args: any[] = [];
    const put = (col: string, val: any) => { sets.push(`\`${col}\` = ?`); args.push(val); };
    if (patch.name !== undefined) put('name', String(patch.name).trim().slice(0, 120));
    if (patch.descVisual !== undefined) put('descVisual', patch.descVisual);
    if (patch.descPersona !== undefined) put('descPersona', patch.descPersona);
    if (patch.aliases !== undefined) {
      sets.push('`aliases` = CAST(? AS JSON)');
      args.push(JSON.stringify(patch.aliases));
    }
    if (patch.refs !== undefined) {
      if (asset.locked) throw new ConflictException('资产已锁定,禁止覆盖参考图(先解锁)');
      sets.push('`refs` = CAST(? AS JSON)');
      args.push(JSON.stringify(patch.refs));
    }
    if (patch.status !== undefined) put('status', patch.status);
    if (!sets.length) return this.fmtAsset(asset);
    args.push(asset.id);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaAsset\` SET ${sets.join(',')}, \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      ...args,
    );
    void drama;
    return this.getAsset(dramaUuid, String(asset.id));
  }

  /** 把某个视图设为 canonical(后续图生图默认拿它当参考) */
  async setCanonicalRef(dramaUuid: string, assetId: string, angle: string): Promise<any> {
    const { asset } = await this.requireAsset(dramaUuid, assetId);
    const refs = this.parseJson(asset.refs, []) as any[];
    if (!refs.length) throw new BadRequestException('该资产还没有参考图,先定妆或上传');
    let hit = false;
    const next = refs.map((r) => {
      const on = !hit && String(r.angle || '') === String(angle || '');
      if (on) hit = true;
      return { ...r, canonical: on };
    });
    if (!hit) throw new BadRequestException(`没有角度为「${angle}」的参考图`);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaAsset\` SET \`refs\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(next), asset.id,
    );
    return this.getAsset(dramaUuid, String(asset.id));
  }

  async setLocked(dramaUuid: string, assetId: string, locked: boolean): Promise<any> {
    const { asset } = await this.requireAsset(dramaUuid, assetId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaAsset\` SET \`locked\` = ?, \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      locked ? 1 : 0, asset.id,
    );
    return this.getAsset(dramaUuid, String(asset.id));
  }

  async confirmAsset(dramaUuid: string, assetId: string): Promise<any> {
    return this.updateAsset(dramaUuid, assetId, { status: 'confirmed' });
  }

  /** 同角色换装 / 同场景换时刻 —— 加变体而不是新建资产 */
  async addVariant(dramaUuid: string, assetId: string, v: {
    label: string; descDelta?: string; fromEp?: number; refs?: any[];
  }): Promise<any> {
    const { asset } = await this.requireAsset(dramaUuid, assetId);
    const label = String(v.label || '').trim();
    if (!label) throw new BadRequestException('变体标签(label)不能为空');
    const variants = this.parseJson(asset.variants, []) as any[];
    if (variants.some((x) => normalizeName(x.label) === normalizeName(label))) {
      throw new ConflictException(`变体「${label}」已存在`);
    }
    variants.push({
      id: `v${variants.length + 1}`, label,
      descDelta: v.descDelta || '', fromEp: v.fromEp ?? null,
      refs: Array.isArray(v.refs) ? v.refs : [],
    });
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaAsset\` SET \`variants\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(variants), asset.id,
    );
    return this.getAsset(dramaUuid, String(asset.id));
  }

  /** 软删除:有引用时禁止,避免历史集成片的关键帧引用断链 */
  async deprecateAsset(dramaUuid: string, assetId: string): Promise<any> {
    const { asset } = await this.requireAsset(dramaUuid, assetId);
    if (Number(asset.useCount) > 0) {
      throw new ConflictException(`该资产已被引用 ${asset.useCount} 次,不能删除;如需停用请锁定`);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaAsset\` SET \`status\` = 'deprecated', \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      asset.id,
    );
    return this.getAsset(dramaUuid, String(asset.id));
  }

  /** 反向引用:这个资产被哪些集的哪些镜头用到 */
  async assetUsage(dramaUuid: string, assetId: string): Promise<any[]> {
    const { drama, asset } = await this.requireAsset(dramaUuid, assetId);
    const eps = await this.prisma.$queryRawUnsafe<EpisodeRow[]>(
      `SELECT * FROM \`DramaEpisode\` WHERE \`dramaId\` = ? ORDER BY \`epNo\` ASC`, drama.id,
    );
    const out: any[] = [];
    for (const e of eps) {
      const used = this.parseJson(e.usedAssets, []) as any[];
      const hit = used.find((u) => String(u.assetId) === String(asset.id));
      if (hit) out.push({ epNo: e.epNo, title: e.title, slug: hit.slug, variant: hit.variant || null, shotIdxs: hit.shotIdxs || [] });
    }
    return out;
  }

  // ==========================================================================
  // 集
  // ==========================================================================

  async createEpisode(dramaUuid: string, input: { epNo?: number; title?: string; brief?: string }): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const eps = await this.listEpisodesByDramaId(drama.id);
    const epNo = input.epNo && input.epNo > 0 ? input.epNo : (eps.length ? Math.max(...eps.map((e) => e.epNo)) + 1 : 1);
    if (eps.some((e) => e.epNo === epNo)) throw new ConflictException(`第 ${epNo} 集已存在`);
    const prev = eps.length ? eps[eps.length - 1] : null;
    // 逐集承接:开场钩子直接继承上一集结尾钩子,用户不必重复输入前情
    const hookIn = prev?.hookOut || '';
    const title = (input.title || `第 ${epNo} 集`).trim().slice(0, 200);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO \`DramaEpisode\`
        (\`uuid\`,\`dramaId\`,\`epNo\`,\`title\`,\`hookIn\`,\`status\`,\`step\`,
         \`stepData\`,\`usedAssets\`,\`newAssets\`,\`credits\`,\`refunded\`,\`createdAt\`,\`updatedAt\`)
       VALUES (?,?,?,?,?, 'pending', 0, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), 0, 0,
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      randomUUID(), drama.id, epNo, title, hookIn || null,
      JSON.stringify(input.brief ? { '0': { input: { brief: input.brief } } } : {}),
      JSON.stringify([]), JSON.stringify([]),
    );
    if (drama.status === 'setup') {
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`Drama\` SET \`status\` = 'producing', \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        drama.id,
      );
    }
    return this.getEpisode(dramaUuid, epNo);
  }

  async getEpisode(dramaUuid: string, epNo: number): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    return this.fmtEpisode(row);
  }

  /**
   * 删除某一集。默认拒绝删掉已有成片的集(成片是烧过配额的作品),
   * 要连作品一起删得显式 force,并把该集成片目录移进回收而非硬删。
   */
  async deleteEpisode(dramaUuid: string, epNo: number, force = false): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    if (row.finalUrl && !force) {
      throw new ConflictException(
        `第 ${epNo} 集已有成片(${row.finalUrl}),要连作品一起删请显式 force`,
      );
    }
    if (row.finalUrl && force) {
      const dir = path.join(this.dramasDir, drama.uuid, `ep${epNo}`);
      if (fs.existsSync(dir)) {
        const trash = path.join(this.dramasDir, drama.uuid, '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(dir, path.join(trash, `ep${epNo}-${Date.now()}`));
      }
    }
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM \`DramaEpisode\` WHERE \`id\` = ?`, row.id,
    );

    // 删的若是快照来源集,必须把 sourceEp 回滚到剩余最大集数。
    // 不回滚,epNo 单调守卫会从此静默拒绝每一次回写 —— 快照卡在一个不存在的未来集上。
    let rolledBackTo: number | null = null;
    const snap = this.parseJson(drama.snapshot, {}) as any;
    if (Number(snap.sourceEp || 0) === epNo) {
      const rest = await this.prisma.$queryRawUnsafe<{ maxEp: number | null }[]>(
        `SELECT MAX(\`epNo\`) AS maxEp FROM \`DramaEpisode\` WHERE \`dramaId\` = ?`, drama.id,
      );
      const newSource = Number(rest?.[0]?.maxEp || 0);
      snap.sourceEp = newSource;
      // 被删那集贡献的既定事实不会自动撤销(暂无逐集事实溯源),显式标记出来,
      // 比假装干净诚实。
      snap.staleFactsFrom = Array.from(new Set([
        ...(Array.isArray(snap.staleFactsFrom) ? snap.staleFactsFrom : []), epNo,
      ]));
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`Drama\` SET \`snapshot\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        JSON.stringify(snap), drama.id,
      );
      rolledBackTo = newSource;
      this.logger.warn(
        `[drama] ${dramaUuid} 删除快照来源 EP${epNo},sourceEp 回滚至 EP${newSource};` +
        `既定事实可能仍含被删集贡献(staleFactsFrom=${JSON.stringify(snap.staleFactsFrom)})`,
      );
    }

    this.logger.log(`[drama] ${dramaUuid} 删除第 ${epNo} 集${force ? ' (force,含成片回收)' : ''}`);
    return { ok: true, epNo, snapshotRolledBackTo: rolledBackTo };
  }

  /** 集内某步的产出覆盖写入(人工编辑用) */
  async updateStepOutput(dramaUuid: string, epNo: number, step: number, output: any): Promise<any> {
    this.checkStep(step);
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    sd[String(step)] = { ...(sd[String(step)] || {}), output, updatedAt: new Date().toISOString() };
    await this.saveStepData(row.id, sd);
    return this.fmtEpisode({ ...row, stepData: sd });
  }

  async confirmStep(dramaUuid: string, epNo: number, step: number, output?: any): Promise<any> {
    this.checkStep(step);
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    const key = String(step);
    if (!sd[key] || sd[key].output == null) {
      throw new BadRequestException(`第 ${step} 步还没有产出,无法确认`);
    }
    sd[key] = { ...sd[key], ...(output ? { output } : {}), confirmedAt: new Date().toISOString() };
    const nextStep = Math.min(step + 1, EPISODE_STEP_LABELS.length - 1);
    const nextStatus = step === EPISODE_STEP_LABELS.length - 1 ? row.status : this.statusOfStep(nextStep);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON), \`step\` = ?, \`status\` = ?,
              \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(sd), nextStep, nextStatus, row.id,
    );
    return this.getEpisode(dramaUuid, epNo);
  }

  async deleteStepOutput(dramaUuid: string, epNo: number, step: number): Promise<any> {
    this.checkStep(step);
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    const key = String(step);
    sd[key] = { input: sd[key]?.input ?? null };
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON), \`step\` = ?, \`status\` = ?,
              \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(sd), step, this.statusOfStep(step), row.id,
    );
    return this.getEpisode(dramaUuid, epNo);
  }

  // ==========================================================================
  // 资产预检(本方案的核心新流程)
  // ==========================================================================

  /**
   * 跑一次预检:把本集需要的资产与剧级库 diff,结果存进 step 1。
   * 纯匹配逻辑在 asset-matcher.ts(有完整单测),这里只负责取库 + 落库。
   */
  async precheckAssets(dramaUuid: string, epNo: number, needs: AssetNeed[]): Promise<PrecheckReport> {
    if (!Array.isArray(needs)) throw new BadRequestException('needs 必须是数组');
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const library = (await this.listAssetsByDramaId(drama.id)) as unknown as AssetRecord[];
    const results = matchAssets(needs, library);
    const report = summarize(results);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    sd['1'] = { ...(sd['1'] || {}), output: report, generatedAt: new Date().toISOString() };
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON), \`status\` = 'asset_check',
              \`step\` = 1, \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(sd), row.id,
    );
    this.logger.log(
      `[precheck] drama=${drama.uuid} ep=${epNo} 需要${report.summary.total}项 ` +
      `命中${report.hits.length} 变体${report.variants.length} 待裁决${report.ambiguous.length} ` +
      `新增${report.news.length} 复用缺定妆图${report.summary.awaitingRefs}`,
    );
    return report;
  }

  /**
   * 应用用户对预检结果的裁决。
   * 关键:非精确命中的确认会写入 aliases —— 下次同样写法直接精确命中,
   *       连集模式才不会反复被同一个问题卡住。
   */
  async resolvePrecheck(dramaUuid: string, epNo: number, decisions: Array<{
    /** 对应 needs 的下标 */
    index: number;
    /** 判定为复用/变体时的资产 id;留空表示新建 */
    assetId?: string;
    /** 作为该资产的哪个变体(留空 = 不加变体) */
    asVariantLabel?: string;
    /** verdict=new 时补齐 slug(中文名建议给英文标识) */
    slug?: string;
    refs?: any[];
  }>): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    const report = sd['1']?.output as PrecheckReport | undefined;
    if (!report) throw new BadRequestException('请先跑一次资产预检');
    const all: MatchResult[] = [...report.hits, ...report.variants, ...report.ambiguous, ...report.news];

    const used = this.parseJson(row.usedAssets, []) as any[];
    const created: any[] = this.parseJson(row.newAssets, []) as any[];
    const alreadyUsed = new Set(used.map((u) => String(u.assetId)));
    let touchedThisRound = 0;

    for (const d of decisions) {
      const r = all[d.index];
      if (!r) throw new BadRequestException(`预检结果下标 ${d.index} 不存在`);
      const action = applyDecision(r.need, r, { assetId: d.assetId, asVariantLabel: d.asVariantLabel });

      if (action.action === 'reuse' || action.action === 'add_alias') {
        if (action.action === 'add_alias') await this.appendAlias(action.assetId, action.alias);
        await this.markUsed(used, action.assetId, r, d);
        if (!alreadyUsed.has(String(action.assetId))) touchedThisRound++;
      } else if (action.action === 'add_variant') {
        const asset = await this.addVariantRaw(action.assetId, action.label, action.descDelta, epNo);
        void asset;
        await this.markUsed(used, action.assetId, r, d, action.label);
        if (!alreadyUsed.has(String(action.assetId))) touchedThisRound++;
      } else {
        // 新建资产:自动入库但标 pending,不阻塞后续集(用户回来可确认或回滚)
        const nd = action.need;
        const newAsset = await this.createAsset(dramaUuid, {
          kind: nd.kind, slug: d.slug || nd.slugHint, name: nd.name,
          descVisual: nd.descVisual || nd.name, descPersona: nd.descPersona,
          refs: d.refs || [], source: 'ep_new', sourceEp: epNo, status: 'pending',
        });
        created.push(newAsset.id);
        await this.markUsed(used, newAsset.id, { ...r, slug: newAsset.slug, name: newAsset.name }, d);
        touchedThisRound++;
      }
    }

    sd['1'] = { ...(sd['1'] || {}), resolvedAt: new Date().toISOString(), usedAssets: used };
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON), \`usedAssets\` = CAST(? AS JSON),
              \`newAssets\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(sd), JSON.stringify(used), JSON.stringify(created), row.id,
    );
    if (touchedThisRound > 0) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`DramaAsset\` SET \`useCount\` = \`useCount\` + 1, \`updatedAt\` = CURRENT_TIMESTAMP(3)
          WHERE \`id\` IN (${used.map(() => '?').join(',')})`,
        ...used.map((u) => Number(u.assetId)),
      );
    }
    return this.getEpisode(dramaUuid, epNo);
  }

  // ==========================================================================
  // 逐集承接:世界状态快照
  // ==========================================================================

  /**
   * 只把「叙事状态」合并进剧级快照,**不碰集记录**。
   *
   * 从 writeBackSnapshot 里抽出来的原因:叙事状态有两个写入时机。
   *   ① 第 0 步(大纲)落库后 —— 让下一集不必等本集的视频跑完;
   *   ② 第 5 步(成片)收尾 —— 原来的唯一时机。
   * 时机 ① 是「集间流水线」的前置条件:下一集的大纲只依赖本集第 0 步的产出
   * (hookOut 早就写在集记录上了),于是"下一集写大纲 + 出关键帧"可以与本集
   * "视频排队等待"并行 —— 而视频通道每 key 每分钟只准建 1 个任务,那 8 分钟里
   * LLM 与图像通道完全是闲的。
   *
   * 重复调用是安全的:establishedFacts 去重合并、characterStates 浅合并、
   * openHooks 缺省保留旧值,外加 sourceEp 单调守卫。
   *
   * @returns updated=false 表示被单调守卫拒绝(本集早于快照来源集)
   */
  async mergeNarrativeSnapshot(dramaUuid: string, epNo: number, patch: {
    establishedFacts?: string[]; characterStates?: Record<string, any>; openHooks?: string[];
  }): Promise<{ updated: boolean; prevSourceEp: number }> {
    const drama = await this.requireDrama(dramaUuid);
    const snap = this.parseJson(drama.snapshot, {}) as any;
    const prevSourceEp = Number(snap.sourceEp || 0);
    if (epNo < prevSourceEp) {
      // 不能只写日志:调用方可能以为"记忆已更新",实际下一集拿到的还是旧快照
      this.logger.warn(
        `[snapshot] 拒绝回退:drama=${drama.uuid} 本集 EP${epNo} < 快照来源 EP${prevSourceEp}`,
      );
      return { updated: false, prevSourceEp };
    }
    const next = {
      sourceEp: epNo,
      establishedFacts: Array.from(new Set([
        ...(Array.isArray(snap.establishedFacts) ? snap.establishedFacts : []),
        ...(Array.isArray(patch.establishedFacts) ? patch.establishedFacts : []),
      ])),
      characterStates: { ...(snap.characterStates || {}), ...(patch.characterStates || {}) },
      openHooks: Array.isArray(patch.openHooks) ? patch.openHooks : (snap.openHooks || []),
    };
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`Drama\` SET \`snapshot\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(next), drama.id,
    );
    return { updated: true, prevSourceEp };
  }

  /**
   * 本集结尾回写世界状态(叙事状态 + 生产字段 + 集终态)。
   * epNo 单调守卫:只有 epNo 大于快照来源集才允许覆盖 —— 否则连集并行完成时,
   * 先完成的集会被后完成的集错误回退(看起来能跑其实错)。
   *
   * ⚠ 会把集 `status` 置为 `done`。只做叙事合并(不动集记录)请用
   * `mergeNarrativeSnapshot()` —— 第 0 步就走的是那一条。
   */
  async writeBackSnapshot(dramaUuid: string, epNo: number, patch: {
    hookOut?: string; establishedFacts?: string[]; characterStates?: Record<string, any>;
    openHooks?: string[]; finalUrl?: string; posterUrl?: string;
    durationSec?: number; shotCount?: number;
  }): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const { updated: snapshotUpdated, prevSourceEp: srcEp } =
      await this.mergeNarrativeSnapshot(dramaUuid, epNo, {
        establishedFacts: patch.establishedFacts,
        characterStates: patch.characterStates,
        openHooks: patch.openHooks,
      });

    const sets: string[] = [];
    const args: any[] = [];
    if (patch.hookOut !== undefined) { sets.push('`hookOut` = ?'); args.push(patch.hookOut); }
    if (patch.finalUrl !== undefined) { sets.push('`finalUrl` = ?'); args.push(patch.finalUrl); }
    if (patch.posterUrl !== undefined) { sets.push('`posterUrl` = ?'); args.push(patch.posterUrl); }
    if (patch.durationSec !== undefined) { sets.push('`durationSec` = ?'); args.push(patch.durationSec); }
    if (patch.shotCount !== undefined) { sets.push('`shotCount` = ?'); args.push(patch.shotCount); }
    sets.push('`status` = ?'); args.push('done');
    args.push(row.id);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET ${sets.join(',')}, \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      ...args,
    );
    const ep = await this.getEpisode(dramaUuid, epNo);
    return {
      ...ep,
      snapshotUpdated,
      // 被拒绝时给出可操作的下一步,而不是让用户自己猜
      snapshotNotice: snapshotUpdated ? null
        : `世界状态未更新:本集 EP${epNo} 早于快照来源 EP${srcEp}。`
          + '若那几集已被删除,请删除当前最大集以触发回滚,或重建成更靠后的集号。',
    };
  }

  /** 下一集建集时给用户的"前情提要"卡片数据 */
  async continuityBrief(dramaUuid: string): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const eps = await this.listEpisodesByDramaId(drama.id);
    const last = eps.length ? eps[eps.length - 1] : null;
    const snap = this.parseJson(drama.snapshot, {}) as any;
    const arc = this.parseJson(drama.storyArc, []) as any[];
    const nextEpNo = last ? last.epNo + 1 : 1;
    return {
      nextEpNo,
      hookIn: last?.hookOut || '',
      snapshot: snap,
      arcForNext: arc.find((a) => Number(a.ep) === nextEpNo) || null,
      assetIndex: (await this.listAssetsByDramaId(drama.id))
        .filter((a: any) => a.status !== 'deprecated')
        .map((a: any) => ({ slug: a.slug, name: a.name, kind: a.kind, variants: (a.variants || []).map((v: any) => v.label) })),
    };
  }

  // ==========================================================================
  // 剧级定妆:LLM 出美术设计 -> 逐资产生成参考图并落地本地
  // ==========================================================================

  /**
   * 用剧的圣经 + 全季故事线跑一次美术设计,把角色/场景/道具建成 pending 资产。
   * 幂等:同 kind + 同 name 已存在(非 deprecated)就跳过,可以反复点。
   * 这步只花一次 LLM、不烧图像配额 —— 图像由 generatePortrait 逐资产触发,
   * 单个失败不影响其余,也不会把整请求吊在 HTTP 里等十几分钟。
   */
  /**
   * 2026-09-16(批4):从小说账本抽取资产名单 —— 设计阶段不再靠提示词硬编码
   *   "角色 2-5 / 道具 2-6"(与小说实际人物数无关,是"资产太少"的根因)。
   *   材料 = 章节标题 + beats(summary+逐字 quote),抽**具名**角色/场景/道具/载具/服装。
   *   缓存进 ledgerJson.assetRoster(re-ingest 会重建账本自然失效);
   *   LLM 失败/无账本 → null → 设计退回旧硬编码行为(降级不阻断)。
   */
  private async assetRosterFor(dramaId: bigint, userId: number): Promise<any | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: bigint; ledgerJson: any }>>(
        'SELECT id, ledgerJson FROM dramas_novel_ledger WHERE dramaId = ? LIMIT 1', dramaId,
      );
      if (!rows.length) return null;
      const lj = typeof rows[0].ledgerJson === 'string'
        ? this.parseJson(rows[0].ledgerJson, {}) : (rows[0].ledgerJson || {});
      if (lj.assetRoster && typeof lj.assetRoster === 'object') return lj.assetRoster;
      const beats: any[] = Array.isArray(lj.beats) ? lj.beats : [];
      const chapters: any[] = Array.isArray(lj.chapters) ? lj.chapters : [];
      if (!beats.length && !chapters.length) return null;
      const material = [
        ...chapters.slice(0, 40).map((c: any) => `章:${c.title || ''}`),
        ...beats.slice(0, 80).map(
          (b: any) => `- ${b.summary || ''}${b.quote ? ` 「${b.quote}」` : ''}`,
        ),
      ].join('\n');
      const raw = await this.montage.callLlm(
        { userId, agentId: DEFAULT_AGENT_ID },
        '你是小说设定抽取助手。从下面章节/beats 材料里抽取故事**实际涉及的具名**资产,' +
        '不要自行发明材料里没有的名字。外貌/视觉描述优先抄材料原句,材料没有才合理推断。' +
        '只输出 JSON,无 markdown:{"characters":[{"name":"","descVisual":"","descPersona":""}],' +
        '"locations":[{"name":"","descVisual":""}],"props":[{"name":"","descVisual":""}],' +
        '"vehicles":[{"name":"","descVisual":""}],"wardrobe":[{"name":"","descVisual":""}]}。' +
        '某类没有提及就输出空数组。',
        `材料:\n${material.slice(0, 12000)}`,
        0.3, 4096,
      );
      const roster = this.montage.parseJsonSafe(raw);
      if (!roster || !Array.isArray(roster.characters)) return null;
      lj.assetRoster = roster;
      await this.prisma.$executeRawUnsafe(
        'UPDATE dramas_novel_ledger SET ledgerJson = CAST(? AS JSON) WHERE id = ?',
        JSON.stringify(lj), rows[0].id,
      );
      this.logger.log(
        `[roster] 抽取:角色 ${roster.characters.length} / 场景 ${(roster.locations || []).length} / ` +
        `道具 ${(roster.props || []).length} / 载具 ${(roster.vehicles || []).length} / ` +
        `服装 ${(roster.wardrobe || []).length}`,
      );
      return roster;
    } catch (e: any) {
      this.logger.warn(`[roster] 抽取失败(降级回旧硬编码设计,不阻断): ${e?.message}`);
      return null;
    }
  }

  async generateDesign(dramaUuid: string, hint?: string): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const ctx = { userId: Number(drama.userId), agentId: Number(drama.agentId) };
    const outline = await this.buildOutlineForDesign(drama, hint);
    // 2026-09-16(批4):名单驱动设计 —— 资产数量跟小说走,不再提示词硬编码
    const roster = await this.assetRosterFor(drama.id, Number(drama.userId));
    const design = await this.montage.genStep2Design({}, outline, ctx, roster);

    const created: any[] = [];
    const skipped: any[] = [];
    const groups: Array<[string, string]> = [
      ['characters', 'character'], ['locations', 'location'], ['props', 'prop'],
      // 2026-09-16(批4):载具/服装按小说提及生成(roster 驱动);没提及 = 不建,
      //   资产库 chip 灰显"本书未涉及"(批1 已做计数灰显)
      ['vehicles', 'vehicle'], ['wardrobe', 'wardrobe'],
    ];
    for (const [coll, kind] of groups) {
      const list = Array.isArray((design as any)[coll]) ? (design as any)[coll] : [];
      for (const item of list) {
        const name = String(item.name || '').trim();
        if (!name) continue;
        const dup = await this.prisma.$queryRawUnsafe<AssetRow[]>(
          `SELECT \`id\` FROM \`DramaAsset\`
            WHERE \`dramaId\` = ? AND \`kind\` = ? AND \`name\` = ?
              AND \`status\` <> 'deprecated' LIMIT 1`,
          drama.id, kind, name,
        );
        if (dup.length) { skipped.push({ kind, name, id: this.s(dup[0].id) }); continue; }
        const descVisual = String(item.appearance || item.description || name);
        const personaRaw =
          item.personality || item.mood ||
          (Array.isArray(item.used_by) ? item.used_by.join('、') : '');
        const asset = await this.createAsset(dramaUuid, {
          kind, slug: item.id, name,
          descVisual,
          descPersona: personaRaw ? String(personaRaw) : null,
          source: 'setup', sourceEp: null, status: 'pending',
        });
        created.push({ id: asset.id, kind, slug: asset.slug, name: asset.name });
      }
    }
    this.logger.log(
      `[drama] ${drama.uuid} 定妆设计:新建 ${created.length} 项 / 已存在跳过 ${skipped.length} 项`,
    );
    return { created, skipped, design };
  }

  /**
   * 给单个资产出参考图并落地本地。角色 = 四视图,场景/道具 = 单张。
   * 默认增量:只补缺口或失败的角度,已成功的图不重烧(force=true 才整套重画)。
   * canonical = 第一个可用视图(优先正面),不绑 refs[0] —— 首张可能因上游 503 是空的。
   * 锁定资产直接 409:用户最满意的那张脸不该被自动流程覆盖。
   */
  async generatePortrait(dramaUuid: string, assetId: string, force = false): Promise<any> {
    const { drama, asset } = await this.requireAsset(dramaUuid, assetId);
    if (Number(asset.locked) === 1) {
      throw new ConflictException('资产已锁定,先解锁再重生成');
    }
    const styleSpec = this.parseJson(drama.styleSpec, {});
    const style = styleSpec.stylePrompt || '电影质感, 高细节, 写实';
    // 2026-09-05:定妆图 seed 锁定(方案1)—— 图像 seed 内容级实测生效(同 seed 同
    //   prompt 两次产物 SHA256 一致)。基线取风格圣经的 seed(未设则不传=保持随机),
    //   每个「资产×角度」用稳定哈希偏移:同一资产同一角度重试必出同一张脸,
    //   不同角度/资产之间仍有差异。哈希用 uuid 而非列表下标 —— 顺序变了也不漂。
    //   ⚠️ 上游 seed 合法范围 [0,999],哈希偏移后 mod 1000 保持区内且稳定。
    const seedBase = Number.isFinite(Number(styleSpec.seed)) ? Number(styleSpec.seed) : null;
    const angleSeed = (angle: string): number | undefined => {
      if (seedBase == null) return undefined;
      const h = createHash('sha1').update(`${asset.uuid}:${angle}`).digest();
      return (seedBase + h.readUInt32BE(0)) % 1000;
    };
    const shots = planAssetShots(
      asset.kind,
      { name: asset.name, appearance: asset.descVisual, description: asset.descVisual },
      style,
    );
    const ctx = { userId: Number(drama.userId), agentId: Number(drama.agentId) };
    const prevRefs = this.parseJson(asset.refs, []) as any[];
    const refs: any[] = [];
    let okCount = 0; let reused = 0;

    // 2026-08-28:增量定妆。上游会返回 503「text image queue is full」,
    //   一把全重跑等于把已经成功的几张再烧一遍配额(与 step6 增量重生成同一道理)。
    //   默认只补缺口/失败的角度;force=true 才整套重画。
    // 2026-09-14:并行化 + 多 key 轮询 —— 之前串行 for 循环逐角度走 dispatcher
    //   单 key 通道(callImage),4 视图 40-120s/资产;现在与 ep-step3 关键帧同构:
    //   Promise.all 并行 + callImageWithKey 多 key 轮询(nextKey),约 ~3-6 倍提速。
    //   计费口径不变:drama-pricing.ts 已注明 callImage/callImageWithKey 均不触发
    //   credits 结算链,切通道对钱包零影响;seed 锁定/增量复用/canonical 逻辑原样保留。
    const pending: { idx: number; sh: any; tag: string; prev: any }[] = [];
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      // 命名规则在 concept-art.portraitFileTag(纯函数,已单测):
      // force 重画必须换文件名,否则 URL 不变会让前端继续显示旧缓存图。
      const tag = portraitFileTag(i, sh.angle, force);
      const prev = prevRefs.find((r) => String(r.angle) === sh.angle);
      const prevUsable = prev && prev.url && prev.alive !== false;
      if (!force && prevUsable) {
        refs.push({ ...prev, angle: sh.angle, canonical: false });
        okCount++; reused++;
        continue;
      }
      pending.push({ idx: i, sh, tag, prev: prev || null });
    }
    // 并行画所有待生成角度,每张轮询取 key(单张失败只丢这一张,不整单失败)
    const genResults = await Promise.all(pending.map(({ sh, tag, prev }) => {
      const apiKey = this.montage.nextKey();
      const seed = angleSeed(sh.angle);
      return (async () => {
        try {
          const remote = await this.montage.callImageWithKey(
            apiKey, sh.prompt, sh.size, sh.negative || undefined,
            undefined, undefined, seed,
          );
          const local = await this.landRef(remote, asset.uuid, tag);
          return {
            ok: true,
            ref: {
              angle: sh.angle, url: local, remoteUrl: remote,
              prompt: sh.prompt, negativePrompt: sh.negative,
              alive: !!local, landedAt: local ? new Date().toISOString() : null,
            },
          };
        } catch (e: any) {
          return {
            ok: false,
            ref: {
              angle: sh.angle, url: prev?.url || null, remoteUrl: prev?.remoteUrl || null,
              prompt: sh.prompt, negativePrompt: sh.negative,
              alive: false, error: e?.message || String(e),
            },
          };
        }
      })();
    }));
    // 按原角度顺序回填(pending 与 refs 的顺序对齐:push 时保持 shots 顺序)
    for (const r of genResults) {
      refs.push(r.ref);
      if (r.ok && r.ref.alive) {
        okCount++;
        this.logger.log(`[portrait] ${asset.name} ${r.ref.angle} OK`);
      } else if (r.ok) {
        // 生成成功但落地失败:保留 remoteUrl 给前端,okCount 不计(与旧逻辑一致)
        this.logger.warn(`[portrait] ${asset.name} ${r.ref.angle} 生成成功但落地失败`);
      } else {
        this.logger.warn(`[portrait] ${asset.name} ${r.ref.angle} 失败: ${r.ref.error}`);
      }
    }

    // 2026-09-16(批4)**视觉质检门**:对第一张可用视图查解剖硬伤(多条胳膊/手指
    //   畸形/多头/部件错位)—— 之前 alive=!!local 只判"下载落地",坏图照判 ok 入库,
    //   用户肉眼发现时已经进了关键帧与成片(七问题之问题4,用户图1/图2)。
    //   不合格 → 自动重画 ≤2 次(换文件名+随机种子);仍坏 → 打 suspect 标入库,
    //   前端资产卡露出 + 一键重生成。多模态通道不可用 = 降级不拦,绝不打死定妆链。
    //   复用旧图(force=false 命中缓存)也会重检 —— 存量坏图下次跑批即被标出。
    if (String(process.env.DRAMA_VISUAL_QC || '1').trim() !== '0') {
      const qcIdx = refs.findIndex((r) => r.alive !== false && (r.url || r.remoteUrl));
      const qcRemote = qcIdx >= 0 ? String(refs[qcIdx].remoteUrl || '') : '';
      if (qcIdx >= 0 && /^https?:\/\//i.test(qcRemote)) {
        let verdict = parseVisualQcVerdict(
          await this.montage.callVisionLlm(
            ctx, VISUAL_QC_SYS, qcRemote, buildVisualQcQuestion(asset.name, asset.kind),
          ),
        );
        let attempts = 0;
        while (verdict && !verdict.ok && attempts < VISUAL_QC_MAX_REDRAW) {
          attempts++;
          this.logger.warn(
            `[portrait] ${asset.name} 质检不合格(${verdict.issues.join(';')}) → 自动重画 ${attempts}/${VISUAL_QC_MAX_REDRAW}`,
          );
          const sh = shots[qcIdx];
          try {
            const apiKey = this.montage.nextKey();
            // 随机种子(不传 seed)+ force 式新文件名,否则同 seed 同 prompt 必出同一张坏图
            const remote = await this.montage.callImageWithKey(
              apiKey, sh.prompt, sh.size, sh.negative || undefined,
              undefined, undefined, undefined,
            );
            const local = await this.landRef(remote, asset.uuid, portraitFileTag(qcIdx, sh.angle, true));
            if (!local) break;
            refs[qcIdx] = {
              ...refs[qcIdx], url: local, remoteUrl: remote,
              alive: true, landedAt: new Date().toISOString(),
            };
            verdict = parseVisualQcVerdict(
              await this.montage.callVisionLlm(
                ctx, VISUAL_QC_SYS, remote, buildVisualQcQuestion(asset.name, asset.kind),
              ),
            );
          } catch (e: any) {
            this.logger.warn(`[portrait] ${asset.name} 质检重画失败(保留原图): ${e?.message}`);
            break;
          }
        }
        if (verdict) {
          refs[qcIdx] = {
            ...refs[qcIdx],
            qc: {
              ok: verdict.ok, issues: verdict.issues, attempts,
              at: new Date().toISOString(),
            },
          };
          if (!verdict.ok) {
            this.logger.warn(
              `[portrait] ${asset.name} 重画 ${attempts} 次仍不合格,标 suspect:${verdict.issues.join(';')}`,
            );
          }
        } else {
          // 通道不可用(模型不支持视觉/超时):打降级戳,跑批不再重复空检该资产;
          //   与 qc 判定区分开 —— 降级不是"合格",前端不显示合格徽章
          refs[qcIdx] = {
            ...refs[qcIdx],
            qcSkipped: 'channel_unavailable',
            qcSkippedAt: new Date().toISOString(),
          };
        }
      }
    }

    if (okCount === 0) {
      throw new BadRequestException(
        `「${asset.name}」参考图全部生成失败,可重试。原因:${refs[0]?.error || '未知'}`,
      );
    }

    // canonical 给「第一个真正可用的视图」,优先正面。
    // 绑死 refs[0] 是 bug:首视图被上游 503 打挂时,整套参考图就没有 canonical 了。
    const usable = (r: any) => r.alive !== false && !!(r.url || r.remoteUrl);
    let canonIdx = refs.findIndex((r) => usable(r) && r.angle === '正面');
    if (canonIdx === -1) canonIdx = refs.findIndex((r) => usable(r));
    for (let i = 0; i < refs.length; i++) refs[i].canonical = i === canonIdx;
    this.logger.log(
      `[portrait] ${asset.name} 完成:复用 ${reused} 张 / 新画 ${shots.length - reused} 张` +
      ` / canonical=${refs[canonIdx]?.angle || '无'}`,
    );

    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaAsset\` SET \`refs\` = CAST(? AS JSON), \`status\` = 'confirmed',
              \`styleSig\` = ?, \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(refs), styleSpec.sigHash || null, asset.id,
    );
    return this.getAsset(dramaUuid, String(asset.id));
  }

  /** 试机帧落盘:uploads/drama-previews/{dramaUuid}/{tag}-{ts}.png */
  private async landPreview(dramaUuid: string, tag: string, remoteUrl: string): Promise<string | null> {
    if (!remoteUrl) return null;
    try {
      const dir = path.join(this.previewsDir, dramaUuid);
      fs.mkdirSync(dir, { recursive: true });
      const file = `${tag}-${Date.now()}.png`;
      await this.montage.downloadFile(remoteUrl, path.join(dir, file));
      return `/uploads/drama-previews/${dramaUuid}/${file}`;
    } catch (e: any) {
      // 落地失败不阻断试机:至少把上游地址回给前端,用户这一帧没白等
      this.logger.warn(`[preview] 落地失败,回落上游地址: ${e?.message}`);
      return null;
    }
  }

  /** 把上游远程图抓回本地;失败只丢这一张视图,不整单失败(下次重试可补) */
  private async landRef(remoteUrl: string, assetUuid: string, tag: string): Promise<string | null> {
    if (!remoteUrl) return null;
    try {
      const dir = path.join(this.assetsDir, assetUuid);
      fs.mkdirSync(dir, { recursive: true });
      let ext = '.png';
      try {
        const u = new URL(remoteUrl);
        const m = u.pathname.match(/\.(png|jpe?g|webp)$/i);
        if (m) {
          const e2 = m[1].toLowerCase();
          ext = (e2 === 'jpg' || e2 === 'jpeg') ? '.jpg' : `.${e2}`;
        }
      } catch { /* 无后缀就用默认 png */ }
      const file = path.join(dir, `${tag}${ext}`);
      await this.montage.downloadFile(remoteUrl, file);
      return `/uploads/drama-assets/${assetUuid}/${tag}${ext}`;
    } catch (e: any) {
      this.logger.warn(`[portrait] 落地失败 ${tag}: ${e?.message}`);
      return null;
    }
  }

  /** 用剧级信息拼一个 outline 形状,喂给共用的美术设计提示词(genStep2Design) */
  private async buildOutlineForDesign(drama: DramaRow, hint?: string): Promise<any> {
    const arc = this.parseJson(drama.storyArc, []) as any[];
    const bible = this.parseJson(drama.bible, {}) as any;
    const scenes = arc.length
      ? arc.map((a, i) => ({
          idx: Number(a.ep ?? i + 1),
          location: String(a.purpose || '').slice(0, 30) || `第 ${i + 1} 集`,
          summary: String(a.purpose || ''),
          estimated_sec: 60,
        }))
      : [1, 2, 3, 4, 5].map((i) => ({
          idx: i,
          location: '',
          summary: String(drama.logline || drama.title || ''),
          estimated_sec: 60,
        }));
    return {
      title: drama.title,
      logline: drama.logline || '',
      synopsis: drama.synopsis || bible.world || '',
      total_estimated_sec: scenes.length * 60,
      scenes,
      ...(hint ? { extraHint: hint } : {}),
    };
  }

  // ==========================================================================
  // 集内 6 步生成(0 承接大纲 / 1 资产预检 / 2 分镜 / 3 关键帧 / 4 分镜视频 / 5 成片回写)
  // --------------------------------------------------------------------------
  // 除「承接大纲」是连续剧专属的新逻辑外,其余全部复用 open-montage 里已验证的
  // 同一份实现(genStep4Shots / genStep6ShotVideos / genStep7Compose / callImageWithKey)。
  // 复制一份是维护事故的开始 —— 支付双路径漏改的教训写在案里。
  // ==========================================================================

  /** 把剧级资产库整理成 keyframe-plan 需要的 RefAsset 字典(按 slug 索引) */
  private async refAssetIndex(dramaId: bigint): Promise<Record<string, RefAsset>> {
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT * FROM \`DramaAsset\` WHERE \`dramaId\` = ? AND \`status\` <> 'deprecated'`, dramaId,
    );
    const out: Record<string, RefAsset> = {};
    for (const r of rows || []) {
      const fmt = this.fmtAsset(r);
      out[fmt.slug] = {
        slug: fmt.slug, name: fmt.name, kind: fmt.kind,
        descVisual: fmt.descVisual,
        refs: (fmt.refs || []).map((x: any) => ({
          angle: x.angle, url: x.url, remoteUrl: x.remoteUrl,
          alive: x.alive !== false && !!(x.url || x.remoteUrl),
          canonical: x.canonical,
        })),
        variants: fmt.variants || [],
      };
    }
    return out;
  }

  /** 把剧级资产库整理成 genStep4Shots 需要的 design 形状(单一实现,不另写提示词) */
  private async designFromLibrary(dramaId: bigint): Promise<any> {
    const idx = await this.refAssetIndex(dramaId);
    const list = Object.values(idx);
    return {
      characters: list.filter((a) => a.kind === 'character')
        .map((a) => ({ id: a.slug, name: a.name, appearance: a.descVisual })),
      locations: list.filter((a) => a.kind === 'location')
        .map((a) => ({ id: a.slug, name: a.name, description: a.descVisual })),
      props: list.filter((a) => a.kind === 'prop')
        .map((a) => ({ id: a.slug, name: a.name, description: a.descVisual })),
    };
  }

  /**
   * 资产库里的角色名表(去重、去空)—— 喂给 dialogue 净化器。
   * 有名单时净化器能在「××地说」「愤怒的××」里精确认出说话人、拆分一镜多说话人;
   * 取名失败一律降级为空名单(净化器转保守模式,台词仍干净),**绝不阻断出片**。
   */
  private async characterNames(dramaId: bigint): Promise<string[]> {
    try {
      const idx = await this.refAssetIndex(dramaId);
      const names = Object.values(idx)
        .filter((a) => a.kind === 'character')
        .map((a) => String(a.name || '').trim())
        .filter(Boolean);
      return Array.from(new Set(names));
    } catch (e: any) {
      this.logger.warn(`取角色名表失败(降级为空名单,不影响出片): ${e?.message}`);
      return [];
    }
  }

  /**
   * 汇总本集预检要处理的资产 = LLM 声明的新需求 ∪ 场景里引用到的库内资产。
   *
   * 为什么不能只看 needs_assets:如果本集全部复用现有资产,LLM 会正确地返回空需求,
   * 那样预检就会"无事可做"并把纯复用集卡死在第 1 步。把场景引用的资产也送进预检,
   * 命中记录才是"复用生效"的凭证,分镜阶段才能稳定拿到 slug 清单。
   */
  private async collectNeeds(dramaId: bigint, outline: any): Promise<AssetNeed[]> {
    const bySlug = await this.refAssetIndex(dramaId);
    const declared = Array.isArray(outline?.needs_assets) ? outline.needs_assets : [];
    const needs: AssetNeed[] = [];
    const seen = new Set<string>();

    for (const n of declared) {
      if (!n?.kind || !n?.name) continue;
      seen.add(String(n.slug || n.name));
      needs.push({
        kind: n.kind, name: n.name, slugHint: n.slug,
        descVisual: n.descVisual, descPersona: n.descPersona,
        variantHint: n.variantHint,
        appearsIn: (outline?.scenes || [])
          .filter((sc: any) => (sc.characters || []).includes(n.slug) || (sc.props || []).includes(n.slug))
          .map((sc: any) => sc.idx),
      });
    }

    for (const sc of outline?.scenes || []) {
      const refs = [
        ...(sc.characters || []), ...(sc.props || []),
        ...(sc.location_id ? [sc.location_id] : []),
        ...(sc.location ? [sc.location] : []),
      ];
      for (const slug of refs) {
        const key = String(slug || '');
        if (!key || seen.has(key)) continue;
        const asset = bySlug[key];
        if (!asset) continue; // 库内不认识的标识交给分镜阶段的 unresolved 报告处理
        seen.add(key);
        needs.push({
          kind: asset.kind as AssetNeed['kind'], name: asset.name, slugHint: asset.slug,
          descVisual: asset.descVisual, appearsIn: [sc.idx],
        });
      }
    }
    return needs;
  }

  /**
   * P0-b:取本集的原文锚点(逐字 beats + 章节正文摘录),喂进大纲提示词,
   * 让编剧「看着原著写」而不是凭章节标题编剧情(诊断里的断点②③)。
   * 全程降级安全:没有账本 / 没有正文 / 读失败一律返回 {},大纲退回旧的标题锚点行为,绝不阻断出片。
   */
  private async novelAnchorForEpisode(
    dramaId: bigint, epNo: number,
  ): Promise<{ chapterExcerpt?: string; beatsAnchor?: string }> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ ledgerJson: any; novelStorageKey: string | null }>>(
        'SELECT ledgerJson, novelStorageKey FROM dramas_novel_ledger WHERE dramaId = ? LIMIT 1', dramaId,
      );
      if (!rows.length) return {};
      const ledgerJson = typeof rows[0].ledgerJson === 'string'
        ? this.parseJson(rows[0].ledgerJson, {}) : (rows[0].ledgerJson || {});
      const chapters: LedgerChapterLike[] = Array.isArray(ledgerJson.chapters) ? ledgerJson.chapters : [];
      const episodes: any[] = Array.isArray(ledgerJson.episodes) ? ledgerJson.episodes : [];
      const ep = episodes[epNo - 1];
      const epChapterIds: string[] = Array.isArray(ep?.chapters) ? ep.chapters.map(String) : [];
      if (!epChapterIds.length) return {};

      // 正文:按 char_offset 从落盘 novel.txt 切回(LF 归一化在 novel-anchor 内做,对齐 ingest 口径)
      let novelText = '';
      const key = rows[0].novelStorageKey;
      if (key) {
        const novelPath = path.join(dramaNovelDir(), path.basename(key));
        if (fs.existsSync(novelPath)) novelText = fs.readFileSync(novelPath, 'utf-8');
      }

      // beats:P0-a 回填后才有;从 ledgerJson.beats 里筛出本集覆盖章节的锚点
      const allBeats: BeatAnchorLike[] = Array.isArray(ledgerJson.beats) ? ledgerJson.beats : [];
      const idSet = new Set(epChapterIds);
      const beats = allBeats.filter((b: any) => idSet.has(String(b?.chapter)));

      const { excerpt, beatsAnchor } = buildEpisodeAnchor({ beats, novelText, chapters, epChapterIds });
      const out: { chapterExcerpt?: string; beatsAnchor?: string } = {};
      if (excerpt) out.chapterExcerpt = excerpt;
      if (beatsAnchor) out.beatsAnchor = beatsAnchor;
      return out;
    } catch (e: any) {
      this.logger.warn(`[ep-step0] 取原文锚点失败(降级回标题锚点,不阻断): ${e?.message}`);
      return {};
    }
  }

  /**
   * 2026-09-16(批2):coverage 自动回写 —— 大纲 scene.quotes 与账本 beats 的逐字
   * 锚点对账(互含即命中),命中标 status='covered' + coveredBy=本集 uuid。
   *
   * 为什么互含而不是全等:LLM 抄录时可能截半句或带标点出入,全等会把真覆盖
   * 判成漏覆盖;互含(quote⊂sceneQuote 或反之)在 240 字锚点尺度上误判率可接受。
   * 只前进不后退:已 covered 的不改判(别的集先覆盖了就是先覆盖)。
   *
   * @returns 本次新标 covered 的 beats 条数
   */
  async markBeatsCoveredByQuotes(
    dramaId: bigint, epUuid: string, quotes: string[],
  ): Promise<number> {
    const qs = (quotes || []).map((q) => String(q || '').trim()).filter(Boolean);
    if (!qs.length) return 0;
    const beats = await this.prisma.$queryRawUnsafe<Array<{ id: bigint; quote: string }>>(
      `SELECT b.id, b.quote FROM dramas_novel_beats b
         JOIN dramas_novel_ledger l ON l.id = b.ledgerId
        WHERE l.dramaId = ? AND b.status = 'pending'`,
      dramaId,
    );
    const hit = beats.filter((b) => {
      const q = String(b.quote || '').trim();
      if (!q) return false;
      return qs.some((s) => s.includes(q) || q.includes(s));
    });
    if (!hit.length) return 0;
    const ids = hit.map((h) => String(h.id)).join(',');
    await this.prisma.$executeRawUnsafe(
      `UPDATE dramas_novel_beats SET \`status\` = 'covered', \`coveredBy\` = ?
        WHERE \`id\` IN (${ids}) AND \`status\` = 'pending'`,
      epUuid,
    );
    return hit.length;
  }

  /**
   * 2026-09-16(批3 透明工作台):改字幕 → 重烧。
   * 读集目录 timeline.json,按 shotIdx 应用文本编辑(applyTextEdits 会诚实标
   * needsRealign:字数变化超阈值=语义窗未重算),复用 concat.mp4 重烧 final.mp4
   * (不重下载分镜、不重跑 ASR、不重烧视频配额),新字幕全文写回 step5 输出。
   */
  async reburnEpisodeSubtitles(
    dramaUuid: string, epNo: number,
    edits: Array<{ shotIdx: number; text?: string; speaker?: string | null }>,
  ): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    const out5 = sd['5']?.output;
    if (!out5) throw new BadRequestException('请先合成过本集(第 5 步)再改字幕');
    const dir = path.join(this.dramasDir, drama.uuid, `ep${epNo}`);
    const tlPath = path.join(dir, 'timeline.json');
    if (!fs.existsSync(tlPath)) {
      throw new BadRequestException('timeline.json 不存在,请重跑一次第 5 步');
    }
    const tl = this.parseJson(fs.readFileSync(tlPath, 'utf8'), null);
    if (!tl || !Array.isArray(tl.cues)) {
      throw new BadRequestException('timeline.json 损坏(无 cues)');
    }
    const { timeline: next, needsRealign } = applyTextEdits(tl, edits || []);
    await this.montage.reburnSubtitlesFromTimeline(dir, next);
    sd['5'] = {
      ...(sd['5'] || {}),
      output: {
        ...out5,
        subtitle_cues: (next.cues || []).map((c: any) => ({
          shotIdx: c?.anchor?.shotIdx ?? null,
          startSec: Number(c?.display?.startSec ?? c?.window?.startSec ?? 0),
          endSec: Number(c?.display?.endSec ?? c?.window?.endSec ?? 0),
          text: String(c?.anchor?.text || ''),
          speaker: c?.anchor?.speaker || null,
          source: c?.anchor?.source || null,
        })),
        subtitle_edited_at: new Date().toISOString(),
        subtitle_needs_realign: needsRealign,
      },
    };
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON) WHERE \`id\` = ?`,
      JSON.stringify(sd), row.id,
    );
    this.logger.log(
      `[ep-subtitles] EP${epNo} 字幕重烧:${(edits || []).length} 处编辑` +
      `${needsRealign ? '(字数变化超阈值,语义窗待重跑分镜后对齐)' : ''}`,
    );
    return {
      ...(await this.fmtEpisode(await this.requireEpisode(drama.id, epNo))),
      needsRealign,
    };
  }

  /**
   * 生成集内某一步。长耗时步骤(3/4)支持逐镜推进,避免把请求吊死在 HTTP 里。
   */
  async generateEpisodeStep(
    dramaUuid: string, epNo: number, step: number, input: any = {},
  ): Promise<any> {
    this.checkStep(step);
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    const sd = this.parseJson(row.stepData, {}) as Record<string, any>;
    const ctx = { userId: Number(drama.userId), agentId: Number(drama.agentId) };
    const styleSpec = this.parseJson(drama.styleSpec, {});
    const scopeTag = `${drama.uuid}-ep${epNo}`;
    const started = Date.now();
    // 本集目标时长(秒)。批次会透传 input.targetSec;手动单步生成时前端不一定带,
    // 那就回落到账本 ingest 时用户选定的值。**必须在这里统一解析** ——
    // 之前只有 n2d-core 的切集步骤知道这个值,生成链路完全不知道,于是
    // 用户选 120 秒、大纲走兜底"2-3 分钟"、分镜每镜 3 秒,成片只有 43 秒。
    const targetSec = await this.resolveEpTargetSec(drama.id, input?.targetSec);

    const save = async (payload: any) => {
      sd[String(step)] = {
        ...(sd[String(step)] || {}), input, output: payload,
        generatedAt: new Date().toISOString(),
        elapsed_ms: Date.now() - started,
      };
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON), \`step\` = ?, \`status\` = ?,
                \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        JSON.stringify(sd), step, this.statusOfStep(step), row.id,
      );
      // 必须重读:直接 fmt 更新前的 row 会让响应里的 step/status 停在旧值,
      // 前端表现为"生成完成了但进度条没动"。
      return this.fmtEpisode(await this.requireEpisode(drama.id, epNo));
    };

    switch (step) {
      // ── 0 承接与大纲:连续剧专属的新逻辑 ──
      case 0: {
        const brief = await this.continuityBrief(dramaUuid);
        const arc = this.parseJson(drama.storyArc, []) as any[];
        // P0-b:把本集覆盖章节的原文摘录 + beats 逐字锚点接进大纲(降级安全,拿不到就退回标题锚点)
        const anchor = await this.novelAnchorForEpisode(drama.id, epNo);
        const prompt = buildEpisodeOutlinePrompt({
          dramaTitle: drama.title,
          logline: drama.logline || '',
          synopsis: drama.synopsis || '',
          bible: this.parseJson(drama.bible, {}),
          styleSpec,
          snapshot: this.parseJson(drama.snapshot, {}),
          storyArcItem: arc.find((a) => Number(a.ep) === epNo) || null,
          hookIn: row.hookIn || brief.hookIn || '',
          epNo,
          totalEpisodes: arc.length || undefined,
          assetIndex: brief.assetIndex,
          userBrief: input?.brief,
          targetSec,
          ...anchor,
        });
        const raw = await this.montage.callLlm(
          ctx, prompt.system, prompt.user, prompt.temperature, prompt.maxTokens,
        );
        const parsed = this.montage.parseJsonSafe(raw);
        if (!parsed || !parsed.title) {
          throw new BadRequestException(
            `本集大纲生成失败(LLM 未返回可解析 JSON)。原始返回前 200 字:${String(raw).slice(0, 200)}`,
          );
        }
        let { outline, warnings } = normalizeEpisodeOutline(parsed);
        // 2026-09-16(批2)**quote 忠实门**:有原文锚点却整份大纲 0 场逐字引用 →
        //   带修订要求重生成一次;仍不过 → 标 quoteMissing 进 warnings(批3 露出),不静默放过。
        //   诊断断点⑥:原文 quote 走到大纲提示词就蒸发,分镜/字幕自此凭 ≤50 字摘要重编。
        let qstats = outlineQuoteStats(outline);
        let quoteMissing = false;
        if (anchor.beatsAnchor && qstats.scenes > 0 && qstats.withQuotes === 0) {
          this.logger.warn(
            `[ep-step0] quote 门未过:0/${qstats.scenes} 场引用逐字锚点 → 重生成一次`,
          );
          const retryRaw = await this.montage.callLlm(
            ctx,
            `${prompt.system}\n\n[修订要求] 上一版输出里没有任何 scene 提供 quotes(本场改编自的原文逐字句)。` +
            `重新输出整集大纲:每个 scene 的 quotes 必须从锚点「」内或摘录原文里原样抄录 1-3 句;纯衔接场才可空数组。`,
            prompt.user, prompt.temperature, prompt.maxTokens,
          );
          const retryParsed = this.montage.parseJsonSafe(retryRaw);
          if (retryParsed && retryParsed.title) {
            const r2 = normalizeEpisodeOutline(retryParsed);
            outline = r2.outline;
            warnings = [...warnings, ...r2.warnings];
            qstats = outlineQuoteStats(outline);
          }
        }
        if (anchor.beatsAnchor && qstats.scenes > 0 && qstats.withQuotes === 0) {
          quoteMissing = true;
          warnings.push('quote 门:重生成后仍无 scene 引用原文逐字句,分镜将退化为摘要改编(已标 quoteMissing)');
        }
        // 2026-09-16(批3 透明工作台):把「本集从哪来」一并落库 —— 原文锚点与
        //   完整提示词。之前这两样进 prompt 即丢,用户无法核对"编剧看着什么写"。
        const step0Payload: any = {
          ...outline,
          ...(quoteMissing ? { quoteMissing: true } : {}),
          anchor: {
            chapterExcerpt: anchor.chapterExcerpt || null,
            beatsAnchor: anchor.beatsAnchor || null,
          },
          prompt_used: { system: prompt.system, user: prompt.user },
        };
        const result = await save(step0Payload);
        // 钩子先落到集记录上,便于下一集在建集时就能继承(成片时再最终确认)
        if (outline.hook_out) {
          await this.prisma.$executeRawUnsafe(
            `UPDATE \`DramaEpisode\` SET \`hookOut\` = ? WHERE \`id\` = ?`, outline.hook_out, row.id,
          );
        }
        // 叙事状态在**大纲落库时**就合并进剧级快照,而不是只等第 5 步成片。
        //
        // 这是「集间流水线」的前置条件:下一集的大纲只依赖本集第 0 步的产出
        // (hookOut 上面刚写进集记录,establishedFacts/characterStates 就是这里),
        // 于是"下一集写大纲 + 出关键帧"可以与本集"视频排队等待"并行。
        // 视频通道每 key 每分钟只准建 1 个任务,那 8 分钟里 LLM 与图像通道全在闲置。
        //
        // 第 5 步仍会再写一次(补 finalUrl/durationSec/shotCount 这些生产字段),
        // mergeNarrativeSnapshot 的去重合并 + sourceEp 单调守卫保证重复写安全。
        // 2026-09-16(批2)openHooks 回写接通:本集接住的钩子(hookIn)在本集被解决,
        //   从「仍未解决的悬念」里移除 —— 之前 step0/step5 回写从不传 openHooks,
        //   大纲提示词里"仍未解决的悬念"恒空,悬念账本形同虚设(诊断断点)。
        const hookInUsed = row.hookIn || brief.hookIn || '';
        const snapAtStep0 = this.parseJson(drama.snapshot, {}) as any;
        const prevOpenHooks: string[] = Array.isArray(snapAtStep0.openHooks) ? snapAtStep0.openHooks : [];
        await this.mergeNarrativeSnapshot(dramaUuid, epNo, {
          establishedFacts: outline.established_facts_new || [],
          characterStates: outline.character_states || {},
          openHooks: prevOpenHooks.filter((h: any) => h && h !== hookInUsed),
        }).catch((e: any) =>
          this.logger.warn(`[ep-step0] 叙事快照合并失败(不阻断): ${e?.message}`));
        // 2026-09-16(批2)**coverage 自动回写**:大纲 quotes 与账本 beats 逐字锚点对账,
        //   命中即标 covered + coveredBy=本集 —— 取代"只有手动端点 + covered_by 恒 pending"
        //   的假通过(诊断断点⑧),忠于原著从此有自动账本可查。
        if (qstats.quotes.length) {
          await this.markBeatsCoveredByQuotes(drama.id, row.uuid, qstats.quotes)
            .then((n) => {
              if (n > 0) this.logger.log(`[ep-step0] coverage 回写:${n} 条 beats 标 covered(EP${epNo})`);
            })
            .catch((e: any) =>
              this.logger.warn(`[ep-step0] coverage 回写失败(不阻断): ${e?.message}`));
        }
        this.logger.log(
          `[ep-step0] ${drama.uuid} EP${epNo} 大纲:${outline.scenes?.length || 0} 场 / ` +
          `需资产 ${outline.needs_assets?.length || 0} 项 / 告警 ${warnings.length} 条`,
        );
        return { ...result, warnings };
      }

      // ── 1 资产预检:新增需求 ∪ 本集引用到的库内资产 ──
      case 1: {
        const outline = sd['0']?.output;
        if (!outline) throw new BadRequestException('请先生成本集大纲(第 0 步)');
        const needs = await this.collectNeeds(drama.id, outline);
        if (!needs.length) {
          throw new BadRequestException(
            '本集大纲既没有新资产需求、也没有引用任何库内资产,预检无事可做 —— 请检查大纲场景是否填了 characters/location/props',
          );
        }
        const report = await this.precheckAssets(dramaUuid, epNo, needs);
        return { ...(await this.getEpisode(dramaUuid, epNo)), precheck: report };
      }

      // ── 2 分镜:引用剧级资产库,复用共享提示词 ──
      case 2: {
        const outline = sd['0']?.output;
        if (!outline) throw new BadRequestException('请先生成本集大纲(第 0 步)');
        const design = await this.designFromLibrary(drama.id);
        if (!design.characters.length) {
          throw new BadRequestException(
            '资产库里还没有任何角色 —— 先去「概览」生成美术设定并定妆,分镜才有人可引用',
          );
        }
        const unresolved = (outline.needs_assets || [])
          .map((n: any) => n.slug)
          .filter((slug: string) => !design.characters.concat(design.locations, design.props)
            .some((x: any) => x.id === slug));
        const shots = await this.montage.genStep4Shots(
          { ...input, style: styleSpec.stylePrompt, targetSec },
          outline, design, ctx,
        );
        const result = await save(shots);
        return { ...result, unresolved_assets: unresolved };
      }

      // ── 3 关键帧:参考图驱动 ──
      case 3: {
        const shotOut = sd['2']?.output;
        if (!shotOut?.shots?.length) throw new BadRequestException('请先生成分镜脚本(第 2 步)');
        const idx = await this.refAssetIndex(drama.id);
        const plans = shotOut.shots.map((sh: any) =>
          buildKeyframePlan(sh, idx, styleSpec));
        // 逐镜推进:整集十几镜一次跑完仍要几分钟,指定 shotIdx 时只画这一镜,
        // 其余沿用上次结果 —— 前端因此可以边跑边出图,而不是转圈到最后才刷新。
        const onlyShot = input?.shotIdx != null ? Number(input.shotIdx) : null;
        const prevKf: Record<number, any> = {};
        for (const k0 of sd['3']?.output?.keyframes || []) {
          if (k0 && k0.shot_idx != null) prevKf[k0.shot_idx] = k0;
        }
        const tasks = plans.map((plan) => {
          if (onlyShot != null && plan.shotIdx !== onlyShot) {
            return Promise.resolve(
              prevKf[plan.shotIdx]
              || { shot_idx: plan.shotIdx, url: null, status: 'pending', prompt: plan.prompt },
            );
          }
          const apiKey = this.montage.nextKey();
          // 2026-09-05:关键帧 seed(方案1)—— 风格圣经 seed 为基线 + 镜号偏移,
          //   补画/重试同一镜锁定同一张图(内容级实测确认生效)。
          //   ⚠️ 上游 seed 合法范围 [0,999],偏移后统一 mod 1000 保持区内且稳定。
          const kfSeed = Number.isFinite(Number(styleSpec.seed))
            ? (Number(styleSpec.seed) + (Number(plan.shotIdx) || 0)) % 1000
            : undefined;
          return (async () => {
            try {
              const url = await this.montage.callImageWithKey(
                apiKey, plan.prompt, plan.size, plan.negative, plan.refUrls,
                plan.ratio, kfSeed,
              );
              return {
                shot_idx: plan.shotIdx, url, prompt: plan.prompt,
                ref_urls: plan.refUrls, ref_sources: plan.refSources,
                degraded: plan.degraded,
              };
            } catch (e: any) {
              return {
                shot_idx: plan.shotIdx, url: null, prompt: plan.prompt,
                ref_urls: plan.refUrls, ref_sources: plan.refSources,
                degraded: plan.degraded, error: e?.message || String(e),
              };
            }
          })();
        });
        const keyframes = await Promise.all(tasks);
        const drawn = onlyShot != null
          ? plans.filter((x) => x.shotIdx === onlyShot) : plans;
        const withRef = drawn.filter((x) => !x.degraded).length;
        const missing = Array.from(new Set(drawn.flatMap((x) => x.missingRefs)));
        // P2-b(flag 默认关):把 degraded 镜头的重生计划附到输出。degraded 的根因是"缺定妆参考图",
        //   单纯重画同一 plan 无用;正确修复是"补该资产定妆图 → 按 shotIdx 逐镜重跑 step3"
        //   (复用上面已有的 onlyShot 逐镜重生能力)。门③/前端据此打靶,避免换脸镜头进成片。
        const degradedRetry = planDegradedRetry(
          plans.map((p: any) => ({ shotIdx: p.shotIdx, degraded: p.degraded, missingRefs: p.missingRefs })),
          { enabled: String(process.env.DRAMA_KEYFRAME_RETRY_DEGRADED || '').trim() === '1' },
        );
        this.logger.log(
          `[ep-step3] EP${epNo} 关键帧 ${keyframes.filter((k: any) => k.url).length}/${keyframes.length} 成功,` +
          `带参考图 ${withRef} 镜,缺参考资产:${missing.join(',') || '无'}` +
          (degradedRetry.enabled ? `,degraded 待重生 #${degradedRetry.retry.join(',#') || '无'}` : ''),
        );
        const result = await save({
          keyframes,
          ref_backed: keyframes.filter((k: any) => (k.ref_urls || []).length > 0).length,
          degraded_count: keyframes.filter((k: any) => k.degraded === true).length,
          missing_refs: missing,
          degraded_retry: degradedRetry,
        });
        return { ...result, missing_refs: missing };
      }

      // ── 4 分镜视频:复用共享实现,支持逐镜补做 ──
      case 4: {
        const kf = sd['3']?.output;
        const shotOut = sd['2']?.output;
        if (!kf?.keyframes) throw new BadRequestException('请先生成关键帧(第 3 步)');
        if (!shotOut?.shots) throw new BadRequestException('请先生成分镜脚本(第 2 步)');
        // 2026-09-15:资产库角色名 → dialogue 净化器(让它在「××地说」「愤怒的××」里
        //   也认得出说话人、拆一镜多说话人)。取名失败绝不阻断出片,降级为空名单即可。
        const knownNames = await this.characterNames(drama.id);
        // 2026-09-05:风格圣经注入 —— style 进视频运动语言(方案2),seed 进逐镜
        //   可复现(方案1,风格圣经未设 seed 时保持原随机行为)。
        //   audios(方案8)由 input 透传,前端/调用方显式提供公网音频才启用。
        const out = await this.montage.genStep6ShotVideos(
          {
            ...input,
            aspect_ratio: input.aspect_ratio || styleSpec.aspectRatio,
            style: input.style || styleSpec.stylePrompt,
            seed: input.seed ?? styleSpec.seed ?? undefined,
            knownNames,
          },
          kf, shotOut, ctx, scopeTag, input?.options || {}, sd['4']?.output,
        );
        return save(out);
      }

      // ── 5 成片 + 状态回写 ──
      case 5: {
        const videos = sd['4']?.output;
        const shotOut = sd['2']?.output;
        if (!videos?.shots) throw new BadRequestException('请先生成分镜视频(第 4 步)');
        const dir = path.join(this.dramasDir, drama.uuid, `ep${epNo}`);
        // 2026-09-15:角色名同样喂给成片字幕的净化器(buildTimeline),与步骤 4 同源,
        //   保证「配音」与「字幕」对说话人的判定一致。
        const knownNames = await this.characterNames(drama.id);
        // 2026-09-16(批2)集首视觉回顾素材:上集成片尾帧 + 上集 hookOut。
        //   上集不存在/没钩子/没成片 → 不传,合成侧自动无回顾(降级安全)。
        let recap: any = null;
        if (epNo > 1) {
          try {
            const prevRow = await this.requireEpisode(drama.id, epNo - 1);
            const prevPath = path.join(this.dramasDir, drama.uuid, `ep${epNo - 1}`, 'final.mp4');
            if (prevRow?.hookOut && fs.existsSync(prevPath)) {
              recap = { prevVideoPath: prevPath, text: String(prevRow.hookOut) };
            }
          } catch (_) {
            // 上集不存在或不可读:不加回顾,绝不阻断本集出片
          }
        }
        const out = await this.montage.genStep7Compose(
          { ...input, targetSec }, videos, shotOut, scopeTag,
          { ...(input?.options || {}), knownNames, recap },
          // narrativeId 进时间轴(对应 hypit 的叙事身份):字幕/音效/图形多轨
          //   共享同一条时间轴时,靠它校验"这条时间轴属于哪部剧",防止串轨。
          { dir, urlBase: `/uploads/dramas/${drama.uuid}/ep${epNo}`, narrativeId: drama.uuid },
        );
        await save(out);
        // 成片即本集定稿:把大纲里预告的钩子与新事实正式写回剧级快照
        const outline = sd['0']?.output || {};
        // 2026-09-16(批2):本集结尾留下的钩子进「仍未解决的悬念」账本,
        //   下一集大纲提示词才读得到 openHooks(与 step0 的消费侧闭环)。
        const snapAtStep5 = this.parseJson(drama.snapshot, {}) as any;
        await this.writeBackSnapshot(dramaUuid, epNo, {
          hookOut: outline.hook_out || '',
          establishedFacts: outline.established_facts_new || [],
          characterStates: outline.character_states || {},
          openHooks: Array.from(new Set([
            ...(Array.isArray(snapAtStep5.openHooks) ? snapAtStep5.openHooks : []),
            ...(outline.hook_out ? [String(outline.hook_out)] : []),
          ])),
          finalUrl: out.final_url,
          durationSec: out.duration_sec,
          shotCount: (shotOut?.shots || []).length,
        });
        this.logger.log(`[ep-step5] EP${epNo} 成片 ${out.final_url}`);
        return this.getEpisode(dramaUuid, epNo);
      }

      default:
        throw new BadRequestException(`第 ${step} 步暂不支持自动生成`);
    }
  }

  // ==========================================================================
  // 一致性试机:同一句画面描述,带参考图 vs 不带参考图 出两张帧对照
  // ==========================================================================

  /**
   * 在真正开跑一整集之前,用极小成本验证「这套参考图到底锁不锁得住脸」。
   * useReference=false 走退化文生图路径,正好当对照组。
   * 这是给用户的证据,不是给用户的承诺 —— 没有 LoRA 时一致性只能做到"像"。
   */
  async previewKeyframe(
    dramaUuid: string, input: {
      description: string;
      shot_type?: string;
      camera_motion?: string;
      assetSlugs?: string[];
      useReference?: boolean;
    },
  ): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const description = String(input.description || '').trim();
    if (!description) throw new BadRequestException('请描述要试机的画面');

    const slugs = Array.isArray(input.assetSlugs) ? input.assetSlugs : [];
    const bySlug: Record<string, RefAsset> = {};
    for (const slug of slugs) {
      const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
        `SELECT * FROM \`DramaAsset\` WHERE \`dramaId\` = ? AND \`slug\` = ? LIMIT 1`,
        drama.id, slug,
      );
      if (rows.length) bySlug[slug] = this.fmtAsset(rows[0]) as unknown as RefAsset;
    }

    const styleSpec = this.parseJson(drama.styleSpec, {});
    const shot: KeyframeShot = {
      idx: 0, description,
      shot_type: input.shot_type, camera_motion: input.camera_motion,
      characters: slugs.filter((x) => bySlug[x]?.kind === 'character'),
      location_id: slugs.find((x) => bySlug[x]?.kind === 'location'),
      props: slugs.filter((x) => bySlug[x]?.kind === 'prop'),
    };
    const plan = buildKeyframePlan(shot, bySlug, styleSpec);

    // 对照组 = 旧路径:保留资产信息(外貌文字会回写进 prompt),只把参考图摘掉。
    // 不能传空字典 —— 那连长相描述都没了,两组之间就不只剩"参考图"这一个变量。
    const textOnlyAssets: Record<string, RefAsset> = {};
    for (const [k, v] of Object.entries(bySlug)) textOnlyAssets[k] = { ...v, refs: [] };
    const effective = input.useReference === false
      ? buildKeyframePlan(shot, textOnlyAssets, styleSpec)
      : plan;
    if (input.useReference !== false && plan.refUrls.length === 0) {
      throw new BadRequestException(
        `所选资产当前没有可用参考图(上游地址已过期或尚未定妆)。` +
        `请先在资产库点「生成定妆图」重出参考图。缺:${plan.missingRefs.join(', ') || '无选中资产'}`,
      );
    }

    // 刻意与 step5 走同一条 callImageWithKey 通道(多 key 轮询 + 429/503 退避),
    // 否则"试机通过、实跑失败"就失去意义。该通道不经 SkillDispatcher 计费,
    // 与 generatePortrait(走 dispatcher)存在已知不对称,统一留到 M4 队列化时收口。
    const apiKey = this.montage.nextKey();
    const started = Date.now();
    let remote: string;
    try {
      remote = await this.montage.callImageWithKey(
        apiKey, effective.prompt, effective.size, effective.negative,
        input.useReference === false ? [] : effective.refUrls,
        effective.ratio,
      );
    } catch (e: any) {
      throw new BadRequestException(
        `试机帧生成失败:${e?.message || e}。可重试,或改用「重生成定妆图」刷新参考地址。`,
      );
    }
    // 试机帧按剧分组建目录:删剧时能一并回收,不会留下无主文件
    const local = await this.landPreview(drama.uuid,
      input.useReference === false ? 'text-only' : 'with-ref', remote);

    return {
      image_url: local || remote,
      remote_url: remote,
      used_reference: input.useReference !== false,
      ref_urls: input.useReference === false ? [] : effective.refUrls,
      ref_sources: input.useReference === false ? [] : effective.refSources,
      degraded: effective.degraded,
      missing_refs: plan.missingRefs,
      prompt: effective.prompt,
      negative: effective.negative,
      elapsed_ms: Date.now() - started,
    };
  }

  // ==========================================================================
  // 连集批任务(M1:记录与查询;M4:BullMQ 编排)
  // ==========================================================================

  async createBatch(dramaUuid: string, userId: number, input: {
    fromEp: number; toEp: number; policy?: Record<string, any>;
  }): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const fromEp = Number(input.fromEp); const toEp = Number(input.toEp);
    if (!Number.isFinite(fromEp) || !Number.isFinite(toEp) || fromEp < 1 || toEp < fromEp) {
      throw new BadRequestException('集范围不合法(需 1 ≤ fromEp ≤ toEp)');
    }
    const policy = input.policy || {};
    if (!Number.isFinite(Number(policy.budgetCredits))) {
      throw new BadRequestException('必须显式给出积分预算 budgetCredits —— 连集不允许无上限烧分');
    }
    const uuid = randomUUID();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO \`DramaBatch\`
        (\`uuid\`,\`dramaId\`,\`userId\`,\`fromEp\`,\`toEp\`,\`policy\`,\`status\`,\`cursorEp\`,\`cursorStep\`,
         \`log\`,\`createdAt\`,\`updatedAt\`)
       VALUES (?,?,?,?,?,?, 'queued', ?, 0, CAST(? AS JSON), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      uuid, drama.id, userId, fromEp, toEp,
      JSON.stringify({
        autoAssetConfirm: policy.autoAssetConfirm !== false,
        autoVisual: policy.autoVisual !== false,
        stopOnFailure: policy.stopOnFailure === true,
        candidatesPerShot: Number(policy.candidatesPerShot) || 2,
        budgetCredits: Number(policy.budgetCredits),
      }),
      fromEp, JSON.stringify([]),
    );
    this.logger.log(`[batch] queued ${uuid} drama=${drama.uuid} EP${fromEp}-EP${toEp} budget=${policy.budgetCredits}`);
    return this.getBatch(uuid);
  }

  async getBatch(uuid: string): Promise<any> {
    const rows = await this.prisma.$queryRawUnsafe<BatchRow[]>(
      `SELECT * FROM \`DramaBatch\` WHERE \`uuid\` = ? LIMIT 1`, uuid,
    );
    if (!rows.length) throw new NotFoundException(`批任务不存在: ${uuid}`);
    const out = this.fmtBatch(rows[0]);
    // 编排器只拿 dramaUuid 就够,不必再查一次表
    const d = await this.prisma.$queryRawUnsafe<{ uuid: string }[]>(
      `SELECT \`uuid\` FROM \`Drama\` WHERE \`id\` = ? LIMIT 1`, rows[0].dramaId,
    );
    out.dramaUuid = d?.[0]?.uuid || '';
    return out;
  }

  async setBatchStatus(uuid: string, status: string, cursor?: { epNo?: number; step?: number }): Promise<any> {
    const allowed = ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'];
    if (!allowed.includes(status)) throw new BadRequestException(`status 必须是 ${allowed.join('/')}`);
    const b = await this.getBatch(uuid);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaBatch\` SET \`status\` = ?, \`cursorEp\` = ?, \`cursorStep\` = ?,
              \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      status, cursor?.epNo ?? b.cursorEp, cursor?.step ?? b.cursorStep, Number(b.id),
    );
    return this.getBatch(uuid);
  }

  /** 改批任务策略(续跑时提高预算用) */
  async updateBatchPolicy(uuid: string, policy: Record<string, any>): Promise<any> {
    const b = await this.getBatch(uuid);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaBatch\` SET \`policy\` = CAST(? AS JSON),
              \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(policy), Number(b.id),
    );
    return this.getBatch(uuid);
  }

  /** 供编排器使用的步骤标签 */
  get episodeStepLabels(): readonly string[] {
    return EPISODE_STEP_LABELS;
  }

  /** 从生成接口返回的剧集对象里取某步产出 */
  stepOutputOf(episode: any, step: number): any {
    return episode?.stepData?.[String(step)]?.output ?? null;
  }

  /** 进程重启后待恢复的批次 */
  async findRunningBatches(): Promise<any[]> {
    const rows = await this.prisma.$queryRawUnsafe<BatchRow[]>(
      `SELECT * FROM \`DramaBatch\` WHERE \`status\` = 'running' ORDER BY \`id\` ASC`,
    );
    const out: any[] = [];
    for (const r of rows || []) {
      const f = this.fmtBatch(r);
      const d = await this.prisma.$queryRawUnsafe<{ uuid: string }[]>(
        `SELECT \`uuid\` FROM \`Drama\` WHERE \`id\` = ? LIMIT 1`, r.dramaId,
      );
      out.push({ ...f, dramaUuid: d?.[0]?.uuid || '' });
    }
    return out;
  }

  /**
   * 记录断点:重启后从这里续跑,不从第 1 集重烧。
   *
   * **单调**:只接受比当前游标更靠后的位置。
   * 2026-09-15 集间流水线引入后,「EP N 的视频」与「EP N+1 的大纲/分镜/关键帧」
   * 是并行的两条线,各自都会写游标 —— 不设守卫的话游标会在
   * (EP N, step4) 与 (EP N+1, step2) 之间来回跳,前端「已到第 N 集第 M 步」
   * 看起来像在倒退。游标只用于展示与断点提示,`execute()` 实际靠 doneSteps
   * 幂等跳过,所以单调化不影响续跑正确性。
   */
  async saveBatchCursor(uuid: string, epNo: number, step: number): Promise<void> {
    const b = await this.getBatch(uuid);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaBatch\` SET \`cursorEp\` = ?, \`cursorStep\` = ?,
              \`updatedAt\` = CURRENT_TIMESTAMP(3)
        WHERE \`id\` = ?
          AND (\`cursorEp\` < ? OR (\`cursorEp\` = ? AND \`cursorStep\` <= ?))`,
      epNo, step, Number(b.id), epNo, epNo, step,
    );
  }

  /**
   * 收尾批次(done / failed)。failed 必须带原因,前端要能点开看。
   * 已取消的批次不许被覆盖成 done:worker 与"取消"存在竞态 ——
   * 取消到达时若所有步骤恰好都已完成,execute 会走到收尾并写 done,
   * 用户看到的就会是"跑完了"而不是"我取消了"。
   */
  async finishBatch(uuid: string, status: 'done' | 'failed', error: string): Promise<any> {
    const b = await this.getBatch(uuid);
    if (b.status === 'cancelled') {
      this.logger.log(`[batch] ${uuid} 已被取消,忽略收尾状态 ${status}(不覆盖用户意图)`);
      return b;
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaBatch\` SET \`status\` = ?, \`error\` = ?,
              \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      status, error || null, Number(b.id),
    );
    return this.getBatch(uuid);
  }

  /**
   * 已消耗积分 = 时间线里各步 credits 之和。
   * 用日志做累加器,好处是"预算用了多少"与"用户能看到的审计轨迹"是同一份数据,
   * 不会出现两个数字对不上的情况。
   */
  async batchSpentCredits(uuid: string, _prices: any): Promise<number> {
    const b = await this.getBatch(uuid);
    const log = Array.isArray(b.log) ? b.log : [];
    return log.reduce((sum: number, e: any) => sum + (Number(e?.credits) || 0), 0);
  }

  /** 取集,不存在则按承接规则新建(连集跨到未创建的集号时用) */
  async ensureEpisode(dramaUuid: string, epNo: number): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const existing = await this.prisma.$queryRawUnsafe<EpisodeRow[]>(
      `SELECT * FROM \`DramaEpisode\` WHERE \`dramaId\` = ? AND \`epNo\` = ? LIMIT 1`,
      drama.id, epNo,
    );
    if (existing.length) return this.fmtEpisode(existing[0]);
    return this.createEpisode(dramaUuid, { epNo });
  }

  /** 自动确认某步(连集模式没有人工点确认这一步) */
  async confirmEpisodeStep(dramaUuid: string, epNo: number, step: number): Promise<any> {
    return this.confirmStep(dramaUuid, epNo, step);
  }

  /** 非阻断步失败:本集标降级并记原因,整批继续下一集 */
  async markEpisodeDegraded(dramaUuid: string, epNo: number, error: string): Promise<any> {
    const drama = await this.requireDrama(dramaUuid);
    const row = await this.requireEpisode(drama.id, epNo);
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`status\` = 'degraded', \`error\` = ?,
              \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      error.slice(0, 2000), row.id,
    );
    return this.getEpisode(dramaUuid, epNo);
  }

  /** 追加一条批任务时间线日志(前端可展开审计) */
  async appendBatchLog(uuid: string, entry: {
    ep: number; step: number; ok: boolean; msg?: string; credits?: number; assetIds?: string[];
  }): Promise<any> {
    return this.enqueueLogWrite(uuid, async () => {
      const row = await this.prisma.$queryRawUnsafe<BatchRow[]>(
        `SELECT * FROM \`DramaBatch\` WHERE \`uuid\` = ? LIMIT 1`, uuid,
      );
      if (!row.length) throw new NotFoundException(`批任务不存在: ${uuid}`);
      // 真实进度落地,心跳让位:留着它前端会把「退避中」显示成当前状态,
      // 而实际上这一步已经完成了。
      // 2026-09-15:只清**本集**的心跳。集间流水线让「上一集的视频段」与
      //   「下一集的步骤 0-3」同时在飞,一刀切全清会把另一集正在跳的进度也抹掉 ——
      //   而那正是本次要解决的问题。
      const log = (this.parseJson(row[0].log, []) as any[])
        .filter((e) => !(e?.kind === BATCH_HEARTBEAT_KIND && e?.ep === entry.ep));
      log.push({ ...entry, at: new Date().toISOString() });
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`DramaBatch\` SET \`log\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        JSON.stringify(log.slice(-500)), row[0].id,
      );
      this.clearBeatState(uuid, entry.ep);
      return this.getBatch(uuid);
    });
  }

  // ==========================================================================
  // 连集时间线心跳:把「正在等上游限流」与「还剩几个镜头」显性化
  // --------------------------------------------------------------------------
  // 连集最容易被误判成卡死:一个视频步骤会因为 429 静默 7 分钟,期间时间线
  // 一条都不追加。心跳补的就是这段空窗。两条不变量(都有对应回归锁):
  //  1. **每个 ep/step 各占一条** —— 一次步骤里重试上百次,若逐条追加会把 log
  //     的 500 条上限吃满,真实进度反而被截断丢掉,那是拿可见性换数据。
  //     2026-09-15 由「整批只占一条」改来:集间流水线让**上一集的视频段**与
  //     **下一集的步骤 0-3** 同时在飞,共用一个键会让两者互相覆盖 ——
  //     用户看到的「正在等待」在一集视频进度和一集图像退避之间来回跳,
  //     两个都读不成完整句子。
  //  2. **永远在数组末尾** —— 工作台页取的是 `log.last`,不在末尾等于没显示。
  // ==========================================================================

  /** 每个 `批次:集:步` 上次写心跳的时间/内容/累计次数,用于节流 */
  private readonly beatState = new Map<string, { at: number; msg: string; n: number }>();

  private static beatKey(uuid: string, ep: number, step: number): string {
    return `${uuid}:${ep}:${step}`;
  }

  /** 某集真实进度落地后,清掉该集所有心跳(旧进度不再可信) */
  private clearBeatState(uuid: string, ep: number): void {
    const prefix = `${uuid}:${ep}:`;
    for (const k of [...this.beatState.keys()]) {
      if (k.startsWith(prefix)) this.beatState.delete(k);
    }
  }
  /** 同一批次的时间线读改写串行化,防心跳与步骤日志互相覆盖丢写 */
  private readonly logChain = new Map<string, Promise<unknown>>();

  private enqueueLogWrite<T>(uuid: string, task: () => Promise<T>): Promise<T> {
    const prev = this.logChain.get(uuid) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    // 链上只留"不会拒"的版本,一次失败不能把后续所有写锁死
    this.logChain.set(uuid, next.catch(() => {}));
    return next;
  }

  /**
   * 上报一次「正在等上游」。同步返回、内部吞错 —— 调用点在 HTTP 重试循环里,
   * 不能因为写库抖动把生成带崩。
   *
   * 节流:内容变了立刻写(用户要看见「第 2/3 次」在推进),
   * 内容没变则每 5s 才写一次,保证 updatedAt 在动但不打穿 DB。
   */
  batchHeartbeat(
    uuid: string, ep: number, step: number, msg: string, extra?: BeatExtra,
  ): void {
    const key = DramaService.beatKey(uuid, ep, step);
    const now = Date.now();
    const prev = this.beatState.get(key);
    if (prev && prev.msg === msg && now - prev.at < 5_000) return;
    this.beatState.set(key, { at: now, msg, n: (prev?.n || 0) + 1 });
    void this.writeHeartbeat(uuid, ep, step, msg, extra).catch(() => null);
  }

  private writeHeartbeat(
    uuid: string, ep: number, step: number, msg: string, extra?: BeatExtra,
  ): Promise<unknown> {
    return this.enqueueLogWrite(uuid, async () => {
      const rows = await this.prisma.$queryRawUnsafe<{ id: bigint; log: any }[]>(
        `SELECT \`id\`,\`log\` FROM \`DramaBatch\` WHERE \`uuid\` = ? LIMIT 1`, uuid,
      );
      if (!rows.length) return null;
      // 只替换**同一 ep/step** 的那一条:别的集/步的心跳属于并行的另一条
      // 流水线,抹掉等于把用户刚能看见的进度又收回去。
      const log = (this.parseJson(rows[0].log, []) as any[])
        .filter((e) => !(e?.kind === BATCH_HEARTBEAT_KIND && e?.ep === ep && e?.step === step));
      log.push({
        kind: BATCH_HEARTBEAT_KIND, ep, step, ok: true, msg,
        beats: this.beatState.get(DramaService.beatKey(uuid, ep, step))?.n || 1,
        at: new Date().toISOString(),
        ...(extra || {}),
      });
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`DramaBatch\` SET \`log\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        JSON.stringify(log.slice(-500)), rows[0].id,
      );
      return null;
    });
  }

  // ==========================================================================
  // 内部:查询 / 格式化 / 工具
  // ==========================================================================

  private async requireDrama(uuid: string): Promise<DramaRow> {
    const rows = await this.prisma.$queryRawUnsafe<DramaRow[]>(
      `SELECT * FROM \`Drama\` WHERE \`uuid\` = ? LIMIT 1`, uuid,
    );
    if (!rows.length) throw new NotFoundException(`剧集不存在: ${uuid}`);
    return rows[0];
  }

  private async requireEpisode(dramaId: bigint, epNo: number): Promise<EpisodeRow> {
    const rows = await this.prisma.$queryRawUnsafe<EpisodeRow[]>(
      `SELECT * FROM \`DramaEpisode\` WHERE \`dramaId\` = ? AND \`epNo\` = ? LIMIT 1`, dramaId, epNo,
    );
    if (!rows.length) throw new NotFoundException(`第 ${epNo} 集不存在`);
    return rows[0];
  }

  private async requireAsset(dramaUuid: string, assetId: string) {
    const drama = await this.requireDrama(dramaUuid);
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT * FROM \`DramaAsset\` WHERE \`dramaId\` = ?
         AND (\`id\` = ? OR \`uuid\` = ? OR \`slug\` = ?) LIMIT 1`,
      drama.id, Number.isNaN(Number(assetId)) ? -1 : Number(assetId), assetId, assetId,
    );
    if (!rows.length) throw new NotFoundException(`资产不存在: ${assetId}`);
    return { drama, asset: rows[0] };
  }

  private async listEpisodesByDramaId(dramaId: bigint): Promise<any[]> {
    const rows = await this.prisma.$queryRawUnsafe<EpisodeRow[]>(
      `SELECT * FROM \`DramaEpisode\` WHERE \`dramaId\` = ? ORDER BY \`epNo\` ASC`, dramaId,
    );
    return (rows || []).map((r) => this.fmtEpisode(r));
  }

  private async listAssetsByDramaId(
    dramaId: bigint, q: { kind?: string; status?: string; keyword?: string } = {},
  ): Promise<any[]> {
    const where = ['`dramaId` = ?'];
    const args: any[] = [dramaId];
    if (q.kind) { where.push('`kind` = ?'); args.push(q.kind); }
    if (q.status) { where.push('`status` = ?'); args.push(q.status); }
    if (q.keyword) {
      where.push('(`name` LIKE ? OR `slug` LIKE ? OR `descVisual` LIKE ?)');
      const like = `%${q.keyword}%`;
      args.push(like, like, like);
    }
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT * FROM \`DramaAsset\` WHERE ${where.join(' AND ')} ORDER BY \`kind\` ASC, \`useCount\` DESC, \`id\` ASC`,
      ...args,
    );
    return (rows || []).map((r) => this.fmtAsset(r));
  }

  private async listBatchesByDramaId(dramaId: bigint): Promise<any[]> {
    const rows = await this.prisma.$queryRawUnsafe<BatchRow[]>(
      `SELECT * FROM \`DramaBatch\` WHERE \`dramaId\` = ? ORDER BY \`id\` DESC LIMIT 20`, dramaId,
    );
    return (rows || []).map((r) => this.fmtBatch(r));
  }

  private async saveStepData(epId: bigint, sd: Record<string, any>): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE \`DramaEpisode\` SET \`stepData\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
      JSON.stringify(sd), epId,
    );
  }

  private async appendAlias(assetId: string, alias: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT * FROM \`DramaAsset\` WHERE \`id\` = ? LIMIT 1`, Number(assetId),
    );
    if (!rows.length || !alias) return;
    const aliases = this.parseJson(rows[0].aliases, []) as string[];
    if (!aliases.some((a) => normalizeName(a) === normalizeName(alias))) {
      aliases.push(alias);
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`DramaAsset\` SET \`aliases\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        JSON.stringify(aliases), rows[0].id,
      );
    }
  }

  private async addVariantRaw(assetId: string, label: string, descDelta: string | undefined, fromEp: number) {
    const rows = await this.prisma.$queryRawUnsafe<AssetRow[]>(
      `SELECT * FROM \`DramaAsset\` WHERE \`id\` = ? LIMIT 1`, Number(assetId),
    );
    if (!rows.length) throw new NotFoundException(`资产不存在: ${assetId}`);
    const asset = rows[0];
    const variants = this.parseJson(asset.variants, []) as any[];
    if (!variants.some((v) => normalizeName(v.label) === normalizeName(label))) {
      variants.push({ id: `v${variants.length + 1}`, label, descDelta: descDelta || '', fromEp, refs: [] });
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`DramaAsset\` SET \`variants\` = CAST(? AS JSON), \`updatedAt\` = CURRENT_TIMESTAMP(3) WHERE \`id\` = ?`,
        JSON.stringify(variants), asset.id,
      );
    }
    return asset;
  }

  private async markUsed(
    used: any[], assetId: string, r: MatchResult, d: { refs?: any[] }, variant?: string,
  ): Promise<void> {
    const shotIdxs = r.need.appearsIn || [];
    const existing = used.find((u) => String(u.assetId) === String(assetId));
    if (existing) {
      existing.variant = variant ?? existing.variant ?? null;
      existing.shotIdxs = Array.from(new Set([...(existing.shotIdxs || []), ...shotIdxs]));
      return;
    }
    used.push({
      assetId: String(assetId), slug: r.slug || '', name: r.name || '',
      variant: variant ?? null, shotIdxs,
    });
    void d;
  }

  /** slug 冲突时自动加数字后缀,保证 (dramaId, slug) 唯一 */
  private async resolveSlug(dramaId: bigint, kind: string, want: string | undefined, name: string): Promise<string> {
    const base = (want && want.trim())
      ? want.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 76)
      : suggestSlug(kind as AssetNeed['kind'], name, Date.now() % 100000);
    if (!base) throw new BadRequestException('无法生成 slug,请显式提供英文标识');
    let candidate = base;
    for (let i = 2; i < 200; i++) {
      const dup = await this.prisma.$queryRawUnsafe<{ id: bigint }[]>(
        `SELECT \`id\` FROM \`DramaAsset\` WHERE \`dramaId\` = ? AND \`slug\` = ? LIMIT 1`, dramaId, candidate,
      );
      if (!dup.length) return candidate;
      candidate = `${base}_${i}`;
    }
    throw new ConflictException('slug 冲突过多,请换一个英文标识');
  }

  private normalizeStyle(s: Record<string, any>): Record<string, any> {
    const LEGAL_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
    // `...s` 必须在最前:它只用于保留用户附加字段,校验后的白名单结果要能覆盖原始输入,
    // 否则非法 aspectRatio 会穿透到 step6 视频生成端。
    // 2026-09-05:seed 归一到上游合法区间 [0,999](实测越界 HTTP 400
    //   "seed must be between -1 and 999");null=不锁定,保持随机。
    const rawSeed = Number.isFinite(Number(s.seed)) ? Math.floor(Number(s.seed)) : null;
    const out = {
      ...s,
      stylePrompt: String(s.stylePrompt || '电影质感, 高细节, 写实'),
      aspectRatio: LEGAL_ASPECTS.includes(s.aspectRatio) ? s.aspectRatio : '9:16',
      palette: String(s.palette || ''),
      lighting: String(s.lighting || ''),
      cameraLanguage: String(s.cameraLanguage || ''),
      negativePrompt: String(s.negativePrompt || ''),
      seed: rawSeed != null ? Math.min(999, Math.max(0, rawSeed)) : null,
    };
    const sig = createHash('sha1')
      .update(JSON.stringify([out.stylePrompt, out.aspectRatio, out.palette, out.lighting,
        out.cameraLanguage, out.negativePrompt, out.seed]))
      .digest('hex').slice(0, 16);
    return { ...out, sigHash: sig };
  }

  private statusOfStep(step: number): string {
    return ['scripting', 'asset_check', 'storyboard', 'keyframe', 'video', 'composing'][step] || 'pending';
  }

  private checkStep(step: number): void {
    if (!Number.isInteger(step) || step < 0 || step >= EPISODE_STEP_LABELS.length) {
      throw new BadRequestException(`step 取值必须为 0-${EPISODE_STEP_LABELS.length - 1}`);
    }
  }

  private parseJson(raw: any, fallback: any): any {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return fallback; }
    }
    return raw;
  }

  /**
   * 解析本剧的「单集目标时长」(秒)。
   *
   * 取值优先级:调用方入参 → 账本 `meta.budget.ep_target_sec`(用户在表单里选的)
   * → 120 秒兜底。
   *
   * 为什么要回落到账本:连集批次会透传 targetSec,但手动单步生成
   * (`POST /episodes/:epNo/steps/:step/generate`)与历史数据都不会带。
   * 不回落的后果是同一部剧在两条路径下产出不同长度的大纲 —— 而用户
   * 在表单里明明选过一次,系统不该"忘了"。
   */
  private async resolveEpTargetSec(dramaId: bigint, fromInput: any): Promise<number> {
    const n = Number(fromInput);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ lj: any }[]>(
        'SELECT `ledgerJson` AS lj FROM `dramas_novel_ledger` WHERE `dramaId` = ? LIMIT 1',
        dramaId,
      );
      const lj = this.parseJson(rows[0]?.lj, null);
      const v = Number(lj?.meta?.budget?.ep_target_sec);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    } catch { /* 账本缺失或 JSON 异常 → 走兜底,不让它阻断生成 */ }
    return 120;
  }

  private s(v: any): string | null {
    if (v == null) return null;
    return typeof v === 'bigint' ? v.toString() : String(v);
  }

  private fmtDrama(r: DramaRow): any {
    return {
      id: this.s(r.id), uuid: r.uuid, userId: this.s(r.userId), agentId: this.s(r.agentId),
      title: r.title, logline: r.logline, synopsis: r.synopsis, coverUrl: r.coverUrl,
      status: r.status, storyMode: r.storyMode,
      bible: this.parseJson(r.bible, {}), styleSpec: this.parseJson(r.styleSpec, {}),
      storyArc: this.parseJson(r.storyArc, []), snapshot: this.parseJson(r.snapshot, {}),
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  private fmtEpisode(r: EpisodeRow): any {
    return {
      id: this.s(r.id), uuid: r.uuid, dramaId: this.s(r.dramaId), epNo: r.epNo,
      title: r.title, logline: r.logline, hookIn: r.hookIn, hookOut: r.hookOut,
      status: r.status, step: r.step, stepLabel: EPISODE_STEP_LABELS[r.step] || '',
      stepData: this.parseJson(r.stepData, {}),
      usedAssets: this.parseJson(r.usedAssets, []),
      newAssets: this.parseJson(r.newAssets, []),
      finalUrl: r.finalUrl, posterUrl: r.posterUrl,
      durationSec: r.durationSec, shotCount: r.shotCount,
      credits: r.credits, refunded: r.refunded, error: r.error,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  private fmtAsset(r: AssetRow): any {
    const refs = this.parseJson(r.refs, []) as any[];
    return {
      id: this.s(r.id), uuid: r.uuid, dramaId: this.s(r.dramaId),
      kind: r.kind, slug: r.slug, name: r.name,
      aliases: this.parseJson(r.aliases, []),
      descVisual: r.descVisual, descPersona: r.descPersona,
      refs,
      // 后续图生图默认拿 canonical;兜底也必须挑「真有图的」那条,
      // 不能盲目退回 refs[0] —— 首视图可能是一次失败留下的空条目。
      canonicalRef:
        refs.find((x) => x.canonical && (x.url || x.remoteUrl))
        || refs.find((x) => x.url || x.remoteUrl)
        || refs[0] || null,
      variants: this.parseJson(r.variants, []),
      source: r.source, sourceEp: r.sourceEp, status: r.status,
      locked: r.locked === 1 || r.locked === true,
      styleSig: r.styleSig, useCount: r.useCount,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  private fmtBatch(r: BatchRow): any {
    return {
      id: this.s(r.id), uuid: r.uuid, dramaId: this.s(r.dramaId), userId: this.s(r.userId),
      fromEp: r.fromEp, toEp: r.toEp, policy: this.parseJson(r.policy, {}),
      status: r.status, cursorEp: r.cursorEp, cursorStep: r.cursorStep,
      cursorStepLabel: EPISODE_STEP_LABELS[r.cursorStep] || '',
      rootJobId: r.rootJobId, log: this.parseJson(r.log, []), error: r.error,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
}
