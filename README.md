# master0071-plugins

个人维护的 ZCode / MiniMax Code / Dim / Qoder 插件市场（marketplace），并附带 opencode / oh-my-pi(omp) 适配。

- **ZCode**：读取仓库根目录的 `marketplace.json`（内联插件清单）
- **MiniMax Code**：以 git 仓库指针注册本市场（其数据目录下的 `known_marketplaces.json`）
- **Dim**：`plugins/systemone-decision/.codex-plugin/plugin.json` 是自描述清单，整个插件目录可直接被 Dim 加载
- **Qoder / Qoder CN**：市场清单读 `.qoder-plugin/marketplace.json`（优先于根 `marketplace.json`），插件清单读 `plugins/systemone-decision/.qoder-plugin/plugin.json`。两端是同一份代码、同一套清单格式，只有数据目录不同（`~/.qoder` 与 `~/.qoder-cn`），装法完全一致
- **opencode**：**没有市场概念**，直接按 npm/git 包安装 `plugins/systemone-decision`（自带 `package.json` 入口），市场清单文件对它无效
- **omp**：兼容 Claude 插件清单格式，但固定读 `.omp-plugin/marketplace.json`

## 插件列表

| 插件 | 版本 | 简介 |
|------|------|------|
| [systemone-decision](plugins/systemone-decision/) | 0.4.7 | SystemOne 决策模型工具集：只注册 2 个 MCP 工具控制 schema 开销，内置 11 个业务场景（工单分流、内容审核、Agent 路由、结果校验、软件开发判定等），返回概率化判定、归一化决策与处置建议，支持设置页自定义场景，附需求明确度预检 hook |

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

### Qoder / Qoder CN

Qoder（国际版，数据目录 `~/.qoder`）与 Qoder CN（国内版，`~/.qoder-cn`）是同一份插件引擎，清单格式、市场文件名、装法完全一致，只是数据目录不同——下面一套在两端通用。市场清单读仓库根的 `.qoder-plugin/marketplace.json`（Qoder 的读取顺序是 `.qoder-plugin/` → `.claude-plugin/` → 根 `marketplace.json`，我们单开一份，是因为根那份的描述写着"ZCode 设置页"，对 Qoder 端用户是误导）。

**桌面端没有 CLI**：`/marketplace add`、`/plugins install` 在 Qoder / Qoder CN 的聊天框里不是真命令，只会以纯文本落到模型。市场源注册的等效做法是往 `<数据目录>/settings.json` 写 `extraKnownMarketplaces`，其余（克隆到 `plugins/marketplaces/<市场名>/`、写 `plugins/known_marketplaces.json`）由引擎自己做：

```jsonc title="~/.qoder-cn/settings.json"
{ "extraKnownMarketplaces": { "master0071-plugins": { "source": { "source": "github", "repo": "zerosloney/master0071-plugins-market" } } } }
```

**但只走市场这条路，插件的 MCP server 不会注册**——skill 和 hook 正常挂载，`mcpServers` 被无声丢掉。原因是两端各挡一刀：

- 桌面端的 MCP 运行时池只从 `plugins/installed_plugins_v2.json` 的登记项构建（`[PluginInventory] Plugin inventory refreshed` 里的 `pluginCount` 就是它的条目数）。git 市场是 `zip_cache_mode=false`，插件**就地**从 `plugins/marketplaces/…` 加载、不进那份登记项，于是桌面端根本不知道有这么个 MCP server。
- worker 侧本来能自己 spawn 清单内联的 server，但桌面端启动它时带 `--strict-mcp-config` 且不带 `--allow-plugin-mcp`，`pluginMcpServersEnabled = !strictMcpConfig || allowPluginMcp === true` 直接为 false。

所以要装成完整可用，得按 Qoder 自己「创建本地 Plugin」的口径登记（`settings.json` 的 `enabledPlugins` 早已就位，缺的是登记项 + 副本）：

```powershell
# 1) 把插件目录放到缓存安装位（cache/<市场名>/<插件名>/<版本>）
Copy-Item -Recurse plugins/systemone-decision `
  "$env:USERPROFILE\.qoder-cn\plugins\cache\master0071-plugins\systemone-decision\0.4.7"
