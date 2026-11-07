#!/usr/bin/env node
// agent-pipelines 可视化渲染：把状态文件 + 事件日志 + 依赖图渲染成自包含 HTML。
// 用法：node scripts/render.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json [--out .loop-cli/state/coding-pipeline.html]
// 数据只读：不写状态文件，不取锁，不追加事件。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.mjs";
import { analyzeDependencies } from "./dag.mjs";
import { readEvents } from "./state-persist.mjs";
// STATUS 与 state.mjs 的 TASK_STATUS 是同一份枚举（单源 pipelines.mjs），这里沿用局部别名
import { PIPELINES, STOP_REASONS, TASK_STATUS as STATUS } from "./pipelines.mjs";

function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}

export function pipelineOf(args) {
  const pipeline = typeof args.pipeline === "string" ? args.pipeline : "coding";
  // 校验失败直接 fail 而非 throw（2026-11-07，对齐 state.mjs 的 pipelineOf 与 args.mjs 的 parseArgs）：
  // 此前抛 Error 无人接——render.main 不 try/catch、serve.mjs 在模块顶层裸调（无 main 守卫），
  // bogus --pipeline 崩栈 exit 1，恰是契约里的 FAIL 码；契约要求参数错误 → 一行干净报错 + 退出码 2。
  if (!PIPELINES[pipeline]) fail(`--pipeline must be one of: ${Object.keys(PIPELINES).join(", ")}`);
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

// 依赖图：分层列 + 拓扑序，算法走 dag.mjs 单源（与 graph.mjs 的 CLI 共用，2026-10-28 合并）
export function layoutGraph(tasks) {
  const { layer, order, cycles, errors } = analyzeDependencies(tasks);
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
  // 2026-11-01 修复史：此前本函数只打开当前一个文件，而 state.mjs 在 5 MiB 处轮转——轮转发生后
  // 看板与静态 HTML 上的历史事件静默消失（render/serve 读得到状态、读不到早段事件）。
  // README.md:67 的「合并轮转段」承诺此前只写在 events 子命令那一段，render 侧没兑现。
  // 修复时曾内联一份「轮转段 `.1` 在前、当前段在后」的合并读；双实现去重后读取委托
  // state-persist.readEvents 单源（同一口径）。这里只剩 render 侧的消费守卫：
  // 损坏日志里的非对象行（如裸 `null` 行）不进渲染——renderEventRow 会对 null 取属性崩溃。
  return readEvents(file, 0).filter((event) => event && typeof event === "object");
}

export function buildHtml({ pipeline, file, state, events, graph, warnings, live = false }) {
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
${live ? `<script>
// 实时看板客户端（2026-10-28）：serve.mjs 在状态/事件变化时推送 \`render\` 事件，这里只负责重载。
// 此前服务端 SSE 与事件都写好了，页面里却没有客户端——README 宣称的「浏览器自动刷新」实际不生效。
// 仅 serve 模式注入：静态导出（render --out）没有 /events，EventSource 会反复重连并刷控制台错误。
(() => {
  const es = new EventSource('/events');
  es.addEventListener('render', () => location.reload());
})();
</script>` : ''}
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { boolean: ["json"], value: ["pipeline", "file", "out"] });
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
  // 显式 --out 指向已存在的非 .html 文件时拒绝（2026-11-05）：上面两条只拦派生碰撞，
  // `--out <state>.events.jsonl` 这类显式路径仍会被 HTML 静默覆盖——事件日志是唯一不可重建的
  // 运行记录，其他 .json 也可能是状态/数据文件。只拦「已存在」的文件：重复渲染到同一 .html
  // 与首渲染到新路径的合法流程不受影响。
  if (args.out && existsSync(out) && path.extname(out) !== ".html") {
    fail(`--out refuses to overwrite an existing non-HTML file: ${out} (event logs and state files cannot be rebuilt); pass a .html path`);
  }
  // 显式 --out 命中事件日志/边车标记的派生路径时无条件拒绝（2026-11-07，审计 m3 及续单）：上一条
  // 只拦「已存在」，拦不住尚未诞生的派生文件——`render --out <状态>.events.jsonl` 首次 exit 0 把
  // HTML 写进未来日志路径，此后 state.mjs 首次 write 会把 JSONL 追加进 HTML；`--out
  // <状态>.promise.json` 同理，promise 子命令的 tmp+rename 此后会把整个 HTML 顶掉。派生规则与
  // state-persist 同款（eventsFile：同目录、基名 .json → .events.jsonl；promiseFile：.json →
  // .promise.json），轮转段 `.1` 一并 reserved；默认输出是 .html，永不命中。
  const eventsLog = path.join(path.dirname(file), `${path.basename(file).replace(/\.json$/, "")}.events.jsonl`);
  const promisePath = `${file.replace(/\.json$/, "")}.promise.json`;
  if (out === eventsLog || out === `${eventsLog}.1` || out === promisePath) {
    fail(`--out refuses a reserved state-derived path: ${out} (${path.basename(eventsLog)} / ${path.basename(promisePath)} are written by state.mjs whether or not they exist yet); pass a .html path`);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, buildHtml({ pipeline, file, state, events, graph, warnings }), "utf8");
  if (args.json) console.log(JSON.stringify({ file, out, events: events.length, graph }));
  else console.log(`Rendered ${out} (${tasks.length} tasks, ${events.length} events)`);
}

// 只在直接执行本脚本时渲染；被 serve.mjs import 时不产生任何副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();