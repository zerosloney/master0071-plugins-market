// check-loop-rev-fixture.mjs — --rev 套件共享夹具（2026-10-23 全量套件优化：单文件拆三片并行）
// 只放夹具/常量/helper，不放断言；三个 *.test.mjs 各自 import，互不共享运行态。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export { HERE };
// 插件化落位（2026-10-27 迁移）：测试在 test/，引擎脚本与配置模板在插件的 scripts/ 与 config-templates/。
export const SCRIPTS = path.join(HERE, '..', 'scripts');
export const LOOP = path.join(SCRIPTS, 'check-loop.mjs');
export const ENUMS = path.join(HERE, '..', 'config-templates', 'workflow-enums.txt');
export const HOOK = path.join(HERE, 'fixtures', 'githooks', 'pre-push');
export const git = process.platform === 'win32' ? 'git.exe' : 'git';
export const Z = '0'.repeat(40);

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};

export function gitRun(cwd, args) {
  const r = spawnSync(git, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`${args.join(' ')}\n${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

export function loop(cwd, args = [], env = {}) {
  return spawnSync(process.execPath, [LOOP, ...args], {
    cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ...env },
  });
}
export const outOf = (r) => `${r.stdout || ''}${r.stderr || ''}`;

export const intent = `---
状态: approved
级别: L1
日期: 2026-09-01
模块: pipeline
---
# INTENT — ok

## 验收标准（可测试）

- [x] 配了 plan（证据：同名 plan）
`;
export const plan = `---
状态: approved
级别: L1
日期: 2026-09-01
模块: pipeline
---
# PLAN — ok

## 改动面

- 无
`;
export const planBad = `---
状态: approved
级别: L1
日期: 2026-09-01
模块: pipeline
---
# PLAN — bad

## 改动面

- [x] 改公共接口签名 → 级别至少 L2
`;

// mkRepo：good / bad / tip 三提交的临时仓（--rev 语义套件共用）。
export function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-repo-'));
  const planPath = path.join(root, 'workflow', 'plans', '2026-09-01-ok.md');
  gitRun(root, ['init', '-q']);
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.copyFileSync(ENUMS, path.join(root, '.agents', 'config', 'workflow-enums.txt'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-01-ok.md'), intent);
  fs.writeFileSync(planPath, plan);
  gitRun(root, ['add', '--', '.']);
  gitRun(root, ['commit', '-q', '-m', 'good']);
  const good = gitRun(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(planPath, planBad);
  gitRun(root, ['add', '--', '.']);
  gitRun(root, ['commit', '-q', '-m', 'bad']);
  const bad = gitRun(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(planPath, plan);
  gitRun(root, ['add', '--', '.']);
  gitRun(root, ['commit', '-q', '-m', 'tip']);
  const tip = gitRun(root, ['rev-parse', 'HEAD']);
  return { root, good, bad, tip, planPath };
}

// cleanup：先摘 worktree，再删目录（Windows 文件锁容忍）。
export function cleanup(dir) {
  const listed = spawnSync(git, ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  for (const line of (listed.stdout || '').split('\n')) {
    const m = line.startsWith('worktree ') ? line.slice(9).trim() : '';
    if (m && path.resolve(m) !== path.resolve(dir)) spawnSync(git, ['worktree', 'remove', '--force', m], { cwd: dir });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
