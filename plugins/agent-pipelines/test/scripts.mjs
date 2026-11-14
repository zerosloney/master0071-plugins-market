#!/usr/bin/env node
// scripts/ 层的单元回归：dag.mjs / graph.mjs / render.mjs / serve.mjs / args.mjs 五个文件的已确认缺陷。
// 独立成文件的原因：test/pipeline.mjs 与 test/regression.mjs 走端到端状态机路线（init→write→gate→scope
// 全链路）且由别的工作流维护，不宜把 scripts 层的算法级断言混进去；这里只钉 2026-11 审查确认的 6 项：
//   1. dag.mjs cycles 只报真环成员（与 state.mjs validateState 的 DFS 同口径）+ 重复 id 报错而非静默合并
//   2. graph.mjs 对 JSON 根为 null/标量/数组的状态 fail-closed（退出码 2），不再 TypeError 崩栈成误读的 1
//   3. render.mjs 显式 --out 指向已存在的非 .html 文件时拒绝覆盖（事件日志是唯一不可重建的运行记录）
//   4. args.mjs 对 --file 的显式空值报错，不再静默回退默认路径
//   5. serve.mjs 一次变更只渲染一次（以 SSE render 事件数计渲染次数；watch×2 + 轮询曾 ≥3 次）
//   6. render/serve 退出码契约：未知 --pipeline → 一行干净报错 + 退出码 2（不再崩栈 exit 1）；
//      serve 既有错误路径的 stderr 统一 [agent-pipelines] 前缀
//   7. dag/state-core：2 万节点深链不再爆栈（分层/Tarjan/环 DFS 改显式栈帧），graph CLI 级正常输出
//   8. render：--out 指向尚不存在的事件日志派生路径（含轮转 .1）无条件拒绝（退出码 2）
//   9. state-core：validateState 缺 completion_promise 的报错补修复提示（fail-loud 行为不变）
//  10. args.mjs：位置参数不再静默忽略（out._ 无消费者，validate 漏写 --file 曾静默校验默认路径）
//  11. state.mjs：--file 指向已存在目录干净拒绝（旧路径 init --force/write 崩栈、读侧误报「损坏 JSON」）
//  12. serve.mjs：状态文件必须 .json 后缀（否则事件日志派生退化成状态文件自己）；--json 幽灵开关移除
//  13. serve.mjs：渲染持续失败时 stderr 提示一次（去重不刷屏），恢复后照常渲染
//  14. state-persist readEvents：坏行丢弃在 stderr 打计数（不再无声消失）
// 风格与 test/pipeline.mjs 一致：临时目录自造自清、check 断言计数、尾部汇总、退出码表真伪。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "agent-pipelines-scripts-test-"));
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

function run(script, args, input = undefined, cwd = sandbox) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd,
    input,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

console.log("\n== dag.mjs：环口径与重复 id ==");
const { analyzeDependencies } = await import(pathToFileURL(path.join(root, "scripts", "dag.mjs")).href);
const { layoutGraph } = await import(pathToFileURL(path.join(root, "scripts", "render.mjs")).href);

// 环 a↔b + 下游 c→b + 独立 d：cycles 只能点名 a、b（validateState 的 DFS 同口径）。
// 旧实现把「拓扑序排不进」一律算环，下游 c 也被点名，render 据此打印「存在环：c」误导排查。
const downstreamTasks = [
  { id: "a", depends_on: ["b"] },
  { id: "b", depends_on: ["a"] },
  { id: "c", depends_on: ["b"] },
  { id: "d", depends_on: [] },
];
const downstream = analyzeDependencies(downstreamTasks);
check("dag：cycles 只含真环成员（下游 c、独立 d 不在内）",
  downstream.cycles.slice().sort().join(",") === "a,b", JSON.stringify(downstream.cycles));
check("dag：order 行为保留（不可排序节点不进拓扑序，可排序的 d 照常输出）",
  downstream.order.join(",") === "d", downstream.order.join(","));
check("dag ↔ layoutGraph 环口径一致",
  layoutGraph(downstreamTasks).cycles.slice().sort().join(",") === downstream.cycles.slice().sort().join(","));

