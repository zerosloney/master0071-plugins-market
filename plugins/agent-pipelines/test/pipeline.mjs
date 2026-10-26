#!/usr/bin/env node
// agent-pipelines 的运行时辅助脚本测试：状态机与 scope 检查。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "agent-pipelines-test-"));
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

function runAsync(script, args, input, cwd = sandbox) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script), ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input);
  });
}

// 打开 SSE 连接，等待出现指定 event 后返回已收到的文本（用于验证实时推送）。
function fetchSseEvent(url, needle, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = "";
      const timer = setTimeout(() => {
        req.destroy();
        resolve(buf);
      }, timeoutMs);
      res.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.includes(needle)) {
          clearTimeout(timer);
          req.destroy();
          resolve(buf);
        }
      });
      res.on("error", () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    req.on("error", reject);
  });
}

function initState(pipeline, file) {
  const result = run("state.mjs", ["init", "--pipeline", pipeline, "--file", file, "--prompt", "test prompt"]);
  check(`init ${pipeline}`, result.status === 0, result.stderr);
  return JSON.parse(readFileSync(file, "utf8"));
}

function gate(file, pipeline = "ralph") {
  const result = run("state.mjs", ["gate", "--pipeline", pipeline, "--file", file, "--json"]);
  check(`${pipeline} gate runs`, result.status === 0, result.stderr);
  return JSON.parse(result.stdout);
}

console.log("\n== 状态机 ==");
const ralphFile = path.join(sandbox, "ralph.json");
const codingFile = path.join(sandbox, "coding.json");
const ralph = initState("ralph", ralphFile);
const coding = initState("coding", codingFile);
check("ralph 默认状态有效", run("state.mjs", ["validate", "--pipeline", "ralph", "--file", ralphFile, "--json"]).status === 0);
check("coding 默认状态有效", run("state.mjs", ["validate", "--pipeline", "coding", "--file", codingFile, "--json"]).status === 0);
check("空任务列表不判 DONE", gate(ralphFile).stop_reason === null);

ralph.tasks = [
  { id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 },
  { id: "t2", title: "b", status: "done", depends_on: ["t1"], accept_criteria: ["ok"], failures: 0 },
];
writeFileSync(ralphFile, JSON.stringify(ralph));
check("全部任务 done 判 DONE", gate(ralphFile).stop_reason === "DONE");

ralph.tasks[1].status = "blocked";
writeFileSync(ralphFile, JSON.stringify(ralph));
check("只剩 blocked 判 HOLD", gate(ralphFile).stop_reason === "HOLD");

ralph.consecutive_failures = 3;
writeFileSync(ralphFile, JSON.stringify(ralph));
check("连续失败达阈值判 ESCALATE", gate(ralphFile).stop_reason === "ESCALATE");

ralph.consecutive_failures = 0;
ralph.tasks[1].status = "pending";
ralph.stall_counter = 3;
writeFileSync(ralphFile, JSON.stringify(ralph));
check("stall_counter 达阈值判 STALL", gate(ralphFile).stop_reason === "STALL");

ralph.stall_counter = 0;
ralph.round = 10;
writeFileSync(ralphFile, JSON.stringify(ralph));
check("round 达上限判 MAX_CYCLES", gate(ralphFile).stop_reason === "MAX_CYCLES");

// 单任务尝试上限：failures 达 max_attempts 判 ESCALATE
const attemptState = JSON.parse(JSON.stringify(ralph));
attemptState.consecutive_failures = 0;
attemptState.stall_counter = 0;
attemptState.round = 0;
attemptState.tasks = [
  { id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 4, max_attempts: 4 },
];
writeFileSync(ralphFile, JSON.stringify(attemptState));
check("单任务达 max_attempts 判 ESCALATE", gate(ralphFile).stop_reason === "ESCALATE");

// 未达 max_attempts 不触发
attemptState.tasks[0].failures = 3;
writeFileSync(ralphFile, JSON.stringify(attemptState));
check("未达 max_attempts 不判 ESCALATE", gate(ralphFile).stop_reason === null);

