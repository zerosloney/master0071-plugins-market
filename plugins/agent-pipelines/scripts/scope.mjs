#!/usr/bin/env node
// agent-pipelines scope 检查：把 coding-pipeline 的 hard/soft/forbidden scope 从提示词约定变成可执行检查。
// 用法：node scripts/scope.mjs --base <ref> --hard "src/**,test/**" --soft "docs/**" --forbidden "dist/**,*.lock"
// 也可从状态文件的可选 scope 对象读取：--file .loop-cli/state/coding-pipeline.json
// 写回状态文件：--apply 把本次结论写进状态文件的 scope_drift，供 state.mjs gate 读取（零容忍门禁串联）。
// 判定基准锚定 git 仓库根：变更清单与 scope 规则都用仓库根相对路径，从哪个目录调用结论一致。
//   此前 git ls-files 在调用目录执行，未跟踪文件只列出调用目录以下的部分——子目录调用时越界改动直接消失
//   （审计实测：仓库根 FAIL，同一条命令加 --cwd sub PASS，零容忍形同虚设）。
// 通配语法：* 单段、** 跨段、? 单字符；不支持 brace 展开与字符类——*.{js,ts} 不匹配，多后缀逐条列出。
// 前导 `**/` 不匹配仓库根目录的文件（要求至少一个目录段）：`**/*.lock` 漏掉根目录的 lock 文件，
// forbidden 方向会 fail-open——根目录规则请并排写一条 `*.lock`（运行时也会打印警告）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
// glob 引擎与越界判定走 scope-core 单源（此前与 state.mjs 的 recheckScope 双份内联，
// 两份各出过真 bug 且修齐时间不同步——bug 史注释见 scope-core）
import { collectChangedFiles, rootRelativePattern, scopeVerdict } from "./scope-core.mjs";

function fail(message, code = 2) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(code);
}

function listOf(value) {
  if (value === undefined || value === true || value === null) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    fail(`git ${args.join(" ")} failed: ${String((err && err.message) || err).split("\n")[0]}`);
  }
}

// --base 是被直接塞进 git argv 的位置参数：`git diff --name-only --output=<path> HEAD` 里的
// `--output=…` 会被 git 当选项执行并真的写出文件（实测 git 2.53），等于借 scope 检查在仓库外落盘。
// git 的位置参数分隔符 `--` 只能分路spec 不能分 rev，`--end-of-options` 又要求 git ≥2.24，
// 故在此收口：合法 rev 不可能以 `-` 开头、不可能含空白与控制字符，拒掉即无选项注入面。
function assertSafeRev(rev, label) {
  const s = String(rev);
  if (!s) fail(`${label} is empty`);
  if (s.startsWith("-")) fail(`${label} must not start with "-" (git would read it as an option): ${s}`);
  if (/[\s\x00-\x1f]/.test(s)) fail(`${label} must not contain whitespace or control characters: ${JSON.stringify(s)}`);
  return s;
}

// 仓库根是 scope 判定的唯一路径基准：变更清单（git diff / git ls-files）与 scope 规则都用它。
function gitRoot(cwd) {
  const out = git(["rev-parse", "--show-toplevel"], cwd);
  if (!out) fail("cannot resolve the git repository root (empty --show-toplevel)");
  return path.resolve(out);
}

// scope 规则按仓库根相对路径解释（实现在 scope-core 单源）。非法规则在那里以 throw 报错，
// 这里统一折算成 CLI 的 fail（一行干净报错 + 退出码 2），文案与单源前逐字一致。
function rootRelative(pattern, root) {
  try {
    return rootRelativePattern(pattern, root);
  } catch (err) {
    fail(err.message);
  }
}

