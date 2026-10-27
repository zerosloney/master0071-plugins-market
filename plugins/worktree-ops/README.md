# worktree-ops

Git worktree 操作台：**在仓库之外的可配置目录**里创建、查看、审计、合并回主干与安全清理 worktree，附带把工作交接到新会话的完整指引。

解决的问题很简单：多数 agent 宿主在会话启动时就固定了工作目录，子 agent 继承这个目录，所以"开一个隔离的分支工作区"要么被写死在某个路径（`isolation: "worktree"`），要么根本做不到。这个插件接管 worktree 的生命周期，把**建在哪**变成配置项，并把"换目录开工"变成一段可以直接粘贴的交底文本。

宿主中立：不绑定任何一家客户端的目录约定、hook 或斜杠命令，只用标准 MCP stdio server + 标准 skill。

## 前置条件

| 依赖 | 要求 | 说明 |
|------|------|------|
| Node.js | ≥ 18，且 `node` 在**宿主启动 MCP 服务时使用的 PATH** 里 | `mcp.json` 的 `command` 是裸名 `node`（Agent Plugins 规范允许），解释器由宿主按平台搜索规则解析。宿主若用受限环境启动子进程、PATH 里没有 node，服务会起不来——这是宿主侧的事，插件无法兜底 |
| git | 任意近期版本，命令名 `git` 在同一 PATH 里 | 服务端所有工具都通过 `git` 命令操作仓库，git 不在 PATH 时工具会返回一条指明缺什么、怎么查的报错 |
| 根目录 | 无默认值，必须显式配置 | 见下文「目录策略」 |

一条命令自检环境：

```bash
node --version && git --version
```

版本过低时服务启动即报可读错误（而不是在半路抛出难懂的异常）；`git` 缺失时工具返回的错误里会直接写明"git 不在 PATH"及排查方式。

## 可移植组件

| 组件 | 路径 |
|------|------|
| MCP server（10 个工具） | `mcp/server.mjs`（装配入口）+ `mcp/core.mjs` / `mcp/tools.mjs` / `mcp/protocol.mjs`，`mcp.json` 里注册为 `worktree` |
| Skill | `skills/worktree-manager/` |

工具清单：

| 工具 | 作用 |
|------|------|
| `worktree_create` | 在配置根目录下从基线新建分支，或检出既有分支（如 PR 分支）做验证，产出绝对路径 + 新会话交底。既有分支按原名检出（`develop` 这类无斜杠分支同样支持）；短任务名不含 ASCII 字母数字时用稳定哈希后缀，并在返回里提示 |
| `worktree_list` | 列出全部 worktree：分支、HEAD、是否干净、领先/落后、是否已合并、闲置天数 |
| `worktree_status` | 单个 worktree 的完整详情，含脏文件、最后提交、当前会话是否已在其中（标准客户端下传 `sessionCwd` 可确认） |
| `worktree_audit` | 清理前分桶审计：`safe` / `review` / `hold` + 原因 + 可回收空间，**只读不删** |
| `worktree_remove` | 删除 worktree（可选删分支），脏/未合并拒绝（可显式 `force`）；受管目录外一律拒绝，`force` 也不放宽 |
| `worktree_lock` | 锁定 worktree（`git worktree lock`，可记原因）：`worktree_remove` 拒绝碰锁定的工作树；`worktree_merge_back` 仅在带 `remove: true` 时拒绝 |
| `worktree_unlock` | 解锁，恢复 remove / merge_back |
| `worktree_merge_back` | 默认只出计划；`rebase` / `merge` / `remove` 开启后执行，遇冲突停下交还 |
| `worktree_config` | 读写全部 worktree 配置（`root` / `baseRef` / `branchPrefix` / `staleDays`），`scope: global` 或单仓库覆盖。`scope: "global"` 下 `repoPath` 可选，仅用于回执附上该仓库的生效值（传了就必须是 git 仓库，路径无效整次调用报错） |
| `worktree_handoff` | 生成可粘贴的交接简报（路径、分支、基线、任务、约束） |

> **调用模型**：工具调用在服务端是**串行执行**的（同步实现，无请求队列与取消机制）——一次长调用期间，后续请求（含 `ping`）会排队等待。最坏情况是 `worktree_audit` 带 `includeSize: true`：目录体积统计共享 20 秒预算，整次调用最坏约 20 秒。宿主的工具超时预算偏紧或需要并发复用服务时，建议大仓库先跑不带 `includeSize` 的审计，或等异步化改造。