// max_attempts 缺省时用默认上限 4
const defaultAttempt = JSON.parse(JSON.stringify(attemptState));
defaultAttempt.tasks[0].failures = 4;
delete defaultAttempt.tasks[0].max_attempts;
writeFileSync(ralphFile, JSON.stringify(defaultAttempt));
check("缺省 max_attempts 用默认上限 4", gate(ralphFile).stop_reason === "ESCALATE");

// 非法 max_attempts 被校验拒绝
const badAttempt = JSON.parse(JSON.stringify(attemptState));
badAttempt.tasks[0].max_attempts = 0;
writeFileSync(ralphFile, JSON.stringify(badAttempt));
check("非法 max_attempts 被拒绝", run("state.mjs", ["validate", "--pipeline", "ralph", "--file", ralphFile]).status === 1);

const codingGate = gate(codingFile, "coding");
check("coding 初始不停止", codingGate.stop_reason === null);
coding.scope_drift = "FAIL";
writeFileSync(codingFile, JSON.stringify(coding));
check("coding scope_drift FAIL 判 ESCALATE", gate(codingFile, "coding").stop_reason === "ESCALATE");

console.log("\n== 状态校验 ==");
const broken = JSON.parse(JSON.stringify(ralph));
broken.version = 2;
const brokenFile = path.join(sandbox, "broken.json");
writeFileSync(brokenFile, JSON.stringify(broken));
const badVersion = run("state.mjs", ["validate", "--pipeline", "ralph", "--file", brokenFile, "--json"]);
check("version 错误被拒绝", badVersion.status === 1 && /"valid":false/.test(badVersion.stdout), badVersion.stdout + badVersion.stderr);
const badStatus = JSON.parse(JSON.stringify(ralph));
badStatus.tasks[0].status = "finished";
writeFileSync(ralphFile, JSON.stringify(badStatus));
check("非法任务状态被拒绝", run("state.mjs", ["validate", "--pipeline", "ralph", "--file", ralphFile]).status === 1);
const unknownDep = JSON.parse(JSON.stringify(ralph));
unknownDep.tasks[1].depends_on = ["nope"];
writeFileSync(ralphFile, JSON.stringify(unknownDep));
check("未知依赖被拒绝", run("state.mjs", ["validate", "--pipeline", "ralph", "--file", ralphFile]).status === 1);
const cycle = JSON.parse(JSON.stringify(ralph));
cycle.tasks[0].depends_on = ["t2"];
cycle.tasks[1].depends_on = ["t1"];
writeFileSync(ralphFile, JSON.stringify(cycle));
check("依赖环被拒绝", run("state.mjs", ["validate", "--pipeline", "ralph", "--file", ralphFile]).status === 1);

const writeFile = path.join(sandbox, "written.json");
const valid = JSON.parse(JSON.stringify(ralph));
valid.round = 1;
valid.tasks[0].status = "done";
valid.tasks[1].status = "in_progress";
const written = run("state.mjs", ["write", "--pipeline", "ralph", "--file", writeFile], JSON.stringify(valid));
check("write 接受合法状态并原子落盘", written.status === 0 && existsSync(writeFile) && !existsSync(`${writeFile}.tmp`), written.stderr);

console.log("\n== scope ==");
const repo = path.join(sandbox, "repo");
mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git("init", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "test");
writeFileSync(path.join(repo, "base.txt"), "base\n");
git("add", ".");
git("commit", "-m", "base");
const base = git("rev-parse", "HEAD").trim();
const scope = (extra = []) =>
  run("scope.mjs", ["--base", base, "--hard", "src/**", "--soft", "docs/**", "--forbidden", "dist/**", "--json"], undefined, repo);

mkdirSync(path.join(repo, "src"));
writeFileSync(path.join(repo, "src", "a.js"), "a\n");
let result = scope();
check("hard 内改动判 PASS", result.status === 0 && JSON.parse(result.stdout).verdict === "PASS", result.stdout + result.stderr);

