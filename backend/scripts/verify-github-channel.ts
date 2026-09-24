// 2026-09-24:从 dist 构建产物忠实还原(误删后恢复,逻辑与编译输出一致)。
import { ConfigService } from '../src/common/config/config.service';
import { GithubChannelPolicy } from '../src/common/github-channel/github-channel.policy';

async function main(): Promise<void> {
  const cfg = new ConfigService();
  const gh = (cfg as any).runtime.github;
  console.log('runtime.github 段存在      :', !!gh);
  if (!gh) {
    console.error('✗ 配置没读到,策略会静默用内置默认值 —— 这就是接线断了');
    process.exit(1);
  }
  console.log('endpoint(经 ${VAR:-} 插值) :', gh.local_proxy.endpoint);
  console.log('  ↳ 必须是 host:port,不能还剩 ${...} 字面量');
  console.log('mirrors                    :', gh.mirrors.map((m: any) => m.id + (m.archive ? '' : '(no-archive)')).join(', '));
  console.log('file_cdns 条数             :', gh.file_cdns.length);
  console.log('verified_at                :', gh.verified_at);
  const p = new GithubChannelPolicy(cfg);
  const repo = 'https://github.com/anthropics/skills.git';
  console.log('\n--- 通道链(按当前网络实况) ---');
  console.log('代理存活      :', await p.proxyAlive());
  console.log('clone 链      :', (await p.cloneAttempts(repo)).map((a: any) => a.label).join(' -> '));
  console.log('archive 链    :', (await p.archiveUrls('anthropics', 'skills', 'main')).join('  |  '));
  console.log('file 链(前3)  :', (await p.fileUrls('anthropics', 'skills', 'main', 'README.md')).slice(0, 3).join('  |  '));
  console.log('\n--- 权威 sha 与新鲜度判定 ---');
  const tip = await p.branchTip('anthropics', 'skills', 'main');
  console.log('api 权威 sha  :', tip);
  console.log('正确 sha 判定 :', await p.isFreshHead(repo, String(tip)));
  const stale = '3b3fad96af16a10759d930941b4520ba0c40edae';
  console.log('旧 sha 判定   :', await p.isFreshHead(repo, stale), '(期望 false)');
  console.log('不存在仓库    :', await p.isFreshHead('https://github.com/o/nope-xyz-42', 'deadbeef'), '(无法判定→不阻断,期望 true)');
}

main().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});

export {};
