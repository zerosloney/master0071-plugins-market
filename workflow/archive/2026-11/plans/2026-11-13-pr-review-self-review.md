---
状态: done
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 2b4f1365a7151c4d
---
# PLAN — pr-review-self-review

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：面板评审首跑对 0.3.4 自身的 12 条 confirmed findings（run pr-b061b19-61f859dd：2 finder → 3 验证者 36 票全 confirm）
- 目标：12 条（5 Important + 7 Nit）全部修复 + 回归锁，0.3.5 发版，处置闭环走完 dispose→gate enforce→summary
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/scripts/pr-review.mjs`：C-001/C-007 默认面板 2→7 镜头、maxFinders 6→7、buildLenses 截断显式告警；C-002 cmdVerify 对带 adjudication 的旧 finding 整体保留（票面漂移只告警）；C-003 collect 改动面校验去掉 line>0 前提；C-008 工单角色契约指路自锚 <插件根>/agents/（PLUGIN_AGENTS_DIR）
- `plugins/ai-native-delivery/scripts/pr-body.mjs`：C-004 三处路径输出补 -c core.quotepath=off；C-010 注释去掉未实现的关单凭证来源
- `plugins/ai-native-delivery/test/pr-review.test.mjs`：回归锁 +6 断言（⑨默认 7 镜头、⑩截断告警、⑫line=0 越界拦截、⑬裁决保留三连）
- `plugins/ai-native-delivery/test/pr-body.test.mjs`：回归锁 +1 断言（⑥quotepath=true 中文路径原样输出）
- `plugins/ai-native-delivery/README.md`：C-009 enforce 拦截面如实列（去 P0/P1）、C-011 modelRole 默认如实写、版本段 0.3.5
- `plugins/ai-native-delivery/commands/pr-review.md`：C-009/C-011 同口径 + adjudicate 终裁语义
- `.agents/config/mechanism-registry.md` + `plugins/ai-native-delivery/config-templates/mechanism-registry.md`：C-005 现状注 64→65（两份同源）
- `.agents/config/rule-budgets.txt` + `plugins/ai-native-delivery/config-templates/rule-budgets.txt`：C-012 预算 51200 行补带日期理由（实测 50304B）
- `plugins/ai-native-delivery/plugin.json`、`.codex/.omp/.zcode` 三宿主 plugin.json、`mcp/protocol.mjs`、`marketplace.json`、`.omp-plugin/marketplace.json`：C-006 计数 9 命令/7 角色 + release.mjs 0.3.5 版本位
- `README.md`（根）：C-006 计数同步
- `workflow/plans/2026-11-13-pr-review-self-review.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：面板管线语义不变（共识数学/状态机/台账口径零变化，只修缺陷）；forge-free 与零依赖纪律不变；登记表 40341B≤40960B 线内
- 风险：默认 7 镜头抬高单次评审成本——--fast 仍在（单镜头）；裁决保留为无条件继承，票面变化只告警不回滚（人工裁定优先）

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] pr-review.test.mjs 27/0（证据：⑨⑩⑫⑬ 六新断言全绿）
- [x] pr-body.test.mjs 8/0（证据：⑥ quotepath 回归锁绿）
- [x] acceptance 全量绿（证据：PASS 132 / FAIL 0）
- [x] 面板 run 12 条 findings 全终态：11 fixed@1dc4f21 + C-012 waived（锚文件为归档终态 plan 禁改正文，实质修复已落预算文件；waiver 留痕）；gate 面板清零（12/12 OK），enforce 的 head 新鲜度检查按设计面向合入前、对历史 run 如实报 FAIL 不适用（证据：dispose/gate/summary 输出）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
