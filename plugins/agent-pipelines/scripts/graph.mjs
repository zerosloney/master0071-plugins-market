#!/usr/bin/env node
// agent-pipelines 依赖图检查：拓扑顺序、循环依赖与子任务预算。
// 用法：node scripts/graph.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json [--json]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./args.mjs";
import { analyzeDependencies } from "./dag.mjs";

const PIPELINES = {
  ralph: { maxCycles: 10, factor: 0.8 },
  coding: { maxCycles: 8, factor: 0.75 },
};

function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2), { boolean: ["json"], value: ["pipeline", "file"] });
  const pipeline = typeof args.pipeline === "string" ? args.pipeline : "coding";
  const spec = PIPELINES[pipeline];
  if (!spec) fail(`--pipeline must be one of: ${Object.keys(PIPELINES).join(", ")}`);
  const file = args.file ? path.resolve(String(args.file)) : path.resolve(".loop-cli", "state", `${pipeline}-pipeline.json`);
  if (!existsSync(file)) fail(`state file not found: ${file}`);

  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`state file is not valid JSON: ${err.message}`);
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  // 依赖图分析（未知依赖 / 拓扑序 / 环）走 dag.mjs 单源——与 render.mjs 的看板分层共用同一份算法。
  const { order, cycles, errors } = analyzeDependencies(tasks);
  const maxCycles = Number.isInteger(state.max_iterations) && state.max_iterations > 0 ? state.max_iterations : spec.maxCycles;
  const limit = Math.floor(maxCycles * spec.factor);
  const budget = { limit, count: tasks.length, overflow: tasks.length > limit };
  const ok = errors.length === 0 && cycles.length === 0 && !budget.overflow;
  const result = { ok, file, order, cycles, budget, errors };

  if (args.json) console.log(JSON.stringify(result));
  else {
    console.log(`graph=${ok ? "OK" : "FAIL"} order=${order.join(" -> ") || "(empty)"}`);
    if (cycles.length) console.log(`cycles: ${cycles.join(", ")}`);
    if (budget.overflow) console.log(`budget overflow: ${budget.count} > ${budget.limit}`);
    for (const error of errors) console.log(`- ${error}`);
  }
  process.exit(ok ? 0 : 1);
}

main();