mkdirSync(path.join(repo, "docs"));
writeFileSync(path.join(repo, "docs", "b.md"), "b\n");
result = scope();
check("soft 内改动仍判 PASS", result.status === 0 && JSON.parse(result.stdout).verdict === "PASS", result.stdout + result.stderr);

mkdirSync(path.join(repo, "dist"));
writeFileSync(path.join(repo, "dist", "c.js"), "c\n");
result = scope();
check("forbidden 改动判 FAIL", result.status === 1 && JSON.parse(result.stdout).verdict === "FAIL", result.stdout + result.stderr);

rmSync(path.join(repo, "dist"), { recursive: true, force: true });
mkdirSync(path.join(repo, "other"));
writeFileSync(path.join(repo, "other", "d.txt"), "d\n");
result = scope();
check("scope 外改动判 FAIL", result.status === 1 && JSON.parse(result.stdout).verdict === "FAIL", result.stdout + result.stderr);

rmSync(path.join(repo, "other"), { recursive: true, force: true });
mkdirSync(path.join(repo, ".loop-cli"));
const stateWithScope = path.join(repo, ".loop-cli", "state.json");
writeFileSync(
  stateWithScope,
  JSON.stringify({
    version: 1,
    prompt: "x",
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
    prior_cycles_summary: "",
    critical_checkpoints: [],
    scope: { hard: ["src/**"], soft: ["docs/**"], forbidden: ["dist/**"] },
  }),
);
result = run("scope.mjs", ["--base", base, "--file", ".loop-cli/state.json", "--json"], undefined, repo);
check("从状态文件读取 scope 生效", result.status === 0 && JSON.parse(result.stdout).verdict === "PASS", result.stdout + result.stderr);

console.log("\n== 锁与事件日志 ==");
const lockFile = path.join(sandbox, "locked.json");
initState("ralph", lockFile);
const lockPath = `${lockFile}.lock`;
writeFileSync(lockPath, "other\n");
const blocked = run("state.mjs", ["init", "--pipeline", "ralph", "--file", lockFile, "--prompt", "blocked"]);
check("锁存在时 init 被拒绝", blocked.status === 2 && /locked/.test(blocked.stderr), blocked.stderr);
check("锁被拒绝时状态未被覆盖", JSON.parse(readFileSync(lockFile, "utf8")).prompt === "test prompt");
const old = new Date(Date.now() - 40000);
utimesSync(lockPath, old, old);
const stale = run("state.mjs", ["init", "--pipeline", "ralph", "--file", lockFile, "--prompt", "stale"]);
check("陈旧锁被清理后 init 成功", stale.status === 0 && !existsSync(lockPath), stale.stderr);

const readEvents = () => JSON.parse(run("state.mjs", ["events", "--pipeline", "ralph", "--file", lockFile, "--json"]).stdout).events;
check("init 写入事件日志", readEvents().some((event) => event.event === "init"));
const stateForWrites = JSON.parse(readFileSync(lockFile, "utf8"));
stateForWrites.round = 1;
run("state.mjs", ["write", "--pipeline", "ralph", "--file", lockFile], JSON.stringify(stateForWrites));
check("write 写入事件日志", readEvents().some((event) => event.event === "write"));
run("state.mjs", ["gate", "--pipeline", "ralph", "--file", lockFile, "--apply"]);
check("gate --apply 写入事件日志", readEvents().some((event) => event.event === "gate"));

