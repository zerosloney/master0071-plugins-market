---
name: systemone-decision
description: SystemOne 决策模型工具集（默认 unisound u2-decision）：工单分流、内容审核、Agent 路由、结果校验，以及销售线索评分、金融风控、招聘筛选、数据打标归因、教育题目归类、需求优先级等场景的结构化判定。当需要对业务文本分流归类、审核违规、路由任务、校验结果、或对任意"走哪条分支"的问题做带概率和置信度的判定时使用。Use for ticket triage, content moderation, agent routing, result verification and other structured decision scenarios with probability-backed judgments.
---

# SystemOne 决策

决策模型不生成自由文本：一次请求对同一业务上下文提出多个结构化问题，返回带概率分布和置信度的判定，毫秒级延迟、极低 token 成本。适合在流程中做"走哪条分支"的判断，而不是写文章。

## 工具选择

| 场景 | 工具 | 判定内容 |
|------|------|----------|
| 工单分流 | `ticket_triage` | 归属团队（choice）+ 严重程度（score）+ 是否升级值班（noul） |
| 内容审核 | `content_moderate` | 处置动作（choice）+ 违规类型（choice）+ 风险等级（score） |
| Agent 路由 | `agent_route` | 执行 Agent（choice）+ 复杂度（score）+ 是否转人工（noul） |
| 结果校验 | `verify_result` | 是否满足要求（noul）+ 主要问题（choice）+ 质量等级（score） |
| 其他自定义 | `systemone_decide` | 自定义 questions（choice / noul / score） |

四个预设工具的判据（团队列表、Agent 名册、等级描述等）都有合理默认值，且都可通过参数整体覆盖——传入实际业务的可选项比默认值更准，能用就传。例如 `agent_route` 应传入当前真实可用的 `agents` 名册。

更多业务场景（销售线索、金融风控、招聘 HR、数据治理、教育内容、需求与变更）的组题方法与判据示例见 [references/scenarios.md](references/scenarios.md)。

## 题型语义

| type | criteria | 返回 |
|------|----------|------|
| `choice` | `{选项ID: 选项描述}` 对象 | `value`（选中 ID）+ `probabilities` + `confidence` |
| `noul` | 无 | `probability`（0~1，对 instructions 所述命题的成立概率）+ `confidence` |
| `score` | `[等级描述, ...]` 数组，索引即分值 | `value`（分值，可为小数）+ `level`（对应等级描述）+ `confidence` |

## 结果解读

- 每个工具返回 `answers`（按问题 ID 归一化）、`meta`（model / request_id / latency_ms / usage）和 `raw`（原始响应）。
- `confidenceThreshold` 默认 0.7：任一答案 confidence 低于阈值时 `needs_human_review = true`，并列出 `low_confidence_questions`。noul 的 confidence 是概率决断度 `max(p, 1-p)`。
- **低置信度时不要硬套判定结果**——转人工或改写判据后重试。流程分支建议同时参考 `probabilities` 的次优选项差距。

## 示例

工单分流：

```
ticket_triage(ticket: "订单支付后超过24小时仍未到账，用户无法继续使用核心服务，要求立即处理。")
→ answers.department.value = "billing" (confidence 0.89)
→ answers.severity.value = 2, level = "核心功能不可用，没有替代方案" (confidence 0.99)
→ answers.escalate.probability = 0.96
```

自定义决策（例如为任务挑选模型）：

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

插件不绑定 unisound。端点 / 模型 / 超时两种配置方式（优先级：设置页 > 环境变量 > 内置默认），任何 SystemOne（Jev 兼容）协议端点直接替换：

- ZCode 插件设置页（设置 → 插件管理 → 已安装 → SystemOne Decision → Advanced）：Base URL / Model / Timeout (ms)
- 环境变量：
  - `SYSTEMONE_API_KEY`（或 `UNISOUND_API_KEY`）— 必填，Key 只能走环境变量（设置页不支持保存密钥）
  - `SYSTEMONE_BASE_URL` — 默认 `https://maas-api.unisound.com/v1`
  - `SYSTEMONE_MODEL` — 默认 `u2-decision`
  - `SYSTEMONE_TIMEOUT_MS` — 默认 30000

改配置后需重启 ZCode 生效；设置页配置只作用于 MCP 工具，需求预检 hook 只读环境变量。

## 边界与限额

- 决策模型只做判定，不做生成。需要解释性输出时：先决策拿结构化结论，再交给对话模型展开。
- 问题数建议 ≤16（延迟随问题数近似线性增长）；choice/score 选项建议 ≤26，上限 255。
- `state` 上下文上限 131072 tokens，超长会被截断。
- 非法或超限的问题在响应 `answers` 中可能缺失，归一化结果中标记 `present: false`。
