#!/usr/bin/env node
// check-hook-wiring.mjs — 接线宣称 ↔ 宿主实态一致性机检（2026-11-12 判据移植，源 3f5e86797 判据级适配）
//
// 为什么需要：宿主接线（hooks 段 / mcpServers）散落四处——hooks/hooks.json 单源 + 三份宿主垫片
//（.zcode-plugin / .codex-plugin / .omp-plugin 的 plugin.json，gen-host-manifests 生成）。生成器
// --check 只防「垫片 ↔ 注册表渲染」漂移，防不了「CLAIMS 宣称 ↔ 实态」整体漂移（如 omp 垫片被手滑
// 加上 hooks 键、mcp/server.mjs 被挪走、hooks.json 删段后垫片未随动）。本脚本只做「宣称 == 实态」
// 对账（drift 检出），不替 owner 决定期望态——期望态变更须同提交改 CLAIMS 与 mechanism-registry
// 对应行；两侧任一漂移本门即红。
//
// 三宿主宣称形态（与 hosts.mjs 注册表一致）：
//   zcode：垫片 hooks 指针 "./hooks" → hooks.json 有 PreToolUse shell matcher 段挂 pretool-risk.mjs；
//          manifest 内联 mcpServers（${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs）。
//   codex：manifest 内联 hooks 段（gen-host-manifests 从 hooks.json 渲染）与 hooks.json 逐字段一致；
//          mcpServers 为指针 "./mcp.json"。
//   omp：  manifest 无 hooks 键（宣称「无」：宿主不拉 PreToolUse，git hooks 层兜底）；内联 mcpServers。
//
// 挂载点：githooks/pre-push（种子占位符 @@HOOK_WIRING_SCRIPT@@ 安装时实化；gate 语义——漂移 exit 1
// 挡推送）；手动：node <插件根>/scripts/check-hook-wiring.mjs。退出码：0 一致 / 1 漂移。
// CLAIMS 每条指回 config-templates/mechanism-registry.md 对应行（registryRow 锚词，脚本校验行在场
// ——行被退役/改名而 CLAIM 未同改时在此红）。
// 测试：node <插件根>/test/check-hook-wiring.test.mjs（注缝：HOOK_WIRING_ROOT 环境变量 / run(root)）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根解析（测试注缝）：HOOK_WIRING_ROOT 环境变量（夹具根）→ 本脚本落位上一级（插件根）。
const ROOT = process.env.HOOK_WIRING_ROOT || path.resolve(HERE, '..');
const REGISTRY_REL = 'config-templates/mechanism-registry.md';

// 键序无关逐字段对账（hooks.json 手写、垫片由生成器产出——人工重排键序不该误报）
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null
    || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 宣称表（单源：期望态在此声明并指回 registry 行；改期望态 = 改本表 + registry 行同提交）。
