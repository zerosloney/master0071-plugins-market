---
name: autonomous-run
description: 无人值守长跑合同——长任务/过夜时逐单元签收、自底向上落地、何时停机；供主智能体在用户离开前立约使用（pipeline-run 已停用）。
---

# autonomous-run — 无人值守合同

用于长跑（过夜 / 用户离开）。**pipeline-run 已停用（2026-10）**：推进按本合同的逐单元签收，编排走项目侧 `.agents/pipelines/`（由初始化从插件 `config-templates/pipelines/` 种子落位）或手动阶段。**不放宽任何门禁与确认门**，只约定推进节奏与停机条件。

## 立约（开工前一次）

1. **授权面**：写明允许改的目录/分支、本次 run 的目标文档。
2. **禁做清单**：远程 push、部署、删数据、直改 workflow 状态、`--no-verify`——仍需用户明确指令。
3. **预算**：修复环沿用 3 次上限（原 pipeline-run 口径）；不新增预算。
4. **停机联系人**：用户回来即停，汇报现状。
5. **决策留痕**：长跑/过夜按 `.agents/skills/decision-log/SKILL.md` 记 `decisions.tsv`（append-only，证据是指针）；提交与否按 stakes 定。

## 逐单元签收（每个 implement / fix 工单）

1. 按授权文件实现，偏离即停（计划外文件 / 公共接口 / 新依赖）。
2. 跑 `node <插件根>/scripts/verify.mjs --scope`，必须退出码 0。
3. 记录绿凭证的 `headShort`（s15 指纹）；**HEAD 变了或凭证超 24h 窗 → 重跑**，不沿用旧绿。
4. 签收后才 `next`；不绿不推进，不攒批。

## 落地顺序

- 按依赖自底向上，一个单元一笔提交，Conventional Commits 中文。
- 跨单元不合并提交；后一单元基于前一单元的已签收 HEAD。
- 同一单元返工后，旧凭证作废，重新签收。

## 停机条件（任一触发即停并汇报）

- 修复环达 3 次仍红。
- 指纹不匹配 / 绿凭证过期且重跑仍红。
- 需要越界文件、公共接口变更或新依赖。
- 同一根因的两次假设都被证伪。
- 用户回来或发出任何新指令。

## 恢复

中断后先按 `.agents/skills/session-resume/SKILL.md` 重建；历史 pipeline-run 运行如需对账，脚本仍保留（已冻结）可跑 `status --run <id>`；已签收单元不重做。

## 汇报

阶段条 / 各门结果 / 提交链（sha + 标题）/ 未决项与需要用户决定的事项。
