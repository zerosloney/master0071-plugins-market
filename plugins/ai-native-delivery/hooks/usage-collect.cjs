#!/usr/bin/env node
// usage-collect.cjs — Claude Code PostToolUse(Agent) usage 观测腿（经 hooks/hooks.json 接线，宿主以
// node "${CLAUDE_PLUGIN_ROOT}/hooks/usage-collect.cjs" 直调）。判据级移植蓝本 agentic-flow-kit
// usage-collect.cjs（零运行时依赖，不 import 不 spawn）。证据来源：Claude Code 官方 hooks 文档
// （2026-11 核实）——PostToolUse matcher=Agent 的 stdin 载荷 tool_response 含 usage（input/output
// tokens）、resolvedModel、agentId、totalDurationMs，只覆盖该子代理最后一次 API 请求；
// 其余宿主无公开证据，不接线。
// 与蓝本的差异（头注声明）：蓝本 root 解析有 FLOW_KIT_PROJECT_ROOT 优先分支（`flow-kit hook`
// 入口注入环境变量）；插件形态由宿主直调、无该注入——该分支省略，root 恒走 payload.cwd 向上找。
// 契约（行 schema 对齐蓝本，聚合消费方 scripts/agg-delegations.mjs「派发预算（advisory）」段）：
//   1) 纯观测：只追加 <root>/.agents/usage.jsonl（appendFileSync = O_APPEND，仓内台账同招），
//      不改历史；不回写、不拦截，stdout 保持干净（hook 协议无决策）。
//   2) 诚实边界：不读宿主 transcript、不推测 token；usage（input/output tokens 数值）缺失 →
//      静默零写入、exit 0；任何异常都不阻塞宿主会话（恒 exit 0）。
//   3) 字段映射：role='agent'（子代理凭据统一标记，语义角色宿主侧不可得）、model=resolvedModel、
//      run=agentId、inputTokens=usage.input_tokens、outputTokens=usage.output_tokens、
//      latencyMs=totalDurationMs；cache_* token 与 totalTokens 不落账（行 schema 无此字段，
//      不得混入 inputTokens）。
//   4) root 解析：payload.cwd || process.cwd() 向上找 .agents/install-manifest.json（hook 进程
//      cwd 不可依赖，同仓内 pretool-risk 口径）；非插件仓 → exit 0 零写入。
const fs = require('node:fs');
const path = require('node:path');

const LEDGER_REL = '.agents/usage.jsonl';

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agents', 'install-manifest.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function nonNegative(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 载荷 → usage 行。返回 null = 无可采凭据（零写入），不抛错。
function buildRow(data) {
  const response = data && typeof data === 'object' ? data.tool_response : null;
  if (!response || typeof response !== 'object') return null;
  const usage = response.usage;
  const input = nonNegative(usage && typeof usage === 'object' ? usage.input_tokens : null);
  const output = nonNegative(usage && typeof usage === 'object' ? usage.output_tokens : null);
  if (input == null && output == null) return null; // 关键 token 字段缺失：不推测、零写入
  const row = {
    ts: new Date().toISOString(),
    role: 'agent',
    model: String(response.resolvedModel || '').trim() || 'unknown',
  };
  const agentId = String(response.agentId || '').trim();
  if (agentId) row.run = agentId;
  if (input != null) row.inputTokens = input;
  if (output != null) row.outputTokens = output;
  const latency = nonNegative(response.totalDurationMs);
  if (latency != null) row.latencyMs = latency;
  return row;
}

function collect() {
  let input = Buffer.alloc(0);
  try { input = fs.readFileSync(0); } catch { /* 无 stdin = 无凭据 */ }
  if (!input.length) process.exit(0);
  let data;
  try { data = JSON.parse(input.toString('utf8')); } catch { process.exit(0); }
  const cwd = data && typeof data === 'object' ? data.cwd : null;
  const root = findRoot(cwd || process.cwd());
  if (!root) process.exit(0); // 非插件仓：no-op
  const row = buildRow(data);
  if (!row) process.exit(0);
  try {
    fs.mkdirSync(path.join(root, path.dirname(LEDGER_REL)), { recursive: true });
    fs.appendFileSync(path.join(root, LEDGER_REL), `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* 台账不可写：观测腿不拦截会话，静默退出 */ }
  process.exit(0);
}

// CLI 守卫：只在被直接执行时消费 stdin（宿主接线为直执行，node <file> 的 argv[1] 即本文件）；
// 被 require 时无副作用。观测腿恒 exit 0——外层再兜一层，任何未预期异常也不阻塞宿主会话。
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try { collect(); } catch { process.exit(0); }
}
