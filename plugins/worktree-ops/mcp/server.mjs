#!/usr/bin/env node
// worktree-ops: MCP server (stdio) that manages git worktrees in a configurable
// directory outside the repository.
//
// Agent hosts generally pin a session's working directory at start, so this server
// does not pretend to relocate the running session. It owns the worktree lifecycle,
// the configurable root directory, and the handoff text that tells the user where to
// open the work that belongs in that worktree.
//
// Configuration precedence (highest first):
//   1. environment overrides  WORKTREE_ROOT / WORKTREE_BASE_REF /
//      WORKTREE_BRANCH_PREFIX / WORKTREE_STALE_DAYS
//   2. per-repository overrides in the config file
//   3. global config file
//   4. built-in defaults
//
// Config file location:
//   Windows  %APPDATA%/worktree-ops/config.json
//   POSIX    $XDG_CONFIG_HOME/worktree-ops/config.json  (default ~/.config)
// Override the whole directory with WORKTREE_CONFIG_HOME.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DAY_MS = 86400000;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  ".venv", "venv", ".next", ".nuxt", ".gradle", "Pods", ".cache",
]);

// 版本位与 plugins/worktree-ops/plugin.json 同步，由 `node scripts/release.mjs worktree-ops <x.y.z>` 统一改
const SERVER_INFO = { name: 'worktree-ops', version: '0.2.0' };

const DEFAULT_CONFIG = {
  root: null,
  baseRef: "auto",
  branchPrefix: "wt/",
  staleDays: 14,
  repos: {},
};

/* ------------------------------------------------------------------ config */

function configDir() {
  const override = process.env.WORKTREE_CONFIG_HOME;
  if (override) return override;
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "worktree-ops");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "worktree-ops");
}

/** Environment overrides win over both the per-repo and the global config file. */
function envOverrides() {
  const out = {};
  if (process.env.WORKTREE_ROOT) out.root = path.resolve(process.env.WORKTREE_ROOT);
  if (process.env.WORKTREE_BASE_REF) out.baseRef = process.env.WORKTREE_BASE_REF;
  if (process.env.WORKTREE_BRANCH_PREFIX !== undefined && process.env.WORKTREE_BRANCH_PREFIX !== "") {
    out.branchPrefix = process.env.WORKTREE_BRANCH_PREFIX;
  }
  const stale = Number(process.env.WORKTREE_STALE_DAYS);
  if (Number.isFinite(stale) && process.env.WORKTREE_STALE_DAYS) out.staleDays = stale;
  return out;
}

function loadConfig() {
  const file = path.join(configDir(), "config.json");
  let parsed = {};
  let parseError = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // 文件不存在属首次运行的正常情况；真正的解析损坏要留痕，set_root 写回前会拒绝并给出修复指引
    if (err && err.code !== "ENOENT") parseError = String((err && err.message) || err);
    parsed = {};
  }
  const config = {
    file,
    parseError,
    root: typeof parsed.root === "string" ? parsed.root : null,
    baseRef: typeof parsed.baseRef === "string" ? parsed.baseRef : DEFAULT_CONFIG.baseRef,
    branchPrefix: typeof parsed.branchPrefix === "string" ? parsed.branchPrefix : DEFAULT_CONFIG.branchPrefix,
    staleDays: Number.isFinite(parsed.staleDays) ? Number(parsed.staleDays) : DEFAULT_CONFIG.staleDays,
    repos: parsed.repos && typeof parsed.repos === "object" ? parsed.repos : {},
  };
  return { file, config };
}

function saveConfig(config) {
  const file = path.join(configDir(), "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    root: config.root,
    baseRef: config.baseRef,
    branchPrefix: config.branchPrefix,
    staleDays: config.staleDays,
    repos: config.repos,
  };
  // 原子写：先落临时文件再 rename 覆盖，避免写一半进程退出留下截断的 config.json
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

/* --------------------------------------------------------------------- git */

function git(args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (allowFail) return null;
    const detail = String((err && (err.stderr || err.message)) || err).trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

function repoRoot(input) {
  const start = input && String(input).trim() ? path.resolve(String(input).trim()) : process.cwd();
  if (!fs.existsSync(start)) throw new Error(`path does not exist: ${start}`);
  const top = git(["rev-parse", "--show-toplevel"], start, { allowFail: true });
  if (!top || !top.trim()) throw new Error(`not inside a git work tree: ${start}`);
  return path.resolve(top.trim());
}

/** Windows 大小写不敏感的路径等值比较：统一 resolve + 小写后再比 */
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** 主检出路径 = --git-common-dir 的父目录：link worktree 会话里 common dir 仍指向主仓库，
 *  据此区分「真主检出」与「会话所在的 worktree」。会话 repoRoot 解析到 link worktree 时，
 *  旧判定（entry.path === repo）会把两者标反。按 repo 路径记忆化（单进程内稳定）。 */
const MAIN_WT_CACHE = new Map();
function mainWorktreePath(repo) {
  const key = path.resolve(repo);
  if (MAIN_WT_CACHE.has(key)) return MAIN_WT_CACHE.get(key);
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], key, { allowFail: true });
  const main = common && common.trim() ? path.dirname(common.trim()) : key;
  MAIN_WT_CACHE.set(key, main);
  return main;
}

function repoKey(config, repo) {
  return Object.keys(config.repos).find((k) => samePath(k, repo));
}

function repoOverrides(config, repo) {
  // 覆盖键按主仓库路径归一：从 link worktree 发起的会话也能命中主检出上存的覆盖
  const key = repoKey(config, mainWorktreePath(repo)) || repoKey(config, repo);
  return key ? config.repos[key] : null;
}

function effective(config, repo) {
  const o = repoOverrides(config, repo) || {};
  const env = envOverrides();
  return {
    root: env.root ?? o.root ?? config.root,
    baseRef: env.baseRef ?? o.baseRef ?? config.baseRef,
    branchPrefix: env.branchPrefix ?? o.branchPrefix ?? config.branchPrefix,
    staleDays: env.staleDays ?? o.staleDays ?? config.staleDays,
  };
}

/** Managed root: explicit config only; null means unset — create refuses, remove
 *  treats every worktree as outside the managed root. */
function managedRoot(config, repo) {
  const e = effective(config, repo);
  return e.root ? path.resolve(e.root) : null;
}

/** 受管根落在仓库工作树内时，把该目录幂等写入 .git/info/exclude（本地忽略，不改被跟踪的
 *  .gitignore），否则新建的 worktree 会以未跟踪目录污染主检出 git status。
 *  返回 { entry, wrote }（wrote=false 表示条目已存在，同样视为已覆盖）；目录不在仓库
 *  内、或拿不到 gitDir 时返回 null。gitDir 是主仓库的 --git-common-dir
 *  （exclude 属于主仓库，link worktree 共享它）。 */
