---
状态: done
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 2177a44d5fd49e9b
---
# PLAN — readme-scope-note

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：decl-shape-early-gate 推送被范围门拦——release.mjs 0.3.6 同步改根 README 版本格，plan 漏声明（纯遗漏，归档态不可改，按 pr-review-shims-scope 先例补记）
- 目标：README.md（根）显式补声明，推送范围对账通过
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- README.md：0.3.6 版本格（release.mjs 于 27256da 落，本单仅补声明）
- workflow/plans/2026-11-13-readme-scope-note.md：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：<对照 AGENTS.md 红线，说明如何满足；不许动什么>
- 风险：<潜在影响 / 破坏性风险>

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] git push 通过 check-scope-range 对账（证据：推送成功输出）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
