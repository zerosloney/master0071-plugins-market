---
description: 代码评审标准（按风险分级：机器兜底 + AI 自查出清单，用户决策定性和合入）
stage: review（横切：合入前使用，不占 6 阶段之一）
triggers:
  - "评审一下"
  - "过 review 标准"
  - "按评审标准过一遍"
delegation:
  - role: independent-reviewer
    instructions: agents/independent-reviewer.md
    when: 机器门禁完成且复核目标与 diff 基准已固定（L2 / L3 强制独立复核：独立子智能体或新会话，不得回退主智能体自查）
    required: true
approval_required: true
next: P0/P1 未清时 L1 → commands/new-task.md §L1 快速道改代码；L2/L3 → commands/build.md。清零后经用户确认合入
---

# Review · 分级评审

> **三分工**：机器门禁自动拦（无需人守）$\rightarrow$ AI 复核出分级清单 $\rightarrow$ 用户定性/合入；禁互相代替（AI 禁下合入定性，用户禁被代判）。
> **独立性**：L2/L3 必须用独立子智能体或新会话，禁原作者自查冒充。

## P0 必拦 (Block)

| 检查项 | 判据 (Invariant) | 机器兜底 | AI 自查 |
|---|---|---|---|
| **架构红线** | 分层依赖方向约束（领域/应用层禁引基础设施实现） | `.agents/hooks/` 架构门禁 | 豁免清单外的引用 |
| **审计字段** | 公共审计字段由统一基础设施自动写入，禁业务代码手写 | 审计字段门禁 (比对新增加值) | 无 |
| **删除拦截** | 删前必须查子级/业务引用，被引用时按统一口径报错 | 删除门禁 (调用点 vs allowlist) | 每个调用点核对删前查引用 |
| **入参校验** | 必填判空、范围校验、非法输入按统一口径拒绝 | 项目验证测试 | 覆盖盲区自查 |
| **L2/L3 无 spec** | 拒收，先回 `workflow/specs/` 立 spec 确认 | `confirm-doc` →done 门（L2/L3 intent 须同名 spec 已确认；2026-10-21 起——配对扫描门已降 WARN，执法点前移至关单动作时刻） | 无 |

## P1 应拦 (Self-check)

| 检查项 | 判据 (Invariant) | 备注 |
|---|---|---|
| **DB 命名与迁移** | 遵循表/字段/外键命名规范与 schema 变更流程 | 禁擅自引入未采用迁移机制 |
| **前端形态** | 新增/编辑与大数据量选择遵循组件约定 | 弹层 vs 跳页、选择器形态、表格样式 |
| **表单** | 可选字段空值归一化后提交 | 禁改后端 DTO 规避校验 |
| **状态管理** | store 调 API，组件只调 store | 无 |
| **API 入参边界** | 写操作禁 `[FromBody]` 绑定领域实体（一律 DTO） | 入参 DTO 禁含主键与审计字段 |
| **导入信任边界** | 导入端点服务端全量复验，禁信任客户端 | 解析失败进错误行汇总，禁静默丢弃 |
| **Create/Update 同口径** | Create 校验 Update 必须同口径 | 被引用的标识符字段禁改 |
| **分页与状态语义** | 分页参数范围校验 + 服务层钳制 | 非法状态与不存在分离 (400/404) |
| **spec 承诺落地** | spec §测试用例须真落到测试或验证脚本 | 常驻断言禁写成随时间增长的行数常量 |
| **薄适配漂移** | 宿主 `agents/`、`commands/` 保持指针壳，正文只在插件 `agents/` 与 `commands/` | `<插件根>/scripts/check-loop-sections/s05-adapters.mjs`（段 5）检查壳引用权威路径且正文不过厚 |
| **影响面证明** | 小 diff 的「安全因为 X」须跑代码证明，不靠口头 | 按 `.agents/skills/blast-radius/SKILL.md` 走；证明脚本随 PR 或落 `tmp/` |

