# systemone-decision

五端共用插件（ZCode / MiniMax Code / opencode / omp / Dim）：接入 SystemOne 决策协议（默认 unisound u2-decision）。只注册 **2 个 MCP 工具**，控制工具 schema 的上下文开销，同时通过内置场景库覆盖常用业务判定：

- **场景决策** `systemone_scenario` — `action=list / describe / run`，一次调用返回带概率分布的判定、归一化决策（`decision` / `labels` / `derived`）与处置建议（`recommendation`）
- **自定义决策** `systemone_decide` — 场景库没有的临时判断，直接提交任意 choice / noul / score 问题组合

零依赖 MCP 服务器（stdio），要求 Node ≥ 18。场景库是纯数据（`mcp/scenarios.mjs`），新增场景无需改工具 schema。

## 内置场景（11 个）

每个场景 = 3 个结构化问题，判据可通过 `params` 覆盖为实际业务选项。

| 场景 id | 业务域 | 判定内容 |
| --- | --- | --- |
| `customer_service` | 客服运营 | 归属团队（choice）+ 严重程度（score）+ 是否升级值班（noul），派生 P1~P4 优先级 |
| `content_moderation` | 内容审核 | 处置动作（choice）+ 违规类型（choice）+ 风险等级（score） |
| `agent_routing` | 智能体路由 | 执行 Agent（choice）+ 复杂度（score）+ 是否转人工（noul），派生 S/M/L/XL |
| `result_verification` | 结果校验 | 是否满足要求（noul）+ 主要问题（choice）+ 质量等级（score） |
| `software_dev` | 软件开发 | 任务类型 bugfix/feature/refactor/…（choice）+ 改动复杂度（score）+ 是否先探查代码库（noul），派生 S/M/L/XL |
| `sales_lead` | 销售线索 | 线索质量（score）+ 线索归属（choice）+ 是否跟进（noul） |
| `risk_control` | 金融风控 | 交易异常（score）+ 风险等级（choice）+ 是否人工复核（noul） |
| `recruiting` | 招聘 HR | 简历匹配度（score）+ 岗位归属（choice）+ 是否进入下一轮（noul） |
| `data_governance` | 数据治理 | 文档打标（choice）+ 问题归因（choice）+ 是否敏感数据（noul） |
| `education` | 教育内容 | 知识点归类（choice）+ 难度分级（score）+ 合规预检（noul） |
| `requirements` | 需求与变更 | 优先级（score）+ 变更风险（choice）+ 是否拆分派发（noul） |

场景支持中文别名（如 `工单分流`、`审核`），`action=list` 可用 `keyword` 过滤。

## 用法示例

```
systemone_scenario(action: "run",
                   scenario: "customer_service",
                   state: "订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。")
```

返回（节选）：

```json
{
  "ok": true,
  "scenario": "customer_service",
  "answers":  { "department": { "value": "billing", "confidence": 0.893 }, "…": "逐题明细，含概率分布" },
  "decision": { "department": "billing", "severity": 2, "escalate": true },
  "labels":   { "department": "支付、退款、账单和计费问题", "severity": "核心功能不可用，没有替代方案", "escalate": "是" },
  "derived":  { "priority": "P2" },
  "needs_human_review": false,
  "recommendation": "转 支付、退款、账单和计费问题 处理（优先级 P2）。需立即通知值班人员",
  "summary": "## 客服运营 · 工单派单与分流 …（Markdown 摘要）"
}
```

**判据覆盖**（`params`，按问题 id）：

```jsonc
{
  "action": "run", "scenario": "customer_service", "state": "…",
  "params": {
    // criteria 整体替换选项（choice 传对象，score 传 ≥2 级标签数组）
    "department": { "criteria": { "vip": "VIP 专属通道", "general": "普通通道" } },
    // addCriteria 在默认选项上追加，不丢默认项（仅 choice）
    // 也可覆盖 instructions / label
  }
}
```

接入真实业务时**传入实际可选项比默认值更准**，能用就传。

## 自定义场景（设置页 / 环境变量）

