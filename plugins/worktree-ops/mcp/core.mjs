// worktree-ops MCP server — core layer.
//
// Configuration (file + env overrides + atomic locked writes), git plumbing,
// path helpers and worktree inspection live here. Tool definitions live in
// tools.mjs, JSON-RPC framing in protocol.mjs, and server.mjs only wires them.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 插件根：本文件位于 <plugin>/mcp/core.mjs，上一层即插件根。用于识别「进程 cwd 就是插件根」这种
// 拿不到会话目录的情形（Agent Plugins 规范：mcp.json 省略 cwd 时默认 cwd = 插件根）。
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DAY_MS = 86400000;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  ".venv", "venv", ".next", ".nuxt", ".gradle", "Pods", ".cache",
]);

// 版本位与 plugins/worktree-ops/plugin.json 同步，由 `node scripts/release.mjs worktree-ops <x.y.z>` 统一改
// （SERVER_INFO 在 protocol.mjs，因为它是 initialize 回给客户端的服务端身份）

// 本服务端实现的 MCP 协议版本，按新到旧排列。initialize 时若客户端报的是列表外的
// 版本，回落到列表首个（最新的），而不是原样回显客户端的值。
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];

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
  if (process.env.WORKTREE_ROOT) {
    // 相对路径会按宿主启动 MCP 的 cwd 解析（标准客户端下是插件根），把 worktree 建到插件目录里。
    // 与 staleDays 的坏值处理一致：忽略这一层，回退配置文件里的根。
    if (path.isAbsolute(process.env.WORKTREE_ROOT)) out.root = path.resolve(process.env.WORKTREE_ROOT);
  }
  if (process.env.WORKTREE_BASE_REF) out.baseRef = process.env.WORKTREE_BASE_REF;
  if (process.env.WORKTREE_BRANCH_PREFIX !== undefined && process.env.WORKTREE_BRANCH_PREFIX !== "") {
    out.branchPrefix = process.env.WORKTREE_BRANCH_PREFIX;
  }
  const stale = Number(process.env.WORKTREE_STALE_DAYS);
  // 非正数按无效值忽略（回退下一级配置），与 worktree_config / worktree_audit 的正数校验
  // 对齐——此前 0 / 负数照单全收，而 ZCode 设置页把用户输入原样映射到这个环境变量，
  // 三条配置路径里唯独它不设防。env 是环境性配置，坏值不抛错（否则毒死所有工具调用），
  // 回退结果可从 Config: 行的值与来源标注核对。
  if (Number.isFinite(stale) && stale > 0 && process.env.WORKTREE_STALE_DAYS) out.staleDays = stale;
  return out;
}

/** 读磁盘上的配置文件原文。返回 { file, parsed, parseError }。 */
function readConfigFile() {
  const file = path.join(configDir(), "config.json");
  try {
    return { file, parsed: JSON.parse(fs.readFileSync(file, "utf8")), parseError: null };
  } catch (err) {
    // 文件不存在属首次运行的正常情况；真正的解析损坏要留痕，worktree_config 写回前会拒绝并给出修复指引
    if (err && err.code === "ENOENT") return { file, parsed: {}, parseError: null };
    return { file, parsed: {}, parseError: String((err && err.message) || err) };
  }
}

const REPO_OVERRIDE_FIELDS = ["root", "baseRef", "branchPrefix", "staleDays"];

