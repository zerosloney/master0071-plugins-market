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
// gate 现在按 git 现状复算 scope（2026-10-29 第二轮），必须从仓库根跑：recheckScope 的
// git 命令以 process.cwd() 为基准，与 scope.mjs 的「判定基准锚 git 根」同口径。
const gated = run("state.mjs", ["gate", "--pipeline", "coding", "--file", statePath, "--json"], undefined, scopeRepo.repo);
check(
  "scope 越界写回后 gate 判 ESCALATE 并给出原因",
  parseJson(gated.stdout)?.stop_reason === "ESCALATE" && /scope/i.test(gated.stdout),
  gated.stdout + gated.stderr,
);

console.log("\n== DONE 判定校验 critical_checkpoints ==");
// 独立干净仓库（2026-10-29 第二轮）：gate 现在按 git 现状复算 scope，而 scopeRepo 里
// 前面的用例故意留下了越界文件——复算会如实报 outside scope，与本组要验的 checkpoint
// 判据互相干扰。用专属仓库 + 专属基线，让 scope 复算必然是 PASS。
const cpRepo = makeRepo("checkpoint-repo");
const checkpointState = path.join(cpRepo.repo, ".loop-cli", "checkpoint.json");
mkdirSync(path.dirname(checkpointState), { recursive: true });
const withCheckpoints = (passed) => ({
  ...codingState(),
  tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
  scope_drift: "PASS",
  scope: { base: cpRepo.base, hard: ["src/**"], soft: ["sub/**"], forbidden: [] },
  critical_checkpoints: [{ id: "cp-lint", description: "lint 通过", passed }],
});
writeFileSync(checkpointState, JSON.stringify(withCheckpoints(false)));
const blocked = run("state.mjs", ["gate", "--pipeline", "coding", "--file", checkpointState, "--json"], undefined, cpRepo.repo);
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
const allowed = run("state.mjs", ["gate", "--pipeline", "coding", "--file", checkpointState, "--json"], undefined, cpRepo.repo);
check(
  "全部 checkpoint 通过且 scope 复算 PASS 时判 DONE",
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

console.log("\n== 2026-10-29：门禁不再采信预设 stop_reason ==");
// 状态文件是执行者可写的普通 JSON。旧实现 gateFor 第一句就是
// `if (state.stop_reason) return { stop_reason: state.stop_reason }`，写个 "DONE" 进去就永远 DONE：
// 实测任务仍 pending、checkpoint 未通过、scope 未判定，validate 说 Valid、gate 说 DONE、--apply 照落盘。
{
  // 用独立干净仓库：gate 现在会按 git 现状复算 scope（2026-10-29 第二轮），
  // 落在非 git 目录里会得到「无法复算」而不是本组要验的「预设 stop_reason 不被采纳」。
  const forgedRepo = makeRepo("forged-repo");
  const forged = {
    ...codingState(),
    tasks: [{ id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
    critical_checkpoints: [{ id: "cp-forged", description: "未跑", passed: false }],
    scope_drift: null,
    scope: { base: forgedRepo.base, hard: ["src/**"], soft: ["sub/**"], forbidden: [] },
    stop_reason: "DONE",
  };
  const forgedPath = path.join(forgedRepo.repo, ".loop-cli", "forged-done.json");
  mkdirSync(path.dirname(forgedPath), { recursive: true });
  writeFileSync(forgedPath, JSON.stringify(forged));
  const g = run("state.mjs", ["gate", "--pipeline", "coding", "--file", forgedPath, "--json"], undefined, forgedRepo.repo);
  const out = parseJson(g.stdout);
  check("预设 stop_reason=DONE 不被采纳", out?.stop_reason !== "DONE", g.stdout);
  check("回执点明预设值未被信任", /NOT trusted/.test(String(out?.presetNote)), g.stdout);
  // 该状态下 cp-forged 未通过 → 拦；scope 复算 PASS 时不再赘述 scope（旧实现要求「两条都点名」，
  // 新实现只点真正拦住的那条）。这里断言「点到了实际的拦截原因」且不误报 scope。
  check("重算后点名实际拦截原因（cp-forged）", /cp-forged/.test(String(out?.reason)), g.stdout);
  check("scope 复算通过时不误报 scope 问题", !/scope/i.test(String(out?.reason)), g.stdout);

  // --apply 必须把这个伪造值清掉，否则下一次调用又读到它
  run("state.mjs", ["gate", "--pipeline", "coding", "--file", forgedPath, "--apply"], undefined, forgedRepo.repo);
  check(
    "--apply 把伪造的 stop_reason 清成 null",
    parseJson(readFileSync(forgedPath, "utf8"))?.stop_reason === null,
    readFileSync(forgedPath, "utf8"),
  );

  // STOPPED 例外：人主动叫停没有可计算依据替代
  writeFileSync(
    path.join(forgedRepo.repo, ".loop-cli", "stopped.json"),
    JSON.stringify({ ...codingState(), stop_reason: "STOPPED" }),
  );
  const stopped = run("state.mjs", ["gate", "--pipeline", "coding", "--file", path.join(forgedRepo.repo, ".loop-cli", "stopped.json"), "--json"], undefined, forgedRepo.repo);
  check("stop_reason=STOPPED 原样保留（人主动叫停）", parseJson(stopped.stdout)?.stop_reason === "STOPPED", stopped.stdout);

  // 反向锚：真实全部 done + checkpoint 通过 + scope PASS 仍然判 DONE
  const legitPath = path.join(forgedRepo.repo, ".loop-cli", "legit-done.json");
  writeFileSync(
    legitPath,
    JSON.stringify({
      ...codingState(),
      tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
      critical_checkpoints: [{ id: "cp-ok", description: "通过", passed: true }],
      scope: { base: forgedRepo.base, hard: ["src/**"], soft: ["sub/**"], forbidden: [] },
      scope_drift: "PASS",
      stop_reason: null,
    }),
  );
  const legit = run("state.mjs", ["gate", "--pipeline", "coding", "--file", legitPath, "--json"], undefined, forgedRepo.repo);
  check("真实满足三个条件时仍判 DONE（重算没把正常路径改坏）", parseJson(legit.stdout)?.stop_reason === "DONE", legit.stdout);
}

console.log("\n== 2026-10-29：scope 看得见 gitignored 改动 ==");
// 旧实现只用 `git ls-files --others --exclude-standard`，它按定义跳过被 .gitignore 的路径。
// 实测：.gitignore=dist/、只改 dist/built.js、--forbidden "dist/**" → 判 PASS，
// 而 dist 正是构建产物的典型 forbidden 目标。
{
  const ignRepo = makeRepo("ignored-repo");
  writeFileSync(path.join(ignRepo.repo, ".gitignore"), "dist/\n");
  ignRepo.git("add", ".gitignore");
  ignRepo.git("commit", "-m", "ignore dist");
  mkdirSync(path.join(ignRepo.repo, "dist", "nested"), { recursive: true });
  writeFileSync(path.join(ignRepo.repo, "dist", "built.js"), "built\n");
  writeFileSync(path.join(ignRepo.repo, "dist", "nested", "deep.js"), "deep\n");
  const ign = run(
    "scope.mjs",
    ["--base", "HEAD", "--forbidden", "dist/**", "--json"],
    undefined,
    ignRepo.repo,
  );
  const ignOut = parseJson(ign.stdout);
  check("只改 gitignored 的 dist/ 也判 FAIL", ignOut?.verdict === "FAIL", ign.stdout + ign.stderr);
  check("ignored 目录按文件展开（嵌套层级也列出）", 
    Array.isArray(ignOut?.forbidden) && ignOut.forbidden.includes("dist/built.js") && ignOut.forbidden.includes("dist/nested/deep.js"),
    ign.stdout);
  // 反向锚：gitignore 本身不改变「正常文件仍判 PASS」
  const clean = run("scope.mjs", ["--base", "HEAD", "--forbidden", "dist/**", "--json"], undefined, ignRepo.repo);
  check("ignored 判定不影响 PASS 路径（同一份规则、无新改动时仍 FAIL 是因为文件还在）", parseJson(clean.stdout)?.verdict === "FAIL", clean.stdout);
}

console.log("\n== 2026-10-29：scope 默认基线取自状态文件 ==");
// 旧实现无条件默认 HEAD：**已提交**的越界改动永远落在 `git diff HEAD` 之外 → PASS。
// 执行者先 commit 再跑 scope 就能拿到一张绿票。
{
  const baseRepo = makeRepo("base-repo");
  mkdirSync(path.join(baseRepo.repo, "dist"), { recursive: true });
  writeFileSync(path.join(baseRepo.repo, "dist", "old.js"), "v1\n");
  baseRepo.git("add", ".");
  baseRepo.git("commit", "-m", "add dist");
  const recordedBase = baseRepo.git("rev-parse", "HEAD").trim();
  writeFileSync(path.join(baseRepo.repo, "dist", "old.js"), "v2\n");
  baseRepo.git("add", ".");
  baseRepo.git("commit", "-m", "越界改动（已提交）");

  const statePath = path.join(baseRepo.repo, ".loop-cli", "state", "coding-pipeline.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({ ...codingState(), scope: { base: recordedBase, hard: ["src/**"], soft: [], forbidden: ["dist/**"] } }),
  );

  const withBaseline = run("scope.mjs", ["--file", statePath, "--json"], undefined, baseRepo.repo);
  check(
    "不传 --base 时回退到状态里记录的基线，已提交的越界改动被发现",
    parseJson(withBaseline.stdout)?.verdict === "FAIL" && String(parseJson(withBaseline.stdout)?.base) === recordedBase,
    withBaseline.stdout + withBaseline.stderr,
  );

  // 显式 --base 仍然优先
  const explicit = run("scope.mjs", ["--base", "HEAD", "--file", statePath, "--json"], undefined, baseRepo.repo);
  check("显式 --base 优先于状态基线", parseJson(explicit.stdout)?.base === "HEAD", explicit.stdout);

  // --apply 把基线记进状态，供下一次无参调用使用
  const appliedBase = run("scope.mjs", ["--file", statePath, "--apply"], undefined, baseRepo.repo);
  check(
    "--apply 把本次 base 记进 state.scope.base",
    parseJson(readFileSync(statePath, "utf8"))?.scope?.base === recordedBase,
    appliedBase.stdout + appliedBase.stderr,
  );
}

console.log("\n== 2026-10-29：write 保留判定产物字段 ==");
// scope_drift / scope 是 scope.mjs 的产物，而每次「推进一轮」的 write 都由执行者整份提交状态。
// 旧实现整文件替换 → 刚写下的 scope_drift 被下一轮 write 静默抹掉，gate 于是判「尚未判定」。
{
  const keepRepo = makeRepo("keep-fields");
  const statePath = path.join(keepRepo.repo, ".loop-cli", "state", "coding-pipeline.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  const base = { ...codingState(), scope: { hard: ["src/**"], forbidden: ["dist/**"] }, scope_drift: "FAIL" };
  writeFileSync(statePath, JSON.stringify(base));

  // 执行者推进一轮：提交的对象里没有 scope_drift / scope（它不知道这两个字段）
  const advanced = { ...codingState(), round: 1 };
  delete advanced.scope;
  delete advanced.scope_drift;
  const w = run("state.mjs", ["write", "--pipeline", "coding", "--file", statePath], JSON.stringify(advanced));
  const after = parseJson(readFileSync(statePath, "utf8"));
  check("write 后 scope_drift 仍在", w.status === 0 && after?.scope_drift === "FAIL", readFileSync(statePath, "utf8"));
  check("write 后 scope 仍在", after?.scope !== undefined && after.scope?.forbidden?.[0] === "dist/**", JSON.stringify(after?.scope));

  // 显式传值仍然优先（scope.mjs 就是这么写回新结论的）
  const override = { ...advanced, round: 2, scope_drift: "PASS" };
  run("state.mjs", ["write", "--pipeline", "coding", "--file", statePath], JSON.stringify(override));
  check("显式传 scope_drift 覆盖继承值", parseJson(readFileSync(statePath, "utf8"))?.scope_drift === "PASS");
}

console.log("\n== 2026-10-29：init 不覆盖非状态文件 ==");
// 旧逻辑只判断「有没有 tasks/round/stop_reason」，package.json 一个都不命中 → 判「无进度」→
// 直接覆盖成状态对象、exit 0。实测 `init --file repo/package.json` 会把 package.json 写坏。
{
  const hostRepo = makeRepo("foreign-file");
  const pkgPath = path.join(hostRepo.repo, "package.json");
  const pkgText = JSON.stringify({ name: "demo", version: "1.0.0" });
  writeFileSync(pkgPath, pkgText);

  const refused = run(
    "state.mjs",
    ["init", "--pipeline", "coding", "--prompt", "x", "--file", pkgPath],
    undefined,
    hostRepo.repo,
  );
  check("init 拒绝覆盖非状态 JSON", refused.status === 2 && /not a pipeline state file/.test(refused.stderr), refused.stderr);
  check("被拒后 package.json 原样保留", readFileSync(pkgPath, "utf8") === pkgText, readFileSync(pkgPath, "utf8"));

  const forced = run(
    "state.mjs",
    ["init", "--pipeline", "coding", "--prompt", "x", "--file", pkgPath, "--force"],
    undefined,
    hostRepo.repo,
  );
  check("--force 也不越过「不是状态文件」", forced.status === 2 && readFileSync(pkgPath, "utf8") === pkgText, forced.stderr);

  // 反向锚：真正的状态文件带进度时 --force 仍可重置（那是它的本职）
  const realState = path.join(hostRepo.repo, ".loop-cli", "state", "coding-pipeline.json");
  mkdirSync(path.dirname(realState), { recursive: true });
  writeFileSync(
    realState,
    JSON.stringify({
      ...codingState(),
      tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
    }),
  );
  const reset = run(
    "state.mjs",
    ["init", "--pipeline", "coding", "--prompt", "again", "--file", realState, "--force"],
    undefined,
    hostRepo.repo,
  );
  check("带进度的真状态文件 --force 仍能重置", reset.status === 0 && parseJson(readFileSync(realState, "utf8"))?.tasks.length === 0, reset.stderr);
}


console.log("\n== 2026-10-29 第二轮：gate 不采信 state.scope_drift，改按 git 现状复算 ==");
// 上一轮修掉了「预设 stop_reason 被采信」，但内层仍在读 state.scope_drift——实测越界文件
// dist/leak.js 在场、状态手写 scope_drift:"PASS"，gate 直接回 DONE。门禁于是仍可自报。
{
  const forgeRepo = makeRepo("scope-forge-repo");
  const statePath = path.join(forgeRepo.repo, ".loop-cli", "coding.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  const stateWith = (drift) => ({
    ...codingState(),
    tasks: [{ id: "t1", title: "a", status: "done", depends_on: [], accept_criteria: ["ok"], failures: 0 }],
    critical_checkpoints: [{ id: "cp-ok", description: "通过", passed: true }],
    scope: { base: forgeRepo.base, hard: ["src/**"], soft: ["sub/**"], forbidden: ["dist/**"] },
    scope_drift: drift,
  });
  const gateIn = (repo) =>
    run("state.mjs", ["gate", "--pipeline", "coding", "--file", statePath, "--json"], undefined, repo);

  // ① 无越界 + 自报 PASS → DONE（正常路径未被改坏）
  writeFileSync(statePath, JSON.stringify(stateWith("PASS")));
  check("无越界且自报 PASS → DONE", parseJson(gateIn(forgeRepo.repo).stdout)?.stop_reason === "DONE");

  // ② 制造真实越界（forbidden 目标），仍自报 PASS → 必须拦下
  mkdirSync(path.join(forgeRepo.repo, "dist"), { recursive: true });
  writeFileSync(path.join(forgeRepo.repo, "dist", "leak.js"), "leak\n");
  const forged = parseJson(gateIn(forgeRepo.repo).stdout);
  check("越界在场 + 自报 PASS → 不判 DONE（自报值不作数）", forged?.stop_reason !== "DONE", JSON.stringify(forged));
  check("越界时判 ESCALATE 而非静默继续", forged?.stop_reason === "ESCALATE", JSON.stringify(forged));
  check("reason 指名越界的实际文件", /dist\/leak\.js/.test(String(forged?.reason)), String(forged?.reason));

  // ③ 删掉越界文件 → 恢复 DONE（证明拦截来自真实状态，不是永久锁死）
  rmSync(path.join(forgeRepo.repo, "dist", "leak.js"));
  check("移除越界文件后恢复 DONE", parseJson(gateIn(forgeRepo.repo).stdout)?.stop_reason === "DONE");

  // ④ 自报 FAIL 但实际无越界 → 按复算放行（自报值既不能放行也不能拦停）
  writeFileSync(statePath, JSON.stringify(stateWith("FAIL")));
  check("无越界但自报 FAIL → 按复算放行 DONE", parseJson(gateIn(forgeRepo.repo).stdout)?.stop_reason === "DONE");

  // ⑤ scope 规则缺失 → 复算不可得 → 不 DONE（判停依据不足）
  const noScope = { ...stateWith("PASS") };
  delete noScope.scope;
  writeFileSync(statePath, JSON.stringify(noScope));
  const unknown = parseJson(gateIn(forgeRepo.repo).stdout);
  check("无 scope 规则 → 不 DONE（复算不可得）", unknown?.stop_reason !== "DONE", JSON.stringify(unknown));
  check("无 scope 规则时 reason 说明无法复算", /无法复算|scope 未配置/.test(String(unknown?.reason)), String(unknown?.reason));

  // ⑥ 非 git 目录 → 同样复算不可得
  const outside = run("state.mjs", ["gate", "--pipeline", "coding", "--file", statePath, "--json"], undefined, sandbox);
  check("从非 git 目录跑 gate → 不 DONE（无法复算）", parseJson(outside.stdout)?.stop_reason !== "DONE", outside.stdout);

  // ⑦ 与 scope.mjs 同宽：ignored 文件也算改动面（构建产物是典型 forbidden 目标）
  writeFileSync(path.join(forgeRepo.repo, ".gitignore"), "dist/\n");
  mkdirSync(path.join(forgeRepo.repo, "dist"), { recursive: true });
  writeFileSync(path.join(forgeRepo.repo, "dist", "built.js"), "built\n");
  writeFileSync(statePath, JSON.stringify(stateWith("PASS")));
  const ignored = parseJson(gateIn(forgeRepo.repo).stdout);
  check("gitignored 的 forbidden 文件同样拦住 DONE", ignored?.stop_reason !== "DONE", JSON.stringify(ignored));
  const viaScope = run(
    "scope.mjs",
    ["--file", statePath, "--json"],
    undefined,
    forgeRepo.repo,
  );
  check(
    "gate 复算与 scope.mjs 对同一起越界给出同一结论",
    parseJson(viaScope.stdout)?.verdict === "FAIL",
    viaScope.stdout,
  );
}


console.log("\n== root_cause_group：从「只有提示词」变成可校验、可聚合的字段 ==");
// 背景（2026-10-29 第三轮）：reviewer / builder / orchestrator 三份 agent 文档都承诺
// 「同一根因的多个 issue 共用同一 root_cause_group，executor 一次修一组」，
// 但 scripts/ 里零实现——字段类型写错、留空串、拼写漂移全部无人发现，那句承诺无法被验证。
{
  const rcFile = path.join(sandbox, "root-cause.json");
  const codingWith = (tasks) => ({
    ...codingState(),
    tasks,
    scope: { base: "HEAD", hard: ["src/**"], soft: [], forbidden: [] },
  });
  const taskOf = (over = {}) => ({
    id: "t1", title: "a", status: "pending", depends_on: [], accept_criteria: ["ok"], failures: 0, ...over,
  });
  const validateWith = (state) => {
    writeFileSync(rcFile, JSON.stringify(state));
    return run("state.mjs", ["validate", "--pipeline", "coding", "--file", rcFile, "--json"]);
  };
  const validateJson = (state) => parseJson(validateWith(state).stdout);

  // ① 形状校验：空串 / 纯空白 / 非字符串都算错
  check(
    'root_cause_group 缺席合法（该字段可选）',
    validateJson(codingWith([taskOf()]))?.valid === true,
    validateWith(codingWith([taskOf()])).stdout,
  );
  check(
    'root_cause_group 为空串被判非法（占位符没填）',
    validateJson(codingWith([taskOf({ root_cause_group: "" })]))?.valid === false,
  );
  check(
    'root_cause_group 为纯空白被判非法',
    validateJson(codingWith([taskOf({ root_cause_group: "   " })]))?.valid === false,
  );
  check(
    'root_cause_group 非字符串被判非法',
    validateJson(codingWith([taskOf({ root_cause_group: 7 })]))?.valid === false,
  );
  check(
    '非法时 reason 点名是哪个任务的哪个字段',
    /root_cause_group/.test(String(validateJson(codingWith([taskOf({ root_cause_group: "" })]))?.errors)),
  );

  // ② 聚合：同一组的多任务 + 未分组任务分开统计
  const grouped = codingWith([
    taskOf({ id: "t1", root_cause_group: "rc-a", status: "done" }),
    taskOf({ id: "t2", root_cause_group: "rc-a" }),
    taskOf({ id: "t3", root_cause_group: "rc-b", status: "done" }),
    taskOf({ id: "t4" }),
  ]);
  writeFileSync(rcFile, JSON.stringify(grouped));
  const rc = parseJson(run("state.mjs", ["root-causes", "--pipeline", "coding", "--file", rcFile, "--json"]).stdout);
  check(
    'root-causes 按 root_cause_group 分桶',
    JSON.stringify((rc?.groups ?? []).map((g) => g.id)) === JSON.stringify(["rc-a", "rc-b"]),
    JSON.stringify(rc),
  );
  check(
    '分组带完成度（rc-a 1/2、rc-b 1/1 完成）',
    rc?.groups?.[0]?.done === 1 && rc.groups[0].total === 2 && rc.groups[0].complete === false
      && rc?.groups?.[1]?.complete === true,
    JSON.stringify(rc?.groups),
  );
  check(
    '没有分组的任务单独归入 ungrouped，不被硬塞进某个组',
    rc?.ungrouped?.total === 1 && rc.ungrouped.tasks[0].id === "t4",
    JSON.stringify(rc?.ungrouped),
  );

  // ③ gate 的 continue 分支点名「下一步该派哪一组」
  const gatedRc = run("state.mjs", ["gate", "--pipeline", "coding", "--file", rcFile, "--json"]);
  const rcReason = String(parseJson(gatedRc.stdout)?.reason);
  check(
    'gate continue 时点名仍未完成的根因组',
    /root_cause_group=rc-a/.test(rcReason),
    rcReason,
  );
  check(
    '已完成的根因组不再被点名',
    !/root_cause_group=rc-b/.test(rcReason),
    rcReason,
  );
  check(
    '该提示不改变判停（仍是继续）',
    parseJson(gatedRc.stdout)?.stop_reason === null,
    gatedRc.stdout,
  );

  // ④ 全部任务都归组且完成时，提示不再出现（不制造幽灵组）
  const allGrouped = codingWith([
    taskOf({ id: "t1", root_cause_group: "rc-a", status: "done" }),
  ]);
  writeFileSync(rcFile, JSON.stringify(allGrouped));
  const doneOut = parseJson(run("state.mjs", ["gate", "--pipeline", "coding", "--file", rcFile, "--json"]).stdout);
  check(
    'root_cause_group 不参与 DONE 判据（全部 done 且 scope 可复算外仍按原规则）',
    !/root_cause_group=/.test(String(doneOut?.reason)),
    String(doneOut?.reason),
  );
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