内置场景不够用时，在设置页 **Custom Scenarios (JSON)** 粘贴场景 JSON 数组（可多行），重启 ZCode 生效；**同 id 覆盖内置场景，否则追加**，无需改代码。也可用环境变量 `SYSTEMONE_SCENARIOS`（建议压缩成单行）。示例：

```json
[
  {
    "id": "intent",
    "title": "通用意图识别",
    "description": "把任意输入归类到业务意图。",
    "aliases": ["意图"],
    "questions": {
      "intent": { "type": "choice", "label": "意图", "instructions": "用户这句话最想做什么？",
        "criteria": { "query": "查询/检索信息", "action": "执行一个操作", "create": "新建内容或文件",
                      "modify": "修改已有内容", "analyze": "分析、对比、总结", "explain": "解释原理或概念",
                      "debug": "排查报错或异常", "chat": "闲聊、寒暄", "other": "以上都不是" } },
      "urgency": { "type": "score", "label": "紧急度", "instructions": "这件事有多紧急？",
        "criteria": ["不急", "可以等", "尽快", "马上"] }
    },
    "derive": { "level": { "question": "urgency", "values": ["P4", "P3", "P2", "P1"] } },
    "recommendation": "意图「{intent}」，紧急度 {level}"
  }
]
```

- 字段说明、建议模板语法与校验规则见 `skills/systemone-decision/references/scenarios.md`。
- 校验约束：问题 1~16 个、choice 选项 2~26 个、score 分级 ≥2 级；**非法条目整条跳过并在日志告警**，不影响内置与其余自定义场景；JSON 解析失败则回退纯内置场景库。
- 生效后 `action=list` 可见（标注"自定义"），describe / run 与内置场景无差别。

## 多端支持（ZCode / MiniMax Code / opencode / omp / Dim）

同一个插件包内并存多份清单，各产品只认自己那份，互不遮蔽：

| 文件 | 归属 | 作用 |
|------|------|------|
| `.zcode-plugin/plugin.json` | ZCode | 内联 `mcpServers`、字符串式 `skills`/`hooks`、带 `userConfig` 设置页 |
| `.minimax-plugin/plugin.json` | MiniMax Code | 引用式 `mcpServers`/`skills`/`hooks`，含 `icon`/`category`/`exampleQueries` |
| `systemone.mcp.json` | MiniMax Code / Dim | stdio MCP 声明（ZCode 直接忽略） |
| `.codex-plugin/plugin.json` | Dim | 自描述清单，`mcpServers` 引用 `./systemone.mcp.json`，`hooks` 复用 ZCode 的 `hooks/hooks.json` |
| `hooks/hooks.json` | ZCode / Dim | `${CLAUDE_PLUGIN_ROOT}`，handler timeout 15s |
| `hooks/hooks.minimax.json` | MiniMax Code | `${PLUGIN_ROOT}`，handler timeout 8s（该产品上限为 10s） |
| 仓库根 `package.json` + 本目录 `index.mjs` | opencode | 包入口 + 适配接线（opencode 无市场概念，只能按包安装） |

业务载荷（`mcp/*.mjs`、`skills/`、`hooks/clarity.mjs`）完全共享，各端运行的是同一份代码。hook 清单必须分文件是因为插件根目录变量名不同，且 handler 不支持用相对路径（其 cwd 是会话工作区而非插件目录）；时间预算统一取小值是因为 MiniMax 的 handler 字段不支持 `env`，无法给两端配不同预算。判定内核（门限 / 三问 / 结论文案）抽在 `hooks/clarity.mjs`，Claude 式 stdin/stdout 协议留在 `hooks/requirement-clarity.mjs`，opencode 的注册在 `index.mjs`——各端改同一处门限不会漂移。

**配置差异**：MiniMax Code、opencode 与 Dim 都没有可用的插件设置页。上表四项配置在 opencode 走 `plugins[].options`（同名的 `base_url` / `model` / `timeout_ms` / `scenarios`），在 MiniMax Code、Dim 走 `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS` 环境变量。功能不丢，只是入口不同——服务端取值链本身就是 `SYSTEMONE_PLUGIN_*`（设置项）→ `SYSTEMONE_*`（环境变量）→ 内置默认。