/** 校验单仓库覆盖对象的字段类型：剔除非法值并记录问题，坏值不参与生效值计算。
*  root 允许显式为 null（= 该仓库不配置根目录）；baseRef / branchPrefix 的 null
*  没有语义，按「未配置」处理，免得拼出 "nullxxx" 这样的分支名。 */
function normalizeRepoOverride(key, value, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`repos["${key}"]: expected an object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
    return null;
  }
  const clean = {};
  for (const field of REPO_OVERRIDE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const v = value[field];
    if (v === null) {
      if (field === "root") clean[field] = null;
      continue;
    }
    if (field === "staleDays") {
      // 与顶层 loadConfig 的 staleDays 校验同口径：只收正数。此前 repo 级只查有限数，
      // 手编 0 / 负数被静默接受，audit 的分桶阈值随之变负。非法时剔除该键并报告 issue，
      // 生效值回退顶层 / 默认值。
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        issues.push(`repos["${key}"].staleDays: expected a positive number, got ${JSON.stringify(v)}`);
        continue;
      }
      clean.staleDays = v;
      continue;
    }
    if (typeof v !== "string") {
      issues.push(`repos["${key}"].${field}: expected a string, got ${typeof v}`);
      continue;
    }
    // 空 branchPrefix 会让分支名退化成裸 slug(name)：name 为 ".." 时落点直接逃出受管根一层。
    // 源头拒绝，不让空前缀流到「拼路径」那一步。
    if (field === "branchPrefix" && v === "") {
      issues.push(`repos["${key}"].branchPrefix: expected a non-empty string, got ""`);
      continue;
    }
    // 相对 root 会按宿主 cwd 解析（标准客户端下是插件根），把受管根指到错误位置。
    if (field === "root" && !path.isAbsolute(v)) {
      issues.push(`repos["${key}"].root: expected an absolute path, got ${JSON.stringify(v)}`);
      continue;
    }
    clean[field] = v;
  }
  return clean;
}

function loadConfig() {
  const { file, parsed, parseError } = readConfigFile();
  const issues = [];
  // JSON 顶层可能是 null / 数组 / 标量：不是对象就当空配置，并如实报告
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
    issues.push(`config root: expected an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
  }
  const repos = {};
  if (source.repos !== undefined && source.repos !== null) {
    if (typeof source.repos !== "object" || Array.isArray(source.repos)) {
      issues.push(`repos: expected an object, got ${Array.isArray(source.repos) ? "array" : typeof source.repos}`);
    } else {
      for (const [key, value] of Object.entries(source.repos)) {
        const clean = normalizeRepoOverride(key, value, issues);
        if (clean) repos[key] = clean;
      }
    }
  }
  const rootValue = typeof source.root === "string" ? source.root : null;
  if (rootValue !== null && !path.isAbsolute(rootValue)) {
    issues.push(`root: expected an absolute path, got ${JSON.stringify(rootValue)}`);
  }
  // staleDays 三条写入路径都校验正数，读取路径同口径：手编配置写入 0/负数/非数字时
  // 忽略并报告 issue，不能让 audit 的分桶阈值悄悄变成负数
  if (source.staleDays !== undefined && !(Number.isFinite(source.staleDays) && Number(source.staleDays) > 0)) {
    issues.push(`staleDays: expected a positive number, got ${JSON.stringify(source.staleDays)}`);
    // 连键一起删掉：否则来源标注仍按「配置文件里定义过」显示 (global)，值却是默认 14，自相矛盾
    delete source.staleDays;
  }
  // branchPrefix 同理：空串会让分支名退化成裸 slug，name 为 ".." 时落点逃出受管根一层。
  if (source.branchPrefix === "") {
    issues.push(`branchPrefix: expected a non-empty string, got ""`);
    delete source.branchPrefix;
  }
  const config = {
    file,
    parseError,
    issues,
    // 记录配置文件里真正出现过的键：来源标注只对「文件里写了的」标 global，
    // 物化的默认值不能冒充 global 来源
    sourceKeys: Object.keys(source),
    root: rootValue !== null && path.isAbsolute(rootValue) ? rootValue : null,
    baseRef: typeof source.baseRef === "string" ? source.baseRef : DEFAULT_CONFIG.baseRef,
    branchPrefix: typeof source.branchPrefix === "string" ? source.branchPrefix : DEFAULT_CONFIG.branchPrefix,
    staleDays:
      Number.isFinite(source.staleDays) && Number(source.staleDays) > 0
        ? Number(source.staleDays)
        : DEFAULT_CONFIG.staleDays,
    repos,
  };
  return { file, config };
}

const CONFIG_LOCK_STALE_MS = 30000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 取配置文件的写锁，返回释放函数。持锁者崩溃会留下陈旧锁：超过阈值就当作失效锁清掉。 */
function acquireConfigLock(file) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      const owner = String(process.pid);
      fs.writeSync(fd, owner);
      fs.closeSync(fd);
      return () => {
        try {
          // 只释放仍属于自己的锁：陈旧锁超时被后来者接管后，迟到的 release 不能误删新持锁者的锁，
          // 否则第三方可再获取，两个写者并发读-改-写
          if (fs.readFileSync(lockPath, "utf8") !== owner) return;
          fs.unlinkSync(lockPath);
        } catch {
          /* 已被清理 */
        }
      };
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > CONFIG_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* 锁刚好被别人释放 */
      }
      if (Date.now() > deadline) {
        throw new Error(
          `could not acquire the config lock (${lockPath}) — another process is writing the config.\n` +
            `Retry in a moment; the lock is released automatically once it goes stale.`
        );
      }
      sleepMs(25 + Math.floor(Math.random() * 50));
    }
  }
}

/** 找到某个仓库的覆盖键：优先主检出路径，其次会话仓库路径，都没有就以主检出路径新建。 */
function resolveRepoKey(repos, canonical, repo) {
  const match = (target) => Object.keys(repos || {}).find((k) => samePath(k, target));
  return match(canonical) || match(repo) || canonical;
}