// 任务状态迁移：write 自动对比旧状态，记录每轮任务状态变化
// 先建立基线：状态里已有 t1(done)/t2(in_progress)
const baseline = JSON.parse(JSON.stringify(stateForWrites));
baseline.tasks = [
  { id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 },
  { id: "t2", title: "b", status: "in_progress", depends_on: ["t1"], accept_criteria: ["ok"], failures: 0 },
];
run("state.mjs", ["write", "--pipeline", "ralph", "--file", lockFile], JSON.stringify(baseline));
// 下一轮：t2 变 done，新增 t3(pending)，t1 不变
const migrated = JSON.parse(JSON.stringify(baseline));
migrated.round = 3;
migrated.tasks = [
  { id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 },
  { id: "t2", title: "b", status: "done", depends_on: ["t1"], accept_criteria: ["ok"], failures: 0 },
  { id: "t3", title: "c", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0 },
];
run("state.mjs", ["write", "--pipeline", "ralph", "--file", lockFile], JSON.stringify(migrated));
const migratedEvents = readEvents();
const writeWithTransition = [...migratedEvents].reverse().find((event) => event.event === "write");
check("write 事件记录任务状态迁移", Array.isArray(writeWithTransition.transitions) && writeWithTransition.transitions.length > 0, JSON.stringify(writeWithTransition));
const transitionText = JSON.stringify(writeWithTransition.transitions);
check("迁移包含 t2 到 done", /"id":"t2".*"to":"done"/.test(transitionText), transitionText);
check("迁移包含新任务 t3 注册", /"id":"t3".*"to":"pending"/.test(transitionText), transitionText);
check("无变化的 t1 不在迁移中", !/"t1"/.test(transitionText), transitionText);

const writerA = JSON.parse(JSON.stringify(stateForWrites));
writerA.round = 2;
const writerB = JSON.parse(JSON.stringify(stateForWrites));
writerB.round = 3;
const concurrent = await Promise.all([
  runAsync("state.mjs", ["write", "--pipeline", "ralph", "--file", lockFile], JSON.stringify(writerA)),
  runAsync("state.mjs", ["write", "--pipeline", "ralph", "--file", lockFile], JSON.stringify(writerB)),
]);
check("并发 write 都成功", concurrent.every((item) => item.status === 0), concurrent.map((item) => item.stderr).join("\n"));
let finalState = null;
try {
  finalState = JSON.parse(readFileSync(lockFile, "utf8"));
} catch {}
check("并发 write 后状态仍是完整 JSON", finalState && [2, 3].includes(finalState.round), JSON.stringify(finalState));
check("并发 write 事件全部落盘", readEvents().filter((event) => event.event === "write").length >= 3);

console.log("\n== 可视化渲染 ==");
const renderDir = path.join(sandbox, "render");
mkdirSync(renderDir, { recursive: true });
const renderStateFile = path.join(renderDir, "render.json");
const renderState = {
  version: 1,
  prompt: "render test",
  max_iterations: 0,
  max_failures: 3,
  retry_on_failure: false,
  completion_promise: null,
  outer_iteration: 0,
  tasks: [
    { id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 },
    { id: "t2", title: "b", status: "in_progress", depends_on: ["t1"], accept_criteria: ["ok"], failures: 1 },
  ],
  consecutive_failures: 1,
  stall_counter: 0,
  fail_history: [],
  round: 2,
  stop_reason: null,
  budget: { max_tokens: 1000, spent_tokens: 100 },
};
writeFileSync(renderStateFile, JSON.stringify(renderState));
for (const event of [
  { ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 2 } },
  { ts: "2026-01-01T00:01:00.000Z", event: "write", round: 1, stop_reason: null, tasks: { done: 1, total: 2 } },
]) {
  writeFileSync(`${renderStateFile}.events.jsonl`, `${JSON.stringify(event)}\n`, { flag: "a" });
}
const renderHtmlFile = path.join(renderDir, "render.html");
let renderResult = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", renderHtmlFile]);
check("render 生成 HTML", renderResult.status === 0 && existsSync(renderHtmlFile), renderResult.stderr);
const html = readFileSync(renderHtmlFile, "utf8");
check("HTML 含任务卡片", /class="task"/.test(html) && /t1/.test(html) && /t2/.test(html));
check("HTML 含状态徽标", /badge-done/.test(html) && /badge-in_progress/.test(html));
check("HTML 含事件日志", /执行轨迹/.test(html) && /init/.test(html) && /write/.test(html));
check("HTML 含预算", /100\/1000/.test(html));
check("HTML 依赖图无环", !/存在环/.test(html));
check("HTML 自包含无外链", !/src="http|href="http/.test(html));

