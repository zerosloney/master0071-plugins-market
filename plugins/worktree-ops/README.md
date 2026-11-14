# worktree-ops

Git worktree 操作台：**在可配置的根目录**（仓库内外皆可）里创建、查看、审计、合并回主干与安全清理 worktree，附带把工作交接到新会话的完整指引。

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
| `worktree_create` | 在配置根目录下从基线新建分支，或检出既有分支（如 PR 分支）做验证，产出绝对路径 + 新会话交底。既有分支按原名检出（`develop` 这类无斜杠分支同样支持）；短任务名不含 ASCII 字母数字时用稳定哈希后缀，并在返回里提示。`noCheckout: true` 以 `--no-checkout` 创建（只设 HEAD 不检出工作区文件，适合超大仓库）；显式 `path` 必须落在受管根内，否则拒绝 |
| `worktree_list` | 列出全部 worktree：分支、HEAD、是否干净、领先/落后、是否已合并、闲置天数 |
| `worktree_status` | 单个 worktree 的完整详情，含脏文件、最后提交、当前会话是否已在其中（标准客户端下传 `sessionCwd` 可确认） |
| `worktree_audit` | 清理前分桶审计：`safe` / `review` / `hold` + 原因 + 可回收空间，**只读不删** |
| `worktree_remove` | 删除 worktree（可选删分支），脏/未合并拒绝（需 `force: true` **且** `confirmDiscard: true` 双标志才越过）；**例外（0.4.16 起）**：prunable 且 HEAD 不可达的登记（gitdir 失效、分支引用已删）无需 force 即可清除；受管目录外一律拒绝，`force` 也不放宽 |
| `worktree_lock` | 锁定 worktree（`git worktree lock`，可记原因）：主检出（primary worktree）会被拒绝；`worktree_remove` 拒绝碰锁定的工作树；`worktree_merge_back` 仅在带 `remove: true` 时拒绝 |
| `worktree_unlock` | 解锁，恢复 remove / merge_back |
| `worktree_merge_back` | 默认只出计划；`rebase` / `merge` / `remove` 开启后执行，遇冲突停下交还。`ff: true` 配合 `merge` 做 fast-forward-only 合并（线性历史、无合并提交），分支已分叉时拒绝。`remove: true` 与 `worktree_remove` 同一道删除护栏：锁定 / 受管根外 / 未合并 / 脏 / **含 gitignored 文件**一律保留工作树并说明原因（2026-11-01 补：此前只有 `worktree_remove` 带 gitignored 闸，`merge_back` 是第二个删除出口却无确认环节，只含 `.env` 的已合并工作树会被静默删掉） |
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

**0.4.17**

面板评审收口（pr-baf1e6e-753574e2 对 0.4.16 单提交：7 镜头 16 原始 → 簇聚 15 候选（baseRef 双镜头并一、1 blast-radius）→ 45 票全 confirm（C-001/C-013 升 Important）→ 15 条全修）：**C-013（Important）** config.mjs + protocol.mjs 接入 CI（0.4.16 新增的 9 项修复唯一回归守护此前从不执行）；**C-001（Important）** saveConfig 写路径 baseRef 空串归一（与 branchPrefix 同待遇——宣称的「不落盘」写路径补齐）。**其余**：②__proto__ 键 round-trip 改 defineProperty（丢键+原型替换堵口，+2 白盒断言）③写盘前二次归属复核（接管窗口再收窄）④锁路径随 release 单源带回（消双推导）⑤prunable 豁免收紧为「目录确已不存在」（实证 prunable ≠ 目录不在，注释前提修正）⑥相对 WORKTREE_CONFIG_HOME 忽略时上报 issue（存量配置弃置不再静默）⑦README 三处：契约表 remove 行补 prunable 例外、已知限制落档（3 项不修决定）、⑧mergedLabel 三态标签抽单源（白盒可测）⑨git log 行解析抽 parseLogLine 单源（两份手工实现归一）⑩协议 enum 单源化（工具侧生产不可达分支移除）⑪fd 泄漏测试死限短路（waitMs 注入，套件墙钟减半）。十套件全绿（含新增 3 断言）。



