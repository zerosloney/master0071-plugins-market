#!/usr/bin/env node
// agent-pipelines 缺陷回归测试：审计实测确认过的缺陷，各自锁一条断言。
// 覆盖四条独立缺陷（改前会红、改后必须绿）：
//   1. scope 判定基准未锚 git 根：同一处越界改动，从子目录调用被判成合规（零容忍失效）；
//   2. DONE 判定不校验 critical_checkpoints[].passed：未通过的硬门禁被跨过；
//   3. scope 结论没接进门禁：scope 判 FAIL 后 gate 仍按自报字段放行；
//   4. args 静默吞掉以 -- 开头的值：整条 scope 规则凭空消失。
// 零依赖纯 Node，与既有三个套件同风格（PASS/FAIL 逐条打印，末尾汇总，失败退出码 1）。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "agent-pipelines-regression-"));
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 建一个最小 git 仓库：src/ 在 scope 内，sub/ 是子目录调用入口
function makeRepo(name) {
  const repo = path.join(sandbox, name);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, "sub"), { recursive: true });
  writeFileSync(path.join(repo, "src", "a.js"), "a\n");
  writeFileSync(path.join(repo, "sub", "keep.js"), "keep\n");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", ".");
  git("commit", "-m", "base");
  return { repo, base: git("rev-parse", "HEAD").trim(), git };
}

console.log("\n== scope 判定基准锚定 git 仓库根 ==");
const scopeRepo = makeRepo("scope-repo");
const scopeArgs = (extra = [], cwd = scopeRepo.repo) =>
  run("scope.mjs", ["--base", scopeRepo.base, "--hard", "src/**", "--json", ...extra], undefined, cwd);

// 未跟踪的越界改动放在仓库根：从仓库根调用必须 FAIL
writeFileSync(path.join(scopeRepo.repo, "other.txt"), "x\n");
const rootCall = scopeArgs();
check(
  "仓库根调用：越界未跟踪改动判 FAIL",
  rootCall.status === 1 && parseJson(rootCall.stdout)?.verdict === "FAIL",
  rootCall.stdout + rootCall.stderr,
);

// 同一条命令改从子目录调用：结论必须一致（改前 git ls-files 只列调用目录以下，越界改动整个消失 → PASS）
const subCall = scopeArgs(["--cwd", path.join(scopeRepo.repo, "sub")]);
check(
  "子目录调用：同一处越界改动同样判 FAIL",
  subCall.status === 1 && parseJson(subCall.stdout)?.verdict === "FAIL",
  subCall.stdout + subCall.stderr,
);
check(
  "子目录调用：越界文件仍被列进变更清单",
  parseJson(subCall.stdout)?.outside?.includes("other.txt"),
  subCall.stdout,
);

// 已跟踪文件的越界改动同样不能因调用目录不同而漏判（sub/keep.js 在 scope 外）
writeFileSync(path.join(scopeRepo.repo, "sub", "keep.js"), "keep changed\n");
const trackedSubCall = scopeArgs(["--cwd", path.join(scopeRepo.repo, "sub")]);
check(
  "子目录调用：已跟踪文件的越界改动同样判 FAIL",
  trackedSubCall.status === 1 && parseJson(trackedSubCall.stdout)?.outside?.includes("sub/keep.js"),
  trackedSubCall.stdout,
);

// 路径基准统一到仓库根：sub/src/x.js 不能被根级规则 "src/**" 误命中
// （改前 ls-files 在调用目录执行、输出 cwd 相对路径 "src/x.js"，正好命中 → 静默放行）
writeFileSync(path.join(scopeRepo.repo, "sub", "stray.js"), "s\n");
mkdirSync(path.join(scopeRepo.repo, "sub", "src"), { recursive: true });
writeFileSync(path.join(scopeRepo.repo, "sub", "src", "x.js"), "x\n");
const mixedBase = scopeArgs(["--cwd", path.join(scopeRepo.repo, "sub")]);
check(
  "scope 规则与变更清单同基准（仓库根相对）",
  parseJson(mixedBase.stdout)?.outside?.includes("sub/src/x.js") && !parseJson(mixedBase.stdout)?.hard?.includes("sub/src/x.js"),
  mixedBase.stdout,
);

