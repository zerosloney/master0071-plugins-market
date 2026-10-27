#!/usr/bin/env node
// check-pr-size.test.mjs — PR 体积预算黑盒套件（2026-10-22 pstack 借鉴）
// 夹具：单个临时 git 仓复用（2026-10-23 全量套件优化：8 次 git init → 1 次；每例 reset 回 base）。
// 覆盖：通过 / 文件超限 / 行数超限 / 免费文件剔除 / PR_SIZE_OK 覆盖 / --json / 基线缺失 / rename 免费。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 插件化落位（2026-10-27 迁移）：被测脚本在 ../scripts/（原与测试同目录的源仓形态）
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-pr-size.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-size-'));
git(root, ['init', '-q']);
git(root, ['config', 'user.email', 't@t']);
git(root, ['config', 'user.name', 't']);
fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
fs.writeFileSync(path.join(root, '.agents', 'config', 'pr-budget.json'), JSON.stringify({ maxFiles: 20, maxLines: 800 }), 'utf8');
fs.writeFileSync(path.join(root, 'README.md'), 'base\n', 'utf8');
fs.writeFileSync(path.join(root, 'big.js'), lines(100), 'utf8');
git(root, ['add', '-A']);
git(root, ['commit', '-qm', 'base']);
const base = git(root, ['rev-parse', 'HEAD']).stdout.trim();

const setBudget = (b) => fs.writeFileSync(path.join(root, '.agents', 'config', 'pr-budget.json'), JSON.stringify(b), 'utf8');
const commit = (files, msg = 'change') => {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content, 'utf8');
  }
  git(root, ['add', ...Object.keys(files)]);
  git(root, ['commit', '-qm', msg]);
};
const reset = () => {
  git(root, ['reset', '--hard', base]);
  git(root, ['clean', '-fdq']);
};
const run = (args = [], env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// ---- T1 通过 ----
{
  setBudget({ maxFiles: 20, maxLines: 800 });
  commit({ 'src/a.js': lines(5), 'src/b.js': lines(5) });
  const r = run(['--base', base]);
  check('T1 2 文件 / 10 行 ≤ 预算 → exit 0 且「通过」', r.code === 0 && r.out.includes('通过'), JSON.stringify(r));
  reset();
}

// ---- T2 文件数超限 ----
{
  setBudget({ maxFiles: 1, maxLines: 800 });
  commit({ 'src/a.js': lines(1), 'src/b.js': lines(1) });
  const r = run(['--base', base]);
  check('T2 2 文件 > 1 → exit 1 且「超限」', r.code === 1 && r.out.includes('超限'), JSON.stringify(r));
  reset();
}

// ---- T3 行数超限 ----
{
  setBudget({ maxFiles: 20, maxLines: 5 });
  commit({ 'src/a.js': lines(10) });
  const r = run(['--base', base]);
  check('T3 10 行 > 5 → exit 1', r.code === 1 && r.out.includes('10 新增行'), JSON.stringify(r));
  reset();
}

// ---- T4 免费文件剔除（lockfile / dist / 生成物）----
{
  setBudget({ maxFiles: 1, maxLines: 5 });
  commit({
    'package-lock.json': lines(100),
    'dist/bundle.js': lines(100),
    'src/a.js': lines(2),
  });
  const r = run(['--base', base]);
  check('T4 lockfile + dist 免费 → 只算 1 文件 / 2 行 → exit 0', r.code === 0 && r.out.includes('1 文件 / 2 新增行'), JSON.stringify(r));
  reset();
}

// ---- T5 PR_SIZE_OK 覆盖 ----
{
  setBudget({ maxFiles: 1, maxLines: 800 });
  commit({ 'src/a.js': lines(1), 'src/b.js': lines(1) });
  const r = run(['--base', base], { PR_SIZE_OK: '1' });
  check('T5 超限 + PR_SIZE_OK=1 → exit 0 且「已覆盖」', r.code === 0 && r.out.includes('已覆盖'), JSON.stringify(r));
  reset();
}

// ---- T6 --json ----
{
  setBudget({ maxFiles: 1, maxLines: 800 });
  commit({ 'src/a.js': lines(1), 'src/b.js': lines(1) });
  const r = run(['--base', base, '--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 断言里报 */ }
  check('T6 --json 可解析且 over=true', r.code === 1 && j && j.over === true && j.files === 2, JSON.stringify(r));
  reset();
}

// ---- T7 基线缺失 ----
{
  const r = run(['--base', 'no-such-ref']);
  check('T7 基线不存在 → exit 2 fail-loud', r.code === 2 && r.out.includes('基线'), JSON.stringify(r));
}

// ---- T8 rename 免费（-M 检测，0 新增行）----
{
  setBudget({ maxFiles: 1, maxLines: 5 });
  git(root, ['mv', 'big.js', 'big2.js']);
  git(root, ['commit', '-qm', 'rename']);
  const r = run(['--base', base]);
  check('T8 纯 rename → 0 新增行、1 文件 ≤ 1 → exit 0', r.code === 0 && r.out.includes('0 新增行'), JSON.stringify(r));
  reset();
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