const graphDir = path.join(sandbox, "graph");
mkdirSync(graphDir, { recursive: true });
const graphStateFile = (name, content) => {
  const file = path.join(graphDir, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};
let result = run("graph.mjs", ["--pipeline", "ralph", "--file", graphStateFile("cycle-downstream.json", { tasks: downstreamTasks }), "--json"]);
const cycleJson = JSON.parse(result.stdout);
check("graph：环下游节点不进 cycles（退出码 1 = FAIL）",
  result.status === 1 && cycleJson.cycles.slice().sort().join(",") === "a,b", result.stdout + result.stderr);

// 重复 id：validateState 会拒绝（state.mjs 的 `duplicate task id`），dag 此前静默合并——
// 同 id 条目的 depends_on 并进同一节点、入度双计，graph 对 validateState 必拒的状态返回 ok=true。
const dupTasks = [
  { id: "x", depends_on: [] },
  { id: "x", depends_on: ["y"] },
  { id: "y", depends_on: [] },
];
const dupAnalysis = analyzeDependencies(dupTasks);
check("dag：重复 id 计入 errors（与 validateState 同文案）",
  dupAnalysis.errors.filter((e) => e === "duplicate task id: x").length === 1, JSON.stringify(dupAnalysis.errors));
check("dag：重复条目不参与建图（取首次出现，重复条目的 depends_on 不并入）",
  dupAnalysis.order.join(",") === "x,y", dupAnalysis.order.join(","));
result = run("graph.mjs", ["--pipeline", "ralph", "--file", graphStateFile("dup.json", { tasks: dupTasks }), "--json"]);
const dupJson = JSON.parse(result.stdout);
check("graph：重复 id 状态不再 ok=true",
  result.status === 1 && dupJson.ok === false && dupJson.errors.some((e) => e === "duplicate task id: x"),
  result.stdout + result.stderr);

console.log("\n== graph.mjs：JSON 根形状 fail-closed ==");
// 根为 null/标量时 state.tasks 抛未捕获 TypeError，崩栈退出码 1 恰是契约里的 FAIL 码，
// 调用方会误读成「检查通过但有环」；根为 [] 的数组此前反而 ok=true。同 render.mjs loadState
// 口径：形状不对 → 明确报错 + 退出码 2（参数或环境错误），不与 graph FAIL（1）混用。
for (const [name, raw] of [["root-null.json", "null"], ["root-scalar.json", "42"], ["root-array.json", "[]"]]) {
  const r = run("graph.mjs", ["--pipeline", "ralph", "--file", graphStateFile(name, raw), "--json"]);
  check(`graph：根为 ${raw} 时明确报错且退出码 2（非崩栈的 1）`,
    r.status === 2 && /state must be a JSON object/.test(r.stderr) && !/TypeError/.test(r.stderr),
    `${r.status} ${r.stdout} ${r.stderr}`);
}
result = run("graph.mjs", ["--pipeline", "ralph", "--file", graphStateFile("empty-tasks.json", { tasks: [] }), "--json"]);
check("graph：tasks 为空数组是合法空图（ok）",
  result.status === 0 && JSON.parse(result.stdout).ok === true, result.stdout + result.stderr);

console.log("\n== dag/state-core：2 万节点深链不再爆栈（递归 → 显式栈帧） ==");
// 审计 m1（2026-11-07）：分层 visit / Tarjan / validateState 环 DFS 都是递归，2 万节点链式
// depends_on 抛 RangeError——graph/render 调用点不接，崩栈 exit 1 恰是 FAIL 码，与「有环/
// 未知依赖」混读（graph.mjs 根形状注释的同款误读面）。修后：单元级正常返回、CLI 级正常输出。
const DEEP = 20000;
const deepTasks = [];
for (let i = 0; i < DEEP; i++) {
  deepTasks.push({ id: `t${i}`, title: "x", status: "pending", depends_on: i === 0 ? [] : [`t${i - 1}`], accept_criteria: ["ok"], failures: 0 });
}
let deep = null;
let deepCrash = "";
try {
  deep = analyzeDependencies(deepTasks);
} catch (err) {
  deepCrash = `${err.constructor.name}: ${err.message}`;
}
check("dag：2 万节点深链正常返回（不再 RangeError，链不构成环）",
  deep !== null && deep.cycles.length === 0 && deep.order.length === DEEP,
  deepCrash || (deep ? `cycles=${deep.cycles.length} order=${deep.order.length}` : ""));
check("dag：深链分层与拓扑序语义不变（链头层 0 / 链尾层 DEEP-1，序从链头到链尾）",
  deep !== null && deep.layer.get("t0") === 0 && deep.layer.get(`t${DEEP - 1}`) === DEEP - 1 && deep.order[0] === "t0" && deep.order[DEEP - 1] === `t${DEEP - 1}`,
  deep ? `layer=${deep.layer.get("t0")}/${deep.layer.get(`t${DEEP - 1}`)} order=${deep.order[0]}/${deep.order[DEEP - 1]}` : deepCrash);

const { validateState } = await import(pathToFileURL(path.join(root, "scripts", "state-core.mjs")).href);
// validateState 的环 DFS 从任务数组序进入：倒序（链尾先访）才会走满 20000 层——审计复现口径。
const deepStateBase = {
  version: 1,
  prompt: "scripts test",
  max_iterations: 0,
  max_failures: 3,
  retry_on_failure: false,
  completion_promise: null,
  outer_iteration: 0,
  consecutive_failures: 0,
  stall_counter: 0,
  fail_history: [],
  round: 0,
  stop_reason: null,
};
let deepValidated = null;
let deepValidatedCrash = "";
try {
  deepValidated = validateState({ ...deepStateBase, tasks: deepTasks.slice().reverse() }, "ralph");
} catch (err) {
  deepValidatedCrash = `${err.constructor.name}: ${err.message}`;
}
check("state-core：validateState 2 万节点深链不再爆栈且无环误报",
  deepValidated !== null && deepValidated.errors.length === 0,
  deepValidatedCrash || JSON.stringify(deepValidated?.errors?.slice(0, 3)));

// 审计 Nit 5：缺 completion_promise 的报错保持 fail-loud（缺失仍算非法），但错误行文里补一句
// 「补 "completion_promise": null 即可」的修复提示，旧版/最小状态的用户不必翻源码。
const noPromise = validateState(
  { ...deepStateBase, completion_promise: undefined, tasks: [{ id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0 }] },
  "ralph",
);
check("state-core：缺 completion_promise 的报错带修复提示（补 \"completion_promise\": null 即可）",
  noPromise.errors.some((e) => e.includes("completion_promise") && e.includes('"completion_promise": null')),
  JSON.stringify(noPromise.errors.filter((e) => e.includes("completion_promise"))));

// CLI 级：graph.mjs 走同一份 dag.mjs，深链必须正常出全量拓扑序（max_iterations 调大只为
// 不让 2 万任务的预算溢出干扰断言），绝不崩栈。
result = run("graph.mjs", ["--pipeline", "ralph", "--file", graphStateFile("deep-chain.json", { tasks: deepTasks, max_iterations: 30000 }), "--json"]);
let deepCli = null;
try {
  deepCli = JSON.parse(result.stdout);
} catch {}
check("graph：2 万节点深链 CLI 正常输出（exit 0、order 全量，不再崩栈成 FAIL 码 1）",
  result.status === 0 && deepCli !== null && deepCli.ok === true && Array.isArray(deepCli.order) && deepCli.order.length === DEEP,
  `${result.status} ${result.stderr.slice(0, 160)}`);

console.log("\n== render.mjs：--out 显式碰撞拒绝 ==");
const renderDir = path.join(sandbox, "render");
mkdirSync(renderDir, { recursive: true });
const renderState = {
  version: 1,
  prompt: "scripts test",
  max_iterations: 0,
  max_failures: 3,
  retry_on_failure: false,
  completion_promise: null,
  outer_iteration: 0,
  consecutive_failures: 0,
  stall_counter: 0,
  fail_history: [],
  round: 1,
  stop_reason: null,
  tasks: [{ id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
};
const renderStateFile = path.join(renderDir, "state.json");
writeFileSync(renderStateFile, JSON.stringify(renderState));
const renderEventsFile = renderStateFile.replace(/\.json$/, ".events.jsonl");
const eventsOriginal = `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 1 } })}\n`;
writeFileSync(renderEventsFile, eventsOriginal);
const otherJson = path.join(renderDir, "other.json");
const otherOriginal = JSON.stringify(renderState);
writeFileSync(otherJson, otherOriginal);

result = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", renderEventsFile]);
check("render：--out 指向事件日志被拒绝（退出码 2）", result.status === 2, `${result.status} ${result.stdout} ${result.stderr}`);
check("render：事件日志未被覆盖（唯一不可重建的运行记录）", readFileSync(renderEventsFile, "utf8") === eventsOriginal);
result = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", otherJson]);
check("render：--out 指向已存在的 .json 被拒绝且原文件完好",
  result.status === 2 && readFileSync(otherJson, "utf8") === otherOriginal, `${result.status} ${result.stdout} ${result.stderr}`);
const htmlOut = path.join(renderDir, "board.html");
result = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", htmlOut]);
check("render：显式 --out 指向新 .html 正常渲染", result.status === 0 && existsSync(htmlOut), result.stderr);
result = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", htmlOut]);
check("render：重复渲染到同一 .html 的合法流程不受影响", result.status === 0, `${result.status} ${result.stderr}`);
const freshOut = path.join(renderDir, "fresh.html");
result = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", freshOut]);
check("render：--out 指向尚不存在的 .html 照常创建", result.status === 0 && existsSync(freshOut), result.stderr);

// 审计 m3（2026-11-07）：上面的拒绝只查「已存在」，拦不住尚未诞生的日志——--out 指向
// <状态基名>.events.jsonl（state.mjs 首次 write 才创建）会先 exit 0 把 HTML 写进未来日志
// 路径，此后事件 JSONL 被追加进 HTML。派生路径无论存在与否一律 reserved（含轮转段 .1）。
const futureStateFile = path.join(renderDir, "future.json");
writeFileSync(futureStateFile, JSON.stringify(renderState));
const futureEventsFile = futureStateFile.replace(/\.json$/, ".events.jsonl");
result = run("render.mjs", ["--pipeline", "ralph", "--file", futureStateFile, "--out", futureEventsFile]);
check("render：--out 指向尚不存在的事件日志路径被拒绝且不落任何文件（退出码 2）",
  result.status === 2 && !existsSync(futureEventsFile), `${result.status} ${result.stdout} ${result.stderr}`);
result = run("render.mjs", ["--pipeline", "ralph", "--file", futureStateFile, "--out", `${futureEventsFile}.1`]);
check("render：--out 指向事件日志轮转段 .1（尚不存在）同样被拒绝",
  result.status === 2 && !existsSync(`${futureEventsFile}.1`), `${result.status} ${result.stdout} ${result.stderr}`);

// 面板评审 C-017（2026-11-14）：事件日志含非对象行（裸 null）时 render 容错渲染 exit 0——
// loadEvents 的 filter 是唯一消费守卫且此前零断言（删守卫全套仍绿、一行 null 即崩栈 exit 1）。
{
  const badEventsState = path.join(renderDir, "bad-events.json");
  writeFileSync(badEventsState, JSON.stringify(renderState));
  writeFileSync(
    badEventsState.replace(/\.json$/, ".events.jsonl"),
    [JSON.stringify({ ts: "2026-11-14T00:00:00.000Z", event: "write", pipeline: "ralph" }), "null", "42"].join("\n") + "\n",
  );
  const badOut = path.join(renderDir, "bad-events.html");
  result = run("render.mjs", ["--pipeline", "ralph", "--file", badEventsState, "--out", badOut]);
  check("C-017 事件日志含裸 null/标量行时 render 容错渲染（exit 0 且产出 HTML）",
    result.status === 0 && existsSync(badOut), `${result.status} ${result.stderr}`);
}

// 续单（2026-11-07）：promise 边车标记路径与事件日志同构——--out 指向尚不存在的
// <基名>.promise.json 会先 exit 0 落 HTML，此后 state.mjs promise 的 tmp+rename 会把整个
// HTML 顶掉。派生与 state-persist.promiseFile 同款，无论存在与否一律 reserved。
const futurePromiseFile = futureStateFile.replace(/\.json$/, ".promise.json");
result = run("render.mjs", ["--pipeline", "ralph", "--file", futureStateFile, "--out", futurePromiseFile]);
check("render：--out 指向尚不存在的 promise 边车路径被拒绝且不落任何文件（退出码 2）",
  result.status === 2 && !existsSync(futurePromiseFile), `${result.status} ${result.stdout} ${result.stderr}`);
writeFileSync(futurePromiseFile, JSON.stringify(renderState));
result = run("render.mjs", ["--pipeline", "ralph", "--file", futureStateFile, "--out", futurePromiseFile]);
check("render：--out 指向已存在的 promise 边车路径同样拒绝且原文件完好",
  result.status === 2 && readFileSync(futurePromiseFile, "utf8") === JSON.stringify(renderState), `${result.status} ${result.stdout} ${result.stderr}`);

console.log("\n== args.mjs：--file 显式空值报错 ==");
// parseArgs 的 fail() 直接 process.exit(2)，探针子进程以「退出码 2 且无 PARSED 输出」表错误路径。
const probeParseArgs = (argv) =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { parseArgs } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts", "args.mjs")).href)};
const out = parseArgs(${JSON.stringify(argv)}, { value: ["file"] });
console.log("PARSED " + JSON.stringify(out));`,
    ],
    { encoding: "utf8" },
  );
let probe = probeParseArgs(["--file="]);
check("args：--file= 显式空值报错（退出码 2）",
  probe.status === 2 && /non-empty/.test(probe.stderr) && !probe.stdout.includes("PARSED"),
  `${probe.status} ${probe.stdout} ${probe.stderr}`);
probe = probeParseArgs(["--file", ""]);
check("args：--file 分离空串同样报错", probe.status === 2 && /non-empty/.test(probe.stderr), `${probe.status} ${probe.stderr}`);
probe = probeParseArgs(["--file", "custom.json"]);
check("args：非空 --file 照常解析",
  probe.status === 0 && probe.stdout.includes("PARSED") && probe.stdout.includes('"file":"custom.json"'),
  `${probe.status} ${probe.stdout} ${probe.stderr}`);
probe = probeParseArgs([]);
check("args：未传 --file 不报错（默认路径语义不变）", probe.status === 0 && probe.stdout.includes("PARSED"), `${probe.status} ${probe.stderr}`);

// 审计 Nit 1（2026-11-07）：out._ 只收集无消费——7 个脚本全部只认开关，`state.mjs validate
// mypath.json`（漏写 --file）会静默校验默认路径、与用户意图无关地报成功/失败。parseArgs
// 单点收口：非 -- 开头的非空参数一律报错 exit 2，点名改用 --file。
probe = probeParseArgs(["mypath.json"]);
check("args：位置参数报错（退出码 2，提示用 --file）",
  probe.status === 2 && /positional argument/.test(probe.stderr) && /--file/.test(probe.stderr) && !probe.stdout.includes("PARSED"),
  `${probe.status} ${probe.stdout} ${probe.stderr}`);
probe = probeParseArgs(["--file", "x.json", "stray.json"]);
check("args：合法开关之后的裸参数同样报错", probe.status === 2 && /positional argument/.test(probe.stderr), `${probe.status} ${probe.stderr}`);

// 端到端：默认路径存在时，--file='' 不得悄悄改渲染目标到默认文件（旧行为：静默回退且 exit 0）
const defaultState = path.join(sandbox, ".loop-cli", "state", "coding-pipeline.json");
mkdirSync(path.dirname(defaultState), { recursive: true });
writeFileSync(defaultState, JSON.stringify(renderState));
result = run("render.mjs", ["--pipeline", "coding", "--file", "", "--out", path.join(renderDir, "trap.html")]);
check("render：--file 空串报错而非渲染默认路径的状态", result.status === 2 && /non-empty/.test(result.stderr), `${result.status} ${result.stdout} ${result.stderr}`);
// 端到端（审计 Nit 1 场景原样）：validate 漏写 --file、把路径当位置参数传 → 点名报错，
// 不再静默落到默认路径（旧实现会对默认路径做真实校验并给出误导性结论）。
result = run("state.mjs", ["validate", "mypath.json", "--pipeline", "coding"]);
check("state：validate 漏写 --file 传位置参数被点名报错（stdout 无校验结论）",
  result.status === 2 && /positional argument/.test(result.stderr) && result.stdout === "",
  `${result.status} ${result.stdout} ${result.stderr}`);

console.log("\n== state.mjs：--file 指向已存在目录拒绝 ==");
// 审计 m2（2026-11-07）：目录对 existsSync 为真，读侧（validate/gate）经 readStateSoft 把
// EISDIR 当「损坏 JSON」报（文案误导排查），写侧（init --force / write）writeAtomic 的
// renameSync 目标是目录 → 未捕获崩栈 exit 1。stateFile 解析处 statSync().isDirectory()
// 单点拒绝：参数错误 → 一行 [agent-pipelines] 报错 + 退出码 2，四条子命令同一口径。
{
  const dirTarget = path.join(sandbox, "dir-target");
  mkdirSync(dirTarget, { recursive: true });
  const dirCases = [
    ["validate", ["validate", "--pipeline", "ralph", "--file", dirTarget], undefined],
    ["gate", ["gate", "--pipeline", "ralph", "--file", dirTarget], undefined],
    ["init --force", ["init", "--pipeline", "ralph", "--file", dirTarget, "--prompt", "x", "--force"], undefined],
    ["write", ["write", "--pipeline", "ralph", "--file", dirTarget], JSON.stringify(renderState)],
  ];
  for (const [label, argv, input] of dirCases) {
    result = run("state.mjs", argv, input);
    check(`state：${label} --file 指向目录干净报错（退出码 2，无崩栈/无误报损坏 JSON）`,
      result.status === 2 && /must name a file, not a directory/.test(result.stderr)
        && result.stderr.startsWith("[agent-pipelines] ") && !result.stderr.includes("at "),
      `${result.status} ${result.stdout} ${result.stderr.slice(0, 200)}`);
  }
}

console.log("\n== serve.mjs：一次变更只渲染一次 ==");
const serveDir = path.join(sandbox, "serve");
mkdirSync(serveDir, { recursive: true });
const serveStateFile = path.join(serveDir, "coding-pipeline.json");
const serveEventsFile = serveStateFile.replace(/\.json$/, ".events.jsonl");
writeFileSync(serveStateFile, JSON.stringify({ ...renderState, round: 0 }));
writeFileSync(serveEventsFile, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 1 } })}\n`);

const servePort = await new Promise((resolve) => {
  const prober = net.createServer();
  prober.listen(0, "127.0.0.1", () => {
    const port = prober.address().port;
    prober.close(() => resolve(port));
  });
});
const serveProc = spawn(
  process.execPath,
  [path.join(root, "scripts", "serve.mjs"), "--pipeline", "coding", "--file", serveStateFile, "--port", String(servePort), "--interval", "100"],
  { cwd: sandbox, stdio: ["ignore", "pipe", "pipe"] },
);
let serveOut = "";
serveProc.stdout.on("data", (chunk) => (serveOut += chunk));
serveProc.stderr.on("data", (chunk) => (serveOut += chunk));
const waitForServe = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${servePort}/health`, (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve(text));
        }).on("error", reject);
      });
      if (body.includes("ok")) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

