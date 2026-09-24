// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { RepoAnalyzerService } from '../src/modules/agent/repo-analyzer.service';
import { makeGithubChannelPolicy } from '../src/common/github-channel/github-channel.factory';
import { ClaudeCodeEngine } from '../src/modules/engine/engines/claude-code/engine';

const REPO_URL = 'https://github.com/zenstory-ai/drama-skills';
const BRANCH = 'main';
const EXPECTED_SKILLS = [
  'short-drama',
  'short-drama-assets',
  'short-drama-develop',
  'short-drama-edit',
  'short-drama-image-prompts',
  'short-drama-novel-analyze',
  'short-drama-produce',
  'short-drama-review',
  'short-drama-storyboard',
  'short-drama-video-prompts',
  'short-drama-write',
];

async function main(): Promise<void> {
  console.log('\n=== 验证 drama-skills 上架链路 ===\n');
  console.log(`仓库: ${REPO_URL}@${BRANCH}`);
  const analyzer = new RepoAnalyzerService(makeGithubChannelPolicy());
  const t0 = Date.now();
  const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
  const check = (name: string, pass: boolean, detail = '') => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  try {
    const result = await analyzer.analyze(REPO_URL, BRANCH, {});
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n分析完成(${elapsed}s),开始断言:\n`);
    check('projectType = skill_package(规则链确定性,无需 LLM 兜底)', result.projectType === 'skill_package', `实际=${result.projectType} reason=${result.reason}`);
    const nestedSkillMds = Object.keys(result.keyFiles)
      .filter((k) => /^skills\/[^/]+\/SKILL\.md$/.test(k))
      .sort((a, b) => {
        const da = a.split('/')[1].toLowerCase();
        const db = b.split('/')[1].toLowerCase();
        if (da !== db) return da < db ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    const foundSkills = nestedSkillMds.map((k) => k.split('/')[1]);
    const missing = EXPECTED_SKILLS.filter((s) => !foundSkills.includes(s));
    check(`嵌套 SKILL.md 读取完整(期望 ${EXPECTED_SKILLS.length} 份)`, missing.length === 0 && nestedSkillMds.length === EXPECTED_SKILLS.length, missing.length ? `缺失: ${missing.join(', ')}` : `实到 ${nestedSkillMds.length} 份`);
    check('run_cmd 指向 skill_agent_runner(纯 Skill 包规则)', typeof result.run_cmd === 'string' && (result.run_cmd as string).includes('skill_agent_runner.py'), `run_cmd=${result.run_cmd || '(空)'}`);
    const files = Object.keys(result.keyFiles).map((p) => ({
      name: path.basename(p),
      path: p,
      dir: path.dirname(p) === '.' ? '/' : path.dirname(p),
      isDir: false,
    }));
    const engine = new ClaudeCodeEngine();
    const matches = engine.detect(files as any);
    const cc = matches.find((m: any) => m.engine === 'claude_code');
    check('ClaudeCodeEngine.detect 命中(claude_code, confidence ≥ 0.7)', !!cc && ((cc as any).confidence ?? 0) >= 0.7, cc ? `confidence=${(cc as any).confidence} matched=${(cc as any).matchedFiles.length} 份 SKILL.md` : '未命中');
    const firstSkill = foundSkills[0];
    check('字母序第一份嵌套 SKILL.md 是路由技能 short-drama(coreFile 落点正确)', firstSkill === 'short-drama', `实际第一份=${firstSkill}`);
    console.log('\n=== 上架时的运行期注意点(静态结论) ===\n');
    console.log('  ⚠️ 一键执行模式 preamble 会把 drama-skills 的生产确认门视为「默认确认」:');
    console.log('     上架时勿配 produce 端供应商 key(Seedance/MiniMax/GPT Image),');
    console.log('     或对该 agent 任务注入 HORIZON_DISABLE_ONE_CLICK=1。');
    console.log('  ⚠️ 兄弟技能注册方式(CLAUDE_SKILL_DIR 单目录 vs ~/.claude/skills 多链接)');
    console.log('     静态代码无法确证,需在沙箱测试里实测 $short-drama-write 等跨技能路由。');
    console.log('  ℹ️ 上游为 MIT 协议,商用/修改允许,保留 LICENSE 即可。');
    const allPass = checks.every((c) => c.pass);
    console.log(`\n=== ${allPass ? '✅ 全部通过' : '❌ 有失败项'}(${checks.filter((c) => c.pass).length}/${checks.length})· 耗时 ${elapsed}s ===\n`);
    process.exit(allPass ? 0 : 1);
  } catch (e: any) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`\n❌ 分析失败(${elapsed}s): ${e?.message || e}`);
    console.error('   提示:先确认本机代理(127.0.0.1:7897)或镜像通道可用,');
    console.error('   排查顺序见 AGENTS.md「GitHub 拉取与加速通道」。');
    process.exit(1);
  }
}

main();

export {};
