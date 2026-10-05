# 场景目录与组题参考

`systemone_scenario` 的 11 个内置场景目录、`params` 判据覆盖指南，以及场景库外用 `systemone_decide` 组题的配方。所有判据都是示例默认值，接入真实业务时**整体替换为实际选项**——选项越贴近业务越准。

## 场景快速索引

| 场景 id | 别名 | 判定内容（题型） | 派生/建议 |
|---------|------|------------------|-----------|
| `customer_service` | 工单分流、客服、派单 | 归属团队（choice）+ 严重程度（score）+ 升级值班（noul） | severity→P4~P1 |
| `content_moderation` | 内容审核、审核 | 处置动作（choice）+ 违规类型（choice）+ 风险等级（score） | 一句话处置建议 |
| `agent_routing` | 任务路由、路由 | 执行 Agent（choice）+ 复杂度（score）+ 转人工（noul） | complexity→S/M/L/XL |
| `result_verification` | 结果校验、校验 | 是否满足要求（noul）+ 主要问题（choice）+ 质量等级（score） | 一句话质检建议 |
| `software_dev` | 开发、编程、编码、研发 | 任务类型（choice：bugfix/feature/refactor/review/test/docs/build/perf）+ 改动复杂度（score）+ 是否先探查代码库（noul） | complexity→S/M/L/XL |
| `sales_lead` | 线索评分、销售 | 线索质量（score）+ 线索归属（choice）+ 是否跟进（noul） | — |
| `risk_control` | 风控、反欺诈 | 交易异常（score）+ 风险等级（choice）+ 人工复核（noul） | — |
| `recruiting` | 招聘、hr、resume | 简历匹配度（score）+ 岗位归属（choice）+ 进入下一轮（noul） | — |
| `data_governance` | 数据治理、数据标注 | 文档标签（choice）+ 问题归因（choice）+ 敏感数据（noul） | — |
| `education` | 教育、教学内容 | 知识点（choice）+ 难度（score）+ 合规预检（noul） | — |
| `requirements` | 需求、变更管理 | 优先级（score）+ 变更风险（choice）+ 拆分派发（noul） | — |

用 `action=describe` 查看任意场景的问题定义与默认判据，用 `action=list` + `keyword` 按关键词找场景。

## 自定义场景（JSON）

场景库可用一个 JSON 数组扩展，**同 id（大小写不敏感）覆盖内置场景，否则追加**。适合把业务的固定判定沉淀为一等场景，避免每次用 `systemone_decide` 手拼 questions——下面"组题配方"里的例子都可以直接改造成自定义场景。

各宿主的填写入口不同，值最终都收敛到 `SYSTEMONE_SCENARIOS`（建议压成单行）：

| 宿主 | 入口 |
|------|------|
| 环境变量（通用，推荐） | `SYSTEMONE_SCENARIOS` |
| ZCode | 设置页 → SystemOne Decision → Advanced → **Custom Scenarios (JSON)** |
| omp / Qwen Code | 无，只能用环境变量 |

改动后需重启宿主生效（MCP 是启动时拉起的 stdio 子进程）。注意它**只作用于 MCP 工具**，需求明确度预检 hook 不读这份配置。

### 场景字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一标识；与内置场景同 id 即覆盖该场景 |
| `title` | ✅ | 展示名 |
| `description` | | 场景说明（`list` 时展示） |
| `aliases` | | 别名数组，便于中文名查找 |
| `questions` | ✅ | 问题映射，1~16 个；问题对象 `{type, instructions, label?, criteria?}`（label 缺省用问题 id） |
| `derive` | | 派生字段：`{名: {question, values: [...]}}`（分值取整按下标映射，如 severity→P1~P4）或 `{名: {question, map: {...}}}` |
| `recommendation` | | 建议模板，渲染为结果里的 `recommendation` 一句话建议 |

### 校验规则

- 问题 1~16 个（延迟随问题数线性增长）；choice 选项 2~26 个；score 分级 ≥2 级。
- **非法条目整条跳过并在启动日志告警**，不影响内置与其余自定义场景；JSON 解析失败则回退纯内置场景库。
- 生效后 `action=list` 可见（标注"自定义"），describe / run 与内置场景无差别。

### 建议模板语法

| 语法 | 含义 |
|------|------|
| `{qid}` | 可读标签（choice=选项说明，score=分级说明，noul=是/否） |
| `{qid.key}` | 原始值（choice=选项 key，score=取整分值，noul=true/false） |
| `{qid.confidence}` | 置信度百分比 |
| `{派生名}` | derive 派生字段 |
| `{qid?文案A\|文案B}` | 条件文案（noul 为真 / 分值 ≥1 / choice 非空且非 none 类哨兵值时取 A；不支持嵌套） |

### 示例

