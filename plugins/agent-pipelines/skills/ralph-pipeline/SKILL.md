---
name: ralph-pipeline
description: 通用多代理编排管道（Ralph-Pipeline），线性 TaskList 驱动「Orchestrator → 执行者 → 审查者」循环，带状态持久化与背压熔断。当用户要求把一个复杂目标拆成多个任务、逐项执行并逐项审查、需要断点恢复或需要防止无限循环撞轮次上限时使用。适用于任意领域（写文档、跑数据迁移、批量重构），不局限于编码。
license: MIT
compatibility: Requires a host that can dispatch subagents (Task or task tool) and keep a state file across rounds.
---

# Ralph Pipeline

通用编排执行审查管道。线性 TaskList，每轮把就绪任务并行走「执行者 → 审查者」，按背压熔断门禁决定停止。

## 角色

你是本管道的 **Orchestrator**。只做四件事：维护任务拓扑、委派、写入状态、按门禁决定停止。**不直接执行业务产出。**

- 任务状态：`pending` / `in_progress` / `done` / `blocked`
- 每轮把全部可执行任务并行委派给执行者（存在多个就绪任务时全部发出，不串行等待），审查者复核后才允许置 `done`
- 执行者与审查者的完整角色契约见 `references/worker-role.md` 与 `references/reviewer-role.md`——委派前必须读取对应 reference 并把角色契约注入子代理上下文

## 状态持久化

状态文件路径：`.loop-cli/state/ralph-pipeline.json`（写在**项目工作区**，不写插件目录）。

**并发限制**：路径按仓库固定，同一仓库同时跑两条同类管道会共用此文件并互相覆盖状态（文件锁只防写撕裂，不防逻辑覆盖）。需要并发时，把其中一条会话的此路径与全部 `--file` 调用同步改成会话专属路径（如 `.loop-cli/state/ralph-pipeline-<slug>.json`）。

JSON 格式（严格按此 schema，`version` 用于检测格式漂移）：

```json
{
  "version": 1,
  "prompt": "<原始 prompt>",
  "max_iterations": 0,
  "max_failures": 3,
  "retry_on_failure": false,
  "completion_promise": null,
  "outer_iteration": 0,
  "tasks": [
    {
      "id": "t1",
      "title": "<任务标题>",
      "status": "pending | in_progress | done | blocked",
      "depends_on": ["<前置任务 id>"],
      "accept_criteria": ["<验收标准>"],
      "subtask_of": "<被拆分来源任务 id，仅子任务填写，用于追溯>",
      "failures": 0,
      "max_attempts": 4
    }
  ],
  "consecutive_failures": 0,
  "stall_counter": 0,
  "fail_history": [
    { "task_id": "t1", "round": 1, "reason": "<失败原因>" }
  ],
  "round": 0,
  "stop_reason": null,
  "budget": {
    "max_tokens": 100000,
    "spent_tokens": 0
  }
}
```

上面代码块是**可直接复制的合法 JSON**（不要往 JSON 里写注释），字段说明：

- `max_iterations`：`0` = 使用默认值（ralph 为 10），`>0` 则覆盖 `MAX_CYCLES`。
- `max_failures`：连续失败达此值立即 ESCALATE，默认 3；旧状态文件缺此字段时按本默认值补齐。
- `retry_on_failure`：`true` 时单次 FAIL 可先重试一次，再计入连续计数。
- `completion_promise`：`null` 或期望的 promise 字符串；仅当用户显式传入 `--completion-promise` 时生效。
- budget（可选）：`{ max_tokens?, max_cost_usd?, spent_tokens?, spent_cost_usd? }`；达到上限时 gate 判 `BUDGET`。上面代码块里的数值只是占位示例，按用户给的预算改写；不设预算就整块删掉 `budget` 字段（写成 `0` 会被当成「上限为 0」立刻 BUDGET）。
- `subtask_of`：仅子任务填写，标注拆分来源任务 id，用于溯源。
- `max_attempts`：单任务尝试上限，默认 4。任一任务 `failures` 达到 `max_attempts` 时立即 `ESCALATE`，避免单任务无限重试。

### 写入规则

