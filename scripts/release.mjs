#!/usr/bin/env node
// 统一同步插件版本号（9 处）：
//   1. marketplace.json                                        → plugins[].version
//   2. .omp-plugin/marketplace.json                            → plugins[].version（omp 市场清单）
//   3. plugins/systemone-decision/.zcode-plugin/plugin.json
//   4. plugins/systemone-decision/.minimax-plugin/plugin.json
//   5. plugins/systemone-decision/.omp-plugin/plugin.json
//   6. plugins/systemone-decision/.codex-plugin/plugin.json    → Dim 清单
//   7. plugins/systemone-decision/package.json                 → opencode 本地路径入口的包版本
//   8. package.json                                            → opencode git 安装入口的包版本
//   9. plugins/systemone-decision/mcp/server.mjs               → SERVER_INFO.version
//
// 用法：
//   node scripts/release.mjs 0.4.0        设置新版本（semver 校验）
//   node scripts/release.mjs --check      只校验各处版本一致，不修改
// 零依赖，Node ≥ 18。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 路径基于本文件解析（而不是 cwd），否则从子目录执行会读到不存在的文件直接 ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (rel) => path.join(ROOT, rel);

const ZCODE = 'plugins/systemone-decision/.zcode-plugin/plugin.json';
const MINIMAX = 'plugins/systemone-decision/.minimax-plugin/plugin.json';
const OMP_MANIFEST = 'plugins/systemone-decision/.omp-plugin/plugin.json';
const CODEX_MANIFEST = 'plugins/systemone-decision/.codex-plugin/plugin.json';
const PKG = 'plugins/systemone-decision/package.json';
const ROOT_PKG = 'package.json';
const MARKET = 'marketplace.json';
const OMP_MARKET = '.omp-plugin/marketplace.json';
const SERVER = 'plugins/systemone-decision/mcp/server.mjs';

const arg = process.argv[2];
const checkOnly = arg === '--check';

if (!checkOnly && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg ?? '')) {
  console.error('用法: node scripts/release.mjs <x.y.z[-pre]> | --check');
  process.exit(1);
}

// 当前版本：以 ZCode 清单为准
const zcode = JSON.parse(readFileSync(at(ZCODE), 'utf8'));
const current = zcode.version;
const next = checkOnly ? current : arg;

// 各处当前版本
const market = JSON.parse(readFileSync(at(MARKET), 'utf8'));
const ompMarket = JSON.parse(readFileSync(at(OMP_MARKET), 'utf8'));
const minimax = JSON.parse(readFileSync(at(MINIMAX), 'utf8'));
const ompManifest = JSON.parse(readFileSync(at(OMP_MANIFEST), 'utf8'));
const pkg = JSON.parse(readFileSync(at(PKG), 'utf8'));
const rootPkg = JSON.parse(readFileSync(at(ROOT_PKG), 'utf8'));
const serverSrc = readFileSync(at(SERVER), 'utf8');
const serverVer = serverSrc.match(/const SERVER_INFO = \{ name: 'systemone-decision', version: '([^']+)' \}/)?.[1];

const spots = [
  ['marketplace.json', market.plugins.find(p => p.name === 'systemone-decision')?.version],
  [OMP_MARKET, ompMarket.plugins.find(p => p.name === 'systemone-decision')?.version],
  [ZCODE, current],
  [MINIMAX, minimax.version],
  [OMP_MANIFEST, ompManifest.version],
  [CODEX_MANIFEST, JSON.parse(readFileSync(at(CODEX_MANIFEST), 'utf8')).version],
  [PKG, pkg.version],
  [ROOT_PKG, rootPkg.version],
  [`${SERVER} SERVER_INFO`, serverVer],
];

if (spots.some(([, v]) => !v)) {
  console.error('✗ 有版本位缺失或格式不符，请人工检查：');
  for (const [f, v] of spots) console.error(`  ${v ? '✓' : '✗'} ${f}${v ? ` = ${v}` : ''}`);
  process.exit(1);
}

if (checkOnly) {
  const all = new Set(spots.map(([, v]) => v));
  if (all.size > 1) {
    console.error('✗ 版本不一致：');
    for (const [f, v] of spots) console.error(`  ${f} = ${v}`);
    process.exit(1);
  }
  console.log(`✓ ${spots.length} 处版本一致：${current}`);
  process.exit(0);
}

if (next === current) {
  console.error(`✗ 新版本与当前相同（${current}），无需发布`);
  process.exit(1);
}

// 其余 8 处都是 JSON：只替换 version 行，保留原有格式（避免 JSON.stringify 重排引起无关 diff）
for (const file of [MARKET, OMP_MARKET, ZCODE, MINIMAX, OMP_MANIFEST, CODEX_MANIFEST, PKG, ROOT_PKG]) {
  const src = readFileSync(at(file), 'utf8');
  const re = new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, '\\.')}(")`);
  if (!re.test(src)) {
    console.error(`✗ ${file} 中未找到版本 ${current}，请人工检查`);
    process.exit(1);
  }
  writeFileSync(at(file), src.replace(re, `$1${next}$2`));
  console.log(`✓ ${file}: ${current} → ${next}`);
}

// 最后一处：server.mjs 只替换 SERVER_INFO 行内版本，避免误伤其他 version 字样
writeFileSync(at(SERVER), serverSrc.replace(
  /(const SERVER_INFO = \{ name: 'systemone-decision', version: ')[^']+(' \})/,
  `$1${next}$2`,
));
console.log(`✓ ${SERVER} SERVER_INFO: ${current} → ${next}`);

console.log(`\n完成。提交推送后，客户端更新插件即拉到 v${next}。`);
