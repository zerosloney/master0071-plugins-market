#!/usr/bin/env node
// scripts/ 层的单元回归：dag.mjs / graph.mjs / render.mjs / serve.mjs / args.mjs 五个文件的已确认缺陷。
// 独立成文件的原因：test/pipeline.mjs 与 test/regression.mjs 走端到端状态机路线（init→write→gate→scope
// 全链路）且由别的工作流维护，不宜把 scripts 层的算法级断言混进去；这里只钉 2026-11 审查确认的 5 项 Minor：
//   1. dag.mjs cycles 只报真环成员（与 state.mjs validateState 的 DFS 同口径）+ 重复 id 报错而非静默合并
//   2. graph.mjs 对 JSON 根为 null/标量/数组的状态 fail-closed（退出码 2），不再 TypeError 崩栈成误读的 1
//   3. render.mjs 显式 --out 指向已存在的非 .html 文件时拒绝覆盖（事件日志是唯一不可重建的运行记录）
//   4. args.mjs 对 --file 的显式空值报错，不再静默回退默认路径
//   5. serve.mjs 一次变更只渲染一次（以 SSE render 事件数计渲染次数；watch×2 + 轮询曾 ≥3 次）
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

// 端到端：默认路径存在时，--file='' 不得悄悄改渲染目标到默认文件（旧行为：静默回退且 exit 0）
const defaultState = path.join(sandbox, ".loop-cli", "state", "coding-pipeline.json");
mkdirSync(path.dirname(defaultState), { recursive: true });
writeFileSync(defaultState, JSON.stringify(renderState));
result = run("render.mjs", ["--pipeline", "coding", "--file", "", "--out", path.join(renderDir, "trap.html")]);
check("render：--file 空串报错而非渲染默认路径的状态", result.status === 2 && /non-empty/.test(result.stderr), `${result.status} ${result.stdout} ${result.stderr}`);

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

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