## 仓库定位：`repoPath` 必须显式传

所有工具都接受 `repoPath`（要操作的仓库的绝对路径），**每次调用都显式传**。

省略它时会回退到 MCP 服务端进程自己的工作目录，而这个目录**不一定是你的会话目录**：Claude Code 一类宿主把会话工作区交给服务端进程，Agent Plugins 规范下的客户端则把它启动在插件根目录（`mcp.json` 省略 `cwd` 时默认如此）。

**服务端进程就起在插件根内时，省略 `repoPath` 会直接报错**（`repoPath is required`）。原因是插件根往往恰好位于某个 git 仓库内（本插件所在的 marketplace 仓库就是），回退到进程工作目录会解析到一个"确实存在、但完全不是你的目标"的仓库，工具就会在它上面静默执行。

`worktree-manager` skill 因此要求每次调用都带上 `repoPath`；`worktree_status` 判断"当前会话是否已在该 worktree 内"在标准客户端下会报 `unknown`（宿主没把会话目录交给服务端，无法判断），只有继承了会话工作区的宿主才能给出 yes / no。需要确认时，给 `worktree_status` 传 `sessionCwd`（会话的绝对工作目录），它优先于服务进程 cwd。

## 目录策略

根目录**没有内置默认值**：未配置时 `worktree_create` 直接拒绝并提示三种配置方式。推荐先设一处仓库外的集中目录（如 `E:\Demo\worktrees`）。根目录**也可以设在仓库工作树内**：`worktree_create` 会先把该目录幂等写入 `.git/info/exclude`（本地忽略，不改动仓库里被跟踪的 `.gitignore`），主检出 `git status` 同样保持干净；只有 `.git` 目录内部是例外，一律拒绝。

配置优先级（高 → 低）：

1. 环境变量 `WORKTREE_ROOT` / `WORKTREE_BASE_REF` / `WORKTREE_BRANCH_PREFIX` / `WORKTREE_STALE_DAYS`（`WORKTREE_ROOT` 必须是绝对路径；相对路径会被忽略并回退配置文件，避免按宿主 cwd 解析到插件目录）
2. 配置文件里的单仓库覆盖（`worktree_config` 的 `scope: "repo"`）
3. 配置文件里的全局值（`scope: "global"`）
4. 内置默认：`baseRef=auto`（跟随会话仓库当前检出分支，detached 时回退仓库默认分支）、`branchPrefix=wt/`、`staleDays=14`——注意 `root` 没有默认值，必须显式配置为绝对路径。环境变量、全局设置、单仓库覆盖三条路径都一样：相对路径会在写入时被拒绝，读取配置文件时会被忽略并回报 issue，避免按宿主 cwd 解析到插件目录。

每个工具输出里的 `Config:` 行会在值后面标出来源（`env` / `repo` / `global` / `default`），用来解释"设置页里改的为什么没生效"。

`auto` 基线跟随会话当前分支，所以当该分支落后于仓库默认分支时，新 worktree 会缺少默认分支上的提交——`worktree_create` 会输出 `base lag:` 提示，并给出改用 `baseRef: "<默认分支>"` 的建议；显式传 `baseRef` 时不提示。

`worktree_config` 里 `root` / `baseRef` / `branchPrefix` 传 `null` 表示清空并回退默认；传空字符串属于无效输入，直接报错，不会被静默当作"未传"。

`scope: "repo"` 时，`root` 传 `null` 的含义是"**这个仓库不用 worktree 根目录**"——它覆盖全局值而不是回退到全局值，该仓库的 `worktree_create` 会直接拒绝。

