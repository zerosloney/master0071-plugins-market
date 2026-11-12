#!/usr/bin/env node
// check-loop-rev-semantics.test.mjs — 合并提交增量面语义对拍探针（判据移植随附夹具套件）
// 方法：现场构造真 git 夹具仓——
//   ① 合并样本仓：双侧各加一文件后 --no-ff 合并（干净合并 `git show` 默认无文件面、first-parent 有）
//      → 探针「退化钉子」命中、PASS exit 0（实现若退化回 git show，钉子归零该仓必红）；
//   ② 无合并提交仓 → 探针跳过 exit 0（fail-open，小仓/快合并工作流不误伤）；
//   ③ 非 git 目录 → 探针跳过 exit 0（与 kit 主入口「不在仓库内跳过」同语义）。
// 用法：node test/check-loop-rev-semantics.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-loop-rev-semantics.mjs');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
const commitFile = (root, rel, content, msg) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
  g(root, ['add', '-A']);
  g(root, ['commit', '-qm', msg]);
};
const runProbe = (root, args = []) => spawnSync(process.execPath, [PROBE, ...args], { cwd: root, encoding: 'utf8' });

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// ---- ① 合并样本仓：钉子命中 → PASS ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-sem-'));
  g(root, ['init', '-q']);
  commitFile(root, 'a.txt', 'a\n', 'base');
  g(root, ['checkout', '-qb', 'feat']);
  commitFile(root, 'b.txt', 'b\n', 'feat side');
  g(root, ['checkout', '-q', '-']);
  commitFile(root, 'c.txt', 'c\n', 'main side');
  g(root, ['merge', '--no-ff', '-m', 'merge feat', 'feat']);
  // 夹具自检：干净合并 `git show` 无文件面（combined diff 空集）而 first-parent diff 非空——钉子前提成立
  const show = g(root, ['show', '--name-only', '--format=', '--no-renames', 'HEAD']).stdout.trim();
  const fp = g(root, ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD']).stdout.trim();
  check('夹具自检：干净合并 git show 空 / first-parent 非空（钉子前提）', show === '' && fp === 'b.txt', `show=[${show}] fp=[${fp}]`);
  const r = runProbe(root);
  check('① 合并样本仓：退化钉子命中 → PASS exit 0',
    r.status === 0 && r.stdout.includes('PASS') && /退化钉子命中 [1-9]/.test(r.stdout),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② 无合并提交仓 → 跳过 exit 0 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-sem-'));
  g(root, ['init', '-q']);
  commitFile(root, 'a.txt', 'a\n', 'only linear commits');
  const r = runProbe(root);
  check('② 无合并提交仓：跳过 exit 0（fail-open，不误伤线性史小仓）',
    r.status === 0 && r.stdout.includes('无合并提交样本'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 非 git 目录 → 跳过 exit 0 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-sem-'));
  const r = runProbe(root);
  check('③ 非 git 目录：跳过 exit 0（fail-open）',
    r.status === 0 && r.stdout.includes('不在 git 仓库内'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
