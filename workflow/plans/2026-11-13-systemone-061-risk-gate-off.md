---
状态: approved
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 0a91b3877f3c922d
---
# PLAN — systemone-061-risk-gate-off——shell 命令风险闸整体下线

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：2026-11-13 用户指令「先处理第 4 项」（systemone 0.6.1 WIP 收口）；规格源 = systemone README:288 的 0.6.1 变更条目
- 目标：shell 命令风险闸整体下线落到代码面（hooks.json 只留需求预检、两个风险闸脚本删除、hook-io 去 emit-ask 策略、共享端点不再落盘 hookRiskGate、设置项与环境变量移除、版本位 0.6.1），三套冒烟全绿
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `marketplace.json`：marketplace 条目 0.6.1 与描述（作者 WIP 提供）
- `plugins/systemone-decision/.codex-plugin/plugin.json`：0.6.1 版本位与描述（作者 WIP 提供）
- `plugins/systemone-decision/.omp-plugin/plugin.json`：0.6.1 版本位与描述（作者 WIP 提供）
- `plugins/systemone-decision/.zcode-plugin/plugin.json`：0.6.1 版本位与描述（作者 WIP 提供）
- `plugins/systemone-decision/README.md`：0.6.1 变更条目与门限口径（作者 WIP 提供）
- `plugins/systemone-decision/endpoint-config.mjs`：共享端点文件不再落盘 hookRiskGate
- `plugins/systemone-decision/hooks/clarity.mjs`：需求明确度门限 proceed 0.6 → 0.35（减少不必要澄清），注释去 risk-gate 指向
- `plugins/systemone-decision/hooks/decide-client.mjs`：注释去 risk-gate 指向
- `plugins/systemone-decision/hooks/hook-io.mjs`：移除仅风险闸用的 emit-ask kill 策略，killer 回归纯 silent 自毁
- `plugins/systemone-decision/hooks/hooks.json`：删 PreToolUse 段，只保留 UserPromptSubmit 需求预检
- `plugins/systemone-decision/hooks/pretool-risk.mjs`：删除——0.6.1 整体下线 shell 命令风险闸
- `plugins/systemone-decision/hooks/risk-gate.mjs`：删除——0.6.1 整体下线 shell 命令风险闸
- `plugins/systemone-decision/mcp/question-types.mjs`：注释去 risk-gate 指向
- `plugins/systemone-decision/mcp/server.mjs`：去掉 hookRiskGate 设置项；SERVER_INFO 版本位 → 0.6.1
- `plugins/systemone-decision/plugin.json`：0.6.1 版本位与描述（作者 WIP 提供）
- `plugins/systemone-decision/test/hook.smoke.mjs`：删风险闸用例（内核/matcher 对账/emit-ask/共享文件风险闸探针），缓存三用例改指需求预检路径，补回共享文件损坏用例的准备步骤
- `plugins/systemone-decision/test/smoke.mjs`：共享端点键集断言去 hookRiskGate；环境变量清单去两个 RISK_GATE 键
- `.agents/confirmations.d/2026-11-13-systemone-061-risk-gate-off.jsonl`：0.6.1 相关改动
- `workflow/plans/2026-11-13-systemone-061-risk-gate-off.md`：0.6.1 相关改动

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 验证与验收（lite）

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（涉前端改动另附实测证据）
- 检索：粘贴第 2 步 kb-search 输出（无命中贴命令与空结果即可，免另写说明）
- 验收：
- [x] 代码面零残留：rg 'pretool-risk|risk-gate|hookRiskGate|RISK_GATE|emit-ask|askPayload' 除 README 历史变更条目外零命中
- [x] hooks.json 只剩 UserPromptSubmit
- [x] 三套冒烟全绿：hook.smoke / smoke / contract.smoke
- [x] 版本位一致 0.6.1：4 清单 + mcp SERVER_INFO + marketplace 条目
- [x] 仓库级门禁：manifest-lint PASS、release --check 一致

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。约束与风险以一句话并入改动方案条目。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
