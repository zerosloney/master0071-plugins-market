// git-core.test.mjs — 引擎 git 调用单源：记忆化 / 失败降级 / 注入替身 / 缓存失效
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnGit, gitOut, clearGitCache } from '../scripts/git-core.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const gitBin = process.platform === 'win32' ? 'git.exe' : 'git';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-core-test-'));
const repo = path.join(tmp, 'repo');
const nonRepo = path.join(tmp, 'not-a-repo');
fs.mkdirSync(repo);
fs.mkdirSync(nonRepo);
const git = (args, cwd = repo) => spawnSync(gitBin, args, { cwd, encoding: 'utf8' });

try {
  check('S0 临时仓 init', git(['init', '-q']).status === 0);
  git(['config', 'user.email', 'git-core-test@example.com']);
  git(['config', 'user.name', 'git-core-test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n', 'utf8');
  git(['add', 'a.txt']);
  const commit = git(['commit', '-q', '-m', 'init']);
  check('S1 临时仓首次提交', commit.status === 0, commit.stderr);

  clearGitCache();
  const r1 = spawnGit(['rev-parse', '--is-inside-work-tree'], repo);
  check('S2 spawnGit 成功并返回 stdout', r1.status === 0 && r1.stdout.trim() === 'true',
    JSON.stringify({ status: r1.status, stdout: r1.stdout, code: r1.error && r1.error.code }));

  const r2 = spawnGit(['rev-parse', '--is-inside-work-tree'], repo);
  check('S3 同参查询命中记忆化（同一结果对象）', r1 === r2);

  const head = gitOut(['rev-parse', 'HEAD'], repo);
  check('S4 gitOut 成功返回完整 SHA', typeof head === 'string' && head.trim().length === 40, head);

  check('S5 gitOut 命令失败返回 null', gitOut(['rev-parse', '--verify', 'no-such-ref'], repo) === null);

  clearGitCache();
  const r3 = spawnGit(['rev-parse', 'HEAD'], repo);
  check('S6 clearGitCache 后重新取数（新对象、同值）', r3 !== r2 && r3.status === 0 && r3.stdout === head);

  const r4 = spawnGit(['rev-parse', '--is-inside-work-tree'], nonRepo);
  check('S7 非 git 仓 status≠0 且无 spawn error', r4.status !== 0 && !r4.error,
    JSON.stringify({ status: r4.status, code: r4.error && r4.error.code }));

  const prevGit = process.env.CHECK_LOOP_GIT;
  process.env.CHECK_LOOP_GIT = path.join(tmp, 'missing-git.exe');
  const errs = [];
  const origError = console.error;
  console.error = (...args) => errs.push(args.join(' '));
  try {
    const injected = await import('../scripts/git-core.mjs?inject=1');
    const bad = injected.spawnGit(['status'], repo);
    check('S8 注入不存在的 git → spawn error 上抛', Boolean(bad.error) && bad.error.code === 'ENOENT',
      JSON.stringify(bad.error && bad.error.code));
    check('S9 基础设施失败 → gitOut 返回 null', injected.gitOut(['status'], repo) === null);
    check('S10 基础设施异常响亮出账恰一条', errs.length === 1 && errs[0].includes('git-core'), JSON.stringify(errs));
    const again = injected.spawnGit(['status'], repo);
    check('S11 失败结果不缓存（再次调用仍复跑）', again !== bad && Boolean(again.error));
  } finally {
    console.error = origError;
    if (prevGit === undefined) delete process.env.CHECK_LOOP_GIT;
    else process.env.CHECK_LOOP_GIT = prevGit;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 超时上界（2026-11-05 Minor：spawnGit 无 timeout——一次挂起的 git 挂死所有门禁）──
// 先例：worktree-ops runGitProcess（DEFAULT_GIT_TIMEOUT_MS + killSignal + 可读超时错误）。
// Windows 无可移植的假 git 可执行件（worktree-ops test/timeout.mjs 同结论）——用「可控的慢命令」：
// CHECK_LOOP_GIT 注入 node.exe 本体，cwd 放名为 status 的脚本文件（睡 60s），spawnGit(['status']) 即执行它。
// 看门狗：外层 spawnSync 自带 timeout（15s）强杀挂起的测试子进程防套件挂死——修复前子进程挂在
// 无 timeout 的 spawnGit 上被看门狗击杀（RED）；修复后 CHECK_LOOP_GIT_TIMEOUT_MS=300 先到 → 快速回报 ETIMEDOUT（GREEN）。
{
  const { GIT_TIMEOUT_MS } = await import('../scripts/git-core.mjs'); // 动态取：修复前模块无此导出（整文件不因静态 import 崩）
  check('S12 git 子进程默认超时上界 = 60s（具名常量）', GIT_TIMEOUT_MS === 60000, String(GIT_TIMEOUT_MS));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'git-core-timeout-'));
  const slowDir = path.join(sandbox, 'slow-git');
  fs.mkdirSync(slowDir, { recursive: true });
  fs.writeFileSync(path.join(slowDir, 'status'), 'setTimeout(() => {}, 60000);\n', 'utf8');
  const coreUrl = new URL('../scripts/git-core.mjs', import.meta.url).href;
  const childFile = path.join(sandbox, 'slow-git-child.mjs');
  fs.writeFileSync(childFile, [
    `import { spawnGit } from ${JSON.stringify(coreUrl)};`,
    'const t0 = Date.now();',
    "const r = spawnGit(['status'], process.cwd());",
    "console.log('RESULT ' + JSON.stringify({ code: r.error && r.error.code, killed: r.error && r.error.killed, signal: r.signal, status: r.status, ms: Date.now() - t0 }));",
  ].join('\n'), 'utf8');
  const wd = spawnSync(process.execPath, [childFile], {
    cwd: slowDir,
    encoding: 'utf8',
    timeout: 15000, // 看门狗（修复前子进程挂死，此处强杀 → RED）
    env: { ...process.env, CHECK_LOOP_GIT: process.execPath, CHECK_LOOP_GIT_TIMEOUT_MS: '300' },
  });
  const m = /RESULT (.+)/.exec(wd.stdout || '');
  const res = m ? JSON.parse(m[1]) : null;
  check('S13 看门狗内子进程自行返回（挂起的 git 不再挂死门禁——修复前被看门狗击杀）',
    wd.status === 0 && res !== null, `wd.status=${wd.status} out=${(wd.stdout || '').slice(0, 200)} err=${(wd.stderr || '').slice(0, 200)}`);
  check('S14 慢 git 被超时中止（ETIMEDOUT、SIGKILL、无退出码）',
    res !== null && res.code === 'ETIMEDOUT' && res.status === null && res.signal === 'SIGKILL', JSON.stringify(res));
  check('S15 超时快速返回（≈注入的 300ms 上限，远小于慢命令 60s）', res !== null && res.ms < 20000, JSON.stringify(res));
  check('S16 超时翻译为可读告警（stderr 响亮出账）', (wd.stderr || '').includes('git-core') && (wd.stderr || '').includes('超时'),
    (wd.stderr || '').slice(0, 200));
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
