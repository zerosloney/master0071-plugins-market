#!/usr/bin/env node
// agent-pipelines 可视化渲染：把状态文件 + 事件日志 + 依赖图渲染成自包含 HTML。
// 用法：node scripts/render.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json [--out .loop-cli/state/coding-pipeline.html]
// 数据只读：不写状态文件，不取锁，不追加事件。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.mjs";

const PIPELINES = {
  ralph: { label: "Ralph Pipeline", color: "#6366f1" },
  coding: { label: "Coding Pipeline", color: "#0f766e" },
};
const STATUS = new Set(["pending", "in_progress", "done", "blocked"]);
const STOP_REASONS = new Set([null, "DONE", "ESCALATE", "BUDGET", "HOLD", "STALL", "MAX_CYCLES", "STOPPED"]);

function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}

export function pipelineOf(args) {
  const pipeline = typeof args.pipeline === "string" ? args.pipeline : "coding";
  if (!PIPELINES[pipeline]) throw new Error(`--pipeline must be one of: ${Object.keys(PIPELINES).join(", ")}`);
  return pipeline;
}

export function stateFile(args, pipeline) {
  if (args.file) return path.resolve(String(args.file));
  return path.resolve(".loop-cli", "state", `${pipeline}-pipeline.json`);
}

export function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonBlock(value) {
  return `<pre class="code">${htmlEscape(JSON.stringify(value, null, 2))}</pre>`;
}

// 依赖图：拓扑排序 + 分层列（复用 graph.mjs 的算法，只读不落盘）
export function layoutGraph(tasks) {
  const ids = tasks.map((task) => task && task.id).filter((id) => typeof id === "string");
  const idSet = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));
  const errors = [];
  for (const task of tasks) {
    if (!task || typeof task.id !== "string") {
      errors.push("task without a string id");
      continue;
    }
    for (const dep of Array.isArray(task.depends_on) ? task.depends_on : []) {
      if (!idSet.has(dep)) {
        errors.push(`task ${task.id}: unknown dependency ${dep}`);
        continue;
      }
      next.get(dep).push(task.id);
      indegree.set(task.id, indegree.get(task.id) + 1);
    }
  }
  // 分层：层 = 最长依赖链长度；无依赖为 0 层
  // 兜底初值必须是 -1 而不是 0：get() ?? 0 会让首次访问的节点因 0 <= 0 直接返回，
  // layer 永远为空、全部任务挤在第 0 列（分层失效）。
  const layer = new Map();
  const visiting = new Set();
  const visit = (id, depth) => {
    const current = layer.get(id) ?? -1;
    if (depth <= current) return;
    if (visiting.has(id)) return; // 环防护：环内节点不再沿环加深，防止无限递归
    visiting.add(id);
    layer.set(id, depth);
    for (const child of next.get(id) || []) visit(child, depth + 1);
    visiting.delete(id);
  };
  for (const id of ids) if (indegree.get(id) === 0) visit(id, 0);
  for (const id of ids) if (!layer.has(id)) visit(id, 0); // 环内节点兜底
  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const dependent of next.get(id) || []) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  const cycles = ids.filter((id) => !order.includes(id));
  return { layer, order, cycles, errors };
}

// badge 的 kind 会拼进 class 属性：render/serve 刻意不跑 validateState，恶意仓库可预置状态文件与事件日志，
// kind 必须白名单化（4 个任务状态 + 事件徽标），未知值回退中性样式，防止属性逃逸注入 HTML。
const BADGE_KINDS = new Set([...STATUS, "event"]);
function badge(text, kind) {
  const safe = BADGE_KINDS.has(kind) ? kind : "event";
  return `<span class="badge badge-${safe}">${htmlEscape(text)}</span>`;
}