function ensureInsideRepoIgnore(repo, ignoredDir, gitDir) {
  const rel = path.relative(repo, path.resolve(ignoredDir));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!gitDir) return null;
  const excludePath = path.join(gitDir, "info", "exclude");
  const entry = `/${rel.split(path.sep).join("/")}/`;
  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf8");
  } catch {
    /* 首次运行还没有 info/exclude */
  }
  if (existing.split(/\r?\n/).some((l) => l.trim() === entry)) return { entry, wrote: false };
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`, "utf8");
  return { entry, wrote: true };
}

function defaultBranch(repo) {
  const sym = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo, { allowFail: true });
  if (sym && sym.trim()) return sym.trim().replace(/^origin\//, "");
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], repo, { allowFail: true });
  if (head && head.trim() && head.trim() !== "HEAD") return head.trim();
  return null;
}

/** 会话仓库当前检出的分支名；detached HEAD / 解析不出时返回 null。
 *  resolveBase 与 resolveTarget 的默认值共用它，避免两处各写一份而漂移。 */
function currentBranch(repo) {
  const out = git(["rev-parse", "--abbrev-ref", "HEAD"], repo, { allowFail: true });
  const cur = out && out.trim();
  return cur && cur !== "HEAD" ? cur : null;
}

/** ref 类参数（target/baseRef 等）进 git argv 前的边界校验：
 *  非空、不以 "-" 开头、首尾无空白、无控制字符，防止被解析成 git 选项。 */
function assertSafeRef(value, label) {
  const s = String(value);
  if (!s || s.trim() !== s || s.startsWith("-") || /[\u0000-\u001f\u007f]/.test(s)) {
    throw new Error(`invalid ${label} \`${s}\`: ref-like arguments must not be empty, start with "-", or contain surrounding whitespace / control characters.`);
  }
  return s;
}

function resolveBase(config, repo, explicit) {
  const raw = explicit === undefined || explicit === null ? "" : String(explicit);
  if (raw.trim()) return assertSafeRef(raw, "baseRef");
  const e = effective(config, repo);
  // 配置文件 / 环境变量里的 baseRef 同样直入 argv，出口统一校验
  if (e.baseRef && e.baseRef !== "auto") return assertSafeRef(e.baseRef, "baseRef");
  // auto：先跟随会话仓库当前检出的分支（在创建那一刻求值），detached / 解析不出分支时
  // 才回退仓库默认分支。与 resolveTarget 的默认顺序一致，只是回退值不同。
  const cur = currentBranch(repo);
  if (cur) return cur;
  const d = defaultBranch(repo);
  return d || "HEAD";
}

/** 显式传入的 target 必须真的解析得到提交，否则直接报错。
 *  解析不了时 counts() 会拿到 ahead=null，而删除路径上的「未合并提交」护栏
 *  （ahead && ahead > 0）会因 null 短路而静默放行，把有未合并提交的工作树删掉。 */
function resolveTarget(repo, explicit) {
  const raw = explicit === undefined || explicit === null ? "" : String(explicit);
  if (raw.trim()) {
    const ref = assertSafeRef(raw, "target");
    const resolved = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo, { allowFail: true });
    if (!resolved || !resolved.trim()) {
      throw new Error(`target ref \`${ref}\` does not resolve to a commit in ${repo}.\nPass a branch or tag that exists, or omit target to use the current checked-out branch.`);
    }
    return ref;
  }
  // 默认先跟随会话仓库当前检出的分支：merge_back 要求 target 已在主检出上，
  // 跟随当前分支让默认值天然满足该前提（旧默认 origin/<默认分支> 永远对不上本地检出而 REFUSED）。
  // detached / 解析不出分支时回退仓库默认分支（origin/<默认分支> 优先）。
  const cur = currentBranch(repo);
  if (cur) return cur;
  const d = defaultBranch(repo);
  if (!d) return "HEAD";
  const remote = git(["rev-parse", "--verify", "--quiet", `origin/${d}`], repo, { allowFail: true });
  return remote ? `origin/${d}` : d;
}

/** worktree add 失败按 stderr 分类给提示：baseRef 的 hint 只留给 ref 类错误，
 *  「分支已被其他工作树占用」等场景各有明确指引，不再一律归咎 baseRef。 */
function classifyAddFailure(err, branch, baseRef) {
  const msg = String((err && err.message) || err);
  if (/is already used by worktree|is already checked out/.test(msg)) {
    return `${msg}\nBranch \`${branch}\` is checked out in another worktree; git allows a branch in only one worktree. Free that worktree first (worktree_remove), or pass a different \`name\`.`;
  }
  if (/a branch named .+ already exists/.test(msg)) {
    return `${msg}\nBranch \`${branch}\` was created concurrently — re-run to check it out, or pass a different \`name\`.`;
  }
  if (/invalid reference|unknown revision|ambiguous argument|not a valid ref|failed to resolve/.test(msg)) {
    return `${msg}\nHint: base ref \`${baseRef}\` may not exist. Check with \`git branch -a\` and pass \`baseRef\` explicitly.`;
  }
  return msg;
}

/* ---------------------------------------------------------------- worktrees */

function slug(value) {
  const s = String(value)
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  // 非 ASCII 任务名（如纯中文）剥完可能为空：用原名的稳定短哈希兜底，避免不同名字都落到 "worktree" 互相撞目录
  return s || createHash("sha1").update(String(value).trim()).digest("hex").slice(0, 8);
}

function listWorktrees(repo) {
  const out = git(["worktree", "list", "--porcelain"], repo);
  const blocks = out.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const entries = [];
  for (const block of blocks) {
    const entry = { path: null, head: null, branch: null, detached: false, bare: false, locked: null, prunable: null };
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(" ");
      const key = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? "" : line.slice(idx + 1);
      if (key === "worktree") entry.path = path.resolve(value);
      else if (key === "HEAD") entry.head = value;
      else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") entry.detached = true;
      else if (key === "bare") entry.bare = true;
      else if (key === "locked") entry.locked = value || "locked";
      else if (key === "prunable") entry.prunable = value || "prunable";
    }
    if (entry.path) entries.push(entry);
  }
  return entries;
}

