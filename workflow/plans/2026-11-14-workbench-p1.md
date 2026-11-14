---
状态: approved
级别: L1
日期: 2026-11-14
模块: board
确认指纹: 1788b4241e0b28e7
---
# PLAN — 交付工作台 P1（三视图真接入：概览 / 交付流 / 决策中心）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。
对应 spec：省略（设计真源 = design/workbench-prototype.html 存档 + 本单契约节）

## 入口

- 来源：治理元循环首跑后用户裁决「P1 三视图真接入（推荐）」——可视化是当前最大缺口；设计参考 = Open Design 原型稿「闭环 · AI-Native 交付工作台」（4406 行单文件，6 视图，全内联 mock）
- 目标：board-server 加 /workbench 页与 /api/workbench 聚合模型，原型三视图（概览/交付流/决策中心）从 mock 换成本仓真实治理数据（plan 族生命周期 + 确认账 + 复核台账），只读观测面纪律不变
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 契约（P1 数据面口径，单源 = workbench-model.mjs）

- **交付（delivery）= plan 族**（stem = 文件名去扩展名；L2/L3 族含 intent/spec/plan 三件套，L1 单 plan；incidents 旁挂不立族）。八章环节状态三态 + na，每态带 evidence 文本（什么证据推的，界面如实展示）：
  - intake：族文件存在即据（intent 存在 / L1 plan 入口节）；draft 未确认 → active
  - spec：L1 → na；spec frontmatter 状态 approved/done → done、draft → active
  - plan：plan 状态 draft → active / approved → done / done → done
  - implement：产品提交锚（提交消息含 stem ∩ 触非 workflow/.agents 路径，复用 gen-workflow-metrics 同款口径）→ done；approved 无锚 → active
  - verify：plan 验收节勾验（`- [x]` 计数）全勾 → done / 部分 → active / 无 → queued
  - review：reviews.d 台账行对象列含 stem → done；否则 na（多数族无独立复核，如实）
  - ship：commit feed 触 marketplace.json ∩ 消息含 stem → done；否则 na
  - closeout：plan 归档 + done → done；活跃 → active；draft → queued
  - 四章（plan/design/build/test）由环节聚合：章内环节全终态 → done、有 active → active、余 → queued/na
