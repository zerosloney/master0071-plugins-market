---
状态: approved
级别: L1
日期: 2026-11-14
模块: board
确认指纹: ddb8cec36c90e4fd
---
# PLAN — 交付工作台 P2（执行运行流 + Git 只读视图）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。
对应 spec：省略（P1 单 workflow/archive/2026-11/plans/2026-11-14-workbench-p1.md 已定契约底座，本单是其 P2 候选落地）

## 入口

- 来源：P1 收口时记入 README 的「P2 候选（执行运行流 / Git 只读视图）」——用户引用该句启动 P2
- 目标：workbench 加两视图——执行（verify 绿行 + 面板 run 运行流，只读）与 Git（分支/最近提交/脏文件，只读）；零写面纪律不变
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 契约（P2 数据面口径，单源 = workbench-model.mjs）

- **execution**（追加到 /api/workbench 模型）：
  - `verifications`：`.agents/verifications.jsonl`（本地遥测，gitignore）尾读最近 15 行 → { ts, exitCode, headShort, gateCount, failedGates, totalMs, wallMs }（gates 数组长度 + exit≠0 的门 id）
  - `panelRuns`：复用 P1 loadPanelRuns（artifacts/<月>/*.json），补 lenses/files 计数，最近 10 → { runId, month, writtenAt, total, counts{fixed,waived,deferred,recorded,undisposed}, lenses, files }
- **git**（只读，全部单次 spawn）：
  - `branches`：`git branch --format=%(refname:short)` + 当前分支标记；每支 `git log -1` 取 lastSubject/lastTs（分支数 ≤5 时逐支，超出只列名）
  - `commits`：P1 gitFeed 已有提交流（扩展 format 加 %h 短 SHA），最近 15 → { short, ts, subject, files, ledgerOnly }（ledgerOnly = 全部文件在 workflow//.agents/ 下）
  - `dirtyFiles`：`git status --porcelain` 行原样（含 XY 状态码），cap 50 超出注记
- **视图**：NAV 五项（概览/交付流/决策/执行/Git）；#execution 与 #git hash 路由；执行 = verify 运行流（时间/HEAD/门数/墙钟秒/失败门）+ 面板 run 卡（runId/lenses/files/findings/处置分布）；Git = 分支列表（当前高亮 + 最近提交）+ 最近提交列表 + 脏文件区；两视图均标「只读」徽标
- **边界**：写面仍为零（Git 视图无任何操作按钮）；delegations/委派账与协作多用户面继续不做

## 改动方案

- `plugins/ai-native-delivery/scripts/workbench-model.mjs`（改）：+loadVerifications（尾读 15 行）；loadPanelRuns 补 lenses/files；gitFeed format 加 %h（解析同步）；+gitFace（branches/commits/dirtyFiles）；buildWorkbench 组装 execution/git 两节；非 git 仓与缺遥测退化（空数组/null 不崩）
- `plugins/ai-native-delivery/board/workbench.html`（改）：NAV +2（执行=terminal 图标 / Git=branch 图标，原型 ICONS 同款）；+view-execution / +view-git 两视图渲染（消费上节契约；空态/缺省宽容同 P1；全字符串转义；只读徽标）；hash 路由扩展 #execution/#git
- `plugins/ai-native-delivery/test/workbench-model.test.mjs`（改）：+断言——verifications 映射（gates 长度/failedGates）、panelRuns lenses/files、gitFace（分支列表/当前标记/commits 短 SHA/ledgerOnly/dirtyFiles cap）、非 git 仓退化（execution.git 面空不崩）
- `plugins/ai-native-delivery/test/board-server.test.mjs`（改）：+⑯ 断言 /workbench 页含 view-execution/view-git 锚点
- `plugins/ai-native-delivery/README.md`（改）：交付工作台节——P2 候选句改为已落地（两视图口径与数据源、verifications 为本地 gitignore 遥测的如实说明）；版本段 0.3.10
- `.agents/config/mechanism-registry.md`（改）：实时看板行载体补执行/Git 只读视图（0.3.10 P2）；`.agents/notes/engine-map.md` 重渲
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.10（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位 0.3.10（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-workbench-p2.md`：本单

## 约束与风险

- 约束：零写面不变（Git 视图无操作按钮、执行视图无重跑按钮）；board-server 路由零新增（两视图同吃 /api/workbench，模板即改即得）；verifications.jsonl 是 gitignore 本地遥测——视图如实展示本地门禁运行史，不宣称远端 CI 覆盖
- 风险：gitFeed format 改动触及 P1 提交锚解析（同步解析器与既有断言回归）；分支逐支 log -1 在多分支仓变慢（>5 支只列名，注记）

## 验证计划

- `node plugins/ai-native-delivery/test/workbench-model.test.mjs` 全绿（含新增 P2 断言，P1 35 断言零回归）
- `node plugins/ai-native-delivery/test/board-server.test.mjs` 全绿（⑯ + P1 ⑬⑭⑮ 零回归）
- 真仓冒烟：/api/workbench 出 execution（verifications 最近行 + panelRuns 5 个）与 git（main 分支/commits/dirtyFiles）；/workbench #execution/#git 两视图 chrome 走查
- `node plugins/ai-native-delivery/scripts/verify.mjs` 全绿

## 验收标准（可测试）

- [ ] /api/workbench 含 execution 与 git 两节：verifications ≥1 行（gateCount/wallMs 在）、panelRuns 含 2026-11 五 run（lenses=7）、git.commits ≥10 条带短 SHA、dirtyFiles 与 status 一致（证据：curl 截取）
- [ ] /workbench 五视图可切换（#execution/#git hash 保持），执行/Git 视图真数据渲染、无操作按钮（证据：chrome 走查）
- [ ] workbench-model 测试全绿（P1 35 + P2 新增，零回归）（证据：测试输出）
- [ ] board-server 测试全绿含 ⑯（证据：测试输出）
- [ ] 0.3.10 发版版本位同步 + README/台账/引擎地图更新（证据：release.mjs 输出 + verify 全绿）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（2026-11-14 用户对话引用 P1 收口语「P2 候选（执行运行流 / Git 只读视图）已记 README」启动 P2——即对 README 所记候选的执行指令）；done（关单时回填）
- 确认门记录：P1 单已过确认门（同族延续）；改动清单 = 本单「改动方案」节
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
