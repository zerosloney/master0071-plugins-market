// check-local-gates.test.mjs — 门卫上岗自检：配置齐全放行 / 缺 hooksPath 阻断（黑盒夹具仓）
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-gates-test-'));
try {
  check('S0 临时仓 init', git(tmp, ['init', '-q']).status === 0);
  fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
    fs.writeFileSync(path.join(tmp, '.githooks', h), '', 'utf8');
  }
  fs.writeFileSync(path.join(tmp, '.gitattributes'), [
    'backend/shared/App.Api/appsettings.json merge=ours', // 脱敏泛化（2026-10-27）：appsettings 路径按使用项目替换
    '.agents/*.jsonl merge=jsonl-union',
    '',
  ].join('\n'), 'utf8');
  git(tmp, ['config', 'core.hooksPath', '.githooks']);
  git(tmp, ['config', 'merge.ours.driver', 'true']);
  git(tmp, ['config', 'merge.jsonl-union.driver', jsonlDriver]);

  const ok = run(tmp);
  check('S1 配置齐全 → exit 0 且打印 PASS', ok.status === 0 && /\[PASS\]/.test(ok.stdout), ok.stdout.slice(-200) + ok.stderr.slice(-200));

  git(tmp, ['config', '--unset', 'core.hooksPath']);
  const missing = run(tmp);
  check('S2 缺 hooksPath → exit 1 且点名修复命令',
    missing.status === 1 && /core\.hooksPath/.test(missing.stdout) && /git config core\.hooksPath \.githooks/.test(missing.stdout),
    missing.stdout.slice(-300));

  git(tmp, ['config', 'core.hooksPath', '.githooks']);
  fs.rmSync(path.join(tmp, '.githooks', 'pre-push'));
  const missingHook = run(tmp);
  check('S3 钩子文件缺失 → exit 1 且点名文件', missingHook.status === 1 && /pre-push/.test(missingHook.stdout),
    missingHook.stdout.slice(-300));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
