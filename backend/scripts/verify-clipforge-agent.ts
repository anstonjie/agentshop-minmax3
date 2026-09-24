// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const a = await prisma.agent.findUnique({ where: { id: 196n } });
  console.log('=== Agent 196 最终状态 ===');
  console.log('id:', String(a?.id));
  console.log('name:', a?.name);
  console.log('description:', a?.description);
  console.log('status:', a?.status);
  console.log('agentType:', a?.agentType);
  console.log('sandboxRuntime:', a?.sandboxRuntime);
  console.log('engineType:', a?.engineType);
  console.log('engineVersion:', a?.engineVersion);
  console.log('allowSandbox:', a?.allowSandbox);
  console.log('allowTrade:', a?.allowTrade);
  console.log('category:', a?.category);
  console.log('tags:', JSON.stringify(a?.tags));
  console.log('systemPrompt length:', a?.systemPrompt?.length);
  console.log();
  const j = await prisma.agentPublishJob.findFirst({ where: { agentId: 196n }, orderBy: { id: 'desc' } });
  console.log('=== Job 状态 ===');
  console.log('jobId:', String(j?.id));
  console.log('status:', j?.status);
  console.log('stage:', j?.stage);
  console.log('progressPct:', j?.progressPct);
  console.log('finishedAt:', j?.finishedAt);
  console.log('errorMessage:', j?.errorMessage);
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });

export {};
