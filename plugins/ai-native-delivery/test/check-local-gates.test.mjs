// check-local-gates.test.mjs — 门卫上岗自检：配置齐全放行 / 缺 hooksPath 阻断 / 插件形态判据切换（黑盒夹具仓）
// 2026-10-27 插件化修复：判据按部署形态分两套（源仓形态 core.hooksPath+.githooks 五钩子；插件形态
//   git 实际会执行的 pre-commit / pre-push 两执法点）。回归护栏：插件形态下输出绝不可出现
//   「设 core.hooksPath」指引——该设置会整体接管 git 钩子查找，使 init-engine 装好的钩子静默失效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-local-gates.mjs', import.meta.url)); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/
const gitBin = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
const git = (cwd, args) => spawnSync(gitBin, args, { cwd, encoding: 'utf8' });
const jsonlDriver = 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B';

const mkRepo = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-gates-test-'));
  git(tmp, ['init', '-q']);
  return tmp;
};

// 源仓形态夹具：.githooks 五钩子 + .gitattributes + 三条 git config + 项目侧引擎脚本副本标记
const tmp = mkRepo();
try {
  check('S0 临时仓 init', git(tmp, ['init', '-q']).status === 0);
  fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
    fs.writeFileSync(path.join(tmp, '.githooks', h), '', 'utf8');
  }
  fs.mkdirSync(path.join(tmp, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.agents', 'scripts', 'check-loop.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(tmp, '.gitattributes'), [
    'backend/shared/App.Api/appsettings.json merge=ours', // 脱敏泛化（2026-10-27）：appsettings 路径按使用项目替换
    '.agents/*.jsonl merge=jsonl-union',
    '',
  ].join('\n'), 'utf8');
  git(tmp, ['config', 'core.hooksPath', '.githooks']);
  git(tmp, ['config', 'merge.ours.driver', 'true']);
  git(tmp, ['config', 'merge.jsonl-union.driver', jsonlDriver]);

  const ok = run(tmp);
  check('S1 源仓形态配置齐全 → exit 0 且打印 PASS', ok.status === 0 && /\[PASS\]/.test(ok.stdout), ok.stdout.slice(-200) + ok.stderr.slice(-200));

  git(tmp, ['config', '--unset', 'core.hooksPath']);
  const missing = run(tmp);
  check('S2 源仓形态缺 hooksPath → exit 1 且点名修复命令',
    missing.status === 1 && /core\.hooksPath/.test(missing.stdout) && /git config core\.hooksPath \.githooks/.test(missing.stdout),
    missing.stdout.slice(-300));

  git(tmp, ['config', 'core.hooksPath', '.githooks']);
  fs.rmSync(path.join(tmp, '.githooks', 'pre-push'));
  const missingHook = run(tmp);
  check('S3 源仓形态钩子文件缺失 → exit 1 且点名文件', missingHook.status === 1 && /pre-push/.test(missingHook.stdout),
    missingHook.stdout.slice(-300));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 插件形态夹具：无项目侧脚本副本；钩子装在 git 默认钩子目录（init-engine 的安装面）
const tmp2 = mkRepo();
try {
  const hooksDir = path.join(tmp2, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const h of ['pre-commit', 'pre-push']) fs.writeFileSync(path.join(hooksDir, h), '', 'utf8');

  const ok2 = run(tmp2);
  check('S4 插件形态钩子在位 → exit 0 且判据为两执法点',
    ok2.status === 0 && /钩子在位（pre-commit \/ pre-push）/.test(ok2.stdout),
    ok2.stdout.slice(-300) + ok2.stderr.slice(-200));
  check('S4 插件形态输出绝不含「设 core.hooksPath」指引（自伤回归护栏）',
    !/git config core\.hooksPath \.githooks/.test(ok2.stdout),
    ok2.stdout.slice(-400));

  fs.rmSync(path.join(hooksDir, 'pre-commit'));
  const bad2 = run(tmp2);
  check('S5 插件形态钩子缺失 → exit 1 且点名 pre-commit + 修复指向 init-engine',
    bad2.status === 1 && /pre-commit/.test(bad2.stdout) && /init-engine\.mjs/.test(bad2.stdout),
    bad2.stdout.slice(-400));
  check('S5 插件形态钩子缺失时绝不含「设 core.hooksPath」指引（自伤回归护栏）',
    !/git config core\.hooksPath \.githooks/.test(bad2.stdout),
    bad2.stdout.slice(-400));
} finally {
  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