/**
* 写配置文件。changes 描述本次要改什么：
*   { top: { root?, baseRef?, branchPrefix?, staleDays? } } 顶层键，出现即覆盖（null = 清空）
*   { repo: { canonical, repo, fields?, remove? } }        单仓库覆盖；fields 为字段级合并
*
* 并发安全：取文件锁 → 重读磁盘最新值 → 只把本次真正改动的字段盖上去 → 原子 rename。
* 旧实现直接把内存里的整份 config 写回，两个进程各改一个键时，后写者会用自己的内存
* 快照覆盖前写者改过的键（实测：并发写 root 与 staleDays，root 被整份盖掉丢失）。
*/
function saveConfig(changes = {}) {
  const file = path.join(configDir(), "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireConfigLock(file);
  try {
    const { parsed, parseError } = readConfigFile();
    if (parseError) {
      throw new Error(
        `config file ${file} is corrupted (failed to parse: ${parseError}).\n` +
          `Refusing to write: saving would overwrite the broken file and lose the original content.`
      );
    }
    const disk = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    const body = {
      root: typeof disk.root === "string" ? disk.root : null,
      baseRef: typeof disk.baseRef === "string" ? disk.baseRef : DEFAULT_CONFIG.baseRef,
      branchPrefix:
        typeof disk.branchPrefix === "string" && disk.branchPrefix !== ""
          ? disk.branchPrefix
          : DEFAULT_CONFIG.branchPrefix,
      // 与读取路径（loadConfig）同口径：手编的 0 / 负数若原样保留，会在下次任意写盘时被
      // 延续下去，读路径拒绝、写路径放行形成分裂。归一为默认值而非拒绝写入：saveConfig
      // 落盘的是整份合法化快照，因个别坏值中断会把其他合法字段的修改一并挡下。
      staleDays:
        Number.isFinite(disk.staleDays) && Number(disk.staleDays) > 0
          ? Number(disk.staleDays)
          : DEFAULT_CONFIG.staleDays,
      repos: disk.repos && typeof disk.repos === "object" && !Array.isArray(disk.repos) ? { ...disk.repos } : {},
    };
    if (changes.top) {
      for (const key of REPO_OVERRIDE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(changes.top, key)) body[key] = changes.top[key];
      }
    }
    if (changes.repo) {
      const { canonical, repo, fields, remove } = changes.repo;
      const key = resolveRepoKey(body.repos, canonical, repo);
      if (remove) {
        delete body.repos[key];
      } else if (fields) {
        const current = body.repos[key] && typeof body.repos[key] === "object" ? { ...body.repos[key] } : {};
        for (const [field, value] of Object.entries(fields)) current[field] = value;
        body.repos[key] = current;
      }
    }
    // 原子写：先落临时文件再 rename 覆盖，避免写一半进程退出留下截断的 config.json。
    // 临时名带 pid + 随机后缀：固定的 config.json.tmp 会让并发写者互相截断对方的写入。
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    try {
      // Windows 上目标文件正被其他进程读取时，rename 覆盖会抛 EPERM（POSIX 不会）。
      // 有界重试即可：并发写者都是「整份覆盖」，最后一次成功写入即最终值。
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.renameSync(tmp, file);
          break;
        } catch (err) {
          if (attempt >= 5 || (err && err.code !== "EPERM" && err.code !== "EBUSY")) throw err;
          sleepMs(25 * (attempt + 1));
        }
      }
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能已被 rename 或根本没写成功 */
      }
      throw err;
    }
  } finally {
    release();
  }
  return file;
}

/* --------------------------------------------------------------------- git */

/** git 可执行文件是否在宿主 PATH 上。
 *
 *  ENOENT 有两个来源，错误码完全相同：spawn 阶段找不到 git 可执行文件，和 spawn
 *  之后 chdir 到一个不存在的 cwd（prunable 工作树的目录被手动删掉就是这种）。
 *  不先单独探测一次就无法区分——把后者误判成「git 没装」会让 prunable 工作树
 *  相关的工具整体报错。 */
let gitAvailability = null;
function ensureGitAvailable() {
  if (gitAvailability !== null) return gitAvailability;
  try {
    execFileSync("git", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: getGitTimeoutMs(),
      killSignal: "SIGKILL",
    });
    gitAvailability = true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        "git executable not found: this server launches `git` by name, so it must be on the PATH the host passes to the server.\n" +
          "Install git, or make the host's PATH include the directory that holds it.\n" +
          "Diagnostic: run `git --version` in the same shell the host launches the server from."
      );
    }
    // git 在，但 --version 本身失败（极少见）——不当成缺失，让后续真实错误浮出来
    gitAvailability = true;
  }
  return gitAvailability;
}

/** git 子进程的默认超时上限（毫秒）。
 *  一次挂住的 git（超大仓库、Windows 文件锁、网络盘）会永久阻塞整个 MCP 服务：
 *  工具实现是同步的，宿主只能看到「工具无响应」，且进行中的状态不确定。 */
const DEFAULT_GIT_TIMEOUT_MS = 30000;

let gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS;

/** 覆盖 git 超时上限（测试注入点；生产路径不调用）。 */
function setGitTimeoutMs(ms) {
  const n = Number(ms);
  gitTimeoutMs = Number.isFinite(n) && n > 0 ? n : DEFAULT_GIT_TIMEOUT_MS;
  return gitTimeoutMs;
}

function getGitTimeoutMs() {
  return gitTimeoutMs;
}

/** 子进程是不是被超时杀掉的：Node 在 kill 之后抛出的错误带 killed / signal。 */
function isTimeoutError(err) {
  return Boolean(err && (err.killed === true || err.signal === "SIGKILL" || err.signal === "SIGTERM" || err.code === "ETIMEDOUT"));
}

/** 唯一的 git 子进程出口：统一超时与错误翻译。
 *  file 与 args 分开传，是为了让测试能用「可控的慢命令」（node -e "setTimeout(...)"）验证
 *  超时行为——Windows 上没有可移植的假 git 可执行文件可造。 */
