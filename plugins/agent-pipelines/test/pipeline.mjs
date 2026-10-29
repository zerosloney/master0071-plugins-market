#!/usr/bin/env node
// agent-pipelines 的运行时辅助脚本测试：状态机与 scope 检查。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const tmpLeftovers = readdirSync(path.dirname(writeFile)).filter(
  (name) => name.startsWith(path.basename(writeFile) + ".") && name.endsWith(".tmp"),
);
check("write 接受合法状态并原子落盘", written.status === 0 && existsSync(writeFile) && tmpLeftovers.length === 0, written.stderr);

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
const negated = run("scope.mjs", ["--base", base, "--forbidden", "!dist/**", "--json"], undefined, repo);
check("scope 的 ! 否定模式显式报错而非静默不匹配", negated.status === 2 && /not supported/.test(negated.stderr), negated.stderr);

// 前导 **/ 不匹配仓库根目录文件：forbidden 方向 fail-open，必须打印警告提示根级模式
writeFileSync(path.join(repo, "root.lock"), "lock\n");
mkdirSync(path.join(repo, "nested"));
writeFileSync(path.join(repo, "nested", "deep.lock"), "lock\n");
const globstarWarn = run(
  "scope.mjs",
  ["--base", base, "--hard", "src/**,docs/**,root.lock,nested/**", "--forbidden", "**/*.lock", "--json"],
  undefined,
  repo,
);
check(
  "前导 **/ 模式打印根目录警告",
  globstarWarn.status === 1 && /warning.*\*\/\*\.lock.*repo root/.test(globstarWarn.stderr),
  globstarWarn.stderr,
);
check(
  "前导 **/ 的 forbidden 只命中子目录、漏掉根目录 lock（fail-open 实况）",
  JSON.parse(globstarWarn.stdout).forbidden.join(",") === "nested/deep.lock" && !JSON.parse(globstarWarn.stdout).forbidden.includes("root.lock"),
  globstarWarn.stdout,
);
// ? 单字符匹配且不跨目录段
mkdirSync(path.join(repo, "glob"));
writeFileSync(path.join(repo, "glob", "a.ts"), "x\n");
const questionMark = run("scope.mjs", ["--base", base, "--hard", "glob/?.ts", "--json"], undefined, repo);
check("? 匹配单字符（glob/a.ts 命中 hard）", JSON.parse(questionMark.stdout).hard.length === 1, questionMark.stdout);
const questionCross = run("scope.mjs", ["--base", base, "--hard", "?.ts", "--json"], undefined, repo);
check("? 不跨目录段（glob/a.ts 不在根级 ?.ts 内）", !JSON.parse(questionCross.stdout).hard.includes("glob/a.ts"), questionCross.stdout);
// src/** 不误伤 srcdir 前缀
mkdirSync(path.join(repo, "srcdir"));
writeFileSync(path.join(repo, "srcdir", "sibling.ts"), "x\n");
const prefix = run("scope.mjs", ["--base", base, "--hard", "src/**", "--json"], undefined, repo);
check("src/** 不误伤 srcdir/（前缀不同段）", !JSON.parse(prefix.stdout).hard.includes("srcdir/sibling.ts"), prefix.stdout);
// 清理本段新增文件，恢复 scope() 共享基线，避免污染后续 hard/soft/状态文件用例
rmSync(path.join(repo, "root.lock"), { force: true });
rmSync(path.join(repo, "nested"), { recursive: true, force: true });
rmSync(path.join(repo, "glob"), { recursive: true, force: true });
rmSync(path.join(repo, "srcdir"), { recursive: true, force: true });

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
// 陈旧锁清理后重放 init：initState 产生的是空任务状态（无进度），直接 init 允许覆盖（防覆盖只拦有进度状态）
const stale = run("state.mjs", ["init", "--pipeline", "ralph", "--file", lockFile, "--prompt", "stale"]);
check("陈旧锁被清理后 init 成功（空任务无进度）", stale.status === 0 && !existsSync(lockPath), stale.stderr);

