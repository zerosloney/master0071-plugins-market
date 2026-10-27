#!/usr/bin/env node
// agent-pipelines 依赖图检查：拓扑顺序、循环依赖与子任务预算。
// 用法：node scripts/graph.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json [--json]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./args.mjs";

const PIPELINES = {
  ralph: { maxCycles: 10, factor: 0.8 },
  coding: { maxCycles: 8, factor: 0.75 },
};

function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
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
  const ids = tasks.map((task) => task && task.id).filter((id) => typeof id === "string");
  const idSet = new Set(ids);
  const errors = [];

  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));
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

  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  const ordered = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    ordered.add(id);
    for (const dependent of next.get(id) || []) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  // 环 = 拓扑排序没吐出来的节点；用 Set 查找，O(n) 而非 includes 的 O(n²)
  const cycles = ids.filter((id) => !ordered.has(id));
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
