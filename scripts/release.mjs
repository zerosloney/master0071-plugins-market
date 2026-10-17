#!/usr/bin/env node
// 统一同步插件版本号（多插件，按插件分组）：
//
//   systemone-decision（7 处）：
//     市场清单条目版本 ×2：marketplace.json（ZCode 兼容垫片，非 Agent Plugins 标准）
//                 .omp-plugin/marketplace.json（Oh My Pi 市场目录，非标准）
//     插件清单 ×4：plugin.json（Agent Plugins 标准清单，权威来源）
//                 .zcode-plugin/plugin.json（非标准 ZCode 兼容垫片）
//                 .codex-plugin/plugin.json（非标准 Codex 兼容垫片）
//                 .omp-plugin/plugin.json（非标准 Oh My Pi 兼容垫片）
//     mcp/server.mjs 的 SERVER_INFO.version ×1
//
//   worktree-ops（7 处）：
//     市场清单条目版本 ×2：marketplace.json（ZCode 兼容垫片，非 Agent Plugins 标准）
//                 .omp-plugin/marketplace.json（Oh My Pi 市场目录，非标准）
//     插件清单 ×4：plugin.json（Agent Plugins 标准清单，权威来源）
//                 .zcode-plugin/plugin.json（非标准 ZCode 兼容垫片）
//                 .codex-plugin/plugin.json（非标准 Codex 兼容垫片）
//                 .omp-plugin/plugin.json（非标准 Oh My Pi 兼容垫片）
//     mcp/server.mjs 的 SERVER_INFO.version ×1
//
//   agent-pipelines（5 处）：
//     市场清单条目版本 ×2：marketplace.json（ZCode 兼容垫片，非 Agent Plugins 标准）
//                 .omp-plugin/marketplace.json（Oh My Pi 市场目录，非标准）
//     插件清单 ×4：plugin.json（Agent Plugins 标准清单，权威来源）
//                 .zcode-plugin/plugin.json（非标准 ZCode 兼容垫片）
//                 .codex-plugin/plugin.json（非标准 Codex 兼容垫片）
//                 .omp-plugin/plugin.json（非标准 Oh My Pi 兼容垫片）
//
//   pstack（5 处）：
//     市场清单条目版本 ×2：marketplace.json（ZCode 兼容垫片，非 Agent Plugins 标准）
//                 .omp-plugin/marketplace.json（Oh My Pi 市场目录，非标准）
//     插件清单 ×4：plugin.json（Agent Plugins 标准清单，权威来源）
//                 .zcode-plugin/plugin.json（非标准 ZCode 兼容垫片）
//                 .codex-plugin/plugin.json（非标准 Codex 兼容垫片）
//                 .omp-plugin/plugin.json（非标准 Oh My Pi 兼容垫片）
//     注意：pstack 的版本号只表示本仓库的移植包版本，与上游 poteto/pstack 的版本号解耦，
//     上游版本记录在 plugins/pstack/NOTICE-PORT.md，不在此同步。
//
// 根 .agents/plugins/marketplace.json（Codex 市场根清单）不带条目版本：Codex 的市场 schema
// 里 plugins[] 只有 name / source / policy / category，版本从各插件的 .codex-plugin/plugin.json 读，
// 因此它不进 MARKETS，只作为 Codex 侧的插件发现入口。
//
// 仓库已按 Agent Plugins 1.0.0 标准打包：根 plugin.json（封闭 schema）+ skills/ + mcp.json。
// 根 marketplace.json 与 .zcode-plugin/ 是超出标准的 ZCode 兼容层，仅为保住 ZCode 的
// /plugin marketplace add 装法而保留；Agent Plugins 客户端会忽略它们。
//
// 市场清单内含多个插件条目，版本替换按条目 name 定位（不依赖"两插件版本号恰好不同"），
// 替换后整体 JSON.parse 校验：目标条目已更新、其余条目版本未被波及，才写盘。
//
// 用法：
//   node scripts/release.mjs <plugin> <x.y.z>    设置某插件的新版本（semver 校验）
//   node scripts/release.mjs --check             校验所有插件各处版本一致
// 零依赖，Node ≥ 18。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 路径基于本文件解析（而不是 cwd），否则从子目录执行会读到不存在的文件直接 ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (rel) => path.join(ROOT, rel);