// 防误覆盖扩展：空任务但 round>0 / stop_reason 非空 / 损坏 JSON 的状态也不允许静默覆盖
const progressFile = path.join(sandbox, "progress.json");
const progressState = JSON.parse(JSON.stringify(valid));
progressState.tasks = [];
progressState.round = 3;
run("state.mjs", ["write", "--pipeline", "ralph", "--file", progressFile], JSON.stringify(progressState));
const refusedProgress = run("state.mjs", ["init", "--pipeline", "ralph", "--file", progressFile, "--prompt", "again"]);
check("init 拒绝覆盖 round>0 的空任务状态", refusedProgress.status === 2 && /--force/.test(refusedProgress.stderr), refusedProgress.stderr);
const stoppedState = JSON.parse(JSON.stringify(progressState));
stoppedState.round = 0;
stoppedState.stop_reason = "ESCALATE";
run("state.mjs", ["write", "--pipeline", "ralph", "--file", progressFile], JSON.stringify(stoppedState));
const refusedStopped = run("state.mjs", ["init", "--pipeline", "ralph", "--file", progressFile, "--prompt", "again"]);
check("init 拒绝覆盖已停止状态", refusedStopped.status === 2 && /--force/.test(refusedStopped.stderr), refusedStopped.stderr);
writeFileSync(progressFile, "{corrupted");
const refusedCorrupt = run("state.mjs", ["init", "--pipeline", "ralph", "--file", progressFile, "--prompt", "again"]);
check("init 对损坏状态也要求 --force", refusedCorrupt.status === 2 && /--force/.test(refusedCorrupt.stderr), refusedCorrupt.stderr);
const freshState = JSON.parse(JSON.stringify(valid));
freshState.tasks = [];
freshState.round = 0;
freshState.stop_reason = null;
run("state.mjs", ["write", "--pipeline", "ralph", "--file", progressFile], JSON.stringify(freshState));
const allowedFresh = run("state.mjs", ["init", "--pipeline", "ralph", "--file", progressFile, "--prompt", "fresh"]);
check("无进度状态允许直接 init", allowedFresh.status === 0, allowedFresh.stderr);

const readEvents = () => JSON.parse(run("state.mjs", ["events", "--pipeline", "ralph", "--file", lockFile, "--json"]).stdout).events;
check("init 写入事件日志", readEvents().some((event) => event.event === "init"));

// 事件日志轮转（2026-10-28 市场审查）：到上限即改名为 .1，events 子命令须能跨轮转段读到历史，
// 否则轮转后「历史消失」——比不轮转更难排查。这里直接造一个超限的 .events.jsonl，再触发一次 write。
{
  const rotFile = path.join(sandbox, "rot.json");
  const rotLog = path.join(sandbox, "rot.events.jsonl");
  run("state.mjs", ["write", "--pipeline", "ralph", "--file", rotFile], JSON.stringify(valid));
  const filler = `${JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", event: "filler", pipeline: "ralph" })}\n`;
  writeFileSync(rotLog, filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length) + 10), "utf8");
  run("state.mjs", ["write", "--pipeline", "ralph", "--file", rotFile], JSON.stringify(valid));
  check("超限后事件日志轮转为 .1", existsSync(`${rotLog}.1`));
  const rotEvents = JSON.parse(run("state.mjs", ["events", "--pipeline", "ralph", "--file", rotFile, "--json"]).stdout).events;
  check("轮转后 events 仍能读到轮转段历史", rotEvents.some((e) => e.event === "filler"));
  check("轮转后 events 读到新写入", rotEvents.some((e) => e.event === "write"));
  check("轮转后事件仍在时间序（filler 段在前）", rotEvents.findIndex((e) => e.event === "filler") < rotEvents.findLastIndex((e) => e.event === "write"));
}

