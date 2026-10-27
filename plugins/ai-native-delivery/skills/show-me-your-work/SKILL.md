---
name: show-me-your-work
description: 长跑/无人值守的决策轨迹——append-only TSV，一行一个决策（what/why/evidence/result），证据是指针不是段落；供过夜、多阶段、用户离开后复核时使用。
---

# show-me-your-work — 决策轨迹

## 触发

- 无人值守 / 过夜 / 多阶段长跑（`autonomous-run`；历史 `pipeline-run` 运行）。
- 用户说「我走了 / 回来再信你 / 跑完给我看」。
- 改动跨多个单元，事后需要一条可复核的决策链。

## 格式

单个 TSV，一行一个决策。单元格保持单行；证据是指针，不是段落。

```
ts	phase	decision	why	evidence	result
```

- **ts**：ISO8601。
- **phase**：阶段或工作流。
- **decision**：选了什么/做了什么，一行。
- **why**：理由，用大白话；原则驱动就直说，不要堆术语。
- **evidence**：能证明的指针——commit SHA、PR 号、`file:line`、artifact/trace/截图路径。禁段落。
- **result**：结果或谓词状态——`tests green` / `reverted` / `pixel-diff 0` / `INCONCLUSIVE` / `open`。

模板：`skills/show-me-your-work/references/decision-log-template.tsv`。

## 记录规则

- **append-only**：错行不删，追加一行 supersede；永不编辑/删除历史。
- 只记决策点与检查点：选了哪个分叉、单元完成及其验证结果、pivot/revert 及触发、暴露的阻塞、修好的门。琐碎动作不记。
- 循环跑：一轮一行。
- 一次 run = 一个 agent 会话（含后续轮次）。接手/换会话/新 chat = 新 run；新 run 的第一行 phase 写 `start`，并在 evidence 里点名本 run（如 agent id）。
- 证据优先用**已提交脚本**产出的，而不是手搓一次性命令（「先升层再写文」）。

## 存放

- 默认是工作产物，不提交：`decisions.tsv` 或 `.audit/<task-slug>.tsv`，留在 git 外。
- 只有「复核者需要这条轨迹才敢信结果」时才提交（大改 / 无人值守 / 跨多 PR）。

## 收尾审计

交回前，用本 run 的 transcript 对账：每行是否对应真实决策/动作；evidence 是否能解析并证明该行；影响过工作但没记的分叉/pivot 是缺口，补上。审计不改故事——错行用新行 supersede。

## 跨模型复核

交回前，用**不同模型档**的子代理读轨迹 + transcript，标出用户该注意的点：证据弱/缺失、验证跳过或只在口头上、事后看有风险的决策、用户随手扫会漏的缺口。回复末尾给 `Attention` 段，首行 `reviewed by <model>`；`No flags` 是合法值。

## 本仓落点

- `autonomous-run`：立约时加一条「决策留痕」。
- 历史 `pipeline-run` 运行：每个工单签收记一行。
- `workflow/delegations.md`：委派结果仍记台账；本 TSV 是 per-run 的决策链，不替代台账。
- 追加一行：`node skills/show-me-your-work/scripts/decision-log.mjs <logfile> <phase> <decision> <why> <evidence> <result>`（自动 ts、首用表头、清洗 tab/换行、转义 `=+-@` 开头）。
