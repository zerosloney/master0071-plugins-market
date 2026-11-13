---
状态: done
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 8067bd529ad67fdb
---
# PLAN — eval-e2e-baseline——E1/E2/E3 三车道真实基线

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：用户对话（2026-11-13「开 eval e1-e3真实基线 跑一个任务看看」）——自举后第一个正式狗粮任务
- 目标：E1/L0、E2/L1、E3/L2 三条种子用例以真实 claude -p 各跑通一次，行为断言全绿或暴露问题被修复后全绿，基线取证留档
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `test/fixtures/eval/cases.json`：仅当 E1–E3 暴露用例缺陷（判据错/夹具脆）时修用例，修的是测试意图不是放水
- `test/eval.mjs`：仅当 runner 缺陷暴露（超时/夹具/断言算子 bug）时修
- 产物：三份 transcript（%TEMP%/eval-logs/）+ 本 plan 验收节证据；无源码产品面预期改动

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 验证与验收（lite）

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（涉前端改动另附实测证据）
- 检索：粘贴第 2 步 kb-search 输出（无命中贴命令与空结果即可，免另写说明）
- 验收：见「验收标准」节

## 验收标准

- [x] E1（L0 极简道）真实跑：agent 完成小改免立档，commit 消息含非空 `L0:` 行（证据：E1-2026-11-13T06-02-17.json，2/2 PASS，23 轮 exit 0）
- [x] E2（L1 快速道）真实跑：plan 三节在场 + 确认账有新行（证据：E2-2026-11-13T05-31-39.json，3/3 PASS）
- [x] E3（L2 全档）真实跑：三档入库 + 确认指纹在场（证据：E3-2026-11-13T06-38-57.json，4/4 PASS；第 4 跑 agent 完整走通含 closeout 的全闭环，内容合规由 premiseGate/taskScopeGate 硬门仲裁）
- [x] 暴露的问题逐条修复或如实记录为 papercut（证据：harness 五修随本 plan 提交 + papercuts.md 三条新行）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。约束与风险以一句话并入改动方案条目。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