function runGitProcess(file, args, { cwd, timeoutMs = getGitTimeoutMs(), allowFail = false } = {}) {
  const started = Date.now();
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    if (allowFail) return null;
    if (isTimeoutError(err)) {
      throw new Error(
        `${file} ${args.join(" ")} timed out after ${Date.now() - started}ms in ${cwd} (limit ${timeoutMs}ms).\n` +
          `The command was killed. Check whether the repository sits on a slow or network drive, or is locked by another process, then retry.`,
      );
    }
    const detail = String((err && (err.stderr || err.message)) || err).trim();
    throw new Error(`${file} ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

function git(args, cwd, { allowFail = false, timeoutMs = getGitTimeoutMs() } = {}) {
  // 放在 try 之外：git 缺失不是「命令合法地失败了」，allowFail 不该把它吞掉。
  // 吞掉的话上层会把「git 没装」误判成「不在 git 工作树内」，排查方向完全跑偏。
  ensureGitAvailable();
  return runGitProcess("git", args, { cwd, timeoutMs, allowFail });
}

/** 仓库定位起点：显式传入 repoPath 优先；省略时用服务端进程自己的工作目录。
*
*  跨宿主差异（重要）：Agent Plugins 规范下 mcp.json 省略 cwd 时，服务端进程的工作
*  目录是「插件根」，不是 agent 会话所在的项目目录；Claude Code / ZCode 这类宿主则
*  把会话工作区继承给 MCP 进程。两者在这里取值相同纯属巧合，所以调用方必须显式传
*  repoPath——省略它时，在标准客户端里可能解析到插件自身所在的仓库，或直接报
*  「不在 git 工作树内」。 */
function repoStart(input) {
  const raw = input && String(input).trim() ? String(input).trim() : "";
  return raw ? path.resolve(raw) : process.cwd();
}

/** 服务进程的工作目录是否落在插件根内 —— 即宿主把 MCP 服务起在插件根里
*  （Agent Plugins 规范：mcp.json 的 cwd = ${PLUGIN_ROOT}）。这种情形下进程 cwd 反映的是
*  插件的安装位置，不是用户的项目目录，据此推断「用户要操作哪个仓库」不可靠。 */
function cwdInsidePluginRoot() {
  const cwd = process.cwd();
  return samePath(cwd, PLUGIN_ROOT) || isInside(cwd, PLUGIN_ROOT);
}

function repoRoot(input) {
  const raw = input && String(input).trim() ? String(input).trim() : "";
  // 省略 repoPath 且进程就起在插件根里时，进程 cwd 指向插件的安装目录，而那里往往恰好
  // 落在某个 git 仓库内（本插件所在的 marketplace 仓库就是如此）。此时
  // `git rev-parse --show-toplevel` 会解析到一个「确实存在、但完全不是用户目标」的仓库，
  // 工具随后就会在那个仓库上静默执行（实测会在插件自己的仓库里建出 worktree）。
  // 宁可硬失败，也不猜。
  if (!raw && cwdInsidePluginRoot()) {
    throw new Error(
      `repoPath is required: this server runs from the plugin root (${PLUGIN_ROOT}), ` +
        `which may itself sit inside a git repository that is not the one you mean.\n` +
        `Pass repoPath = the absolute path of the repository you want to operate on.`
    );
  }
  const start = repoStart(input);
  if (!fs.existsSync(start)) throw new Error(`path does not exist: ${start}`);
  const top = git(["rev-parse", "--show-toplevel"], start, { allowFail: true });
  if (!top || !top.trim())
    throw new Error(
      `not inside a git work tree: ${start}\n` +
        `Pass repoPath = the absolute path of the repository you mean. Leaving it out falls back to ` +
        `this server's own working directory, which in Agent Plugins clients is the plugin root, not your project.`
    );
  return path.resolve(top.trim());
}

/** 会话目录：判断「当前会话是否已在这个 worktree 内」时用。
*  优先进程 cwd：Claude Code / ZCode 等宿主把会话工作区继承给了服务端进程。进程 cwd
*  落在插件根里，说明宿主没给会话目录（Agent Plugins 规范：省略 cwd 时默认
*  cwd = 插件根），此时返回调用方显式传的 repoPath 仅作展示参考；worktree_status 会把
*  该结果标为未知，除非调用方另传 sessionCwd。 */
function sessionDir(input) {
  const cwd = process.cwd();
  const raw = input && String(input).trim() ? String(input).trim() : "";
  if (raw && cwdInsidePluginRoot()) return path.resolve(raw);
  return cwd;
}

