---
状态: done
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 8dccd8a1cf2ebbb0
---
# PLAN — mutable-ledger-semantics——运行时账本只追踪存在性

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：2026-11-13 自举 dogfooding 实证——doctor 报「已装文件与台账不一致 3」（workflow/INDEX.md、papercuts.md、metrics.md），init 永远把它们当「用户改过」静默跳过
- 目标：安装台账对运行时账本（workflow/ 骨架文档 + 三本审计账主账）只追踪存在性，不再按哈希判「用户改过」——doctor 不再恒红、init 不再误判冲突
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/scripts/install/plan.mjs`：skeleton（workflow/ 骨架文档）与 runtime（三本审计账主账）条目带 `mutable: true` 标记
- `plugins/ai-native-delivery/scripts/install/apply.mjs`：mutable 条目存在即在位（不比对哈希、不覆盖、不报 conflict），台账值记 `{mutable:true}`；领养路径同口径
- `plugins/ai-native-delivery/scripts/doctor.mjs`：「已装文件与台账一致」对 mutable 条目只核存在性
- `plugins/ai-native-delivery/test/install.test.mjs`：①/⑥ 语义改写 + 新增 ⑥b（账本被改写 → 重跑 init 走 mutable 通道，不冲突不覆盖）
- `plugins/ai-native-delivery/test/doctor.test.mjs`：④ 改用非可变种子做失配断言 + 新增 ④b（账本被改写 → doctor 仍全绿）
- `plugins/ai-native-delivery/README.md`：安装台账与 doctor 口径补「运行时账本只核存在性」
- `plugins/ai-native-delivery/scripts/check-scope-range.mjs`：归档回退收紧为**只认真归档**（git 历史里发生过 rename 才回退到归档副本）；仅工作区被删而树里无归档副本时仍 fail-loud（修「被删即静默放行」的回归）
- `plugins/ai-native-delivery/test/check-secrets-lite.test.mjs`：夹具 allow 标记由 `#` 改 `//`——ESM 里 `#` 不是注释符（此前用 `# secrets-lite:allow` 致文件语法破损，acceptance 恒红）；同时复原被误写的转义
- `plugins/ai-native-delivery/test/check-secrets.test.mjs`：同上（接续测试的夹具行同步标记）
- `plugins/ai-native-delivery/test/workflows-check.test.mjs`：S14 扫描面份数改为按目录实况自适应（原硬编码「>= 3」是源仓形状；本仓非编排件作者仓，自举只播种 2 份种子）
- `.omp-plugin/marketplace.json`、`README.md`：systemone-decision 版本位补齐到 0.6.1（.omp 市场清单与 README 插件表漏位）+ README「双命令闸」段按 0.6.1 事实改写（systemone 已无 shell 命令闸，当前同装只有一道闸）
- `.agents/install-manifest.json`：本仓自举台账迁移（6 项转 mutable 追踪，入库共享）

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 验证与验收（lite）

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（涉前端改动另附实测证据）
- 检索：粘贴第 2 步 kb-search 输出（无命中贴命令与空结果即可，免另写说明）
- 验收：见「验收标准」节

## 验收标准

- [x] doctor 7/7 全绿（证据：本仓自举实测输出「doctor: 7 项检查全部通过」）
- [x] install 套件 56/0（证据：套件输出合计 PASS 56 / FAIL 0，含新增 ⑥b）
- [x] doctor 套件 39/0（证据：套件输出合计 PASS 39 / FAIL 0，含新增 ④b）
- [x] acceptance 全量绿（证据：合计 PASS 126 / FAIL 0）
- [x] 自举暴露的 4 处一并修完：夹具 allow 标记 `#`→`//`（ESM 语法破损）、scope-range 归档回退只认真归档（fail-loud 保持）、workflows-check S14 份数自适应、systemone 版本位补齐（证据：release --check 绿）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。约束与风险以一句话并入改动方案条目。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
