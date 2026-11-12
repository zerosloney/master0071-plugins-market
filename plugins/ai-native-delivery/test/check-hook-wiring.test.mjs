#!/usr/bin/env node
// check-hook-wiring.test.mjs — 接线宣称对账的 fixture 测试（2026-11-12 判据移植配套）
// 注缝：HOOK_WIRING_ROOT 环境变量 / run(root)——夹具根 = 从真实插件树拷贝数据面（三垫片、
// hooks.json、pretool-risk.mjs、pre-write-guard.mjs、mcp/server.mjs、mcp.json、registry），脚本本体跑真实文件不落盘。
// 断言：①干净夹具 exit 0（7 项宣称全符）；②run() 导出缝同判据（空问题表）；③篡改 hooks.json 删
//      PreToolUse 段 → 红（zcode 指针实态 + codex 内联失对 双腿点名）；④篡改 omp 垫片加 hooks 键
//      → 红（宣称「无」失实）；⑤删 registry → 红（CLAIMS 指回断链）；⑥写前门段窄化 matcher → 红
//      （写前门腿点名）；⑦删 pre-write-guard.mjs → 红（接线指向空）。
// 用法：node test/check-hook-wiring.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/check-hook-wiring.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(TEST_DIR, '..');
const SCRIPT = path.join(PLUGIN, 'scripts', 'check-hook-wiring.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${desc}`); }
  else { fail += 1; console.log(`FAIL  ${desc}\n${detail}`); }
};

// 数据面拷贝清单（脚本读取面；脚本体与测试不进夹具）
const FIXTURE_FILES = [
  '.zcode-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.omp-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/pretool-risk.mjs',
  'hooks/pre-write-guard.mjs',
  'mcp/server.mjs',
  'mcp.json',
  'config-templates/mechanism-registry.md',
];

const mkFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-wiring-'));
  for (const rel of FIXTURE_FILES) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(PLUGIN, rel), dst);
  }
  return root;
};
const cli = (root) => spawnSync(process.execPath, [SCRIPT], {
  encoding: 'utf8',
  env: { ...process.env, HOOK_WIRING_ROOT: root },
});
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const writeJson = (root, rel, obj) => fs.writeFileSync(path.join(root, rel), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');

// ① 干净夹具 → exit 0；② run() 导出缝同判据
{
  const root = mkFixture();
  const r = cli(root);
  check('① 干净夹具 CLI exit 0 且报 7 项宣称全符',
    r.status === 0 && /7 项宣称与实态一致/.test(r.stdout), `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  const problems = run(root);
  check('② run(root) 导出缝：干净夹具空问题表', Array.isArray(problems) && problems.length === 0, JSON.stringify(problems));
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 篡改 hooks.json 删 PreToolUse 段 → 红：zcode 实态腿 + codex 内联失双腿点名
{
  const root = mkFixture();
  const j = readJson(root, 'hooks/hooks.json');
  delete j.hooks.PreToolUse;
  writeJson(root, 'hooks/hooks.json', j);
  const r = cli(root);
  check('③ hooks.json 删段 → exit 1',
    r.status === 1, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  check('③ zcode 腿点名（hooks.json 缺 PreToolUse 段）', /\.zcode-plugin\/plugin\.json/.test(r.stderr) && /缺 hooks\.PreToolUse 段/.test(r.stderr), r.stderr);
  check('③ codex 腿点名（内联段与 hooks.json 不一致）', /\.codex-plugin\/plugin\.json/.test(r.stderr) && /逐字段不一致/.test(r.stderr), r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ④ 篡改 omp 垫片加 hooks 键 → 红（CLAIMS 宣称「无」失实）
{
  const root = mkFixture();
  const o = readJson(root, '.omp-plugin/plugin.json');
  o.hooks = './hooks';
  writeJson(root, '.omp-plugin/plugin.json', o);
  const r = cli(root);
  check('④ omp 垫片加 hooks 键 → exit 1 且点名宣称「无」失实',
    r.status === 1 && /\.omp-plugin\/plugin\.json/.test(r.stderr) && /宣称「无」/.test(r.stderr),
    `exit=${r.status} stderr=${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑤ 删 registry → 红（CLAIMS 指回断链）
{
  const root = mkFixture();
  fs.rmSync(path.join(root, 'config-templates', 'mechanism-registry.md'));
  const r = cli(root);
  check('⑤ registry 缺席 → exit 1 且点名指回断链',
    r.status === 1 && /mechanism-registry/.test(r.stderr) && /指回断链/.test(r.stderr),
    `exit=${r.status} stderr=${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑥ 写前门段 matcher 窄化（只 Write，丢 Edit/Update/NotebookEdit）→ 红（写前门腿点名窄写法）
{
  const root = mkFixture();
  const j = readJson(root, 'hooks/hooks.json');
  const seg = j.hooks.PreToolUse.find((e) => JSON.stringify(e.hooks).includes('pre-write-guard.mjs'));
  seg.matcher = '[wW][rR][iI][tT][eE]';
  writeJson(root, 'hooks/hooks.json', j);
  const r = cli(root);
  check('⑥ 写前门 matcher 窄化 → exit 1 且点名窄写法',
    r.status === 1 && /窄写法/.test(r.stderr) && /pre-write-guard\.mjs/.test(r.stderr),
    `exit=${r.status} stderr=${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑦ 删 hooks/pre-write-guard.mjs 本体 → 红（接线指向空；垫片未同步另由 codex 腿点名）
{
  const root = mkFixture();
  fs.rmSync(path.join(root, 'hooks', 'pre-write-guard.mjs'));
  const r = cli(root);
  check('⑦ pre-write-guard.mjs 缺席 → exit 1 且点名接线指向空',
    r.status === 1 && /pre-write-guard\.mjs 文件不存在/.test(r.stderr),
    `exit=${r.status} stderr=${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
