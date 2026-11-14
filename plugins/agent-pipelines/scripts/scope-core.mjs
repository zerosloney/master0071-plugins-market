// scope-core.mjs — scope 判定的单源内核：glob 引擎、仓库根相对模式、git 变更清单收集与越界判定。
//
// 背景：这四块此前在 scope.mjs（CLI 原件）与 state.mjs 的 recheckScope（gate 复算体）各内联一份，
// 「口径同宽」只能靠 test/regression 的对照用例事后锁——而且锁不住改一处忘另一处：两份实现
// 历史上各出过真 bug 且不是同一天修齐的——
//   · 2026-11-01，复算体内联 glob 把 `**` 判定写成与两字符常量比较（恒假），退化成单段匹配，
//     `src/**` 匹配不到 `src/auth/login.js`，改动触及 ≥2 层路径的仓库 DONE 永不可达；同一缺陷
//     scope.mjs 原件没有（修 bug 时两份代码已经分叉的实证）。
//   · 2026-11-01，复算体列清单仍在调用目录执行，仓库其它目录的越界改动整个消失；scope.mjs
//     修过同一个缺陷并留了注释，复算体当时没跟上。
// 现在两个消费方（scope.mjs CLI、state.mjs 复算）都从这里取同一份实现，结构上同宽。
// CLI 专属的增量（参数解析、--apply 写回、警告打印、fail 退出码）留在调用方。
//
// git runner 一律注入而非本模块直接调 git：scope.mjs 的 runner 失败即 fail（退出码 2），
// state.mjs 复算的 runner 失败返回 null（转成「复算不可得」）——两种错误纪律不进内核。
import path from "node:path";

// 把 scope glob 编译成正则。语法：`*` 单段、`**` 跨段、`?` 单字符；不支持 brace 展开与
// 字符类——`*.{js,ts}` 不匹配，多后缀逐条列出（文档化行为）。尾部 `/` 视为该目录整体。
//
// `**` 的两条判读史（两份内联实现各踩过一次，迁到单源后不会再分叉）：
//   · 单字符比较才算 `**`（2026-11-01，复算体）：写成与 "**" 比较时 p[i+1] 是长度 1 的子串，
//     恒不相等，`**` 分支不进入、退化成 `*`（单段），`src/**` 匹配不到 `src/auth/login.js`，
//     而 README:61 与 SKILL:122 都写明 `**` = 跨段。后果不是放行而是反向：自家
//     .loop-cli/state/ 两层深的状态文件被判 outside scope，任何改动触及 ≥2 层路径的仓库
//     DONE 永不可达、且 reason 把排查方向带偏。
//   · 两侧紧邻 `/` 的 `/**/` 按 gitignore 语义允许零层（2026-11-07）：docs/**/secret.env 要
//     同时命中 docs/secret.env 与 docs/a/b/secret.env（旧实现一律 `.*` → 零层漏判，forbidden
//     方向 fail-open）。裸 **、前导 **/（文档化行为，警告保留）、尾部 /** 的语义不变。
function globToRegExp(glob) {
  let pattern = glob.replace(/\\/g, "/").trim();
  if (pattern.endsWith("/")) pattern += "**";
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i - 1] === "/" && pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
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

/**
 * 文件路径是否命中任一模式。
 * @param {string} file - 仓库根相对路径
 * @param {string[]} patterns - scope 模式清单
 * @returns {boolean}
 */
function matchAny(file, patterns) {
  return patterns.some((pattern) => compiled(pattern).test(file));
}

/**
 * scope 规则按仓库根相对路径解释。绝对路径先转成仓库根相对路径；越出仓库根的规则直接报错——
 * 它永远匹配不到任何变更文件，静默留着就是 fail-open（越界改动会被判成合规）。
 * 非法规则以 throw 报错：scope.mjs 接住后按参数错误 fail（退出码 2）；文案与单源前逐字一致。
 *
 * @param {string} pattern - scope 模式（相对或绝对路径）
 * @param {string} root - git 仓库根（判定的唯一路径基准）
 * @returns {string} 仓库根相对路径的模式
 * @throws {Error} `..` 段逃出仓库根、或绝对路径落在仓库根之外
 */
// 面板评审 C-013（2026-11-14）：盘符相对模式（C:foo/**）——isAbsolute 判 false、无 .. 段，
// 原样放行后 glob 对仓库相对清单永不匹配（静默 fail-open）。在此按非法拒绝（与 recheckScope
// 经本函数单源同判，双写已消）。
export function rootRelativePattern(pattern, root) {
  if (/^[A-Za-z]:[^\\/]/.test(String(pattern))) {
    throw new Error(`scope pattern must be repo-root-relative (drive-relative form rejected): ${pattern}`);
  }
  const normalized = pattern.replace(/\\/g, "/");
  if (!path.isAbsolute(pattern)) {
    if (normalized.split("/").includes("..")) {
      throw new Error(`scope pattern "${pattern}" escapes the repository root; scope rules are repository-root relative`);
    }
    return normalized;
  }
  const rel = path.relative(root, path.resolve(pattern)).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`scope pattern "${pattern}" is outside the repository root`);
  }
  return rel;
}

