# master0071-plugins

个人维护的 ZCode / MiniMax Code 插件市场（marketplace）。

- **ZCode**：读取仓库根目录的 `marketplace.json`（内联插件清单）
- **MiniMax Code**：以 git 仓库指针注册本市场（其数据目录下的 `known_marketplaces.json`）

## 插件列表

| 插件 | 版本 | 简介 |
|------|------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.3.1 | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 11 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持设置页自定义场景，附需求明确度预检 hook |

字段说明、用法示例、判据覆盖、供应商切换等完整文档见[插件 README](plugins/systemone-decision/README.md)。

## 安装

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

## 仓库结构

```
marketplace.json           市场清单（ZCode 读取，市场名 master0071-plugins）
plugins/
└── systemone-decision/    插件包（ZCode 与 MiniMax Code 双格式共存）
    ├── .zcode-plugin/     ZCode 清单（内联 mcpServers + 设置页 userConfig）
    ├── .minimax-plugin/   MiniMax Code 清单
    ├── systemone.mcp.json MiniMax 的 MCP 声明
    ├── mcp/               stdio MCP 服务器（零依赖，Node ≥ 18）
    ├── skills/            使用指引与场景文档
    ├── hooks/             需求明确度预检 hook（两端清单分开，脚本共享）
    └── test/              冒烟测试（本地 mock 端点，无需真实 Key）
```

同一插件包内并存两份清单，各产品只认自己那份，业务载荷（`mcp/*.mjs`、`skills/`、`hooks/*.mjs`）完全共享。细节见插件 README 的「同时支持 ZCode 与 MiniMax Code」一节。

## 维护

- **新增插件**：在 `plugins/` 下建目录，并在 `marketplace.json` 的 `plugins` 数组登记 `name` / `source` / `version` / 描述（含 `displayName_i18n` / `description_i18n`）。
- **发布新版本**：运行 `node scripts/release.mjs <x.y.z>`，一键同步 6 处版本号（`marketplace.json` 与 `.omp-plugin/marketplace.json` 插件条目、三份 plugin.json、`mcp/server.mjs` 的 `SERVER_INFO`），只改版本行不重排格式；`node scripts/release.mjs --check` 仅校验一致性。改完提交推送，客户端更新插件即拉到新版。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  ```
