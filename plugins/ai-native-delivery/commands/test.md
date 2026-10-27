---
description: Test 阶段:静态门(架构红线 + build + test)+ UI 实测(headless Chrome)
stage: Test
triggers:
  - "跑下 verify"
  - "改完了"
  - "跑下 verify 看看"
  - "验证一下"
delegation:
  - role: ui-verifier
    instructions: agents/ui-verifier.md
    when: 涉及 UI 改动且静态门已通过
    required: true
    fallback: main
  - role: independent-reviewer
    instructions: agents/independent-reviewer.md
    when: L2 或 L3 改动完成且 diff 已固定
    required: true
    attach:
      - 同名 spec 的验收判据
      - 固定 git range：git rev-parse <基准> 可解析，且 git diff <基准>...<HEAD> 非空
      - 级别为 L2 或 L3
      - 新会话，不与实现同上下文
      - 结论首行 reviewed by <模型名>
      - 落盘行按 agents/independent-reviewer.md 由主智能体写入文档「确认与复核」
      - 不改任何仓库文件
approval_required: true
next: L2/L3 上 prod 时 → commands/deploy.md
---

# Test · 静态门 + UI 实测

L1 快速道在 `commands/new-task.md` §L1 快速道。本文件留给 L2/L3、切库冒烟、flaky 和独立复核。

## 1. 静态门 (Static Gates)
**Input**: 待验证代码变更
**Process**:
1. **执行门禁**: `node <插件根>/scripts/verify.mjs`（增量用 `--scope`，面规则在 `<插件根>/scripts/verify-scope.mjs`）。项目构建、测试、类型检查的命令清单单源是 `.agents/hooks/commit-check.config.json`。
2. **故障处置**: 任一失败 $\rightarrow$ **HALT**。L1 回 `commands/new-task.md` 快速道第 5 步改代码。L2/L3 回 `build.md` 修复。偶发/跨层问题用 `diagnosing-bugs` 诊断。全量首跑红、隔离重跑转绿不算绿：按 flaky 立项（papercut/incident）后修复，禁以重跑绿直接关单。
**Output**: 静态门全绿证据
**Note**: 运行环境细节见 `.agents/notes/runtime-env.md` §1, §2；长门禁命令（verify 全量/`dotnet test`）**分段等 + 每段回报进度**，不阻塞到 timeout 上限——口径 §6.4「后台长任务取结果」

## 2. 切库冒烟 (DB Smoke Test)
**Trigger**: 改了项目数据库连接配置或新增目标库
**Process**:
1. **Schema 比对**: 目标库实际 Schema $\leftrightarrow$ 代码期望（近期变更脚本 + 基础表）
2. **接口探活**: 运行冒烟脚本 $\rightarrow$ 验证 6 个核心端点 $\text{HTTP 200}$
**Output**: 探活通过证据
**Fact**: 探活脚本路径见 `.agents/notes/runtime-env.md` §6.1
**Fail**: 任一非 200 $\rightarrow$ **HARD-BLOCK** $\rightarrow$ 停在此步，禁部署。

## 3. UI 实测 (UI Verification)
**Trigger**: 涉及前端改动 $\text{AND}$ 静态门已通过
**Process**:
1. **调用技能**: 使用 `.agents/skills/verify-ui/SKILL.md` 执行实测。
2. **环境配置**: 详情见 `.agents/notes/runtime-env.md` §4 与 §6.3
**Output**: UI 验证报告 (截图/DOM 证据)

## 4. 独立复核 (Independent Review - L2/L3 强制)
**Input**: 入口文档 (intent/incident) + spec + plan + diff
**Process**:
1. **委派复核**: 将任务交给 `independent-reviewer`。必附文首该角色的 `attach`，缺一项不派。落盘行由主智能体按 `agents/independent-reviewer.md` 写入。**跨模型优先**：优先指派与执行方不同代/不同家族的模型（同模型新会话仍有共模盲区），无法做到时在复核结论记原因
2. **评审定性**: 根据复核意见 $\rightarrow$ 采纳 $\rightarrow$ 回 `build.md` 修改 $\rightarrow$ 重跑本阶段
3. **意见级落账**: 复核收口时在 `workflow/reviews.d/<当月>.md` 追加一行，口径见该文件头注。
**Output**: 复核结论 (Approved / Reject) 首行署名 `reviewed by <模型名>`（署名不可省，可追责凭证；「无 flag」也是合法结论但模型名必须留）+ 意见级台账行

## 5. 确认后关单 (Closure)
L1 关单在 `commands/new-task.md` 快速道第 6 步与关单技能。本节从 L2/L3 新需求和修复类起。
**Process**:
1. **验证与关单**: 按 `.agents/skills/workflow-closeout/SKILL.md`。
2. **验收勾验**:
   - **L2/L3 新需求**: 逐条勾验 intent「验收标准」 $\rightarrow$ 补证据 $\rightarrow$ intent $\text{approved} \rightarrow \text{done}$
   - **修复类**: 验证防复发落地 $\rightarrow$ incident $\text{open} \rightarrow \text{fixed} \rightarrow \text{closed}$
3. **同族清理**: L2/L3 与修复类的同名 plan 一并置 `done`。不留 `approved` 孤儿。
4. **留痕记录**: 委派任务记入 `workflow/delegations.md` 委派结果表；L2/L3 自做记入自做任务结果表。自做 L1 不写。写了行才跑 `node <插件根>/scripts/agg-delegations.mjs --write`。
5. **顺事回灌（advisory）**: 有摩擦记 `workflow/papercuts.md`，没有就在关单回复写「无候选」。
**Next**: L2/L3 $\rightarrow$ `commands/deploy.md`

## 🚫 禁止项
| 操作 | 机器行为 | 例外 |
|---|---|---|
| 顺手改代码 | 违反 Test 阶段定义 | 必须回 `build.md` 修复 $\rightarrow$ 重跑 Test |
| 部分通过 | `ui-verifier` 报告阻塞 | 禁将部分通过项标记为已通过 |
| 缺证据勾选 | check-loop 拦截 | 必须提供具体证据 (截图/SHA/Log) |
