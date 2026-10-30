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
  // 只做存在性解析，**不做** cwd 限定（2026-10-29 的取舍）：
  // 真实危害是「init 把非状态文件覆盖成状态对象」（`init --file package.json` 实测 exit 0 并写坏
  // package.json），那条已由 init 分支的 foreignFile 检测堵住；而「状态文件放在项目外」本身没有
  // 破坏性——它只是落在没人读的位置。限定到 cwd 之下会误伤两类合法形态：monorepo 里从子包目录
  // 操作、以及测试/脚本用临时目录做夹具（equivalence 套件正是后者）。
  // 用一个更窄、无歧义的判据替代：拒绝写到文件系统根与家目录本身（那从来不是状态文件的位置）。
  if (args.file) {
    const resolved = path.resolve(String(args.file));
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const tooBroad =
      path.dirname(resolved) === resolved ||
      (home && (resolved === path.resolve(home) || resolved === path.resolve(home, "")));
    if (tooBroad) {
      fail(
        `--file must name a file, not a root/home directory: got ${resolved}\n` +
          `Pass e.g. ${path.join(resolved, ".loop-cli", "state", `${pipeline}-pipeline.json`)} instead.`,
      );
    }
    return resolved;
  }
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

// 事件日志上限（2026-10-28 市场审查）：无人值守长跑会让 <file>.events.jsonl 无界增长，而 readEvents
// 每次都全量读+解析。到上限即轮转：把当前文件改名为 .1（覆盖旧 .1），新行写新文件——最坏占用约
// 2×MAX，且保留最近一段历史供 `events` 子命令回看。轮转失败一律静默（观测面不得挡住主流程）。
const EVENTS_MAX_BYTES = 5 * 1024 * 1024;

function rotateEventsIfNeeded(log) {
  try {
    if (!existsSync(log)) return;
    if (statSync(log).size < EVENTS_MAX_BYTES) return;
    renameSync(log, `${log}.1`);
  } catch {
    /* 权限/竞态：跳过轮转，继续追加（宁可超限也不丢事件） */
  }
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
    const log = eventsFile(file);
    rotateEventsIfNeeded(log);
    appendFileSync(log, `${line}\n`, "utf8");
  } catch {}
}

