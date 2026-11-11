#!/usr/bin/env node
// gen-host-manifests.mjs — 宿主垫片单源生成器（2026-11 市场审查后引入，仿 gen-engine-map 先例）
// 动机：三份宿主垫片（.zcode-plugin / .codex-plugin / .omp-plugin 的 plugin.json）此前手写，
//       name/version 等共享字段与根 plugin.json 靠 smoke.mjs 对账兜底，漂了才知道；.codex 的内联
//       PreToolUse hooks 段更是 hooks/hooks.json 的第二份拷贝（hook.test.mjs 第⑧组专门对账 matcher）。
//       单源化后：共享字段运行时读根 plugin.json，.codex hooks 段整块读 hooks/hooks.json，
//       宿主差异（短描述 / interface / category / 指针面）收口在 scripts/hosts.mjs 注册表。
// 用法：node <插件根>/scripts/gen-host-manifests.mjs          默认渲染并写盘三份垫片
//       node <插件根>/scripts/gen-host-manifests.mjs --check  只比对不写盘，漂移即 exit 1（CI 防漂移）
// 测试：node <插件根>/test/gen-host-manifests.test.mjs
// 写盘格式：JSON.stringify(obj, null, 2) + 末尾换行，UTF-8 无 BOM；--check 归一 \r 后比对
//（Windows 检出 autocrlf 会把垫片检成 CRLF，按 gen-engine-map 先例不因行尾假阳性）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOSTS, SHORT_DESCRIPTION } from './hosts.mjs';

