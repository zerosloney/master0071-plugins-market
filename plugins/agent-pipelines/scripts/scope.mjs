#!/usr/bin/env node
// agent-pipelines scope 检查：把 coding-pipeline 的 hard/soft/forbidden scope 从提示词约定变成可执行检查。
// 用法：node scripts/scope.mjs --base <ref> --hard "src/**,test/**" --soft "docs/**" --forbidden "dist/**,*.lock"
// 也可从状态文件的可选 scope 对象读取：--file .loop-cli/state/coding-pipeline.json
// 通配语法：* 单段、** 跨段、? 单字符；不支持 brace 展开与字符类——*.{js,ts} 不匹配，多后缀逐条列出。
// 前导 `**/` 不匹配仓库根目录的文件（要求至少一个目录段）：`**/*.lock` 漏掉根目录的 lock 文件，
// forbidden 方向会 fail-open——根目录规则请并排写一条 `*.lock`（运行时也会打印警告）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const base = typeof args.base === "string" ? args.base : "HEAD";
  const pipeline = typeof args.pipeline === "string" ? args.pipeline : "coding";
  if (pipeline !== "coding") fail("scope checking is only defined for --pipeline coding");

  let hard = listOf(args.hard);
  let soft = listOf(args.soft);
  let forbidden = listOf(args.forbidden);
  if (args.file) {
    const file = path.resolve(cwd, String(args.file));
    if (!existsSync(file)) fail(`state file not found: ${file}`);
    let state;
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      fail(`state file is not valid JSON: ${err.message}`);
    }
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
  const exclude = listOf(args.exclude).length > 0 ? listOf(args.exclude) : [".loop-cli/**"];

  const changed = new Set();
  const addChanged = (line) => {
    const file = line.trim().replace(/\\/g, "/");
    if (file && !matchAny(file, exclude)) changed.add(file);
  };
  for (const line of git(["diff", "--name-only", base], cwd).split("\n")) addChanged(line);
  const includeUntracked = args["no-untracked"] !== true;
  if (includeUntracked) {
    for (const line of git(["ls-files", "--others", "--exclude-standard"], cwd).split("\n")) addChanged(line);
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
