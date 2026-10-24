#!/usr/bin/env node
// agent-pipelines 状态机辅助：init / validate / write / gate。
// 提示词仍是主入口；宿主能执行 shell 时用本脚本落盘与判停，不能执行时退回 SKILL 里的手写规则。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

const PIPELINES = {
  ralph: { maxCycles: 10, stallMax: 3 },
  coding: { maxCycles: 8, stallMax: 2 },
};
const TASK_STATUS = new Set(["pending", "in_progress", "done", "blocked"]);
const STOP_REASONS = new Set([null, "DONE", "ESCALATE", "HOLD", "STALL", "MAX_CYCLES", "STOPPED"]);

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
  const pipeline = args.pipeline;
  if (!PIPELINES[pipeline]) fail(`--pipeline must be one of: ${Object.keys(PIPELINES).join(", ")}`);
  return pipeline;
}

function stateFile(args, pipeline) {
  if (args.file) return path.resolve(String(args.file));
  return path.resolve(".loop-cli", "state", `${pipeline}.json`);
}

function writeAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function readState(file) {
  if (!existsSync(file)) fail(`state file not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`state file is not valid JSON (${file}): ${err.message}`);
  }
}

const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 2000;

function eventsFile(file) {
  const base = path.basename(file).replace(/\.json$/, "");
  return path.join(path.dirname(file), `${base}.events.jsonl`);
}

function logEvent(file, pipeline, event, state, extra = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pipeline,
      file,
      round: state && state.round,
      stop_reason: state ? state.stop_reason ?? null : null,
      tasks:
        state && Array.isArray(state.tasks)
          ? { done: state.tasks.filter((task) => task && task.status === "done").length, total: state.tasks.length }
          : undefined,
      pid: process.pid,
      ...extra,
    });
    appendFileSync(eventsFile(file), `${line}\n`, "utf8");
  } catch {}
}

function readEvents(file, tail) {
  const log = eventsFile(file);
  if (!existsSync(log)) return [];
  const events = [];
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return tail > 0 ? events.slice(-tail) : events;
}

// 写状态与 gate --apply 共用一把锁：同一仓库两个会话同时写时串行化，避免整份覆盖。
function withLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      try {
        return fn();
      } finally {
        try {
          unlinkSync(lock);
        } catch {}
      }
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) fail(`state file is locked by another process: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateState(state, pipeline) {
  const errors = [];
  const warnings = [];
  if (!isObject(state)) return { errors: ["state must be a JSON object"], warnings };
  if (state.version !== 1) errors.push("version must be 1");
  if (typeof state.prompt !== "string" || state.prompt.trim() === "") errors.push("prompt must be a non-empty string");
  if (!Number.isInteger(state.max_iterations) || state.max_iterations < 0) errors.push("max_iterations must be an integer >= 0");
  if (!Number.isInteger(state.max_failures) || state.max_failures < 1) errors.push("max_failures must be an integer >= 1");
  if (typeof state.retry_on_failure !== "boolean") errors.push("retry_on_failure must be a boolean");
  if (!(state.completion_promise === null || typeof state.completion_promise === "string")) {
    errors.push("completion_promise must be null or a string");
  }
  if (!Number.isInteger(state.outer_iteration) || state.outer_iteration < 0) errors.push("outer_iteration must be an integer >= 0");
  if (!Number.isInteger(state.consecutive_failures) || state.consecutive_failures < 0) {
    errors.push("consecutive_failures must be an integer >= 0");
  }
  if (!Number.isInteger(state.stall_counter) || state.stall_counter < 0) errors.push("stall_counter must be an integer >= 0");
  if (!Number.isInteger(state.round) || state.round < 0) errors.push("round must be an integer >= 0");
  if (!STOP_REASONS.has(state.stop_reason ?? null)) {
    errors.push(`stop_reason must be one of: ${[...STOP_REASONS].filter(Boolean).join(", ")} or null`);
  }
  if (!Array.isArray(state.fail_history)) errors.push("fail_history must be an array");
  else if (state.fail_history.length > 10) warnings.push("fail_history has more than 10 entries; the orchestrator should keep the latest 10");
  if (!Array.isArray(state.tasks)) errors.push("tasks must be an array");
  else {
    const ids = new Set();
    for (const task of state.tasks) {
      if (!isObject(task)) {
        errors.push("each task must be an object");
        continue;
      }
      if (typeof task.id !== "string" || task.id.trim() === "") errors.push("task.id must be a non-empty string");
      else if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
      else ids.add(task.id);
      if (typeof task.title !== "string" || task.title.trim() === "") errors.push(`task ${task.id}: title must be a non-empty string`);
      if (!TASK_STATUS.has(task.status)) errors.push(`task ${task.id}: invalid status ${JSON.stringify(task.status)}`);
      if (!Array.isArray(task.depends_on) || task.depends_on.some((d) => typeof d !== "string")) {
        errors.push(`task ${task.id}: depends_on must be an array of strings`);
      }
      if (!Array.isArray(task.accept_criteria) || task.accept_criteria.some((c) => typeof c !== "string")) {
        errors.push(`task ${task.id}: accept_criteria must be an array of strings`);
      }
      if (!Number.isInteger(task.failures) || task.failures < 0) errors.push(`task ${task.id}: failures must be an integer >= 0`);
    }
    for (const task of state.tasks) {
      if (!isObject(task) || !Array.isArray(task.depends_on)) continue;
      for (const dep of task.depends_on) {
        if (!ids.has(dep)) errors.push(`task ${task.id}: depends_on references unknown task ${dep}`);
        if (dep === task.id) errors.push(`task ${task.id}: depends_on must not reference itself`);
      }
      if (task.subtask_of !== undefined && !ids.has(task.subtask_of)) {
        errors.push(`task ${task.id}: subtask_of references unknown task ${task.subtask_of}`);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const byId = new Map(state.tasks.filter(isObject).map((t) => [t.id, t]));
    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        errors.push(`dependency cycle detected at task ${id}`);
        return;
      }
      visiting.add(id);
      const task = byId.get(id);
      if (task && Array.isArray(task.depends_on)) for (const dep of task.depends_on) if (byId.has(dep)) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of byId.keys()) visit(id);
  }
  if (pipeline === "coding") {
    if (typeof state.prior_cycles_summary !== "string") errors.push("coding: prior_cycles_summary must be a string");
    if (!Array.isArray(state.critical_checkpoints)) errors.push("coding: critical_checkpoints must be an array");
    else {
      for (const checkpoint of state.critical_checkpoints) {
        if (!isObject(checkpoint) || typeof checkpoint.id !== "string" || typeof checkpoint.description !== "string" || typeof checkpoint.passed !== "boolean") {
          errors.push("coding: each critical_checkpoint needs id, description and passed");
        }
      }
    }
    if (state.scope_drift !== undefined && !["PASS", "FAIL", null].includes(state.scope_drift)) {
      errors.push("coding: scope_drift must be PASS, FAIL or null when present");
    }
    if (state.scope !== undefined && !isObject(state.scope)) errors.push("coding: scope must be an object when present");
  }
  return { errors, warnings };
}

function gateFor(state, pipeline) {
  const spec = PIPELINES[pipeline];
  const maxCycles = state.max_iterations > 0 ? state.max_iterations : spec.maxCycles;
  const stallMax = spec.stallMax;
  if (state.stop_reason) return { stop_reason: state.stop_reason, reason: "already stopped" };
  const tasks = state.tasks;
  if (tasks.length > 0 && tasks.every((t) => t.status === "done")) {
    return { stop_reason: "DONE", reason: "all tasks are done" };
  }
  if (state.consecutive_failures >= state.max_failures) {
    return { stop_reason: "ESCALATE", reason: `consecutive_failures ${state.consecutive_failures} >= max_failures ${state.max_failures}` };
  }
  if (pipeline === "coding" && state.scope_drift === "FAIL") {
    return { stop_reason: "ESCALATE", reason: "scope_drift is FAIL" };
  }
  if (tasks.some((t) => t.status === "blocked") && tasks.every((t) => t.status === "done" || t.status === "blocked")) {
    return { stop_reason: "HOLD", reason: "only blocked tasks remain" };
  }
  if (state.stall_counter >= stallMax) {
    return { stop_reason: "STALL", reason: `stall_counter ${state.stall_counter} >= ${stallMax}` };
  }
  if (state.round >= maxCycles) {
    return { stop_reason: "MAX_CYCLES", reason: `round ${state.round} >= ${maxCycles}` };
  }
  return { stop_reason: null, reason: "continue" };
}

function applyGate(file, state, result) {
  if (result.stop_reason && state.stop_reason !== result.stop_reason) {
    state.stop_reason = result.stop_reason;
    writeAtomic(file, state);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!command || !["init", "validate", "write", "gate", "events"].includes(command)) {
    fail("usage: state.mjs init|validate|write|gate|events --pipeline ralph|coding [--file <path>] [--json]");
  }
  const pipeline = pipelineOf(args);
  const file = stateFile(args, pipeline);

  if (command === "init") {
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) fail("init requires --prompt");
    const base = {
      version: 1,
      prompt,
      max_iterations: 0,
      max_failures: 3,
      retry_on_failure: false,
      completion_promise: null,
      outer_iteration: 0,
      tasks: [],
      consecutive_failures: 0,
      stall_counter: 0,
      fail_history: [],
      round: 0,
      stop_reason: null,
    };
    if (pipeline === "coding") {
      base.prior_cycles_summary = "";
      base.critical_checkpoints = [];
    }
    const { errors } = validateState(base, pipeline);
    if (errors.length) fail(errors.join("\n"));
    withLock(file, () => {
      writeAtomic(file, base);
      logEvent(file, pipeline, "init", base);
    });
    if (args.json) console.log(JSON.stringify({ file, state: base }));
    else console.log(`Initialized ${file}`);
    return;
  }

  if (command === "write") {
    let state;
    try {
      state = JSON.parse(readFileSync(0, "utf8"));
    } catch (err) {
      fail(`stdin must be a JSON state object: ${err.message}`);
    }
    const { errors, warnings } = validateState(state, pipeline);
    if (errors.length) fail(`invalid state:\n- ${errors.join("\n- ")}`);
    withLock(file, () => {
      writeAtomic(file, state);
      logEvent(file, pipeline, "write", state);
    });
    if (args.json) console.log(JSON.stringify({ file, warnings }));
    else console.log(`Wrote ${file}${warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""}`);
    return;
  }

  if (command === "events") {
    const requested = Number(args.tail);
    const tail = Number.isInteger(requested) && requested > 0 ? requested : 20;
    const events = readEvents(file, tail);
    if (args.json) console.log(JSON.stringify({ file, events }));
    else {
      for (const event of events) {
        const tasks = event.tasks ? ` tasks ${event.tasks.done}/${event.tasks.total}` : "";
        console.log(`${event.ts} ${event.event} round=${event.round ?? "-"} stop=${event.stop_reason ?? "null"}${tasks}`);
      }
    }
    return;
  }

  const state = readState(file);
  const { errors, warnings } = validateState(state, pipeline);
  if (command === "validate") {
    if (args.json) console.log(JSON.stringify({ file, valid: errors.length === 0, errors, warnings }));
    else {
      console.log(errors.length ? `Invalid ${file}` : `Valid ${file}`);
      for (const error of errors) console.log(`- ${error}`);
      for (const warning of warnings) console.log(`warning: ${warning}`);
    }
    if (errors.length) process.exit(1);
    return;
  }

  if (errors.length) fail(`invalid state:\n- ${errors.join("\n- ")}`);
  const result = gateFor(state, pipeline);
  if (args.apply) {
    withLock(file, () => {
      applyGate(file, state, result);
      logEvent(file, pipeline, "gate", state, { applied: Boolean(result.stop_reason) });
    });
  }
  if (args.json) console.log(JSON.stringify({ file, ...result, applied: Boolean(args.apply) }));
  else console.log(`stop_reason=${result.stop_reason ?? "null"} (${result.reason})`);
}

main();
