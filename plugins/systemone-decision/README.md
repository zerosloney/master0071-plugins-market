# systemone-decision

标准 Agent Plugin 布局插件：接入 SystemOne 决策协议（默认 unisound u2-decision）。只注册 **2 个 MCP 工具**，控制工具 schema 的上下文开销，同时通过内置场景库覆盖常用业务判定：

- **场景决策** `systemone_scenario` — `action=list / describe / run / batch / stats`，一次调用返回带概率分布的判定、归一化决策（`decision` / `labels` / `derived`）与处置建议（`recommendation`）
- **自定义决策** `systemone_decide` — 场景库没有的临时判断，直接提交任意 choice / noul / score 问题组合（≤ 16 个问题、单题 `instructions` ≤ 10000 字符，与场景库校验口径对齐）

零依赖 MCP 服务器（stdio），要求 Node ≥ 18。场景库是纯数据（`mcp/scenarios.mjs`），新增场景无需改工具 schema。

> **⚠ 数据外流提示（装前必读）**：一切判定都发生在你配置的 SystemOne 端点上。MCP 工具按调用把 `state` 发往端点；**配置 API Key 后，两个预检 hook 还会自动把每次用户输入（≥10 字符、非寒暄）与每条非只读 shell 命令的全文发往同一端点**——编码会话里的提示与命令常含私有路径、分支名或凭据引用，请只在你信任的端点上启用 hook，不需要时按[「预检 hook」](#预检-hook随插件自动安装)一节的说明关闭（需求预检 `SYSTEMONE_HOOK_PRECHECK=off`、shell 风险闸 `SYSTEMONE_HOOK_RISK_GATE=off`，各一键停用）。hook 判定带 5 分钟本地缓存：TTL 内重复的相同输入不再重复外发（`SYSTEMONE_CACHE_TTL_MS=0` 关闭）。

## 前置条件

| 依赖 | 要求 | 说明 |
|------|------|------|
| Node.js | ≥ 18，且 `node` 在**宿主启动 MCP 服务时使用的 PATH** 里 | `mcp.json` 的 `command` 是裸名 `node`（Agent Plugins 规范允许），解释器由宿主按平台搜索规则解析。宿主若用受限环境启动子进程、PATH 里没有 node，服务会起不来——这是宿主侧的事，插件无法兜底 |
| 网络 | 能访问所配置的 SystemOne 端点 | 默认 `unisound u2-decision`，可用 `SYSTEMONE_BASE_URL` 换供应商 |
| API Key | `SYSTEMONE_API_KEY` | 缺失时工具返回 `isError` 与配置指引，不会静默失败 |

一条命令自检环境：

```bash
node --version
```

版本过低时服务启动即报可读错误（而不是在半路抛出难懂的异常）。

## 内置场景（15 个）

每个场景 = 3 个结构化问题，判据可通过 `params` 覆盖为实际业务选项。

| 场景 id | 业务域 | 判定内容 |
| --- | --- | --- |
| `customer_service` | 客服运营 | 归属团队（choice）+ 严重程度（score）+ 是否升级值班（noul），派生 P1~P4 优先级 |
| `content_moderation` | 内容审核 | 处置动作（choice）+ 违规类型（choice）+ 风险等级（score） |
| `agent_routing` | 智能体路由 | 执行 Agent（choice）+ 复杂度（score）+ 是否转人工（noul），派生 S/M/L/XL |
| `result_verification` | 结果校验 | 是否满足要求（noul）+ 主要问题（choice）+ 质量等级（score） |
| `software_dev` | 软件开发 | 任务类型 bugfix/feature/refactor/…（choice）+ 改动复杂度（score）+ 是否先探查代码库（noul），派生 S/M/L/XL |
| `test_failure` | 测试失败分流 | 根因 代码/环境/不稳定/数据（choice）+ 阻塞等级（score）+ 是否先重跑确认（noul），派生 不阻塞/可跟进/阻塞合并/阻塞发布 |
| `pr_review` | 代码评审 | 结论 放行/附意见/打回/阻塞（choice）+ 变更风险（score）+ 是否需第二评审人（noul），派生合并门禁 |
| `incident_response` | 事故响应 | 等级 S4~S1（score）+ 回滚处置（choice）+ 是否拉起应急（noul），派生事故级别 |
| `security_triage` | 安全告警 | 告警真伪（choice）+ 影响面（score）+ 是否立即遏制（noul），派生真伪标签；**默认阈值 0.8** |
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

## 批量、精简与观测

- **批量** `action=batch`：同一场景对多条 `states`（2~10 条）依次判定，单条失败不中断（逐条标注 `error`），条目为精简形状（不含逐题明细与原始响应）。
- **精简模式** `format: "brief"`（run / decide 可选）：只返回 `decision` / `labels` / `derived` / `confidences` / `recommendation` 与复核标记，不含 `answers` / `summary` / `raw`——长会话里省上下文。
- **本地缓存**：相同输入（模型 + state + 问题）5 分钟内命中缓存，`cached: true` 标记且不发远端请求；`SYSTEMONE_CACHE_TTL_MS=0` 关闭（默认 300000，上限 200 条 LRU）。
- **审计日志**：设置 `SYSTEMONE_LOG_FILE`（或设置页 Decision Log）指向一个 JSONL 文件后，每次决策逐条落盘（判定值、置信度、延迟、复核标记）；`action=stats` 汇总各场景的判定次数、复核率、缓存命中与高频判定——场景判据调优的数据基础。路径受护栏约束（绝对路径、`.jsonl`、不得落在插件安装目录或 `.git` 内）：设置值来自用户可写位置，过去未经校验就交给截断写入，指到一个超过体积上限的非日志文件时会被一行标记整体替换——用户数据当场消失。超上限现在改为**轮转**（上一段改名成 `<文件>.1` 保留一代），不再原地清空。
- **阈值优先级**：调用参数 `confidenceThreshold` > 场景默认（如 `security_triage` 0.8）> 全局 0.7。

## 自定义场景（设置页 / 场景文件 / 环境变量）

内置场景不够用时，在设置页 **Custom Scenarios (JSON)** 粘贴场景 JSON 数组（可多行），重启 ZCode 生效；**同 id 覆盖内置场景，否则追加**，无需改代码。也可用环境变量 `SYSTEMONE_SCENARIOS`（建议压缩成单行），或 **Scenarios File** 配置项 / `SYSTEMONE_SCENARIOS_FILE` 环境变量指向一个 JSON 文件（便于把场景剧本纳入版本管理）。三个来源按优先级合并：**设置页 JSON > 场景文件 > 内置**。示例：

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
- 校验约束：问题 1~16 个、choice 选项 2~26 个、score 分级 ≥2 级；**非法条目整条跳过并在日志告警**，不影响内置与其余自定义场景；某一来源 JSON 解析失败则跳过该来源、回退其余来源与内置场景库。
- 场景可带 `confidenceThreshold`（0~1）定义自己的默认复核阈值；生效后 `action=list` 可见（标注"自定义"），describe / run / batch 与内置场景无差别。

## 宿主支持（Agent Plugins 标准布局）

插件按 [Agent Plugins 1.0.0](https://agent-plugins.org) 打包，可移植核心是根 `plugin.json`（封闭 schema）、`skills/systemone-decision/SKILL.md`、`mcp.json`，客户端按固定位置自动发现，清单里不写组件路径：

| 组件 | 位置 | 状态 |
|------|------|------|
| 清单 | `plugin.json` | 标准（`$schema` + `name` 必填，版本以此为准） |
| MCP | `mcp.json` | 标准（`mcpServers.systemone.type = "stdio"`） |
| Skill | `skills/systemone-decision/` | 标准（`skills/<name>/SKILL.md`） |
| Hooks | `hooks/hooks.json` | **客户端约定，非标准** |

`hooks/` 不是 Agent Plugins 的组件类型，它服务 Claude Code / ZCode 这类支持 Claude 式 hook 的宿主，用 `${CLAUDE_PLUGIN_ROOT}` 定位插件根。Agent Plugins 兼容客户端会忽略它，插件其余能力不受影响。

**ZCode 兼容垫片**：`.zcode-plugin/plugin.json` 额外提供内联 `mcpServers` 与 `userConfig` 设置页，配合仓库根 `marketplace.json` 使用，ZCode 的 `/plugin marketplace add` 装法不变。这两份是**非标准**的（规范要求一个包内有且仅有一个根 `plugin.json`），保留它们是为不破坏 ZCode 现有安装方式的自觉取舍。Agent Plugins 客户端会忽略。两处版本必须一致（`node scripts/release.mjs --check` 校验）。

**Codex 兼容垫片**：`.codex-plugin/plugin.json` 声明 `skills` 与 `mcpServers: "./mcp.json"`，配合仓库根 `.agents/plugins/marketplace.json` 使用。同样是非标准的。Codex 侧的 `hooks/` 未在垫片里声明——本机 Codex 插件样本中的 hook 只有 `mcp_tool` 类型，Claude 式的 `command` hook 是否被接受无法离线确认，所以不写进去：Codex 上少两个预检 hook（需求明确度、shell 风险闸），MCP 判定与 skill 不受影响。

**Oh My Pi 兼容垫片**：`.omp-plugin/plugin.json` 声明 `skills` 与内联 `mcpServers`（`node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`），配合仓库根 `.omp-plugin/marketplace.json` 使用。这份写法沿用 omp 侧已验证的 0.3.1 清单形状（`~/.omp/plugins/cache/plugins/` 里的旧安装可直接比对）。omp 不加载 `hooks/`，预检 hook 同样缺失。

**凭据**：`mcp.json` 里不写任何密钥，stdio 子进程直接继承用户环境变量，因此 `SYSTEMONE_API_KEY` 不会被打包或落盘。

业务载荷（`mcp/*.mjs`、`endpoint-config.mjs`、`skills/`、`hooks/`）完全共享，各宿主运行的是同一份代码。判定内核（门限 / 三问 / 结论文案）抽在 `hooks/clarity.mjs`，Claude 式 stdin/stdout 协议留在 `hooks/requirement-clarity.mjs`——改同一处门限不会跨端漂移。

**配置入口差异**：只有 ZCode 的兼容垫片清单带 `userConfig`，所以只有它有设置页；其余宿主走 `SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` / `SYSTEMONE_TIMEOUT_MS` / `SYSTEMONE_SCENARIOS` 环境变量。功能不丢，只是入口不同——服务端取值链本身就是 `SYSTEMONE_PLUGIN_*`（设置项）→ `SYSTEMONE_*`（环境变量）→ 内置默认。

## ZCode 设置页配置

在 **设置 → 插件管理 → 已安装 → SystemOne Decision → Advanced** 可直接配置，无需环境变量：

| 配置项 | 说明 | 留空时 |
|--------|------|--------|
| Base URL | SystemOne 兼容端点根地址 | 用内置默认，或环境变量 `SYSTEMONE_BASE_URL` |
| Model | 决策模型编码 | 用内置默认 `u2-decision`，或环境变量 `SYSTEMONE_MODEL` |
| Timeout (ms) | 请求超时毫秒数 | 用内置默认 30000，或环境变量 `SYSTEMONE_TIMEOUT_MS` |
| Custom Scenarios (JSON) | 自定义场景 JSON 数组，同 id 覆盖内置（见上节） | 仅用内置 15 个场景 |
| Scenarios File | 自定义场景 JSON 文件路径（便于纳入版本管理），优先级低于上面的 JSON | 不用场景文件 |
| Decision Log (JSONL) | 审计日志文件路径，每次决策逐条追加，`action=stats` 消费 | 不记录 |

优先级：**设置页 > 环境变量 > 内置默认**；改动后重启 ZCode 生效。

**API Key 例外**：ZCode 目前没有安全凭据存储，插件设置页不支持保存敏感值，Key 仍只能走环境变量 `SYSTEMONE_API_KEY`（或 `UNISOUND_API_KEY`）。

**hook 端点共享**：hook 进程拿不到设置页注入的变量，但 MCP 服务每次启动会把「已解析」的端点（Base URL / Model / Timeout，不含 API Key）落盘到共享文件，需求预检 hook 优先读这份文件、缺失或损坏时回退环境变量——通过设置页切换供应商后，预检自动跟随同一端点，无需再设环境变量（改动设置后重启生效，与 MCP 一致）。API Key 仍只能走环境变量；若插件目录只读导致落盘失败，hook 回退纯环境变量行为。

**共享文件位置**：Agent Plugins 规范的客户端会提供 `PLUGIN_DATA`（跨插件更新保留的可写数据目录），此时文件落在 `$PLUGIN_DATA/endpoint.json`——插件更新后端点配置不丢，也不会把运行时产物留在包目录里。没有 `PLUGIN_DATA` 的宿主（Claude Code / ZCode 等）沿用插件根的 `.endpoint.json`。读时两处都看、`PLUGIN_DATA` 优先；写时只写 `PLUGIN_DATA`（存在时）并清掉插件根的旧文件，避免同一份配置留两个副本、日后回退旧文件时读到过期端点。**注意：无 `PLUGIN_DATA` 时 `.endpoint.json` / `decision-cache.json` / `precheck-quota.json` 会回退写入插件安装目录，目录只读时各写入路径自行降级——端点共享文件失败会 stderr 告警，判定缓存与预检配额静默跳过，均不影响主流程。**

## 配置（环境变量）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SYSTEMONE_API_KEY` | 是（或 `UNISOUND_API_KEY`） | — | API Key，unisound 在 [API Key 管理](https://maas.unisound.com/admin/project/api-key) 创建 |
| `SYSTEMONE_BASE_URL` | 否 | `https://maas-api.unisound.com/v1` | SystemOne 兼容端点根地址 |
| `SYSTEMONE_MODEL` | 否 | `u2-decision` | 模型编码 |
| `SYSTEMONE_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |
| `SYSTEMONE_SCENARIOS` | 否 | — | 自定义场景 JSON 数组（与设置页同源，优先级低于设置页） |
| `SYSTEMONE_SCENARIOS_FILE` | 否 | — | 自定义场景 JSON 文件路径（优先级：设置页 > 环境变量 > 文件）。**须为绝对路径、`.json` 扩展名，且不在插件安装目录或任何 `.git` 内**；不合格则忽略该文件并告警，内置场景照常可用 |
| `SYSTEMONE_LOG_FILE` | 否 | — | 审计日志 JSONL 路径，`action=stats` 消费。**须为绝对路径、`.jsonl` 扩展名，且不在插件安装目录或任何 `.git` 内**（插件安装目录跨项目共享、且随插件更新被覆盖）。超过 5 MB 时**轮转**为 `<文件>.1` 保留上一段，不再原地清空 |
| `SYSTEMONE_CACHE_TTL_MS` | 否 | `300000` | 决策缓存 TTL（毫秒），0 关闭；**同时作用于 MCP 工具缓存与 hook 判定缓存** |
| `SYSTEMONE_HOOK_PRECHECK` | 否 | `on` | 需求预检开关：`on` / `off` / `first:N`（每会话仅前 N 条被判定输入做预检，用尽后静默跳过；裸数字等同 `first:N`） |
| `SYSTEMONE_HOOK_RISK_GATE` | 否 | `on` | shell 风险闸总开关：`on` / `off`（`off` 时一律放行且不发判定请求，比删 `hooks.json` 注册温和）。非法值告警后按 `on`，不静默关灯 |

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

## 预检 hook（随插件自动安装）

插件通过 hook 清单声明了两个 hook（`hooks/hooks.json`，判定内核与配置解析共用 `hooks/decide-client.mjs`，任何失败都 fail-open，绝不阻塞输入或工具调用）：

**① 需求明确度预检（UserPromptSubmit）**：每次用户提交输入时，先用决策模型对需求做一次明确度判定（clarity / missing / proceed 三问），仅在判定为"不明确"（clarity ≤ 1 或 proceed < 0.6）时把结论注入对话上下文，提醒 Agent 先澄清再动手。需求明确、寒暄捷径（如"好的""继续"）或预检失败时静默放行。

**② shell 命令风险闸（PreToolUse）**：工具调用前，对 shell 类工具的非只读命令做风险判定（放行/确认/拒绝三问）。判定为拒绝（高风险且不可逆）时输出 `permissionDecision: "deny"`，判定为需确认（中风险以上或不可逆）时输出 `"ask"` 并附理由；放行、只读命令捷径（ls / git status 等）或缺 Key 时静默放行。

`hooks.json` 的 matcher 与内核的 `SHELL_TOOL_NAMES` **必须同宽**（由 `test/hook.smoke.mjs` 对账锁死）：过去 matcher 只写 `Bash|Shell|Terminal`，而内核认 12 个名字，宿主把命令交给 `cmd` / `exec` / `run_*` / `pwsh` 类工具时 hook 根本不被调用——闸门对着这些调用完全失效。

已知未覆盖的窄口子：`git log` / `git diff` / `git show` 仍算只读捷径，但仓库自带配置里的 `core.pager` / `pager.log` / `diff.external` 是**仓库可控**的，恶意仓库可借它在 `git diff` 时执行外部程序。把这三条移出白名单会让每次 git 读取都付一次判定请求，代价过大，故交由宿主自身的目录信任与权限系统兜底，这里如实标注而非声称已覆盖。

安装插件即自动生效，卸载即自动移除，无需手动注册；复用 `SYSTEMONE_*` 环境变量与 `.endpoint.json` 共享端点，未配置 Key 时自动跳过。

**与 ai-native-delivery 共装时（双风险闸，2026-10-28 说明）**：同一市场里的 `ai-native-delivery` 也注册 PreToolUse 风险闸，matcher 同为 shell 类。宿主按插件各跑各的 hook，两个闸之间没有仲裁通道——本插件的 hook 进程看不到另一个插件是否在场。共装的实际行为：危险命令被两个闸各判一次（可能两道确认，或一个 `ask` 叠一个 `deny`），且两套清单彼此独立（本插件读自己的场景判据，对方读项目侧 `.agents/settings.json`）。**约定只保留一道闸**：保留对方（它同时管 git hooks）时设 `SYSTEMONE_HOOK_RISK_GATE=off`；保留本插件则删对方的 hooks 注册段。不做自动让位——靠猜安装布局检测对方会让行为随目录结构漂移，比双提示更难排查。

内部时间预算：hook 请求超时按优先级取小——先取 `.endpoint.json` 落盘的 `timeoutMs`（MCP 服务启动时写入，来自设置页或 `SYSTEMONE_TIMEOUT_MS`；无落盘文件时直接用环境变量，再缺省 8 秒），再与 12 秒硬上限、共享 deadline 剩余（进程自毁 14 秒 − stdin 耗时 − 1 秒收尾）取最小值。落盘默认值为 30000，因此常态下实际请求超时是 12 秒 < 14 秒 < hooks.json 的 handler 15 秒上限。实测真实接口延迟约 0.1 秒，仍有百倍以上余量。

**隐私提示**：需求预检 hook 会把你每次提交的输入发送到决策服务接口（跳过少于 10 字的输入与寒暄短语）；风险闸会把 shell 命令文本发送到决策服务接口（跳过只读命令）。判定为"明确"/"放行"时静默返回，但请求本身已经发出。不需要某个 hook 时，删除（或改名）`hooks/hooks.json` 里对应的注册段即可，插件其余能力不受影响。

**hook 判定缓存**：两个 hook 共用一个跨进程文件缓存，与 MCP 侧同一个 `SYSTEMONE_CACHE_TTL_MS` 开关（默认 5 分钟，`0` 关闭）：相同「端点 + 模型 + 输入 + 问题」在 TTL 内直接复用本地答案，不再发远端请求——代理循环里反复执行的同一批命令、重发的同一提示都吃这条捷径，这是对"每条提示/命令都打一次远端"的延迟与外发面的直接削减。缓存文件落在 `$PLUGIN_DATA/decision-cache.json`（无该变量的宿主落在插件根，已被 `.gitignore` 覆盖）；文件损坏一律当未命中，不影响 fail-open 契约。

**预检开关与会话配额**：`SYSTEMONE_HOOK_PRECHECK=off` 一键停掉需求预检（比删 `hooks.json` 注册温和，风险闸不受影响，立即停止提示外发）；`SYSTEMONE_HOOK_RISK_GATE=off` 是同等的另一把闸，单独停掉 shell 命令风险闸且不发判定请求；`=first:N` 则每个会话只对前 N 条被判定输入做预检，用尽后静默跳过——适合「先试用几轮再决定留不留」，也是削减常态延迟税的档位。配额按 hook 输入的 `session_id` 分桶计数（宿主不传则共用一个桶），落在 `$PLUGIN_DATA/precheck-quota.json`（无该变量的宿主落插件根，已被 `.gitignore` 覆盖），删除该文件即重置全部会话配额；非法值告警后按默认 `on` 处理。

## 结果解读

- `confidenceThreshold` 默认 0.7：任一答案 confidence 低于阈值、判定值不可用（choice 无选项、noul 无概率、score 无分值，或 choice 返回 `uncertain`/`unknown` 哨兵）、判定值越界（choice 选中的选项不在该题判据表内、score 分值超出量表范围）、或 noul 概率落在 0.45~0.55 模糊区间时，`needs_human_review = true` 并列出 `low_confidence_questions`。判定值缺失或越界时**即便 confidence 很高也会转人工**——模型对结构性坏响应同样会给高分。
- **低置信度时不要硬套判定结果**——转人工或改写判据后重试。流程分支建议同时参考 `probabilities` 的次优选项差距。

## 开发与测试

```
node test/smoke.mjs
node test/hook.smoke.mjs
```

冒烟测试启动本地 mock 端点，对 MCP 服务器做端到端验证（initialize / tools/list / 场景 list-describe-run / params 覆盖 / 输出整形 / 自定义场景新增-覆盖-容错 / 参数校验 / 缺 Key 报错 / 批量 / 精简模式 / 缓存 / 审计统计 / 场景文件），不需要真实 API Key。`hook.smoke.mjs` 覆盖需求预检与风险闸两个 hook 的全部行为路径。

## 架构

```
mcp/
├── server.mjs     stdio JSON-RPC 主循环、配置、HTTP 调用（含本地缓存）、信任边界校验、审计日志、2 个工具定义
├── scenarios.mjs  场景库（15 个内置 + 场景文件/设置页/环境变量自定义合并，纯数据）+ 校验与查找
└── format.mjs     结果归一化（逐题明细 + decision/labels）、派生字段、建议模板渲染、Markdown 摘要
endpoint-config.mjs MCP 与 hook 的端点共享文件（MCP 启动落盘、hook 读取，不含 API Key）
hooks/
├── decide-client.mjs        配置解析 + 判定请求（含跨进程缓存）+ 答案归一化（两个 hook 内核共用）
├── decision-cache.mjs       hook 判定的跨进程文件缓存（TTL 同 MCP 侧，损坏当未命中）
├── precheck-quota.mjs       需求预检的开关与会话配额（off 短路 / first:N 按 session_id 计数）
├── hook-io.mjs              stdin 读取（100K 字符上限）+ 共享 deadline + stdout 退出协议（两个入口脚本共用）
├── clarity.mjs              需求明确度预检内核（门限 / 三问 / 结论文案，全端共用）
├── requirement-clarity.mjs  UserPromptSubmit 入口脚本（stdin/stdout 协议壳在 hook-io.mjs）
├── risk-gate.mjs            shell 命令风险闸内核（放行 / 确认 / 拒绝的门限与理由文案）
├── pretool-risk.mjs         PreToolUse 脚本（permissionDecision deny/ask 输出协议）
└── hooks.json               事件清单（UserPromptSubmit 需求预检 + PreToolUse 风险闸，${CLAUDE_PLUGIN_ROOT}，timeout 15）
skills/            使用指引与场景文档（skills/systemone-decision/SKILL.md）
plugin.json        Agent Plugins 标准清单（版本权威来源）
mcp.json           Agent Plugins 标准 MCP 声明（mcpServers / type: stdio）
.zcode-plugin/     ZCode 兼容垫片，非标准（内联 mcpServers + 设置页 userConfig）
.codex-plugin/     Codex 兼容垫片，非标准（skills + mcpServers + interface）
.omp-plugin/       Oh My Pi 兼容垫片，非标准（skills + 内联 mcpServers）
icon.png           界面 logo
```
