#!/usr/bin/env node
// agent-pipelines 状态机辅助：init / validate / write / gate / events / root-causes / promise。
// 提示词仍是主入口；宿主能执行 shell 时用本脚本落盘与判停，不能执行时退回 SKILL 里的手写规则。
// 三缝分层（2026-11-07）：持久化原语（原子写/事件日志/文件锁）在 state-persist.mjs、
// 域逻辑（validateState/gateFor/recheckScope 等）在 state-core.mjs；本文件只留 CLI——
// args 解析、子命令分发、init 与 git exclude 登记这类 IO 编排。行为与拆分前逐字一致。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.mjs";
import { PIPELINES } from "./pipelines.mjs";
import { isObject, logEvent, promiseFile, readEvents, readPromiseValue, readState, readStateSoft, withLock, writeAtomic } from "./state-persist.mjs";
import { applyGate, diffTaskStatus, gateFor, groupTasksByRootCause, looksLikeState, validateState } from "./state-core.mjs";

// 供测试/脚本不经 CLI 直连域逻辑（与 main() 内部用的是同一份实现，不另立拷贝）
export { validateState, gateFor, groupTasksByRootCause } from "./state-core.mjs";

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
    // 目录不是状态文件（2026-11-07，审计 m2）：目录对 existsSync 为真，读侧会把 EISDIR 当
    // 「损坏 JSON」误报，写侧 writeAtomic 的 renameSync 覆盖目录未捕获崩栈。在路径解析处
    // 单点拒绝，所有子命令同一口径：参数错误 → 一行报错 + 退出码 2。
    let stat = null;
    try {
      stat = statSync(resolved);
    } catch {
      /* 不存在：交给各命令既有的「文件缺失」路径 */
    }
    if (stat && stat.isDirectory()) {
      fail(
        `--file must name a file, not a directory: got ${resolved}\n` +
          `Pass e.g. ${path.join(resolved, ".loop-cli", "state", `${pipeline}-pipeline.json`)} instead.`,
      );
    }
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const tooBroad = path.dirname(resolved) === resolved || (home && resolved === path.resolve(home));
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

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, { boolean: ["force", "json", "apply"], value: ["pipeline", "file", "prompt", "tail", "value"] });
  if (!command || !["init", "validate", "write", "gate", "events", "root-causes", "promise"].includes(command)) {
    fail(
      "usage: state.mjs init|validate|write|gate|events|root-causes|promise --pipeline ralph|coding [--file <path>] [--json]\n" +
        "       promise（orchestrator 专属）：--value <text> 写边车标记 <状态>.promise.json，gate 据此判用户显式早停",
    );
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
    let promiseCleanupError = null;
    let promiseCleared = false;
    withLock(file, () => {
      if (existsSync(file)) {
        try {
          const existing = JSON.parse(readFileSync(file, "utf8"));
          if (!looksLikeState(existing)) {
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
        // 新一轮管线不留旧早停：删掉同路径 promise 边车标记（删不掉则中止 init——静默保留会让
        // 新管线继承上一轮的早停）。清理与写入同锁；promise 写标记也取这把锁（2026-11-07，
        // 审计 m5），「防止与并发 promise/gate 竞争」才是事实而非仅注释口径。
        const marker = promiseFile(file);
        if (existsSync(marker)) {
          try {
            unlinkSync(marker);
            promiseCleared = true;
          } catch (err) {
            promiseCleanupError = `failed to remove stale promise marker ${marker}: ${err.message}`;
            return;
          }
        }
        writeAtomic(file, base);
        logEvent(file, pipeline, "init", base);
        if (promiseCleared) logEvent(file, pipeline, "promise_cleared", base);
      }
    });
    if (promiseCleanupError) fail(promiseCleanupError);
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
    // 2026-11-05 修复：继承读原来在锁外——并发 `gate --apply` / `scope --apply` 在「继承读
    // 之后、落盘之前」写下的结论，会被这份基于陈旧快照的副本整份覆盖。继承、校验、落盘现在
    // 都在同一把 withLock 临界区内完成（锁内重读现值）；fail 纪律不变：process.exit 不会跑
    // withLock 的 finally，校验错误经 flag 带出锁外再 fail。
    let foreignFile = false;
    let invalidErrors = null;
    let warnings = [];
    withLock(file, () => {
      let current = null;
      if (existsSync(file)) {
        try {
          current = JSON.parse(readFileSync(file, "utf8"));
          if (!looksLikeState(current)) foreignFile = true;
        } catch {
          // 损坏 JSON 与 init 同一立场：可能是被中断的状态文件，不新增误拒、放行 write
        }
      }
      if (isObject(current)) {
        if (state.scope_drift === undefined && current.scope_drift !== undefined) state.scope_drift = current.scope_drift;
        if (state.scope === undefined && current.scope !== undefined) state.scope = current.scope;
      }
      const { errors, warnings: stateWarnings } = validateState(state, pipeline);
      if (errors.length) {
        invalidErrors = errors;
        return;
      }
      if (foreignFile) return;
      // 防误覆盖（对齐 init 的 foreignFile 检测）：write 也可能被指到别人的文件——
      // `write --file package.json` 实测会把 package.json 整份替换成状态对象、exit 0。
      const transitions = diffTaskStatus(file, state);
      writeAtomic(file, state);
      logEvent(file, pipeline, "write", state, { transitions });
      warnings = stateWarnings;
    });
    // fail 统一放锁外（优先序与旧实现一致：invalid 在 foreignFile 之前判）
    if (invalidErrors) fail(`invalid state:\n- ${invalidErrors.join("\n- ")}`);
    if (foreignFile) {
      fail(
        `refusing to overwrite ${file}: it exists but is not a pipeline state file (no version/prompt).\n` +
          `Overwriting a non-state file is data loss, not a pipeline update.\n` +
          `Init it first (state.mjs init --pipeline ${pipeline} --file ${file} --prompt ...) or check --file.`,
      );
    }
    if (args.json) console.log(JSON.stringify({ file, warnings }));
    else console.log(`Wrote ${file}${warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""}`);
    return;
  }

  // promise：orchestrator 专属（文档明确执行者禁用）。把用户在会话中显式给出的早停承诺写入
  // 边车标记 <状态基名>.promise.json（tmp+rename 原子写），不碰状态文件——gate 只认这个标记。
  // 空串/纯空白不构成早停依据，命令层直接拒绝（fail-loud，不给「写了但没生效」留哑巴坑）。
  if (command === "promise") {
    const value = typeof args.value === "string" ? args.value : "";
    if (!value.trim()) fail("promise requires a non-empty --value <text> (the user's explicit early-stop promise)");
    const marker = {
      version: 1,
      pipeline,
      value,
      created_at: new Date().toISOString(),
    };
    const markerPath = promiseFile(file);
    // 写标记与 init 的旧标记清理同锁（2026-11-07，审计 m5）：init 在锁内删旧标记、gate --apply
    // 在锁内读标记，promise 若锁外落盘，「init 清理后、promise 落盘前」的竞窗会让新管线继承
    // 上一轮的早停——与 init/write/gate --apply 同一把 <state>.lock 纪律对齐。
    withLock(file, () => {
      writeAtomic(markerPath, marker);
      logEvent(file, pipeline, "promise_set", null);
    });
    if (args.json) console.log(JSON.stringify({ file: markerPath, ...marker }));
    else console.log(`Wrote ${markerPath}`);
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
          ? ` [${event.transitions.map((t) => `${JSON.stringify(t.id)}:${t.from}->${t.to}`).join(", ")}]`
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
      // id 拼进 stdout 前一律 JSON.stringify 定界（引号+转义），防状态体字符串伪装分隔符/指令
      if (grouped.groups.length === 0) console.log("(no root_cause_group assigned)");
      for (const group of grouped.groups) {
        const states = group.tasks.map((t) => `${JSON.stringify(t.id)}:${t.status}`).join(", ");
        console.log(`${JSON.stringify(group.id)}  ${group.done}/${group.total} done${group.complete ? " ✓" : ""}  [${states}]`);
      }
      if (grouped.ungrouped.total > 0) {
        const states = grouped.ungrouped.tasks.map((t) => `${JSON.stringify(t.id)}:${t.status}`).join(", ");
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
    const result = gateFor(state, pipeline, process.cwd(), readPromiseValue(file));
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
    result = gateFor(read.state, pipeline, process.cwd(), readPromiseValue(file));
    applyGate(file, read.state, result);
    logEvent(file, pipeline, "gate", read.state, { applied: Boolean(result.stop_reason) });
  });
  // fail 统一放锁外：process.exit 不会跑 withLock 的 finally，锁内退出会把锁留在盘上
  if (readError) fail(readError);
  if (applyErrors && applyErrors.length > 0) fail(`invalid state:\n- ${applyErrors.join("\n- ")}`);
  if (args.json) console.log(JSON.stringify({ file, ...result, applied: true }));
  else console.log(`stop_reason=${result.stop_reason ?? "null"} (${result.reason})`);
}

// 只在直接执行本脚本时跑 CLI；被 import（直连 validateState/gateFor 等纯函数）时无副作用
// （范式与 render.mjs 底部的 main 守卫同款）。scope.mjs 经 spawnSync 调本脚本 write 的链路不受影响。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