function pickWorktree(repo, nameOrPath) {
  const entries = listWorktrees(repo);
  if (!nameOrPath || !String(nameOrPath).trim()) {
    const mainPath = mainWorktreePath(repo);
    const main = entries.find((e) => path.resolve(e.path) === mainPath);
    if (main) return main;
    throw new Error(`worktree not found: (empty name). Known: ${entries.map((e) => e.branch || e.path).join(", ")}`);
  }
  const needle = String(nameOrPath).trim();
  const lower = needle.toLowerCase();
  const direct = entries.find((e) => samePath(e.path, needle));
  if (direct) return direct;
  const byBranch = entries.find((e) => e.branch === needle);
  if (byBranch) return byBranch;
  const bySlug = entries.find((e) => e.branch && slug(e.branch) === slug(needle));
  if (bySlug) return bySlug;
  // "dirty-one" should find branch "wt/dirty-one" when the slug only differs by the prefix.
  const bySuffix = entries.find((e) => e.branch && slug(e.branch).endsWith(`-${slug(needle)}`));
  if (bySuffix) return bySuffix;
  const byDir = entries.find((e) => path.basename(e.path).toLowerCase() === lower);
  if (byDir) return byDir;
  throw new Error(`worktree not found: ${needle}. Known: ${entries.map((e) => e.branch || e.path).join(", ")}`);
}

function statusOf(dir) {
  const out = git(["status", "--porcelain"], dir, { allowFail: true });
  if (out === null) return { clean: null, dirtyFiles: [], lines: [] };
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  return { clean: lines.length === 0, dirtyFiles: lines.slice(0, 20), dirtyCount: lines.length, lines };
}

/** ahead/behind 与祖先判定只读仓库级 refs，cwd 必须用仓库根而非工作树目录：
 *  prunable（目录被手动删/移走）的工作树目录做 cwd 会 ENOENT → null，
 *  曾让删除护栏把「无法计算」误判成「已合并」或反过来误拒干净分支。 */
function counts(repo, target, branch) {
  const out = git(["rev-list", "--left-right", "--count", `${target}...${branch}`], repo, { allowFail: true });
  if (!out) return { behind: null, ahead: null };
  const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number(n));
  return { behind: Number.isFinite(behind) ? behind : null, ahead: Number.isFinite(ahead) ? ahead : null };
}

function isAncestor(repo, branch, target) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, target], {
      cwd: repo,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function lastCommit(dir) {
  const line = git(["log", "-1", "--format=%h%x09%an%x09%cI%x09%s"], dir, { allowFail: true });
  if (!line || !line.trim()) return null;
  const [sha, author, date, subject] = line.trim().split("\t");
  const ts = Date.parse(date || "");
  return {
    sha,
    author,
    date,
    subject,
    ageDays: Number.isFinite(ts) ? Math.floor((Date.now() - ts) / DAY_MS) : null,
  };
}

function dirSize(dir, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const current = stack.pop();
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) stack.push(full);
      } else if (item.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  }
  return { bytes, files };
}

function human(bytes) {
  if (bytes === null || bytes === undefined) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function describe(repo, entry, target, { includeSize = false } = {}) {
  const dir = entry.path;
  const isMain = samePath(path.resolve(dir), mainWorktreePath(repo));
  const status = statusOf(dir);
  const commit = lastCommit(dir);
  const branch = entry.branch || (entry.detached ? `detached@${(entry.head || "").slice(0, 7)}` : null);
  const counter = branch && !isMain ? counts(repo, target, branch) : { ahead: null, behind: null };
  const merged = branch && !isMain ? isAncestor(repo, branch, target) : null;
  const age = commit && commit.ageDays !== null ? commit.ageDays : dirAgeDays(dir);
  return {
    repo,
    path: dir,
    branch,
    isMain,
    head: entry.head ? entry.head.slice(0, 7) : null,
    detached: Boolean(entry.detached),
    locked: entry.locked,
    prunable: entry.prunable,
    clean: status.clean,
    dirtyCount: status.dirtyCount ?? 0,
    dirtyFiles: status.dirtyFiles || [],
    ahead: counter.ahead,
    behind: counter.behind,
    mergedIntoTarget: merged,
    ageDays: age,
    sizeBytes: includeSize ? (dirSize(dir) || {}).bytes ?? null : null,
    lastCommit: commit,
  };
}

function dirAgeDays(dir) {
  try {
    const mtime = fs.statSync(dir).mtimeMs;
    return Math.floor((Date.now() - mtime) / DAY_MS);
  } catch {
    return null;
  }
}

function bucketOf(info, staleDays) {
  if (info.locked) return { bucket: "hold", reason: "worktree is locked" };
  if (info.isMain) return { bucket: "hold", reason: "primary worktree" };
  if (info.clean === false) return { bucket: "hold", reason: `${info.dirtyCount} uncommitted change(s)` };
  if (info.prunable) return { bucket: "hold", reason: `prunable: ${info.prunable}` };
  if (info.ahead && info.ahead > 0) return { bucket: "hold", reason: `${info.ahead} commit(s) not merged into target` };
  if (info.mergedIntoTarget) return { bucket: "safe", reason: "clean and already merged into target" };
  if (info.ageDays !== null && info.ageDays >= staleDays) {
    return { bucket: "review", reason: `clean, not merged, idle ${info.ageDays}d` };
  }
  return { bucket: "review", reason: "clean, merge state unknown" };
}

function configSummary(config, repo) {
  const e = effective(config, repo);
  return [
    `root: ${managedRoot(config, repo) ?? "(unset)"}`,
    `baseRef: ${e.baseRef}`,
    `branchPrefix: ${e.branchPrefix}`,
    `staleDays: ${e.staleDays}`,
    ...(config.parseError
      ? [`config: ${config.file} (corrupted, failed to parse: ${config.parseError} — defaults in effect)`]
      : [`config: ${config.file}`]),
  ].join(" | ");
}

function table(rows) {
  if (!rows.length) return "_no rows_";
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).length);
    });
  }
  const line = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  return [line(rows[0]), line(widths.map((w) => "-".repeat(w))), ...rows.slice(1).map(line)].join("\n");
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

/* ------------------------------------------------------------------- tools */