/** 路径等值比较。Windows 与 macOS 默认文件系统大小写不敏感，Linux 敏感：
*  统一 toLowerCase 会在大小写敏感的文件系统上把两个不同的目录判成同一个——pickWorktree
*  的绝对路径匹配与去重、isMain 判定、repoKey 查找都建立在这个函数上，判错就可能作用到
*  错误的对象。反过来，在大小写不敏感的系统上用敏感比较，则只是「找不到」而非「判错」，
*  失败方向更安全。
*  因此：Windows 一律不敏感（NTFS 默认如此）；macOS 取决于卷的设置，运行时探测；
*  Linux 默认敏感。 */
function detectCaseInsensitiveFs() {
  if (process.platform === "win32") return true;
  if (process.platform !== "darwin") return false;
  // macOS：建一个临时文件，用大写名能否命中来判定当前卷是否大小写不敏感
  try {
    const probe = path.join(os.tmpdir(), `.wt-case-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    fs.writeFileSync(probe, "");
    const insensitive = fs.existsSync(probe.toUpperCase());
    try {
      fs.unlinkSync(probe);
    } catch {
      /* 探测文件已消失 */
    }
    return insensitive;
  } catch {
    return true; // 探测不了就按 macOS 默认（不敏感）处理
  }
}

const CASE_INSENSITIVE_FS = detectCaseInsensitiveFs();

/** 规范化用于比较的路径（2026-10-28 CI 修复）。
*  Windows 上同一目录存在 8.3 短名与长名两种写法：GitHub Actions 的 TEMP 是
*  `C:\Users\RUNNER~1\AppData\Local\Temp`，而 `git worktree list` 回的是长名
*  `C:\Users\runneradmin\...`。纯字符串比较会把同一目录判成两个不同目录——在 CI 上表现为
*  「refusing to remove a worktree outside the managed root（RUNNER~1 版）」与
*  「worktree not found（列出的是 runneradmin 版）」，而两者其实是同一个 worktree。
*  realpathSync.native 走句柄取真实长名（POSIX 上则解析符号链接，顺带修掉 /tmp→/private/tmp 这类）；
*  路径不存在时（prunable 工作树目录已被手动删走）退回 resolve 结果——取不到不能当错误。 */
function canonicalPath(p) {
  const resolved = path.resolve(p);
  // 归一到**最长的已存在祖先**，再把不存在的尾巴拼回去（2026-10-28 第二次修）。
  // 只对整条路径 realpath 不够：新建工作树的落点、即将写入的 .git 子目录都还不存在，
  // 取不到就退回原样，于是短名/长名照旧对不上——CI 上「.git 内 root 应被拒绝」等用例正是这样漏判。
  let head = resolved;
  const tail = [];
  for (;;) {
    try {
      // Windows 的 native realpath 会带 \\?\ 前缀，比较前剥掉
      const real = fs.realpathSync.native(head).replace(/^\\\\\?\\/, '');
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return resolved; // 到达卷根仍失败（如不存在的盘符）
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function samePath(a, b) {
  const x = canonicalPath(a);
  const y = canonicalPath(b);
  return CASE_INSENSITIVE_FS ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 主检出路径 = `git worktree list --porcelain` 的首条。git 文档保证主检出列在首位，
*  且从 link worktree 会话里运行同样先列出主检出，据此区分「真主检出」与「会话所在的
*  worktree」：会话 repoRoot 解析到 link worktree 时，旧判定（entry.path === repo）会把两者标反。
*  不能用 dirname(--git-common-dir)：submodule 的 common-dir 指向 <super>/.git/modules/<name>，
*  dirname 得到 <super>/.git/modules，与 porcelain 里的任何 entry.path 都不相等，
*  isMain 恒为假 → 删/锁/合并三道主工作树保护同时失效。
*  取 porcelain 首条还保证与 listWorktrees() 自洽：判定用的路径就是代码其余部分在操作的那一条。
*  按 repo 路径记忆化（单进程内稳定）；仓库临时读不到时不缓存，退回入参让调用方 fail-closed。 */
const MAIN_WT_CACHE = new Map();
function mainWorktreePath(repo) {
  const key = path.resolve(repo);
  const cached = MAIN_WT_CACHE.get(key);
  if (cached) {
    // 缓存命中要同时满足两个条件，否则重算：
    //  · 记下的主检出路径还在 —— 仓库被移走/删掉后旧路径已不存在；
    //  · 该 repo 路径现在仍解析到同一个真实目录 —— 仓库被移动/复制后，旧路径可能
    //    已经指向别的目录，沿用旧记录就会把操作作用到错误的工作树上。
    if (cached.main && fs.existsSync(cached.main) && cached.repoReal === canonicalPath(key)) return cached.main;
    MAIN_WT_CACHE.delete(key);
  }
  let entries = [];
  try {
    entries = listWorktrees(key);
  } catch {
    return key;
  }
  const main = entries.length > 0 ? path.resolve(entries[0].path) : key;
  MAIN_WT_CACHE.set(key, { main, repoReal: canonicalPath(key) });
  return main;
}

/** 清空主检出路径缓存（仓库被移动/复制后调用，或测试里强制重算）。 */
function clearMainWorktreeCache() {
  MAIN_WT_CACHE.clear();
}

function repoKey(config, repo) {
  return Object.keys(config.repos).find((k) => samePath(k, repo));
}

function repoOverrides(config, repo) {
  // 覆盖键按主仓库路径归一：从 link worktree 发起的会话也能命中主检出上存的覆盖
  const key = repoKey(config, mainWorktreePath(repo)) || repoKey(config, repo);
  return key ? config.repos[key] : null;
}

/** 逐键判定生效值与来源：同一个 root 可能是环境变量注入的、单仓库覆盖的或全局配置的，
 *  用户只看最终值无法判断「为什么我在设置页改的不生效」。 */
function effectiveWithSources(config, repo) {
  const o = repoOverrides(config, repo) || {};
  const env = envOverrides();
  const pick = (envKey, repoKey, globalKey, fallback) => {
    if (env[envKey] !== undefined) return { value: env[envKey], source: "env" };
    if (o[repoKey] !== undefined) return { value: o[repoKey], source: "repo" };
    if (
      config[globalKey] !== undefined &&
      config[globalKey] !== null &&
      (config.sourceKeys || []).includes(globalKey)
    ) {
      return { value: config[globalKey], source: "global" };
    }
    return { value: fallback, source: "default" };
  };
  return {
    root: pick("root", "root", "root", null),
    baseRef: pick("baseRef", "baseRef", "baseRef", DEFAULT_CONFIG.baseRef),
    branchPrefix: pick("branchPrefix", "branchPrefix", "branchPrefix", DEFAULT_CONFIG.branchPrefix),
    staleDays: pick("staleDays", "staleDays", "staleDays", DEFAULT_CONFIG.staleDays),
  };
}

function effective(config, repo) {
  const s = effectiveWithSources(config, repo);
  return {
    root: s.root.value,
    baseRef: s.baseRef.value,
    branchPrefix: s.branchPrefix.value,
    staleDays: s.staleDays.value,
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
  // 两侧都先归一（2026-10-28）：repo 来自 git（长名），ignoredDir 来自配置（CI 上是 RUNNER~1 短名），
  // 直接 path.relative 会算出跨盘的相对路径 → 条目不写、主检出 status 变脏，而实际在同一棵树下。
  const rel = path.relative(canonicalPath(repo), canonicalPath(ignoredDir));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // 控制字符不得进 exclude 行（2026-10-28 市场审查）：entry 由**配置来的**路径派生，
  // 路径里带换行会把一行拆成两条规则——等于往 .git/info/exclude 注入任意 ignore 项，
  // 静默隐藏本该可见的未跟踪文件。合法路径不需要控制字符，直接放弃写入：
  // 没有本地忽略只是 git status 多一行，比注入安全。
  if (/[\u0000-\u001f\u007f]/.test(rel)) return null;
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
  // 无 origin/HEAD 时不能回退「当前检出分支」：那是会话所在分支，不是仓库默认分支，
  // 会让 auto 的落后判定永远为 0。依次试本地 main / master，最后才用 symbolic-ref HEAD。
  for (const name of ["main", "master"]) {
    if ((git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repo, { allowFail: true }) || "").trim()) {
      return name;
    }
  }
  const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo, { allowFail: true });
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

/** 显式传入的字符串参数：undefined/null 表示「未传」，空串表示调用方传了空值——必须报错，
 *  不能静默等同未传（否则 baseRef:"" 会悄悄走 auto，用户以为指定了基线）。 */
function assertNonEmptyArg(value, label) {
  const s = String(value);
  if (!s.trim()) throw new Error(`invalid ${label}: pass a non-empty value, or omit the field entirely.`);
  return s;
}

function resolveBase(config, repo, explicit) {
  if (explicit !== undefined && explicit !== null) return { ref: assertSafeRef(assertNonEmptyArg(explicit, "baseRef"), "baseRef"), auto: "explicit" };
  const e = effective(config, repo);
  // 配置文件 / 环境变量里的 baseRef 同样直入 argv，出口统一校验
  if (e.baseRef && e.baseRef !== "auto") return { ref: assertSafeRef(e.baseRef, "baseRef"), auto: "configured" };
  // auto：先跟随会话仓库当前检出的分支（在创建那一刻求值），detached / 解析不出分支时
  // 才回退仓库默认分支。与 resolveTarget 的默认顺序一致，只是回退值不同。
  const cur = currentBranch(repo);
  return { ref: cur || defaultBranch(repo) || "HEAD", auto: !cur ? "fallback" : "follow" };
}

/** auto 基线的落后量：会话当前分支不是默认分支、且落后默认分支时，新 worktree 会缺
 *  默认分支上的提交（git worktree add 只检出 baseRef 的树）。返回 null 表示无需提示。
 *  只在 auto 下调用；显式 baseRef 是用户的明确选择，不打扰。 */
function autoBaseLag(repo, baseRef) {
  const d = defaultBranch(repo);
  if (!d || d === baseRef) return null;
  const behind = counts(repo, baseRef, d).ahead;
  return behind && behind > 0 ? { defaultBranch: d, behind } : null;
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
  // "." / ".." 是路径原语：拼进受管根就是「上一层目录」。在源头拒绝，不靠下游兜底
  //（目标目录非空、git 拒绝非法分支名）——下游兜底会随实现调整而失效。
  if (s === "." || s === "..") return createHash("sha1").update(String(value).trim()).digest("hex").slice(0, 8);
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
// 每一级都取「全部候选」而非第一个命中：remove/lock 是破坏性操作，
// 多个 worktree 同时匹配时必须让调用方给出精确路径，而不是由遍历顺序决定删谁。
const unique = (list) => {
const seen = new Map();
for (const e of list) seen.set(path.resolve(e.path), e);
return [...seen.values()];
};
// 分级匹配：按精确度从高到低，只对「第一个有候选的层级」判歧义。
// 旧实现把五级写成一个数组字面量，元素在数组构造时就被全部求值——任何一层出现
// 多个候选就立刻抛 ambiguous，哪怕更精确的上一层已经唯一命中。实测：仓库里同时有
// `feat/login` 与 `feat-login` 时，按精确分支名 `feat/login` 查询本该唯一命中，
// 却被 slug 层的歧义误伤成 ambiguous。
const tiers = [
["absolute path", (e) => samePath(e.path, needle)],
["branch name", (e) => e.branch === needle],
// "dirty-one" should find branch "wt/dirty-one" when the slug only differs by the prefix.
["branch slug", (e) => e.branch && slug(e.branch) === slug(needle)],
["branch slug suffix", (e) => e.branch && slug(e.branch).endsWith(`-${slug(needle)}`)],
["directory name", (e) => path.basename(e.path).toLowerCase() === lower],
];
for (const [how, match] of tiers) {
const found = unique(entries.filter(match));
if (found.length === 0) continue;
if (found.length > 1) {
throw new Error(`ambiguous worktree name \`${needle}\` (matched by ${how}):\n${found.map((e) => ` - ${e.branch || "(detached)"} → ${e.path}`).join("\n")}\nPass the absolute path instead.`);
}
return found[0];
}
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
  // 退出码 1 = 不是祖先（正常结果），非 0 的其他失败（ref 不存在等）同样按「不是祖先」处理，
  // 与旧实现一致；超时会杀掉子进程而不是挂住整个服务。
  return runGitProcess("git", ["merge-base", "--is-ancestor", branch, target], { cwd: repo, allowFail: true }) !== null;
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

