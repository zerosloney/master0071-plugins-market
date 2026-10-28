#!/usr/bin/env node
// check-scripts-syntax.mjs — 引擎脚本语法自检（node --check 全量扫描）
// 用途：守护者受守护——对 .agents/scripts 与 .agents/hooks 下全部 .mjs/.cjs 逐个 node --check，
//       任何文件不可解析即判红（先例教训：verify.mjs:31 SyntaxError 带病进 CI，全链门静默失效）。
// 语义与红线：只读裁决，不改任何状态；**任一**检查目录缺失、或该目录递归后一个可检文件都没有，
// 一律判红（fail-closed，防「改名/删除/清空脚本即去门」）；递归扫描（2026-10-24 复核 M1：
// 原实现只 readdirSync 顶层，`scripts/verify` 顶层 0 个 .mjs 时静默空转、总数不变无痕迹）；
// 不 import 任何引擎件，零依赖可独立调度。
// 性能（scripts-syntax-parallel）：node --check 无原地解析 ESM 的 API，只能逐文件起子进程
//       （单次 ~70ms × 117 文件）；改工作池并发（min(8, cpus-2)）后本机 8.1s → 4.2s，判红集合不变。
// 测试：node <插件根>/test/check-scripts-syntax.test.mjs
// 用法：node <插件根>/scripts/check-scripts-syntax.mjs [目录...]（相对仓库根；缺省 .agents/scripts .agents/hooks
//       scripts/verify——第三项为 backend 门执行器所在，2026-10-24 复核 P1 修复纳入守护；
//       CHECK_LOOP_ROOT 可覆写仓库根，与 check-loop/verify 同口径）
// 沿革：guardian-selfcheck（审计 P0-1 立项，verify.mjs GATES 首门消费）。
//       2026-10-27 插件化迁移：引擎脚本本体落插件 scripts/（paths.mjs 单源）——缺省守护面改为
//       「插件 scripts/ 恒守 + 项目侧三目录存在才守」（目录缺席=插件驱动项目常态，不再 fail-closed；
//       存在即守、清空即红的原语义按目录保留）。

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
// 路径收口（2026-10-27 插件化迁移改道 paths.mjs）：引擎脚本本体随插件分发，插件 scripts/ 恒入守护面。
import { PLUGIN_SCRIPTS_DIR, PLUGIN_ROOT, findProjectRoot } from './paths.mjs';

const SCRIPT_DIR = PLUGIN_SCRIPTS_DIR;
// 仓库根锚（2026-10-27 插件化迁移，与 verify.mjs 同口径）：CHECK_LOOP_ROOT 夹具注入 > git root > 插件根。
const ROOT = process.env.CHECK_LOOP_ROOT || findProjectRoot() || PLUGIN_ROOT;
// 守护面（2026-10-27 插件化迁移）：①插件内 scripts/（引擎脚本本体，缺失/清空仍 fail-closed——插件损坏
// 即去门）；②项目侧三目录（源仓形态自带的 .agents/scripts / .agents/hooks / scripts/verify）改为
// **存在才守护**——插件驱动项目不向项目复制脚本（paths.mjs 架构决策），目录缺席属常态不再判红；
// 但存在却被清空/改名仍 fail-closed（原「清空即去门」语义按目录保留）。
const PROJECT_DIRS = ['.agents/scripts', '.agents/hooks', 'scripts/verify'];
const defaultTargets = () => [
  { rel: '<插件>/scripts', abs: PLUGIN_SCRIPTS_DIR },
  ...PROJECT_DIRS.filter((d) => fs.existsSync(path.resolve(ROOT, d)))
    .map((d) => ({ rel: d, abs: path.resolve(ROOT, d) })),
];

const dirs = process.argv.slice(2);
// 显式参数 = 逐目录 fail-closed（原语义：给了哪些目录就守哪些）；缺省 = 上面 constructed 守护面。
const targets = dirs.length
  ? dirs.map((d) => ({ rel: d, abs: path.resolve(ROOT, d) }))
  : defaultTargets();

// 守卫文件清单（目录缺失 fail-closed；**每目录**可检文件数 0 fail-closed——防「改名/删除/清空即去门」）
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp']); // tmp = 一次性/生成件（gitignored），不入守护面
const walk = (abs, rel) => {
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isSymbolicLink()) continue; // 防环；符号链接目标不属本仓守护面
    const childAbs = path.join(abs, ent.name);
    const childRel = `${rel}/${ent.name}`;
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) out.push(...walk(childAbs, childRel)); continue; }
    if (ent.isFile() && /\.(mjs|cjs)$/.test(ent.name)) out.push({ rel: childRel, abs: childAbs });
  }
  return out;
};

const files = [];
const missing = [];
const empty = [];
for (const t of targets) {
  try {
    if (!fs.statSync(t.abs).isDirectory()) { missing.push(t.rel); continue; }
  } catch {
    missing.push(t.rel);
    continue;
  }
  const found = walk(t.abs, t.rel);
  if (!found.length) { empty.push(t.rel); continue; }
  files.push(...found);
}
const total = files.length;

// node --check 逐文件起子进程（无 API 可原地解析 ESM 而不执行），单次 ~70ms × 108 文件 = 8.1s 实测；
// 工作池并发后墙钟 ≈ 单次 spawn × ceil(文件数/并发)（scripts-syntax-parallel）。
// 裁决口径不变：任一文件不可解析即判红，判红文件按路径排序输出（并发下不回放乱序）。
const reds = [];
{
  const conc = Math.max(2, Math.min(8, os.cpus().length - 2));
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const t = files[cursor++];
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['--check', t.abs]);
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => resolve({ status: null, stderr: String(e.message) }));
        child.on('close', (status) => resolve({ status, stderr: err }));
      });
      if (r.status !== 0) {
        const first = (r.stderr || '').split(/\r?\n/).find((l) => l.trim()) || `exit ${r.status}`;
        reds.push(`[syntax] ❌ ${t.rel}: ${first}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, files.length) }, worker));
  reds.sort();
}

if (missing.length) {
  console.error(`[syntax] ❌ 检查目标目录缺失：${missing.join('、')}（fail-closed——脚本被改名/删除即去门）`);
  process.exit(1);
}
if (empty.length) {
  console.error(`[syntax] ❌ 检查目标目录递归后无可检脚本：${empty.join('、')}（fail-closed——目录被清空/改名即去门）`);
  process.exit(1);
}
if (total === 0) {
  console.error('[syntax] ❌ 可检文件数为 0（目录为空或参数指错，fail-closed）');
  process.exit(1);
}
if (reds.length) {
  for (const line of reds) console.error(line);
  console.error(`[syntax] 共 ${total} 个引擎脚本，${reds.length} 个不可解析`);
  process.exit(1);
}
console.log(`[syntax] ✅ ${total} 个引擎脚本全部可解析（node --check）`);
process.exit(0);