// 根 marketplace.json 是 ZCode 的兼容垫片，只保留这一份
// 根 .omp-plugin/marketplace.json 是 Oh My Pi 的市场目录，条目带版本，同样需要同步
const MARKETS = ['marketplace.json', '.omp-plugin/marketplace.json'];
const inPlugin = (name, rel) => `plugins/${name}/${rel}`;

// 每个插件四份清单：根 plugin.json 是 Agent Plugins 标准清单（版本权威来源），
// .zcode-plugin / .codex-plugin / .omp-plugin 是超出标准的客户端兼容垫片
const PLUGIN_MANIFESTS = ['plugin.json', '.zcode-plugin/plugin.json', '.codex-plugin/plugin.json', '.omp-plugin/plugin.json'];

const PLUGINS = {
  'systemone-decision': {
    currentFrom: inPlugin('systemone-decision', 'plugin.json'),
    jsonFiles: PLUGIN_MANIFESTS.map((f) => inPlugin('systemone-decision', f)),
    markets: MARKETS,
    serverInfo: inPlugin('systemone-decision', 'mcp/server.mjs'),
  },
  'worktree-ops': {
    currentFrom: inPlugin('worktree-ops', 'plugin.json'),
    jsonFiles: PLUGIN_MANIFESTS.map((f) => inPlugin('worktree-ops', f)),
    markets: MARKETS,
    serverInfo: inPlugin('worktree-ops', 'mcp/server.mjs'),
  },
  'agent-pipelines': {
    currentFrom: inPlugin('agent-pipelines', 'plugin.json'),
    jsonFiles: PLUGIN_MANIFESTS.map((f) => inPlugin('agent-pipelines', f)),
    markets: MARKETS,
  },
  'pstack': {
    currentFrom: inPlugin('pstack', 'plugin.json'),
    jsonFiles: PLUGIN_MANIFESTS.map((f) => inPlugin('pstack', f)),
    markets: MARKETS,
  },
};

const arg = process.argv[2];
const checkOnly = arg === '--check';