- **Windows `\\?\` 前缀剥离**：实测 no-op（Node 的 fs API 已规范化长路径），无行为差异——不修。
- **git 超时孙进程级联杀**：需要 Windows Job Objects 绑进程树，超出本插件零依赖边界——不修（超时后孤儿孙进程由 git 自身回收语义兜底）。
- **Node 版本自检顺序**：ESM import 提升使检查晚于模块加载，形式上「先加载后检查」——实测无危害（不支持版本在 import 阶段即崩），不修。

## 版本变更

**0.4.16**

功能与代码全量审查的 Minor 批量收口（16 修 / 3 评估后不修）。四组：

- **配置与锁的健壮性**。`saveConfig` 写临时文件本身失败（ENOSPC/EACCES）不再留下半截 `.tmp`；取锁时 `writeSync` 失败不再泄漏 fd（退避/超时路径照常走）；手写在 config.json 里的未知**顶层**键在任意一次配置写盘后原样保留（此前无提示消失）；`WORKTREE_CONFIG_HOME` 相对路径被忽略并回退默认位置（此前随宿主进程 cwd 漂移，表现为「设置改了不生效」）；`baseRef: ""` 与 `branchPrefix: ""` 同待遇——上报 issue、不落盘（此前静默降级 auto，无任何提示）。
- **输出与口径**。`worktree_list` 真的带 HEAD 短 sha 列（文档一直这么承诺，实现此前缺失）；`merge_back` 计划行的「合并状态未知」显示 `?` 而不是写死 `no`（与同行 ahead 的 `?` 口径对齐）；单条最后提交的 subject 含 tab 不再被截断（与批量版同口径）；`slug` 命中 Windows 保留设备名（con / nul / com1…）时自动加 `-wt` 后缀，不再让 git 报晦涩的 Win32 错误；create 去掉对既有分支名的重复 rev-parse；**prunable 且 HEAD 不可达的登记，remove 无需 force 即可清除**——与紧邻的 clean 检查同口径：目录已不存在、磁盘无文件可删，清的只是 git 自己判为残骸的过期登记，等价于 prune。
- **协议层**。带 `enum` 的参数（`action` / `scope`）在协议层即校验，拼错值立刻报错点名合法集合（此前落到工具内部兜底）；`type: "array"` 判定修正（潜伏缺口，当前无工具使用）；无 id 的 ping 按 JSON-RPC 2.0 不再违规回包；unknown tool 按 MCP 规范回 JSON-RPC error（-32602，含被拒工具名）而非 content+isError；stdin 读错误对齐 stdout EPIPE 的既有口径（EPIPE 静默退出，不再未捕获崩栈）。
- **文档**。lock 拒绝主检出补进 README / SKILL / schema description；SKILL 的 audit `hold` 枚举补上 `gitignored`；list 描述补 HEAD。

**0.4.15**

- **配置锁的陈旧接管不再「删锁重建」，改为原子替换 + 写盘前归属校验**。原接管路径 stat 判陈旧后无条件 unlink：两进程并发接管同一把陈旧锁时，后到者的 unlink 删掉的是前者刚建好的**新**锁，两个写者同时进临界区，后写者覆盖先写者的配置改动（该路径此前无测试覆盖）。现在接管方把自己的 pid 写临时文件后 `rename` 原子替换锁文件——rename 要么整体换掉要么不动，不存在误删他人新锁的中间态，并发接管时最后替换者即唯一持锁者；`worktree_config` 落盘前校验锁内容仍为本进程 pid，输掉接管竞态的一方中止保存并给出重试指引，不落盘、不吞错。lock 测试补齐接管三场景（陈旧锁仍可接管 / 接管后锁内容为新持有者 / 临界区内锁换主则拒绝落盘）。
- **`create` 对「分支已检出于同名路径的活 worktree」不再误报为残留目录**。原「目录非空」检查先于「git 已注册」检查：活工作树目录必非空，先命中前者，报错指引 `remove the leftover directory first`——照做会删掉活树的未提交内容，而精确诊断不可达。现在注册检查先行，活树报 `git already registers this worktree`；真正的残留目录场景不受影响，smoke 补两侧回归用例。

**0.4.14**

- **`merge_back` 的 remove 出口补齐删除护栏**。`worktree_remove` 一直拒绝删含 gitignored 文件的工作树，但功能等价的 `merge_back { remove: true }` 是**第二个删除出口**且没有确认环节：只含 `.env` 的已合并工作树被判 clean 后，裸 `git worktree remove` 连目录带文件一起删掉且无法恢复（实测）。现在它与 `worktree_remove` 同闸（锁定 / 受管根外 / 未合并 / 脏 / 含 gitignored 文件一律保留并说明原因），计划阶段就标注"removal will be kept back"，需要真丢弃时导向唯一带二次确认的 `worktree_remove`（`force` + `confirmDiscard`）。README 与 `worktree-manager` skill 同步，smoke 补 merge_back + gitignored 用例。

**0.4.13**

- **stdout EPIPE 不再崩栈**：宿主提前关闭管道时以退出码 0 静默收场，而不是抛 EPIPE 打一屏栈。
- **`status` / `lock` / `unlock` 三个工具的回执补 `Config:` 来源行**，与其余工具同口径——来源（env / 单仓覆盖 / 全局 / 默认）在回执里可直接核对。
- 文档口径同步：README、SKILL 与 marketplace 条目按实现改写。

**0.4.12**

- **`target` 默认值改锚主检出，「未合并提交」护栏不再对 worktree 自身失效**。旧默认取 `repoPath` 当前检出的分支；会话 cwd 就在某个 worktree 里时 `repoPath` 自然指向它自己，target 于是等于该 worktree 的分支，`rev-list target...branch` 自己和自己比，`ahead` 恒为 0——不带 `force` 也能删掉有未合并提交的工作树。现在默认取**主检出**当前检出的分支（那才是"合并回哪里"的答案，也与 `merge_back` 要求 target 已在主检出上的前提一致），主检出 detached 时仍回退 `origin/<默认分支>`。显式传 `target` 的行为不变，五个工具的 schema 描述同步改口径。

**0.4.11**

- **从 worktree 内部删除自身不再把目录删成孤儿**。会话就在某个 worktree 里时 `repoPath` 自然指向它自己，旧实现拿它当 cwd 跑 `git worktree remove`：内容先被删光、最后 `rmdir` 报 `Permission denied`，同时那个 worktree 已从 git 登记里注销——目录变成 `git worktree remove` 再也删不掉的空壳，而报错文案说的是权限问题。现在删除动作一律站在被删目录之外的主检出上执行，并先把**服务进程自己的** cwd 移出去（Windows 不允许删除进程当前目录）。删除成功后的「剩余工作树 / 删分支」也改用同一个存活目录，不再因为 cwd 刚被删掉而误报 `spawnSync git ENOENT`。若仍失败且处于「登记已注销、目录还在」的状态，回执会如实点名这个不一致并给出人工清理步骤。
- **`worktree_audit` / `worktree_remove` 看得见 gitignored 文件**。旧脏检查只用 `git status --porcelain`，而它按定义不列 ignored 文件：一个只含 `.env` + `build/` 的 worktree 被判 `clean: yes`，`remove` 不带任何 flag 就把 `.env` 一起删掉——无警告、无报错、不可恢复。现在状态查询带 `--ignored=matching`，ignored 条目单独计数：`audit` 把它放进 `hold` 并点名「会随目录删除」，`remove` 要求 `force` + `confirmDiscard` 二次确认。
- **未配置受管根时 `bucketOf` 不再判 `safe`**。旧判定写成 `if (managedPath && !isInside(...))`，`root` 为 null 时整条跳过 → audit 报 `safe to remove`，`remove` 却回 `outside the managed root (none configured)`，audit 自己的指引把人撞墙。`test/bucket.mjs` 里把这一错误行为钉成契约的断言同步改掉。
- **合并冲突后中止本次合并**。旧实现返回 `isError` 却把 `MERGE_HEAD` 留在主检出上，重试撞到的是「你还有未完成的合并」这个无关的错。现在冲突时执行 `git merge --abort`（失败则如实告知需人工中止），回执说明主检出已回到合并前状态。

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

**0.4.6**

- **删除护栏对「状态不可得」改判 fail-closed**。`worktree_remove` 只拦 `clean === false`：`git status` 取不到时 `clean` 为 `null`，直接 fall through 被当成干净放行——恰恰是无法证明干净的时候最好删。现在与紧邻的 `ahead === null` 同口径拒绝，并保住 prunable 例外（目录已被手动删走，无未提交工作可丢）。
- `worktree_audit` 的 `bucketOf` 同批改：`git status` 不可得不得进 `safe` 桶，否则 audit 报「safe to remove」而 remove 拒绝，照着做必然撞墙；prunable 判定前置于该条，出账仍点名 prunable。
- **市场与垫片描述如实区分 `force` 与 `confirmDiscard`**。此前写「脏工作树、未合并提交一律拒绝删除」与代码不符（`force` 会越过这两道）；改为准确表述：默认拒绝、须 `force: true` **且** `confirmDiscard: true` 双标志才越过，锁定中与受管目录外一律拒绝且 `force` 不放开。顺带修掉 omp 市场条目「在仓库之外」的旧错（仓库内根一直支持）。
- 新增 `test/bucket.mjs` 白盒套件（7 断言）锁住分桶口径并接入 CI——黑盒无法稳定制造「git 拒绝报告状态」的目录。

**0.4.7**

- 垫片元数据与能力指针形态统一（由市场级 `manifest-lint.mjs` 机器对账兜住），版本位同步至 Qoder 侧清单。

**0.4.8**

- **本地忽略行拒绝控制字符**。`ensureInsideRepoIgnore` 把配置来的受管根路径派生成一行写进 `.git/info/exclude`，此前不过滤控制字符：路径里带换行会把一行拆成两条规则，等于借配置往 exclude 注入任意 ignore 项，静默隐藏本该可见的未跟踪文件。合法路径不需要控制字符，故直接放弃写入——没有本地忽略只是 `git status` 多一行，比注入安全。
- 新增 `test/exclude.mjs`（10 断言）：正常写入与幂等、含换行/制表符的路径拒绝且字节零变化、仓库外/仓库根/缺 gitDir 三条既有短路未被破坏。

**0.4.9**

- **路径比较解析 Windows 8.3 短名**。`samePath` / `isInside` 只做 `path.resolve` + 大小写折叠，而 GitHub Actions 的 TEMP 是 `C:\Users\RUNNER~1\...`、`git worktree list` 回的是长名 `C:\Users\runneradmin\...`——同一目录被判成两个，windows-latest 上 smoke 大面积红。改为统一走 `realpathSync.native` 归一（Windows 经句柄取真实长名，POSIX 顺带解析符号链接，一并修掉 `/tmp`→`/private/tmp`），并剥掉 Windows 返回的 `\\?\` 前缀；路径不存在时（prunable 工作树目录已被删走）退回 `resolve` 结果，取不到不能当错误。
- 新增 `test/paths.mjs`（11 断言），含本机 8.3 别名可用时短名与长名必须判等。

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
- 删脏工作树 / 有未合并提交的 worktree / 含 **gitignored 文件**的 worktree：拒绝，必须同时传 `force: true` **与** `confirmDiscard: true`（两个独立标志，单给 `force` 会被拒并提示补第二个——防一个误注入或误传的 `force` 独自毁掉未提交的工作）。
  - gitignored 也算：裸 `git status` 看不见它们，`.env`、`build/` 这类文件会随目录一起消失且无法恢复，所以 `worktree_audit` 把它们放进 `hold`，`worktree_remove` 要求二次确认。
- 删受管根目录之外的 worktree：一律拒绝，`force` 只覆盖脏工作树 / 未合并提交，不放宽受管根边界。**未配置受管根时同样拒绝**（`worktree_audit` 也因此不再把任何 worktree 判成 `safe`——分桶与护栏同宽）。
- 会话就在待删 worktree 内：允许删除，但会先把服务进程的工作目录移出该目录（Windows 不允许删除进程当前目录）；若移动失败则如实报告，不会把目录删成「登记已注销、目录还在」的孤儿。
- 合并时主工作树检出的不是目标分支：拒绝，并告知先 `git checkout`。
- rebase / merge 冲突：停下并列出冲突文件，不自动解决。**冲突后会中止这次合并**（`git merge --abort`），不把 `MERGE_HEAD` 留在主检出上——否则下一次调用撞到的是「你还有未完成的合并」这个无关的错。
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
