---
name: pipeline-closing
description: 推广环节闭环——L1 只起草一份 plan → 用户对话内确认 → 按 plan 改动面实施 → 2 关静态门 → 关单留痕（plan → done）。L2/L3 仍双写 intent + spec + plan。可复用于本项目 L1 推广环节（新增工具 / 微改动 / 协议修补）
concurrency: 2
---
# workflow — pipeline-closing（推广环节 6 阶段闭环）

> 把 5 个已闭环推广环节（E/A/D/C/F/B）的标准节奏固化为可复用编排。stage 用 role 派单 / gate 终端 / human 确认门三种形态——不引新 step（`_TEMPLATE.md` 解析校验要求 `step ∈ steps/`，新增 step 留给后续项目注册）。

| id | after | role | step | task / params | files（授权） | accept（验收判据） | gate | human | retries |
|----|-------|------|------|---------------|--------------|-------------------|------|-------|---------|
| author | — | implementer | — | 起草一份 L1 plan（fill-plan.mjs --level L1 + AI 填实），状态 draft。不另立 intent | workflow/plans/<date>-<topic>.md | plan 含入口/改动方案/约束与风险/验证计划/验收标准，状态 draft | | | 1 |
| gate-doc | author | — | — | — | — | — | node <插件根>/test/fill-intent.test.mjs && node <插件根>/test/fill-plan.test.mjs | | |
| confirm | gate-doc | — | — | plan 草稿全文过目，用户对话内一句"可以" → plan 状态 draft → approved + 回填「确认与复核」节 | — | plan 状态 approved + 「确认结果：approved（YYYY-MM-DD 用户对话内确认）」 | | 用户确认（plan 确认门） | |
| plan-commit | confirm | implementer | — | 提交 plan 立项 commit（docs(workflow)） | workflow/plans/, workflow/INDEX.md | pre-commit 钩子全过；commit message 含 plan 改动面摘要 | | | 0 |
| build | plan-commit | implementer | — | 按 plan §改动面 执行 | 见 plan | plan 改动面全部完成 | | | 1 |
| gate-test | build | — | — | — | — | — | 项目测试命令（必须全绿） | | |
| gate-loop | build | — | — | — | — | — | node <插件根>/scripts/check-loop.mjs（EXIT=0 且无 HARD-BLOCK） | | |
| feat-commit | gate-test,gate-loop | implementer | — | 提交 feat commit（feat(模块名)） | 工作区所有变更文件 | pre-commit 钩子全过；commit message 含 build 改动面摘要 | | | 0 |
| closeout | feat-commit | implementer | — | 勾 plan 验收 + plan → done + 关单 docs commit 留痕；同步 INDEX.md（如适用） | workflow/plans/<date>-<topic>.md, workflow/INDEX.md | plan 状态 done；验收勾验含 commit SHA 证据 | | | 0 |

**编排语义**：第 0 层 author → 第 1 层 gate-doc + confirm（confirm 为 human 确认门形态——宿主 AI 停下询问用户，不派子智能体；通过才派下层）→ 第 2 层 plan-commit → 第 3 层 build → 第 4 层 2 关静态门（并行 fan-out）→ 第 5 层 feat-commit → 第 6 层 closeout。失败且 retries > 0 → 重派（全新上下文）；gate 非零 / human 驳回 → 中止后续、汇总报告失败项。每个 stage 每次尝试出结果即向 `.agents/cache/orchestration-runs.jsonl` 追加一行（run journal，自报态）；中止续跑先读该文件——已 pass 不重跑。

**纪律**（先读）：
- 声明随 plan 确认后方可执行——本 workflow 是 plan 任务拆解的执行器；plan 草稿先经用户对话内确认。
- 子智能体不跨确认门、不 commit / push（派单红线行：只改授权文件；缺输入或需偏离 → `BLOCKER:` 停下）。确认门一律 human 形态行表达（confirm 行即此），不得派子智能体代行。
- 留痕：每个派单 stage 完成后向 `workflow/delegations.md` 委派结果表追加一行（`一次通过` / `返工×N` / `返工待修`）。
- 解析校验先行（机器门 `node <插件根>/scripts/workflows-check.mjs`）：role ∈ `.agents/roles/`、after 引用存在且无环、四形态恰填一项——任一不过即拒，不执行。