let sseReq = null;
// serve 子进程以 sandbox 为 cwd：Windows 上进程存活期间目录被锁，rmSync 前必须等它退出
const serveExited = new Promise((resolve) => serveProc.on("close", resolve));
try {
  check("serve 启动并监听", await waitForServe(), serveOut.slice(-300));

  // SSE 客户端：broadcast 只在真实渲染后发生，render 事件数即渲染次数（item 5 的计数口径）
  let sseBuf = "";
  const sseConnected = new Promise((resolve) => {
    sseReq = http.get(`http://127.0.0.1:${servePort}/events`, (res) => {
      res.on("data", (chunk) => (sseBuf += chunk.toString()));
      res.on("error", () => {});
      resolve();
    });
    sseReq.on("error", resolve);
  });
  await sseConnected;
  const rendersSeen = () => (sseBuf.match(/event: render/g) || []).length;

  // 静默窗：不写任何文件。旧实现首个轮询周期会对未变化内容重渲染并广播（mtime 初值 0）；
  // 修后启动时对齐 mtime 标记，静默期必须零渲染（复用上次渲染）。
  await new Promise((r) => setTimeout(r, 600)); // interval=100 → 约 6 个轮询周期
  const quietCount = rendersSeen();
  check("serve：静默期零渲染（mtime 未变复用上次渲染）", quietCount === 0, `renders=${quietCount} ${serveOut.slice(-200)}`);

  // 一次变更（state + events 同批落盘，模拟 state.mjs write）→ 恰好 1 次渲染。
  // 旧实现：两个 watch + 轮询各自 renderHtml() 两次再广播，≥3 次全量渲染（每次重读事件日志）。
  const updated = JSON.parse(readFileSync(serveStateFile, "utf8"));
  updated.round = 1;
  updated.tasks[0].status = "done";
  writeFileSync(serveStateFile, JSON.stringify(updated));
  writeFileSync(serveEventsFile, `${JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", event: "write", round: 1, stop_reason: null, tasks: { done: 1, total: 1 } })}\n`);
  await new Promise((r) => setTimeout(r, 800)); // 容纳 watch 触发与多个轮询周期
  const changeCount = rendersSeen() - quietCount;
  check("serve：一次变更恰好 1 次渲染（旧实现 ≥3 次）", changeCount === 1, `renders=${changeCount} ${sseBuf.slice(-200)}`);

  // 页面拿到的是变更后的新渲染（实时性语义不变）
  const page = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${servePort}/`, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve(body));
    }).on("error", reject);
  });
  check("serve：页面反映变更后的状态", /badge-done/.test(page) && /round=1/.test(page), serveOut.slice(-300));
} finally {
  if (sseReq) sseReq.destroy();
  serveProc.kill();
  await serveExited;
}

console.log("\n== render/serve：未知 --pipeline 退出码契约 ==");
// 契约（README.md:61 同一 exit 语义）：参数或环境错误 → 一行 [agent-pipelines] 干净报错 + 退出码 2。
// 旧实现 render.main 与 serve.mjs 模块顶层对 pipelineOf 的抛出都不接（serve 无 main 守卫），
// bogus --pipeline 崩栈 exit 1——1 是 graph 的 FAIL 码，调用方会误读成「检查有环」。
result = run("render.mjs", ["--pipeline", "bogus"]);
check("render：未知 --pipeline 退出码 2（非崩栈的 1）", result.status === 2, `${result.status} ${result.stderr}`);
check("render：报错带 [agent-pipelines] 前缀且无堆栈帧",
  result.stderr.startsWith("[agent-pipelines] ") && !result.stderr.includes("at "), result.stderr);
result = run("serve.mjs", ["--pipeline", "bogus"]);
check("serve：未知 --pipeline 退出码 2（非崩栈的 1）", result.status === 2, `${result.status} ${result.stderr}`);
check("serve：报错带 [agent-pipelines] 前缀且无堆栈帧",
  result.stderr.startsWith("[agent-pipelines] ") && !result.stderr.includes("at "), result.stderr);

console.log("\n== serve.mjs：既有错误路径 stderr 前缀统一 ==");
// 五个脚本的 stderr 统一 [agent-pipelines] 前缀；serve 此前三处自成一体用「agent-pipelines live board」。
result = run("serve.mjs", ["--pipeline", "coding", "--file", path.join(serveDir, "missing.json"), "--port", "0"]);
check("serve：--port 越界报错带统一前缀（退出码 2）",
  result.status === 2 && result.stderr.startsWith("[agent-pipelines] "), `${result.status} ${result.stderr}`);
result = run("serve.mjs", ["--pipeline", "coding", "--file", path.join(serveDir, "missing.json")]);
check("serve：状态文件缺失的启动失败报错带统一前缀（退出码 2）",
  result.status === 2 && result.stderr.startsWith("[agent-pipelines] "), `${result.status} ${result.stderr}`);
// 端口被占（error 处理器路径）：先占住一个端口再让 serve 去监听同一个端口
const blocker = net.createServer();
await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
result = run("serve.mjs", ["--pipeline", "coding", "--file", serveStateFile, "--port", String(blocker.address().port)]);
blocker.close();
check("serve：端口被占报错带统一前缀（退出码 2）",
  result.status === 2 && result.stderr.startsWith("[agent-pipelines] "), `${result.status} ${result.stderr}`);

console.log("\n== serve.mjs：非 .json 状态文件拒绝 + --json 幽灵开关移除 ==");
// 审计 m4（2026-11-07）：事件日志路径派生是 `.json` → `.events.jsonl`，--file 不带 .json 时
// replace 不替换、eventsFile 退化成状态文件自己——watch 双注册同一文件、loadEvents 把状态
// JSON 当 JSONL 逐行解析成空日志，看板「看起来正常」但事件轨迹永远为空。与 render 同款
// 后缀校验（退出码 2）。Nit 2：--json 只注册从不消费（serve 没有 JSON 输出面），传它此前
// 被静默吞掉；移除注册后走 parseArgs 统一的未知参数报错。
const serveExitProbe = (argv, waitMs = 5000) =>
  new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(root, "scripts", "serve.mjs"), ...argv], { cwd: sandbox, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => proc.kill(), waitMs); // 仍存活 = 没走拒绝路径（RED 时杀掉收场）
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    });
  });
const noExtState = path.join(serveDir, "state-no-ext");
writeFileSync(noExtState, JSON.stringify(renderState));
{
  const { code, out } = await serveExitProbe(["--pipeline", "coding", "--file", noExtState, "--port", "18739"]);
  check("serve：--file 无 .json 后缀拒绝启动（退出码 2，不进监听）",
    code === 2 && /\.json extension/.test(out) && out.startsWith("[agent-pipelines] ") && !out.includes("live board: http"),
    `code=${code} ${out.slice(0, 200)}`);
  const withJson = await serveExitProbe(["--pipeline", "coding", "--file", serveStateFile, "--port", "18739", "--json"]);
  check("serve：--json 未注册，按未知参数报错（退出码 2）",
    withJson.code === 2 && /unknown argument "--json"/.test(withJson.out),
    `code=${withJson.code} ${withJson.out.slice(0, 200)}`);
}

console.log("\n== serve.mjs：渲染持续失败 stderr 提示一次（去重），恢复后照常渲染 ==");
// 质量审计 §3.3（2026-11-07）：refresh 的 catch { return } 吞掉一切渲染错误——状态文件变成
// 永久损坏 JSON 后看板静默展示旧内容，用户无从察觉数据已停更。现在渲染失败至少 console.error
// 一次（[agent-pipelines] 前缀）；watch + 轮询会反复触发同一错误，按消息去重不刷屏；渲染
// 成功后清空去重标记，再次损坏能再报。
{
  const corruptDir = path.join(sandbox, "serve-corrupt");
  mkdirSync(corruptDir, { recursive: true });
  const corruptStateFile = path.join(corruptDir, "coding-pipeline.json");
  const corruptEventsFile = corruptStateFile.replace(/\.json$/, ".events.jsonl");
  writeFileSync(corruptStateFile, JSON.stringify({ ...renderState, round: 0 }));
  writeFileSync(corruptEventsFile, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 1 } })}\n`);
  const corruptPort = await new Promise((resolve) => {
    const prober = net.createServer();
    prober.listen(0, "127.0.0.1", () => {
      const port = prober.address().port;
      prober.close(() => resolve(port));
    });
  });
  const corruptProc = spawn(
    process.execPath,
    [path.join(root, "scripts", "serve.mjs"), "--pipeline", "coding", "--file", corruptStateFile, "--port", String(corruptPort), "--interval", "100"],
    { cwd: sandbox, stdio: ["ignore", "pipe", "pipe"] },
  );
  let corruptOut = "";
  corruptProc.stdout.on("data", (chunk) => (corruptOut += chunk));
  corruptProc.stderr.on("data", (chunk) => (corruptOut += chunk));
  const corruptExited = new Promise((resolve) => corruptProc.on("close", resolve));
  const corruptHealthy = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const body = await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${corruptPort}/health`, (r) => {
            let text = "";
            r.on("data", (c) => (text += c));
            r.on("end", () => resolve(text));
          }).on("error", reject);
        });
        if (body.includes("ok")) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const errorLines = () => corruptOut.split("\n").filter((line) => line.includes("render failed"));
  const fetchPage = () =>
    new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${corruptPort}/`, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve(body));
      }).on("error", reject);
    });
  try {
    check("corrupt serve 启动并监听", await corruptHealthy(), corruptOut.slice(-300));
    corruptOut = ""; // 清掉启动横幅，只观察损坏后的 stderr
    writeFileSync(corruptStateFile, "{corrupted json");
    await new Promise((r) => setTimeout(r, 700)); // watch 去抖 50ms + 多个 100ms 轮询周期
    check("状态损坏后 stderr 恰好一行渲染失败提示（[agent-pipelines] 前缀）",
      errorLines().length === 1 && /\[agent-pipelines\]/.test(errorLines()[0] || ""), JSON.stringify(corruptOut.slice(-300)));
    await new Promise((r) => setTimeout(r, 800)); // 继续轮询多个周期
    check("持续损坏期间提示不随轮询刷屏（去重生效）", errorLines().length === 1, `lines=${errorLines().length}`);
    writeFileSync(corruptStateFile, JSON.stringify({ ...renderState, round: 1, tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }] }));
    writeFileSync(corruptEventsFile, `${JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", event: "write", round: 1, stop_reason: null, tasks: { done: 1, total: 1 } })}\n`);
    await new Promise((r) => setTimeout(r, 700));
    const page = await fetchPage();
    check("修复后看板恢复渲染新状态", /badge-done/.test(page) && /round=1/.test(page), corruptOut.slice(-300));
    writeFileSync(corruptStateFile, "{corrupted json");
    await new Promise((r) => setTimeout(r, 700));
    check("恢复后再次损坏能再报一次（去重标记已清空）", errorLines().length === 2, `lines=${errorLines().length}`);
  } finally {
    corruptProc.kill();
    await corruptExited;
  }
}