/**
 * 收集变更清单：已跟踪改动（`git diff --name-only <base>`）+ 未跟踪文件 + gitignored 文件，
 * 命中 exclude 的条目剔除，返回仓库根相对路径的 Set。
 *
 * 三条列清单的 git 命令由 runner 执行——runner 必须在**仓库根**执行命令，输出才与 scope 规则
 * 同基准（仓库根相对路径）。2026-11-01 修复：复算体此前只在 cwd 跑一条 rev-parse 判断
 * 「在不在 git 里」，取到的根没用上，列清单仍按调用目录执行——`git ls-files --others` 只列
 * 该目录以下的未跟踪/ignored 文件，仓库其它目录的越界改动整个消失（实测：同一状态同一
 * --file，仓库根跑判 FAIL/ESCALATE，子目录跑判 DONE，forbidden 目录下未跟踪的泄漏文件对
 * 门禁不可见）。scope.mjs 修过同一个缺陷并留了注释，复算体当时没跟上。`git diff
 * --name-only` 本就输出仓库根相对路径，改到根上执行不改变其结果，只让三条命令同基准。
 *
 * @param {(args: string[]) => string|null} git - git runner（注入保持可测性）：执行给定命令并
 *   返回 stdout（已 trim）；返回 null 表示该命令失败。diff 失败时本函数抛错（见下），
 *   其余两条失败按空清单处理（与两个消费方的既有取舍一致）。
 * @param {string[]} exclude - 仓库根相对路径的排除 glob 清单
 * @param {string} base - diff 基线 rev（调用方已做注入面校验）
 * @param {boolean} includeUntracked - false 时只算已跟踪改动（scope.mjs 的 --no-untracked）
 * @returns {Set<string>} 变更文件集合（仓库根相对路径）
 * @throws {Error} `git diff --name-only <base>` 失败（runner 返回 null）：scope.mjs 的 runner
 *   失败即 fail、到不了这里；state.mjs 复算接住后返回「复算不可得」。
 */
export function collectChangedFiles(git, exclude, base, includeUntracked = true) {
  const changed = new Set();
  const addChanged = (line) => {
    const file = line.trim().replace(/\\/g, "/");
    if (file && !matchAny(file, exclude)) changed.add(file);
  };
  const diffed = git(["diff", "--name-only", base]);
  if (diffed === null || diffed === undefined) {
    throw new Error(`unable to list changed files against base ${base}`);
  }
  for (const line of diffed.split("\n")) addChanged(line);
  if (includeUntracked) {
    for (const line of (git(["ls-files", "--others", "--exclude-standard"]) || "").split("\n")) addChanged(line);
    // gitignored 的改动必须一并纳入（2026-10-29 修复）：`--exclude-standard` 按定义跳过被
    // .gitignore 的路径，而构建产物、生成代码、本地配置恰好都在那里。实测：.gitignore=dist/、
    // 只改 dist/built.js、--forbidden "dist/**" → 判 **PASS**，而 dist 正是最典型的 forbidden 目标。
    //
    // `git ls-files --others --ignored --exclude-standard` 默认**逐文件展开**被忽略的目录
    // （实测：`dist/` 忽略时输出 `dist/a.js`、`dist/nested/c.js`；只有额外加 `--directory`
    // 才会折叠成一行 `dist/`）。这里要的是可匹配的文件路径，所以保持默认行为、不加该开关，
    // 仅剥掉目录条目可能带的尾部 `/` 作防御。
    // 已知边界：只覆盖**未跟踪**的 ignored 项。已跟踪文件后来被加进 .gitignore 的情况仍会被
    // `git diff --name-only <base>` 列出（它本来就跟踪），不会漏。
    for (const line of (git(["ls-files", "--others", "--ignored", "--exclude-standard"]) || "").split("\n")) {
      const entry = line.trim().replace(/\\/g, "/").replace(/\/$/, "");
      if (entry && !matchAny(entry, exclude)) changed.add(entry);
    }
  }
  return changed;
}

/**
 * 越界判定主函数：输入排序后的变更文件与三类规则，输出各类命中与 PASS/FAIL 结论。
 * 判 FAIL 的只有 forbidden 命中与 outside（不落在任何规则内的文件）；hard/soft 命中只进
 * 报告（scope.mjs 的 stdout 分组打印），不影响结论。
 *
 * @param {string[]} files - 变更文件清单（建议 `[...changed].sort()`，保证输出稳定可比对）
 * @param {{hard: string[], soft: string[], forbidden: string[]}} rules - 三类 scope 规则
 * @returns {{hardHits: string[], softHits: string[], forbiddenHits: string[], outside: string[], verdict: "PASS"|"FAIL"}}
 */
export function scopeVerdict(files, rules) {
  const { hard, soft, forbidden } = rules;
  const hardHits = files.filter((file) => matchAny(file, hard));
  const softHits = files.filter((file) => matchAny(file, soft));
  const forbiddenHits = files.filter((file) => matchAny(file, forbidden));
  const outside = files.filter(
    (file) => !matchAny(file, hard) && !matchAny(file, soft) && !matchAny(file, forbidden),
  );
  const verdict = forbiddenHits.length > 0 || outside.length > 0 ? "FAIL" : "PASS";
  return { hardHits, softHits, forbiddenHits, outside, verdict };
}
