# master0071-plugins

个人维护的 ChatGPT Codex / ZCode / MiniMax Code / Dim / CodeBuddy 插件市场（marketplace），并附带 opencode / oh-my-pi(omp) 适配。

- **ZCode**：读取仓库根目录的 `marketplace.json`（内联插件清单）
- **MiniMax Code**：以 git 仓库指针注册本市场（其数据目录下的 `known_marketplaces.json`）
- **ChatGPT Codex**：读取仓库根目录的 `.agents/plugins/marketplace.json`；插件使用 `.codex-plugin/plugin.json` 清单
- **Dim**：同样使用 `plugins/systemone-decision/.codex-plugin/plugin.json` 自描述清单，整个插件目录可直接加载
- **CodeBuddy**：兼容 Claude 插件清单格式，读取仓库根目录的 `.codebuddy-plugin/marketplace.json`；插件使用 `.codebuddy-plugin/plugin.json` 清单
- **opencode**：**没有市场概念**，直接按 npm/git 包安装 `plugins/systemone-decision`（自带 `package.json` 入口），市场清单文件对它无效
- **omp**：兼容 Claude 插件清单格式，但固定读 `.omp-plugin/marketplace.json`

## 插件列表

| 插件 | 版本 | 简介 |
|------|------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.4.8 | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 11 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持设置页自定义场景，附需求明确度预检 hook |

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
/plugin marketplace add D:\code\master0071-plugins-market
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

### MiniMax Code

将本仓库 git 地址（`https://github.com/zerosloney/master0071-plugins-market`）加入 MiniMax Code 的插件市场（`known_marketplaces.json`）后安装。MiniMax Code 没有插件设置页，所有配置改用环境变量：`SYSTEMONE_API_KEY` / `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS`。

### opencode

opencode **没有插件市场**，只有 `plugins` 数组（npm 包名 / git spec / 本地路径）。所以本仓库的市场清单对它无效，改为直接装插件包。

装法有个坑：opencode 的 `plugin add` 走 bun 的 npm 兼容层，**git spec 的 `::path:` 子目录选择器会被静默忽略**（加不加根 `package.json` 都一样：没有就报 `ENOENT ... git-cloneXXX/package.json`，有了就把整个仓库根当成包装下来，`::path:` 静默失效）。因此**仓库根必须本身是一个包**，`main` 指向插件入口（见根 `package.json`）：

```sh
opencode plugin add github:zerosloney/master0071-plugins-market
```

装下来的是整个仓库（含 `marketplace.json` / `plugins/` / `test/`），无害但不精简。零依赖，`main` 解析进子目录由标准 Node 解析完成，`index.mjs` 用 `import.meta.url` 定位自己的目录，所以 `mcp/`、`skills/` 路径不受影响。

