# master0071-plugins

五个按 **[Agent Plugins 1.0.0](https://agent-plugins.org) 开放标准**打包的个人插件。一次打包，所有兼容客户端通用。

| 插件 | 版本 | 可移植组件 | 简介 |
|------|------|-----------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.5.11 | `skills/` + `mcp.json` | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 15 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持自定义场景 |
| [worktree-ops](plugins/worktree-ops/) | 0.4.12 | `skills/` + `mcp.json` | Git worktree 操作台：在可配置目录里创建（新分支或检出既有分支）/ 列出 / 审计 / 合并回主干与安全清理 worktree，10 个 MCP 工具 + `worktree-manager` skill，根目录与分支前缀均可配；删除默认拒绝脏工作树与未合并提交（`force=true` 单独无效，须与 `confirmDiscard=true` 同时为真才丢弃），锁定中与受管目录外一律拒绝删除且 `force` 不放开 |
| [agent-pipelines](plugins/agent-pipelines/) | 0.1.21 | `skills/` | 多代理编排管道套件：`/ralph-pipeline` 通用任务编排 + `/coding-pipeline` 受控编码管道，含 6 个配套子智能体。模型不写死，回退会话默认模型 |
| [pstack](plugins/pstack/) | 0.1.18 | `skills/` | poteto 风格 agent 工作流栈（第三方移植）：`poteto-mode` 作为路由入口调度 architect / arena / interrogate / thermos / unslop 等 65 个 skill，含 24 条 principle 原则、14 个子智能体与会话启动 hook |
| [ai-native-delivery](plugins/ai-native-delivery/) | 0.1.9 | `skills/` + `mcp.json` | AI-Native 交付治理引擎：L1/L2/L3 风险泳道两问定级 + check-loop 硬门 5 段 + 台账三件套 + 判定账治理进化，装上即得三层闭环；台账落使用项目 git 仓库根。移植自 Shipyard.Material 治理引擎（policyVersion 14 基线，机制保真、运行数据不迁） |

## 共装注意：两个 PreToolUse 风险闸

`systemone-decision` 与 `ai-native-delivery` **都注册 PreToolUse shell 命令闸**，判据却不同：前者把命令文本交给带外决策模型做三问判定，后者是项目内静态 deny/ask 清单匹配（无网络、无模型）。宿主按插件各跑各的 hook，**两个闸之间没有仲裁通道**——同装时一条 shell 命令会被判两次，可能出现两道确认，或一个 `ask` 叠一个 `deny`（最终按宿主对多份 hook 输出的合并规则取严）。

只留一道闸的办法（按你要的判据选）：

| 想留 | 怎么让位 | 代价 |
|------|----------|------|
| ai-native 的清单闸（确定性、不外发） | 给 systemone 设 `SYSTEMONE_HOOK_RISK_GATE=off` | 失去语义级判定，只认清单里写死的串 |
| systemone 的模型闸（能判语义） | 删除 `plugins/ai-native-delivery/hooks/hooks.json` 的 `PreToolUse` 段 | **命令全文会外发到所配置的第三方端点**（默认 unisound），并需在该插件设置页配 API Key |

默认两者都开、都只读命令文本（不读文件内容）。要外发这件事本身就是选型依据，所以写在装之前看的那一页上，而不是埋在各自 README 里。

## 标准包结构

Agent Plugins 的可移植核心只有三样：**根 `plugin.json`**（封闭 schema 的清单）、**`skills/<name>/SKILL.md`**、**`mcp.json`**。客户端按固定位置自动发现，不需要在清单里声明路径。

```
plugins/
├── systemone-decision/
│   ├── plugin.json           # 标准清单：$schema + name + 元数据（版本权威来源）
│   ├── mcp.json              # 标准 MCP 声明：mcpServers.{name}.type = stdio
│   ├── skills/systemone-decision/   # 标准 skill
│   ├── hooks/                # ↓ 以下为客户端约定，非 Agent Plugins 核心
│   ├── mcp/  test/  endpoint-config.mjs  icon.png
│   └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
├── worktree-ops/
│   ├── plugin.json           # 标准清单
│   ├── mcp.json              # 标准 MCP 声明：worktree = node ./mcp/server.mjs
│   ├── mcp/server.mjs        # 零依赖 Node 实现：装配入口
│   ├── mcp/core.mjs          # 配置层、git 封装、路径与 worktree 检查
│   ├── mcp/tools.mjs         # 10 个 worktree 工具的定义、描述、schema 与处理函数
│   ├── mcp/protocol.mjs      # JSON-RPC 收发与 stdio 循环
│   ├── skills/worktree-manager/    # 标准 skill：何时建、怎么交接、何时能删
│   ├── test/smoke.mjs        # ↓ 一次性 git 仓库上的端到端冒烟测试
│   └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
├── agent-pipelines/
│   ├── plugin.json           # 标准清单
│   ├── skills/               # 标准 skill：ralph-pipeline / coding-pipeline
│   ├── commands/  agents/    # ↓ 客户端约定，非 Agent Plugins 核心
│   └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
├── ai-native-delivery/
│   ├── plugin.json           # 标准清单
│   ├── mcp.json              # 标准 MCP 声明：delivery = node ./mcp/server.mjs（7 工具）
│   ├── skills/               # 标准 skill：6 个（autonomous-run / review-method / session-resume / decision-log / verify-ui / workflow-closeout）
│   ├── commands/  agents/    # ↓ 客户端约定，非 Agent Plugins 核心（8 命令 / 3 角色）
│   ├── scripts/  hooks/  config-templates/            # ↓ 引擎脚本 / PreToolUse 风险闸 / 项目侧配置种子
│   └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
└── pstack/
    ├── plugin.json           # 标准清单
    ├── skills/               # 标准 skill：65 个（poteto-mode / 24 principle-* / 工作流）
    ├── agents/  hooks/  models.json                    # ↓ 客户端约定，非 Agent Plugins 核心
    ├── extras/              # 按需启用：bun 专属 vendored 脚本 / effort-agents / 上游参考，见 extras/README.md
    ├── NOTICE-PORT.md  LICENSE*                       # 第三方 MIT 作品的署名与许可，不可删
    └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
LICENSE                     # 本仓库自身作品的 MIT 许可（pstack 的第三方许可另见其目录内文件）
```

根 `plugin.json` 的顶层字段受规范封闭约束，只有：`$schema`、`name`（前两项必填）、`version`、`description`、`author`（`{name, email, url}` 对象）、`homepage`、`repository`、`license`、`keywords`、`extensions`。组件路径不写在这里——放进去会被判为未知字段（报告并忽略，不致命但无意义）。

注意规范**没有** `engines` 这个键：`additionalProperties: false` 的封闭集里没有它，写进去宿主只会忽略，于是"清单已声明 Node 下限"只是错觉（此前五个插件的根清单都带了这个越界字段，现已移除）。Node 版本要求写在各插件 README 与下面的「配置」一节，并由运行期自检兜住——`scripts/manifest-lint.mjs` 现在按规范白名单对账顶层字段，越界即报错。

`skills/<name>/SKILL.md` 的 frontmatter 按 [Agent Skills 规范](https://agentskills.io/specification) 写：只出现规范字段——`name`（必填，与目录名一致）、`description`（必填）、`license`、`compatibility`、`metadata`、`allowed-tools`。`compatibility` 只在确有环境依赖时写（外部命令、运行时、凭据、网络），没有就不写。客户端专有的 frontmatter 键（`user-invocable`、`paths` 等）一律不写。

skill 正文同样不写死某一家的路径与清单名：需要项目级 skill 目录、用户级 skill 目录、按项目 transcript 目录或 agent store 时，正文用宿主中立表述（"the host's project-skill directory" 等），具体路径由各宿主的映射文件 `skills/poteto-mode/references/<host>-tools.md` 的路径对照表给出。

规范还强制**路径隔离**：插件内所有相对路径必须解析在插件根目录内。

### 非标准部分说明

Agent Plugins 只规范化 skills 与 MCP 两类组件，以下内容超出标准，兼容客户端会忽略，但本仓库仍保留以服务实际使用的宿主：

| 内容 | 状态 | 谁在用 |
|------|------|--------|
| `plugins/*/hooks/hooks.json` | 客户端约定（非标准） | Claude Code / ZCode 等支持 Claude 式 hook 的宿主，用 `${CLAUDE_PLUGIN_ROOT}` 定位插件根 |
| `plugins/agent-pipelines/commands/`、`agents/` | 客户端约定（非标准） | 支持斜杠命令与子智能体的宿主 |
| `plugins/ai-native-delivery/commands/`、`agents/` | 客户端约定（非标准） | 同上（8 交付命令 / 3 角色委派）；`hooks/hooks.json` 走 Claude 式 hook 约定，omp 不加载 |
| `plugins/pstack/agents/`、`hooks/` | 客户端约定（非标准） | 支持子智能体 / Claude 式 hook 的宿主；session hook 读 `~/.claude/pstack-models.md`，含 `session hook: off` 即不注入路由令；ZCode 按约定路径注册同一份 `hooks/hooks.json`，`session-start.mjs` 宿主自检后走 zcode 分支读 `~/.zcode/pstack-models.md`，映射见 `skills/poteto-mode/references/zcode-tools.md`。effort 分级子智能体与 bun 专属脚本在 `plugins/pstack/extras/`（默认不加载） |
| `plugins/*/.zcode-plugin/plugin.json` | **非标准 ZCode 兼容垫片** | ZCode；提供内联 `mcpServers` 与 `userConfig` 设置页 |
| `plugins/*/.codex-plugin/plugin.json` | **非标准 Codex 兼容垫片** | Codex；声明 `skills` / `mcpServers` / `hooks` 与 `interface` 展示信息 |
| `plugins/*/.omp-plugin/plugin.json` | **非标准 Oh My Pi 兼容垫片** | Oh My Pi（`omp`）；声明 `skills` / `agents` / `commands` 与内联 `mcpServers` |
| 根 `marketplace.json` | **非标准 ZCode 兼容垫片** | ZCode 的 `/plugin marketplace add` 发现入口 |
| 根 `.agents/plugins/marketplace.json` | **非标准 Codex 兼容垫片** | Codex 的市场发现入口（Codex 市场 schema：`name` / `interface` / `plugins[]`，条目不带版本） |
| 根 `.omp-plugin/marketplace.json` | **非标准 Oh My Pi 兼容垫片** | Oh My Pi 的市场目录（`name` / `owner` / `plugins[]`，条目带版本） |

三份市场目录的**字段集合不同是各宿主 schema 决定的**，不是不一致：ZCode 条目带 `displayName` / `displayName_i18n` / `description_i18n`，omp 条目带 `category` / `keywords`（无 i18n），Codex 条目按其 schema 只有 `name` / `source` / `policy` / `category`、**不带版本**（版本从各插件的 `.codex-plugin/plugin.json` 读）。要守住的是**事实一致**：同一插件在两份目录里描述的能力、数字与边界条件必须对得上——措辞可以按各宿主的展示位置裁剪，事实不能各自漂移。

保留垫片是为了**不破坏 ZCode 现有的安装方式**。严格意义上一个包内有且仅有一个 `plugin.json`，垫片那份会让包不再是纯粹的单清单形态——这是为兼容性做的自觉取舍，不是疏忽。

## 安装

> **同名 skill 冲突**：pstack 的 `tdd`、`teach` 与常见的用户级 skill 同名。宿主的用户级 skill 目录若已有同名项，`dim plugin install` 会拒绝安装；先移开或禁用用户级版本，或只安装需要的 skill。ZCode / Codex 的同名处理由宿主决定。

### Agent Plugins 兼容客户端（VS Code / Cursor / Copilot / Kiro / OpenClaw 等）

直接加载插件目录：

```
plugins/systemone-decision
plugins/worktree-ops
plugins/agent-pipelines
plugins/pstack
plugins/ai-native-delivery
```

各客户端的分发入口以其自身文档为准（规范刻意不规定分发机制）。

### ZCode

```
/plugin marketplace add zerosloney/master0071-plugins-market
/plugin install systemone-decision@master0071-plugins
/plugin install worktree-ops@master0071-plugins
/plugin install agent-pipelines@master0071-plugins
/plugin install pstack@master0071-plugins
/plugin install ai-native-delivery@master0071-plugins
```

本地开发直接指向仓库目录：

```
/plugin marketplace add E:\Demo\cli-tools\master0071-pluigns-market
```

### Codex

仓库根的 `.agents/plugins/marketplace.json` 是 Codex 的市场入口，在 `~/.codex/config.toml` 里登记一次即可：

```toml
[marketplaces.master0071-plugins]
source = 'E:\Demo\cli-tools\master0071-pluigns-market'
```

然后：

```
codex plugin add systemone-decision@master0071-plugins
codex plugin add worktree-ops@master0071-plugins
codex plugin add agent-pipelines@master0071-plugins
codex plugin add pstack@master0071-plugins
codex plugin add ai-native-delivery@master0071-plugins
```

Codex 侧只加载 `skills/`、`mcp.json` 与清单内声明的 `hooks`；`commands/`、`agents/` 是 Claude 式宿主的约定，Codex 不加载（effort 分级变体在 `extras/`，任何宿主都不加载）。

### Oh My Pi（omp）

仓库根的 `.omp-plugin/marketplace.json` 是 Oh My Pi 的市场目录，登记一次即可：

```
omp plugin marketplace add E:\Demo\cli-tools\master0071-pluigns-market
omp plugin install pstack@master0071-plugins
omp plugin install agent-pipelines@master0071-plugins
omp plugin install systemone-decision@master0071-plugins
omp plugin install worktree-ops@master0071-plugins
omp plugin install ai-native-delivery@master0071-plugins
```

市场目录有缓存，仓库改动后用 `omp plugin marketplace update master0071-plugins` 刷新；`omp plugin upgrade` 会把已装插件升到目录里的版本。

Oh My Pi 侧与 Codex 不同：它**会加载 `agents/` 与 `commands/`**（caveman 插件即如此），但**不加载 `hooks/`**——所以 pstack 在 omp 上没有会话启动自动路由，手动叫 `poteto-mode` 即可。

> 垫片与标准清单的版本必须一致，发版前用 `node scripts/release.mjs --check` 校验。

## 配置

五个插件都不需要任何私有配置。systemone-decision 首次使用需设置 API Key——`mcp.json` 里不写任何凭据，Key 只从环境变量读（各宿主都没有安全的凭据存储）：

```
setx SYSTEMONE_API_KEY "你的Key"
```

端点 / 模型 / 超时 / 自定义场景 / 审计日志 / 缓存 TTL 全部可选，完整说明见[插件 README](plugins/systemone-decision/README.md)。

agent-pipelines 无需配置：模型不写死，回退宿主会话默认模型。

五个插件都要求 **Node.js ≥ 18**（脚本与 MCP 服务均为零依赖纯 Node），且 `node` 在**宿主启动 MCP 服务时使用的 PATH** 里——`mcp.json` 的 `command` 是裸名 `node`（Agent Plugins 规范允许的解释器写法），由宿主按平台搜索规则解析。宿主若用受限环境启动子进程导致 PATH 里没有 node，服务会起不来，属宿主侧问题。带 MCP 服务的三个插件（systemone-decision / worktree-ops / ai-native-delivery）另需 git。自检：`node --version && git --version`。

worktree-ops 无需凭据，根目录须先配置（未配置时 `worktree_create` 拒绝创建）。要改位置有三层，按优先级从高到低：环境变量 `WORKTREE_ROOT` / `WORKTREE_BASE_REF` / `WORKTREE_BRANCH_PREFIX` / `WORKTREE_STALE_DAYS`，配置文件里的单仓库覆盖（会话里调 `worktree_config`），配置文件里的全局值。配置文件默认落在 `%APPDATA%\worktree-ops\config.json`（macOS / Linux 为 `~/.config/worktree-ops/config.json`），用 `WORKTREE_CONFIG_HOME` 可整体改路径；ZCode 上这四项已映射进插件设置页。完整说明见[插件 README](plugins/worktree-ops/README.md)。

pstack 无需配置也不需要凭据：模型分工由 `setup-pstack` skill 写入运行时的模型表（路径按运行时而定，见该 skill 的 Other runtimes 表），会话 hook 读它决定是否注入路由令。pstack 是第三方 MIT 作品的移植（原作者 Lauren Tan / poteto，移植版 Michael Denyer），署名链见 [pstack/NOTICE-PORT.md](plugins/pstack/NOTICE-PORT.md)，再分发时那几份 LICENSE 不可删。

## 维护

- **发版**：`node scripts/release.mjs <plugin> <x.y.z>`，同步该插件的各版本位（根 `plugin.json`、ZCode 垫片两处、市场条目，systemone-decision 的 `mcp/server.mjs`、worktree-ops 的 `mcp/protocol.mjs` 里还有 `SERVER_INFO`）；`node scripts/release.mjs --check` 校验全部一致。
- **新增插件**：在 `plugins/` 下建目录，至少写一份根 `plugin.json`（含 `$schema` 与 `name`），按需加 `skills/` 与 `mcp.json`，并在 `scripts/release.mjs` 的 `PLUGINS` 中登记；若需要在 ZCode 可装，再补 `.zcode-plugin/plugin.json` 与根 `marketplace.json` 条目。skill 的 `SKILL.md` frontmatter 只写 Agent Skills 规范字段（`name` / `description` / `license` / `compatibility` / `metadata` / `allowed-tools`），不写客户端专有键。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  ```

  worktree-ops 的 `node test/smoke.mjs` 在系统临时目录里造一次性 git 仓库，跑完全部断言后自动清理，同样不需要真实仓库或凭据。pstack 的测试也在插件目录下执行：`node test/run-hook-tests.mjs`（hook 契约与表解码）与 `node test/sheet-parity.mjs`（awk↔mjs 一致性，无 awk 环境自动跳过）。agent-pipelines 在插件目录执行 `node test/contract.mjs`，校验角色文件齐全、关键参数一致与 skill 自足。