**市场注册**：ZCode 读取仓库根目录的 `marketplace.json`；MiniMax Code 使用数据目录下的 `known_marketplaces.json`，存的是 git 仓库指针而非内联插件列表；omp 读 `.omp-plugin/marketplace.json`；**Dim 没有市场概念**，插件是自描述目录——把本目录放进任一插件根，Dim 读取 `.codex-plugin/plugin.json` 即加载 MCP / skill / hook，也可在桌面端 **Plugins → Add plugin** 粘贴仓库 git 地址安装。**opencode 没有市场概念**，只有 `plugins` 数组，且 `plugin add` 走 bun 的 npm 兼容层——git spec 的 `::path:` 子目录选择器会被静默忽略，所以只能装仓库根本身这个包（根 `package.json` 的 `main` 指向 `plugins/systemone-decision/index.mjs`）：

```sh
opencode plugin add github:zerosloney/master0071-plugins-market
```

`index.mjs` 的 `setup` 注册三样东西：stdio MCP server（`ctx.mcp.transform`，工具名不变，opencode 暴露为 `tools.systemone.systemone_scenario` 等）、skill（`ctx.skill.transform`）、需求明确度预检（`ctx.session.hook("prompt")` —— opencode 没有 Claude 式 `hooks/hooks.json`，prompt hook 就是 `UserPromptSubmit` 的等价物，结论追加到 `event.prompt.text`）。安装细节见[仓库 README](../../README.md#opencode)。

## ZCode 设置页配置

在 **设置 → 插件管理 → 已安装 → SystemOne Decision → Advanced** 可直接配置，无需环境变量：

| 配置项 | 说明 | 留空时 |
|--------|------|--------|
| Base URL | SystemOne 兼容端点根地址 | 用内置默认，或环境变量 `SYSTEMONE_BASE_URL` |
| Model | 决策模型编码 | 用内置默认 `u2-decision`，或环境变量 `SYSTEMONE_MODEL` |
| Timeout (ms) | 请求超时毫秒数 | 用内置默认 30000，或环境变量 `SYSTEMONE_TIMEOUT_MS` |
| Custom Scenarios (JSON) | 自定义场景 JSON 数组，同 id 覆盖内置（见上节） | 仅用内置 11 个场景 |

优先级：**设置页 > 环境变量 > 内置默认**；改动后重启 ZCode 生效。

**API Key 例外**：ZCode 目前没有安全凭据存储，插件设置页不支持保存敏感值，Key 仍只能走环境变量 `SYSTEMONE_API_KEY`（或 `UNISOUND_API_KEY`）。

**hook 例外**：需求预检 hook 不支持读取插件设置页配置，只读环境变量。若通过设置页切换了供应商，需同时设置 `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` 环境变量，预检才会继续生效（否则 hook 请求失败后静默跳过）。

## 配置（环境变量）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SYSTEMONE_API_KEY` | 是（或 `UNISOUND_API_KEY`） | — | API Key，unisound 在 [API Key 管理](https://maas.unisound.com/admin/project/api-key) 创建 |
| `SYSTEMONE_BASE_URL` | 否 | `https://maas-api.unisound.com/v1` | SystemOne 兼容端点根地址 |
| `SYSTEMONE_MODEL` | 否 | `u2-decision` | 模型编码 |
| `SYSTEMONE_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |

Windows 设置示例（设置后重启 ZCode）：

```
setx SYSTEMONE_API_KEY "你的Key"
```

## 切换供应商

插件与厂商解耦：所有请求收敛于 `mcp/server.mjs` 的 `callSystemone()`，协议字段（`model` / `state` / `questions` → `answers`）遵循 SystemOne 规范。换厂商 = 改配置，插件代码零改动——Base URL / 模型在设置页改即可，Key 用环境变量：

```
setx SYSTEMONE_BASE_URL "https://你的供应商/v1"
setx SYSTEMONE_MODEL "你的决策模型"
setx SYSTEMONE_API_KEY "对应的Key"
```

## 需求明确度预检 hook（随插件自动安装）

插件通过 hook 清单声明了一个 UserPromptSubmit hook（ZCode 读 `hooks/hooks.json`，MiniMax Code 读 `hooks/hooks.minimax.json`，Dim 复用 ZCode 的 `hooks/hooks.json`，三者指向同一个脚本）：每次用户提交输入时，先用决策模型对需求做一次明确度判定（clarity / missing / proceed 三问），仅在判定为"不明确"（clarity ≤ 1 或 proceed < 0.6）时把结论注入对话上下文，提醒 Agent 先澄清再动手。需求明确、寒暄捷径（如"好的""继续"）或预检失败时静默放行，不产生任何输出。

安装插件即自动生效，卸载即自动移除，无需手动注册；复用 `SYSTEMONE_*` 环境变量，未配置 Key 时自动跳过。

内部时间预算按最严的一侧统一收紧：请求 6 秒 < 进程自毁 7 秒 < MiniMax handler 8 秒 < ZCode / Dim handler 15 秒。实测真实接口延迟约 0.1 秒，仍有 60 倍余量；任何失败都 fail-open，绝不阻塞用户输入。

**隐私提示**：该 hook 会把你每次提交的输入发送到决策服务接口。它会跳过少于 10 字的输入与寒暄短语，判定为"明确"时静默返回，但请求本身已经发出。不需要预检时，删除（或改名）对应的 hook 清单文件即可，插件其余能力不受影响。

## 结果解读

- `confidenceThreshold` 默认 0.7：任一答案 confidence 低于阈值、判定值不可用（choice 无选项、noul 无概率、score 无分值，或 choice 返回 `uncertain`/`unknown` 哨兵）、判定值越界（choice 选中的选项不在该题判据表内、score 分值超出量表范围）、或 noul 概率落在 0.45~0.55 模糊区间时，`needs_human_review = true` 并列出 `low_confidence_questions`。判定值缺失或越界时**即便 confidence 很高也会转人工**——模型对结构性坏响应同样会给高分。
- **低置信度时不要硬套判定结果**——转人工或改写判据后重试。流程分支建议同时参考 `probabilities` 的次优选项差距。

## 开发与测试

```
node test/smoke.mjs
node test/hook.smoke.mjs
node test/opencode.smoke.mjs
```

冒烟测试启动本地 mock 端点，对 MCP 服务器做端到端验证（initialize / tools/list / 场景 list-describe-run / params 覆盖 / 输出整形 / 自定义场景新增-覆盖-容错 / 参数校验 / 缺 Key 报错），不需要真实 API Key。`hook.smoke.mjs` 覆盖 UserPromptSubmit 的六类行为，`opencode.smoke.mjs` 用假 ctx 验证 opencode 侧的 MCP / skill / prompt hook 接线。

## 架构

```
mcp/
├── server.mjs     stdio JSON-RPC 主循环、配置、HTTP 调用、信任边界校验、2 个工具定义
├── scenarios.mjs  场景库（11 个内置 + 设置页/环境变量自定义场景合并，纯数据）+ 校验与查找
└── format.mjs     结果归一化（逐题明细 + decision/labels）、派生字段、建议模板渲染、Markdown 摘要
hooks/
├── clarity.mjs              需求明确度预检内核（门限 / 三问 / 结论文案，全端共用）
├── requirement-clarity.mjs  UserPromptSubmit 脚本（ZCode / MiniMax / Dim 共享的 stdin/stdout 协议）
├── hooks.json               ZCode / Dim 清单（${CLAUDE_PLUGIN_ROOT}，timeout 15）
└── hooks.minimax.json       MiniMax 清单（${PLUGIN_ROOT}，timeout 8）
skills/            使用指引与场景文档
.zcode-plugin/     ZCode 清单
.minimax-plugin/   MiniMax Code 清单
.codex-plugin/     Dim 清单（mcpServers 指向 systemone.mcp.json）
package.json       opencode 包入口
index.mjs          opencode 适配接线（MCP + skill + prompt hook）
systemone.mcp.json MiniMax / Dim 的 MCP 声明
icon*.png          MiniMax 插件图标（明亮/暗色）
```
