# Workflow 编排机制 — 编排脚本 + steps 扩展点

> **种子定位（2026-10-27 插件化迁移）**：本目录是插件内**首次初始化的种子**（`config-templates/pipelines/`）——正式落位在**项目侧 `.agents/pipelines/`，由初始化从此种子复制**；下文与各编排脚本的 `.agents/pipelines/`、`.agents/roles/` 等路径均按项目侧落位口径书写。

> **命令口径**：`<插件根>` 指 ai-native-delivery 插件的安装根（宿主按插件清单解析）——治理脚本随插件分发，项目侧只落数据（`.agents/` 运行时 + `workflow/` 台账），故脚本路径一律写 `<插件根>/scripts/<名>.mjs`，**不写项目侧脚本目录（插件形态下该目录不存在）**（该路径在插件形态下不存在）。

> kit 的跨宿主编排机制：`.agents/pipelines/` 下的编排脚本承载编排语义（依赖分层 / 并行 / 重试 / gate / 用户确认门 / run journal），**宿主 AI 经 AGENTS.md 常驻指令自动加载并按语义执行**——有子智能体的宿主并行 fan-out，没有的顺序自做，验收不变。零宿主协议适配：机制只依赖所有宿主共有的四样本领（读 AGENTS.md、读仓库文件、跑终端命令、子智能体）。

## 自动加载（AGENTS.md 常驻指令）

> 多工作包编排——用户要跑编排、或 plan 执行多工作包时：读 `.agents/pipelines/` 编排脚本按本文档语义执行；自定义步骤在 `steps/`。

## 编排脚本（`.agents/pipelines/<主题>.md`）

frontmatter（`name` / `description` / `concurrency` 默认 2）+ 一张 stages 表（`human` 列可选——不用确认门的可省该列，保持 9 列）：

```md
---
name: 并行修两域
description: 后端+前端并行实现 → 汇聚过测试 → 部署验证（step）→ 独立评审
concurrency: 2
---
| id | after | role | step | task / params | files（授权） | accept（验收判据） | gate | human | retries |
|----|-------|------|------|---------------|--------------|-------------------|------|-------|---------|
| backend | — | implementer | — | 实现后端 X | src/api/** | 项目测试过 | | | 1 |
| frontend | — | implementer | — | 改前端 Y | web/** | 构建过 | | | 0 |
| gate-all | backend,frontend | — | — | — | — | — | npm test | | |
| confirm-deploy | gate-all | — | — | 用户对话内确认可上 staging | — | 一句「可以」 | | 用户确认 | |
| deploy-check | confirm-deploy | — | 部署验证 | env=staging | | 部署命令 exit 0 | | | 0 |
| review | deploy-check | independent-reviewer | — | 评审两域改动 | | 符合 plan 与判据 | | | 0 |
```

**stage 四形态**（互斥，恰填一项）：

| 形态 | 判据 | 执行 |
|------|------|------|
| role 派单行 | `role` 非空 | 派子智能体（`task` 目标 / `files` 授权清单 / `accept` 验收判据写进派单头 + 红线行） |
| step 行 | `step` 非空 | 宿主 AI 读 `steps/<step>.md` 按指引执行，`task / params` 列传参 |
| gate 行 | `gate` 非空（role/step/human 空） | 终端跑命令，非零即中止 |
| human 确认门行 | `human` 非空（其余形态列空） | 宿主 AI **停下向用户询问**（`task` 列 = 问什么、`accept` 列 = 通过判据），通过才派下层；驳回 → 中止汇总。**不派子智能体**（机器判据层面落实「子智能体不跨确认门」，取代早前 role 行伪装确认门的写法） |

**编排语义**（执行口径，全宿主同一）：`after` 空 = 第 0 层；一层全 ok 才派依赖它的下一层；层内按 `concurrency` 分批——有子智能体的宿主并行 fan-out，没有的顺序自做（验收标准不变）；失败且 `retries` > 0 → 重派（全新上下文）；重试超限 / gate 非零 / human 驳回 → 中止后续、汇总报告失败项。human 行无重试语义（retries 视作 0）。

**run journal**（断点续跑与重试计量）：每个 stage 每次尝试出结果（pass / fail / blocked）即记一行；中止后重跑先看 status——已 pass 的 stage 不重跑，从就绪层续。

- journal 落 `.agents/cache/orchestration-runs.jsonl`（本地运行态，可丢弃；同 run 同 stage 多行按末次生效，attempt 自动计次）。
- 记账由**执行者（宿主 AI）直接追加 JSONL 行**（一行一个 JSON 对象，无表头）：`run` / `wf` / `stage` / `status`（pass|fail|blocked）/ `form`（role|step|gate|human）/ `attempt` / `ts`。
- 续跑时读该文件：某 stage 最新一行为 `pass` 即视为已完成（不重跑），据此从就绪层续。
- journal 是**自报态，非验证态**（见下方纪律条）——编排层无运行时派发器强制（源项目的 wf-run 已废），记账纪律由执行者保证。

## steps 扩展点（`.agents/pipelines/steps/<名>.md`）

kit 定义的扩展机制：文件名即步骤名（steps 目录即注册表），项目把自己的领域动作（部署 / 迁移 / 审计上报…）注册进来，编排脚本 step 行引用即用。

```md
---
params: env（目标环境）；timeout-min（可选，默认 10）
---
# 步骤 — 部署验证

1. 跑终端命令：`npm run deploy -- --env <env>`，非零即步骤失败并回报 stderr 尾段
2. 跑冒烟检查：`curl -fsS https://<env>.example.com/healthz`
3. 回报：部署版本号 + 冒烟结果
```

- frontmatter `params`：参数约定（自由文本列明名称与含义）；调用方在编排脚本 `task / params` 列传参（`k=v`，空格分隔多个）。
- 正文：执行指引（编号步骤）——可指使命令、子智能体、检查动作；步骤失败按编排脚本行 `retries` 重试。

## 纪律（先读）

- **声明随 plan 确认后方可执行**：编排脚本是 plan 任务拆解的执行器，随 plan 草稿一并全文过目。
- 子智能体不跨确认门、不 commit / push（派单红线行：只改授权文件；缺输入或需偏离 → `BLOCKER:` 停下）。确认门一律用 human 形态行表达，不得派子智能体代行。
- 收敛复核：派单返回后核对 diff 与授权文件范围（与 build.md 委派约定同口径）；BLOCKER 停住待处置。
- **run journal 三条**：① 每个 stage 每次尝试出结果即向 `.agents/cache/orchestration-runs.jsonl` 追加一行（含重试与 human 门结论）；② 中止后重跑先读 journal——已 pass 不重跑，从就绪层续；③ 收尾可把本 run 的 status 汇总粘 `workflow/delegations.md` 留痕（聚合脚本不读 journal）。
- **journal 是自报态，非验证态**：run journal 由执行者（宿主 AI）自己记——concurrency / retry / 断点续跑语义的保证取决于记账纪律，编排层无运行时派发器强制（wf-run 已废，执行按本机制文档语义）；中止续跑时对「已 pass」结论保留人工核对权（audit-gate-hardening 边界声明）。
- 留痕：每个派单 / step stage 完成后向 `workflow/delegations.md` 委派结果表追加一行（`一次通过` / `返工×N` / `返工待修`，口径与 agg-delegations.mjs 对齐）。
- 解析校验先行（机器门）：`node <插件根>/scripts/workflows-check.mjs`——role ∈ `.agents/roles/`、step ∈ `steps/`、after 引用存在且无环、四形态恰填一项、retries/concurrency 数值合法；任一不过即拒，不执行。
