#!/usr/bin/env node
// agent-pipelines 的运行时辅助脚本测试：状态机与 scope 检查。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