const stringArg = (value) => (value === undefined || value === null ? "" : String(value));
const boolArg = (value) => value === true || value === "true";
const isInside = (dir, root) => {
  const rel = path.relative(root, dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const numArg = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const tools = [
  {
    name: "worktree_create",
    description:
      "Create a git worktree for a branch in the configured root directory. If the branch already exists (and is not checked out elsewhere) it is checked out as-is — the common way to inspect or verify someone's PR branch; otherwise a new branch is created from the base ref. Requires a configured root (WORKTREE_ROOT, or worktree_set_root) — there is no implicit default location, and the call is refused without one. A root inside the repository is allowed: the create call first writes it into the local .git/info/exclude (never the tracked .gitignore) so the main checkout stays clean; only a root inside the .git directory itself is refused. Returns the absolute worktree path plus the exact steps to open a session that works inside it.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Absolute path inside the repository. Defaults to the current session directory." },
        name: { type: "string", description: "Branch name, or a short task name that gets the configured prefix and slug applied. An existing branch is checked out as-is instead of being recreated." },
        baseRef: { type: "string", description: "Base commit/ref to branch from. Defaults to the configured baseRef; `auto` follows the current checked-out branch of the session repository, falling back to the repository default branch when detached." },
        path: { type: "string", description: "Explicit absolute worktree directory. Defaults to <configured root>/<branch-slug>." },
        noCheckout: { type: "boolean", description: "Create with --no-checkout: HEAD is set but no working-tree files (git status there reads as deletions, so removal needs force). Useful for huge repositories. Default false." },
      },
      required: ["name"],
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const name = stringArg(args.name).trim();
      if (!name) return fail("`name` is required (branch name or short task name).");

      const e = effective(config, repo);
      if (!e.root) {
        return fail(
          [
            "no worktree root configured — refusing to create one implicitly.",
            "Set a root first, any of:",
            "  - environment variable WORKTREE_ROOT (the ZCode settings field maps to it)",
            '  - worktree_set_root with scope "repo" and repoPath (this repository only)',
            '  - worktree_set_root with scope "global" (every repository)',
          ].join("\n"),
        );
      }
      const looksLikeBranch = name.includes("/") || /^[A-Za-z0-9._-]+$/.test(name);
      // 带 "/" 的名字按显式分支名原样使用；短任务名走 slug()，其白名单剥除（[^A-Za-z0-9._-]）
      // 保证合成出的分支不可能夹带选项或空白，这里再对最终分支名兜底校验一次
      const branch = looksLikeBranch && name.includes("/") ? name : `${e.branchPrefix}${slug(name)}`;
      if (branch.startsWith("-") || branch.trim() !== branch) {
        return fail(`invalid branch name \`${branch}\`: must not start with "-" or contain surrounding whitespace.`);
      }
      const baseRef = resolveBase(config, repo, args.baseRef);
      // 分支已存在时不再 -b 重建（git 必然拒绝），改为直接检出——
      // 检出既有分支（如 PR 分支）做验证是 worktree 的高频用法
      const branchExists = Boolean(
        (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo, { allowFail: true }) || "").trim(),
      );
      if (branchExists && stringArg(args.baseRef).trim()) {
        return fail(
          `branch \`${branch}\` already exists, so \`baseRef\` would be ignored (it only seeds new branches).\nOmit \`baseRef\` to check the existing branch out, or pass a different \`name\`.`,
        );
      }
      const rootDir = managedRoot(config, repo);
      // README 承诺 worktree 建在配置根目录下：显式 path 也必须落在受管根内
      const dir = args.path ? path.resolve(String(args.path)) : path.join(rootDir, slug(branch));
      if (args.path && !isInside(dir, rootDir)) {
        return fail(`explicit \`path\` resolves to ${dir}, outside the managed root ${rootDir}.\nChoose a directory inside the managed root, or drop \`path\` to use <root>/<branch-slug>.`);
      }

      // 落点在仓库工作树内：git 会照建（实测），但 checkout 混进 .git 对象库是病态配置且
      // exclude 无法表达，直接拒绝；否则先把受管根写进本地忽略，保证主检出 status 干净
      let ignoreEntry = null;
      if (isInside(dir, repo)) {
        const gitDir = (git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo, { allowFail: true }) || "").trim();
        if (gitDir && isInside(dir, gitDir)) {
          return fail(`target directory ${dir} is inside the repository's git directory ${gitDir}.\nMove the configured root outside the git directory (worktree_set_root), or pass \`path\` outside it.`);
        }
        // 优先忽略整个受管根（一条覆盖后续所有 worktree）；root==repo 时退化为按本次目录忽略
        ignoreEntry = ensureInsideRepoIgnore(repo, rootDir, gitDir) ?? ensureInsideRepoIgnore(repo, dir, gitDir);      }

      const registered = listWorktrees(repo);
      // slug() 把仅大小写 / 非 ASCII 不同的分支折叠到同一目录：撞名时点名根因，而不是只报目录非空
      const slugClash = registered.find((w) => w.branch && w.branch !== branch && slug(w.branch) === slug(branch));
      const clashHint = slugClash
        ? `\nNote: branch \`${slugClash.branch}\` (worktree ${slugClash.path}) is a different branch but slugifies to the same directory \`${slug(branch)}\` — letter case and non-ASCII differences do not survive directory naming.`
        : "";
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
        return fail(`target directory is not empty: ${dir}\nChoose another \`path\`, or remove the leftover directory first.${clashHint}`);
      }
      const existing = registered.find((w) => samePath(w.path, dir));
      if (existing) return fail(`git already registers this worktree: ${dir} (branch ${existing.branch || "detached"}).${clashHint}`);

      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const noCheckout = boolArg(args.noCheckout);
      const addArgs = ["worktree", "add", ...(noCheckout ? ["--no-checkout"] : [])];
      try {
        git(branchExists ? [...addArgs, dir, branch] : [...addArgs, dir, "-b", branch, baseRef], repo);
      } catch (err) {
        return fail(classifyAddFailure(err, branch, baseRef));
      }

      const baseLabel = branchExists ? branch : baseRef;
      const info = describe(repo, pickWorktree(repo, branch), resolveTarget(repo), { includeSize: false });
      return ok(
        [
          `Created worktree for branch \`${branch}\`${branchExists ? " (existing branch checked out)" : ""}.`,
          ``,
          `- path: ${dir}`,
          `- branch: ${branch}`,
          `- base: ${baseLabel} @ ${info.head}`,
          ...(ignoreEntry?.wrote
            ? [`- note: root is inside the repository; added \`${ignoreEntry.entry}\` to .git/info/exclude (local-only ignore) so the worktree does not pollute \`git status\`.`]
            : []),
          `- config: ${configSummary(config, repo)}`,
          ``,
          `The running session keeps its own working directory, so it cannot start working in the new one. To move the work into this worktree:`,
          `1. Open a new session in your agent host.`,
          `2. Use this directory as that session's working directory:`,
          `   ${dir}`,
          `3. Paste the briefing below as the first message.`,
          ``,
          "--- briefing ---",
          handoffText(repo, branch, `Work on the task in worktree ${dir} (branch ${branch}, based on ${baseLabel}).`),
          "--- end briefing ---",
        ].join("\n"),
      );
    },
  },
  {
    name: "worktree_list",
    description:
      "List every git worktree of a repository with branch, HEAD, dirty state, commits ahead/behind of the target, and merge state.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Optional: only this worktree (branch name, slug, or absolute path)." },
        includeSize: { type: "boolean", description: "Compute on-disk size. Slower; default false." },
        target: { type: "string", description: "Comparison ref. Defaults to the current checked-out branch, then origin/<default branch> when detached." },
      },
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const target = resolveTarget(repo, args.target);
      const entries = args.name && String(args.name).trim()
        ? [pickWorktree(repo, args.name)]
        : listWorktrees(repo);
      const includeSize = boolArg(args.includeSize);
      const infos = entries.map((e) => describe(repo, e, target, { includeSize }));

      // 列只在 includeSize 时追加/省略 SIZE；禁用 filter(Boolean)，否则 ahead=0 / ageDays=0 这类有效零值会被丢掉导致列错位
      const rows = [["WORKTREE", "PATH", "BRANCH", "CLEAN", "AHEAD", "BEHIND", "MERGED", "AGE(d)", ...(includeSize ? ["SIZE"] : [])].map(String)];
      for (const i of infos) {
        rows.push([
          i.isMain ? "main" : "wt",
          i.path,
          i.branch || "-",
          i.clean === null ? "?" : i.clean ? "yes" : `dirty(${i.dirtyCount})`,
          i.ahead ?? "-",
          i.behind ?? "-",
          i.mergedIntoTarget === null ? "-" : i.mergedIntoTarget ? "yes" : "no",
          i.ageDays ?? "-",
          ...(includeSize ? [human(i.sizeBytes)] : []),
        ].map(String));
      }

      return ok(
        [
          `Target ref: ${target}`,
          `Config: ${configSummary(config, repo)}`,
          ``,
          table(rows),
          ``,
          ...infos
            .filter((i) => i.clean === false)
            .flatMap((i) => [`dirty in ${i.path}:`, ...i.dirtyFiles.map((f) => `  ${f}`)]),
        ].join("\n"),
      );
    },
  },
  {
    name: "worktree_status",
    description:
      "Full detail for one worktree: path, branch, base, dirty files, ahead/behind, last commit, size, and whether the current session already runs inside it.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Branch name, slug, or absolute worktree path." },
        target: { type: "string" },
        includeSize: { type: "boolean" },
      },
      required: ["name"],
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const entry = pickWorktree(repo, args.name);
      const target = resolveTarget(repo, args.target);
      const info = describe(repo, entry, target, { includeSize: boolArg(args.includeSize) });
      const bucket = bucketOf(info, effective(config, repo).staleDays);
      // cwd 等于该 worktree 或位于其内部都算在其中；用 isInside 而非 startsWith，避免兄弟前缀目录（wt-a vs wt-ab）误判
      const cwdDir = path.resolve(process.cwd());
      const wtDir = path.resolve(info.path);
      const cwdInside = samePath(cwdDir, wtDir) || isInside(cwdDir, wtDir);
      return ok(
        [
          `Worktree: ${info.path}`,
          `- branch: ${info.branch || "(detached)"}`,
          `- head: ${info.head}`,
          `- primary worktree: ${info.isMain ? "yes" : "no"}`,
          `- clean: ${info.clean === null ? "unknown" : info.clean ? "yes" : `no (${info.dirtyCount} change(s))`}`,
          ...(info.dirtyFiles.length ? ["- dirty files:", ...info.dirtyFiles.map((f) => `    ${f}`)] : []),
          `- vs target ${target}: ahead ${info.ahead ?? "?"}, behind ${info.behind ?? "?"}`,
          `- merged into target: ${info.mergedIntoTarget === null ? "n/a" : info.mergedIntoTarget ? "yes" : "no"}`,
          `- idle: ${info.ageDays ?? "?"} day(s)`,
          ...(info.sizeBytes !== null ? [`- size: ${human(info.sizeBytes)}`] : []),
          `- last commit: ${info.lastCommit ? `${info.lastCommit.sha} ${info.lastCommit.date} ${info.lastCommit.author} — ${info.lastCommit.subject}` : "none"}`,
          `- bucket: ${bucket.bucket} (${bucket.reason})`,
          `- current session cwd inside this worktree: ${cwdInside ? "yes" : "no"}`,
          ``,
          `Config: ${configSummary(config, repo)}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "worktree_audit",
    description:
      "Classify every worktree as safe / review / hold before cleanup, with the reason and a suggested action. Never deletes anything.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        target: { type: "string" },
        staleDays: { type: "number", description: "Override the configured idle threshold." },
        includeSize: { type: "boolean" },
      },
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const target = resolveTarget(repo, args.target);
      const staleDays = numArg(args.staleDays) ?? effective(config, repo).staleDays;
      const includeSize = boolArg(args.includeSize);
      const infos = listWorktrees(repo).map((e) => describe(repo, e, target, { includeSize }));
      const rated = infos.map((i) => ({ info: i, ...bucketOf(i, staleDays) }));
      const order = { hold: 0, review: 1, safe: 2 };
      rated.sort((a, b) => order[a.bucket] - order[b.bucket] || (b.info.sizeBytes || 0) - (a.info.sizeBytes || 0));

      const rows = [["BUCKET", "BRANCH", "PATH", "REASON", "AGE(d)", ...(includeSize ? ["SIZE"] : [])].map(String)];
      for (const r of rated) {
        rows.push([
          r.bucket,
          r.info.branch || "-",
          r.info.path,
          r.reason,
          r.info.ageDays ?? "-",
          ...(includeSize ? [human(r.info.sizeBytes)] : []),
        ].map(String));
      }

      const safe = rated.filter((r) => r.bucket === "safe");
      const review = rated.filter((r) => r.bucket === "review");
      const hold = rated.filter((r) => r.bucket === "hold");
      const reclaimable = safe.reduce((sum, r) => sum + (r.info.sizeBytes || 0), 0);

      return ok(
        [
          `Target ref: ${target} | idle threshold: ${staleDays}d | Config: ${configSummary(config, repo)}`,
          ``,
          table(rows),
          ``,
          `safe to remove: ${safe.length}`,
          `needs review: ${review.length}`,
          `hold: ${hold.length}`,
          ...(includeSize ? [`reclaimable size (safe only): ${human(reclaimable)}`] : []),
          ``,
          `This tool never deletes. After you confirm with the user, call worktree_remove for the safe ones.`,
        ].join("\n"),
      );
    },
  },
  {
    name: "worktree_remove",
    description:
      "Remove a worktree and optionally its branch. Refuses to delete when the worktree has uncommitted changes or unmerged commits unless `force` is true.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Branch name, slug, or absolute worktree path." },
        target: { type: "string" },
        deleteBranch: { type: "boolean", description: "Also delete the branch after removal. Default false." },
        force: { type: "boolean", description: "Delete even with uncommitted changes or unmerged commits. Default false." },
      },
      required: ["name"],
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const entry = pickWorktree(repo, args.name);
      if (samePath(entry.path, mainWorktreePath(repo))) {
        return fail("refusing to remove the primary worktree.");
      }
      const target = resolveTarget(repo, args.target);
      const info = describe(repo, entry, target, {});
      const force = boolArg(args.force);
      if (entry.locked) {
        return fail(`refusing to remove a locked worktree (${entry.locked}).\nUnlock it with \`git worktree unlock ${entry.path}\`, then re-run.`);
      }
      const managedPath = managedRoot(config, repo);
      // force only covers dirty/unmerged work; it never widens the managed root.
      if (!managedPath || !isInside(info.path, path.resolve(managedPath))) {
        return fail(`refusing to remove a worktree outside the managed root ${managedPath ?? "(none configured)"}.\nSet that root with worktree_set_root, or remove this worktree yourself.`);
      }

      if (!force) {
        if (info.clean === false) {
          return fail(`refusing to remove a dirty worktree (${info.dirtyCount} uncommitted change(s)).\nResolve them, or call again with force=true if the user explicitly asked to discard them.`);
        }
        // 有真实分支却数不出 ahead：合并没有验证成，不能因为 null 而当成「已合并」放行。
        // 判据用 entry.branch 而非 info.branch：detached 的 info.branch 是 "detached@<sha>" 合成串，
        // 它本就没有分支可与 target 比，不该被这条护栏拦下。
        if (entry.branch && info.ahead === null) {
          return fail(`refusing to remove: cannot determine whether branch \`${entry.branch}\` is merged into ${target} (rev-list against ${target} returned nothing).\nCheck that the target ref resolves, or call again with force=true if the user accepts losing unmerged commits.`);
        }
        if (info.ahead > 0) {
          return fail(`refusing to remove: ${info.ahead} commit(s) are not merged into ${target}.\nMerge first (worktree_merge_back), or call again with force=true if the user accepts losing them.`);
        }
      }

      git(["worktree", "remove", ...(force ? ["--force"] : []), info.path], repo);
      git(["worktree", "prune"], repo, { allowFail: true });
      let branchNote = "";
      if (boolArg(args.deleteBranch) && info.branch) {
        const deleted = git(["branch", "-d", info.branch], repo, { allowFail: true });
        branchNote = deleted === null ? `\nbranch \`${info.branch}\` was kept (not fully merged or still referenced).` : `\nbranch \`${info.branch}\` deleted.`;
      }
      return ok(
        [
          `Removed worktree ${info.path}${info.branch ? ` (branch ${info.branch})` : ""}.`,
          ...(force ? ["Note: forced removal — uncommitted work or unmerged commits may be gone."] : []),
          branchNote,
          `Remaining worktrees: ${listWorktrees(repo).map((w) => w.branch || w.path).join(", ")}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "worktree_lock",
    description:
      "Lock a worktree (git worktree lock). worktree_remove and worktree_merge_back refuse to touch locked worktrees — use this while another agent session or person is working in it, so cleanup passes leave it alone.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Branch name, slug, or absolute worktree path." },
        reason: { type: "string", description: "Optional reason recorded with the lock (shown by git worktree list -v)." },
      },
      required: ["name"],
    },
    handler: (args) => {
      const repo = repoRoot(args.repoPath);
      const entry = pickWorktree(repo, args.name);
      if (samePath(entry.path, mainWorktreePath(repo))) {
        return fail("refusing to lock the primary worktree.");
      }
      const reason = stringArg(args.reason).trim();
      git(["worktree", "lock", ...(reason ? ["--reason", reason] : []), entry.path], repo);
      return ok(
        `Locked worktree ${entry.path}${reason ? ` (reason: ${reason})` : ""}.\nworktree_remove and worktree_merge_back now refuse to touch it; unlock with worktree_unlock.`,
      );
    },
  },
  {
    name: "worktree_unlock",
    description: "Unlock a worktree locked by worktree_lock or git worktree lock, re-allowing removal and merge-back.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Branch name, slug, or absolute worktree path." },
      },
      required: ["name"],
    },
    handler: (args) => {
      const repo = repoRoot(args.repoPath);
      const entry = pickWorktree(repo, args.name);
      git(["worktree", "unlock", entry.path], repo);
      return ok(`Unlocked worktree ${entry.path}. Removal and merge-back are allowed again.`);
    },
  },
  {
    name: "worktree_merge_back",
    description:
      "Report-only by default. With rebase/merge/remove enabled it rebases the worktree branch onto the target, merges it into the repository's target branch, and cleans up. Stops and reports on any conflict instead of resolving it.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Branch name, slug, or absolute worktree path." },
        target: { type: "string", description: "Branch to land on. Defaults to the current checked-out branch, falling back to origin/<default branch> when detached." },
        rebase: { type: "boolean", description: "Run `git -C <worktree> rebase <target>`. Default false." },
        ff: { type: "boolean", description: "With merge: fast-forward only (linear history, no merge commit); refuses when the branches diverged. Default false (--no-ff merge commit)." },
        merge: { type: "boolean", description: "Run `git merge` in the main worktree. Default false." },
        remove: { type: "boolean", description: "Remove the worktree (and optionally the branch) after a clean merge. Default false." },
        deleteBranch: { type: "boolean" },
      },
      required: ["name"],
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const entry = pickWorktree(repo, args.name);
      if (samePath(entry.path, mainWorktreePath(repo))) {
        return fail("this is the primary worktree; nothing to merge back from it.");
      }
      if (boolArg(args.remove) && entry.locked) {
        return fail(`this worktree is locked (${entry.locked}), so it cannot be removed after merge.\nUnlock it with \`git worktree unlock ${entry.path}\`, or re-run without remove=true.`);
      }
      const target = resolveTarget(repo, args.target);
      const info = describe(repo, entry, target, {});
      const steps = [`Plan for ${info.branch || info.path} → ${target}:`, `- clean: ${info.clean ? "yes" : `no (${info.dirtyCount} uncommitted)`}`, `- commits ahead of ${target}: ${info.ahead ?? "?"}`, `- already merged: ${info.mergedIntoTarget ? "yes" : "no"}`];
      if (info.clean === false) return fail(`${steps.join("\n")}\nUncommitted changes block merge-back. Commit, stash, or discard them first.`);

      const doRebase = boolArg(args.rebase);
      const doMerge = boolArg(args.merge);
      const doRemove = boolArg(args.remove);
      if (!doRebase && !doMerge && !doRemove) return ok(`${steps.join("\n")}\n\nReport-only. Pass rebase/merge/remove=true to execute.`);

      if (doRebase && (info.ahead || 0) > 0 && !info.mergedIntoTarget) {
        try {
          git(["rebase", target], info.path);
          steps.push(`- rebase onto ${target}: ok`);
        } catch (err) {
          // 只有确认存在未合并文件才算 CONFLICT；否则原样报告失败原因（如无效 ref、仓库不可用）
          const conflicts = (git(["diff", "--name-only", "--diff-filter=U"], info.path, { allowFail: true }) || "").trim();
          if (conflicts) {
            return fail(`${steps.join("\n")}\n- rebase onto ${target}: CONFLICT, stopped for the user.\nResolve in ${info.path}, then re-run with --continue/--abort on the command line.\nconflicted files:\n${conflicts}`);
          }
          return fail(`${steps.join("\n")}\n- rebase onto ${target}: failed.\n${err.message}`);
        }
      }

      if (doMerge) {
        const branch = info.branch;
        if (!branch) return fail(`${steps.join("\n")}\n- merge: skipped, worktree is detached.`);
        const checkedOut = currentBranch(repo) || "HEAD";
        if (checkedOut !== target) {
          return fail(`${steps.join("\n")}\n- merge: REFUSED. The main worktree has \`${checkedOut}\` checked out, but the target is \`${target}\`.\nCheck out \`${target}\` in ${repo} first, then re-run.`);
        }
        if (info.ahead === 0 && info.mergedIntoTarget) {
          steps.push(`- merge: skipped, ${target} already contains ${branch}`);
        } else {
          const useFf = boolArg(args.ff);
          const mergeArgs = useFf
            ? ["merge", "--ff-only", branch]
            : ["merge", "--no-ff", "-m", `Merge ${branch} into ${target}`, branch];
          try {
            git(mergeArgs, repo);
            steps.push(`- merge ${branch} into ${target}: ${useFf ? "ok (fast-forward)" : "ok"}`);
          } catch (err) {
            if (useFf && /fast-forward/i.test(String((err && err.message) || err))) {
              return fail(`${steps.join("\n")}\n- merge: REFUSED. ${branch} and ${target} have diverged, so a fast-forward is impossible.\nRebase first (rebase: true), or drop \`ff\` to merge with a merge commit.`);
            }
            // 只有确认存在未合并文件才算 CONFLICT；否则原样报告失败原因（如无效 ref、仓库不可用）
            const conflicts = (git(["diff", "--name-only", "--diff-filter=U"], repo, { allowFail: true }) || "").trim();
            if (conflicts) {
              return fail(`${steps.join("\n")}\n- merge: CONFLICT in ${repo}.\nResolve and commit there, or run \`git merge --abort\`.\nconflicted files:\n${conflicts}`);
            }
            return fail(`${steps.join("\n")}\n- merge: failed.\n${err.message}`);
          }
        }
      }

      if (doRemove) {
        // 与 worktree_remove 一致的受管根护栏：越界一律不删，任何 flag 都不放宽
        const managedPath = managedRoot(config, repo);
        const inManaged = Boolean(managedPath) && isInside(info.path, path.resolve(managedPath));
        const mergedNow = info.branch ? isAncestor(repo, info.branch, target) : false;
        if (!inManaged) {
          steps.push(`- kept worktree ${info.path}: outside the managed root ${managedPath ?? "(none configured)"}; run worktree_remove if intentional`);
        } else if (!mergedNow) {
          // 分支未并入 target 时禁止强删：--force 会连带丢掉未合并提交
          steps.push(`- kept worktree ${info.path}: branch not merged into ${target}; run worktree_remove if intentional`);
        } else {
          try {
            git(["worktree", "remove", info.path], repo);
          } catch (err) {
            // Merge already landed (or was skipped as already merged); never report it as a plain failure.
            // The merge has already landed in a shared ref, so report success with the cleanup
            // failure instead of isError, which would make clients retry the whole call.
            return ok(
              `${steps.join("\n")}\n\nWorktree cleanup FAILED after the merge step:\n${err.message}\nThe worktree ${info.path} was left in place${info.branch ? `; branch \`${info.branch}\` was left in place` : ""}.\nFix the cause above (e.g. unlock it), then run worktree_remove.`,
            );
          }
          git(["worktree", "prune"], repo, { allowFail: true });
          steps.push(`- removed worktree ${info.path}`);
          if (boolArg(args.deleteBranch) && info.branch) {
            const deleted = git(["branch", "-d", info.branch], repo, { allowFail: true });
            steps.push(deleted === null ? `- branch ${info.branch} kept` : `- branch ${info.branch} deleted`);
          }
        }
      }

    return ok(`${steps.join("\n")}\n\nConfig: ${configSummary(config, repo)}`);
    },
  },
  {
    name: "worktree_set_root",
    description:
      "Read or change where worktrees are created. Scope `global` applies to every repository; scope `repo` stores an override for one repository. root=null clears the setting — worktree_create refuses until a root is configured.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "Default: set when any value is supplied, otherwise get." },
        scope: { type: "string", enum: ["global", "repo"], description: "Default global." },
        repoPath: { type: "string", description: "Required for scope=repo." },
        root: { type: "string", description: "Absolute worktree root. Omit or pass null to reset." },
        baseRef: { type: "string", description: "Default base ref, or `auto` to follow the current checked-out branch (repository default branch when detached)." },
        branchPrefix: { type: "string" },
        staleDays: { type: "number" },
        clearRepoOverride: { type: "boolean" },
      },
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = args.repoPath ? repoRoot(args.repoPath) : null;
      const scope = stringArg(args.scope) || "global";
      if (scope !== "global" && scope !== "repo") {
        return fail(`invalid scope \`${scope}\`: use "global" or "repo".`);
      }
      if (scope === "repo" && !repo) return fail("scope=repo requires `repoPath`.");

      const isSet = stringArg(args.action) === "set"
        || args.root !== undefined
        || args.baseRef !== undefined
        || args.branchPrefix !== undefined
        || args.staleDays !== undefined
        || boolArg(args.clearRepoOverride);

      if (!isSet) {
        return ok(
          [
            `config file: ${config.file}`,
            `global: root=${config.root ?? "(unset)"} baseRef=${config.baseRef} branchPrefix=${config.branchPrefix} staleDays=${config.staleDays}`,
            `per-repo overrides: ${Object.keys(config.repos).length === 0 ? "(none)" : ""}`,
            ...Object.entries(config.repos).map(([k, v]) => `  ${k} → ${JSON.stringify(v)}`),
            ...(repo ? ["", `effective for ${repo}: ${configSummary(config, repo)}`] : []),
          ].join("\n"),
        );
      }

      // 配置文件损坏时拒绝一切写入：现在保存会用内存里的残缺内容覆盖原文件，先让用户修复
      if (config.parseError) {
        return fail(
          [
            `config file ${config.file} is corrupted (failed to parse: ${config.parseError}).`,
            "Refusing to write: saving would overwrite the broken file and lose the original content.",
            "Fix or delete the file above, then re-run worktree_set_root.",
          ].join("\n"),
        );
      }

      if (scope === "repo") {
        // 键按主仓库路径归一：从 link worktree 里 set 的覆盖，主检出会话同样读得到
        const canonical = mainWorktreePath(repo);
        const key = repoKey(config, canonical) || repoKey(config, repo) || canonical;
        if (boolArg(args.clearRepoOverride)) {
          delete config.repos[key];
          saveConfig(config);
          return ok(`Removed the per-repo override for ${repo}. Effective: ${configSummary(config, repo)}`);
        }
        const current = config.repos[key] || {};
        if (args.root !== undefined) current.root = args.root === null || args.root === "" ? null : path.resolve(String(args.root));
        if (args.baseRef !== undefined) {
          const v = String(args.baseRef);
          if (v.trim() !== "") assertSafeRef(v, "baseRef"); // 空串保留原语义（回退 auto）
          current.baseRef = v;
        }
        if (args.branchPrefix !== undefined) {
          const v = String(args.branchPrefix);
          if (v.trim() !== "") assertSafeRef(v, "branchPrefix"); // 前缀会拼进分支名，同样不允许前导 "-"
          current.branchPrefix = v;
        }
        if (args.staleDays !== undefined && args.staleDays !== null && args.staleDays !== "") {
          const staleDays = numArg(args.staleDays);
          if (staleDays === null || !(staleDays > 0)) {
            return fail(`invalid staleDays \`${args.staleDays}\`: must be a positive number of days.`);
          }
          current.staleDays = staleDays;
        }
        config.repos[key] = current;
        saveConfig(config);
        return ok(`Per-repo override for ${repo} saved.\n${configSummary(config, repo)}`);
      }

      if (boolArg(args.clearRepoOverride)) return fail("clearRepoOverride only applies to scope=repo.");
      if (args.root !== undefined) config.root = args.root === null || args.root === "" ? null : path.resolve(String(args.root));
      if (args.baseRef !== undefined) {
        const v = String(args.baseRef);
        if (v.trim() !== "") assertSafeRef(v, "baseRef");
        config.baseRef = v;
      }
      if (args.branchPrefix !== undefined) {
        const v = String(args.branchPrefix);
        if (v.trim() !== "") assertSafeRef(v, "branchPrefix");
        config.branchPrefix = v;
      }
      if (args.staleDays !== undefined && args.staleDays !== null && args.staleDays !== "") {
        const staleDaysArg = numArg(args.staleDays);
        if (staleDaysArg === null || !(staleDaysArg > 0)) {
          return fail(`invalid staleDays \`${args.staleDays}\`: must be a positive number of days.`);
        }
        config.staleDays = staleDaysArg;
      }
      const file = saveConfig(config);
      return ok(
        [
          `Saved ${file}`,
          `global: root=${config.root ?? "(unset)"} baseRef=${config.baseRef} branchPrefix=${config.branchPrefix} staleDays=${config.staleDays}`,
          ...(repo ? ["", `effective for ${repo}: ${configSummary(config, repo)}`] : []),
        ].join("\n"),
      );
    },
  },
  {
    name: "worktree_handoff",
    description:
      "Produce the ready-to-paste briefing for working in an existing worktree: what to open, which branch it is on, its base, and the constraints of agent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        name: { type: "string", description: "Branch name, slug, or absolute worktree path." },
        task: { type: "string", description: "Optional task text to embed in the briefing." },
        target: { type: "string" },
      },
      required: ["name"],
    },
    handler: (args) => {
      const { config } = loadConfig();
      const repo = repoRoot(args.repoPath);
      const entry = pickWorktree(repo, args.name);
      const target = resolveTarget(repo, args.target);
      const info = describe(repo, entry, target, {});
      return ok(handoffText(repo, info.branch || info.path, stringArg(args.task).trim(), info, config));
    },
  },
];

