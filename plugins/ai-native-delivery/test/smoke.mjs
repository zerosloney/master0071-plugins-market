#!/usr/bin/env node
// ai-native-delivery 工程骨架冒烟测试。
//
// 断言工程准入接线本身：四份插件清单可解析且 name / version 一致、两份市场清单含本插件条目
// 且版本一致、mcp/protocol.mjs 的 SERVER_INFO.version 一致、MCP stdio 探测——tools/list
// 返回恰好 7 个具名治理工具（骨架期「零工具」断言随工具层挂载退役）。
// 零依赖，Node ≥ 18 直接运行：
//
//   node test/smoke.mjs
//
// 退出码非 0 表示有断言失败。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NAME = 'ai-native-delivery';

// 路径基于本文件解析（而不是 cwd），插件根 = test/ 上一级，仓库根 = 插件根上两级
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const at = (...rel) => path.join(PLUGIN_ROOT, ...rel);

// 版本基准 = plugin.json 自身，其余 7 处向它对账。
// 写成字面量的话每次升版都要同步改本行——漏改就是「release.mjs --check 全绿、
// 插件自测 7 项红」（scripts/release.mjs 只写清单与 SERVER_INFO，不碰测试文件）。
const VERSION = JSON.parse(readFileSync(at('plugin.json'), 'utf8')).version;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};

// ── 四份插件清单 ─────────────────────────────────────────────────────────────
const manifests = [
  'plugin.json',
  path.join('.zcode-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
  path.join('.omp-plugin', 'plugin.json'),
];

for (const rel of manifests) {
  const file = at(rel);
  let body = null;
  try {
    body = readJson(file);
    check(`${rel} 可 JSON.parse`, true);
  } catch (err) {
    check(`${rel} 可 JSON.parse`, false, String(err));
    continue;
  }
  check(`${rel} name = ${NAME}`, body.name === NAME, `got ${body.name}`);
  check(`${rel} version = ${VERSION}`, body.version === VERSION, `got ${body.version}`);
}

// ── 两份市场清单条目 ────────────────────────────────────────────────────────
const markets = ['marketplace.json', path.join('.omp-plugin', 'marketplace.json')];

for (const rel of markets) {
  const file = path.join(MARKET_ROOT, rel);
  let body = null;
  try {
    body = readJson(file);
  } catch (err) {
    check(`${rel} 可 JSON.parse`, false, String(err));
    continue;
  }
  const entry = (body.plugins || []).find((p) => p.name === NAME);
  check(`${rel} 含 ${NAME} 条目`, Boolean(entry));
  check(`${rel} 条目 version = ${VERSION}`, entry?.version === VERSION, `got ${entry?.version}`);
}

// ── SERVER_INFO 版本位（release.mjs 按同一字面量格式定位）────────────────────
const protocolSrc = readFileSync(at('mcp', 'protocol.mjs'), 'utf8');
const serverInfoVersion = protocolSrc.match(
  new RegExp(`const SERVER_INFO = \\{ name: '${NAME}', version: '([^']+)' \\}`),
)?.[1];
check(
  `mcp/protocol.mjs SERVER_INFO = { name: '${NAME}', version: '${VERSION}' }`,
  serverInfoVersion === VERSION,
  `got ${serverInfoVersion}`,
);

// ── MCP stdio 探测：initialize → tools/list 恰好 7 个具名工具 ────────────────
// 骨架期断言为「tools/list 空」，工具层挂载后改为具名集合钉死（§3.3 工具表，防多注册漏注册）。
const MCP_TOOL_NAMES = [
  'grade_task',
  'read_context',
  'update_ledger',
  'confirm',
  'verify_gate',
  'ledger_stats',
  'policy_status',
];
{
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n');
  const r = spawnSync(process.execPath, [at('mcp', 'server.mjs')], { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  check('MCP server 可启动且 exit 0', r.status === 0, `exit=${r.status} stderr=${(r.stderr || '').slice(0, 300)}`);
  let tools = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result && msg.result.tools) tools = msg.result.tools;
    } catch { /* 非回执行忽略 */ }
  }
  const names = (tools || []).map((t) => t.name);
  check('tools/list 返回恰好 7 个工具', names.length === 7, JSON.stringify(names));
  check('tools/list 工具名与设计文档一致', JSON.stringify(names) === JSON.stringify(MCP_TOOL_NAMES), JSON.stringify(names));
  check(
    '每个工具带非空 description 与 inputSchema',
    (tools || []).every((t) => typeof t.description === 'string' && t.description && t.inputSchema && t.inputSchema.type === 'object'),
  );
}

if (failures > 0) {
  console.error(`\n${failures} 个断言失败`);
  process.exit(1);
}
console.log('\n全部断言通过');
