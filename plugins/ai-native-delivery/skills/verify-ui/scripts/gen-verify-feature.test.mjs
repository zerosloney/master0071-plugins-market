#!/usr/bin/env node
// gen-verify-feature.test.mjs — 特性地图生成器套件（2026-10-22 pstack create-verification-skill 借鉴）
// 覆盖：覆盖缺口 / --check / --route 生成骨架 / 已覆盖拒绝 / 未知路由 exit 2 / --json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gen-verify-feature.mjs');
let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-feature-'));
git(root, ['init', '-q']);
git(root, ['config', 'user.email', 't@t']);
git(root, ['config', 'user.name', 't']);
fs.mkdirSync(path.join(root, 'frontend', 'src', 'router'), { recursive: true });
fs.writeFileSync(path.join(root, 'frontend', 'src', 'router', 'index.ts'), [
  "const routes = [",
  "  { path: '/login' },",
  "  { path: 'purchase-orders' },",
  "  { path: 'suppliers' },",
  "  { path: 'mto-orders/:id' },",
  '];',
].join('\n'), 'utf8');
fs.mkdirSync(path.join(root, '.agents', 'skills', 'verify-ui', 'features'), { recursive: true });
fs.writeFileSync(path.join(root, '.agents', 'skills', 'verify-ui', 'features', 'purchase-orders.md'), '# 特性\n\n到达路径 `#/purchase-orders`\n', 'utf8');

{
  const r = run(root, ['--check']);
  check('T1 --check 有缺口 → exit 1 且点名 /suppliers', r.code === 1 && r.out.includes('/suppliers') && !r.out.includes('/purchase-orders'), r.out);
}
{
  const r = run(root, ['--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 断言里报 */ }
  check('T2 --json 可解析且缺口正确', r.code === 0 && j && j.uncovered.includes('/suppliers') && !j.uncovered.includes('/purchase-orders'), r.out);
}
{
  const r = run(root, ['--route', '/suppliers']);
  const file = path.join(root, '.agents', 'skills', 'verify-ui', 'features', 'suppliers.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check('T3 --route 生成骨架（四段 H2 + 路由）',
    r.code === 0 && text.includes('## 到达路径') && text.includes('## 驱动') && text.includes('## 可观察终态') && text.includes('## Gotchas') && text.includes('#/suppliers'),
    text);
}
{
  const r = run(root, ['--route', '/purchase-orders']);
  check('T4 已覆盖路由 → exit 1 拒绝新建', r.code === 1 && r.out.includes('已被特性地图覆盖'), r.out);
}
{
  const r = run(root, ['--route', '/missing']);
  check('T5 未知路由 → exit 2', r.code === 2 && r.out.includes('不在 router'), r.out);
}
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