- 每轮结束时写入，先写 `.loop-cli/state/ralph-pipeline.json.tmp`，再重命名为 `.loop-cli/state/ralph-pipeline.json`（防止写入中断导致文件损坏）。
- `stop_reason` 枚举值：`null`（运行中）| `"DONE"` | `"ESCALATE"` | `"BUDGET"` | `"HOLD"` | `"STALL"` | `"MAX_CYCLES"` | `"STOPPED"`。
- `fail_history` 保留最近 10 条，超出时丢弃最旧的。
- 每轮结束时计算「任务状态签名」（所有任务按 id 升序拼成的 `id:status` 有序串）：与上一轮**完全相同** → `stall_counter += 1`；有任一变化 → `stall_counter = 0`。
- 若宿主可执行 shell，优先用插件根的 `scripts/state.mjs write --pipeline ralph` 从 stdin 原子落盘，并在 JUDGE 后用 `scripts/state.mjs gate` 计算停止条件；脚本不可用时按本节规则手写。

### 读取规则

1. 解析 JSON，校验 `version === 1` 且所有必填字段存在。
2. 旧版本状态文件缺少 `max_failures` / `retry_on_failure` 时按默认值补齐，不算损坏。
3. 若格式不合法 → 询问「状态文件损坏，是否新建？」
4. 若 `stop_reason` 非空 → 询问「上次因 {stop_reason} 终止，是否重试？」
5. 若所有任务状态为 `done` → 询问「已完成，是否重新开始？」
6. 恢复时跳过 `done` 任务，继续执行剩余任务。

## 完成标准

DONE 必须**同时**满足：

- TaskList 全部任务状态为 `done`。
- 每个任务的产出都经过审查者 PASS。
- 最后一次背压验证命令通过。
- 无未处理的 critical / major。

执行者自报完成、单次 PASS 都不算最终完成。

## 任务复杂度评估与拆分

**再拆分判据**：单个任务满足任一条即视为过大，需原地拆成子任务——

- `accept_criteria` 条数 > 3
- 预计改动跨文件 > 5，或跨模块 > 2

ralph 域专属约束：

- **预算 ≤ 8**（`MAX_CYCLES=10 × 0.8`，留 retry buffer）。
- 原任务可被完全替换（由子任务链替代），也可保留为聚合占位。

拆完后核算子任务总数 ≤ **8**。超出则强制再拆当前最大的任务，直到达标。若已无法再拆（原子任务）仍超预算 → 立即停止委派并向用户报告 `decomposition_overflow`，不闷头撞 `MAX_CYCLES`。

## 初始化

1. 读取用户请求；为空则询问用户。
2. 若状态文件存在，按「读取规则」处理恢复或新建；新建时删除旧文件。
3. 把请求拆解为 TaskList，每项严格按 JSON schema 的 `tasks[]` 格式。**检查 `depends_on` 是否存在循环依赖**（如 A→B→C→A），存在则报错并要求用户修正。
4. 按上节「任务复杂度评估与拆分」逐项评估，对过大任务原地拆成子任务，`subtask_of` 标注溯源，新 `depends_on` 接入拓扑。子任务总数超预算且无法再拆时输出 `action="HOLD"`、`reason="decomposition_overflow"` 交用户。
5. 初始化 `consecutive_failures = 0`、`stall_counter = 0`、`round = 0`、`stop_reason = null`。
6. 设置 `MAX_CYCLES = 10`（超过此轮次仍未 DONE 则强制停止）与 `STALL_MAX = 3`（连续 3 轮任务状态签名无变化则判 STALL）。二者均为初始化硬上限，不被 `fail_history` 或 `round` 覆盖。每轮约消耗 2-3 个 agentic step。
7. 确定背压验证命令。优先沿用仓库已有的测试或检查命令（package.json 的 test 脚本、Makefile 的 test 目标或 CI 验证步骤）；仓库没有可用的验证命令时询问用户，不要自行臆造。

## 委派机制

**核心规则：必须使用子代理工具执行任务，不得直接编写产出。**

宿主不支持子代理委派时，退化为主会话直接扮演执行者/审查者，不静默失败。

### 语义映射（参数名按宿主实际 schema 填写）

| 语义 | 宿主子代理工具（如 ZCode `task`） | Claude Code `Task` |
|------|-----------------------------|---------------------|
| 目标子代理 | `target` | `subagent_type` |
| 任务标题（3-5 个词） | `description` | `description` |
| 完整上下文正文 | `query` | `prompt` |

宿主若支持语言参数（如 `response_language`）可显式指定 `"zh"`；不支持则忽略。

### 决策流程

```
1. Orchestrator 选出本轮全部可执行任务（pending 且依赖已 done）
2. 按拓扑顺序逐个调用 ralph-worker 执行任务（存在多个就绪任务时全部发出，不串行等待）
3. 等待所有 worker 完成并获取结果
4. 逐个调用 ralph-reviewer 审查产出
5. 根据各 reviewer verdict 更新任务状态
6. 写入状态文件
7. 判断停止条件
```

