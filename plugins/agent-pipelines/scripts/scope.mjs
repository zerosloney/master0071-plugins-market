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

function globToRegExp(glob) {
  let pattern = glob.replace(/\\/g, "/").trim();
  if (pattern.endsWith("/")) pattern += "**";
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("/.+()[]{}^$|\\".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

// 模式按原样缓存：matchAny 对每个文件 × 每个 pattern 调用，重复 new RegExp 是纯浪费。
const compiledCache = new Map();
function compiled(pattern) {
  if (!compiledCache.has(pattern)) compiledCache.set(pattern, globToRegExp(pattern));
  return compiledCache.get(pattern);
}

function matchAny(file, patterns) {
  return patterns.some((pattern) => compiled(pattern).test(file));
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

// scope 规则按仓库根相对路径解释。绝对路径先转成仓库根相对路径；越出仓库根的规则直接报错——
// 它永远匹配不到任何变更文件，静默留着就是 fail-open（越界改动会被判成合规）。
function rootRelativePattern(pattern, root) {
  const normalized = pattern.replace(/\\/g, "/");
  if (!path.isAbsolute(pattern)) {
    if (normalized.split("/").includes("..")) {
      fail(`scope pattern "${pattern}" escapes the repository root; scope rules are repository-root relative`);
    }
    return normalized;
  }
  const rel = path.relative(root, path.resolve(pattern)).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    fail(`scope pattern "${pattern}" is outside the repository root`);
  }
  return rel;
}

// 把判定结果写回状态文件：后续 state.mjs gate 读到的是真实结论，而不是执行者自报的 scope_drift。
// 复用 state.mjs write：落盘、校验、加锁与事件日志只有一份实现，不在 scope.mjs 里再写一套原子写与锁。
// 已知局限：读—改—写跨两个进程，中间没有跨进程锁，并发写同一状态文件的会话可能被这次写回覆盖
// （与「同一仓库并发跑两条同类管道会互相覆盖状态」是同一条已记录的并发限制）。
function applyVerdict(file, pipeline, verdict, state, base, exclude) {
  const stateScript = fileURLToPath(new URL("./state.mjs", import.meta.url));
  const prevScope = state && typeof state === "object" && state.scope && typeof state.scope === "object" && !Array.isArray(state.scope)
    ? state.scope
    : null;
  // 一并记下本次判定用的基线与排除清单：下次不传 --base/--exclude 时以它们为起点。
  // exclude 不落盘的话，gate 的复算只认 .loop-cli/ 前缀——自定义 --exclude 判 PASS 后
  // 复算却把同样文件算成越界，管道永久 ESCALATE（口径必须与 scope.mjs 同宽，见 state.mjs）。
  const scope = { ...(prevScope || {}), base, exclude };
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

/** 列被 gitignore 的未跟踪文件（仓库根相对路径）。
 *
 *  `git ls-files --others --ignored --exclude-standard` 默认**逐文件展开**被忽略的目录
 *  （实测：`dist/` 忽略时输出 `dist/a.js`、`dist/nested/c.js`；只有额外加 `--directory`
 *  才会折叠成一行 `dist/`）。这里要的是可匹配的文件路径，所以保持默认行为、不加该开关。
 *
 *  已知边界：只覆盖**未跟踪**的 ignored 项。已跟踪文件后来被加进 .gitignore 的情况仍会被
 *  `git diff --name-only <base>` 列出（它本来就跟踪），不会漏。 */
function listIgnoredFiles(root) {
  const listing = git(["ls-files", "--others", "--ignored", "--exclude-standard"], root);
  const out = new Set();
  if (!listing) return out;
  for (const line of listing.split("\n")) {
    const entry = line.trim().replace(/\\/g, "/").replace(/\/$/, "");
    if (entry) out.add(entry);
  }
  return out;
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

  let hard = listOf(args.hard);
  let soft = listOf(args.soft);
  let forbidden = listOf(args.forbidden);
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
  hard = hard.map((pattern) => rootRelativePattern(pattern, root));
  soft = soft.map((pattern) => rootRelativePattern(pattern, root));
  forbidden = forbidden.map((pattern) => rootRelativePattern(pattern, root));
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
  // 状态文件本身不属于业务改动；默认排除，避免 pipeline 自己把自己判成越界。
  const exclude = (listOf(args.exclude).length > 0 ? listOf(args.exclude) : [".loop-cli/**"]).map((pattern) =>
    rootRelativePattern(pattern, root),
  );

  const changed = new Set();
  const addChanged = (line) => {
    const file = line.trim().replace(/\\/g, "/");
    if (file && !matchAny(file, exclude)) changed.add(file);
  };
  // 两条清单都在仓库根执行，输出才同基准（仓库根相对路径）：
  // 在调用目录执行时 git ls-files 只列出调用目录以下的未跟踪文件，仓库其它目录的越界改动会被整个漏掉。
  for (const line of git(["diff", "--name-only", base], root).split("\n")) addChanged(line);
  const includeUntracked = args["no-untracked"] !== true;
  if (includeUntracked) {
    for (const line of git(["ls-files", "--others", "--exclude-standard"], root).split("\n")) addChanged(line);
    // gitignored 的改动必须一并纳入（2026-10-29 修复）：`--exclude-standard` 按定义跳过被
    // .gitignore 的路径，而构建产物、生成代码、本地配置恰好都在那里。实测：.gitignore=dist/、
    // 只改 dist/built.js、--forbidden "dist/**" → 判 **PASS**，而 dist 正是最典型的 forbidden 目标。
    // 只列 ignored 的**已存在**路径（--others --ignored --exclude-standard 只出未跟踪的 ignored 项），
    // 目录本身不会展开成其下每个文件，故还需把命中的目录按其内容展开一次。
    for (const line of listIgnoredFiles(root)) addChanged(line);
  }

  const files = [...changed].sort();
  const forbiddenHits = files.filter((file) => matchAny(file, forbidden));
  const hardHits = files.filter((file) => matchAny(file, hard));
  const softHits = files.filter((file) => matchAny(file, soft));
  const outside = files.filter(
    (file) => !matchAny(file, hard) && !matchAny(file, soft) && !matchAny(file, forbidden),
  );
  const verdict = forbiddenHits.length > 0 || outside.length > 0 ? "FAIL" : "PASS";
  const result = { verdict, base, pipeline, changed: files, hard: hardHits, soft: softHits, forbidden: forbiddenHits, outside };

  // 把本次 base 一并记进状态：下一次调用不传 --base 时就有确定的起点可用，
  // 而不是退回 HEAD（那样已提交的越界改动永远看不见）。
  if (args.apply) applyVerdict(statePath, pipeline, verdict, state, base, exclude);

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