function readEvents(file, tail) {
  const log = eventsFile(file);
  // 轮转文件（.1）在前、当前文件在后，保持时间序（.1 是较早的一段）。两者都可能不存在。
  const parts = [];
  for (const p of [`${log}.1`, log]) {
    if (!existsSync(p)) continue;
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue; // 读失败跳过该段，不因观测面挡住 events 输出
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        parts.push(JSON.parse(line));
      } catch {}
    }
  }
  return tail > 0 ? parts.slice(-tail) : parts;
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
      // root_cause_group（2026-10-29 补）此前只存在于提示词里：reviewer / builder / orchestrator
      // 三份 agent 文档都承诺「同一根因的多个 issue 共用同一 id，executor 一次修一组」，
      // 而脚本从不读它——写错类型、留空串、跨任务拼写漂移都无人发现，那句承诺无法被验证。
      // 现在至少把形状钉死：出现时必须是非空字符串。空串与纯空白是最常见的「占位符没填」。
      if (task.root_cause_group !== undefined
        && (typeof task.root_cause_group !== 'string' || task.root_cause_group.trim() === '')) {
        errors.push(`task ${task.id}: root_cause_group must be a non-empty string when present`);
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

// coding 硬门禁：scope 零容忍 + critical checkpoints 全部通过。
// 两条规则共用一条判定链——DONE 必须同时满足，否则给出可读原因（哪个 checkpoint 没通过），不静默放行。
// 此前 DONE 只看任务状态流转，passed=false 的硬门禁被跨过，流程提前进入收尾态。
// scope 未判定（undefined / null）不算越界，但同样不允许 DONE：判停依据不足就继续本轮补跑 scope。
// scope 的判据（2026-10-29 第二轮修复）：**不接受 state.scope_drift 作为 DONE 依据**。
// 状态文件是执行者可写的普通 JSON，写 scope_drift:"PASS" 就能过——实测越界文件 dist/leak.js
// 在场、状态自称 PASS，旧 gate 直接回 stop_reason=DONE。这与上一轮修的「预设 stop_reason」是
// 同一类问题，只是发生在更里一层：外层不再信预设终态，内层仍在信预设的 scope 结论。
// 现在 gate 自己按 git 现状重算：读 state.scope 的规则（hard/soft/forbidden/base）重新判定。
//   · PASS    → 放行（scope_drift 记成什么都不影响判据）
//   · FAIL    → 拦，reason 里指名越界文件
//   · unknown → 拦（无规则 / 不在 git 仓库）——判停依据不足，与「未判定」同档
// 口径必须与 scope.mjs 同宽（glob 语法、.loop-cli 排除、ignored 文件三类都算改动面），
// 由 test/regression.mjs 的对照用例锁住。这里只做最小复算，不反向依赖 scope.mjs 的 CLI。
function recheckScope(state, cwd) {
  const scope = isObject(state.scope) ? state.scope : null;
  if (!scope) return { state: "unknown", reason: "scope 未配置（DONE 需要 hard/soft/forbidden 规则）" };
  const rulesOf = (v) => (Array.isArray(v) ? v.map((x) => String(x).replace(/\\/g, "/")) : []);
  const hard = rulesOf(scope.hard);
  const soft = rulesOf(scope.soft);
  const forbidden = rulesOf(scope.forbidden);
  if (hard.length === 0 && soft.length === 0 && forbidden.length === 0) {
    return { state: "unknown", reason: "scope 规则为空（DONE 需要至少一条 hard/soft/forbidden）" };
  }
  const base = typeof scope.base === "string" && scope.base.trim() ? scope.base.trim() : "HEAD";
  if (base.startsWith("-") || /\s/.test(base)) {
    return { state: "unknown", reason: `scope.base 非法：${base}` };
  }
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  if (run(["rev-parse", "--show-toplevel"]) === null) {
    return { state: "unknown", reason: "不在 git 仓库内（无法复算 scope）" };
  }
  const changed = new Set();
  const add = (line) => {
    const f = line.trim().replace(/\\/g, "/");
    if (f && !f.startsWith(".loop-cli/")) changed.add(f);
  };
  const diffed = run(["diff", "--name-only", base]);
  if (diffed === null) return { state: "unknown", reason: `无法计算 ${base} 到工作区的变更清单` };
  for (const line of diffed.split("\n")) add(line);
  for (const line of (run(["ls-files", "--others", "--exclude-standard"]) || "").split("\n")) add(line);
  for (const line of (run(["ls-files", "--others", "--ignored", "--exclude-standard"]) || "").split("\n")) add(line);

  const glob = (pattern) => {
    let p = String(pattern).replace(/\\/g, "/").trim();
    if (p.endsWith("/")) p += "**";
    let src = "";
    for (let i = 0; i < p.length; i += 1) {
      const ch = p[i];
      if (ch === "*") {
        if (p[i + 1] === "*") { src += ".*"; i += 1; } else { src += "[^/]*"; }
      } else if (ch === "?") src += "[^/]";
      else if ("/.+()[]{}^$|\\".includes(ch)) src += `\\${ch}`;
      else src += ch;
    }
    return new RegExp(`^${src}$`);
  };
  const matchAny = (file, patterns) => patterns.some((p) => glob(p).test(file));
  const files = [...changed].sort();
  const forbiddenHits = files.filter((f) => matchAny(f, forbidden));
  const outside = files.filter((f) => !matchAny(f, hard) && !matchAny(f, soft) && !matchAny(f, forbidden));
  if (forbiddenHits.length > 0 || outside.length > 0) {
    const detail = [
      ...(forbiddenHits.length ? [`forbidden: ${forbiddenHits.join(", ")}`] : []),
      ...(outside.length ? [`outside scope: ${outside.join(", ")}`] : []),
    ].join("；");
    return { state: "FAIL", reason: `scope 复算 FAIL（${detail}）`, files };
  }
  return { state: "PASS", reason: `scope 复算 PASS（base ${base}，${files.length} 个变更文件）`, files };
}

// 按 root_cause_group 把任务分桶——「一次修一组」这句承诺的可执行形态。
// 没有分组的任务单独归到 ungrouped，不硬塞进某个组（那会凭空造出一个组）。
function groupTasksByRootCause(tasks) {
  const groups = new Map();
  const ungrouped = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(task) || typeof task.id !== 'string') continue;
    const key = typeof task.root_cause_group === 'string' ? task.root_cause_group.trim() : '';
    if (!key) {
      ungrouped.push({ id: task.id, status: task.status });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: task.id, status: task.status });
  }
  const describe = (entries) => {
    const done = entries.filter((e) => e.status === 'done').length;
    return { tasks: entries, done, total: entries.length, complete: entries.length > 0 && done === entries.length };
  };
  return {
    groups: [...groups.entries()].map(([id, entries]) => ({ id, ...describe(entries) })),
    ungrouped: describe(ungrouped),
  };
}

