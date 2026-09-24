// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import axios from 'axios';

const MODEL = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';
const BASE_URL = process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1';
const API_KEY = process.env.AGNES_API_KEY || '';

async function probeOne(modelName: string): Promise<number | null> {
  const url = `${BASE_URL}/embeddings`;
  console.log(`\nProbing model=${modelName} ...`);
  try {
    const resp = await axios.post(
      url,
      { model: modelName, input: 'ping' },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );
    if (resp.status < 200 || resp.status >= 300) {
      console.log(`  ❌ HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
      return null;
    }
    const v = resp.data?.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) {
      console.log(`  ❌ no embedding in response: ${JSON.stringify(resp.data).slice(0, 200)}`);
      return null;
    }
    console.log(`  ✅ dim=${v.length} (first 5: [${v.slice(0, 5).map((x: number) => x.toFixed(4)).join(', ')}, ...])`);
    return v.length;
  } catch (e: any) {
    console.log(`  ❌ ${e?.code || 'ERR'}: ${e?.message}`);
    return null;
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('AGNES_API_KEY not set in env. Aborting.');
    process.exit(1);
  }
  console.log(`AGNES_BASE_URL = ${BASE_URL}`);
  console.log(`AGNES_API_KEY  = ${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)}`);
  const candidates = [MODEL, 'text-embedding-3-small', 'text-embedding-ada-002'];
  const tried = new Set<string>();
  let foundDim: number | null = null;
  for (const m of candidates) {
    if (tried.has(m)) continue;
    tried.add(m);
    const d = await probeOne(m);
    if (d !== null) {
      foundDim = d;
      if (m !== MODEL) {
        console.log(`\n(Note: configured model '${MODEL}' failed; '${m}' returned dim=${d})`);
      }
      break;
    }
  }
  if (foundDim) {
    console.log(`\n========================================`);
    console.log(`Recommended runtime.yaml setting:`);
    console.log(`  rag.embedding_model: "${tried.has(MODEL) ? MODEL : Array.from(tried).pop()}"`);
    console.log(`  rag.embedding_dim: ${foundDim}`);
    console.log(`========================================`);
  } else {
    console.log('\nAll candidates failed. Check AGNES_BASE_URL / API_KEY / network.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

export {};