// face ∈ hooks（registry 行「PreToolUse 风险闸」）/ mcp（registry 行「MCP 工具面」）。
const CLAIMS = [
  {
    host: '.zcode-plugin/plugin.json', face: 'hooks', registryRow: 'PreToolUse 风险闸',
    claim: 'hooks 指针 "./hooks" 且 hooks.json 有 PreToolUse shell 段挂 pretool-risk.mjs（zcode 走宿主 hooks 面）',
    problems(ctx) {
      const out = [];
      if (!ctx.shims.zcode) out.push('不可读/不可解析');
      else if (ctx.shims.zcode.hooks !== './hooks') out.push(`hooks=${JSON.stringify(ctx.shims.zcode.hooks ?? null)}，宣称 "./hooks"`);
      if (ctx.hooksJsonProblem) out.push(ctx.hooksJsonProblem);
      return out;
    },
  },
  {
    host: '.codex-plugin/plugin.json', face: 'hooks', registryRow: 'PreToolUse 风险闸',
    claim: 'manifest 内联 hooks 段与 hooks/hooks.json 逐字段一致（风险闸 + 写前门两段随单源整体渲染，gen-host-manifests 渲染面）',
    problems(ctx) {
      const out = [];
      if (!ctx.shims.codex) out.push('不可读/不可解析');
      else if (!ctx.hooksJson) out.push('hooks/hooks.json 不可读——内联 hooks 段失去比对基准');
      else if (!deepEqual(ctx.shims.codex.hooks, ctx.hooksJson)) out.push('内联 hooks 段与 hooks/hooks.json 逐字段不一致（垫片须由 gen-host-manifests 重生成对齐）');
      return out;
    },
  },
  {
    host: '.zcode-plugin/plugin.json', face: 'hooks', registryRow: 'PreToolUse 写前门',
    claim: 'hooks.json 有 PreToolUse 写前门段挂 pre-write-guard.mjs（Write/Edit/Update/NotebookEdit 写工具面，脚本实存）',
    problems(ctx) {
      return ctx.writeGuardProblem ? [ctx.writeGuardProblem] : [];
    },
  },
  {
    host: '.omp-plugin/plugin.json', face: 'hooks', registryRow: 'PreToolUse 风险闸',
    claim: 'manifest 无 hooks 键（宣称「无」：宿主不拉 PreToolUse 风险闸，git hooks 层兜底）',
    problems(ctx) {
      if (!ctx.shims.omp) return ['不可读/不可解析'];
      if ('hooks' in ctx.shims.omp) return [`实态出现 hooks 键=${JSON.stringify(ctx.shims.omp.hooks)}，宣称「无」`];
      return [];
    },
  },
  {
    host: '.zcode-plugin/plugin.json', face: 'mcp', registryRow: 'MCP 工具面',
    claim: 'manifest 内联 mcpServers.delivery = node + mcp/server.mjs，且文件实存',
    problems(ctx) {
      if (!ctx.shims.zcode) return ['不可读/不可解析'];
      const p = ctx.inlineMcpProblem(ctx.shims.zcode);
      return p ? [p] : [];
    },
  },
  {
    host: '.codex-plugin/plugin.json', face: 'mcp', registryRow: 'MCP 工具面',
    claim: 'mcpServers 为指针 "./mcp.json" 且指针目标可解析到 mcp/server.mjs',
    problems(ctx) {
      const out = [];
      if (!ctx.shims.codex) out.push('不可读/不可解析');
      else if (ctx.shims.codex.mcpServers !== './mcp.json') out.push(`mcpServers=${JSON.stringify(ctx.shims.codex.mcpServers ?? null)}，宣称指针 "./mcp.json"`);
      if (ctx.mcpJsonProblem) out.push(ctx.mcpJsonProblem);
      return out;
    },
  },
  {
    host: '.omp-plugin/plugin.json', face: 'mcp', registryRow: 'MCP 工具面',
    claim: 'manifest 内联 mcpServers.delivery = node + mcp/server.mjs，且文件实存',
    problems(ctx) {
      if (!ctx.shims.omp) return ['不可读/不可解析'];
      const p = ctx.inlineMcpProblem(ctx.shims.omp);
      return p ? [p] : [];
    },
  },
];