// 把判定结果写回状态文件：后续 state.mjs gate 读到的是真实结论，而不是执行者自报的 scope_drift。
// 复用 state.mjs write：落盘、校验、加锁与事件日志只有一份实现，不在 scope.mjs 里再写一套原子写与锁。
// 已知局限：读—改—写跨两个进程，中间没有跨进程锁，并发写同一状态文件的会话可能被这次写回覆盖
// （与「同一仓库并发跑两条同类管道会互相覆盖状态」是同一条已记录的并发限制）。
function applyVerdict(file, pipeline, verdict, state, base, exclude, rules = {}) {
  const stateScript = fileURLToPath(new URL("./state.mjs", import.meta.url));
  const prevScope = state && typeof state === "object" && state.scope && typeof state.scope === "object" && !Array.isArray(state.scope)
    ? state.scope
    : null;
  // 一并记下本次判定用的基线与排除清单：下次不传 --base/--exclude 时以它们为起点。
  // exclude 不落盘的话，gate 的复算只认 .loop-cli/ 前缀——自定义 --exclude 判 PASS 后
  // 复算却把同样文件算成越界，管道永久 ESCALATE（复算与 CLI 消费同一 scope-core 内核，见 state.mjs）。
  // exclude 仅在 CLI 显式传入时覆盖（调用点对「未传」传 undefined）：裸跑时的生效清单可能
  // 是回退出来的默认，整份覆盖会把已落盘的自定义清单抹掉，复算口径随之变窄。
  const scope = { ...(prevScope || {}), base };
  if (exclude !== undefined) scope.exclude = exclude;
  // 规则维度（hard/soft/forbidden）同理：仅 CLI 显式传入的维度落盘（整体替换该维度既有值），
  // 未传的维度不动状态里已有值——裸跑时的生效规则可能回退自状态文件，整份覆盖与 exclude 的
  // 抹除缺陷同型；不落盘则 README 示例的 CLI 用法在状态里永远没有规则，gate 复算恒
  // 「规则为空」→ 永远拦 DONE。
  for (const kind of ["hard", "soft", "forbidden"]) {
    if (rules[kind] !== undefined) scope[kind] = rules[kind];
  }
  const next = { ...state, scope, scope_drift: verdict };
  const result = spawnSync(process.execPath, [stateScript, "write", "--pipeline", pipeline, "--file", file], {
    input: JSON.stringify(next),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim().split("\n")[0];
    fail(`failed to write scope_drift=${verdict} into ${file}: ${detail || `state.mjs write exited ${result.status}`}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    boolean: ["json", "no-untracked", "apply"],
    value: ["cwd", "base", "pipeline", "hard", "soft", "forbidden", "file", "exclude"],
  });
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const pipeline = typeof args.pipeline === "string" ? args.pipeline : "coding";
  if (pipeline !== "coding") fail("scope checking is only defined for --pipeline coding");
  const root = gitRoot(cwd);

  // 状态文件先读：`--base` 的默认值要从里面取（见下面的基线回退）。
  let state = null;
  let statePath = null;
  if (args.file) {
    statePath = path.resolve(cwd, String(args.file));
    if (!existsSync(statePath)) fail(`state file not found: ${statePath}`);
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (err) {
      fail(`state file is not valid JSON: ${err.message}`);
    }
  }

  // base 的默认值：状态里记录的 `scope.base` → 否则 HEAD。
  // 旧实现无条件默认 HEAD，于是**已提交**的越界改动永远看不见（`git diff HEAD` 为空 → PASS）：
  // 执行者只要先 commit 再跑 scope，就能拿到一张绿票。状态里记下的基线才是这条管道的起点。
  const stateBase = state && typeof state === "object" && state.scope && typeof state.scope === "object"
    ? state.scope.base
    : undefined;
  const baseSource = typeof args.base === "string" && args.base ? args.base : (typeof stateBase === "string" && stateBase ? stateBase : "HEAD");
  const base = assertSafeRev(baseSource, "--base");

  // CLI 显式传入的规则先单独记下：落盘侧要区分「CLI 传入」与「状态回退」，与状态合并
  // （下方 if (state) 块）后就分不出来了。判定语义不变：合并顺序仍是 CLI 优先。
  const cliRules = { hard: listOf(args.hard), soft: listOf(args.soft), forbidden: listOf(args.forbidden) };
  let hard = cliRules.hard;
  let soft = cliRules.soft;
  let forbidden = cliRules.forbidden;
  if (state) {
    const scope = state && typeof state === "object" ? state.scope : null;
    if (scope && typeof scope === "object" && !Array.isArray(scope)) {
      if (hard.length === 0 && Array.isArray(scope.hard)) hard = scope.hard.map((v) => String(v).replace(/\\/g, "/"));
      if (soft.length === 0 && Array.isArray(scope.soft)) soft = scope.soft.map((v) => String(v).replace(/\\/g, "/"));
      if (forbidden.length === 0 && Array.isArray(scope.forbidden)) forbidden = scope.forbidden.map((v) => String(v).replace(/\\/g, "/"));
    }
  }
  if (hard.length === 0 && soft.length === 0 && forbidden.length === 0) {
    fail("no scope configured; pass --hard/--soft/--forbidden or put a scope object in the state file");
  }
  if (args.apply && !statePath) {
    fail("--apply writes the verdict back into the state file; pass --file <state file> too");
  }
  // scope 规则与变更清单同基准：都按仓库根相对路径解释
  hard = hard.map((pattern) => rootRelative(pattern, root));
  soft = soft.map((pattern) => rootRelative(pattern, root));
  forbidden = forbidden.map((pattern) => rootRelative(pattern, root));
  // `!` 否定不支持：globToRegExp 会把它当字面量，写进 forbidden 会静默永不匹配（fail-open）。
  // 显式报错把人引到 hard/soft/forbidden 的正确表达方式上，而不是让越界改动静默通过
  for (const [kind, patterns] of [["hard", hard], ["soft", soft], ["forbidden", forbidden]]) {
    const negated = patterns.find((pattern) => pattern.startsWith("!"));
    if (negated) {
      fail(`scope ${kind} pattern "${negated}": negation ("!") is not supported and would silently never match; express the rule via the hard/soft/forbidden split instead`);
    }
    // 前导 `**/` 要求路径至少含一个目录段，不匹配仓库根目录的文件——forbidden 方向是漏判（fail-open）。
    // gitignore 语义里 `**/*.lock` 覆盖根目录，这里的实现不覆盖；显式警告避免用户按 gitignore 直觉踩坑。
    const leadingGlobstar = patterns.find((pattern) => pattern.startsWith("**/"));
    if (leadingGlobstar) {
      process.stderr.write(
        `[agent-pipelines] warning: scope ${kind} pattern "${leadingGlobstar}" does not match files in the repo root (leading **/ requires at least one directory segment); add a root-level pattern (e.g. "*.lock") alongside it\n`,
      );
    }
  }
  // 状态文件本身不属于业务改动；排除清单三级回退：CLI --exclude → 状态文件 scope.exclude → 默认。
  // 只看 CLI 的话，`--exclude "node_modules/**,.loop-cli/**" --apply` 落盘后裸跑就回退默认清单
  // ——已落盘的自定义排除失效（上方注释承诺的「下次不传 --exclude 时以它们为起点」落空），
  // gate 复算把排除目标算成越界，管道永久 ESCALATE。
  const cliExclude = listOf(args.exclude);
  const stateExclude = state && typeof state === "object" && state.scope && typeof state.scope === "object" && Array.isArray(state.scope.exclude)
    ? state.scope.exclude.map((v) => String(v).replace(/\\/g, "/"))
    : [];
  const exclude = (cliExclude.length > 0 ? cliExclude : (stateExclude.length > 0 ? stateExclude : [".loop-cli/**"])).map((pattern) =>
    rootRelative(pattern, root),
  );

  // 变更清单收集与越界判定走 scope-core 单源（git runner 注入：失败即 fail 的纪律留在本文件）
  const changed = collectChangedFiles((args) => git(args, root), exclude, base, args["no-untracked"] !== true);
  const files = [...changed].sort();
  const { hardHits, softHits, forbiddenHits, outside, verdict } = scopeVerdict(files, { hard, soft, forbidden });
  const result = { verdict, base, pipeline, changed: files, hard: hardHits, soft: softHits, forbidden: forbiddenHits, outside };

  // 把本次 base 一并记进状态：下一次调用不传 --base 时就有确定的起点可用，
  // 而不是退回 HEAD（那样已提交的越界改动永远看不见）。
  // 规则维度与 exclude 同构：仅 CLI 显式传入时落盘（此时合并后的 hard/soft/forbidden 正是
  // CLI 传入值经 rootRelative 映射的结果），未传维度传 undefined 以保留状态里已有值。
  if (args.apply) {
    applyVerdict(
      statePath,
      pipeline,
      verdict,
      state,
      base,
      cliExclude.length > 0 ? exclude : undefined,
      {
        hard: cliRules.hard.length > 0 ? hard : undefined,
        soft: cliRules.soft.length > 0 ? soft : undefined,
        forbidden: cliRules.forbidden.length > 0 ? forbidden : undefined,
      },
    );
  }

  if (args.json) console.log(JSON.stringify(result));
  else {
    console.log(`scope_drift=${verdict} (base ${base}, ${files.length} changed file(s))`);
    if (hardHits.length) console.log(`hard: ${hardHits.join(", ")}`);
    if (softHits.length) console.log(`soft: ${softHits.join(", ")}`);
    if (forbiddenHits.length) console.log(`forbidden: ${forbiddenHits.join(", ")}`);
    if (outside.length) console.log(`outside scope: ${outside.join(", ")}`);
  }
  process.exit(verdict === "PASS" ? 0 : 1);
}

main();
