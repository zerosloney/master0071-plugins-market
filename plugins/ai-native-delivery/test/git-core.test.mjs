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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