/** 目录大小。budgetMs 是本次调用的时间预算；超时返回 { bytes, files, timedOut: true }，
*  与「真的是 0 字节」区分开——旧实现超时返回 null，audit 汇总时用 `|| 0` 累加，
*  超时的目录被当成 0 字节计入「可回收空间」，静默低估。
*  预算按「一次工具调用的总量」共享：describe() 逐个工作树调用本函数，旧实现每个
*  目录各拿 5s，N 个工作树最坏 N×5s 把整个 MCP 服务堵死。传 deadline 就能让所有
*  目录共用同一份预算。 */
function dirSize(dir, deadline) {
  const limit = typeof deadline === "number" ? deadline : Date.now() + 5000;
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > limit) return { bytes, files, timedOut: true };
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
  return { bytes, files, timedOut: false };
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

/** 目录是否仍是一个可用的 git 工作树目录。
 *  旧实现逐个工作树跑 `git log -1`（cwd = 工作树目录）：目录被移走（prunable）或
 *  已不是工作树时命令跑不起来 → lastCommit 为 null。批量取提交信息时必须保住这个语义，
 *  不能凭空给出一个提交。裸仓库的 git 目录里没有 .git，但有 HEAD，故两者都认。 */
function isWorktreeDir(dir) {
  try {
    return fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "HEAD"));
  } catch {
    return false;
  }
}