function renderTaskGraph(tasks, graph) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rows = [];
  const maxLayer = Math.max(0, ...tasks.map((task) => graph.layer.get(task.id) ?? 0));
  // .task 是绝对定位、脱离文档流：不显式设 top 时同层卡片按 CSS 静态位置规则会全部叠在容器顶部。
  // 同层任务按行堆叠，行高 110px 与 .graph 的 min-height 口径一致
  const rowOfLayer = new Map();
  for (const task of tasks) {
    const layer = graph.layer.get(task.id) ?? 0;
    const row = rowOfLayer.get(layer) ?? 0;
    rowOfLayer.set(layer, row + 1);
    const left = `${(layer / Math.max(1, maxLayer)) * 80}%`;
    const top = 18 + row * 110; // 18px 容器内边距 + 行号 × 110px
    const status = task.status;
    const depLines = (Array.isArray(task.depends_on) ? task.depends_on : [])
      .map((dep) => {
        const depTask = byId.get(dep);
        return depTask
          ? `<div class="dep"><span class="dep-from">${htmlEscape(dep)}</span> <span class="dep-arrow">→</span> <span class="dep-to">${htmlEscape(task.id)}</span></div>`
          : `<div class="dep dep-error">${htmlEscape(dep)} → ${htmlEscape(task.id)}（未知依赖）</div>`;
      })
      .join("");
    rows.push(
      `<div class="task" style="left:${left};top:${top}px">` +
        `<div class="task-head"><span class="task-id">${htmlEscape(task.id)}</span>${badge(status, status)}</div>` +
        `<div class="task-title">${htmlEscape(task.title)}</div>` +
        (task.failures > 0 ? `<div class="task-failures">failures: ${htmlEscape(String(task.failures))}</div>` : "") +
        (task.subtask_of ? `<div class="task-sub">⊂ ${htmlEscape(task.subtask_of)}</div>` : "") +
        (depLines ? `<div class="deps">${depLines}</div>` : "") +
        (Array.isArray(task.accept_criteria) && task.accept_criteria.length
          ? `<ul class="criteria">${task.accept_criteria.map((c) => `<li>${htmlEscape(c)}</li>`).join("")}</ul>`
          : "") +
        `</div>`,
    );
  }
  return `<div class="graph">${rows.join("")}</div>`;
}

function renderEventRow(event) {
  // round 与 tasks.done/total 来自事件日志，同样不能裸内插：恶意仓库可预置 .events.jsonl
  const tasks = event.tasks ? ` · tasks ${htmlEscape(`${event.tasks.done}/${event.tasks.total}`)}` : "";
  const applied = event.applied ? " · applied" : "";
  const transitions = Array.isArray(event.transitions) && event.transitions.length
    ? ` · ${event.transitions
        .map(
          (t) =>
            `${htmlEscape(t.id)}:${htmlEscape(t.from)}→${htmlEscape(t.to)}`,
        )
        .join(", ")}`
    : "";
  return `<li><code class="ts">${htmlEscape(event.ts)}</code> ${badge(event.event, "event")}<span class="ev-meta">round=${htmlEscape(String(event.round ?? "-"))} · stop=${htmlEscape(String(event.stop_reason ?? "null"))}${tasks}${applied}${transitions}</span></li>`;
}

