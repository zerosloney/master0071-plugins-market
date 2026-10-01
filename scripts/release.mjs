#!/usr/bin/env node
// 统一同步插件版本号（6 处）：
//   1. marketplace.json                                        → plugins[].version
//   2. .omp-plugin/marketplace.json                            → plugins[].version（omp 市场清单）
//   3. plugins/systemone-decision/.zcode-plugin/plugin.json
//   4. plugins/systemone-decision/.minimax-plugin/plugin.json
//   5. plugins/systemone-decision/.omp-plugin/plugin.json
//   6. plugins/systemone-decision/mcp/server.mjs               → SERVER_INFO.version
//
// 用法：
//   node scripts/release.mjs 0.4.0        设置新版本（semver 校验）
//   node scripts/release.mjs --check      只校验各处版本一致，不修改
// 零依赖，Node ≥ 18。

import { readFileSync, writeFileSync } from 'node:fs';

const ZCODE = 'plugins/systemone-decision/.zcode-plugin/plugin.json';
const MINIMAX = 'plugins/systemone-decision/.minimax-plugin/plugin.json';
const OMP_MANIFEST = 'plugins/systemone-decision/.omp-plugin/plugin.json';
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
const zcode = JSON.parse(readFileSync(ZCODE, 'utf8'));
const current = zcode.version;
const next = checkOnly ? current : arg;

// 各处当前版本
const market = JSON.parse(readFileSync(MARKET, 'utf8'));
const ompMarket = JSON.parse(readFileSync(OMP_MARKET, 'utf8'));
const minimax = JSON.parse(readFileSync(MINIMAX, 'utf8'));
const ompManifest = JSON.parse(readFileSync(OMP_MANIFEST, 'utf8'));
const serverSrc = readFileSync(SERVER, 'utf8');
const serverVer = serverSrc.match(/const SERVER_INFO = \{ name: 'systemone-decision', version: '([^']+)' \}/)?.[1];

const spots = [
  ['marketplace.json', market.plugins.find(p => p.name === 'systemone-decision')?.version],
  [OMP_MARKET, ompMarket.plugins.find(p => p.name === 'systemone-decision')?.version],
  [ZCODE, current],
  [MINIMAX, minimax.version],
  [OMP_MANIFEST, ompManifest.version],
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

// 1/2/4/5：JSON 文件只替换 version 行，保留原有格式（避免 JSON.stringify 重排引起无关 diff）
for (const file of [MARKET, OMP_MARKET, ZCODE, MINIMAX, OMP_MANIFEST]) {
  const src = readFileSync(file, 'utf8');
  const re = new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, '\\.')}(")`);
  if (!re.test(src)) {
    console.error(`✗ ${file} 中未找到版本 ${current}，请人工检查`);
    process.exit(1);
  }
  writeFileSync(file, src.replace(re, `$1${next}$2`));
  console.log(`✓ ${file}: ${current} → ${next}`);
}

// 6：server.mjs 只替换 SERVER_INFO 行内版本，避免误伤其他 version 字样
writeFileSync(SERVER, serverSrc.replace(
  /(const SERVER_INFO = \{ name: 'systemone-decision', version: ')[^']+(' \})/,
  `$1${next}$2`,
));
console.log(`✓ ${SERVER} SERVER_INFO: ${current} → ${next}`);

console.log(`\n完成。提交推送后，客户端更新插件即拉到 v${next}。`);
