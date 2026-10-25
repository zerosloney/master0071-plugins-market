#!/usr/bin/env node
// agent-pipelines 可视化渲染：把状态文件 + 事件日志 + 依赖图渲染成自包含 HTML。
// 用法：node scripts/render.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json [--out .loop-cli/state/coding-pipeline.html]
// 数据只读：不写状态文件，不取锁，不追加事件。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function pipelineOf(args) {
  const pipeline = typeof args.pipeline === "string" ? args.pipeline : "coding";
  if (!PIPELINES[pipeline]) fail(`--pipeline must be one of: ${Object.keys(PIPELINES).join(", ")}`);
  return pipeline;
}

function stateFile(args, pipeline) {
  if (args.file) return path.resolve(String(args.file));
  return path.resolve(".loop-cli", "state", `${pipeline}.json`);
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonBlock(value) {
  return `<pre class="code">${htmlEscape(JSON.stringify(value, null, 2))}</pre>`;
}

// 依赖图：拓扑排序 + 分层列（复用 graph.mjs 的算法，只读不落盘）
function layoutGraph(tasks) {
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
  const layer = new Map();
  const visit = (id, depth) => {
    const current = layer.get(id) ?? 0;
    if (depth <= current) return;
    layer.set(id, depth);
    for (const child of next.get(id) || []) visit(child, depth + 1);
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

function badge(text, kind) {
  return `<span class="badge badge-${kind}">${htmlEscape(text)}</span>`;
}

function renderTaskGraph(tasks, graph) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rows = [];
  const maxLayer = Math.max(0, ...tasks.map((task) => graph.layer.get(task.id) ?? 0));
  for (const task of tasks) {
    const layer = graph.layer.get(task.id) ?? 0;
    const left = `${(layer / Math.max(1, maxLayer)) * 80}%`;
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
      `<div class="task" style="left:${left}">` +
        `<div class="task-head"><span class="task-id">${htmlEscape(task.id)}</span>${badge(status, status)}</div>` +
        `<div class="task-title">${htmlEscape(task.title)}</div>` +
        (task.failures > 0 ? `<div class="task-failures">failures: ${task.failures}</div>` : "") +
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
  const tasks = event.tasks ? ` · tasks ${event.tasks.done}/${event.tasks.total}` : "";
  const applied = event.applied ? " · applied" : "";
  return `<li><code class="ts">${htmlEscape(event.ts)}</code> ${badge(event.event, "event")}<span class="ev-meta">round=${event.round ?? "-"} · stop=${htmlEscape(String(event.stop_reason ?? "null"))}${tasks}${applied}</span></li>`;
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
    `<div class="card"><div class="card-label">round</div><div class="card-value">${state.round ?? 0}</div></div>` +
    `<div class="card"><div class="card-label">tasks</div><div class="card-value">${tasks.length}</div><div class="card-sub">${done} done · ${inProgress} in_progress · ${pending} pending · ${blocked} blocked</div></div>` +
    `<div class="card"><div class="card-label">stop_reason</div><div class="card-value">${htmlEscape(String(state.stop_reason ?? "null"))}</div></div>` +
    `<div class="card"><div class="card-label">连续失败</div><div class="card-value">${state.consecutive_failures ?? 0}</div><div class="card-sub">max ${state.max_failures ?? "-"}</div></div>` +
    `<div class="card"><div class="card-label">stall</div><div class="card-value">${state.stall_counter ?? 0}</div></div>` +
    `<div class="card"><div class="card-label">预算</div><div class="card-value card-value-sm">${htmlEscape(budget)}</div></div>` +
    `</div>`
  );
}

function buildHtml({ pipeline, file, state, events, graph, warnings }) {
  const spec = PIPELINES[pipeline];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const graphOk = graph.cycles.length === 0 && graph.errors.length === 0;
  const lastEvent = events[events.length - 1];
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
.graph { position: relative; min-height: ${Math.max(220, tasks.length * 110)}px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 14px; }
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
  if (!existsSync(file)) fail(`state file not found: ${file}`);
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`state file is not valid JSON: ${err.message}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("state must be a JSON object");
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

  const out = args.out ? path.resolve(String(args.out)) : file.replace(/\.json$/, ".html");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, buildHtml({ pipeline, file, state, events, graph, warnings }), "utf8");
  if (args.json) console.log(JSON.stringify({ file, out, events: events.length, graph }));
  else console.log(`Rendered ${out} (${tasks.length} tasks, ${events.length} events)`);
}

main();