/** 一次 git log 取多个工作树 HEAD 的提交信息。
 *  `git log --no-walk=unsorted --format=... <sha>...` 一次输出多个提交，
 *  省掉「每个工作树各起一个 git 进程」的固定开销（N 个工作树省 N-1 次 spawn）。 */
function lastCommits(repo, entries) {
  const out = new Map();
  const wanted = entries.filter((e) => e && e.head && isWorktreeDir(e.path));
  if (!wanted.length) return out;
  const shas = [...new Set(wanted.map((e) => e.head))];
  const raw = git(["log", "--no-walk=unsorted", "--format=%H%x09%h%x09%an%x09%cI%x09%s", ...shas], repo, {
    allowFail: true,
  });
  if (raw === null) {
    // 批量调用失败（sha 不可解析等）→ 退回逐个取，语义与旧实现一致
    for (const e of wanted) {
      const c = lastCommit(e.path);
      if (c) out.set(e.head, c);
    }
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [full, short, author, date, ...rest] = line.split("\t");
    if (!full) continue;
    const ts = Date.parse(date || "");
    out.set(full, {
      sha: short,
      author,
      date,
      subject: rest.join("\t"),
      ageDays: Number.isFinite(ts) ? Math.floor((Date.now() - ts) / DAY_MS) : null,
    });
  }
  return out;
}

function describeEntry(repo, entry, target, { includeSize = false, sizeDeadline = null, commit = null } = {}) {
  const dir = entry.path;
  const isMain = samePath(path.resolve(dir), mainWorktreePath(repo));
  const status = statusOf(dir);
  // branch 恒为「真实分支名」：detached 工作树没有分支，值为 null。
  // 展示用的合成名（detached@<sha>）单独放在 label 里。下游的判定——是否已合并、
  // 能不能删分支、合并该用哪个 ref——一律看 branch，避免把展示串当 ref 传给 git：
  // 旧实现让 branch 直接返回 "detached@<sha>"，于是 merge_back 拿它去 `git merge`、
  // 拿它去 `git branch -d`、拿它当分支名写进交接简报，三处全错。
  const branch = entry.branch || null;
  const label = branch || (entry.detached ? `detached@${(entry.head || "").slice(0, 7)}` : "(detached)");
  // 与 target 比较用的 rev 必须是真的可解析 rev：detached 工作树没有分支名，但 entry.head
  // 是完整 sha。旧代码把展示用合成串 "detached@<sha>" 当 rev 传给 rev-list，必然 fatal
  // （unknown revision）→ ahead/behind/merged 全变未知，删除护栏被静默绕过。
  const rev = entry.branch || entry.head || null;
  const counter = rev && !isMain ? counts(repo, target, rev) : { ahead: null, behind: null };
  // mergedIntoTarget 与 ahead === 0 等价：rev-list --left-right --count 的右半边就是
  // 「rev 有而 target 没有」的提交数，为 0 即 rev 的历史全在 target 上（rev 是 target 的祖先）。
  // 据此省掉每个工作树一次 git merge-base 进程；counts 本身失败时退回 merge-base 判定，
  // 语义与旧实现完全一致。
  const merged = rev && !isMain ? (counter.ahead === null ? isAncestor(repo, rev, target) : counter.ahead === 0) : null;
  const age = commit && commit.ageDays !== null ? commit.ageDays : dirAgeDays(dir);
  const size = includeSize ? dirSize(dir, sizeDeadline) : null;
  return {
    repo,
    path: dir,
    branch,
    label,
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
    sizeBytes: size ? size.bytes : null,
    // 超时的目录只统计了一部分：可回收空间要单独提示，不能当成完整数字
    sizeTimedOut: size ? size.timedOut : false,
    lastCommit: commit,
  };
}

/** 批量描述若干工作树。提交信息一次 git log 取回（见 lastCommits），
 *  其余字段逐个工作树取，字段与语义与逐个 describe() 完全一致。 */
