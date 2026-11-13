---
状态: done
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 1b88fc27f38a7026
---
# PLAN — decl-shape-early-gate

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：papercuts 2026-11-13 两条——范围门缩写路径无早期反馈（两天两次推送被拦：eval-harness-fixes、pr-review-shims-scope）+ 承诺面占位符替换触发 reconfirm（登记并线程）
- 目标：缩写声明在确认时刻被拦（判据单源），不再等到推送；acceptance 全绿，0.3.6 发版
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/scripts/check-scope.mjs`：token 接受判据抽为导出 `declAccepted`（extractDeclared 复用，行为零变化）；新增导出 `suspiciousDeclarations`——声明节 bullet 反引号 token 整串形似路径（含目录、锚定匹配）且 !declAccepted → 可疑（散文/URL/版本号/裸名刻意不判，误报>收益）
- `plugins/ai-native-delivery/scripts/confirm-doc.mjs`：draft→approved 与 --reconfirm 双路径接「声明形态门」（plan 适用；spec/intent 无改动面不检）——可疑即拒（exit 2 + 行号 + 修法提示，不落账不写盘）
- `plugins/ai-native-delivery/test/check-scope.test.mjs`：S12 三断言（缩写标记含行号 / 合法声明·通配·散文·URL·版本号·非 bullet 不误报 / declAccepted 三态）
- `plugins/ai-native-delivery/test/confirm-doc.test.mjs`：S72 两断言（缩写确认被拒且状态仍 draft 未落台账 / 写全精确路径后通过）
- `workflow/papercuts.md`：登记 2 条（其一注明已根修；承诺面条并入既有线程待 owner 复评）
- `plugins/ai-native-delivery/README.md`：版本段 0.3.6
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.6（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `workflow/plans/2026-11-13-decl-shape-early-gate.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：extractDeclared 行为零变化（纯抽取重构 + 新增导出）；check-scope-range / stage-gates 复用面不动；承诺面门归一口径不擅改（仅登记 papercut 待 owner 复评）
- 风险：suspiciousDeclarations 误报会拦正常确认——判据刻意收窄（bullet 行 + 整串路径形态 + 含目录 + 非真实文件 + 未知扩展名），S12 锁误报面

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] check-scope.test.mjs 含 S12 全绿（证据：PASS 23 / FAIL 0）
- [x] confirm-doc.test.mjs 含 S72 全绿（证据：PASS 130 / FAIL 0）
- [x] acceptance 全量绿（证据：PASS 132 / FAIL 0）
- [x] extractDeclared 行为零变化（证据：check-scope 既有 S1-S11 断言全部未动且全绿）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