function renderSummaryCards(state, graph) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const done = tasks.filter((t) => t && t.status === "done").length;
  const inProgress = tasks.filter((t) => t && t.status === "in_progress").length;
  const pending = tasks.filter((t) => t && t.status === "pending").length;
  const blocked = tasks.filter((t) => t && t.status === "blocked").length;
  const budget = state.budget
    ? `token ${state.budget.spent_tokens ?? 0}/${state.budget.max_tokens ?? "∞"} · cost $${state.budget.spent_cost_usd ?? 0}/${state.budget.max_cost_usd ?? "∞"}`
    : "未设置";
  return (
    `<div class="cards">` +
    `<div class="card"><div class="card-label">round</div><div class="card-value">${htmlEscape(String(state.round ?? 0))}</div></div>` +
    `<div class="card"><div class="card-label">tasks</div><div class="card-value">${tasks.length}</div><div class="card-sub">${done} done · ${inProgress} in_progress · ${pending} pending · ${blocked} blocked</div></div>` +
    `<div class="card"><div class="card-label">stop_reason</div><div class="card-value">${htmlEscape(String(state.stop_reason ?? "null"))}</div></div>` +
    `<div class="card"><div class="card-label">连续失败</div><div class="card-value">${htmlEscape(String(state.consecutive_failures ?? 0))}</div><div class="card-sub">max ${htmlEscape(String(state.max_failures ?? "-"))}</div></div>` +
    `<div class="card"><div class="card-label">stall</div><div class="card-value">${htmlEscape(String(state.stall_counter ?? 0))}</div></div>` +
    `<div class="card"><div class="card-label">预算</div><div class="card-value card-value-sm">${htmlEscape(budget)}</div></div>` +
    `</div>`
  );
}