function describeMany(repo, entries, target, { includeSize = false, sizeDeadline = null } = {}) {
  const commits = lastCommits(repo, entries);
  return entries.map((entry) =>
    describeEntry(repo, entry, target, {
      includeSize,
      sizeDeadline,
      commit: commits.get(entry.head) || null,
    }),
  );
}

function describe(repo, entry, target, opts = {}) {
  return describeMany(repo, [entry], target, opts)[0];
}

function dirAgeDays(dir) {
  try {
    const mtime = fs.statSync(dir).mtimeMs;
    return Math.floor((Date.now() - mtime) / DAY_MS);
  } catch {
    return null;
  }
}

/** 清理分桶。分桶必须与 worktree_remove 的实际护栏一致，否则 audit 会把
*  「remove 一定拒绝」的工作树报成 safe，用户照着做必然撞墙。
*  受管根外的工作树 remove 永远拒绝（force 也不放宽），因此不能进 safe 桶——
*  旧实现不看受管根，audit 报 "safe to remove: 1"，remove 却回 "outside the
*  managed root"。 */
function bucketOf(info, staleDays, managedPath = null) {
  if (info.locked) return { bucket: "hold", reason: "worktree is locked" };
  if (info.isMain) return { bucket: "hold", reason: "primary worktree" };
  if (info.clean === false) return { bucket: "hold", reason: `${info.dirtyCount} uncommitted change(s)` };
  if (info.prunable) return { bucket: "hold", reason: `prunable: ${info.prunable}` };
  // 与 worktree_remove 同口径（prunable 例外已在上方先出）：git status 取不到时不得进 safe，
  // 否则 audit 报「safe to remove」而 remove 拒绝，用户照着做必然撞墙。
  if (info.clean === null || info.clean === undefined) return { bucket: "review", reason: "git status unavailable — cleanliness unproven, remove refuses without force" };
  if (info.ahead && info.ahead > 0) return { bucket: "hold", reason: `${info.ahead} commit(s) not merged into target` };
  if (managedPath && !isInside(info.path, path.resolve(managedPath))) {
    return { bucket: "review", reason: "outside the managed root — this plugin will not remove it" };
  }
  if (info.mergedIntoTarget) return { bucket: "safe", reason: "clean and already merged into target" };
  if (info.ageDays !== null && info.ageDays >= staleDays) {
    return { bucket: "review", reason: `clean, not merged, idle ${info.ageDays}d` };
  }
  return { bucket: "review", reason: "clean, merge state unknown" };
}

function configSummary(config, repo) {
  const e = effectiveWithSources(config, repo);
  // root 为空时仍标出来源：repo 级显式 null 与「压根没配」是两回事，用户要能分辨
  const rootSource = e.root.source === "repo" && e.root.value === null ? "repo (explicitly unset)" : e.root.source;
  return [
    `root: ${managedRoot(config, repo) ?? "(unset)"} (${rootSource})`,
    `baseRef: ${e.baseRef.value} (${e.baseRef.source})`,
    `branchPrefix: ${e.branchPrefix.value} (${e.branchPrefix.source})`,
    `staleDays: ${e.staleDays.value} (${e.staleDays.source})`,
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


// 路径包含判定：core 内部（cwdInsidePluginRoot / bucketOf）也用，放这里避免与 tools 循环依赖。
// 大小写口径与 samePath 对齐：path.relative 在 POSIX 上大小写敏感，macOS 大小写不敏感卷上
// 会出现「配置键匹配（samePath）而包含判定失败（isInside）」的分裂——受管根内的工作树被
// 误报成 outside the managed root。Windows 的 relative 实现内部已小写化，这里统一归一无害。
const isInside = (dir, root) => {
  // canonicalPath 与 samePath 同一口径：8.3 短名与长名必须先归一，否则受管根判定会把
  // 同一目录判成「在外」（CI 的 RUNNER~1 场景）。
  const norm = (p) => (CASE_INSENSITIVE_FS ? canonicalPath(p).toLowerCase() : canonicalPath(p));
  const rel = path.relative(norm(root), norm(dir));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

export {
  DAY_MS,
  SKIP_DIRS,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_CONFIG,
  configDir,
  envOverrides,
  readConfigFile,
  REPO_OVERRIDE_FIELDS,
  normalizeRepoOverride,
  loadConfig,
  CONFIG_LOCK_STALE_MS,
  sleepMs,
  acquireConfigLock,
  resolveRepoKey,
  saveConfig,
  DEFAULT_GIT_TIMEOUT_MS,
  setGitTimeoutMs,
  getGitTimeoutMs,
  isTimeoutError,
  runGitProcess,
  git,
  repoStart,
  cwdInsidePluginRoot,
  repoRoot,
  sessionDir,
  detectCaseInsensitiveFs,
  CASE_INSENSITIVE_FS,
  samePath,
  MAIN_WT_CACHE,
  mainWorktreePath,
  clearMainWorktreeCache,
  repoKey,
  repoOverrides,
  effectiveWithSources,
  effective,
  managedRoot,
  ensureInsideRepoIgnore,
  defaultBranch,
  currentBranch,
  assertSafeRef,
  assertNonEmptyArg,
  resolveBase,
  autoBaseLag,
  resolveTarget,
  classifyAddFailure,
  slug,
  listWorktrees,
  pickWorktree,
  statusOf,
  counts,
  isAncestor,
  lastCommit,
  isWorktreeDir,
  lastCommits,
  dirSize,
  human,
  describe,
  describeMany,
  dirAgeDays,
  bucketOf,
  configSummary,
  table,
  isInside,
};
