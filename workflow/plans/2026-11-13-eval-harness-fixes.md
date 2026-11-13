---
状态: approved
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: b3e778ee5cd5ea9f
---
# PLAN — eval 基线后修复补记（关单后回归修复与基线资产）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：2026-11-13-eval-e2e-baseline 关单后回归修复（自举首推被自己门拦下的实证链）
- 目标：harness 五修与基线资产入库，check-scope-range 归档回退后本补记 plan 声明覆盖全部范围变更
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/scripts/check-scope-range.mjs`：归档回退——closeout 移 plan 后推送范围含 rename 提交，live 与 HEAD 树均无旧路径；遍历触该路径提交取首个 show 成功者（跳过 rename 提交），落临时文件复用 extractDeclared
- `.gitleaks-baseline.json`：本仓密钥扫描豁免基线起步（[] 起步，lite 扫描 fail-closed 前提）
- `plugins/ai-native-delivery/test/check-secrets-lite.test.mjs`：AKIA 样例夹具行加 secrets-lite:allow（自检型误报的行内豁免机制）
- `plugins/ai-native-delivery/test/check-secrets.test.mjs`：同上（接续测试的夹具行同步标记）
- `plugins/ai-native-delivery/test/eval.mjs`、`test/fixtures/eval/cases.json`：harness 五修与轮次预算（归属前序 eval-e2e-baseline，其归档态声明经历史重写不可达，在本补记显式声明）
- `workflow/archive/2026-11/plans/2026-11-13-eval-e2e-baseline.md`：closeout 归档移动本身（随关单发生）

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 验证与验收（lite）

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（涉前端改动另附实测证据）
- 检索：粘贴第 2 步 kb-search 输出（无命中贴命令与空结果即可，免另写说明）
- 验收：
- [x] 本仓 git push 通过 check-scope-range 对账（声明覆盖全部范围变更）（证据：推送成功输出）
- [x] check-secrets-lite 全绿（证据：✅ 无泄漏 637 文件）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。约束与风险以一句话并入改动方案条目。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