// 防误覆盖：已有非空任务列表的状态是带进度的管道，init 必须拒绝，--force 才放行
const guardFile = path.join(sandbox, "guard.json");
run("state.mjs", ["write", "--pipeline", "ralph", "--file", guardFile], JSON.stringify(valid));
const refusedInit = run("state.mjs", ["init", "--pipeline", "ralph", "--file", guardFile, "--prompt", "again"]);
check("init 拒绝覆盖非空状态", refusedInit.status === 2 && /--force/.test(refusedInit.stderr), refusedInit.stderr);
check("被拒绝的 init 未破坏原状态", JSON.parse(readFileSync(guardFile, "utf8")).tasks.length === 2);
const forcedInit = run("state.mjs", ["init", "--pipeline", "ralph", "--file", guardFile, "--prompt", "again", "--force"]);
check("init --force 才允许覆盖", forcedInit.status === 0 && JSON.parse(readFileSync(guardFile, "utf8")).tasks.length === 0, forcedInit.stderr);
const stateForWrites = JSON.parse(readFileSync(lockFile, "utf8"));
stateForWrites.round = 1;
run("state.mjs", ["write", "--pipeline", "ralph", "--file", lockFile], JSON.stringify(stateForWrites));
check("write 写入事件日志", readEvents().some((event) => event.event === "write"));
run("state.mjs", ["gate", "--pipeline", "ralph", "--file", lockFile, "--apply"]);
check("gate --apply 写入事件日志", readEvents().some((event) => event.event === "gate"));

// 事件日志记录相对路径而非绝对路径（日志可能随仓库分发，绝对路径泄露本机目录结构）
const relPathEvent = readEvents().find((event) => event.event === "write");
check(
  "事件日志 file 字段为相对路径",
  relPathEvent && !path.isAbsolute(String(relPathEvent.file)) && String(relPathEvent.file).replace(/\\/g, "/") === "locked.json",
  JSON.stringify(relPathEvent && relPathEvent.file),
);

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
    { id: "t3", title: "c", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0 },
  ],
  consecutive_failures: 1,
  stall_counter: 0,
  fail_history: [],
  round: 2,
  stop_reason: null,
  budget: { max_tokens: 1000, spent_tokens: 100 },
};
writeFileSync(renderStateFile, JSON.stringify(renderState));
// 事件文件路径必须按 .json → .events.jsonl 替换规则派生（loadEvents / state.mjs 同款）：
// 此前写成 `${file}.events.jsonl` 追加式，与应用侧路径永不重合，事件从未被渲染，
// 下面的「含事件日志」断言靠占位文案里的 "write" 字样假阳性通过。
const renderEventsFile = renderStateFile.replace(/\.json$/, ".events.jsonl");
for (const event of [
  { ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 2 } },
  { ts: "2026-01-01T00:01:00.000Z", event: "write", round: 1, stop_reason: null, tasks: { done: 1, total: 2 } },
]) {
  writeFileSync(renderEventsFile, `${JSON.stringify(event)}\n`, { flag: "a" });
}
const renderHtmlFile = path.join(renderDir, "render.html");
let renderResult = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", renderHtmlFile]);
check("render 生成 HTML", renderResult.status === 0 && existsSync(renderHtmlFile), renderResult.stderr);
const html = readFileSync(renderHtmlFile, "utf8");
check("HTML 含任务卡片", /class="task"/.test(html) && /t1/.test(html) && /t2/.test(html));
check("HTML 含状态徽标", /badge-done/.test(html) && /badge-in_progress/.test(html));
// round/tasks/ts 是事件行独有的标记，占位文案与静态页面都不含，才能真正证明事件被渲染
check("HTML 含事件日志", /执行轨迹/.test(html) && /round=0/.test(html) && /round=1/.test(html) && /tasks 1\/2/.test(html) && /2026-01-01T00:01:00\.000Z/.test(html));
check("HTML 含预算", /100\/1000/.test(html));
// 静态导出没有 /events 端点：不得注入 SSE 客户端，否则浏览器会反复重连并刷控制台错误
check("静态导出不含 EventSource 客户端（serve 专有）", !html.includes("new EventSource"), "静态页面不应注入实时客户端");
check("HTML 依赖图无环", !/存在环/.test(html));
check("HTML 自包含无外链", !/src="http|href="http/.test(html));
// .task 绝对定位必须显式设 top：t1/t3 同层（第 0 层两行），t3 应在第 1 行（18 + 110px）
check("HTML 同层任务按行堆叠（显式 top）", /top:18px/.test(html) && /top:128px/.test(html), html.match(/top:\d+px/g)?.join(","));

// 依赖链必须横向分层：t1(层0) → t2(层1)。此前 layoutGraph 的 ?? 0 让 layer 恒为空，
// 全部任务挤在 left:0% 一列——该断言曾在 bug 期间被「全 0 层」意外满足，现在锚定真实分层。
check(
  "依赖图按层分列（t1 层0 / t2 层1）",
  /left:0%;top:18px/.test(html) && /left:80%;top:18px/.test(html),
  html.match(/left:[\d.]+%;top:\d+px/g)?.join(" | "),
);