// 插件根 = 本脚本落位（<plugin>/scripts/）的上一级，随安装缓存目录漂移（对齐 paths.mjs 口径；
// 不走 paths.mjs 是为本生成器保持零依赖单文件，测试夹具整树复制后相对关系不变）
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── MCP / hooks 声明形态渲染 ─────────────────────────────────────────────────
// inline-claude-root：内联 mcpServers，路径经 ${CLAUDE_PLUGIN_ROOT}（宿主安装根运行时替换）
function renderMcp(kind) {
  if (kind === 'inline-claude-root') {
    return { delivery: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'] } };
  }
  if (kind === 'pointer-mcp-json') return './mcp.json';
  throw new Error(`[gen-host-manifests] 未知 mcp 形态 "${kind}"（合法：inline-claude-root / pointer-mcp-json）`);
}

// pointer → "./hooks"；inline-from-hooks-json → **整个 hooks/hooks.json 对象**（其根键 hooks 下挂
// PreToolUse，与 .codex 垫片现形态逐字同构——matcher/command/timeout 单源在该文件，此处零拷贝）
function renderHooks(kind) {
  if (kind === 'pointer') return './hooks';
  if (kind === 'inline-from-hooks-json') {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  }
  if (kind === 'none') return undefined;
  throw new Error(`[gen-host-manifests] 未知 hooks 形态 "${kind}"（合法：pointer / inline-from-hooks-json / none）`);
}

// ── 纯函数渲染（供测试 import；不做任何写盘） ────────────────────────────────
export function renderHostManifest(hostId) {
  const host = HOSTS.find((h) => h.id === hostId);
  if (!host) {
    throw new Error(`[gen-host-manifests] 未知宿主 "${hostId}"（注册表：${HOSTS.map((h) => h.id).join(' / ')}）`);
  }
  // 共享字段单源 = 根 plugin.json（$schema/长描述不上垫片；description 按宿主取短文案）
  const root = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
  const base = {
    name: root.name,
    version: root.version,
    description: host.descriptionKind === 'short' ? SHORT_DESCRIPTION : root.description,
    author: root.author,
    homepage: root.homepage,
    repository: root.repository,
    license: root.license,
    keywords: root.keywords,
  };
  const hooksVal = renderHooks(host.hooks);
  // 按 order 逐键取值（JS 对象保序，键序 = 垫片字段序，与现文件一致以追求零 diff）
  const obj = {};
  for (const key of host.order) {
    if (key in base) { obj[key] = base[key]; continue; }
    if (key === 'mcpServers') { obj[key] = renderMcp(host.mcp); continue; }
    if (key === 'hooks') {
      if (hooksVal === undefined) throw new Error(`[gen-host-manifests] 宿主 ${hostId} order 含 hooks 但注册表声明 hooks: none`);
      obj[key] = hooksVal;
      continue;
    }
    if (host.points.includes(key)) { obj[key] = `./${key}`; continue; }
    if (key in host.extra) { obj[key] = host.extra[key]; continue; }
    throw new Error(`[gen-host-manifests] 宿主 ${hostId} order 键 "${key}" 无来源（points/extra/mcp/hooks 均未声明）`);
  }
  // 反向完整性：points / extra / hooks(pointer) 里声明的键必须都进了 order，防注册表自相矛盾静默丢字段
  const declared = [...host.points, ...(hooksVal !== undefined ? ['hooks'] : []), ...Object.keys(host.extra)];
  const missing = declared.filter((k) => !(k in obj));
  if (missing.length) {
    throw new Error(`[gen-host-manifests] 宿主 ${hostId} 注册表声明了 ${missing.join(', ')} 但 order 未收录——修 hosts.mjs`);
  }
  return obj;
}

// 序列化：两空格缩进 + 末尾换行，UTF-8 无 BOM（writeFileSync 默认不写 BOM）
const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

// ── CLI（isMain 前置：被测试 import 纯函数时本段不执行，对齐 gen-engine-map 先例） ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const UNKNOWN = argv.filter((a) => a !== '--check');
  if (UNKNOWN.length) {
    console.error(`[gen-host-manifests] 未知参数 ${UNKNOWN.join(' ')}——用法：node scripts/gen-host-manifests.mjs [--check]`);
    process.exit(1);
  }

  const checkMode = argv.includes('--check');
  const norm = (s) => s.replace(/\r/g, '');
  const drifts = [];
  for (const host of HOSTS) {
    const rel = path.join(host.dir, 'plugin.json');
    const file = path.join(PLUGIN_ROOT, rel);
    const rendered = serialize(renderHostManifest(host.id));
    const current = fs.existsSync(file) ? norm(fs.readFileSync(file, 'utf8')) : null;
    if (current === norm(rendered)) {
      console.log(`  ✓ ${rel} 与单源一致`);
      continue;
    }
    // 逐文件列差异：定位首处发散行，两侧各截 160 字符（不整段搬运 diff）
    let detail = current === null ? '垫片不存在' : '';
    if (current !== null) {
      const a = current.split('\n');
      const b = norm(rendered).split('\n');
      const i = a.findIndex((line, idx) => line !== b[idx]);
      detail = `首处发散于第 ${i + 1} 行\n      现文件: ${(a[i] === undefined ? '(EOF)' : a[i]).slice(0, 160)}\n      渲染值: ${(b[i] === undefined ? '(EOF)' : b[i]).slice(0, 160)}`;
    }
    drifts.push({ rel, detail });
    console.error(`  ✗ ${rel} 与渲染结果不一致\n      ${detail}`);
  }

  if (checkMode) {
    if (drifts.length) {
      console.error(`[gen-host-manifests] ❌ ${drifts.length}/${HOSTS.length} 份垫片漂移——重生成：node scripts/gen-host-manifests.mjs`);
      process.exit(1);
    }
    console.log(`[gen-host-manifests] ✅ ${HOSTS.length} 份宿主垫片与单源一致`);
    process.exit(0);
  }

  for (const host of HOSTS) {
    const file = path.join(PLUGIN_ROOT, host.dir, 'plugin.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serialize(renderHostManifest(host.id)), 'utf8');
  }
  console.log(`[gen-host-manifests] ✅ 已生成 ${HOSTS.length} 份宿主垫片（共享字段取根 plugin.json，codex hooks 段取 hooks/hooks.json）`);
}
