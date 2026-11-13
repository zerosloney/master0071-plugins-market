---
状态: approved
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: c83f049d53a41d30
---
# PLAN — systemone-062-panel-findings

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：pr-review 面板跨插件首跑（run pr-a22dbf1-d4dfcf72，范围 7e030b5..a22dbf1 = systemone 0.6.1）：7 镜头 finder 34 条原始 → collect 19 候选（11 条带外被改动面校验拦下）→ 3 验证者 57 票全 confirm
- 目标：19 条 confirmed 全修（含 Important C-001/C-010 changelog 矛盾）+ 带外盲区四处顺手清，systemone 0.6.2 发版，处置闭环走完
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/systemone-decision/README.md`：C-001/C-010（Important）0.6.1 条目「需求预检与 MCP 工具行为不变」改如实披露（门限 0.6→0.35/文案改写/mode 兜底）；C-008/C-011 架构树「两个 hook 内核共用」→「hook 内核共用」；版本段 0.6.2
- `plugins/systemone-decision/test/hook.smoke.mjs`：C-018 补 proceed=0.35 等值用例 + 门限注释改如实（三点钉死）；C-019/C-002 补 8d modeOf 兜底直连用例 + 429 注释改如实；C-003 删 caseVariants 死助手与 PassThrough 死 import、killerProbe(false)→()；C-017 8b 段注释「两个开关」→单开关
- `plugins/systemone-decision/hooks/hook-io.mjs`：C-004 删 killPolicy JSDoc 残段；C-009/C-014 预算耗尽注释改如实（fail-open 静默放行，与 54-55 JSDoc 一致）
- `plugins/systemone-decision/hooks/clarity.mjs`：C-005/C-012 头注去「（与风险闸同一份）」
- `plugins/systemone-decision/hooks/decide-client.mjs`：C-006/C-013 注释去「风险闸」「permissionDecisionReason」指向
- `plugins/systemone-decision/mcp/server.mjs`：C-007/C-015 注释「两个 hook 开关」→单开关口径；SERVER_INFO 0.6.2（release.mjs）
- `plugins/systemone-decision/endpoint-config.mjs`：C-016 注释「这两个开关」→单开关口径
- `plugins/systemone-decision/plugin.json`：版本 0.6.2（release.mjs）
- `plugins/systemone-decision/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/systemone-decision/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/systemone-decision/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表 systemone 版本格 0.6.2（release.mjs）
- `plugins/systemone-decision/skills/systemone-decision/references/scenarios.md`：带外盲区——去「风险闸 hook」指向
- `plugins/systemone-decision/hooks/decision-cache.mjs`：带外盲区——注释去 riskGateEnabled 引用
- `plugins/systemone-decision/test/contract.smoke.mjs`：带外盲区——「两个 hook 内核」→单内核
- `plugins/ai-native-delivery/README.md`：带外盲区——共装「双风险闸」节改写为 0.6.1 后现状（systemone 已无 PreToolUse 闸）
- `workflow/plans/2026-11-14-systemone-062-panel-findings.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：产品行为零变化（纯注释/文档/测试/死代码清理 + changelog 如实化）；不复活任何已删风险闸语义；面板管线自身不改
- 风险：无行为面改动，风险极低；8d 新用例按配额层真实契约断言（on/off 对配额 no-op，仅 first 限流）

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] 19 条 confirmed findings 全部处置 fixed（证据：dispose 输出 + 修复提交 SHA，随本单执行）
- [x] 三套冒烟全绿（证据：hook 34 PASS 含 2 新用例 / contract / smoke 全通过）
- [x] 0.6.2 版本位五处同步 + 版本段（证据：release.mjs 输出与 README）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
