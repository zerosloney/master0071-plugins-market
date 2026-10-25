#!/usr/bin/env node
// agent-pipelines 等价性锚定测试：提示词文档 ↔ scripts/state.mjs 双实现防漂移。
// 命令/SKILL 提示词文档（供无 shell 宿主手写执行）与 scripts/state.mjs（有 shell 宿主走脚本）
// 是同一套编排规则的两份实现。本测试从 state.mjs 源码提取常量，与 4 份文档
// （commands/、skills/ 下的 ralph/coding）写死的规则逐一比对（A 部分），
// 再用最小合法状态跑 `state.mjs gate`，验证文档声明的判停规则与优先级和脚本实际输出一致（B 部分）。
// 文档与脚本漂移时，以脚本为唯一事实来源修文档，不改脚本行为。
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateScript = path.join(root, "scripts", "state.mjs");
const stateFile = path.join(tmpdir(), `agent-pipelines-equivalence-${process.pid}.json`);
let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
  }
};

console.log("\n== 源码常量提取 ==");
const source = readFileSync(stateScript, "utf8");

const specs = {};
for (const pipeline of ["ralph", "coding"]) {
  const match = source.match(new RegExp(`${pipeline}:\\s*\\{\\s*maxCycles:\\s*(\\d+),\\s*stallMax:\\s*(\\d+)\\s*\\}`));
  check(`脚本 PIPELINES.${pipeline} 常量存在`, Boolean(match));
  if (match) specs[pipeline] = { maxCycles: Number(match[1]), stallMax: Number(match[2]) };
}

const attemptMatch = source.match(/const attemptLimit\s*=\s*(\d+)/);
check("脚本 attemptLimit 常量存在", Boolean(attemptMatch));
const attemptLimit = attemptMatch ? Number(attemptMatch[1]) : -1;

const stopMatch = source.match(/const STOP_REASONS\s*=\s*new Set\(\[([^\]]*)\]\)/);
check("脚本 STOP_REASONS 常量存在", Boolean(stopMatch));
const stopReasons = new Set(
  stopMatch
    ? stopMatch[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item === "null" ? null : item.replace(/^"|"$/g, "")))
    : [],
);
check("脚本 STOP_REASONS 解析非空", stopReasons.size > 0 && stopReasons.has(null), JSON.stringify([...stopReasons]));

const failuresMatch = source.match(/max_failures:\s*(\d+)/);
check("脚本 init max_failures 默认存在", Boolean(failuresMatch));
const maxFailuresDefault = failuresMatch ? Number(failuresMatch[1]) : -1;

console.log("\n== 文档 ↔ 源码常量锚定 ==");
const docFiles = {
  ralph: ["commands/ralph-pipeline.md", "skills/ralph-pipeline/SKILL.md"],
  coding: ["commands/coding-pipeline.md", "skills/coding-pipeline/SKILL.md"],
};
const setsEqual = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