```

```jsonc title="~/.qoder-cn/plugins/installed_plugins_v2.json（plugins 里加一条）"
"systemone-decision@master0071-plugins": [
  { "scope": "user",
    "installPath": "C:\\Users\\<你>\\.qoder-cn\\plugins\\cache\\master0071-plugins\\systemone-decision\\0.4.7",
    "version": "0.4.7", "installedAt": "<ISO 时间>", "displayName": "SystemOne Decision" }
]
```

写完**不用重启整个 App**：桌面端监听 `installed_plugins_v2.json`（日志 `reason:"watched-plugin-registry-changed"`），inventory 刷新后会重新解析清单 `mcpServers` 并拉起 stdio 进程（`[MCP] MCP runtime state changed … status:"ready"`），**新开一个会话**即可在启动参数里看到 `plugin:systemone-decision:systemone`，工具名变成 `mcp__plugin_systemone-decision_systemone__systemone_scenario` / `…__systemone_decide`。已开着的会话读的是陈旧快照，看不到。

去重按插件**名字**：登记项先加载，`plugins/marketplaces/…` 那份就地副本会被跳过，所以 skill 和 hook 不会挂两份（`plugin_root` 会变成缓存路径）。副本是静态的——市场 `autoUpdate` 只更新 `marketplaces/` 那份，发新版要重新拷一次缓存目录并同步登记项里的 `version` / `installPath`。

组件由 `plugins/systemone-decision/.qoder-plugin/plugin.json` 一次声明齐三样，业务载荷与其他各端共用同一份：

| 组件 | 声明方式 | 说明 |
| --- | --- | --- |
| stdio MCP server | 清单内联 `mcpServers` | 跑同一份 `mcp/server.mjs`，工具名 `systemone_scenario` / `systemone_decide` |
| skill | `skills: "./skills/"` | 复用 `skills/systemone-decision/SKILL.md` |
| 需求明确度预检 | `hooks: "./hooks/hooks.json"` | Claude 式 `UserPromptSubmit` 命令 hook，Qoder 原生支持，与 ZCode / Dim 共用同一份文件 |

三个坑位由清单写法规避掉，改动清单时别退回去：

- **脚本路径必须走插件根变量**。Qoder 只替换 `${QODER_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`，**不解析相对路径**：`./mcp/server.mjs` 能不能命中，取决于宿主给子进程的 cwd，插件不能指望。`systemone.mcp.json` 那种相对路径写法服务的是 MiniMax / Dim（它们自己按插件根解析），所以 Qoder 清单把 server 内联写成 `${QODER_PLUGIN_ROOT}/mcp/server.mjs`。
- **`env_vars` 必须显式列出 `SYSTEMONE_*`**。桌面端 spawn 插件 MCP 子进程时，env 只装 `QODER_PLUGIN_ROOT` / `QODER_PLUGIN_DATA`（含 CLAUDE 别名）+ 清单里 `env_vars` 点名的那几个进程环境变量，**不整份继承**。不写 `env_vars`，`SYSTEMONE_API_KEY` 到不了 server，工具会带着默认端点去请求然后 401。
- **不用 `${user_config.X}`**。Qoder 的 `settings.json → pluginConfigs` 确实能往清单里注入自定义值，但占位符只在用户**已经为该插件写过配置项**时才替换；没写过就整段原样留在 env 里，`SYSTEMONE_BASE_URL` 会变成字面量 `${user_config.base_url}`，把取值链（设置项 > 环境变量 > 内置默认）打断。MiniMax / omp / Dim 同样没有可用的插件设置页，四端一起走环境变量，不搞一端特例。

配置：环境变量 `SYSTEMONE_API_KEY` / `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS`。hook 子进程由 worker 直接 spawn，整份继承进程环境；插件 MCP 的 stdio 子进程由桌面端 spawn，只拿到清单 `env_vars` 点名的那几个（见上一条坑位）。Windows 用 `setx` 设置后重启 Qoder 才进得了新进程环境。`node` 需在 PATH 上（清单里 `command: "node"`，宿主直接 exec）。API Key 只走环境变量，不写入清单。

## 仓库结构

```
marketplace.json           市场清单（ZCode 读取，市场名 master0071-plugins）
.qoder-plugin/
└── marketplace.json       Qoder / Qoder CN 市场清单（Qoder 优先读它，描述按 env 配置口径写）
package.json               opencode 装整个仓库时的包入口（main 指向下方 index.mjs）
plugins/
└── systemone-decision/    插件包（ZCode / MiniMax Code / opencode / omp / Dim / Qoder 六端共用载荷）
    ├── .zcode-plugin/     ZCode 清单（内联 mcpServers + 设置页 userConfig）
    ├── .minimax-plugin/   MiniMax Code 清单
    ├── .codex-plugin/     Dim 清单（自描述清单，指向下方 systemone.mcp.json）
    ├── .qoder-plugin/     Qoder / Qoder CN 清单（内联 mcpServers，脚本路径写 ${QODER_PLUGIN_ROOT}）
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

- **新增插件**：在 `plugins/` 下建目录，并在 `marketplace.json` 的 `plugins` 数组登记 `name` / `source` / `version` / 描述（含 `displayName_i18n` / `description_i18n`）。
- **发布新版本**：运行 `node scripts/release.mjs <x.y.z>`，一键同步 11 处版本号（三份市场清单——根 `marketplace.json`、`.omp-plugin/marketplace.json`、`.qoder-plugin/marketplace.json` 的插件条目；五份 plugin.json——ZCode / MiniMax / omp / Dim / Qoder；两份 `package.json`；`mcp/server.mjs` 的 `SERVER_INFO`），只改版本行不重排格式；`node scripts/release.mjs --check` 仅校验一致性。改完提交推送，客户端更新插件即拉到新版。
- **测试**（插件目录下执行，不需要真实 API Key）：

  ```
  node test/smoke.mjs
  node test/hook.smoke.mjs
  node test/opencode.smoke.mjs
  node test/qoder.smoke.mjs
  ```