if (!checkOnly && !(arg in PLUGINS)) {
  console.error(`用法: node scripts/release.mjs <${Object.keys(PLUGINS).join('|')}> <x.y.z[-pre]> | --check`);
  process.exit(1);
}
if (!checkOnly && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(process.argv[3] ?? '')) {
  console.error('✗ 版本号需为 semver（x.y.z 或 x.y.z-pre）');
  process.exit(1);
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

const esc = (s) => s.replace(/\./g, '\\.');
const readJson = (file) => JSON.parse(readFileSync(at(file), 'utf8'));

const marketEntryVersion = (file, name) =>
  readJson(file).plugins.find((p) => p.name === name)?.version;

// SERVER_INFO 版本位按插件名锚定，避免只认 systemone-decision 那一条字面量
const serverInfoVersion = (file, pluginName) =>
  readFileSync(at(file), 'utf8').match(
    new RegExp(`const SERVER_INFO = \\{ name: '${esc(pluginName)}', version: '([^']+)' \\}`),
  )?.[1];

// 每个插件收集 [label, 当前版本值]；以 currentFrom 清单为基准版本
function collect(name) {
  const cfg = PLUGINS[name];
  const current = readJson(cfg.currentFrom).version;
  const spots = [];
  for (const f of cfg.markets) spots.push([f, marketEntryVersion(f, name)]);
  for (const f of cfg.jsonFiles) spots.push([f, readJson(f).version]);
  if (cfg.serverInfo) spots.push([`${cfg.serverInfo} SERVER_INFO`, serverInfoVersion(cfg.serverInfo, name)]);
  return { current, spots };
}

if (checkOnly) {
  let failed = false;
  for (const name of Object.keys(PLUGINS)) {
    const { current, spots } = collect(name);
    if (spots.some(([, v]) => !v)) {
      failed = true;
      console.error(`✗ [${name}] 有版本位缺失或格式不符：`);
      for (const [f, v] of spots) console.error(`  ${v ? '✓' : '✗'} ${f}${v ? ` = ${v}` : ''}`);
      continue;
    }
    const all = new Set(spots.map(([, v]) => v));
    if (all.size > 1) {
      failed = true;
      console.error(`✗ [${name}] 版本不一致：`);
      for (const [f, v] of spots) console.error(`  ${f} = ${v}`);
      continue;
    }
    console.log(`✓ [${name}] ${spots.length} 处版本一致：${current}`);
  }
  process.exit(failed ? 1 : 0);
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

const name = arg;
const next = process.argv[3];
const { current, spots } = collect(name);

if (spots.some(([, v]) => !v)) {
  console.error(`✗ [${name}] 有版本位缺失，请先运行 --check 人工排查`);
  process.exit(1);
}
if (next === current) {
  console.error(`✗ [${name}] 新版本与当前相同（${current}），无需发布`);
  process.exit(1);
}

// 市场清单条目：按 name 锚定后替换首个版本行，写盘前 JSON.parse 校验不波及其余条目
function writeMarketEntry(file, pluginName, from, to) {
  const src = readFileSync(at(file), 'utf8');
  const anchor = src.indexOf(`"name": "${pluginName}"`);
  if (anchor < 0) throw new Error(`${file} 中找不到插件 ${pluginName} 条目`);
  const re = new RegExp(`("version"\\s*:\\s*")${esc(from)}(")`);
  if (!re.test(src.slice(anchor))) throw new Error(`${file} 中插件 ${pluginName} 未找到版本 ${from}`);
  const out = src.slice(0, anchor) + src.slice(anchor).replace(re, `$1${to}$2`);
  const before = JSON.parse(src);
  const after = JSON.parse(out);
  for (const p of after.plugins) {
    const old = before.plugins.find((x) => x.name === p.name);
    if (!old || p.version !== (p.name === pluginName ? to : old.version)) {
      throw new Error(`${file} 版本替换波及了错误条目（${p.name}: ${old?.version} → ${p.version}），放弃写入`);
    }
  }
  writeFileSync(at(file), out);
  console.log(`✓ ${file} [${pluginName}]: ${from} → ${to}`);
}

// 普通 JSON：只替换顶层 version 行，保留原有格式（避免 JSON.stringify 重排引起无关 diff）
function writeJsonRoot(file, from, to) {
  const src = readFileSync(at(file), 'utf8');
  const re = new RegExp(`("version"\\s*:\\s*")${esc(from)}(")`);
  if (!re.test(src)) throw new Error(`${file} 中未找到版本 ${from}，请人工检查`);
  writeFileSync(at(file), src.replace(re, `$1${to}$2`));
  console.log(`✓ ${file}: ${from} → ${to}`);
}

const cfg = PLUGINS[name];
try {
  for (const f of cfg.markets) writeMarketEntry(f, name, current, next);
  for (const f of cfg.jsonFiles) writeJsonRoot(f, current, next);
  if (cfg.serverInfo) {
    const src = readFileSync(at(cfg.serverInfo), 'utf8');
    const re = new RegExp(`(const SERVER_INFO = \\{ name: '${esc(name)}', version: ')[^']+(' \\})`);
    if (!re.test(src)) throw new Error(`${cfg.serverInfo} 中未找到 SERVER_INFO 版本行`);
    writeFileSync(at(cfg.serverInfo), src.replace(re, `$1${next}$2`));
    console.log(`✓ ${cfg.serverInfo} SERVER_INFO: ${current} → ${next}`);
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

console.log(`\n完成。[${name}] 已发布 v${next}，提交推送后客户端更新插件即拉到新版。`);
