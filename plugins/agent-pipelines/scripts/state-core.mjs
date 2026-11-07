// state-core.mjs — state.mjs 的域逻辑单源：状态校验、gate 判停决策、scope 复算、根因分组。
//
// 拆分自 state.mjs（三缝拆分的域逻辑层）：这里的函数要么纯、要么近纯（diffTaskStatus /
// applyGate 触文件系统，但不解析参数、不打印输出）。锁与事件 IO 不进本模块——gateFor 的
// promise 标记值与 cwd 由调用方注入（沿用拆分前的注入风格，不为纯化改语义）；applyGate
// 落盘走 state-persist 的 writeAtomic。校验/判停规则与提示词文档的锚定（test/equivalence.mjs）
// 以这里的实现为准。
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isObject, writeAtomic } from "./state-persist.mjs";
import { PIPELINES, STOP_REASONS, TASK_STATUS, attemptLimit, effectiveMaxCycles } from "./pipelines.mjs";
import { collectChangedFiles, scopeVerdict } from "./scope-core.mjs";

// 字符串上限（LLM 消费面的注入/泛洪缓解）：id/title/criteria 是执行者可写的字符串，会被原样拼进
// gate reason、root-causes/events stdout。数据形状在写入口（validateState）定死，超限 fail-loud 拒绝；
// 错误消息点名字段、上限、实际长度，但不回显超限值本身——错误消息也是消费面，不能成为泛洪面。
const LIMIT_ID = 64; // task.id / root_cause_group / critical_checkpoints[].id
const LIMIT_TITLE = 200; // task.title
const LIMIT_CRITERION = 300; // accept_criteria 单条

// 「像状态文件」判定：有 version/prompt 才算。init 与 write 共用同一口径（见 init 分支的
// foreignFile 注释：覆盖非状态文件是数据损失，不是管道重置/更新）。
export function looksLikeState(value) {
  return isObject(value) && value.version === 1 && typeof value.prompt === "string";
}