本地开发用路径更省事（改完 `opencode service restart` 生效），这样只挂插件目录、不带市场清单：

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["E:/Demo/cli-tools/master0071-plugins-market/plugins/systemone-decision"]
}
```

`index.mjs` 的 `setup` 一次注册三样东西，业务载荷与另外两端共用：

| 注册内容 | opencode API | 说明 |
| --- | --- | --- |
| stdio MCP server | `ctx.mcp.transform` | 跑同一份 `mcp/server.mjs`；工具名不变，opencode 暴露为 `tools.systemone.systemone_scenario` 等 |
| skill | `ctx.skill.transform` | 复用 `skills/systemone-decision/SKILL.md` |
| 需求明确度预检 | `ctx.session.hook("prompt", ...)` | opencode 没有 Claude 式 `hooks/hooks.json`，`UserPromptSubmit` 的等价物就是 prompt hook |

配置：opencode 同样没有插件设置页，`plugins[].options` 是等价入口（`base_url` / `model` / `timeout_ms` / `scenarios` 四个键），不传就用环境变量 `SYSTEMONE_API_KEY` / `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS`：

```jsonc
{
  "plugins": [
    {
      "package": "github:zerosloney/master0071-plugins-market",
      "options": { "base_url": "https://maas-api.unisound.com/v1", "model": "u2-decision" }
    }
  ]
}
```

`options` 会被映射回服务端本来就认的 `SYSTEMONE_PLUGIN_*`，取值链（设置项 > 环境变量 > 内置默认）与 ZCode 端完全一致。API Key 不在 `options` 里，仍只走环境变量。

### Dim

Dim 没有市场清单概念，插件是自描述目录——把 `plugins/systemone-decision` 整个目录放进任一插件根即可，Dim 扫描时读取 `.codex-plugin/plugin.json` 并加载其组件：

- **MCP server**：`systemone.mcp.json` 声明，复用同一份 `mcp/server.mjs`，工具名为 `systemone_scenario` / `systemone_decide`
- **skill**：`skills/systemone-decision/SKILL.md` 自动发现
- **需求明确度预检**：`hooks/hooks.json` 的 `UserPromptSubmit` hook（Claude 式命令 hook，Dim 原生支持）

本地开发可直接用目录路径安装；要分享则把仓库推到 git，在 Dim 桌面端 **Plugins → Add plugin** 粘贴仓库地址（`owner/repo` 或完整 git URL，可带 ref），Dim 会克隆仓库并安装到 `<DIMCODE_HOME>/plugins/systemone-decision/`。

Dim 没有插件设置页，配置走环境变量（stdio 进程自动继承）：`SYSTEMONE_API_KEY` / `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS`。注意 API Key 只走环境变量，不写入清单。

### CodeBuddy

CodeBuddy Code 兼容 Claude 插件清单格式，市场清单读仓库根 `.codebuddy-plugin/marketplace.json`，插件清单读插件目录 `.codebuddy-plugin/plugin.json`：

```sh
codebuddy plugin marketplace add zerosloney/master0071-plugins-market
codebuddy plugin install systemone-decision@master0071-plugins
```

或在 CodeBuddy 会话内执行 `/plugin marketplace add zerosloney/master0071-plugins-market` 后按提示安装。

API Key 仍走环境变量 `SYSTEMONE_API_KEY`；端点 / 模型 / 超时 / 自定义场景四项在启用插件时按 `userConfig` 提示填写即可（留空回退环境变量 `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS`）。需求明确度预检 hook 复用 `hooks/hooks.json`（`${CLAUDE_PLUGIN_ROOT}` 变量 CodeBuddy 兼容展开）。

## 仓库结构

```
.agents/plugins/marketplace.json  ChatGPT Codex 仓库级插件市场清单
marketplace.json           ZCode 市场清单（市场名 master0071-plugins）
.codebuddy-plugin/marketplace.json  CodeBuddy 市场清单（Claude 插件清单格式）
package.json               opencode 装整个仓库时的包入口（main 指向下方 index.mjs）
plugins/
└── systemone-decision/    插件包（ChatGPT Codex / ZCode / MiniMax Code / opencode / omp / Dim / CodeBuddy 七端共用载荷）
    ├── .zcode-plugin/     ZCode 清单（内联 mcpServers + 设置页 userConfig）
    ├── .minimax-plugin/   MiniMax Code 清单
    ├── .codex-plugin/     ChatGPT Codex / Dim 兼容清单（指向下方 systemone.mcp.json）
    ├── .codebuddy-plugin/ CodeBuddy 清单（内联 mcpServers + userConfig 提示配置）
    ├── package.json       本地路径安装时的包入口
    ├── index.mjs          opencode 适配入口（注册 MCP + skill + prompt hook）
    ├── systemone.mcp.json MiniMax / Dim 的 MCP 声明
    ├── mcp/               stdio MCP 服务器（零依赖，Node ≥ 18）
    ├── skills/            使用指引与场景文档
    ├── hooks/             需求明确度预检（清单两端分开；判定内核 clarity.mjs 全端共用）
    └── test/              冒烟测试（本地 mock 端点，无需真实 Key）
```

同一插件包内并存多份清单，各产品只认自己那份，业务载荷（`mcp/*.mjs`、`skills/`、`hooks/clarity.mjs`）完全共享。细节见插件 README 的「多端支持」一节。

## 维护

- **新增插件**：在 `plugins/` 下建目录，并分别在 ZCode 的 `marketplace.json`、CodeBuddy 的 `.codebuddy-plugin/marketplace.json`、omp 的 `.omp-plugin/marketplace.json` 与 ChatGPT Codex 的 `.agents/plugins/marketplace.json` 登记插件来源；各市场字段按对应格式填写。
- **发布新版本**：运行 `node scripts/release.mjs <x.y.z>`，一键同步 11 处版本号（根 `marketplace.json`、`.omp-plugin/marketplace.json`、`.codebuddy-plugin/marketplace.json` 三份市场清单；五份 plugin.json——ZCode / MiniMax / omp / CodeBuddy 各一份，ChatGPT Codex / Dim 共用 Codex 兼容清单；两份 `package.json`；`mcp/server.mjs` 的 `SERVER_INFO`），只改版本行不重排格式；`node scripts/release.mjs --check` 仅校验一致性。改完提交推送，客户端更新插件即拉到新版。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  node test/opencode.smoke.mjs
  ```
