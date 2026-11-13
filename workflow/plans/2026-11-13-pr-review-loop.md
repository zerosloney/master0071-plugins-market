---
状态: approved
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 879d29e5ee4f3a95
---
# PLAN — pr-review-loop

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：路线图「继续下一项」选定 PR 评审回路（源仓 pr-review.mjs 从未随插件分发）
- 目标：forge-free 的 PR 面板评审回路（多镜头 finder → 验证者投票共识 → 裁决处置 → gate 清零 → 台账）+ 插件原生 PR 正文三件套生成器，两套新测试全绿，版本 0.3.4
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/scripts/pr-review.mjs`：源仓 1551 行判据级移植——8 子命令（plan 固定 SHA/collect 去重样式丢弃/verify 共识投票/adjudicate 裁决/dispose 状态机/gate shadow+enforce/summary 月度台账/status），7 镜头 FOCUS 表；默认 base origin/develop→origin/main，头部口径改插件 forge-free
- `plugins/ai-native-delivery/scripts/pr-body.mjs`：插件原生新增——PR 三件套正文生成器（Summary 来自 diff / Evidence 引 verify 绿线或明写未运行 / Merge Danger Door+Radius+Rollback），每节标数据来源禁编造
- `plugins/ai-native-delivery/agents/pr-finder.md`、`agents/pr-verifier.md`、`agents/pr-adjudicator.md`：3 个新角色契约（独立上下文只读 finder / 投票 verifier / 裁决 adjudicator），frontmatter 适配插件形态
- `plugins/ai-native-delivery/commands/pr-review.md`：编排命令（触发条件 + 与 /review 分工：分级评审默认、面板评审升级档）
- `plugins/ai-native-delivery/test/pr-review.test.mjs`、`test/pr-body.test.mjs`：两套新黑盒（21+7 断言，mkdtemp 临时仓 spawn 真实 CLI）
- `plugins/ai-native-delivery/test/warn-fold-plugin.test.mjs`：判据修正——两种形态同源比较按告警条数（`- [` 前缀）不按原始行数（多行告警续行导致假红；0.3.4 登记行把常驻面顶超限暴露此缺陷）
- `plugins/ai-native-delivery/config-templates/mechanism-registry.md`：补登 2 行至 64（PR 面板评审 [检出型] / PR 正文三件套 [数据面]）+ 现状注日期流水压缩（处置顺序③，41196→40341B 回 40960B 线内）
- `plugins/ai-native-delivery/config-templates/rule-budgets.txt`：commands 预算 8704→9728 / 47282→51200（新命令 pr-review.md 带日期理由）
- `plugins/ai-native-delivery/README.md`：PR 面板评审 + pr-body 两节
- `plugins/ai-native-delivery/plugin.json`、`.codex-plugin/plugin.json`、`.omp-plugin/plugin.json`、`.zcode-plugin/plugin.json`、`mcp/protocol.mjs`：版本 0.3.4（release.mjs 单源）
- `.github/workflows/ci.yml`：接 2 个新测试
- `README.md`、`marketplace.json`、`.omp-plugin/marketplace.json`：市场版本面（release.mjs）
- `.agents/config/rule-budgets.txt`：仓内侧预算同步
- `.agents/config/mechanism-registry.md`：仓内侧登记同步（补 PR 2 行 + 压缩现状注，与插件单源一致 40341B）
- `workflow/plans/2026-11-13-pr-review-loop.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：forge-free（不搬 tfs-pr/pr-create，插件不碰 forge API/PAT——PR=固定 base..head 评审范围）；零依赖（node: 内置）；tfs-pr(947 行)/面板耦合/自动 babysit 明确不做
- 风险：pr-review 流程新接入无真实使用史——以 21 断言黑盒锁状态机护栏（Important 禁 deferred、waive 须用户原话 quote、rejected 不可处置）

## 验证计划

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（关单时跑）
- 检索：本轮无新增外部依赖（复用 node: 内置），kb-search 无命中项
- 验收：见下节（两套新测试 + acceptance 全量 + 常驻面回线 + pr-body 真实生成）

## 验收标准（可测试）

- [x] pr-review.test.mjs 全绿（证据：21/0——plan 固定 SHA/collect 去重/verify 共识/adjudicate 护栏/dispose 状态机/gate 两档/summary 台账 8 列自洽/status）
- [x] pr-body.test.mjs 全绿（证据：7/0——Summary 来自真实 diff/Evidence 未运行明写/Danger 三要素/空 diff 拒生成）
- [x] acceptance 全量绿（证据：PASS 132 / FAIL 0，含修正后 warn-fold-plugin 8/0）
- [x] mechanism-registry 回常驻面线内（证据：40341B ≤ 40960B，夹具 check-loop 无超限 WARN）
- [x] pr-body 对本仓真实提交生成且诚实（证据：对 2a4b832 生成三件套，无 verify 绿线时如实标「未运行」）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