// continue 分支的「下一步」提示：还没修完的根因组按「全部完成后才能并行」的语义点名，
// 让 orchestrator 不必自己从 tasks[] 里再算一遍该派哪一组。
function nextRootCauseHint(state) {
  const { groups } = groupTasksByRootCause(state.tasks);
  const open = groups.filter((group) => !group.complete);
  if (open.length === 0) return '';
  const first = open[0];
  const pending = first.tasks.filter((t) => t.status !== 'done').map((t) => `${t.id}(${t.status})`);
  return `next root_cause_group=${first.id}（${first.done}/${first.total} done；未完成 ${pending.join(', ')}）`;
}

function codingGateBlockers(state, cwd) {
  const blockers = [];
  const checkpoints = Array.isArray(state.critical_checkpoints) ? state.critical_checkpoints : [];
  const failed = checkpoints
    .filter((checkpoint) => !isObject(checkpoint) || checkpoint.passed !== true)
    .map((checkpoint) => (isObject(checkpoint) && typeof checkpoint.id === "string" ? checkpoint.id : "(未命名)"));
  if (failed.length > 0) blockers.push(`critical checkpoints 未通过: ${failed.join(", ")}`);
  const actual = recheckScope(state, cwd);
  if (actual.state === "FAIL") blockers.push(`scope_drift=FAIL（${actual.reason}）`);
  else if (actual.state === "unknown") blockers.push(`scope 无法复算（${actual.reason}）——DONE 需要可复算的 scope`);
  return { blockers, actual };
}

