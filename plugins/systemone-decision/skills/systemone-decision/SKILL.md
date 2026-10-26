---
name: systemone-decision
description: SystemOne 决策模型工具集（默认 unisound u2-decision）：2 个 MCP 工具覆盖 15 个内置场景——工单分流、内容审核、Agent 路由、结果校验、软件开发任务判定（类型/复杂度/是否先探查代码库）、测试失败分流、代码评审门禁、事故响应定级、安全告警分流、销售线索、金融风控、招聘、数据治理、教育、需求优先级，以及任意自定义问题（choice/noul/score）的结构化判定。当需要对业务文本分流归类、审核违规、路由任务、校验结果、或对任意"走哪条分支"的问题做带概率和置信度的判定时使用。Use for ticket triage, content moderation, agent routing, result verification, software-dev task classification and other structured decision scenarios with probability-backed judgments.
license: MIT
compatibility: Needs network access to the SystemOne endpoint, an API key in SYSTEMONE_API_KEY, and Node.js 18+ on the PATH the host uses to launch the plugin MCP server.
---

# SystemOne 决策

决策模型不生成自由文本：一次请求对同一业务上下文提出多个结构化问题，返回带概率分布和置信度的判定，毫秒级延迟、极低 token 成本。适合在流程中做"走哪条分支"的判断，而不是写文章。

## 工具选择

| 工具 | 用途 |
|------|------|
| `systemone_scenario` | 大多数情况。`action=run` 跑内置场景；`action=list` 列场景；`action=describe` 看问题定义；`action=batch` 批量判定（2~10 条 states）；`action=stats` 汇总审计日志 |
| `systemone_decide` | 场景库没有的临时判断，自定义 questions（choice / noul / score） |

> 下文一律用 MCP 原生名书写，各宿主与原生名一致；个别宿主可能加命名空间前缀，以本会话工具清单里的实际名称为准。

## 内置场景（`systemone_scenario` action=run）

| 场景 id | 判定内容（题型） | 建议传入的 params |
|---------|------------------|-------------------|
| `customer_service` | 归属团队（choice）+ 严重程度（score）+ 升级值班（noul）→ 派生 P1~P4 | `department.criteria`（实际团队表） |
| `content_moderation` | 处置动作（choice）+ 违规类型（choice）+ 风险等级（score） | `category.criteria`（实际违规类型表） |
| `agent_routing` | 执行 Agent（choice）+ 复杂度（score）+ 转人工（noul）→ 派生 S/M/L/XL | `agent.criteria`（实际可用 Agent 名册） |
| `result_verification` | 是否满足要求（noul）+ 主要问题（choice）+ 质量等级（score） | `state` 传 `{task, result}` |
| `software_dev` | 任务类型 bugfix/feature/…（choice）+ 改动复杂度（score）+ 是否先探查代码库（noul） | — |
| `test_failure` | 根因 代码/环境/不稳定/数据（choice）+ 阻塞等级（score）+ 先重跑确认（noul）→ 派生阻塞结论 | — |
| `pr_review` | 结论 放行/附意见/打回/阻塞（choice）+ 变更风险（score）+ 需第二评审人（noul）→ 派生合并门禁 | — |
| `incident_response` | 等级 S4~S1（score）+ 回滚处置（choice）+ 拉起应急（noul）→ 派生事故级别 | — |
| `security_triage` | 告警真伪（choice）+ 影响面（score）+ 立即遏制（noul），默认阈值 0.8 | `impact.criteria`（实际资产分级） |
| `sales_lead` / `risk_control` / `recruiting` / `data_governance` / `education` / `requirements` | 见 [references/scenarios.md](references/scenarios.md) | 按业务覆盖判据 |

场景支持中文别名（`工单分流`、`审核`、`开发`、`测试失败`、`评审`、`事故`、`安全` 等）。用户也可能配置了自定义场景（设置页 JSON / `SYSTEMONE_SCENARIOS` / `SYSTEMONE_SCENARIOS_FILE` 场景文件）——`action=list` 可见全部场景（自定义场景带"自定义"标注），describe / run / batch 用法与内置场景完全一致。

**判据都有合理默认值，且可通过 `params` 按问题 id 覆盖——传入实际业务的可选项比默认值更准，能用就传**：

```
systemone_scenario(action: "run", scenario: "agent_routing",
  state: "把这份 50 页 PDF 的中文合同翻译成英文",
  params: { agent: { criteria: { flash: "快且便宜，简单任务够用", pro: "质量优先，复杂任务" } } })
```

`params` 覆盖语义：`criteria` 整体替换选项（choice 传对象 / score 传 ≥2 级标签数组）、`addCriteria` 在默认选项上追加（仅 choice）、`instructions` / `label` 局部替换。更多场景与组题方法见 [references/scenarios.md](references/scenarios.md)。

**省上下文与批量**：`format: "brief"`（run / decide 可选）只返回 `decision` / `labels` / `derived` / `recommendation` 与复核标记，不含逐题明细与原始响应——结果只需驱动流程分支时用 brief。多条同类输入（批量工单、批量校验）用 `action=batch`（2~10 条 states，逐条返回精简结果，单条失败不中断）。相同输入 5 分钟内命中本地缓存（`cached: true`）。

## 题型语义

| type | criteria | 返回 |
|------|----------|------|
| `choice` | `{选项ID: 选项描述}` 对象 | `value`（选中 ID）+ `probabilities` + `confidence` |
| `noul` | 无 | `probability`（0~1，对 instructions 所述命题的成立概率）+ `confidence` |
| `score` | `[等级描述, ...]` 数组，索引即分值 | `value`（分值，可为小数）+ `level`（对应等级描述）+ `confidence` |

## 结果解读

