// ============================================================================
// DramaModule —— 微短剧「剧 / 集 / 资产」三层结构
// ----------------------------------------------------------------------------
// 对应前端 lib/pages/drama/ (我的剧集 / 剧集详情 / 单集生产)
// 数据层 Drama / DramaEpisode / DramaAsset / DramaBatch 四张表
// 设计方案 docs/微短剧分集与资产库设计方案_2026-08-28.html
//
// M1 依赖 Prisma + OpenMontage(定妆复用其设计提示词与图像调用);
// M4 起会引入 BullMQ 队列编排。
// ============================================================================

import { Module } from '@nestjs/common';
import { DramaController } from './drama.controller';
import { DramaService } from './drama.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { OpenMontageModule } from '../open-montage/open-montage.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { DramaOrchestrator } from './drama-orchestrator.service';
import { NovelLedgerService } from './novel-ledger.service';
import { NovelGenService } from './novel-gen.service';
import { NovelPipelineService } from './novel-pipeline.service';
import { PortraitBatchService } from './portrait-batch.service';

@Module({
  // OpenMontageModule 导出 OpenMontageService:定妆用的设计提示词(genStep2Design)、
  // 图像调用(callImage)与下载落地(downloadFile)全部复用它,不另写第二套。
  // RuntimeModule 提供 QueueService(BullMQ)与 ProgressGateway(WS 进度房间)
  imports: [PrismaModule, OpenMontageModule, RuntimeModule],
  controllers: [DramaController],
  // NovelLedgerService(P1):Novel2Drama 对齐账本层(n2d-core 桥接 +
  // dramas_novel_ledger/beats/gates/snaps 四表,最终方案 v6.0)
  // NovelGenService(入口 A):标题→完本小说五级瀑布(L1-L5,断点续跑),
  // 完成后经 novel/ingest(source='generated')与本智能体对齐链路汇合
  // NovelPipelineService(Stage 2 编排):审批门驱动的 设定→剧本→连集生产 流水线
  // PortraitBatchService(2026-09-15):剧级批量定妆 —— 门②通过后自动开跑,
  // 资产库「一键定妆剩余 N 项」手动补跑,进度落 Drama.portraitBatch 供两端轮询
  providers: [DramaService, DramaOrchestrator, NovelLedgerService, NovelGenService, NovelPipelineService, PortraitBatchService],
  exports: [DramaService, DramaOrchestrator, NovelLedgerService, NovelGenService, NovelPipelineService, PortraitBatchService],
})
export class DramaModule {}
