---
状态: approved
级别: L1
日期: 2026-11-14
模块: pipeline
确认指纹: 7caee9d730ecfd8f
---
# PLAN — panel-pipeline-observations

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：面板评审三连跑（自评审 12 / systemone 19 / pstack 17，共 48 条闭环）的管线观察：三个实证缺口（用户选定「管线观察改进」）
- 目标：去重簇聚（同点改写并候选省验证票）+ blast-radius 带外锚入账（不再丢 PR 爆炸半径类 finding）+ release 触碰面对冲（打印清单 + 确认门 advisory），0.3.8 发版
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/scripts/pr-review.mjs`：①collect 去重键收紧为 file|rootCause|line（claim 归一抓不住跨镜头改写），合并侧互异 claim 并进 evidence 链；②blast-radius 政策——锚不在 diff 但 claim/evidence 引用 diff 路径（含 --diff-filter=D 删除面）的 finding 入账标 blastRadius，consensusOf 落 provenance=blast-radius（处置面同 introduced，禁 recorded）；collect 输出加 blast-radius 计数
- `plugins/ai-native-delivery/scripts/confirm-doc.mjs`：声明形态门加 release 触碰面 advisory（声明面含 plugins/<X>/ 产品件但缺 plugin.json×4/marketplace×2/根 README/protocol.mjs → ⚠️ 提醒不阻断；复用 extractDeclared 单源）
- `plugins/ai-native-delivery/test/pr-review.test.mjs`：+3 断言（同行跨镜头改写并为一候选且保留 sources/claim 链；blast-radius 引用 diff 路径入账；无因果带外仍拦）
- `plugins/ai-native-delivery/test/confirm-doc.test.mjs`：S73 +2 断言（advisory 打出且列 marketplace.json；不阻断确认落账）
- `scripts/release.mjs`：发版完成输出可粘贴触碰面清单（jsonFiles+markets+serverInfo+根 README）
- `plugins/ai-native-delivery/README.md`：版本段 0.3.8
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.8（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-panel-pipeline-observations.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：verify/共识数学/dispose 状态机零变化（只动 collect 入账与去重、provenance 新枚举）；blast-radius 仍须 2/3 验证者共识才成 finding；advisory 不得演化为拒绝
- 风险：同文件同行两条真异质 finding 被并为一候选——互异 claim 全保留在 evidence，verifier 按锚整体裁决，处置本就以行为为单位；blast-radius 因果判定的 basename 误命中（如 README.md）——多付验证票不失真，reject 通道仍在

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] pr-review.test.mjs 29/0（证据：含 +3 新断言——簇聚/blast-radius/无因果仍拦）
- [x] confirm-doc.test.mjs 132/0（证据：含 S73 advisory 两断言）
- [x] acceptance 132/0（证据：全量输出）
- [x] release.mjs 触碰面清单实战输出（证据：0.3.8 发版运行打印 8 项清单）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