// 环场景分层不崩溃且不无限递归：环上节点兜底到可显示的层
const cycleRenderFile = path.join(renderDir, "cycle.json");
writeFileSync(
  cycleRenderFile,
  JSON.stringify({
    ...renderState,
    tasks: [
      { id: "c1", title: "环1", status: "pending", depends_on: ["c2"], accept_criteria: ["ok"], failures: 0 },
      { id: "c2", title: "环2", status: "pending", depends_on: ["c1"], accept_criteria: ["ok"], failures: 0 },
    ],
  }),
);
const cycleRenderResult = run("render.mjs", ["--pipeline", "ralph", "--file", cycleRenderFile, "--out", path.join(renderDir, "cycle.html")]);
const cycleHtml = existsSync(path.join(renderDir, "cycle.html")) ? readFileSync(path.join(renderDir, "cycle.html"), "utf8") : "";
check("环场景渲染不崩溃且提示存在环", cycleRenderResult.status === 0 && /存在环/.test(cycleHtml) && /c1/.test(cycleHtml), cycleRenderResult.stderr);

// 输出路径与状态文件相同（--file 无 .json 后缀时派生路径不替换）必须拒绝，防止渲染覆盖状态
const noExtFile = path.join(renderDir, "noext-state");
writeFileSync(noExtFile, JSON.stringify(renderState));
const noExtResult = run("render.mjs", ["--pipeline", "ralph", "--file", noExtFile]);
check(
  "无 .json 后缀的状态文件被 render 拒绝",
  noExtResult.status === 2 && /resolves to the state file itself|\.json extension/.test(noExtResult.stderr),
  noExtResult.stderr,
);
check("被拒绝的渲染未覆盖状态文件", JSON.parse(readFileSync(noExtFile, "utf8")).round === 2);

// 数值字段同样不能裸内插：render/serve 路径不跑 validateState，被篡改的状态文件不能把 HTML 注进看板
const xssFile = path.join(renderDir, "xss.json");
writeFileSync(xssFile, JSON.stringify({ ...renderState, round: "<img src=x onerror=alert(1)>" }));
const xssResult = run("render.mjs", ["--pipeline", "ralph", "--file", xssFile, "--out", path.join(renderDir, "xss.html")]);
const xssHtml = existsSync(path.join(renderDir, "xss.html")) ? readFileSync(path.join(renderDir, "xss.html"), "utf8") : "";
check("概览卡数值字段转义，状态文件不可注入 HTML", xssResult.status === 0 && /&lt;img/.test(xssHtml) && !/<img src=x/.test(xssHtml), xssResult.stderr);
// 反向分支：xss.json 没有伴随的事件文件，loadEvents 应返回空数组并渲染占位提示
check("HTML 无事件文件时显示占位提示", /暂无事件/.test(xssHtml));

// 徽标 kind 会拼进 class 属性：恶意 status 不能属性逃逸（转义后的载荷会以惰性文本存在，
// 因此断言「未转义形态 onerror=alert(N)> 不出现、转义形态 &lt;img 出现」）
const badgeXssFile = path.join(renderDir, "xss-badge.json");
writeFileSync(
  badgeXssFile,
  JSON.stringify({
    ...renderState,
    tasks: [{ id: "t1", title: "a", status: `pending"><img src=x onerror=alert(3)>`, depends_on: [], accept_criteria: ["ok"], failures: 0 }],
  }),
);
const badgeXssResult = run("render.mjs", ["--pipeline", "ralph", "--file", badgeXssFile, "--out", path.join(renderDir, "xss-badge.html")]);
const badgeXssHtml = existsSync(path.join(renderDir, "xss-badge.html")) ? readFileSync(path.join(renderDir, "xss-badge.html"), "utf8") : "";
check(
  "状态徽标 kind 白名单化，task.status 不可属性逃逸",
  badgeXssResult.status === 0 && /&lt;img src=x/.test(badgeXssHtml) && !/onerror=alert\(3\)>/.test(badgeXssHtml) && !/badge badge-pending"><img/.test(badgeXssHtml),
  badgeXssResult.stderr,
);

