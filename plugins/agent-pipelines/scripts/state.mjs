#!/usr/bin/env node
// agent-pipelines 状态机辅助：init / validate / write / gate。
// 提示词仍是主入口；宿主能执行 shell 时用本脚本落盘与判停，不能执行时退回 SKILL 里的手写规则。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "./args.mjs";

const PIPELINES = {
  ralph: { maxCycles: 10, stallMax: 3 },
  coding: { maxCycles: 8, stallMax: 2 },
};
const TASK_STATUS = new Set(["pending", "in_progress", "done", "blocked"]);
const STOP_REASONS = new Set([null, "DONE", "ESCALATE", "BUDGET", "HOLD", "STALL", "MAX_CYCLES", "STOPPED"]);

function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}

function pipelineOf(args) {
  const pipeline = args.pipeline;
  if (!PIPELINES[pipeline]) fail(`--pipeline must be one of: ${Object.keys(PIPELINES).join(", ")}`);
  return pipeline;
}

function stateFile(args, pipeline) {
  if (args.file) return path.resolve(String(args.file));
  return path.resolve(".loop-cli", "state", `${pipeline}-pipeline.json`);
}

// 管道状态与 <file>.events.jsonl 事件日志是运行垃圾（事件行里带任务笔记与代理输出），
// 落在使用项目的仓库里、却没有任何一处忽略它——顺手 git add -A 就把过程噪声提交进主干。
// 写 .git/info/exclude 而不是用户的 .gitignore：本地生效、不改跟踪文件、不给 PR 制造 diff 噪声。
// 仅在状态确实落在本仓 .loop-cli/ 下时登记（--file 指到别处就不动别人的仓库配置）。
// 失败一律静默：这是卫生便利，不该让 init 因此红。
function ensureStateIgnored(file) {
  const loopRoot = path.join(process.cwd(), ".loop-cli");
  const rel = path.relative(loopRoot, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  let out;
  try {
    out = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return; // 不在 git 仓库 / 无 git
  }
  const pointer = String(out).trim();
  if (!pointer) return;
  const excludeFile = path.resolve(process.cwd(), pointer);
  const rule = ".loop-cli/";
  try {
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === rule)) return;
    mkdirSync(path.dirname(excludeFile), { recursive: true });
    appendFileSync(
      excludeFile,
      `${current === "" || current.endsWith("\n") ? "" : "\n"}# agent-pipelines 管道状态与事件日志\n${rule}\n`,
      "utf8",
    );
  } catch {
    /* 只读仓库 / 权限问题：跳过登记 */
  }
}

function writeAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // 清理同 pid 的陈旧 tmp（进程被 kill -9 残留）：writeFileSync 以 w 模式覆盖，写坏也无妨
    try {
      unlinkSync(tmp);
    } catch {}
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// readState 的非退出版本：gate --apply 要在锁内读状态，而锁内 process.exit 不会跑 withLock 的 finally、
// 会把锁留在盘上，因此读取错误先带出锁外，由调用方统一 fail（错误信息与 readState 完全一致）。
function readStateSoft(file) {
  if (!existsSync(file)) return { error: `state file not found: ${file}` };
  try {
    return { state: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { error: `state file is not valid JSON (${file}): ${err.message}` };
  }
}

function readState(file) {
  const { state, error } = readStateSoft(file);
  if (error) fail(error);
  return state;
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
      // 相对路径（相对 cwd）：事件日志可能随仓库分发，绝对路径会泄露本机目录结构
      file: path.relative(process.cwd(), file) || path.basename(file),
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

// 对比旧状态与新状态，输出任务状态迁移列表 [{ id, from, to }]。
// - 已有任务：状态变化时记录 from（旧状态）→ to（新状态）。
// - 新任务：from 为 null，表示本轮注册。
// - 旧状态不存在、解析失败或字段缺失时返回空数组，不影响主写入流程。
function diffTaskStatus(file, nextState) {
  if (!existsSync(file)) return [];
  let prev;
  try {
    prev = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(prev.tasks) || !Array.isArray(nextState.tasks)) return [];
  const prevById = new Map(prev.tasks.filter(isObject).map((task) => [task.id, task]));
  const transitions = [];
  for (const task of nextState.tasks) {
    if (!isObject(task) || typeof task.id !== "string") continue;
    const prevTask = prevById.get(task.id);
    if (!prevTask) {
      transitions.push({ id: task.id, from: null, to: task.status });
      continue;
    }
    if (prevTask.status === task.status) continue;
    transitions.push({ id: task.id, from: prevTask.status, to: task.status });
  }
  return transitions;
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
        const mtimeMs = statSync(lock).mtimeMs;
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          // 二次 stat 防误删：第一次判陈旧后、unlink 前，锁可能已被原持有者重建；
          // mtime 变了就放弃接管，走下方等待/失败路径。第二次 stat 与 unlink 之间仍残余极窄竞态，属有意取舍。
          if (statSync(lock).mtimeMs === mtimeMs) {
            unlinkSync(lock);
            continue;
          }
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
  if (state.budget !== undefined) {
    if (!isObject(state.budget)) errors.push("budget must be an object when present");
    else {
      if (state.budget.max_tokens === undefined && state.budget.max_cost_usd === undefined) {
        errors.push("budget requires max_tokens or max_cost_usd");
      }
      for (const key of ["max_tokens", "max_cost_usd", "spent_tokens", "spent_cost_usd"]) {
        const value = state.budget[key];
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          errors.push(`budget.${key} must be a number >= 0`);
        }
      }
    }
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
      if (task.max_attempts !== undefined && (!Number.isInteger(task.max_attempts) || task.max_attempts < 1)) {
        errors.push(`task ${task.id}: max_attempts must be an integer >= 1 when present`);
      }
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
  // coding 零容忍：scope_drift=FAIL 时不允许 DONE（任何越界都必须人工裁决，落到下方 ESCALATE）
  const scopeBlocked = pipeline === "coding" && state.scope_drift === "FAIL";
  if (tasks.length > 0 && tasks.every((t) => t.status === "done") && !scopeBlocked) {
    return { stop_reason: "DONE", reason: "all tasks are done" };
  }
  if (state.consecutive_failures >= state.max_failures) {
    return { stop_reason: "ESCALATE", reason: `consecutive_failures ${state.consecutive_failures} >= max_failures ${state.max_failures}` };
  }
  // 单任务尝试上限：任一任务的 failures 达到自身 max_attempts（或默认上限），立即 ESCALATE，避免单任务无限重试。
  const attemptLimit = 4; // 默认单任务尝试上限
  for (const task of tasks) {
    if (!task || typeof task.failures !== "number") continue;
    const limit = Number.isInteger(task.max_attempts) && task.max_attempts > 0 ? task.max_attempts : attemptLimit;
    if (task.failures >= limit) {
      return { stop_reason: "ESCALATE", reason: `task ${task.id} failures ${task.failures} >= max_attempts ${limit}` };
    }
  }
  if (pipeline === "coding" && state.scope_drift === "FAIL") {
    return { stop_reason: "ESCALATE", reason: "scope_drift is FAIL" };
  }
  if (state.budget) {
    const budget = state.budget;
    const tokensSpent = budget.spent_tokens ?? 0;
    const costSpent = budget.spent_cost_usd ?? 0;
    if ((budget.max_tokens !== undefined && tokensSpent >= budget.max_tokens) || (budget.max_cost_usd !== undefined && costSpent >= budget.max_cost_usd)) {
      return { stop_reason: "BUDGET", reason: `budget exhausted (tokens ${tokensSpent}/${budget.max_tokens ?? "-"}, cost ${costSpent}/${budget.max_cost_usd ?? "-"})` };
    }
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
    // 防误覆盖：带进度的状态（非空任务列表、已推进轮次或已停止）不允许静默 init 覆盖。
    // 只看任务数会漏掉「空任务但 round>0 / 已 stop」的进行中管道。
    // 检测在锁内完成（避免 TOCTOU），fail 放在锁外——process.exit 不会跑 withLock 的 finally，锁内 fail 会把锁留在盘上
    let existingProgress = false;
    withLock(file, () => {
      if (!args.force && existsSync(file)) {
        try {
          const existing = JSON.parse(readFileSync(file, "utf8"));
          existingProgress = Boolean(
            existing &&
            (Array.isArray(existing.tasks) ? existing.tasks.length : 0) > 0 ||
              (existing && (existing.round > 0 || existing.stop_reason != null)),
          );
        } catch {
          existingProgress = true; // 旧文件损坏也按有进度处理，交给 --force 决定，避免静默覆盖
        }
      }
      if (!existingProgress) {
        writeAtomic(file, base);
        logEvent(file, pipeline, "init", base);
      }
    });
    if (existingProgress) {
      fail(`refusing to overwrite existing state (has progress): pass --force to start over, or use write to update it`);
    }
    ensureStateIgnored(file);
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
      const transitions = diffTaskStatus(file, state);
      writeAtomic(file, state);
      logEvent(file, pipeline, "write", state, { transitions });
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
        const transitions = Array.isArray(event.transitions) && event.transitions.length
          ? ` [${event.transitions.map((t) => `${t.id}:${t.from}->${t.to}`).join(", ")}]`
          : "";
        console.log(`${event.ts} ${event.event} round=${event.round ?? "-"} stop=${event.stop_reason ?? "null"}${tasks}${transitions}`);
      }
    }
    return;
  }

  if (command === "validate") {
    const state = readState(file);
    const { errors, warnings } = validateState(state, pipeline);
    if (args.json) console.log(JSON.stringify({ file, valid: errors.length === 0, errors, warnings }));
    else {
      console.log(errors.length ? `Invalid ${file}` : `Valid ${file}`);
      for (const error of errors) console.log(`- ${error}`);
      for (const warning of warnings) console.log(`warning: ${warning}`);
    }
    if (errors.length) process.exit(1);
    return;
  }

  if (!args.apply) {
    // 只判不写，无并发覆盖风险：保持锁外读取
    const state = readState(file);
    const { errors } = validateState(state, pipeline);
    if (errors.length) fail(`invalid state:\n- ${errors.join("\n- ")}`);
    const result = gateFor(state, pipeline);
    if (args.json) console.log(JSON.stringify({ file, ...result, applied: false }));
    else console.log(`stop_reason=${result.stop_reason ?? "null"} (${result.reason})`);
    return;
  }

  // gate --apply：读-判-写全程持锁。readState 若在锁外执行，拿到的是陈旧快照，
  // applyGate 会用整份旧对象覆盖并发会话刚写入的状态，违背 withLock「避免整份覆盖」的设计目标。
  let result = null;
  let applyErrors = null;
  let readError = null;
  withLock(file, () => {
    const read = readStateSoft(file);
    if (read.error) {
      readError = read.error;
      return;
    }
    applyErrors = validateState(read.state, pipeline).errors;
    if (applyErrors.length > 0) return;
    result = gateFor(read.state, pipeline);
    applyGate(file, read.state, result);
    logEvent(file, pipeline, "gate", read.state, { applied: Boolean(result.stop_reason) });
  });
  // fail 统一放锁外：process.exit 不会跑 withLock 的 finally，锁内退出会把锁留在盘上
  if (readError) fail(readError);
  if (applyErrors && applyErrors.length > 0) fail(`invalid state:\n- ${applyErrors.join("\n- ")}`);
  if (args.json) console.log(JSON.stringify({ file, ...result, applied: true }));
  else console.log(`stop_reason=${result.stop_reason ?? "null"} (${result.reason})`);
}

main();