for (const [pipeline, files] of Object.entries(docFiles)) {
  const spec = specs[pipeline];
  for (const rel of files) {
    if (!spec) {
      check(`${rel} 锚定前提（脚本 ${pipeline} 常量提取）`, false);
      continue;
    }
    const doc = readFileSync(path.join(root, rel), "utf8");

    const iterDefaults = [...doc.matchAll(/`0` = 使用默认值（(\S+) 为 (\d+)）/g)].map((m) => ({ name: m[1], value: Number(m[2]) }));
    check(
      `${rel} max_iterations 默认 = ${pipeline} maxCycles (${spec.maxCycles})`,
      iterDefaults.length > 0 && iterDefaults.every((d) => d.name === pipeline && d.value === spec.maxCycles),
      JSON.stringify(iterDefaults),
    );

    const cycles = [...new Set([...doc.matchAll(/MAX_CYCLES\s*=\s*(\d+)/g)].map((m) => Number(m[1])))];
    check(`${rel} MAX_CYCLES 与 maxCycles 一致 (${spec.maxCycles})`, cycles.length > 0 && cycles.every((n) => n === spec.maxCycles), JSON.stringify(cycles));

    const stalls = [...new Set([...doc.matchAll(/STALL_MAX\s*=\s*(\d+)/g)].map((m) => Number(m[1])))];
    check(`${rel} STALL_MAX 与 stallMax 一致 (${spec.stallMax})`, stalls.length > 0 && stalls.every((n) => n === spec.stallMax), JSON.stringify(stalls));

    const failureDefaults = [
      ...[...doc.matchAll(/max_failures`?：[^；\n]*?默认\s*(\d+)/g)].map((m) => Number(m[1])),
      ...[...doc.matchAll(/max_failures`?（默认\s*(\d+)）/g)].map((m) => Number(m[1])),
    ];
    check(`${rel} max_failures 默认 = init 默认 (${maxFailuresDefault})`, failureDefaults.length > 0 && failureDefaults.every((n) => n === maxFailuresDefault), JSON.stringify(failureDefaults));

    // max_attempts 仅在 commands 文档声明，SKILL 文档无该表述时跳过
    const attemptDefaults = [
      ...[...doc.matchAll(/max_attempts`?：[^。\n]*?默认\s*(\d+)/g)].map((m) => Number(m[1])),
      ...[...doc.matchAll(/max_attempts`?（默认\s*(\d+)）/g)].map((m) => Number(m[1])),
    ];
    if (attemptDefaults.length > 0) {
      check(`${rel} max_attempts 默认 = attemptLimit (${attemptLimit})`, attemptDefaults.every((n) => n === attemptLimit), JSON.stringify(attemptDefaults));
    }

    const enumLine = doc.split(/\r?\n/).find((line) => /stop_reason`?\s*枚举/.test(line));
    if (!enumLine) {
      check(`${rel} stop_reason 枚举行存在`, false, "未找到 stop_reason 枚举行");
    } else {
      const members = [...enumLine.matchAll(/`(?:"([A-Z_]+)"|null)`/g)].map((m) => (m[1] === undefined ? null : m[1]));
      const docReasons = new Set(members);
      check(
        `${rel} stop_reason 枚举与 STOP_REASONS 完全相等`,
        members.length === docReasons.size && setsEqual(docReasons, stopReasons),
        `文档: ${JSON.stringify(members)}\n      脚本: ${JSON.stringify([...stopReasons])}`,
      );
    }
  }
}

console.log("\n== 判停行为与优先级（gate） ==");
// 构造可通过 validateState 校验的最小合法状态（schema 见 commands/coding-pipeline.md 的 JSON 块；
// coding 需额外 prior_cycles_summary / critical_checkpoints，tasks 元素需 id/title/status/depends_on/accept_criteria/failures）。
function baseState(pipeline, overrides = {}) {
  const state = {
    version: 1,
    prompt: "equivalence test",
    max_iterations: 0,
    max_failures: 3,
    retry_on_failure: false,
    completion_promise: null,
    outer_iteration: 0,
    tasks: [{ id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
    consecutive_failures: 0,
    stall_counter: 0,
    fail_history: [],
    round: 0,
    stop_reason: null,
  };
  if (pipeline === "coding") {
    state.prior_cycles_summary = "";
    state.critical_checkpoints = [];
  }
  return { ...state, ...overrides };
}

function spawnScript(args, state) {
  if (state !== undefined) writeFileSync(stateFile, JSON.stringify(state));
  return spawnSync(process.execPath, [stateScript, ...args], { encoding: "utf8" });
}

function runValidate(pipeline, state) {
  return spawnScript(["validate", "--pipeline", pipeline, "--file", stateFile, "--json"], state);
}

function runGate(pipeline, state) {
  const result = spawnScript(["gate", "--pipeline", pipeline, "--file", stateFile, "--json"], state);
  if (result.status !== 0) return { stop_reason: undefined, detail: `gate 退出码 ${result.status}: ${result.stderr.trim()}` };
  try {
    return { stop_reason: JSON.parse(result.stdout).stop_reason, detail: result.stdout.trim() };
  } catch (err) {
    return { stop_reason: undefined, detail: `gate 输出不可解析: ${err.message}\n${result.stdout}` };
  }
}

function expectStop(label, pipeline, overrides, expected) {
  const out = runGate(pipeline, baseState(pipeline, overrides));
  check(label, out.stop_reason === expected, `got=${JSON.stringify(out.stop_reason)} expected=${JSON.stringify(expected)}\n      ${out.detail}`);
}

try {
  check("ralph 最小合法状态通过 validateState", runValidate("ralph", baseState("ralph")).status === 0);
  check("coding 最小合法状态通过 validateState", runValidate("coding", baseState("coding")).status === 0);

  // 轮次上限：max_iterations=0 用默认 maxCycles；>0 覆盖 MAX_CYCLES
  expectStop("ralph round=9 继续（默认 maxCycles=10）", "ralph", { round: 9 }, null);
  expectStop("ralph round=10 判 MAX_CYCLES", "ralph", { round: 10 }, "MAX_CYCLES");
  expectStop("ralph max_iterations=3 覆盖后 round=3 判 MAX_CYCLES", "ralph", { max_iterations: 3, round: 3 }, "MAX_CYCLES");
  expectStop("coding round=7 继续（默认 maxCycles=8）", "coding", { round: 7 }, null);
  expectStop("coding round=8 判 MAX_CYCLES", "coding", { round: 8 }, "MAX_CYCLES");
  expectStop("coding max_iterations=5 覆盖后 round=5 判 MAX_CYCLES", "coding", { max_iterations: 5, round: 5 }, "MAX_CYCLES");

  // DONE 优先级最高：全部 done 时即使熔断/预算也判 DONE
  expectStop(
    "全部 done + 连续失败 5 + 预算耗尽 → DONE 优先",
    "ralph",
    {
      consecutive_failures: 5,
      budget: { max_tokens: 100, spent_tokens: 100 },
      tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
    },
    "DONE",
  );

  // 连续失败熔断
  expectStop("consecutive_failures=3（默认 max_failures）判 ESCALATE", "ralph", { consecutive_failures: 3 }, "ESCALATE");

  // 单任务尝试上限：failures 达缺省上限 4 判 ESCALATE，差一次不触发
  expectStop(
    "单任务 failures=4（缺省 max_attempts）判 ESCALATE",
    "ralph",
    { tasks: [{ id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 4 }] },
    "ESCALATE",
  );
  expectStop(
    "单任务 failures=3 不触发 ESCALATE",
    "ralph",
    { tasks: [{ id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 3 }] },
    null,
  );

  // coding scope 漂移
  expectStop("coding scope_drift=FAIL 判 ESCALATE", "coding", { scope_drift: "FAIL" }, "ESCALATE");

  // 预算耗尽（无更高优先级规则触发时）
  expectStop("token 预算耗尽判 BUDGET", "ralph", { budget: { max_tokens: 100, spent_tokens: 100 } }, "BUDGET");
  expectStop("费用预算耗尽判 BUDGET", "coding", { budget: { max_cost_usd: 2, spent_cost_usd: 2 } }, "BUDGET");

  // 仅剩 blocked 任务需用户决策
  expectStop(
    "仅剩 blocked 任务判 HOLD",
    "ralph",
    {
      tasks: [
        { id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 },
        { id: "t2", title: "b", status: "blocked", depends_on: [], accept_criteria: ["ok"], failures: 0 },
      ],
    },
    "HOLD",
  );

  // 停滞检测：ralph 阈值 3、coding 阈值 2
  expectStop("ralph stall_counter=3 判 STALL", "ralph", { stall_counter: 3 }, "STALL");
  expectStop("ralph stall_counter=2 继续", "ralph", { stall_counter: 2 }, null);
  expectStop("coding stall_counter=2 判 STALL", "coding", { stall_counter: 2 }, "STALL");
  expectStop("coding stall_counter=1 继续", "coding", { stall_counter: 1 }, null);

  // 已停止状态原样返回，不被更低优先级规则改写
  expectStop("已有 stop_reason=STOPPED 原样返回", "ralph", { stop_reason: "STOPPED", round: 99 }, "STOPPED");
} finally {
  rmSync(stateFile, { force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
