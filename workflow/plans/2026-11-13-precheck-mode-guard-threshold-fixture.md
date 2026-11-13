---
状态: approved
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 27fa1b0209cf6c7a
---
# PLAN — precheck-mode-guard-threshold-fixture——mode 缺省兜底与 0.35 门限边界 fixture

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：2026-11-13 用户指令「开小单 处理2，3项」（AGENTS.md/Skill 自主性审阅会话遗留项）
- 目标：precheck 的 opts.mode 缺省不再崩（契约「缺省=on」），并用 0.34/0.36 两侧 fixture 锁死 proceed 门限 0.35 的行为边界
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/systemone-decision/hooks/precheck-quota.mjs`：新增 modeOf() 规范化——缺省/非对象 mode 一律按 on 处理（quotaAllows / bumpQuota 两处消费点根因兜底，调用点不重复兜底；既有预检行为不变）
- `plugins/systemone-decision/test/hook.smoke.mjs`：新增 SCENARIOS 边界场景 clearAt034 / clearAt036（clarity 高 + proceed 0.34 / 0.36）与两条边界断言（0.34 仍提醒、0.36 静默），防止门限被改回 0.6 或漂移

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 验证与验收（lite）

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（涉前端改动另附实测证据）
- 检索：粘贴第 2 步 kb-search 输出（无命中贴命令与空结果即可，免另写说明）
- 验收：
- [x] mode 缺省调用不再抛错（证据：不传 opts.mode 的 precheck 调用返回 null 而非 TypeError）
- [x] 门限边界两条断言绿：0.34 提醒 / 0.36 静默（证据：hook.smoke 输出的两条 PASS）
- [x] 三套冒烟全绿（证据：hook.smoke / smoke / contract.smoke 均输出「全部通过」）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。约束与风险以一句话并入改动方案条目。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