每个工具返回四层结果，按需取用：

- `answers` — 逐题明细（value / level / probabilities / confidence / present）
- `decision` / `labels` / `derived` / `confidences` — 归一化速览：choice=选项 key、score=取整分值、noul=boolean；labels 是可读标签，derived 是场景派生字段（如 severity→P2、complexity→M）
- `recommendation` — 场景建议模板渲染出的一句话处置建议（如"转 支付、退款和账单问题 处理（优先级 P2）。需立即通知值班人员"）
- `summary` — Markdown 摘要；`meta`（model / request_id / latency_ms / usage）与 `raw`（原始响应）供追溯

`confidenceThreshold` 默认 0.7（可被场景默认覆盖，如 `security_triage` 0.8；调用参数优先级最高）：任一答案 confidence 低于阈值、判定值不可用（choice 无选项、noul 无概率、score 无分值，或 choice 返回 `uncertain`/`unknown` 哨兵）、判定值越界（choice 选中的选项不在该题判据表内、score 分值超出量表范围）、或 noul 概率落在 0.45~0.55 模糊区间时 `needs_human_review = true`，并列出 `low_confidence_questions`。判定值缺失或越界时即便 confidence 很高也会转人工。noul 的 confidence 是概率决断度 `max(p, 1-p)`。

- **低置信度时不要硬套判定结果**——转人工或改写判据后重试。流程分支建议同时参考 `probabilities` 的次优选项差距。

## 示例

工单分流：

```
systemone_scenario(action: "run", scenario: "customer_service",
  state: "订单支付后超过24小时仍未到账，用户无法继续使用核心服务，要求立即处理。")
→ decision = { department: "billing", severity: 2, escalate: true }
→ labels.severity = "核心功能不可用，没有替代方案"，derived.priority = "P2"
```

编码任务判定（判断是 bug 还是功能、多大改动、要不要先翻代码）：

```
systemone_scenario(action: "run", scenario: "software_dev",
  state: "修复登录页在 Safari 下无法提交表单的问题")
→ decision = { task_type: "bugfix", complexity: 1, needs_context: true }，derived.effort = "M"
```

自定义决策（场景库外的临时判断）：

```
systemone_decide(
  state: "把这份 50 页 PDF 的中文合同翻译成英文",
  questions: {
    model: {type: "choice", instructions: "应使用哪个模型？",
            criteria: {flash: "快且便宜，简单任务够用", pro: "质量优先，复杂任务"}},
    needs_rag: {type: "noul", instructions: "是否需要先检索参考资料？"}
  }
)
```

## 切换供应商

插件不绑定 unisound。任何 SystemOne（Jev 兼容）协议端点直接替换。

环境变量（**所有宿主通用，也是最省事的一种**）：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SYSTEMONE_API_KEY` | 是（或 `UNISOUND_API_KEY`） | — | API Key，**只能走环境变量**——各宿主都没有安全的凭据存储 |
| `SYSTEMONE_BASE_URL` | 否 | `https://maas-api.unisound.com/v1` | 端点根地址 |
| `SYSTEMONE_MODEL` | 否 | `u2-decision` | 决策模型编码 |
| `SYSTEMONE_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |
| `SYSTEMONE_SCENARIOS` | 否 | 空 | 自定义场景 JSON 数组（同 id 覆盖内置），**仅 MCP 工具读取** |
| `SYSTEMONE_SCENARIOS_FILE` | 否 | 空 | 自定义场景 JSON 文件路径（优先级：设置页 > 环境变量 > 文件） |
| `SYSTEMONE_LOG_FILE` | 否 | 空 | 审计日志 JSONL 路径，`action=stats` 消费 |
| `SYSTEMONE_CACHE_TTL_MS` | 否 | `300000` | 决策缓存 TTL（毫秒），0 关闭 |

想在宿主里点选配置而不用记环境变量，各宿主入口不同（值都收敛到同一套 `SYSTEMONE_PLUGIN_*`，优先级：宿主配置 > 环境变量 > 内置默认）：

| 宿主 | 入口 | 备注 |
|------|------|------|
| ZCode | 设置 → 插件管理 → 已安装 → SystemOne Decision → Advanced | Base URL / Model / Timeout (ms) / Custom Scenarios |
| Claude Code / CodeBuddy / Qwen Code / omp | 无，只能用上面的环境变量 | 尤其 `SYSTEMONE_SCENARIOS` |

两个通用注意点：

- **改配置后需重启宿主**才生效——MCP 是启动时拉起的 stdio 子进程，持有一份启动瞬间的环境变量快照；ZCode 的设置页也是改完要重启。
- **宿主配置对预检 hook 同样生效**：MCP 服务启动时把已解析端点（Base URL / Model / Timeout，不含 API Key）落盘到共享文件（客户端提供 `PLUGIN_DATA` 时落 `$PLUGIN_DATA/endpoint.json`，否则落插件根 `.endpoint.json`），需求预检 hook 优先读这份文件、缺失或损坏时回退环境变量——设置页切换供应商后预检自动跟随同一端点。API Key 仍只走环境变量；若插件目录只读导致落盘失败，hook 回退纯环境变量行为。

## 边界与限额

- 决策模型只做判定，不做生成。需要解释性输出时：先决策拿结构化结论，再交给对话模型展开。
- 问题数建议 ≤16（延迟随问题数近似线性增长）；choice 选项 2~26 个（26 是硬上限，超出整题被拒）；score 分级 2~255 级。
- `state` 上限 10 万**字符**（不是 token），超出直接报错并提示精简，**不会自动截断**。
- 非法或超限的问题在响应 `answers` 中可能缺失，归一化结果中标记 `present: false` 并计入 `low_confidence_questions`。