function gateFor(state, pipeline, cwd = process.cwd()) {
  const spec = PIPELINES[pipeline];
  const maxCycles = state.max_iterations > 0 ? state.max_iterations : spec.maxCycles;
  const stallMax = spec.stallMax;
  const tasks = state.tasks;
  // coding 零容忍 + 硬门禁：DONE 要求 scope **复算**为 PASS 且 critical_checkpoints 全通过。
  // 复算不可得（无规则 / 不在 git 仓库）同样不允许 DONE：判停依据不足就继续本轮补跑 scope。
  const scopeGate = pipeline === "coding" ? codingGateBlockers(state, cwd) : { blockers: [], actual: null };
  const blockers = scopeGate.blockers;
  // 预设 stop_reason 的处置（2026-10-29 修复）。
  // 旧实现第一句就是 `if (state.stop_reason) return { stop_reason: state.stop_reason }`：状态文件是
  // 执行者可写的普通 JSON，写进去一个 "DONE" 就永远 DONE——实测任务仍 pending、checkpoint 未通过、
  // scope 未判定，`validate` 说 Valid、`gate` 说 DONE、`gate --apply` 照落盘。门禁于是退化成自报。
  // 现在的口径：
  //   · 终态（DONE/ESCALATE/BUDGET/STALL/MAX_CYCLES/HOLD/STOPPED）一律**重算**，不采信预设值；
  //   · STOPPED 例外：它表示「人主动叫停」，没有任何可计算依据替代，故放行；
  //   · 重算结果与预设不一致时，在 reason 里点明「预设值未被采纳」，让调用方看得见改判。
  // 重算后仍可能返回同一个 DONE，但那必须由 tasks/checkpoints/scope 三处真实通过支撑。
  const presetNote =
    state.stop_reason && state.stop_reason !== "STOPPED"
      ? `preset stop_reason=${state.stop_reason} was NOT trusted (recomputed from state)`
      : "";
  const withNote = (result) => (presetNote ? { ...result, presetNote } : result);
  if (state.stop_reason === "STOPPED") {
    return { stop_reason: "STOPPED", reason: "stopped by an operator (STOPPED is not recomputable)" };
  }
  if (tasks.length > 0 && tasks.every((t) => t.status === "done") && blockers.length === 0) {
    return withNote({ stop_reason: "DONE", reason: "all tasks are done" });
  }
  if (state.consecutive_failures >= state.max_failures) {
    return withNote({ stop_reason: "ESCALATE", reason: `consecutive_failures ${state.consecutive_failures} >= max_failures ${state.max_failures}` });
  }
  // 单任务尝试上限：任一任务的 failures 达到自身 max_attempts（或默认上限），立即 ESCALATE，避免单任务无限重试。
  const attemptLimit = 4; // 默认单任务尝试上限
  for (const task of tasks) {
    if (!task || typeof task.failures !== "number") continue;
    const limit = Number.isInteger(task.max_attempts) && task.max_attempts > 0 ? task.max_attempts : attemptLimit;
    if (task.failures >= limit) {
      return withNote({ stop_reason: "ESCALATE", reason: `task ${task.id} failures ${task.failures} >= max_attempts ${limit}` });
    }
  }
  if (pipeline === "coding" && scopeGate.actual && scopeGate.actual.state === "FAIL") {
    // 越界以**复算结果**为准（state.scope_drift 只作对照）：执行者删掉或改写自报值也逃不掉。
    return withNote({ stop_reason: "ESCALATE", reason: scopeGate.actual.reason });
  }
  if (state.budget) {
    const budget = state.budget;
    const tokensSpent = budget.spent_tokens ?? 0;
    const costSpent = budget.spent_cost_usd ?? 0;
    if ((budget.max_tokens !== undefined && tokensSpent >= budget.max_tokens) || (budget.max_cost_usd !== undefined && costSpent >= budget.max_cost_usd)) {
      return withNote({ stop_reason: "BUDGET", reason: `budget exhausted (tokens ${tokensSpent}/${budget.max_tokens ?? "-"}, cost ${costSpent}/${budget.max_cost_usd ?? "-"})` });
    }
  }
  if (tasks.some((t) => t.status === "blocked") && tasks.every((t) => t.status === "done" || t.status === "blocked")) {
    return withNote({ stop_reason: "HOLD", reason: "only blocked tasks remain" });
  }
  if (state.stall_counter >= stallMax) {
    return withNote({ stop_reason: "STALL", reason: `stall_counter ${state.stall_counter} >= ${stallMax}` });
  }
  if (state.round >= maxCycles) {
    return withNote({ stop_reason: "MAX_CYCLES", reason: `round ${state.round} >= ${maxCycles}` });
  }
  // 继续本轮：把未通过的硬门禁写进 reason，调用方能直接看到卡在哪一条。
  // root_cause_group 的「下一步该派哪一组」也在这里点名（此前该字段只有提示词在讲）。
  const hint = pipeline === "coding" ? nextRootCauseHint(state) : "";
  const parts = [...blockers, ...(hint ? [hint] : [])];
  return withNote({ stop_reason: null, reason: parts.length > 0 ? parts.join("；") : "continue" });
}

