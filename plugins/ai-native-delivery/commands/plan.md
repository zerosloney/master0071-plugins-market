---
description: Plan 阶段:L2/L3 立 intent。L1 plan 在 new-task 快速道第 3 步
stage: Plan
triggers:
  - "起个 intent"
  - "立 intent"
approval_required: true
next: L1 → commands/new-task.md §L1 快速道 ；L2/L3 → commands/design.md
---

# Plan · L2/L3 立 intent

L1 的立档、实现和关单在 `commands/new-task.md` §L1 快速道。本文件从 §3 起给 L2/L3。L1 只在下面 §1 发现已有在途 plan 时打开，用来对齐进度，然后回快速道。

级别已由 `new-task.md` 定；本节按级别分叉执行，禁重新定级。

## 1. 准入与捷径
**Input**: 用户需求原文 + 已定级别
**Process**:
1. **捷径检查（兼会话重入，session-context）**: L1 看 `workflow/plans/` 是否已有同名 plan；L2/L3 看 `workflow/intents/` 是否已有 approved intent。已有且**终态** → 按 `next` 跳；已有且**在途**（draft/approved、任务清单未全勾）→ 这是重入不是新建：读 plan 勾选态和 `git status` 对齐后续作，禁另立新档。L1 回到快速道，不打开 `build.md`。
2. **同类检索**: `node <插件根>/scripts/kb-search.mjs "<关键词>" --scope workflow --type intents,plans,specs` $\rightarrow$ 命中同类先读结论与验收
**Output**: 确认无同类入口 / 已有 approved 入口

## 2. L1：不在本文件起草
L1 plan 只在 `commands/new-task.md` §L1 快速道第 3 步起草。本节不另写 `fill-plan`。§1 的在途 plan 重入仍在本文件。

## 3. L2/L3：起草 intent
**Process**:
1. **生成草稿**: `node <插件根>/scripts/fill-intent.mjs --module <模块> --level <L2|L3> --topic <主题> --output workflow/intents/<date>-<主题>.md --notes "<备注>"`
2. **填实**: 背景与问题 / 历史教训防复发 / 目标 / 非目标 / 约束 / 影响面 / 触达红线 / 验收标准
3. **红线核对**: 对照根 `AGENTS.md` 及目录级 `AGENTS.md`。没碰到不勾。
**Output**: `workflow/intents/{name}.md` (Status: Draft)
**Next**: `design.md`

## 4. 确认与落态
**Process**:
1. **HALT**: 输出草稿全文 $\rightarrow$ 等待用户确认
2. **状态迁移**: $\text{draft} \rightarrow \text{approved}$（`confirm-doc.mjs`）
3. **留痕提交**: L2/L3 立即 `docs(workflow)` 单独提交；**L1 免单独立项提交**——plan 随首个实现提交一并入树，这一笔不标 done。关单走快速道第 6 步，单独收口。
**Next**: L1 $\rightarrow$ `commands/new-task.md` §L1 快速道 / L2,L3 $\rightarrow$ `commands/design.md`

## 🚫 禁止项
| 操作 | 机器行为 | 例外 |
|---|---|---|
| 硬填红线 | check-loop 判「红线判低」 | 必须实测触达才勾 |
| 硬填判据 | 验收标准不可测试 | 想不清楚必须 HALT 澄清 |
| 直改状态 | 状态迁移失效 | 必须通过 `confirm-doc` |

## 🛠️ 辅助工具
- **需求拷问**: `grilling` (答完回填 6 节)