console.log("\n== state-persist：readEvents 坏行丢弃打 stderr 计数 ==");
// 质量审计 §3.4（2026-11-07）：JSON.parse 失败的事件行此前无声消失——events 子命令与看板
// 都看不出日志曾被截断/写坏，事后审计会误信「没发生过」。丢弃时 stderr 打一行计数
// （[agent-pipelines] 前缀、含文件名），不打断读取、不改变 stdout 事件内容。
{
  const evDir = path.join(sandbox, "events");
  mkdirSync(evDir, { recursive: true });
  const evStateFile = path.join(evDir, "coding-pipeline.json");
  writeFileSync(evStateFile, JSON.stringify(renderState));
  const evLog = evStateFile.replace(/\.json$/, ".events.jsonl");
  writeFileSync(
    evLog,
    [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 1 } }),
      "{broken json",
      "",
      JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", event: "write", round: 1, stop_reason: null, tasks: { done: 1, total: 1 } }),
    ].join("\n") + "\n",
  );
  result = run("state.mjs", ["events", "--pipeline", "coding", "--file", evStateFile]);
  check("events：坏行被跳过后 stdout 仍完整输出其余事件（读取不打断）",
    result.status === 0 && result.stdout.includes("init") && result.stdout.includes("write"), `${result.status} ${result.stdout}`);
  check("events：坏行丢弃在 stderr 打一行计数（含文件名、前缀统一）",
    // 面板评审 C-004：消息带去重注记后缀（同一坏行计数不重复刷 stderr）
    /^\[agent-pipelines\] skipped 1 malformed event line\(s\) in .+events\.jsonl \(deduplicated until the count changes\)$/m.test(result.stderr), result.stderr);
  result = run("state.mjs", ["events", "--pipeline", "coding", "--file", evStateFile, "--json", "--tail", "20"]);
  const evJson = JSON.parse(result.stdout);
  check("events：--json 输出只含 2 条合法事件（坏行不进数据面）",
    result.status === 0 && evJson.events.length === 2 && /^\[agent-pipelines\] skipped 1 malformed/.test(result.stderr),
    `${result.stderr} ${result.stdout.slice(0, 200)}`);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
