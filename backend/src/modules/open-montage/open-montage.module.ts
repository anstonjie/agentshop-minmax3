// ============================================================================
// OpenMontageModule - 微短剧制作 8 步向导
// ----------------------------------------------------------------------------
// 对应前端 lib/pages/micro_drama_studio_page.dart
// 数据库:MicroDramaSession 表(Prisma schema 已定义,运行时通过 $queryRawUnsafe 操作)
// LLM/图像/视频:走 SkillDispatcher(agnes-2.5-flash / agnes-image-2.5-flash / agnes-video-2.5-flash)
// ============================================================================

import { Module } from '@nestjs/common';
import { OpenMontageController } from './open-montage.controller';
import { OpenMontageService } from './open-montage.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { SkillsModule } from '../skills/skills.module';
import { OssModule } from '../oss/oss.module';

@Module({
  imports: [PrismaModule, SkillsModule, OssModule],
  controllers: [OpenMontageController],
  providers: [OpenMontageService],
  exports: [OpenMontageService],
})
export class OpenMontageModule {}