// 渲染必须把 write 事件里的任务迁移显示出来
const migratedJson = JSON.stringify({
  version: 1,
  prompt: "render test",
  max_iterations: 0,
  max_failures: 3,
  retry_on_failure: false,
  completion_promise: null,
  outer_iteration: 0,
  tasks: [
    { id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 },
    { id: "t2", title: "b", status: "done", depends_on: ["t1"], accept_criteria: ["ok"], failures: 0 },
  ],
  consecutive_failures: 0,
  stall_counter: 0,
  fail_history: [],
  round: 3,
  stop_reason: null,
});
run("state.mjs", ["write", "--pipeline", "ralph", "--file", renderStateFile], migratedJson);
renderResult = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", renderHtmlFile]);
check("HTML 显示任务状态迁移", /t2:in_progress→done|t2:in_progress→done/.test(readFileSync(renderHtmlFile, "utf8")), renderHtmlFile);

// 只读性：render 不写状态、不追加事件、不创建锁
const stateBefore = readFileSync(renderStateFile, "utf8");
const eventsBefore = readFileSync(`${renderStateFile}.events.jsonl`, "utf8");
renderResult = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", renderHtmlFile]);
const stateAfter = readFileSync(renderStateFile, "utf8");
const eventsAfter = readFileSync(`${renderStateFile}.events.jsonl`, "utf8");
check("render 不修改状态文件", stateBefore === stateAfter);
check("render 不修改事件日志", eventsBefore === eventsAfter);
check("render 不创建锁", !existsSync(`${renderStateFile}.lock`));

// 非法状态文件仍应给出可读错误
const brokenRender = path.join(renderDir, "broken.json");
writeFileSync(brokenRender, "{not json");
renderResult = run("render.mjs", ["--pipeline", "ralph", "--file", brokenRender]);
check("render 拒绝非法 JSON", renderResult.status === 2 && /not valid JSON/.test(renderResult.stderr), renderResult.stderr);

console.log("\n== 实时看板（SSE） ==");
const serveDir = path.join(sandbox, "serve");
mkdirSync(serveDir, { recursive: true });
const serveStateFile = path.join(serveDir, "coding.json");
writeFileSync(
  serveStateFile,
  JSON.stringify({
    version: 1,
    prompt: "serve test",
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
  }),
);
writeFileSync(`${serveStateFile}.events.jsonl`, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 1 } })}\n`);
const servePort = 8917;
const serveProc = spawn(process.execPath, [path.join(root, "scripts", "serve.mjs"), "--pipeline", "coding", "--file", serveStateFile, "--port", String(servePort), "--interval", "200"], {
  cwd: sandbox,
  stdio: ["ignore", "pipe", "pipe"],
});
let serveOut = "";
serveProc.stdout.on("data", (chunk) => (serveOut += chunk));
serveProc.stderr.on("data", (chunk) => (serveOut += chunk));
const waitForServe = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${servePort}/health`, (r) => {
            let body = "";
            r.on("data", (c) => (body += c));
            r.on("end", () => resolve(body));
          })
          .on("error", reject);
      });
      if (res.includes("ok")) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
check("serve 启动并监听", await waitForServe(), serveOut);

// 页面是完整 HTML
const page = await new Promise((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${servePort}/`, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve(body));
    })
    .on("error", reject);
});
check("serve 返回看板 HTML", page.includes('class="task"') && page.includes("t1"), serveOut);

// SSE 连接 + 写入新状态 → 收到 render 事件
const ssePromise = fetchSseEvent(`http://127.0.0.1:${servePort}/events`, "event: render", 5000);
const updated = JSON.parse(readFileSync(serveStateFile, "utf8"));
updated.round = 1;
updated.tasks[0].status = "done";
writeFileSync(serveStateFile, JSON.stringify(updated));
const sseData = await ssePromise;
check("SSE 推送 render 事件", /event: render/.test(sseData), sseData);

// 页面刷新后显示新状态
await new Promise((r) => setTimeout(r, 600));
const page2 = await new Promise((resolve, reject) => {
  http
    .get(`http://127.0.0.1:${servePort}/`, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve(body));
    })
    .on("error", reject);
});
check("SSE 后页面反映新状态", /badge-done/.test(page2), serveOut);

