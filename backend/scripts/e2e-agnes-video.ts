// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import * as dotenv from 'dotenv';

dotenv.config();

import { ConfigService } from '../src/common/config/config.service';
import { AgnesDispatcher } from '../src/modules/skills/providers/agnes.provider';

const config = new ConfigService();
const agnes = new AgnesDispatcher(config);
const ctx: any = {
  taskId: 0n,
  userId: 0,
  agentId: 0,
  signal: new AbortController().signal,
  upstreamOutputs: {},
  onProgress: async (p: number, msg: string) => {
    console.log(`  [progress ${p}%] ${msg}`);
  },
};

async function main(): Promise<void> {
  const mode = process.argv[2] || 't2v';
  if (mode === 'image') {
    const r = await agnes.call('image.agnes-image-2.5-flash', { prompt: 'a red ceramic coffee mug on a white table, studio light, product photo', n: 1 }, null, ctx);
    const url = r.artifacts?.[0]?.remoteUrl || '';
    console.log('IMAGE_URL=' + url);
    return;
  }
  if (mode === 't2v') {
    console.log('== t2v: video.agnes-v2-t2v (binding config aspect_ratio=9:16 应生效, input seconds=4) ==');
    const r = await agnes.call('video.agnes-v2-t2v', { prompt: 'a futuristic street after rain, neon reflections, cinematic camera', seconds: '4' }, { aspect_ratio: '9:16', seed: 42 }, ctx);
    console.log('T2V_RESULT=' + JSON.stringify({
      status: r.output.status,
      mode: r.output.mode,
      video_id: r.output.video_id,
      url: r.artifacts?.[0]?.remoteUrl,
      w: r.artifacts?.[0]?.metadata?.width,
      h: r.artifacts?.[0]?.metadata?.height,
      seed_sent: true,
    }));
    if (!r.artifacts?.[0]?.remoteUrl) {
      console.error('FAIL: no video url');
      process.exit(1);
    }
    console.log('T2V_OK');
    return;
  }
  if (mode === 'i2v') {
    const imageUrl = process.argv[3];
    if (!imageUrl) {
      console.error('usage: i2v <public imageUrl>');
      process.exit(2);
    }
    console.log('== i2v: video.agnes-v2-i2v keyframe first_frame=' + imageUrl.slice(0, 60) + ' ==');
    const r = await agnes.call('video.agnes-v2-i2v', { prompt: 'the mug slowly rotates, steam rising, soft cinematic light, product commercial', seconds: '4', image: imageUrl }, { aspect_ratio: '1:1' }, ctx);
    console.log('I2V_RESULT=' + JSON.stringify({
      status: r.output.status,
      mode: r.output.mode,
      url: r.artifacts?.[0]?.remoteUrl,
      w: r.artifacts?.[0]?.metadata?.width,
      h: r.artifacts?.[0]?.metadata?.height,
    }));
    if (r.output.mode !== 'keyframe') {
      console.error('FAIL: expected keyframe mode');
      process.exit(1);
    }
    if (!r.artifacts?.[0]?.remoteUrl) {
      console.error('FAIL: no video url');
      process.exit(1);
    }
    console.log('I2V_OK');
    return;
  }
  if (mode === 'datauri') {
    console.log('== datauri 防御: first_frame 传 data URI,应降级 text 且成功出片 ==');
    const r = await agnes.call('video.agnes-v2-i2v', { prompt: 'calm ocean waves at sunset, slow camera drift', seconds: '4', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }, null, ctx);
    console.log('DATAURI_RESULT=' + JSON.stringify({
      mode: r.output.mode,
      url: r.artifacts?.[0]?.remoteUrl,
    }));
    if (r.output.mode !== 'text') {
      console.error('FAIL: expected downgrade to text');
      process.exit(1);
    }
    if (!r.artifacts?.[0]?.remoteUrl) {
      console.error('FAIL: no video url');
      process.exit(1);
    }
    console.log('DATAURI_OK');
    return;
  }
  console.error('unknown mode ' + mode);
  process.exit(2);
}

main().catch((e: any) => { console.error('E2E_FAILED:', e.message || e); process.exit(1); });

export {};