function handoffText(repo, branch, task, info = null, config = null) {
  const { config: cfg } = config ? { config } : loadConfig();
  const entry = info || describe(repo, pickWorktree(repo, branch), resolveTarget(repo), {});
  const lines = [
    `Run location (work in this directory, and nowhere else):`,
    `${entry.path}`,
    ``,
    `Branch: ${entry.branch || "(detached)"}`,
    `HEAD: ${entry.head}${entry.lastCommit ? ` — ${entry.lastCommit.subject}` : ""}`,
    `Base target: ${resolveTarget(repo)}`,
    ...(task ? ["", `Task:`, task] : []),
    ``,
    `Constraints:`,
    `- This session already runs in the worktree; do not create another one for this task.`,
    `- Most hosts give subagents the session's working directory, so parallel writers here share one worktree — give each writer its own branch and worktree if they must not collide.`,
    `- Keep commits small; finish with ${entry.branch || "the branch"} rebased on ${resolveTarget(repo)}.`,
    ``,
    `Config: ${configSummary(cfg, repo)}`,
  ];
  return lines.join("\n");
}

/* --------------------------------------------------------- MCP json-rpc */

const TOOL_MAP = new Map(tools.map((t) => [t.name, t]));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "initialized":
      return undefined;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = params && params.name;
      const tool = TOOL_MAP.get(name);
      if (!tool) return reply(id, { content: [{ type: "text", text: `Error: unknown tool ${name}` }], isError: true });
      try {
        const result = tool.handler(params.arguments || {});
        return reply(id, result);
      } catch (err) {
        return reply(id, { content: [{ type: "text", text: `Error: ${err && err.message ? err.message : String(err)}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return undefined;
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  Promise.resolve(handle(message)).catch((err) => {
    if (message && message.id !== undefined) {
      replyError(message.id, -32603, err && err.message ? err.message : String(err));
    }
  });
});