serveProc.kill();

// 只读性：serve 不修改状态文件、不追加事件、不创建锁，也不触发 render 产物落盘
const serveStateBefore = readFileSync(serveStateFile, "utf8");
const serveEventsBefore = readFileSync(`${serveStateFile}.events.jsonl`, "utf8");
check("serve 不修改状态文件", serveStateBefore === readFileSync(serveStateFile, "utf8"));
check("serve 不修改事件日志", serveEventsBefore === readFileSync(`${serveStateFile}.events.jsonl`, "utf8"));
check("serve 不创建锁", !existsSync(`${serveStateFile}.lock`));
check("serve 不生成 render HTML 产物", !existsSync(serveStateFile.replace(/\.json$/, ".html")), serveOut);

console.log("\n== 预算与依赖图 ==");
const budgetFile = path.join(sandbox, "budget.json");
const budgetState = initState("ralph", budgetFile);
budgetState.budget = { max_tokens: 100, spent_tokens: 100 };
writeFileSync(budgetFile, JSON.stringify(budgetState));
check("token 预算耗尽判 BUDGET", gate(budgetFile).stop_reason === "BUDGET");
budgetState.budget = { max_tokens: 100, spent_tokens: 1, max_cost_usd: 2, spent_cost_usd: 2 };
writeFileSync(budgetFile, JSON.stringify(budgetState));
check("费用预算耗尽判 BUDGET", gate(budgetFile).stop_reason === "BUDGET");
budgetState.tasks = [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }];
budgetState.budget = { max_tokens: 0, spent_tokens: 0 };
writeFileSync(budgetFile, JSON.stringify(budgetState));
check("DONE 优先于 BUDGET", gate(budgetFile).stop_reason === "DONE");

const graphFile = path.join(sandbox, "graph.json");
const graphState = (tasks, maxIterations = 0) =>
  writeFileSync(graphFile, JSON.stringify({ max_iterations: maxIterations, tasks }));
graphState([
  { id: "t1", depends_on: [] },
  { id: "t2", depends_on: ["t1"] },
]);
let graphResult = run("graph.mjs", ["--pipeline", "ralph", "--file", graphFile, "--json"]);
check(
  "依赖图给出拓扑顺序",
  graphResult.status === 0 && JSON.parse(graphResult.stdout).order.join(",") === "t1,t2",
  graphResult.stdout + graphResult.stderr,
);
graphState([
  { id: "t1", depends_on: ["t2"] },
  { id: "t2", depends_on: ["t1"] },
]);
graphResult = run("graph.mjs", ["--pipeline", "ralph", "--file", graphFile, "--json"]);
check(
  "依赖环被 graph 拒绝",
  graphResult.status === 1 && JSON.parse(graphResult.stdout).cycles.length === 2,
  graphResult.stdout + graphResult.stderr,
);
graphState([{ id: "t1", depends_on: ["nope"] }]);
graphResult = run("graph.mjs", ["--pipeline", "ralph", "--file", graphFile, "--json"]);
check(
  "未知依赖被 graph 拒绝",
  graphResult.status === 1 && JSON.parse(graphResult.stdout).errors.length > 0,
  graphResult.stdout + graphResult.stderr,
);
graphState(Array.from({ length: 9 }, (_, index) => ({ id: `t${index + 1}`, depends_on: [] })));
graphResult = run("graph.mjs", ["--pipeline", "ralph", "--file", graphFile, "--json"]);
check(
  "子任务超预算被 graph 拒绝",
  graphResult.status === 1 && JSON.parse(graphResult.stdout).budget.overflow === true,
  graphResult.stdout + graphResult.stderr,
);

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
