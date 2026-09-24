// ============================================================================
// OpenMontageController - 微短剧制作 8 步向导 REST API
// ----------------------------------------------------------------------------
// 全部接口需要 JWT 鉴权
//
// 8 步流程:
//   0: 需求确认     (用户输入主题/类型/时长/风格)
//   1: 剧本大纲     (LLM 生成 title/logline/scenes)
//   2: 角色/场景/道具设计 (LLM 生成 characters/locations/props)
//   3: 设定图       (AGNES image 生成角色四视图/场景图/道具图)
//   4: 分镜脚本     (LLM 把剧本拆为 shots)
//   5: 分镜关键帧   (AGNES image 为每个 shot 生成 keyframe)
//   6: 分镜视频     (AGNES video 为每个 shot 生成视频)
//   7: 合成视频     (ffmpeg 拼接 + xfade 转场 + ASS/SRT 字幕烧录 + 音轨拼接;
//                    台词音轨来自 Agnes i2v 片段自带 AAC,无独立 TTS/BGM 混音)
//
// 通用接口:
//   POST   /api/open-montage/sessions                     创建会话
//   GET    /api/open-montage/sessions                     列出我的会话
//   GET    /api/open-montage/sessions/:id                 获取会话状态
//   DELETE /api/open-montage/sessions/:id                 删除会话
//   POST   /api/open-montage/sessions/:id/step/:step/generate   生成某步
//   POST   /api/open-montage/sessions/:id/step/:step/confirm    确认某步(推进)
//   PUT    /api/open-montage/sessions/:id/step/:step/output     修改某步产出
//   DELETE /api/open-montage/sessions/:id/step/:step/output     删除某步产出(回退)
// ============================================================================

import {
  Body, Controller, Delete, Get, Param, Post, Put, Req, Res, Query, UseGuards, Logger, BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import axios from 'axios';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { OpenMontageService } from './open-montage.service';

@Controller('open-montage')
@UseGuards(JwtAuthGuard)
export class OpenMontageController {
  private readonly logger = new Logger(OpenMontageController.name);

  constructor(private readonly svc: OpenMontageService) {}

  private userId(req: Request): number {
    const raw = (req as any).user?.id;
    return raw == null ? 0 : Number(raw);
  }

  // ── 图片代理(绕过 AGNES 图片域名 CORS 限制) ──
  // 2026-07-30:platform-outputs.agnes-ai.space 没有 CORS 头,浏览器直接加载被阻止。
  // 前端 <img> 标签把外部图片 URL 转成 /api/open-montage/proxy-image?url=xxx,后端 stream 返回。
  // @Public:因为 <img> 标签不会带 Authorization header,需公开访问。
  // 安全:仅允许 agnes-ai 相关域名,防止 SSRF。
  @Public()
  @Get('proxy-image')
  async proxyImage(@Query('url') url: string, @Res() res: Response) {
    if (!url) throw new BadRequestException('missing url param');
    // 白名单:agnes-ai 域名
    const allowed = ['agnes-ai.space', 'agnes-ai.com', 'agnes-ai.cn'];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('invalid url');
    }
    if (!allowed.some((d) => parsed.hostname.endsWith(d))) {
      throw new BadRequestException(`domain not allowed: ${parsed.hostname}`);
    }
    try {
      const upstream = await axios.get(url, {
        responseType: 'stream',
        timeout: 60_000,
        headers: { 'User-Agent': 'Horizon-Backend-Proxy/1.0' },
      });
      const ct = String(upstream.headers['content-type'] || 'image/png');
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      upstream.data.pipe(res);
    } catch (e: any) {
      this.logger.error(`[proxyImage] failed: ${url} → ${e?.message}`);
      res.status(502).send(`proxy failed: ${e?.message}`);
    }
  }

  // ── 会话 CRUD ──

  @Post('sessions')
  async createSession(
    @Req() req: Request,
    @Body() body: { agentId?: number; title?: string; requirement?: any },
  ) {
    return this.svc.createSession({
      userId: this.userId(req),
      agentId: body.agentId ?? 201,
      title: body.title,
      requirement: body.requirement,
    });
  }

  @Get('sessions')
  async listSessions(@Req() req: Request) {
    return this.svc.listSessions(this.userId(req));
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string) {
    return this.svc.getSession(id);
  }

  @Delete('sessions/:id')
  async deleteSession(@Param('id') id: string) {
    return this.svc.deleteSession(id);
  }

  // ── 步骤操作 ──

  @Post('sessions/:id/step/:step/generate')
  async generateStep(
    @Param('id') id: string,
    @Param('step') step: string,
    @Body() body: { input?: any; options?: any },
  ) {
    const stepNum = Number(step);
    if (Number.isNaN(stepNum) || stepNum < 0 || stepNum > 7) {
      throw new Error('step 取值必须为 0-7');
    }
    return this.svc.generateStep(id, stepNum, body.input, body.options);
  }

  @Post('sessions/:id/step/:step/confirm')
  async confirmStep(
    @Param('id') id: string,
    @Param('step') step: string,
    @Body() body: { input?: any; output?: any },
  ) {
    const stepNum = Number(step);
    if (Number.isNaN(stepNum) || stepNum < 0 || stepNum > 7) {
      throw new Error('step 取值必须为 0-7');
    }
    return this.svc.confirmStep(id, stepNum, body.input, body.output);
  }

  @Put('sessions/:id/step/:step/output')
  async updateStepOutput(
    @Param('id') id: string,
    @Param('step') step: string,
    @Body() body: { output: any },
  ) {
    const stepNum = Number(step);
    if (Number.isNaN(stepNum) || stepNum < 0 || stepNum > 7) {
      throw new Error('step 取值必须为 0-7');
    }
    return this.svc.updateStepOutput(id, stepNum, body.output);
  }

  @Delete('sessions/:id/step/:step/output')
  async deleteStepOutput(
    @Param('id') id: string,
    @Param('step') step: string,
  ) {
    const stepNum = Number(step);
    if (Number.isNaN(stepNum) || stepNum < 0 || stepNum > 7) {
      throw new Error('step 取值必须为 0-7');
    }
    return this.svc.deleteStepOutput(id, stepNum);
  }
}
