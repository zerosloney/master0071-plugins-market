#!/usr/bin/env node
// check-scripts-syntax.mjs 的夹具测试（CHECK_LOOP_ROOT 注入临时根 + 显式目录参数，不触真实 .agents）
// 断言：①全绿目录 exit 0 且报数；②混入语法坏件 exit 1 且点名坏文件；③目录缺失 exit 1（fail-closed）；
// ④空目录（递归后无可检文件）exit 1（防「清空目录即去门」）；⑤非 .mjs/.cjs 扩展名不入扫描；
// ⑥子目录内的脚本被递归扫描（2026-10-24 复核 M1：顶层 0 文件曾静默空转）；
// ⑦目录只含空子目录 → exit 1（防「把文件挪走/改布局即去门」）。
// 用法：node .agents/scripts/check-scripts-syntax.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(SCRIPT_DIR, '..', 'scripts', 'check-scripts-syntax.mjs'); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'syn-fix-'));
const run = (root, argv) => spawnSync(process.execPath, [CHECKER, ...argv], {
  encoding: 'utf8',
  env: { ...process.env, CHECK_LOOP_ROOT: root },
});

// ---- 场景 1：全绿目录 → exit 0 且报数 2（txt 不入扫描） ----
{
  const root = mkroot();
  fs.mkdirSync(path.join(root, 'sd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sd', 'good.mjs'), 'const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sd', 'good.cjs'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sd', 'note.txt'), 'not scanned\n', 'utf8');
  const r = run(root, ['sd']);
  check('场景 1：全绿 → exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  check('场景 1：报数 2 且 txt 被排除', r.stdout.includes('✅ 2 个引擎脚本'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2：语法坏件 → exit 1 且点名 ----
{
  const root = mkroot();
  fs.mkdirSync(path.join(root, 'sd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sd', 'good.mjs'), 'const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sd', 'broken.mjs'), 'if (true) entry.x process.env.Y;\n', 'utf8');
  const r = run(root, ['sd']);
  check('场景 2：混入坏件 → exit 1', r.status === 1, `exit=${r.status}`);
  check('场景 2：stderr 点名坏文件', r.stderr.includes('sd/broken.mjs') && r.stderr.includes('1 个不可解析'), r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：目录缺失 → exit 1（fail-closed） ----
{
  const root = mkroot();
  const r = run(root, ['no-such-dir']);
  check('场景 3：目录缺失 → exit 1 且提示 fail-closed', r.status === 1 && r.stderr.includes('检查目标目录缺失'), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：空目录 → exit 1（递归后无可检文件即拒放行） ----
{
  const root = mkroot();
  fs.mkdirSync(path.join(root, 'sd'), { recursive: true });
  const r = run(root, ['sd']);
  check('场景 4：空目录 → exit 1 且提示无可检脚本', r.status === 1 && r.stderr.includes('递归后无可检脚本'), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6：子目录脚本被递归扫描（顶层 0 文件不得静默空转） ----
{
  const root = mkroot();
  fs.mkdirSync(path.join(root, 'sd', 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sd', 'sub', 'deep', 'a.mjs'), 'const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sd', 'sub', 'b.cjs'), 'module.exports = 2;\n', 'utf8');
  const r = run(root, ['sd']);
  check('场景 6：递归扫描到子目录 2 文件 → exit 0', r.status === 0 && r.stdout.includes('✅ 2 个引擎脚本'), `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7：目录只含空子目录 → exit 1 ----
{
  const root = mkroot();
  fs.mkdirSync(path.join(root, 'sd', 'sub'), { recursive: true });
  const r = run(root, ['sd']);
  check('场景 7：仅空子目录 → exit 1', r.status === 1 && r.stderr.includes('递归后无可检脚本'), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 8：真实默认目录集（DEFAULT_DIRS）每个都必须有可检脚本 ----
{
  const r = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' });
  check('场景 8：默认目录集 exit 0 且总数 > 0', r.status === 0 && /✅ (\d+) 个引擎脚本/.test(r.stdout) && Number(/✅ (\d+) 个引擎脚本/.exec(r.stdout)[1]) > 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