- **决策面**：pending = draft 态 docs + 面板 undisposed findings（reviews.d/artifacts/*.json 无 disposition 者）+ deferred findings（disposition=deferred 挂账）；recent = .agents/confirmations.d/*.jsonl 合并按 ts 取 12 条（ts/doc/stage/source/quoteGrounding）；panels = reviews.d 行级 {日期, 对象, 意见/采纳/拒绝/误报}
- **repo 面**：branch / HEAD short / 脏文件数（git status --porcelain 单次）
- **API**：GET /api/workbench → { generatedAt, repo, stats, deliveries[], decisions{pending,recent,panels} }；GET /workbench → 页（live-only：fetch /api/workbench + SSE /api/events changed 重拉，断流退化 15s 轮询，同 dev-tour 纪律）
- **写面：零**。原型签署/审批按钮不迁——动作位改命令指引文案（如待确认项显示对应 confirm-doc 命令文本，不执行）

## 改动方案

- `design/workbench-prototype.html`（新）：原型稿原样存档（设计真源；260KB 单文件，来自 Open Design 工程目录，来源与用途在文件头注释标明）
- `plugins/ai-native-delivery/scripts/workbench-model.mjs`（新，~300 行）：`export function buildWorkbench({ root, now })`——族发现（workflow/{intents,specs,plans} 活跃+归档扫描）+ 环节/章推导（上节口径）+ 决策面聚合 + repo 面；git 单次 log feed（loadCommitFeed 同款：%cI\x1f%s + name-only，非台账路径 ∩ 消息含 stem = 产品锚；firstAdded 复用 metrics-core.loadFirstAdded）
- `plugins/ai-native-delivery/scripts/board-server.mjs`（改）：+GET /workbench（模板注入 live 锚点后吐页）+ GET /api/workbench（现场重建，构建量级秒内）；既有路由/SSE/白名单/Host 校验零改动
- `plugins/ai-native-delivery/board/workbench.html`（新，~1200 行）：三视图页——CSS 从原型精选迁移（od-* 原子类 + panel/stat/chip/track/gate/doc 主题变量与深色底；gateway/执行/协作/Git 专属样式不搬；Google Fonts 删，落 system-ui/Consolas 本地栈）；JS 面向 API 形状新写（非改原型 mock 工厂）；NAV 三项：概览/交付流/决策
- `plugins/ai-native-delivery/scripts/check-scope.mjs`（改）：KNOWN_EXT +`.html`（一处单行）——2026-11-13 起插件已分发 board/dev-tour.html，扩展集落后于现实：新增 .html 声明（本单设计稿存档 + 工作台模板）确认时刻与推送范围门双拦的根修
- `plugins/ai-native-delivery/test/workbench-model.test.mjs`（新）：mkdtemp 临时 git 仓夹具（假 plan 族：L1 单 plan / L2 三件套 / 归档 done 族 / draft 待确认族 + 假确认账 + 假 reviews.d 行 + 假 artifacts）断言：环节推导八键三态、章聚合、pending/recent/panels 聚合、产品提交锚、非 git 仓退化
- `plugins/ai-native-delivery/test/board-server.test.mjs`（改）：+3 断言——/api/workbench 出模型（deliveries/decisions 键）、/workbench 页注入 live 锚点无残留、坏参数 404 面不变
- `plugins/ai-native-delivery/README.md`（改）：实时看板节补 /workbench 三视图用法与数据口径（哪些环节是推导、证据文本如实展示）
- `.agents/config/mechanism-registry.md`（改）：实时看板行载体补 /workbench + /api/workbench（观测口径不变：启动次数与 SSE 推送数）；`.agents/notes/engine-map.md` 随 registry 重渲（gen-engine-map）
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.9（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-workbench-p1.md`：本单

## 约束与风险

- 约束：board-server 安全面零放松（127.0.0.1 / Host 校验 / 无静态文件服务 / 唯一写面仍只有 usage 埋点）；/api/workbench 只读聚合，不写任何文件；写操作不进 P1（按钮位 = 命令指引文案）；不做 gateway 选目录屏（ensure-board 已负责拉起）；执行/协作/Git 三视图不进 P1 也不留死占位（NAV 不显示，README 记 P2 候选）
- 风险：环节推导是启发式（verify=验收勾验、review=台账对象列匹配、ship=marketplace 提交）——每个环节带 evidence 文本如实展示推导依据，推不出显示 queued/na 不硬造；原型 CSS 精选迁移可能遗漏类（页面走查对拍原型截图核对三视图）；260KB 原型存档进 design/ 增仓库体积（一次性设计真源，接受）

## 验证计划

- `node plugins/ai-native-delivery/test/workbench-model.test.mjs` 全绿（夹具断言）
- `node plugins/ai-native-delivery/test/board-server.test.mjs` 全绿（含新增 3 断言）
- 真仓冒烟：ensure-board 拉起后 /api/workbench 出本仓真实模型（21 族、确认账非空、5 面板行），/workbench 页三视图人工走查（对照原型设计语言）
- `node plugins/ai-native-delivery/scripts/verify.mjs` 全绿（引擎脚本语法/机制台账/引擎地图/常驻面棘轮）

## 验收标准（可测试）

- [ ] /api/workbench 在本仓出真实模型：deliveries ≥ 20 族、每族 8 环节三态 + evidence、decisions.pending 含当前 draft/挂账、panels 含 2026-11 五行（证据：curl 输出截取）
- [ ] /workbench 页三视图可交互（切视图/切交付/环节展开），无 SSE 时 15s 轮询退化生效（证据：走查 + Network 截取）
- [ ] workbench-model 测试全绿：L1/L2/归档/draft 四型族推导 + 非 git 仓退化不崩（证据：测试输出）
- [ ] board-server 既有断言零回归 + 新增 3 断言绿（证据：测试输出）
- [ ] 0.3.9 发版五处版本位同步 + 机制台账/引擎地图/README 更新（证据：release.mjs 输出 + verify 全绿）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（2026-11-14 用户对话裁决「P1 三视图真接入（推荐）」——本单改动面即该选项描述的实现展开）；done（关单时回填）
- 确认门记录：AskUserQuestion 两问裁决（no-fuel 改判据 + P1 深度）；改动清单 = 本单「改动方案」节
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