// run(root = ROOT)：对账全部 CLAIM，返回问题列表（空数组 = 一致）。root 参数为测试注缝。
export function run(root = ROOT) {
  const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; } };
  const readText = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

  const ctx = {
    hooksJson: readJson('hooks/hooks.json'),
    shims: {
      zcode: readJson('.zcode-plugin/plugin.json'),
      codex: readJson('.codex-plugin/plugin.json'),
      omp: readJson('.omp-plugin/plugin.json'),
    },
    preRiskOnDisk: fs.existsSync(path.join(root, 'hooks', 'pretool-risk.mjs')),
    preWriteOnDisk: fs.existsSync(path.join(root, 'hooks', 'pre-write-guard.mjs')),
    serverOnDisk: fs.existsSync(path.join(root, 'mcp', 'server.mjs')),
  };

  // hooks.json 实态（zcode 指针目标 / codex 内联段的比对基准）。
  // matcher 非窄写法对账复用 test/hook.test.mjs ⑧ 口径的轻量版：宿主包装形态 Command/pwsh 必须命中
  //（⑧ 的全名单覆盖/真实进程判行为仍归 hook.test，此处只防「删段/窄化」两类漂移）。
  ctx.hooksJsonProblem = (() => {
    if (!ctx.hooksJson) return 'hooks/hooks.json 不可读/不可解析';
    const entries = ctx.hooksJson?.hooks?.PreToolUse;
    if (!Array.isArray(entries) || !entries.length) return 'hooks/hooks.json 缺 hooks.PreToolUse 段';
    const hit = entries.find((e) => typeof e?.matcher === 'string' && e.matcher
      && Array.isArray(e.hooks)
      && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('pretool-risk.mjs')));
    if (!hit) return 'hooks/hooks.json PreToolUse 段无挂 pretool-risk.mjs 的 matcher 条目';
    try {
      const re = new RegExp(hit.matcher);
      if (!(re.test('Command') && re.test('pwsh'))) return `hooks/hooks.json PreToolUse matcher 窄写法（宿主包装形态漏匹配）:${hit.matcher}`;
    } catch { return `hooks/hooks.json PreToolUse matcher 非法正则:${hit.matcher}`; }
    if (!ctx.preRiskOnDisk) return 'hooks/pretool-risk.mjs 文件不存在（接线指向空）';
    return null;
  })();

  // 写前门段实态（zcode 指针目标的第二段；codex 内联段由 deepEqual 整体同步，不在此重复判）。
  // hooksJson 不可读时 hooksJsonProblem 已点名，本腿不重复报。
  ctx.writeGuardProblem = (() => {
    if (!ctx.hooksJson) return null;
    const entries = ctx.hooksJson?.hooks?.PreToolUse;
    const hit = entries?.find((e) => typeof e?.matcher === 'string' && e.matcher
      && Array.isArray(e.hooks)
      && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('pre-write-guard.mjs')));
    if (!hit) return 'hooks/hooks.json PreToolUse 段无挂 pre-write-guard.mjs 的 matcher 条目（写前门段缺失）';
    try {
      const re = new RegExp(hit.matcher);
      if (!(re.test('Write') && re.test('Edit') && re.test('Update') && re.test('NotebookEdit'))) return `hooks/hooks.json 写前门 matcher 窄写法（Write/Edit/Update/NotebookEdit 漏匹配）:${hit.matcher}`;
    } catch { return `hooks/hooks.json 写前门 matcher 非法正则:${hit.matcher}`; }
    if (!ctx.preWriteOnDisk) return 'hooks/pre-write-guard.mjs 文件不存在（接线指向空）';
    return null;
  })();

  // 内联 mcp 面实态（zcode / omp 共用判据）
  ctx.inlineMcpProblem = (shim) => {
    const d = shim?.mcpServers?.delivery;
    if (!d || d.command !== 'node') return 'mcpServers.delivery 缺失或 command ≠ node';
    const args = Array.isArray(d.args) ? d.args.join(' ') : String(d.args ?? '');
    if (!args.includes('mcp/server.mjs')) return `mcpServers.delivery.args 未指 mcp/server.mjs（${args || '(空)'}）`;
    if (!ctx.serverOnDisk) return 'mcp/server.mjs 文件不存在（命令串指向空）';
    return null;
  };

  // codex 指针目标实态（插件根 mcp.json）
  const mcpJson = readJson('mcp.json');
  ctx.mcpJsonProblem = (() => {
    if (!mcpJson) return 'mcp.json 不可读/不可解析（codex 指针目标）';
    const d = mcpJson?.mcpServers?.delivery;
    const args = Array.isArray(d?.args) ? d.args.join(' ') : String(d?.args ?? '');
    if (!d || d.command !== 'node' || !args.includes('mcp/server.mjs')) return 'mcp.json mcpServers.delivery 未指 node + mcp/server.mjs';
    if (!ctx.serverOnDisk) return 'mcp/server.mjs 文件不存在（指针链指向空）';
    return null;
  })();

  const problems = [];
  for (const c of CLAIMS) {
    for (const p of c.problems(ctx)) {
      problems.push(`${c.host} ${p}（宣称：${c.claim}；registry 行「${c.registryRow}」）`);
    }
  }
  // CLAIM → registry 行锚在场（行被退役/改名而 CLAIM 未同改时在此红）
  const registry = readText(REGISTRY_REL);
  if (registry === null) {
    problems.push(`mechanism-registry 不可读（${REGISTRY_REL}）——CLAIMS 指回断链`);
  } else {
    for (const row of new Set(CLAIMS.map((c) => c.registryRow))) {
      if (!new RegExp(`^\\|\\s*${escRe(row)}\\s*\\|`, 'm').test(registry)) {
        problems.push(`mechanism-registry 无「${row}」行——CLAIMS 指回断链（行改名/退役须同提交改本脚本 CLAIMS）`);
      }
    }
  }
  return problems;
}

function main() {
  const problems = run();
  if (problems.length) {
    console.error('check-hook-wiring: 接线漂移——宣称与实态不一致：');
    for (const p of problems) console.error(`  ❌ ${p}`);
    console.error('处置：改实态（hooks.json / 垫片 gen-host-manifests 重生成 / mcp 面）或改宣称（本脚本 CLAIMS + mechanism-registry 对应行）后重跑；两侧须同提交。');
    process.exit(1);
  }
  console.log(`check-hook-wiring: ✅ ${CLAIMS.length} 项宣称与实态一致（hooks 面 4 / mcp 面 3，registry 行锚在场）`);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