// 事件行的 round 与 tasks.done/total 来自 .events.jsonl，同样不允许裸内插
// （loadEvents 按 .json → .events.jsonl 替换规则定位事件文件，写错路径会静默渲染 0 事件）
const eventXssFile = path.join(renderDir, "xss-events.json");
writeFileSync(eventXssFile, JSON.stringify(renderState));
writeFileSync(
  eventXssFile.replace(/\.json$/, ".events.jsonl"),
  `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: `<img src=x onerror=alert(4)>`, stop_reason: null, tasks: { done: `</span><script>alert(5)</script>`, total: 1 } })}\n`,
);
const eventXssResult = run("render.mjs", ["--pipeline", "ralph", "--file", eventXssFile, "--out", path.join(renderDir, "xss-events.html")]);
const eventXssHtml = existsSync(path.join(renderDir, "xss-events.html")) ? readFileSync(path.join(renderDir, "xss-events.html"), "utf8") : "";
check(
  "事件行 round/tasks 数值转义，事件日志不可注入 HTML",
  eventXssResult.status === 0 && !/onerror=alert\(4\)>/.test(eventXssHtml) && !/<script/.test(eventXssHtml) && /&lt;script&gt;/.test(eventXssHtml),
  eventXssResult.stderr,
);

// tasks 数组里的 null 条目不允许崩掉渲染：按 layoutGraph 口径过滤并落到 graph 警告
const nullTaskFile = path.join(renderDir, "null-task.json");
writeFileSync(nullTaskFile, JSON.stringify({ ...renderState, tasks: [null, renderState.tasks[0]] }));
const nullTaskResult = run("render.mjs", ["--pipeline", "ralph", "--file", nullTaskFile, "--out", path.join(renderDir, "null-task.html")]);
const nullTaskHtml = existsSync(path.join(renderDir, "null-task.html")) ? readFileSync(path.join(renderDir, "null-task.html"), "utf8") : "";
check(
  "render 容忍 tasks 中的 null 条目",
  nullTaskResult.status === 0 && /class="task"/.test(nullTaskHtml) && /task without a string id/.test(nullTaskHtml),
  nullTaskResult.stderr,
);

