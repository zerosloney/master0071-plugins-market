# 业务场景 → questions 组题参考

典型决策场景的组题方法：前 3 个场景用预设工具，其余 6 个用 `systemone_decide` 组题。所有判据都是示例默认值，接入真实业务时**整体替换为实际选项**——选项越贴近业务越准。

## 快速索引

| 场景 | 判定内容（题型） | 用法 |
|------|------------------|------|
| 客服运营 | 归属团队（choice）+ 升级 P0（noul）+ 严重度（score） | `ticket_triage` |
| 内容审核 | 违规与否（noul）+ 类型归类（choice）+ 放行/复审/拦截（choice） | `content_moderate` |
| 智能体路由 | 意图分流（choice）+ 是否调用工具（noul）+ 是否转人工（noul） | `agent_route` 或 `systemone_decide` |
| 销售线索 | 质量评分（score）+ 线索分配（choice）+ 是否值得跟进（noul） | `systemone_decide` |
| 金融风控 | 交易异常评分（score）+ 风险等级（choice）+ 是否人工复核（noul） | `systemone_decide` |
| 招聘 HR | 简历匹配打分（score）+ 是否进入下一轮（noul）+ 岗位归属（choice） | `systemone_decide` |
| 数据治理 | 文档打标（choice）+ 问题归因（choice）+ 是否敏感数据（noul） | `systemone_decide` |
| 教育内容 | 知识点归类（choice）+ 难度评分（score）+ 合规预检（noul） | `systemone_decide` |
| 需求与变更 | 优先级评分（score）+ 变更风险评级（score）+ 子任务派发（choice） | `systemone_decide` |

## 预设工具覆盖的场景

- **客服运营** → `ticket_triage`：department / severity / escalate 三问原生对应；传实际 `departments` 团队表更准。
- **内容审核** → `content_moderate`：`action` 即放行(approve)/复审(review)/拦截(reject)；"违规与否"由 `category` 是否为 none 与 `risk` 分值体现；传实际 `categories` 违规类型表更准。
- **智能体路由** → `agent_route`：已含"是否转人工"（needs_human）。若还需要"是否调用工具"且想一次调用齐发，用 `systemone_decide`：

```
systemone_decide(
  state: <任务描述>,
  questions: {
    intent:   {type: "choice", instructions: "该请求属于哪类意图？", criteria: {…实际意图表…}},
    use_tool: {type: "noul",   instructions: "完成该任务是否需要调用外部工具？"},
    human:    {type: "noul",   instructions: "是否需要转交人工处理？"}
  }
)
```

## `systemone_decide` 组题示例

### 销售线索

```
systemone_decide(
  state: <线索来源、需求描述、预算与时间线、联系方式完整度>,
  questions: {
    quality:   {type: "score", instructions: "该线索的质量评分是？",
                criteria: ["低：需求不明确或无预算", "中：有需求但时机未到", "高：需求明确、预算待定", "优质：需求与预算明确，近期可成交"]},
    owner:     {type: "choice", instructions: "该线索应分配给哪个团队？",
                criteria: {enterprise: "大客户组：定制化需求", smb: "中小企业组：标准化产品", channel: "渠道组：合作伙伴来源"}},
    follow_up: {type: "noul", instructions: "该线索是否值得销售跟进？"}
  }
)
```

### 金融风控

```
systemone_decide(
  state: <交易金额、渠道、时间、设备与历史行为特征>,
  questions: {
    anomaly: {type: "score", instructions: "该交易的异常程度是？",
              criteria: ["正常", "轻微异常：个别特征偏离", "明显异常：多项特征可疑", "高度异常：典型欺诈特征"]},
    risk:    {type: "choice", instructions: "该交易的风险等级是？",
              criteria: {low: "低风险，正常放行", medium: "中风险，加强监控", high: "高风险，限制交易", critical: "严重风险，冻结并调查"}},
    review:  {type: "noul", instructions: "该交易是否需要人工复核？"}
  }
)
```

### 招聘 HR

```
systemone_decide(
  state: <简历要点 + 岗位要求（技能、经验、学历）>,
  questions: {
    match:      {type: "score", instructions: "简历与岗位的匹配度是？",
                 criteria: ["不匹配：硬性条件不符", "偏低：多项要求未满足", "匹配：核心要求满足", "优秀：超出岗位要求"]},
    next_round: {type: "noul", instructions: "该候选人是否应进入下一轮？"},
    position:   {type: "choice", instructions: "该候选人更适合哪个岗位？",
                 criteria: {frontend: "前端开发", backend: "后端开发", algorithm: "算法工程师", pm: "产品经理"}}
  }
)
```

### 数据治理

```
systemone_decide(
  state: <文档标题、正文摘要、来源系统>,
  questions: {
    tag:       {type: "choice", instructions: "该文档应归入哪个类别？",
                criteria: {contract: "合同协议", report: "报告分析", invoice: "票据凭证", manual: "操作手册", other: "其他"}},
    cause:     {type: "choice", instructions: "该数据问题的主要归因是？",
                criteria: {entry: "人工录入错误", sync: "同步延迟或失败", schema: "Schema 变更未对齐", source: "上游数据源有误"}},
    sensitive: {type: "noul", instructions: "该文档是否包含敏感数据（个人信息、密钥、财务）？"}
  }
)
```

### 教育内容

```
systemone_decide(
  state: <题目全文与所属课程/年级>,
  questions: {
    knowledge:  {type: "choice", instructions: "该题考察的知识点是？",
                 criteria: {algebra: "代数", geometry: "几何", probability: "概率统计", calculus: "微积分"}},
    difficulty: {type: "score", instructions: "该题的难度是？",
                 criteria: ["容易：直接套用公式", "较易：一两步推导", "中等：多步综合", "困难：需巧妙构造或跨知识点"]},
    compliance: {type: "noul", instructions: "该内容是否存在合规风险（超纲、表述错误、不当内容）？"}
  }
)
```

### 需求与变更

```
systemone_decide(
  state: <需求/变更描述、影响范围、提出方与背景>,
  questions: {
    priority: {type: "score", instructions: "该需求的优先级是？",
               criteria: ["低：可延后", "中：正常排期", "高：尽快安排", "紧急：阻塞其他工作"]},
    risk:     {type: "score", instructions: "该变更的风险评级是？",
               criteria: ["无风险：仅文档或注释", "低：局部改动，影响单一模块", "中：跨模块改动，需回归", "高：影响核心链路或数据"]},
    dispatch: {type: "choice", instructions: "应派发到哪个子任务队列？",
               criteria: {dev: "开发实现", test: "测试验证", doc: "文档整理", review: "方案评审"}}
  }
)
```

## 组题通则

- 一条 `state` 携带判定所需的全部上下文，同一组问题共享上下文，一次调用全部返回。
- 问题数建议 ≤16；choice/score 选项建议 ≤26（上限 255）。
- 判据描述写"判断依据"而不是只写名字：`"大客户组：定制化需求"` 优于 `"大客户组"`。
- 低置信度（`needs_human_review = true`）时不要硬套结果，转人工或换判据重试。
