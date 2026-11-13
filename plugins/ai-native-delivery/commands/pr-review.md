---
description: PR 面板评审——多镜头独立找 bug + 验证者投票定共识 + 裁决处置闭环（升级版分级评审，按需触发）
stage: review（横切：合入前使用）
triggers:
  - "面板评审这个 PR"
  - "跑 PR 面板评审"
  - "pr-review"
next: gate PASS 后回 commands/review.md 用户定性合入；SHADOW/FAIL 时按 dispose 处置再重跑 gate
---

# PR Review · 面板评审（多镜头 + 投票 + 处置闭环）

> **与 /review 的分工**：分级评审（`commands/review.md`）是**默认**——机器门 + AI 自查清单 + 用户定性，单轮收口。面板评审是**升级档**——多镜头独立 finder 并行找 bug、每条 finding 独立验证者投票定共识、裁决处置后才判清零。禁互相代替：面板评审的 findings 照样过用户定性合入。

## 触发规则

满足任一条，跑面板评审；均不满足，走 `commands/review.md` 分级评审，禁跑面板：
- diff 触及信任边界 / 数据面 / 公共契约
- 合 main 前（高风险变更）
- 疑难回归需多镜头交叉验证

## 流程

脚本：`node <插件根>/scripts/pr-review.mjs`（子命令细节 `--help`；`--base` 默认 `origin/main`，`--head` 默认 `HEAD`）。按序执行，禁跳步：

1. `plan --base <ref> --head <ref>`：固定 base..head 为 SHA，生成 run.json / finder 工单（每镜头一份，内嵌 diff 切片）/ tasks.json。高风险快检加 `--fast`（镜头裁为仅 correctness，共识阈值降为单票）。
2. 按 `tasks.json` 并行派 finder / verifier 子代理（角色契约见 `agents/pr-finder.md`、`agents/pr-verifier.md`、`agents/pr-adjudicator.md`）。模型按 `model-roles.json` 的 `review` 角色取（本地覆盖 `.local.json` 优先，皆空 = 宿主默认）；派发禁传 `model` 参数——口径见 `model-roles.json` 的 `dispatch` 段。
3. 依序执行：`collect`（读 findings/*.json，归一化/去重/样式丢弃/标 provenance，生成 verifier 工单）→ `verify`（读 votes/*.json，按配置阈值算共识）→ `adjudicate`（对 escalated finding 落裁决）→ `dispose`（修复/豁免/延后/记录）→ `gate`（P0/P1 清零判定）→ `summary`（写 artifact + 月度台账行）。

## gate 两档

- **shadow**（默认）：findings 未清零只报 `SHADOW`，不阻断——适合评审进行中随时查状态。
- **enforce**：P0/P1 未清零即 `FAIL`（exit 1）——合入前最后一步用。

## 落账

- artifact：`workflow/reviews.d/artifacts/<YYYY-MM>/<runId>.json`（可提交、可对质）。
- 月度一行写 `workflow/reviews.d/<YYYY-MM>.md`（append-only，8 列自洽：意见数 = 采纳 + 拒绝 + 误报）——与 `commands/review.md` 既有复核效果台账同一口径，`gen-workflow-metrics.mjs` 月度聚合自动消费。

## PR 正文

评审清零后开 PR 用 `node <插件根>/scripts/pr-body.mjs --base <ref>` 生成三件套正文（Summary / Evidence / Merge Danger），agent 复制贴宿主的 forge（GitHub / TFS / 任何形态——插件不碰 forge API）。
