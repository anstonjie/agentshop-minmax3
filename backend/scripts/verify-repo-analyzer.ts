// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { RepoAnalyzerService } from '../src/modules/agent/repo-analyzer.service';
import { makeGithubChannelPolicy } from '../src/common/github-channel/github-channel.factory';

async function main(): Promise<void> {
  const analyzer = new RepoAnalyzerService(makeGithubChannelPolicy());
  const repoUrl = 'https://github.com/hugohe3/ppt-master';
  const branch = 'main';
  console.log('\n=== 验证 RepoAnalyzerService ===\n');
  console.log(`仓库: ${repoUrl}@${branch}`);
  console.log(`LLM_BASE_URL: ${process.env.LLM_BASE_URL || process.env.SANDBOX_LLM_BASE_URL || '(未设置)'}`);
  console.log(`LLM_API_KEY: ${process.env.LLM_API_KEY || process.env.SANDBOX_LLM_API_KEY ? '(已设置)' : '(未设置)'}`);
  console.log(`LLM_MODEL: ${process.env.LLM_MODEL || process.env.SANDBOX_LLM_MODEL || '(未设置)'}\n`);
  const t0 = Date.now();
  try {
    const result = await analyzer.analyze(repoUrl, branch, {});
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('=== 分析结果 ===\n');
    console.log(`项目类型: ${result.projectType}`);
    console.log(`分析理由: ${result.reason}`);
    console.log(`install_cmd: ${result.install_cmd || '(空)'}`);
    console.log(`run_cmd: ${result.run_cmd || '(空)'}`);
    console.log(`systemPrompt: ${result.systemPrompt ? result.systemPrompt.substring(0, 300) + '...' : '(空)'}`);
    console.log(`\n环境变量 (${Object.keys(result.env).length} 个):`);
    for (const [key, value] of Object.entries(result.env).sort()) {
      const display = (value as string).length > 20
        ? (value as string).substring(0, 8) + '...' + ` (${(value as string).length} chars)`
        : value;
      console.log(`  ${key} = ${display}`);
    }
    console.log(`\n仓库文件列表 (${result.fileNames.length} 个):`);
    console.log(`  ${result.fileNames.slice(0, 30).join(', ')}`);
    console.log(`\n关键文件 (${Object.keys(result.keyFiles).length} 个):`);
    for (const [name, content] of Object.entries(result.keyFiles)) {
      console.log(`  ${name}: ${(content as string).length} 字符`);
    }
    console.log('\n=== 验证断言 ===\n');
    const checks = [
      { name: 'install_cmd 不为空', pass: !!result.install_cmd },
      { name: 'run_cmd 不为空', pass: !!result.run_cmd },
      { name: 'env 包含 OPENAI_API_KEY', pass: !!result.env['OPENAI_API_KEY'] },
      { name: 'env 包含 LLM_API_KEY', pass: !!result.env['LLM_API_KEY'] },
      { name: 'env 包含 LLM_BASE_URL', pass: !!result.env['LLM_BASE_URL'] },
      { name: 'systemPrompt 不为空', pass: !!result.systemPrompt },
      { name: 'projectType 为 skill_package 或 application', pass: ['skill_package', 'application'].includes(result.projectType) },
    ];
    for (const c of checks) {
      console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    }
    const allPass = checks.every((c) => c.pass);
    console.log(`\n=== ${allPass ? '✅ 全部通过' : '❌ 有失败项'} · 耗时 ${elapsed}s ===\n`);
    process.exit(allPass ? 0 : 1);
  } catch (e: any) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`\n❌ 分析失败 (${elapsed}s): ${e?.message || e}`);
    console.error(e?.stack);
    process.exit(1);
  }
}

main();

export {};
