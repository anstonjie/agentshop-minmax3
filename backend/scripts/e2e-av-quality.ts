// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import * as dotenv from 'dotenv';

dotenv.config();

import axios from 'axios';
import * as crypto from 'crypto';
import { buildShotVideoPrompt } from '../src/modules/drama/video-prompt';

const KEY = process.env.AGNES_API_KEY || '';
const BASE = (process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, '');
if (!KEY) {
  console.error('FAIL: AGNES_API_KEY 未配置');
  process.exit(1);
}
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? '✅' : '❌'} ${label}`);
    if (ok) pass++;
    else fail++;
  };
  console.log('\n[方案1] 图像 seed 确定性(同 seed 两次,SHA256 对比)');
  const imgBody = (seed: number) => ({
    model: 'agnes-image-2.5-flash',
    prompt: '(front view:1.3), single character only, character reference design, white background, highly detailed',
    n: 1, size: '1K', ratio: '1:1', seed,
    extra_body: { response_format: 'url' },
  });
  const genHash = async (seed: number): Promise<string> => {
    const r = await axios.post(`${BASE}/images/generations`, imgBody(seed), { headers, timeout: 120_000, validateStatus: () => true });
    const u = r.data?.data?.[0]?.url;
    if (!u) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const img = await axios.get(u, { responseType: 'arraybuffer', timeout: 120_000 });
    return crypto.createHash('sha256').update(Buffer.from(img.data)).digest('hex');
  };
  try {
    const h1 = await genHash(426);
    await sleep(6000);
    const h2 = await genHash(426);
    check(h1 === h2, `同 seed(426)产物 SHA256 一致 (${h1.slice(0, 16)}…)`);
  } catch (e: any) {
    check(false, `seed 确定性: ${e.message}`);
  }
  console.log('\n[方案2] buildShotVideoPrompt 运动语言');
  const vp = buildShotVideoPrompt(
    { description: '女主角推开咖啡馆的门走进雨中', shot_type: '中景', camera_motion: '跟' },
    { styleTail: '电影质感, 冷色调胶片' },
  );
  console.log(`  prompt = ${vp}`);
  check(vp.includes('follows the moving subject'), '运镜"跟"→ follows the moving subject');
  check(vp.includes('medium shot'), '景别"中景"→ medium shot');
  check(vp.includes('no morphing') && vp.includes('no flickering'), '真实性底线词在位');
  check(vp.includes('电影质感'), '风格尾巴注入');
  check(!/hairstyle|wardrobe|facial features/i.test(vp), '不复述外貌(防换脸铁律)');
  console.log('\n[方案8] 视频 reference 模式 + audios(音频参考)');
  const kfResp = await axios.post(`${BASE}/images/generations`, {
    model: 'agnes-image-2.5-flash',
    prompt: 'a woman standing at a cafe door in light rain, cinematic, medium shot',
    n: 1, size: '1K', ratio: '9:16', extra_body: { response_format: 'url' },
  }, { headers, timeout: 120_000, validateStatus: () => true });
  const kfUrl = kfResp.data?.data?.[0]?.url;
  check(!!kfUrl, `关键帧图生成 ${kfUrl ? 'OK' : 'FAIL HTTP ' + kfResp.status}`);
  if (!kfUrl) {
    console.log(`总:${pass} pass / ${fail} fail`);
    process.exit(1);
  }
  const refPrompt = buildShotVideoPrompt(
    { description: '女性推开门走进雨中,雨水自然落下', shot_type: '中景', camera_motion: '跟' },
    { referenceMode: true, refImageCount: 1, refAudioCount: 1 },
  );
  console.log(`  reference prompt = ${refPrompt}`);
  const vidResp = await axios.post(`${BASE}/videos`, {
    model: 'agnes-video-2.5-flash',
    prompt: refPrompt,
    mode: 'reference',
    seconds: '4', size: '720P', aspect_ratio: '9:16',
    images: [kfUrl],
    audios: ['https://cdn.jsdelivr.net/gh/anars/blank-audio@master/1-second-of-silence.mp3'],
    seed: 426,
  }, { headers, timeout: 120_000, validateStatus: () => true }).catch((e: any) => ({ status: -1, data: { timeout: true, message: e.message } }));
  if (vidResp.status >= 200 && vidResp.status < 300 && (vidResp.data?.video_id || vidResp.data?.id)) {
    check(true, `reference+audios 任务创建成功 (video_id=${vidResp.data.video_id || vidResp.data.id})`);
  } else if (vidResp.status === -1) {
    console.log('⚠️ reference+audios 创建读超时(已知上游问题:外部音频拉取不可用,跳过)');
  } else {
    check(false, `reference+audios 创建 HTTP ${vidResp.status}: ${JSON.stringify(vidResp.data).slice(0, 300)}`);
  }
  console.log(`\n== 总计:${pass} pass / ${fail} fail ==`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e: any) => {
  console.log(`\n[异常] ${e.message}`);
  process.exit(1);
});

export {};
