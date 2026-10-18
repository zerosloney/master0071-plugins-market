# master0071-plugins

四个按 **[Agent Plugins 1.0.0](https://agent-plugins.org) 开放标准**打包的个人插件。一次打包，所有兼容客户端通用。

| 插件 | 版本 | 可移植组件 | 简介 |
|------|------|-----------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.5.1 | `skills/` + `mcp.json` | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 15 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持自定义场景 |
| [worktree-ops](plugins/worktree-ops/) | 0.1.0 | `skills/` + `mcp.json` | Git worktree 操作台：在仓库之外的可配置目录里创建 / 列出 / 审计 / 合并回主干 / 安全清理 worktree，8 个 MCP 工具 + `worktree-manager` skill，根目录与分支前缀均可配，脏工作树、未合并提交与受管目录外一律拒绝删除 |
| [agent-pipelines](plugins/agent-pipelines/) | 0.1.0 | `skills/` | 多代理编排管道套件：`/ralph-pipeline` 通用任务编排 + `/coding-pipeline` 受控编码管道，含 6 个配套子智能体。模型不写死，回退会话默认模型 |
| [pstack](plugins/pstack/) | 0.1.0 | `skills/` | poteto 风格 agent 工作流栈（第三方移植）：`poteto-mode` 作为路由入口调度 architect / arena / interrogate / thermos / unslop 等 63 个 skill，含 24 条 principle 原则、14 个子智能体与会话启动 hook |

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
│   ├── mcp/server.mjs        # 零依赖 Node 实现，8 个 worktree 工具
│   ├── skills/worktree-manager/    # 标准 skill：何时建、怎么交接、何时能删
│   ├── test/smoke.mjs        # ↓ 一次性 git 仓库上的端到端冒烟测试
│   └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
├── agent-pipelines/
│   ├── plugin.json           # 标准清单
│   ├── skills/               # 标准 skill：ralph-pipeline / coding-pipeline
│   ├── commands/  agents/    # ↓ 客户端约定，非 Agent Plugins 核心
│   └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
└── pstack/
    ├── plugin.json           # 标准清单
    ├── skills/               # 标准 skill：63 个（poteto-mode / 24 principle-* / 工作流）
    ├── agents/  effort-agents/  hooks/  models.json   # ↓ 客户端约定，非 Agent Plugins 核心
    ├── NOTICE-PORT.md  LICENSE*                       # 第三方 MIT 作品的署名与许可，不可删
    └── .zcode-plugin/  .codex-plugin/  .omp-plugin/   # ↓ 宿主兼容垫片，非标准
```

根 `plugin.json` 的顶层字段受规范封闭约束，只有：`$schema`、`name`（前两项必填）、`version`、`description`、`author`（`{name, email, url}` 对象）、`homepage`、`repository`、`license`、`keywords`、`extensions`。组件路径不写在这里——放进去会被判为未知字段（报告并忽略，不致命但无意义）。

规范还强制**路径隔离**：插件内所有相对路径必须解析在插件根目录内。

### 非标准部分说明

Agent Plugins 只规范化 skills 与 MCP 两类组件，以下内容超出标准，兼容客户端会忽略，但本仓库仍保留以服务实际使用的宿主：

| 内容 | 状态 | 谁在用 |
|------|------|--------|
| `plugins/*/hooks/hooks.json` | 客户端约定（非标准） | Claude Code / ZCode 等支持 Claude 式 hook 的宿主，用 `${CLAUDE_PLUGIN_ROOT}` 定位插件根 |
| `plugins/agent-pipelines/commands/`、`agents/` | 客户端约定（非标准） | 支持斜杠命令与子智能体的宿主 |
| `plugins/pstack/agents/`、`effort-agents/`、`hooks/` | 客户端约定（非标准） | 支持子智能体 / Claude 式 hook 的宿主；session hook 读 `~/.claude/pstack-models.md`，含 `session hook: off` 即不注入路由令 |
| `plugins/*/.zcode-plugin/plugin.json` | **非标准 ZCode 兼容垫片** | ZCode；提供内联 `mcpServers` 与 `userConfig` 设置页 |
| `plugins/*/.codex-plugin/plugin.json` | **非标准 Codex 兼容垫片** | Codex；声明 `skills` / `mcpServers` / `hooks` 与 `interface` 展示信息 |
| `plugins/*/.omp-plugin/plugin.json` | **非标准 Oh My Pi 兼容垫片** | Oh My Pi（`omp`）；声明 `skills` / `agents` / `commands` 与内联 `mcpServers` |
| 根 `marketplace.json` | **非标准 ZCode 兼容垫片** | ZCode 的 `/plugin marketplace add` 发现入口 |
| 根 `.agents/plugins/marketplace.json` | **非标准 Codex 兼容垫片** | Codex 的市场发现入口（Codex 市场 schema：`name` / `interface` / `plugins[]`，条目不带版本） |
| 根 `.omp-plugin/marketplace.json` | **非标准 Oh My Pi 兼容垫片** | Oh My Pi 的市场目录（`name` / `owner` / `plugins[]`，条目带版本） |

保留垫片是为了**不破坏 ZCode 现有的安装方式**。严格意义上一个包内有且仅有一个 `plugin.json`，垫片那份会让包不再是纯粹的单清单形态——这是为兼容性做的自觉取舍，不是疏忽。

## 安装

### Agent Plugins 兼容客户端（VS Code / Cursor / Copilot / Kiro / OpenClaw 等）

直接加载插件目录：

```
plugins/systemone-decision
plugins/worktree-ops
plugins/agent-pipelines
plugins/pstack
```

各客户端的分发入口以其自身文档为准（规范刻意不规定分发机制）。

### ZCode

```
/plugin marketplace add zerosloney/master0071-plugins-market
/plugin install systemone-decision@master0071-plugins
/plugin install worktree-ops@master0071-plugins
/plugin install agent-pipelines@master0071-plugins
/plugin install pstack@master0071-plugins
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
```

Codex 侧只加载 `skills/`、`mcp.json` 与清单内声明的 `hooks`；`commands/`、`agents/`、`effort-agents/` 是 Claude 式宿主的约定，Codex 不加载。

### Oh My Pi（omp）

仓库根的 `.omp-plugin/marketplace.json` 是 Oh My Pi 的市场目录，登记一次即可：

```
omp plugin marketplace add E:\Demo\cli-tools\master0071-pluigns-market
omp plugin install pstack@master0071-plugins
omp plugin install agent-pipelines@master0071-plugins
omp plugin install systemone-decision@master0071-plugins
omp plugin install worktree-ops@master0071-plugins
```

市场目录有缓存，仓库改动后用 `omp plugin marketplace update master0071-plugins` 刷新；`omp plugin upgrade` 会把已装插件升到目录里的版本。

Oh My Pi 侧与 Codex 不同：它**会加载 `agents/` 与 `commands/`**（caveman 插件即如此），但**不加载 `hooks/`**——所以 pstack 在 omp 上没有会话启动自动路由，手动叫 `poteto-mode` 即可。

> 垫片与标准清单的版本必须一致，发版前用 `node scripts/release.mjs --check` 校验。

## 配置

四个插件都不需要任何私有配置。systemone-decision 首次使用需设置 API Key——`mcp.json` 里不写任何凭据，Key 只从环境变量读（各宿主都没有安全的凭据存储）：

```
setx SYSTEMONE_API_KEY "你的Key"
```

端点 / 模型 / 超时 / 自定义场景 / 审计日志 / 缓存 TTL 全部可选，完整说明见[插件 README](plugins/systemone-decision/README.md)。

agent-pipelines 无需配置：模型不写死，回退宿主会话默认模型。

worktree-ops 无需凭据，根目录须先配置（未配置时 `worktree_create` 拒绝创建）。要改位置有三层，按优先级从高到低：环境变量 `WORKTREE_ROOT` / `WORKTREE_BASE_REF` / `WORKTREE_BRANCH_PREFIX` / `WORKTREE_STALE_DAYS`，配置文件里的单仓库覆盖（会话里调 `worktree_set_root`），配置文件里的全局值。配置文件默认落在 `%APPDATA%\worktree-ops\config.json`（macOS / Linux 为 `~/.config/worktree-ops/config.json`），用 `WORKTREE_CONFIG_HOME` 可整体改路径；ZCode 上这四项已映射进插件设置页。完整说明见[插件 README](plugins/worktree-ops/README.md)。

pstack 无需配置也不需要凭据：模型分工由 `setup-pstack` skill 写入 `~/.claude/pstack-models.md`，会话 hook 读它决定是否注入路由令。pstack 是第三方 MIT 作品的移植（原作者 Lauren Tan / poteto，移植版 Michael Denyer），署名链见 [pstack/NOTICE-PORT.md](plugins/pstack/NOTICE-PORT.md)，再分发时那几份 LICENSE 不可删。

## 维护

- **发版**：`node scripts/release.mjs <plugin> <x.y.z>`，同步该插件的各版本位（根 `plugin.json`、ZCode 垫片两处、市场条目，systemone-decision 还含 `mcp/server.mjs` 的 `SERVER_INFO`）；`node scripts/release.mjs --check` 校验全部一致。
- **新增插件**：在 `plugins/` 下建目录，至少写一份根 `plugin.json`（含 `$schema` 与 `name`），按需加 `skills/` 与 `mcp.json`，并在 `scripts/release.mjs` 的 `PLUGINS` 中登记；若需要在 ZCode 可装，再补 `.zcode-plugin/plugin.json` 与根 `marketplace.json` 条目。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  ```

  worktree-ops 的 `node test/smoke.mjs` 在系统临时目录里造一次性 git 仓库，跑完全部断言后自动清理，同样不需要真实仓库或凭据。
