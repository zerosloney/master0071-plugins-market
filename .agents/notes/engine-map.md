# 引擎地图（生成物，勿手改）

> 生成器 `node <插件根>/scripts/gen-engine-map.mjs`（单源现场取数；`--check` 防漂移——改引擎后重生成随同提交）。
> 一页冷启动地图：接手会话/新协作者读本页替代全仓考古；明细按 §维护 的单源指针下钻。

## 执行模型（一段）

本引擎无常驻进程：**文档即状态机**（`workflow/` 四目录，frontmatter `状态: draft→approved→done` 由 confirm-doc 迁移）+ **git 钩子即执法点** + **脚本即确定性验证器** + **AI 即执行体**（读命令/技能/角色契约行动）。质量分工：确定性脚本管事实（确认过没有/验证过没有/红线判低），模型管判断（定级/根因/设计/复核）。

## 执法卡口

git 钩子 4 个：

| 钩子 | 跑什么 |
|---|---|
| commit-msg | 提交信息规范（Conventional Commits） |
| post-commit | 领先 upstream 提示（勤推小步） |
| pre-commit | 硬拦：台账不变量（触及才跑）+ 四业务守卫 + 常驻面体积预算 + commit-check（--no-build）；advisory 五门已撤（2026-10-21） |
| pre-push | check-loop hard 段扫描（--rev 按推送树）+ commit-check --range 范围条件构建 |
| CI（azure-pipelines） | （未找到 azure-pipelines.yml——CI 触发面未知） |

## verify 门表（20 门，单源 verify.mjs GATES；--scope 按 diff 面裁剪）

`scripts-syntax` · `engine-tests` · `workflows-check` · `rule-budget` · `local-gate-config` · `effective-policy` · `engine-map` · `workflow-index` · `workflow-metrics` · `check-loop` · `ledger-doc-presence` · `ledger-invariant` · `lane-surface-ci` · `secrets-scan` · `frontend-lint` · `frontend-unit-test` · `wiki-consistency` · `backend-build` · `backend-test` · `frontend-build`

## check-loop 段（22 段 = hard 5 + hygiene 17；单源 check-loop.mjs SECTIONS）

- **hard 车道**（默认关单/pre-push 扫）：s01_pairing、s03x_regr_evidence、s08_acceptance、s15_fingerprint、s29_regr_enforcer
- **hygiene 车道**（--hygiene/--all 才扫）：17 段（索引/宿主/词表/指标/委派等 WARN——月检道）

## 机制台账状态（65 行，单源 mechanism-registry.md）

现役 65 / 已退役 0 / 待退役 0

owner-fiat 复评挂号称 8（retire-watch 规则④到期自动催办）：三件套同名配对(2027-01-21)、incident 复盘三件套(2027-01-21)、approved 留痕(2027-01-21)、路由预判一致性(2027-01-21)、密钥扫描门（gitleaks）(2027-01-21)、委托引文接地(2027-01-22)、flaky 隔离重跑(2027-01-22)、PR 体积预算(2027-01-22)

## 模型侧载体

- **命令** 9 篇（commands/，常驻指令面；2026-10-27 起随插件分发，项目侧 .agents/commands/ 存在时列项目自有）：build.md、deploy.md、design.md、maintain.md、new-task.md、plan.md、pr-review.md、review.md、test.md
- **技能** 8 个（skills/，按需加载；项目侧 .agents/skills/ 存在时列项目自有）：autonomous-run、decision-log、dev-tour、dream、review-method、session-resume、verify-ui、workflow-closeout
- **角色** 7 个（agents/，子代理契约；项目侧 .agents/roles/ 存在时列项目自有）：implementer、independent-reviewer、pr-adjudicator、pr-finder、pr-verifier、ui-verifier、wiki-compiler

## 数据与台账面

| 台账 | 用途 |
|---|---|
| `.agents/verifications.jsonl` | verify 绿凭证（钉 headShort + 24h 窗；--scope 行带面与基线） |
| `.agents/judgments.jsonl` | check-loop 每次运行 per-rule WARN/BLOCK 落账（retire-watch 供数） |
| `.agents/confirmations.jsonl` + `confirmations.d/` | 确认链（append-only，指纹 sha256，提交时刻增量执法） |
| `.agents/trust-mode-audit.jsonl` | 自治授权升降级（prev-sha256 链） |
| `workflow/reviews.d/` | 复核事件级台账（采纳/拒绝/误报） |
| `workflow/papercuts.d/` | 摩擦与消债台账 |
| `workflow/delegations.md` | 委派/自做结果 + 月度聚合快照（扩容门供数） |
| `workflow/metrics.md` | 月度指标（incident/门禁成本/复核效果——GENERATED 区） |

## 维护

- 改任何单源（钩子/GATES/SECTIONS/台账/目录）后：`node <插件根>/scripts/gen-engine-map.mjs` 重生成随同提交；CI/hygiene 可跑 `--check` 防漂移。
- 环境事实单源 `.agents/notes/runtime-env.md` §6；机制明细与退役阈值单源 `.agents/config/mechanism-registry.md`；门禁成本 `workflow/metrics.md`。
