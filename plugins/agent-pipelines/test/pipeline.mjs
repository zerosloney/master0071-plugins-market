#!/usr/bin/env node
// agent-pipelines 的运行时辅助脚本测试：状态机与 scope 检查。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