```json
[
  {
    "id": "legal_review",
    "title": "法务 · 合同风险预审",
    "description": "判断合同风险等级与是否需要法务介入。",
    "aliases": ["法务", "合同"],
    "questions": {
      "risk":   { "type": "score",  "label": "风险等级", "instructions": "这份合同的风险有多高？",
                  "criteria": ["无风险", "低风险", "中风险", "高风险"] },
      "clause": { "type": "choice", "label": "问题条款", "instructions": "主要问题出在哪类条款？",
                  "criteria": { "none": "无问题条款", "liability": "责任与赔偿条款",
                                "payment": "付款与结算条款", "ip": "知识产权条款", "other": "其他" } },
      "lawyer": { "type": "noul",   "label": "法务介入", "instructions": "是否需要法务介入？" }
    },
    "derive": { "level": { "question": "risk", "values": ["L1", "L2", "L3", "L4"] } },
    "recommendation": "风险等级 {risk}（{level}），问题条款「{clause}」。{lawyer?需法务介入|可业务自审}"
  }
]
```

## params 判据覆盖

四种覆盖方式，按问题 id 指定，只覆盖要改的题：

```jsonc
{
  "action": "run", "scenario": "customer_service", "state": "…",
  "params": {
    // 1. criteria 整体替换选项（choice 传对象；score 传 ≥2 级标签数组，索引即分值）
    "department": { "criteria": { "billing": "账单与支付", "technical": "技术故障" } },
    // 2. addCriteria 在默认选项上追加/覆盖单个选项，不丢默认项（仅 choice）
    // 3. instructions 覆盖问题描述：{ "severity": { "instructions": "…" } }
    // 4. label 覆盖本地显示名：{ "escalate": { "label": "升级 PO" } }
  }
}
```

典型用法：

- **`agent_routing` 传真实 Agent 名册**（默认名册是示例）：

```
systemone_scenario(action: "run", scenario: "agent_routing",
  state: <任务描述>,
  params: { agent: { criteria: {
    "coder-zh": "中文编码助手", "researcher": "检索调研助手", "ops": "运维操作助手"
  } } })
```

- **`content_moderation` 传实际违规类型表**；**`customer_service` 传实际团队表**。

- **`result_verification` 的 state** 传结构化对象 `{ "task": <原始要求>, "result": <待检结果> }`。

- **`software_dev` 一般无需覆盖**，直接跑：判断编码请求是缺陷/功能/重构/评审/测试/文档/构建/性能，改动多大，要不要先检索代码库——适合驱动"先探查再动手"的工作流。

## `systemone_decide` 组题配方（场景库外）

### 通用意图识别

SystemOne 是"结构化问题 → 概率分布"的决策模型，**不是开放式意图分类器**：标签空间就是声明的 `criteria`。要通用意图识别就自定义标签集：

```
systemone_decide(
  state: <用户输入>,
  questions: {
    intent:   {type: "choice", instructions: "用户这句话最想做什么？",
               criteria: {query: "查询/检索信息", action: "执行一个操作", create: "新建内容或文件",
                          modify: "修改已有内容", analyze: "分析、对比、总结", explain: "解释原理或概念",
                          debug: "排查报错或异常", chat: "闲聊、寒暄", other: "以上都不是"}},
    urgency:  {type: "score", instructions: "这件事有多紧急？",
               criteria: ["不急", "可以等", "尽快", "马上"]}
  }
)
```

意图标签实践上限约 26 类（choice 选项建议 ≤26），超了只能合并或落到 `other`。

### 法务合同风险预审

```
systemone_decide(
  state: <合同文本要点>,
  questions: {
    risk:   {type: "score", instructions: "这份合同的风险有多高？",
             criteria: ["无风险", "低风险", "中风险", "高风险"]},
    clause: {type: "choice", instructions: "主要问题出在哪类条款？",
             criteria: {none: "无问题条款", liability: "责任与赔偿条款", payment: "付款与结算条款",
                        ip: "知识产权条款", other: "其他"}},
    lawyer: {type: "noul", instructions: "是否需要法务介入？"}
  }
)
```

### 为任务挑选模型

```
systemone_decide(
  state: "把这份 50 页 PDF 的中文合同翻译成英文",
  questions: {
    model:    {type: "choice", instructions: "应使用哪个模型？",
               criteria: {flash: "快且便宜，简单任务够用", pro: "质量优先，复杂任务"}},
    needs_rag: {type: "noul", instructions: "是否需要先检索参考资料？"}
  }
)
```

## 组题原则

- 一次决策 2~4 个问题最常见（内置场景均为 3 问）；问题数 ≤16，延迟随问题数近似线性增长。
- choice 选项 2~26 个，选项描述写"职责/特征"而非光秃秃的名词（"支付、退款、账单和计费问题" 优于 "billing"）。
- score 的 criteria 是分级描述数组，索引即分值，等级间要有清晰的递进关系。
- 需要"是/否"判断用 noul，返回 0~1 概率；概率落在 0.45~0.55 会被标记需人工复核。
- 同一业务上下文的多个问题放一次调用（同一 state 共享推理），不要拆成多次。