配置文件位置：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\worktree-ops\config.json` |
| macOS / Linux | `$XDG_CONFIG_HOME/worktree-ops/config.json`（默认 `~/.config`） |

用 `WORKTREE_CONFIG_HOME` 可以整体改掉这个目录。支持设置页的宿主（ZCode）会把设置项映射成上面那组环境变量，用户在界面里填的值优先级最高。

## 版本变更

**0.4.0（含破坏性变更）**

- **`worktree_set_root` 改名为 `worktree_config`**（破坏性）。这个名字一直只说"根目录"，实际却同时管着 `root` / `baseRef` / `branchPrefix` / `staleDays` 和 `scope` / `action`，`staleDays` 藏在 "set_root" 里是纯粹的误导。改名后职责与名字对齐。工具数量不变，仍是 10 个。
- **服务端源码按职责拆成三层**：`mcp/core.mjs`（配置层、git 封装、路径与 worktree 检查）、`mcp/tools.mjs`（10 个工具的定义、描述、schema 与处理函数）、`mcp/protocol.mjs`（JSON-RPC 收发与 stdio 循环），`mcp/server.mjs` 只做装配与入口。拆分前是 1300 行的单文件，职责边界只能靠注释维持。
- **省略 `repoPath` 时不再可能操作到错误的仓库**。服务端进程起在插件根内（Agent Plugins 客户端的默认形态）时，省略 `repoPath` 现在直接报 `repoPath is required`。此前会回退到进程工作目录，而插件根往往恰好位于某个 git 仓库内（本插件所在的 marketplace 仓库就是），实测会在那个仓库里真的建出 worktree。
- **配置文件并发写不再丢字段**。旧实现把内存里的整份配置覆盖写回磁盘，两个进程各改一个键时后写者会盖掉前写者（实测 `root` 被整份盖掉丢失）。现在取文件锁 + 重读磁盘最新值 + 只合并本次改动的字段。
- **`worktree_create` 支持无斜杠的既有分支按原名检出**。此前只有含 `/` 的名字会被识别为分支名，`develop`、`main` 这类既有分支会被当成短任务名新建出 `wt/develop`。
- **detached 工作树的 merge / remove / handoff 不再拿展示名当分支用**。此前 `detached@<sha>` 这个展示串会被传给 `git merge`（报 "not something we can merge"）、被当成 ref 做合并判定（已合并的也删不掉）、被写进交接简报让下一个 agent 去 rebase 一个不存在的分支。现在展示名与真实分支分离，detached 时给出"先建分支"的明确指引。
- **按精确分支名查询不再被下层 slug 歧义误伤**。`pickWorktree` 的分级匹配改为只对"第一个有候选的层级"判歧义；此前五级在构造数组时就被全部求值，任何一层多候选都会抛 `ambiguous`，哪怕更精确的层级已唯一命中。
- **`scope: "repo"` 时 `root: null` 真正表示"本仓库不用全局根目录"**。此前 `null` 被当作"没设置"而回退到全局值，这个意图无法表达。
- **`worktree_audit` 的分桶与 `worktree_remove` 的护栏口径一致**。受管根之外的工作树不再被判为 `safe`（`worktree_remove` 对它永远拒绝，force 也不放宽），照着 audit 的指示调用 remove 不会撞墙。
- **未知参数直接报错**，不再静默忽略。`forse` 这类拼错的字段名会让调用方误以为 `force` 已生效。
- 全部工具的 `inputSchema` 加上 `additionalProperties: false`；`target` 参数补上描述（此前 `status` / `remove` / `handoff` 三个工具的 `target` 没有描述，模型无从得知其含义）。
- `worktree_audit` 的 `staleDays` 覆盖值现在与 `worktree_config` 用同一套正数校验（此前接受 0 与负数）。
- 配置文件里的非法值（类型错误的 `repos[*].root` 等）被安全忽略并如实报告，不再抛出 Node 原生的 `The "paths[0]" argument must be of type string`。
- 主检出自身有未提交改动时，`worktree_merge_back` 在合并前拦下并说明该做什么，而不是让 git 抛 "Your local changes would be overwritten"。
- `worktree_status` 的"当前会话是否已在该 worktree 内"在标准客户端下报 `unknown`（宿主没把会话目录交给服务端），不再谎报 `no`。
- `worktree_handoff` 简报里的 task 文本用显式边界标记为不受信任内容——简报会被粘贴给下一个 agent 当指令执行。
- 目录大小统计改为所有工作树共用一份时间预算（此前每个目录各拿 5s，N 个工作树最坏 N×5s 堵死服务），并区分"超时"与"真的是 0 字节"，可回收空间不再静默低估。
- **宿主 PATH 里没有 git 时，报错点名缺的是 git，而不是"不在 git 工作树内"**。`mcp.json` 的 `command` 是裸名 `node`（Agent Plugins 规范允许），git 与 node 都由宿主的 PATH 解析；而 `git` 调用原本用 `allowFail` 吞掉一切失败，于是 git 缺失会被上层误判成"这个目录不是 git 仓库"，排查方向完全跑偏。现在改为单独探测 git 可执行文件是否在 PATH 上，缺失时给出"装 git / 把 git 所在目录加进宿主 PATH / 用 `git --version` 自检"的可执行提示。
- **Node 版本过低时服务启动即报可读错误**（`Node.js 18 or newer is required; this server runs on <实际版本>`），而不是让后续代码在半路抛出难懂的异常。
- 路径等值比较按平台区分大小写（Windows 与 macOS 默认不敏感，Linux 敏感），此前在大小写敏感的文件系统上会把两个不同目录判成同一个。
- `initialize` 对不认识的协议版本回落到服务端支持的版本，不再原样回显客户端的值。
- 服务端现在执行 schema 的 `required`：缺 `name`（含空串 / null）的调用直接报 `missing required parameter(s)`。此前 `worktree_status` / `worktree_handoff` 缺 `name` 会走"空名 = 主工作树"的匹配语义，静默描述主检出——看似成功，对象完全错误。
- 环境变量 `WORKTREE_STALE_DAYS` 的非正数（0 / 负数）不再生效，按无效值忽略并回退下一级配置，与 `worktree_config` / `worktree_audit` 覆盖值的正数校验对齐（ZCode 设置页正映射到这个变量，此前它是三条配置路径里唯一不设防的）。`worktree_audit` 的 `staleDays` 显式传非数字（如 `"abc"`）现在响亮报错，不再被静默当作未传。
- `worktree_merge_back` 请求了 rebase 但无法判定领先量（rev-list 无结果）时，跳过 rebase 会点名说明，不再只留一行 "commits ahead: ?" 让调用方误以为已执行。
- macOS 大小写不敏感卷上，受管根包含判定（`isInside`）与路径等值比较（`samePath`）的大小写口径一致：此前配置键能匹配而包含判定按大小写敏感计算，受管根内的工作树被误报 "outside the managed root"（失败方向安全但误导）。skill 的 Removing 一节同步修正——受管根外的拒绝与 `force` 无关，旧表述让人以为 `force: true` 能越过该边界。
- `worktree_remove` 对目录早已不在的 prunable 登记，成功回执点名"只清理了过期登记，没有删任何文件"；新增回归断言钉住 git 对目录消失工作树的 remove 行为（当前 git 静默按单点清除登记，无需 prune，也不波及其他 prunable 登记）。
- `worktree_merge_back` 的 target 是 `origin/*` 这类 remote-tracking ref 时（detached 回退会落到这里），拒绝语从"先 checkout 该 target"改为"先建本地分支（`git checkout -b <branch> origin/x`）再传分支名"——旧指引照做会进 detached HEAD。
- `worktree_config` 的 `repoPath` 在 `scope: "global"` 下的语义写入 schema 描述：可选，仅用于回执附上该仓库的生效值；传了就必须指向 git 仓库。

**0.4.1**

- **`root` 必须是绝对路径**。环境变量、全局设置、单仓库覆盖三条路径行为一致：写入时拒绝相对路径，读取配置文件时忽略并报告 issue，避免按宿主 cwd 解析到插件目录。
- **`worktree_status` 新增 `sessionCwd`**。标准 Agent Plugins 客户端把服务起在插件根，服务端看不到会话目录；传 `sessionCwd`（绝对路径）即可判断会话是否在 worktree 内，优先级高于服务进程 cwd。
- **`merge_back` 的删除判定使用最新 HEAD**。rebase 改写提交后重新读取 HEAD，不再用调用开始时的旧快照做合并判定。
- **非 ASCII 短任务名提示哈希来源**。纯中文等不含 ASCII 字母数字的名字仍用稳定哈希后缀，返回里说明原因。
- 冒烟断言增至 211 条。

**0.4.2**

- 修正 ZCode 兼容垫片里对受管根的过时描述：受管根允许配置在仓库内，垫片文案按实际语义改写。代码无行为变化。

**0.4.3**

- 修正锁定语义的文档与回执：`worktree_remove` 拒绝碰锁定工作树，`worktree_merge_back` 仅在带 `remove: true` 时拒绝（纯合并 / 变基锁定工作树是放行的）——此前"一律拒绝"的表述与实现不符。
- 锁定拒绝消息与 `worktree_lock` 回执的解锁指引改用插件自带的 `worktree_unlock`（保留裸 `git worktree unlock` 作备选）。
- 移除 `mcp/core.mjs` 未使用的 `SOURCES` 常量与导出。

**0.4.4**

- **配置文件读取路径校验 `staleDays`**。三条写入路径本就只收正数，但手编 `config.json` 写入 0 / 负数 / 非数字会被照单全收，audit 分桶阈值随之异常；现在读取时同口径忽略并报告 issue，回退默认 14。
- **修复配置锁的陈旧锁接管竞态**。持锁者停滞超 30s 被后来者清掉接管后，原持锁者迟到的 `release()` 会无条件删锁、误删新持锁者的锁；现在 release 前比对锁文件里的 pid，只释放仍属于自己的锁。
- README 补"调用模型"说明：工具调用串行执行、`worktree_audit` 带 `includeSize: true` 最坏约 20s，长操作期间后续请求排队。
- 冒烟断言增至 212 条。（0.4.4 发布时此行误记为 213，0.4.5 校正为实跑值。）

**0.4.5**

- **repo 级 `staleDays` 读取校验补齐正数口径**。0.4.4 的读取校验只盖了顶层，手编 `repos[*].staleDays` 写 0 / 负数仍被静默接受，audit 分桶阈值随之变负；现在与顶层同口径剔除并报告 issue，`saveConfig` 写盘时非法值归一为默认 14——读写路径不再分裂。
- 冒烟断言增至 217 条（新增 repo 级 `staleDays` 读写同口径用例 5 条）；新增 `test/lock.mjs` 配置锁单测 8 条（直连 `mcp/core.mjs`：release 归属校验——迟到 release 不误删换主后的锁、持锁竞争等到死限报错）。

**0.3.0（含破坏性变更）**

- `worktree_config` 的 `root` / `baseRef` / `branchPrefix` 传入空字符串现在直接报错。此前空串被静默当作"未传"，`baseRef: ""` 会悄悄退回 `auto`。要用"清空并回退默认"，改传 `null`。宿主设置页回传空串时需改传 `null` 或省略该字段。
- `worktree_create` 在 `auto` 基线落后仓库默认分支时输出 `base lag:` 提示。根因是 `defaultBranch()` 曾回退"当前检出分支"，导致落后量恒为 0；现在按 `origin/HEAD` → 本地 `main` → `master` → `symbolic-ref HEAD` 的顺序判定。
- 所有工具的 `Config:` 行标出每项配置的来源（`env` / `repo` / `global` / `default`）。
- `worktree_remove` / `lock` / `merge_back` 在名字同时匹配多个 worktree 时报 `ambiguous worktree name` 并列出候选，不再任选其一；改传绝对路径。
- `worktree_merge_back` 在 rebase / merge 之后重新计算 ahead 与合并状态，修复后续步骤按旧快照判断的问题。
- 配置文件写入的临时名带进程号与随机后缀，并对 Windows 上 `rename` 覆盖时偶发的 `EPERM` 做有界重试。

## 安全边界

这些是有意为之的拒绝，不是 bug：

- 删主工作树：永远拒绝。
- 删脏工作树 / 有未合并提交的 worktree：拒绝，必须显式 `force`。
- 删受管根目录之外的 worktree：一律拒绝，`force` 只覆盖脏工作树 / 未合并提交，不放宽受管根边界。
- 合并时主工作树检出的不是目标分支：拒绝，并告知先 `git checkout`。
- rebase / merge 冲突：停下并列出冲突文件，不自动解决。
- skill 层面：任何破坏性调用前先向用户确认。

## 安装

按 **Agent Plugins 1.0.0** 打包（根 `plugin.json` + `mcp.json` + `skills/`），兼容客户端直接加载 `plugins/worktree-ops` 目录即可；ZCode / Codex / Oh My Pi 通过各自的垫片安装。

## 依赖

- Node.js ≥ 18（在 PATH 上）
- `git`（在 PATH 上）

零第三方依赖，无网络调用，无凭据。

## 测试

```
node test/smoke.mjs
```

在临时目录里建一个一次性 git 仓库，跑完整工具链（创建 / 列表 / 状态 / 交接 / 审计 / 合并 / 删除拦截 / 主工作树保护 / 未配置拒绝 / 非 git 目录报错 / 环境变量覆盖优先级），不需要真实仓库，也不需要任何凭据。测完自动清理临时目录。