// main() 计算的警告此前被丢弃：缺 id 任务必须出现在页面顶部的 warnings 区块
const warnFile = path.join(renderDir, "warn.json");
writeFileSync(warnFile, JSON.stringify({ ...renderState, tasks: [{ title: "no id", status: "pending", depends_on: [], accept_criteria: [], failures: 0 }] }));
const warnResult = run("render.mjs", ["--pipeline", "ralph", "--file", warnFile, "--out", path.join(renderDir, "warn.html")]);
const warnHtml = existsSync(path.join(renderDir, "warn.html")) ? readFileSync(path.join(renderDir, "warn.html"), "utf8") : "";
check("渲染页面包含 warnings 区块", warnResult.status === 0 && /class="warnings"/.test(warnHtml) && /存在缺少 id 的任务/.test(warnHtml), warnResult.stderr);

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
const eventsBefore = readFileSync(renderEventsFile, "utf8");
renderResult = run("render.mjs", ["--pipeline", "ralph", "--file", renderStateFile, "--out", renderHtmlFile]);
const stateAfter = readFileSync(renderStateFile, "utf8");
const eventsAfter = readFileSync(renderEventsFile, "utf8");
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
// 与 render 段同理：按替换规则派生事件文件路径，serve 的 watch / 轮询才盯得住同一份文件
const serveEventsFile = serveStateFile.replace(/\.json$/, ".events.jsonl");
writeFileSync(serveEventsFile, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "init", round: 0, stop_reason: null, tasks: { done: 0, total: 1 } })}\n`);
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
check("serve 返回看板 HTML（含种子事件行）", page.includes('class="task"') && page.includes("t1") && page.includes("round=0") && page.includes("tasks 0/1"), serveOut);

// 2026-10-28：服务端 SSE 与事件此前都齐备，但页面里没有客户端，README 宣称的「浏览器自动刷新」
// 实际不生效。此断言锁住「推送 + 重载」这条链路的客户端一半。
check("serve 页面注入 EventSource 客户端（自动刷新实际生效）",
  page.includes("new EventSource('/events')") && page.includes("addEventListener('render'"), serveOut);

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

// Host 头校验（2026-10-28）：只绑 127.0.0.1 不防 DNS rebinding——恶意域名解析到 127.0.0.1 后，
// 浏览器会当作同源向本服务取数，读走任务标题 / 验收标准 / 状态文件绝对路径。这里直接发一个
// 伪造成攻击者域名的 Host，要求 403 且不返回看板正文。
const rebind = await new Promise((resolve) => {
  const req = http.request(
    { host: "127.0.0.1", port: servePort, path: "/", method: "GET", headers: { Host: "evil.example.com" } },
    (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, body }));
    },
  );
  req.on("error", () => resolve({ status: 0, body: "" }));
  req.end();
});
check("非回环 Host 的请求被 403 拒绝（防 DNS rebinding）",
  rebind.status === 403 && !/badge-done|<html/i.test(rebind.body), `status=${rebind.status} body=${rebind.body.slice(0, 120)}`);

// 反向锚：回环字面量必须照常放行，否则校验会把正常访问也挡掉
const loopbackOk = await new Promise((resolve) => {
  const req = http.request(
    { host: "127.0.0.1", port: servePort, path: "/health", method: "GET", headers: { Host: `localhost:${servePort}` } },
    (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, body }));
    },
  );
  req.on("error", () => resolve({ status: 0, body: "" }));
  req.end();
});
check("localhost 字面量 Host 照常放行", loopbackOk.status === 200 && /"ok":true/.test(loopbackOk.body),
  `status=${loopbackOk.status} body=${loopbackOk.body.slice(0, 120)}`);

// userinfo 冒充回环（2026-10-29 修复）：旧实现手工切串 `raw.startsWith("[") ? raw.slice(0, idx+1) : raw.split(":")[0]`，
// `[::1]@evil.example` 被切成 `[::1]` 从而放行——实测返回 **200 + 完整看板正文**。
// 浏览器不会发这种 Host（会先被浏览器拒），所以它不是可用的 rebinding 绕过，但
// 「Host 的主机名必须是回环字面量」这条不变量被破了。现在解析交给 URL，只看 hostname。
const probeHost = (host) => new Promise((resolve) => {
  const req = http.request(
    { host: "127.0.0.1", port: servePort, path: "/", method: "GET", headers: { Host: host } },
    (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, body }));
    },
  );
  req.on("error", () => resolve({ status: 0, body: "" }));
  req.end();
});
for (const badHost of ["[::1]@evil.example", "localhost@evil.example", "127.0.0.1.evil.example", "[::1]evil.example"]) {
  const r = await probeHost(badHost);
  check(`Host=${badHost} 被拒绝（不得返回看板正文）`,
    r.status === 403 && !/<html/i.test(r.body),
    `status=${r.status} body=${r.body.slice(0, 120)}`);
}
for (const goodHost of [`127.0.0.1:${servePort}`, `[::1]:${servePort}`]) {
  const r = await probeHost(goodHost);
  check(`Host=${goodHost} 照常放行（回环字面量未被误伤）`, r.status === 200, `status=${r.status}`);
}

serveProc.kill();

// 状态文件缺失时 serve 给出可读指引并以退出码 2 结束，不再裸栈崩溃（renderHtml 在监听前执行，不会占端口）
const missingServe = run("serve.mjs", ["--pipeline", "ralph", "--file", path.join(serveDir, "missing.json"), "--port", "8919"]);
check(
  "serve 状态文件缺失时干净退出",
  missingServe.status === 2 && /state file not found/.test(missingServe.stderr) && /state\.mjs init/.test(missingServe.stderr),
  missingServe.stderr,
);

// 只读性：serve 不修改状态文件、不追加事件、不创建锁，也不触发 render 产物落盘
const serveStateBefore = readFileSync(serveStateFile, "utf8");
const serveEventsBefore = readFileSync(serveEventsFile, "utf8");
check("serve 不修改状态文件", serveStateBefore === readFileSync(serveStateFile, "utf8"));
check("serve 不修改事件日志", serveEventsBefore === readFileSync(serveEventsFile, "utf8"));
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
graphState(Array.from({ length: 7 }, (_, index) => ({ id: `t${index + 1}`, depends_on: [] })));
graphResult = run("graph.mjs", ["--pipeline", "coding", "--file", graphFile, "--json"]);
check(
  "coding 拆分预算为 6（7 个任务即超预算）",
  graphResult.status === 1 && JSON.parse(graphResult.stdout).budget.overflow === true,
  graphResult.stdout + graphResult.stderr,
);

// ---- dag.mjs 单源：graph.mjs（CLI）与 render.mjs（看板）必须给出同一份拓扑序与环 ----
// 2026-10-28 合并前两处各写一份约 35 行同构代码，环检测一边用 Set、一边用 Array.includes。
// 这里直接对同一份任务集跑两条路径，要求结果逐项相等——单源被拆开时会立刻报红。
{
  const { analyzeDependencies } = await import(pathToFileURL(path.join(root, "scripts", "dag.mjs")).href);
  const { layoutGraph } = await import(pathToFileURL(path.join(root, "scripts", "render.mjs")).href);

  const dagTasks = [
    { id: "a", depends_on: [] },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["a"] },
    { id: "d", depends_on: ["b", "c"] },
    { id: "e", depends_on: [] },
  ];
  const analysis = analyzeDependencies(dagTasks);
  // 拓扑序只保证「依赖在前」，不保证同层全局字典序（Kahn 的初始队列排序后，新入队的节点追加在尾部，
  // 于是 a 的出边 b/c 排在初始无依赖的 e 之后）。断言按依赖关系验，别钉死字符串——
  // 钉死会把一次合法的实现调整变成假红。
  const posOf = new Map(analysis.order.map((id, i) => [id, i]));
  check("dag：拓扑序覆盖全部节点", analysis.order.length === dagTasks.length, analysis.order.join(","));
  check("dag：依赖一律排在被依赖者之后",
    dagTasks.every((t) => (t.depends_on || []).every((d) => posOf.get(d) < posOf.get(t.id))),
    analysis.order.join(","));
  check("dag：分层为最长依赖链（d 在第 2 层）", analysis.layer.get("d") === 2 && analysis.layer.get("a") === 0,
    JSON.stringify([...analysis.layer]));
  check("dag：无环无错", analysis.cycles.length === 0 && analysis.errors.length === 0);

  // 与看板路径逐项相等（两条入口共用同一实现后，这条断言防它们再次分叉）
  const layout = layoutGraph(dagTasks);
  check("dag ↔ layoutGraph 拓扑序一致", layout.order.join(",") === analysis.order.join(","), layout.order.join(","));
  check("dag ↔ layoutGraph 分层一致",
    [...analysis.layer].every(([id, l]) => layout.layer.get(id) === l), JSON.stringify([...layout.layer]));

  // 环：两侧都要点名同样的节点（Array.includes 与 Set 查找口径应一致）
  const cyclic = [{ id: "x", depends_on: ["y"] }, { id: "y", depends_on: ["x"] }, { id: "z", depends_on: [] }];
  const cycleAnalysis = analyzeDependencies(cyclic);
  check("dag：环内节点被点名、环外不受牵连",
    cycleAnalysis.cycles.sort().join(",") === "x,y" && cycleAnalysis.order.join(",") === "z",
    `${cycleAnalysis.cycles.join(",")} / ${cycleAnalysis.order.join(",")}`);
  check("dag ↔ layoutGraph 环判定一致",
    layoutGraph(cyclic).cycles.sort().join(",") === cycleAnalysis.cycles.join(","));

  // null / 缺 id 条目：计为 error 而非崩溃（render 侧同样依赖这条）
  const messy = [null, { depends_on: [] }, { id: "ok", depends_on: ["missing"] }];
  const messyAnalysis = analyzeDependencies(messy);
  check("dag：null 与缺 id 各计一条 error（共 2 条）",
    messyAnalysis.errors.filter((e) => /without a string id/.test(e)).length === 2, messyAnalysis.errors.join(" | "));
  check("dag：未知依赖进 errors", messyAnalysis.errors.some((e) => /unknown dependency missing/.test(e)),
    messyAnalysis.errors.join(" | "));
  check("dag：非数组输入退化为空", analyzeDependencies(undefined).order.length === 0);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
