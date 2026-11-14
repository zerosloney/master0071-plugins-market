---
状态: done
级别: L1
日期: 2026-11-14
模块: pipeline
确认指纹: 4649e55083b44447
---
# PLAN — pipelines-panel-findings

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：pr-review 面板专属评审（run pr-0cd027b-ea55f351，范围 79e248f..0cd027b = agent-pipelines 0.1.27 单提交）：7 镜头 24 原始 → 簇聚 18 候选（含 1 blast-radius）→ 54 票全 confirm（用户选定「下一轮 agent-pipelines 专属评审」）
- 目标：18 条 confirmed 全修（含 2 条 pre-existing 安全 Important 的防御性收口与宣称如实化）+ 6 组回归锁，0.1.29 发版
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/agent-pipelines/scripts/state-core.mjs`：C-011 recheckScope 全覆盖模式（**/**//*）防御 fail-closed 拒 DONE + 信任边界注释如实化；C-012 promise reason 标注未鉴别来源；C-006 内联合法性判据改复用 rootRelativePattern（归一化，与 CLI 同宽）+ de-export recheckScope；C-009 补齐引用 MAX_FAILURES_DEFAULT 单源
- `plugins/agent-pipelines/scripts/scope-core.mjs`：C-013 rootRelativePattern 拒盘符相对模式（^[A-Za-z]:[^/]）堵 fail-open；C-007 globToRegExp/matchAny 孤儿导出转内部
- `plugins/agent-pipelines/scripts/state-persist.mjs`：C-002 接管双读确认（+25ms Atomics.wait 抖动复读）；C-004 坏行 stderr 计数按文件去重；C-005 eventsFile 导出（单源）；C-018 LOCK_WAIT_MS 环境变量覆盖（测试用，默认不变）
- `plugins/agent-pipelines/scripts/render.mjs`：C-005 派生复用 eventsFile/promiseFile 单源；C-010 注释旧指称修正
- `plugins/agent-pipelines/scripts/serve.mjs`：C-005 派生复用单源；C-003 前缀两处补漏（positiveInt/init 引导行）
- `plugins/agent-pipelines/scripts/state.mjs`：C-009 init 引用 MAX_FAILURES_DEFAULT
- `plugins/agent-pipelines/scripts/pipelines.mjs`：C-009 MAX_FAILURES_DEFAULT=3 单源常量
- `plugins/agent-pipelines/README.md`：C-014 能力表补 promise；C-011/C-012 信任边界如实化（gate 重算防御注/promise「来源可鉴别」改如实边界）；版本段 0.1.29
- `plugins/agent-pipelines/test/regression.mjs`：+4 回归锁（C-011 全覆盖拒 DONE/C-012 未鉴别注记/C-013 盘符相对拒/C-006 绝对路径同宽）+ M3 竞态锁等待环境变量化（C-018）
- `plugins/agent-pipelines/test/scripts.mjs`：+1 回归锁（C-017 非对象行 render 容错）+ C-004 坏行消息去重后缀适配
- `plugins/agent-pipelines/test/contract.mjs`：C-009 max_failures 锚单源 pipelines.mjs（两处）
- `plugins/agent-pipelines/test/equivalence.mjs`：C-009 锚单源 pipelines.mjs
- `plugins/ai-native-delivery/scripts/pr-review.mjs`：簇聚键行号优先修正（rootCause 各镜头自由命名致首轮簇聚只并 2/24）
- `plugins/agent-pipelines/plugin.json`：版本 0.1.29（release.mjs）
- `plugins/agent-pipelines/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/agent-pipelines/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/agent-pipelines/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-pipelines-panel-findings.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：共识数学/dispose 状态机零变化；安全修复取防御性收口 + 宣称如实化路线（进程级信任通道超出插件边界，已知限制如实入档而非假装已鉴别）；行为面改动均带回归锁
- 风险：catch-all 防御可能误伤合法的极宽 hard 规则——fail-closed 方向（拦 DONE 不放行越界），按提示收敛目录即可；M3 环境变量化仅测试消费，产品默认不变

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] 18 条 confirmed 全处置（15 fixed@本单 + C-001/C-015/C-016 fixed@71f525b 已修在前，证据：dispose 输出）
- [x] 五套全绿 553→565 断言（证据：contract 133 / pipeline 161 / equivalence 83 / regression 121 / scripts 60）
- [x] 新回归锁 6 组全绿（证据：C-011/C-012/C-013/C-006/C-017/C-018 用例输出）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