console.log("\n== scope 结论接入门禁 ==");
// 状态文件放在仓库内 .loop-cli/ 下：scope 的默认排除会把它从变更清单里剔掉
const statePath = path.join(scopeRepo.repo, ".loop-cli", "state", "coding-pipeline.json");
mkdirSync(path.dirname(statePath), { recursive: true });
const codingState = () => ({
  version: 1,
  prompt: "regression",
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
  scope: { hard: ["src/**"], soft: [], forbidden: [] },
  scope_drift: null,
});
writeFileSync(statePath, JSON.stringify(codingState()));
const applied = run(
  "scope.mjs",
  ["--base", scopeRepo.base, "--file", statePath, "--apply", "--json"],
  undefined,
  scopeRepo.repo,
);
check(
  "scope --apply 把 FAIL 结论写回状态文件",
  applied.status === 1 && parseJson(readFileSync(statePath, "utf8")).scope_drift === "FAIL",
  applied.stdout + applied.stderr,
);
const gated = run("state.mjs", ["gate", "--pipeline", "coding", "--file", statePath, "--json"]);
check(
  "scope 越界写回后 gate 判 ESCALATE 并给出原因",
  parseJson(gated.stdout)?.stop_reason === "ESCALATE" && /scope/i.test(gated.stdout),
  gated.stdout + gated.stderr,
);

console.log("\n== DONE 判定校验 critical_checkpoints ==");
const checkpointState = path.join(sandbox, "checkpoint.json");
const withCheckpoints = (passed) => ({
  ...codingState(),
  tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
  scope_drift: "PASS",
  critical_checkpoints: [{ id: "cp-lint", description: "lint 通过", passed }],
});
writeFileSync(checkpointState, JSON.stringify(withCheckpoints(false)));
const blocked = run("state.mjs", ["gate", "--pipeline", "coding", "--file", checkpointState, "--json"]);
check(
  "critical checkpoint 未通过时不判 DONE",
  parseJson(blocked.stdout)?.stop_reason !== "DONE",
  blocked.stdout + blocked.stderr,
);
check(
  "未通过的 checkpoint 在 reason 里点名",
  /cp-lint/.test(String(parseJson(blocked.stdout)?.reason)),
  blocked.stdout,
);
writeFileSync(checkpointState, JSON.stringify(withCheckpoints(true)));
const allowed = run("state.mjs", ["gate", "--pipeline", "coding", "--file", checkpointState, "--json"]);
check(
  "全部 checkpoint 通过且 scope_drift=PASS 时判 DONE",
  parseJson(allowed.stdout)?.stop_reason === "DONE",
  allowed.stdout + allowed.stderr,
);

console.log("\n== args 不静默吞掉 -- 开头的值 ==");
const argsRepo = makeRepo("args-repo");
writeFileSync(path.join(argsRepo.repo, "--weird.txt"), "w\n");
const weirdValue = run(
  "scope.mjs",
  ["--base", argsRepo.base, "--hard", "--weird.txt", "--json"],
  undefined,
  argsRepo.repo,
);
check(
  "以 -- 开头的值被当成值收下（规则不再凭空消失）",
  weirdValue.status === 0 && parseJson(weirdValue.stdout)?.hard?.includes("--weird.txt"),
  weirdValue.stdout + weirdValue.stderr,
);
const unknownArg = run("scope.mjs", ["--base", argsRepo.base, "--hards", "src/**"], undefined, argsRepo.repo);
check(
  "未知参数报错并列出已知开关",
  unknownArg.status === 2 && /unknown argument/.test(unknownArg.stderr) && /--hard/.test(unknownArg.stderr),
  unknownArg.stderr,
);
const missingValue = run("scope.mjs", ["--base", argsRepo.base, "--hard"], undefined, argsRepo.repo);
check(
  "值开关缺值报错而不是静默当布尔",
  missingValue.status === 2 && /requires a value/.test(missingValue.stderr),
  missingValue.stderr,
);
const boolFirst = run(
  "scope.mjs",
  ["--json", "--base", argsRepo.base, "--hard", "--weird.txt"],
  undefined,
  argsRepo.repo,
);
check(
  "布尔开关后面跟其它开关仍按布尔解析",
  boolFirst.status === 0 && parseJson(boolFirst.stdout)?.verdict === "PASS",
  boolFirst.stdout + boolFirst.stderr,
);

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