## P2 建议 (Advisory)

- 样式统一性（深色/浅色主题、卡片样式）
- 注释完整性（复杂逻辑处补注释）
- Conventional Commits 中文（feat / fix / docs / style / refactor / perf / chore）
- 历史同类 incident 复盘三件套是否补齐

## 执行流程 (Process)

**Input**: 待评审 diff + 固定基准 (SHA/分支)
**Process**:
1. **机器门禁**: pre-commit / pre-push / `test.md` 静态门全过 (无需人守)
2. **AI 复核**: 委派 `independent-reviewer` $\rightarrow$ 聚焦 P0 未覆盖项 + 全部 P1 (P2 视精力)
   - **方法**: `.agents/skills/review-method/SKILL.md` (Standards×Spec 双轴 + 坏味道走查 + 合入标尺；有全局 `code-review` 技能时可叠加)
   - **防误报**: 每条 finding 过 `review-verification-protocol` (锚定 file:line、给证据、校准严重级，不确定降级为提问)
   - **落账**: 复核收口时在 `workflow/reviews.d/<当月>.md` 追加一行事件记录（口径见该文件头注；采纳+拒绝+误报=意见数）
   - **模型选择**: 取 `model-roles.json`（本地覆盖 `.local.json` 优先，皆空 = 宿主默认）。`heterogeneous` 须与实现不同模型，做不到只跑质量镜头并记降级。换模型前按 `delegations.md` 跑 3 个已定性 bug 回归
   - **高风险 diff**: 叠加 `.agents/skills/interrogate/SKILL.md`（多模型多镜头独立拆，聚合去重；不替代上面的单一独立复核）
3. **用户决策**: 问题定性 (误报驳回 / P0 必修 / P1,P2 裁量) + 合入时机
**Output**: 分级问题清单 + 修复建议 $\rightarrow$ 用户确认合入
**Next**: P0/P1 未清时，L1 回 `commands/new-task.md` §L1 快速道改代码；L2/L3 回 `build.md`。清零后经用户确认合入。

## PR 体三件套（合入叙事约定）

开 PR 时 body 固定三节，各答一个合入决策要素，缺一不可（matt `pr` 同构；Azure DevOps 无技能钩子，本节即约定单源）：

| 节 | 答 | 形态 |
|---|---|---|
| **Summary** | 这是什么改动 | 1-4 条：为什么改、改了什么，指向关键模块/文件——必须来自实际 diff，写实际行为不写意图修辞 |
| **Evidence** | 证据呢 | 实际运行的测试/构建/手工验证（Before/After 对照：改前红改后绿的测试对、同视角前后截图）；挂绿凭证或实测证据路径，须可点开复核；没运行就明确写「未运行」及原因，禁编造 |
| **Merge Danger** | 风险多大 | **Door**: 影响面（API / DB / 配置 / 权限 / 兼容性），无风险写「无」，禁省略；**Blast Radius**: 一词（局部 / 模块 / 全局）；**Rollback**: 回滚方式与风险，必填 |

体积超预算（pre-push advisory；覆盖须 `PR_SIZE_OK=1` 并在 Tradeoffs 写理由）、diff 大、overlap 非空或不可逆变更 → body 另加 **Tradeoffs** 段：真实 diff 规模 + 为什么仍这样做。

写不出「Door=无 + 局部」时即触发一次定级复核——L2/L3 触达面单据天然大影响面，与两问定级互证。

> 分发型技能（如 `tfs-pr`）自带同款模板，那是其**无约定宿主的缺省值**；本仓以本节为准，判据随本节演进（技能侧已声明宿主优先）。

## 🚫 禁止项
| 操作 | 后果 / 机器行为 | 例外 |
|---|---|---|
| L2/L3 主智能体自查 | → 独立性失效 | 必须委派 `independent-reviewer` 或新会话 |
| P0 未清合入 | → 拦截 | 必须清零后经用户确认 |
