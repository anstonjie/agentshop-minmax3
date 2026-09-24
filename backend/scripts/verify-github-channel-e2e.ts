// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '../src/common/config/config.service';
import { GithubChannelPolicy } from '../src/common/github-channel/github-channel.policy';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const cfg = new ConfigService();
  const p = new GithubChannelPolicy(cfg);
  const repo = 'https://github.com/hugohe3/ppt-master.git';
  const branch = 'main';
  const dest = path.join(os.tmpdir(), 'gh-channel-e2e-' + Date.now());
  console.log('=== 1. clone 链(与 repo-sync.gitCloneWithMirror 相同的参数形状)===');
  const attempts = await p.cloneAttempts(repo);
  let cloned = false;
  for (const a of attempts) {
    try {
      await execFileAsync('git', [...(a as any).gitArgs, 'clone', '--depth=1', '-b', branch, (a as any).url, dest], { timeout: 180_000 });
      console.log(`  ✓ 成功  通道=${(a as any).label}`);
      console.log(`    url=${(a as any).url}`);
      console.log(`    gitArgs=${JSON.stringify((a as any).gitArgs)}`);
      cloned = true;
      break;
    } catch (e: any) {
      console.log(`  ✗ 失败  通道=${(a as any).label}  ${String(e?.message).slice(0, 90)}`);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    }
  }
  if (!cloned) {
    console.error('✗ 全链失败');
    process.exit(1);
  }
  const local = String((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dest })).stdout).trim();
  console.log(`  本地 HEAD = ${local.slice(0, 8)}`);
  console.log('\n=== 2. 上游权威 sha(与 repo-sync.lsRemote 相同的优先级)===');
  const parsed = p.parseGithubUrl(repo);
  const tip = await p.branchTip(parsed.owner, parsed.repo, branch);
  console.log(`  api.github.com = ${tip ? tip.slice(0, 8) : 'null'}`);
  console.log(`  isFreshHead    = ${await p.isFreshHead(repo, local)}`);
  console.log('\n=== 3. 归档链真下载(验证 archive=false 的镜像确实被跳过)===');
  const urls = await p.archiveUrls('anthropics', 'skills', 'main');
  console.log('  候选:', urls.map((u: string) => u.split('/')[2]).join(' -> '));
  const out = path.join(os.tmpdir(), 'gh-channel-e2e.tar.gz');
  const alive = await p.proxyAlive();
  const proxyArg = alive
    ? ['-x', 'http://' + (cfg as any).runtime.github.local_proxy.endpoint]
    : [];
  for (const u of urls) {
    try {
      const r = await execFileAsync('curl', [...proxyArg, '-sL', '--max-time', '90', '-o', out, '-w', '%{http_code} %{size_download}', u], { timeout: 120_000 });
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      console.log(`  ${u.split('/')[2]}${alive && u.includes('github.com') ? ' (走代理)' : ''}: ${String(r.stdout).trim()}  落地=${size}B`);
      if (size > 3_000_000) {
        console.log('  ✓ 归档完整');
        break;
      }
    } catch (e: any) {
      console.log(`  ${u.split('/')[2]}: 失败 ${String(e?.message).slice(0, 70)}`);
    }
  }
  fs.rmSync(dest, { recursive: true, force: true });
  if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  console.log('\n临时产物已清理');
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });

export {};