// 落盘规则：只要重算结果与现值不同就更新——**包括重算为 null 的情形**。
// 旧实现只在 `result.stop_reason` 为真时写，于是一个伪造的预设 DONE 永远清不掉：
// 任务回退成 pending 后门禁说「继续」，文件里却仍写着 DONE，下一次调用又读到它。
function applyGate(file, state, result) {
  const next = result.stop_reason ?? null;
  if (state.stop_reason !== next) {
    state.stop_reason = next;
    writeAtomic(file, state);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, { boolean: ["force", "json", "apply"], value: ["pipeline", "file", "prompt", "tail"] });
  if (!command || !["init", "validate", "write", "gate", "events", "root-causes"].includes(command)) {
    fail("usage: state.mjs init|validate|write|gate|events|root-causes --pipeline ralph|coding [--file <path>] [--json]");
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
    // 已存在但**不是状态文件**（2026-10-29 修复）：旧逻辑只判断「有没有 tasks/round/stop_reason」，
    // `package.json` 这类普通 JSON 一个都不命中 → 判「无进度」→ 直接覆盖成状态对象，exit 0。
    // 实测 `init --file repo/package.json` 会把 package.json 写成状态文件。现在先认形状：
    // 有 version/prompt 才算状态文件。
    // 两类拒绝分开报，因为补救方式不同：
    //   · existingProgress（是状态文件且带进度）→ `--force` 可以重置管道，这是它的本职；
    //   · foreignFile（根本不是状态文件）→ `--force` **也不放行**：把 package.json 覆盖成状态文件
    //     不是「重置管道」，是毁掉别人的文件。要初始化就换个路径。
    let foreignFile = false;
    withLock(file, () => {
      if (existsSync(file)) {
        try {
          const existing = JSON.parse(readFileSync(file, "utf8"));
          const looksLikeState = isObject(existing) && existing.version === 1 && typeof existing.prompt === "string";
          if (!looksLikeState) {
            foreignFile = true;
          } else {
            existingProgress = !args.force && Boolean(
              (Array.isArray(existing.tasks) ? existing.tasks.length : 0) > 0 ||
                existing.round > 0 ||
                existing.stop_reason != null,
            );
          }
        } catch {
          // 损坏的 JSON：可能是被中断的状态文件（--force 重建是正当用法），也可能压根是别的文件。
          // 无法区分时按「有进度」处理、交给 --force —— 与旧行为一致，且不新增误拒。
          existingProgress = !args.force;
        }
      }
      if (!existingProgress && !foreignFile) {
        writeAtomic(file, base);
        logEvent(file, pipeline, "init", base);
      }
    });
    if (foreignFile) {
      fail(
        `refusing to overwrite ${file}: it exists but is not a pipeline state file (no version/prompt).\n` +
          `--force does not bypass this — overwriting a non-state file is data loss, not a pipeline reset.\n` +
          `Pick another --file path (e.g. .loop-cli/state/${pipeline}-pipeline.json).`,
      );
    }
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
    // 保序字段（2026-10-29 修复）：scope_drift 与 scope 由 scope.mjs 写回，而每次「推进一轮」
    // 的 write 都是由执行者整份提交状态——执行者不知道这两个字段、或用了旧快照，就会把它们
    // 静默抹掉。旧行为实测：先 `scope --apply` 写入 scope_drift=PASS，再 `state.mjs write`
    // 推进一轮 → scope_drift 变空 → gate 判「尚未判定」，用户看到的是「刚判过又没判」。
    // 这两个字段是**判定产物**而非执行者输入，缺省时从磁盘现值继承；显式传值仍然优先
    // （scope.mjs 就是这么写回新结论的）。
    try {
      const current = JSON.parse(readFileSync(file, "utf8"));
      if (isObject(current)) {
        if (state.scope_drift === undefined && current.scope_drift !== undefined) state.scope_drift = current.scope_drift;
        if (state.scope === undefined && current.scope !== undefined) state.scope = current.scope;
      }
    } catch {
      /* 文件不存在或不是 JSON：没有可继承的现值 */
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

  // root-causes：把「一次修一组」变成机器可读的分桶，供 orchestrator 直接消费，
  // 不必自己遍历 tasks[] 去归并。只读，不写状态、不取锁。
  if (command === "root-causes") {
    const state = readState(file);
    const grouped = groupTasksByRootCause(state.tasks);
    if (args.json) console.log(JSON.stringify({ file, ...grouped }));
    else {
      if (grouped.groups.length === 0) console.log("(no root_cause_group assigned)");
      for (const group of grouped.groups) {
        const states = group.tasks.map((t) => `${t.id}:${t.status}`).join(", ");
        console.log(`${group.id}  ${group.done}/${group.total} done${group.complete ? " ✓" : ""}  [${states}]`);
      }
      if (grouped.ungrouped.total > 0) {
        const states = grouped.ungrouped.tasks.map((t) => `${t.id}:${t.status}`).join(", ");
        console.log(`(ungrouped) ${grouped.ungrouped.done}/${grouped.ungrouped.total} done  [${states}]`);
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
    const result = gateFor(state, pipeline, process.cwd());
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
    result = gateFor(read.state, pipeline, process.cwd());
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