export function validateState(state, pipeline) {
  const errors = [];
  const warnings = [];
  if (!isObject(state)) return { errors: ["state must be a JSON object"], warnings };
  if (state.version !== 1) errors.push("version must be 1");
  if (typeof state.prompt !== "string" || state.prompt.trim() === "") errors.push("prompt must be a non-empty string");
  if (!Number.isInteger(state.max_iterations) || state.max_iterations < 0) errors.push("max_iterations must be an integer >= 0");
  // 文档承诺（commands/ralph-pipeline.md、commands/coding-pipeline.md 的读取规则 2）：旧版本
  // 状态文件缺少 max_failures / retry_on_failure 时按默认值补齐、不算损坏。此前只有文档没有
  // 实现，这里对**缺失**（undefined）回填默认值——write / gate --apply 路径会把补齐后的对象
  // 连带落盘；显式 null / 错误类型仍走下方校验拒绝，补齐不是放松。
  if (state.max_failures === undefined) state.max_failures = 3;
  if (state.retry_on_failure === undefined) state.retry_on_failure = false;
  if (!Number.isInteger(state.max_failures) || state.max_failures < 1) errors.push("max_failures must be an integer >= 1");
  if (typeof state.retry_on_failure !== "boolean") errors.push("retry_on_failure must be a boolean");
  if (!(state.completion_promise === null || typeof state.completion_promise === "string")) {
    // 缺失也按非法（fail-loud 是有意设计：completion_promise 早停机制曾依赖此字段，见 gateFor），
    // 但错误行文补一句修复提示——旧版/最小状态的用户不必翻源码就知道补 null 即可通过校验。
    errors.push('completion_promise must be null or a string; add "completion_promise": null to fix');
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
      else if (task.id.length > LIMIT_ID) {
        errors.push(`task.id length ${task.id.length} exceeds limit ${LIMIT_ID}`);
        continue; // 超限 id 不进后续按 id 点名的错误消息（错误消息不放大无界字符串）
      } else if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
      else ids.add(task.id);
      if (typeof task.title !== "string" || task.title.trim() === "") errors.push(`task ${task.id}: title must be a non-empty string`);
      else if (task.title.length > LIMIT_TITLE) errors.push(`task ${task.id}: title length ${task.title.length} exceeds limit ${LIMIT_TITLE}`);
      if (!TASK_STATUS.has(task.status)) errors.push(`task ${task.id}: invalid status ${JSON.stringify(task.status)}`);
      if (!Array.isArray(task.depends_on) || task.depends_on.some((d) => typeof d !== "string")) {
        errors.push(`task ${task.id}: depends_on must be an array of strings`);
      }
      if (!Array.isArray(task.accept_criteria) || task.accept_criteria.some((c) => typeof c !== "string")) {
        errors.push(`task ${task.id}: accept_criteria must be an array of strings`);
      } else {
        const over = task.accept_criteria.findIndex((c) => c.length > LIMIT_CRITERION);
        if (over >= 0) errors.push(`task ${task.id}: accept_criteria[${over}] length ${task.accept_criteria[over].length} exceeds limit ${LIMIT_CRITERION}`);
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
      } else if (typeof task.root_cause_group === 'string' && task.root_cause_group.length > LIMIT_ID) {
        errors.push(`task ${task.id}: root_cause_group length ${task.root_cause_group.length} exceeds limit ${LIMIT_ID}`);
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
    // 环检测 DFS 迭代式（2026-11-07，审计 m1，与 dag.mjs 的分层/Tarjan 同因同法）：递归版在
    // 2 万节点链式 depends_on（链尾先访的任务序）上爆栈，RangeError 会从 validate/write 冒成
    // 裸 exit 1。栈帧 [id, 已分流的依赖下标] 复刻递归序：帧首做 visited（静默跳过）/ visiting
    // （报环，文案同前）判定，依赖按 depends_on 原序分流，帧弹出时补 post-order 的 visiting
    // 退出与 visited 登记。
    const visiting = new Set();
    const visited = new Set();
    const byId = new Map(state.tasks.filter(isObject).map((t) => [t.id, t]));
    const visit = (root) => {
      const frames = [[root, 0]];
      while (frames.length > 0) {
        const frame = frames[frames.length - 1];
        const id = frame[0];
        if (frame[1] === 0) {
          if (visited.has(id) || visiting.has(id)) {
            if (!visited.has(id)) errors.push(`dependency cycle detected at task ${id}`);
            frames.pop();
            continue;
          }
          visiting.add(id);
        }
        const task = byId.get(id);
        const deps = task && Array.isArray(task.depends_on) ? task.depends_on : [];
        let descended = false;
        while (frame[1] < deps.length) {
          const dep = deps[frame[1]];
          frame[1] += 1;
          if (byId.has(dep)) {
            frames.push([dep, 0]);
            descended = true;
            break;
          }
        }
        if (!descended) {
          frames.pop();
          visiting.delete(id);
          visited.add(id);
        }
      }
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
        } else if (checkpoint.id.length > LIMIT_ID) {
          errors.push(`coding: critical_checkpoints[].id length ${checkpoint.id.length} exceeds limit ${LIMIT_ID}`);
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

// 对比旧状态与新状态，输出任务状态迁移列表 [{ id, from, to }]。
// - 已有任务：状态变化时记录 from（旧状态）→ to（新状态）。
// - 新任务：from 为 null，表示本轮注册。
// - 旧状态不存在、解析失败或字段缺失时返回空数组，不影响主写入流程。
export function diffTaskStatus(file, nextState) {
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
// 判定内核（glob 引擎、变更清单收集、越界判定）与 scope.mjs 消费同一个 scope-core 单源，
// 口径同宽由结构保证——此前两份内联实现各出过真 bug 且修齐时间不同步（bug 史注释见
// scope-core），那时只能靠 test/regression.mjs 的对照用例事后锁等价；现在对照用例锁的是
// 「两个消费方接线正确」。这里只保留复算特有的增量：fail-soft 纪律（不反向依赖 scope.mjs
// 的 CLI，判定不可得时返回 unknown 而非退出）与读 state.scope 的规则装配。
export function recheckScope(state, cwd) {
  const scope = isObject(state.scope) ? state.scope : null;
  if (!scope) return { state: "unknown", reason: "scope 未配置（DONE 需要 hard/soft/forbidden 规则）" };
  const rulesOf = (v) => (Array.isArray(v) ? v.map((x) => String(x).replace(/\\/g, "/")) : []);
  const hard = rulesOf(scope.hard);
  const soft = rulesOf(scope.soft);
  const forbidden = rulesOf(scope.forbidden);
  if (hard.length === 0 && soft.length === 0 && forbidden.length === 0) {
    return { state: "unknown", reason: "scope 规则为空（DONE 需要至少一条 hard/soft/forbidden）" };
  }
  // 排除清单与 scope.mjs 同源：`--apply` 时由 applyVerdict 把实际生效的清单落进 scope.exclude
  // （自定义 --exclude 在此生效）；旧状态没有该字段时退回 scope.mjs 的默认排除。
  const excludedRules = rulesOf(scope.exclude);
  const exclude = excludedRules.length > 0 ? excludedRules : [".loop-cli/**"];
  // 模式必须仓库根相对（与 scope-core rootRelativePattern 的拒绝口径同判）：绝对路径或 ../ 段在这里
  // 永远匹配不到任何文件，静默沿用就是复算口径失真——按「无法复算」拦下，把修配置还给调用方。
  const malformed = [hard, soft, forbidden, exclude]
    .flat()
    .find((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes(".."));
  if (malformed) {
    return { state: "unknown", reason: `scope 模式非法（须仓库根相对路径）:${malformed}` };
  }
  const base = typeof scope.base === "string" && scope.base.trim() ? scope.base.trim() : "HEAD";
  if (base.startsWith("-") || /\s/.test(base)) {
    return { state: "unknown", reason: `scope.base 非法：${base}` };
  }
  // 复算的 git runner：失败返回 null（fail-soft），由 collectChangedFiles 对 diff 失败抛错、
  // 这里接住转成「复算不可得」；列清单的命令必须在**仓库根**执行，输出才与 scope 规则同基准
  // （仓库根相对路径），2026-11-01 的根锚定修复史见 scope-core.collectChangedFiles。
  const run = (args, dir = cwd) => {
    try {
      return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const toplevel = run(["rev-parse", "--show-toplevel"]);
  if (toplevel === null) {
    return { state: "unknown", reason: "不在 git 仓库内（无法复算 scope）" };
  }
  const root = toplevel || cwd;

  let changed;
  try {
    changed = collectChangedFiles((args) => run(args, root), exclude, base, true);
  } catch {
    return { state: "unknown", reason: `无法计算 ${base} 到工作区的变更清单` };
  }
  const files = [...changed].sort();
  const { forbiddenHits, outside, verdict } = scopeVerdict(files, { hard, soft, forbidden });
  if (verdict === "FAIL") {
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
export function groupTasksByRootCause(tasks) {
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
  // id 拼进 stdout 前一律 JSON.stringify 定界（引号+转义），防状态体字符串伪装分隔符/指令
  const pending = first.tasks.filter((t) => t.status !== 'done').map((t) => `${JSON.stringify(t.id)}(${t.status})`);
  return `next root_cause_group=${JSON.stringify(first.id)}（${first.done}/${first.total} done；未完成 ${pending.join(', ')}）`;
}

function codingGateBlockers(state, cwd) {
  const blockers = [];
  const checkpoints = Array.isArray(state.critical_checkpoints) ? state.critical_checkpoints : [];
  const failed = checkpoints
    .filter((checkpoint) => !isObject(checkpoint) || checkpoint.passed !== true)
    .map((checkpoint) => (isObject(checkpoint) && typeof checkpoint.id === "string" ? JSON.stringify(checkpoint.id) : "(未命名)"));
  if (failed.length > 0) blockers.push(`critical checkpoints 未通过: ${failed.join(", ")}`);
  const actual = recheckScope(state, cwd);
  if (actual.state === "FAIL") blockers.push(`scope_drift=FAIL（${actual.reason}）`);
  else if (actual.state === "unknown") blockers.push(`scope 无法复算（${actual.reason}）——DONE 需要可复算的 scope`);
  return { blockers, actual };
}

export function gateFor(state, pipeline, cwd = process.cwd(), promiseValue = "") {
  const spec = PIPELINES[pipeline];
  // max_iterations > 0 覆盖默认 maxCycles 的规则单源于 pipelines.mjs
  const maxCycles = effectiveMaxCycles(state, pipeline);
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
    // STOPPED 是唯一被采信的预设终态（人主动叫停没有可计算依据替代），但状态文件是执行者
    // 可写的普通 JSON，写一个 "STOPPED" 就能伪装「人主动叫停」，且没有任何机制可鉴别来源。
    // 不做机制变更，只做与其它预设终态「未采信」注记同族的透明化：采信时在 reason 里明示
    // 这是执行者自报值。
    return {
      stop_reason: "STOPPED",
      reason: "stopped by an operator (STOPPED is not recomputable) (executor-reported preset; 未鉴别来源)",
    };
  }
  // completion_promise 早停（2026-11-05 第二轮，方案 b）：只认 `state.mjs promise` 写的边车标记
  // （<状态基名>.promise.json，orchestrator 专属命令写入），状态体的 completion_promise 字段
  // **彻底不再参与判定**。旧机制（状态体非空即 DONE）已封死：状态文件是执行者（builder/worker）
  // 可写的普通 JSON，被注入或出错时写一行字符串就能伪造「用户显式早停」；边车标记只在用户于
  // 会话中显式要求早停时由 orchestrator 写入，且 init 会清掉旧标记（新一轮不继承早停）。
  // 标记命中即 DONE，按文档绕过 verdict / scope_drift / 验证 / critical 门禁（人明确授意的早停
  // 不是可伪造的自报终态：预设 stop_reason 仍然不采信，见上）。
  const promise = typeof promiseValue === "string" ? promiseValue.trim() : "";
  if (promise) {
    const result = {
      stop_reason: "DONE",
      // 用户提供的自由文本拼进 stdout 前 JSON.stringify 定界（引号+转义），防分隔符/指令伪装
      reason: `completion_promise 标记命中：${JSON.stringify(promise)}（经 promise 边车标记的用户主导早停，绕过 verdict/scope/验证/critical 门禁；状态体字段不再参与判定）`,
    };
    // 预设值本就等于 DONE 时不再挂「未采信」注记——这一次 DONE 是有依据的。
    if (state.stop_reason && state.stop_reason !== "DONE" && presetNote) result.presetNote = presetNote;
    return result;
  }
  if (tasks.length > 0 && tasks.every((t) => t.status === "done") && blockers.length === 0) {
    return withNote({ stop_reason: "DONE", reason: "all tasks are done" });
  }
  if (state.consecutive_failures >= state.max_failures) {
    return withNote({ stop_reason: "ESCALATE", reason: `consecutive_failures ${state.consecutive_failures} >= max_failures ${state.max_failures}` });
  }
  // 单任务尝试上限：任一任务的 failures 达到自身 max_attempts（或默认上限），立即 ESCALATE，避免单任务无限重试。
  for (const task of tasks) {
    if (!task || typeof task.failures !== "number") continue;
    const limit = Number.isInteger(task.max_attempts) && task.max_attempts > 0 ? task.max_attempts : attemptLimit;
    if (task.failures >= limit) {
      return withNote({ stop_reason: "ESCALATE", reason: `task ${JSON.stringify(task.id)} failures ${task.failures} >= max_attempts ${limit}` });
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
export function applyGate(file, state, result) {
  const next = result.stop_reason ?? null;
  if (state.stop_reason !== next) {
    state.stop_reason = next;
    writeAtomic(file, state);
  }
}