export function loadState(file) {
  if (!existsSync(file)) throw new Error(`state file not found: ${file}`);
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`state file is not valid JSON: ${err.message}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state must be a JSON object");
  return state;
}

export function loadEvents(file) {
  const events = [];
  const eventsPath = file.replace(/\.json$/, ".events.jsonl");
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === "object") events.push(event);
      } catch {}
    }
  }
  return events;
}

export function buildHtml({ pipeline, file, state, events, graph, warnings }) {
  const spec = PIPELINES[pipeline];
  // 与 layoutGraph 的畸形条目口径一致：null/缺 id 的任务不进渲染（layoutGraph 已把它们记入 graph.errors），
  // 否则下方 rowsPerLayer 与 renderTaskGraph 对 null 条目取 task.id 直接 TypeError
  const tasks = (Array.isArray(state.tasks) ? state.tasks : []).filter((task) => task && typeof task.id === "string");
  const graphOk = graph.cycles.length === 0 && graph.errors.length === 0;
  const lastEvent = events[events.length - 1];
  // 容器高度按「最多任务的那一层」的行数算，而不是任务总数：卡片按 层=列、层内序=行 绝对定位
  const rowsPerLayer = new Map();
  for (const task of tasks) {
    const layer = graph.layer.get(task.id) ?? 0;
    rowsPerLayer.set(layer, (rowsPerLayer.get(layer) ?? 0) + 1);
  }
  const maxRows = Math.max(1, ...rowsPerLayer.values());
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${spec.label} · 状态 ${htmlEscape(String(state.stop_reason ?? "运行中"))}</title>
<style>
:root { color-scheme: light dark; --bg: #0f172a; --panel: #1e293b; --panel2: #273549; --border: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: ${spec.color}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 12px; color: var(--muted); border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; word-break: break-all; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.card-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.card-value { font-size: 20px; font-weight: 700; margin-top: 2px; }
.card-value-sm { font-size: 13px; font-weight: 500; }
.card-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
.warnings { background: var(--panel); border: 1px solid #f59e0b55; border-radius: 10px; padding: 10px 12px; margin: 16px 0; font-size: 13px; color: #fbbf24; }
.warnings ul { margin: 4px 0 0; padding-left: 18px; }
.graph { position: relative; min-height: ${Math.max(220, maxRows * 110 + 36)}px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 14px; }
.task { position: absolute; width: 300px; max-width: 90%; background: var(--panel2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 8px 10px; }
.task-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 2px; }
.task-id { font-weight: 700; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
.task-title { font-size: 13px; }
.task-failures { color: #f87171; font-size: 12px; }
.task-sub { color: var(--muted); font-size: 11px; }
.deps { margin-top: 6px; font-size: 11px; color: var(--muted); }
.dep-arrow { color: var(--accent); }
.dep-error { color: #f87171; }
.criteria { margin: 6px 0 0; padding-left: 16px; font-size: 12px; color: var(--muted); }
.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
.badge-pending { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b55; }
.badge-in_progress { background: #3b82f622; color: #60a5fa; border: 1px solid #3b82f655; }
.badge-done { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e55; }
.badge-blocked { background: #ef444422; color: #f87171; border: 1px solid #ef444455; }
.badge-event { background: var(--panel2); color: var(--muted); border: 1px solid var(--border); }
.badge-ok { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e55; }
.badge-warn { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b55; }
.events { list-style: none; padding: 0; margin: 0; }
.events li { padding: 8px 10px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.events li:nth-child(odd) { background: #ffffff05; }
.ts { font-size: 12px; color: var(--muted); }
.ev-meta { color: var(--muted); font-size: 12px; }
.code { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; }
.graph-warn { color: #f87171; }
.dep-list { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
<h1>${spec.label}</h1>
<div class="sub">${htmlEscape(file)} · 生成于 ${new Date().toISOString()}${lastEvent ? ` · 最近事件 ${htmlEscape(lastEvent.event)}` : ""}</div>
${warnings && warnings.length ? `<div class="warnings"><div class="warnings-label">渲染警告</div><ul>${warnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join("")}</ul></div>` : ""}
${renderSummaryCards(state, graph)}
${graphOk ? "" : `<div class="graph-warn">依赖图警告：${graph.cycles.length ? `存在环：${htmlEscape(graph.cycles.join(", "))}` : ""}${graph.errors.length ? " " + htmlEscape(graph.errors.join("；")) : ""}</div>`}
<h2>依赖图与任务状态</h2>
${renderTaskGraph(tasks, graph)}
<div class="dep-list">拓扑顺序：${htmlEscape(graph.order.join(" → ") || "(空)")}${graph.cycles.length ? ` · 环：${htmlEscape(graph.cycles.join(", "))}` : ""}</div>
<h2>执行轨迹（事件日志）</h2>
${events.length ? `<ul class="events">${events.map(renderEventRow).join("")}</ul>` : `<div class="sub">暂无事件；运行 <code>state.mjs write</code> 或 <code>gate --apply</code> 后这里会出现轨迹。</div>`}
<h2>状态 JSON</h2>
${jsonBlock(state)}
</div>
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pipeline = pipelineOf(args);
  const file = stateFile(args, pipeline);
  let state;
  try {
    state = loadState(file);
  } catch (err) {
    fail(err.message);
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const warnings = [];
  for (const task of tasks) {
    if (!task || typeof task.id !== "string") warnings.push("存在缺少 id 的任务");
    if (task && task.status !== undefined && !STATUS.has(task.status)) warnings.push(`任务 ${task.id} 状态非法：${task.status}`);
  }
  if (state.stop_reason !== undefined && !STOP_REASONS.has(state.stop_reason)) {
    warnings.push(`stop_reason 非法：${state.stop_reason}`);
  }

  const graph = layoutGraph(tasks);
  const events = loadEvents(file);

  const out = args.out ? path.resolve(String(args.out)) : file.replace(/\.json$/, ".html");
  // 输出路径不能就是状态文件：--file 不带 .json 后缀时 replace 不替换，out === file，
  // 渲染会直接覆盖状态文件（数据丢失）；同样拦截 out 是 .events.jsonl 派生路径的情况
  if (out === file) {
    fail(`output path resolves to the state file itself: ${file}; pass --out <path>.html explicitly`);
  }
  if (path.extname(file) !== ".json") {
    fail(`state file should have a .json extension (got ${file}): without it, the derived output and events paths collide`);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, buildHtml({ pipeline, file, state, events, graph, warnings }), "utf8");
  if (args.json) console.log(JSON.stringify({ file, out, events: events.length, graph }));
  else console.log(`Rendered ${out} (${tasks.length} tasks, ${events.length} events)`);
}

// 只在直接执行本脚本时渲染；被 serve.mjs import 时不产生任何副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();