### 注入上下文

#### 给执行者的上下文（对齐 executor 输入契约）：

```text
=== 目标 ===
{goal}

=== 当前任务 ===
id: {task_id}
title: {task_title}
accept_criteria:
{accept_criteria}

=== 已知上下文 ===
相关文件、约束、前置任务产出：
{known_context}

=== 验证命令 ===
{verify_cmd}

=== 失败教训 ===
此前失败记录（避免重复踩坑；无则写"无"）：
{fail_lessons}

=== 执行轮次 ===
{round}
```

#### 给审查者的上下文（对齐 reviewer 输入契约）：

```text
=== 目标 ===
{goal}

=== 当前任务 ===
id: {task_id}
title: {task_title}
accept_criteria:
{accept_criteria}

=== 执行者产出 ===
{worker_result}

=== 本轮变更 ===
{diff_or_files}

=== 审查轮次 ===
{round}
```

## 执行路径

每轮：

1. 从 TaskList 选下一个可执行任务（`pending` + 依赖已 `done`）。
2. 委派执行者执行任务，注入完整上下文。
3. 获取执行者结果后，委派审查者审查产出。
4. 根据审查者 verdict 与验证结果更新任务状态：
   - PASS → 任务 `done`，`consecutive_failures = 0`。
   - PASS 必须附 `evidence`（`file:line`、命令与输出摘要、accept_criteria 对照）；无 evidence 的 PASS 按 NEEDS_FIX 处理。
   - NEEDS_FIX → 任务回 `pending`，`consecutive_failures += 1`，附 failure note。
   - REJECT → 任务 `blocked` 或回 `pending`，`consecutive_failures += 1`。
5. 按 JSON schema 格式写入状态文件（遵循「写入规则」的原子写入流程）。
6. 判断停止条件。

## 背压熔断

- `consecutive_failures` 达到状态文件里的 `max_failures`（默认 3）→ 立即 ESCALATE，停止委派。
- 任一任务 `failures` 达到状态文件里的 `max_attempts`（默认 4）→ 立即 ESCALATE，避免单任务无限重试。
- `retry_on_failure=true` 时，单次 FAIL 可重试一次再计入连续计数。
- 任务被标 `blocked` 时必须给出阻塞原因，不强制推进。

## 停止

按顺序判断：

1. **DONE** —— 见「完成标准」，全部满足。
2. **ESCALATE** —— 熔断触发，或审查者给出不可恢复的 critical。
3. BUDGET（token 或费用预算耗尽）
4. **HOLD** —— 仅剩 `blocked` 任务，需用户决策。
5. **STALL** —— `stall_counter >= STALL_MAX`（默认 3，连续 3 轮任务状态签名无变化）。
6. **MAX_CYCLES** —— `=10`（或 `max_iterations`），超过仍未 DONE。
7. **STOPPED** —— 用户要求停止。

早停优先；满足 DONE 立即停止。停止时按 JSON schema 写入最终状态，设置 `stop_reason` 为对应枚举值。

### Completion promise 检查

若状态文件 `completion_promise` 非空，每轮 JUDGE 阶段检查执行者输出中是否包含 `<promise>...</promise>` 标签（匹配 `completion_promise` 值）。匹配则立即设置 `stop_reason="DONE"` 并跳过后续任务。

注意：promise 匹配是 DONE 铁律的显式覆盖，**仅当用户显式传入 `--completion-promise` 时生效**，绕过 verdict / 验证 / critical 门禁。
## 输出格式

每轮输出一段机器可路由的 JSON：

```json
{
  "action": "DELEGATE | WAIT_REVIEW | DONE | ESCALATE | BUDGET | HOLD | STALL | MAX_CYCLES | STOPPED",
  "task_id": "<下一任务 id，DELEGATE 时必填>",
  "budget": {
    "max_tokens": 100000,
    "spent_tokens": 0
  },
  "reason": "<简短说明>"
}
```

- `action` 取值与 `stop_reason` 枚举对齐：`DONE | ESCALATE | BUDGET | HOLD | STALL | MAX_CYCLES | STOPPED` 七个停止原因都能从这里表达。
- `budget`：本轮读到的预算快照，未设预算时省略该字段；上面的数值是占位示例。

## 红线

- 不直接执行业务产出。
- 不跳过背压验证。
- 不在熔断阈值触发后继续委派。
- 不把审查者 REJECT 的任务标记为 done。
