# master0071-plugins

两个按 **[Agent Plugins 1.0.0](https://agent-plugins.org) 开放标准**打包的个人插件。一次打包，所有兼容客户端通用。

| 插件 | 版本 | 可移植组件 | 简介 |
|------|------|-----------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.5.1 | `skills/` + `mcp.json` | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 15 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持自定义场景 |
| [agent-pipelines](plugins/agent-pipelines/) | 0.1.0 | `skills/` | 多代理编排管道套件：`/ralph-pipeline` 通用任务编排 + `/coding-pipeline` 受控编码管道，含 6 个配套子智能体。模型不写死，回退会话默认模型 |

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
│   └── .zcode-plugin/        # ↓ ZCode 兼容层，非标准
└── agent-pipelines/
    ├── plugin.json           # 标准清单
    ├── skills/               # 标准 skill：ralph-pipeline / coding-pipeline
    ├── commands/  agents/    # ↓ 客户端约定，非 Agent Plugins 核心
    └── .zcode-plugin/        # ↓ ZCode 兼容层，非标准
```

根 `plugin.json` 的顶层字段受规范封闭约束，只有：`$schema`、`name`（前两项必填）、`version`、`description`、`author`（`{name, email, url}` 对象）、`homepage`、`repository`、`license`、`keywords`、`extensions`。组件路径不写在这里——放进去会被判为未知字段（报告并忽略，不致命但无意义）。

规范还强制**路径隔离**：插件内所有相对路径必须解析在插件根目录内。

### 非标准部分说明

Agent Plugins 只规范化 skills 与 MCP 两类组件，以下内容超出标准，兼容客户端会忽略，但本仓库仍保留以服务实际使用的宿主：

| 内容 | 状态 | 谁在用 |
|------|------|--------|
| `plugins/*/hooks/hooks.json` | 客户端约定（非标准） | Claude Code / ZCode 等支持 Claude 式 hook 的宿主，用 `${CLAUDE_PLUGIN_ROOT}` 定位插件根 |
| `plugins/agent-pipelines/commands/`、`agents/` | 客户端约定（非标准） | 支持斜杠命令与子智能体的宿主 |
| `plugins/*/.zcode-plugin/plugin.json` | **非标准 ZCode 兼容垫片** | ZCode；提供内联 `mcpServers` 与 `userConfig` 设置页 |
| 根 `marketplace.json` | **非标准 ZCode 兼容垫片** | ZCode 的 `/plugin marketplace add` 发现入口 |

保留垫片是为了**不破坏 ZCode 现有的安装方式**。严格意义上一个包内有且仅有一个 `plugin.json`，垫片那份会让包不再是纯粹的单清单形态——这是为兼容性做的自觉取舍，不是疏忽。

## 安装

### Agent Plugins 兼容客户端（VS Code / Cursor / Copilot / Kiro / OpenClaw 等）

直接加载插件目录：

```
plugins/systemone-decision
plugins/agent-pipelines
```

各客户端的分发入口以其自身文档为准（规范刻意不规定分发机制）。

### ZCode

```
/plugin marketplace add zerosloney/master0071-plugins-market
/plugin install systemone-decision@master0071-plugins
/plugin install agent-pipelines@master0071-plugins
```

本地开发直接指向仓库目录：

```
/plugin marketplace add E:\Demo\cli-tools\master0071-pluigns-market
```

> 垫片与标准清单的版本必须一致，发版前用 `node scripts/release.mjs --check` 校验。

## 配置

两个插件都不需要任何私有配置。systemone-decision 首次使用需设置 API Key——`mcp.json` 里不写任何凭据，Key 只从环境变量读（各宿主都没有安全的凭据存储）：

```
setx SYSTEMONE_API_KEY "你的Key"
```

端点 / 模型 / 超时 / 自定义场景 / 审计日志 / 缓存 TTL 全部可选，完整说明见[插件 README](plugins/systemone-decision/README.md)。

agent-pipelines 无需配置：模型不写死，回退宿主会话默认模型。

## 维护

- **发版**：`node scripts/release.mjs <plugin> <x.y.z>`，同步该插件的各版本位（根 `plugin.json`、ZCode 垫片两处、市场条目，systemone-decision 还含 `mcp/server.mjs` 的 `SERVER_INFO`）；`node scripts/release.mjs --check` 校验全部一致。
- **新增插件**：在 `plugins/` 下建目录，至少写一份根 `plugin.json`（含 `$schema` 与 `name`），按需加 `skills/` 与 `mcp.json`，并在 `scripts/release.mjs` 的 `PLUGINS` 中登记；若需要在 ZCode 可装，再补 `.zcode-plugin/plugin.json` 与根 `marketplace.json` 条目。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  ```
