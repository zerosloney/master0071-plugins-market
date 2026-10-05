# master0071-plugins

个人维护的 ChatGPT Codex / ZCode / CodeBuddy 插件市场（marketplace），并附带 Qwen Code / oh-my-pi(omp) 适配。

- **ZCode**：读取仓库根目录的 `marketplace.json`（内联插件清单）
- **ChatGPT Codex**：读取仓库根目录的 `.agents/plugins/marketplace.json`；插件使用 `.codex-plugin/plugin.json` 清单
- **CodeBuddy**：兼容 Claude 插件清单格式，读取仓库根目录的 `.codebuddy-plugin/marketplace.json`；插件使用 `.codebuddy-plugin/plugin.json` 清单
- **Qwen Code**：市场机制复用 Claude 清单格式，读取仓库根目录的 `.claude-plugin/marketplace.json` 并转换安装（市场条目即权威清单）
- **omp**：兼容 Claude 插件清单格式，但固定读 `.omp-plugin/marketplace.json`

## 插件列表

| 插件 | 版本 | 简介 |
|------|------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.4.9 | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 11 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持设置页自定义场景，附需求明确度预检 hook |
| [agent-pipelines](plugins/agent-pipelines/) | 0.1.0 | 多代理编排管道套件：/ralph-pipeline 通用任务编排（TaskList + 背压熔断 + 状态持久化）+ /coding-pipeline 受控编码管道（scope 零容忍、根因分组修复、真实验证），含 6 个子智能体（ZCode 独占） |

字段说明、用法示例、判据覆盖、供应商切换等完整文档见[插件 README](plugins/systemone-decision/README.md)。

## 安装

### ChatGPT Codex

在 Codex 桌面端打开本仓库，重启应用后，在 Plugins Directory 中选择 `master0071 Plugins` 并安装 `SystemOne Decision`。也可通过 Codex CLI 注册市场：

```sh
codex plugin marketplace add zerosloney/master0071-plugins-market
```

插件使用本机 Node.js（≥18）运行 MCP server。首次使用前配置 `SYSTEMONE_API_KEY`；端点、模型、超时和自定义场景也可通过 `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS` 配置。市场项和 `.codex-plugin/plugin.json` 分别提供发现入口与插件组件声明。

### ZCode

```
/plugin marketplace add zerosloney/master0071-plugins-market
/plugin install systemone-decision@master0071-plugins
```

本地开发也可直接指向目录：

```
/plugin marketplace add E:\Demo\cli-tools\master0071-pluigns-market
```

插件默认接入 unisound u2-decision，需要先配置 API Key（设置页不支持敏感值，走环境变量），设置后重启 ZCode 生效：

```
setx SYSTEMONE_API_KEY "你的Key"
```

端点 / 模型 / 超时可在 **设置 → 插件管理 → 已安装 → SystemOne Decision → Advanced** 配置，无需环境变量。

### oh-my-pi（omp）

omp 兼容 Claude 插件清单格式，但市场清单固定读 `.omp-plugin/marketplace.json`（本仓库已内置），并读 `.omp-plugin/plugin.json` 获取 MCP 声明：

```
/marketplace add zerosloney/master0071-plugins-market
/marketplace install systemone-decision@master0071-plugins
```

或 CLI：`omp plugin marketplace add zerosloney/master0071-plugins-market && omp plugin install systemone-decision@master0071-plugins`。

omp 没有插件设置页，配置全部走环境变量（stdio 进程自动继承）：`SYSTEMONE_API_KEY` / `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS`，自定义场景用 `SYSTEMONE_SCENARIOS`。注意：需求明确度预检 hook（Claude 式 `hooks/hooks.json`）在 omp 下不生效——omp 的 hook 是 `hooks/pre|post/` 下的 JS 工厂模块，格式不同。

### CodeBuddy

CodeBuddy Code 兼容 Claude 插件清单格式，市场清单读仓库根 `.codebuddy-plugin/marketplace.json`，插件清单读插件目录 `.codebuddy-plugin/plugin.json`：

```sh
codebuddy plugin marketplace add zerosloney/master0071-plugins-market
codebuddy plugin install systemone-decision@master0071-plugins
```

或在 CodeBuddy 会话内执行 `/plugin marketplace add zerosloney/master0071-plugins-market` 后按提示安装。

API Key 仍走环境变量 `SYSTEMONE_API_KEY`；端点 / 模型 / 超时 / 自定义场景四项在启用插件时按 `userConfig` 提示填写即可（留空回退环境变量 `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS`）。需求明确度预检 hook 复用 `hooks/hooks.json`（`${CLAUDE_PLUGIN_ROOT}` 变量 CodeBuddy 兼容展开）。

### Qwen Code

Qwen Code 的市场机制复用 Claude 清单格式：读取仓库根 `.claude-plugin/marketplace.json`，按 `仓库:插件名` 选择条目并转换为本地扩展安装（`strict: false`，市场条目即权威清单，组件随转换拷入扩展包）：

```sh
qwen extensions install zerosloney/master0071-plugins-market:systemone-decision
```

- **systemone-decision**：skills + 内联 MCP server 声明。需求明确度预检 hook 在 Qwen 下不注册（Qwen 无插件根变量替换，`${CLAUDE_PLUGIN_ROOT}` 会留在命令里），配置走 `SYSTEMONE_*` 环境变量。

## 仓库结构

```
.agents/plugins/marketplace.json  ChatGPT Codex 仓库级插件市场清单
marketplace.json           ZCode 市场清单（市场名 master0071-plugins）
.codebuddy-plugin/marketplace.json  CodeBuddy 市场清单（Claude 插件清单格式）
.claude-plugin/marketplace.json  Qwen Code 市场清单（Claude 格式转换安装）
plugins/
└── systemone-decision/    插件包（ChatGPT Codex / ZCode / CodeBuddy / Qwen Code / omp 五端共用载荷）
    ├── .zcode-plugin/     ZCode 清单（内联 mcpServers + 设置页 userConfig）
    ├── .codex-plugin/     ChatGPT Codex 清单（指向下方 systemone.mcp.json）
    ├── .codebuddy-plugin/ CodeBuddy 清单（内联 mcpServers + userConfig 提示配置）
    ├── systemone.mcp.json ChatGPT Codex 的 MCP 声明
    ├── mcp/               stdio MCP 服务器（零依赖，Node ≥ 18）
    ├── skills/            使用指引与场景文档
    ├── hooks/             需求明确度预检（判定内核 clarity.mjs 全端共用）
    └── test/              冒烟测试（本地 mock 端点，无需真实 Key）
```

同一插件包内并存多份清单，各产品只认自己那份，业务载荷（`mcp/*.mjs`、`skills/`、`hooks/clarity.mjs`）完全共享。细节见插件 README 的「多端支持」一节。

## 维护

- **新增插件**：在 `plugins/` 下建目录，并分别在 ZCode 的 `marketplace.json`、CodeBuddy 的 `.codebuddy-plugin/marketplace.json`、omp 的 `.omp-plugin/marketplace.json`、Qwen Code 的 `.claude-plugin/marketplace.json` 与 ChatGPT Codex 的 `.agents/plugins/marketplace.json` 登记插件来源；各市场字段按对应格式填写。
- **发布新版本**：运行 `node scripts/release.mjs <plugin> <x.y.z>`（如 `node scripts/release.mjs systemone-decision 0.5.0`），按插件同步各自版本位，各插件版本独立演进；`node scripts/release.mjs --check` 校验所有插件一致性。改完提交推送，客户端更新插件即拉到新版。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  ```
