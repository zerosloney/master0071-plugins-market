---
状态: approved
级别: L1
日期: 2026-11-14
模块: board
确认指纹: df5848d77ebde1e9
---
# PLAN — 交付工作台融合 dev-tour 全景（第六视图：内嵌 /tour）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。
对应 spec：省略（P1/P2 单已定工作台契约底座，本单是 dev-tour 既有页的内嵌融合）

## 入口

- 来源：用户对话指令「tour全景融进去这个工作台吧」——dev-tour 六视图全景（单 plan 步骤×文件）内嵌进工作台，不再跳出去看
- 目标：workbench 加第六视图「全景」（#tour）：选中交付 → 同源 iframe 加载 /tour?file=<该族 plan 路径>；归档族可用（白名单根修）
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 契约

- **白名单根修**：`tourDocRel` 放宽接受 `workflow/archive/<月>/{plans,specs,intents}/<名>.md`（归档 plan 同为 workflow/ 下只读 md，风险面等价；拒 `..`/绝对路径/`_` 前缀逻辑保留不变）——/tour 页与 /api/tour 同口径生效，dev-tour 模型对归档路径本就可建（fs 层面无限制）
- **全景视图**：NAV 第六项「全景」（icon 原型 flow/grid 系）；视图内 = 交付选择器（复用交付流的选择口径：active 优先、updatedAt 降序）+ 同源 `<iframe src="/tour?file=<选中族 plan 相对路径>">`；族无 plan 文档 → 空态文案；iframe 同源无跨域问题，/tour 页自带 live 模式与自身 SSE
- **数据零新增**：deliveries[].docs[].path 已含归档路径，前端直接消费；/api/workbench 模型不变

## 改动方案

- `plugins/ai-native-delivery/scripts/board-server.mjs`（改）：tourDocRel 放宽 archive 路径段（白名单注释同步——只读 md 面不变、防穿越不变）
- `plugins/ai-native-delivery/board/workbench.html`（改）：NAV +1「全景」+ view-tour 视图（交付选择器 + iframe + 无 plan 空态；沿用既有 select 样式；iframe 高度自适应视口）
- `plugins/ai-native-delivery/test/board-server.test.mjs`（改）：+⑰ archive 路径 /api/tour 200 出模型（夹具加归档 plan）+ 越界路径仍 400（../ 穿越回归）；+⑱ 页含 view-tour/全景锚点
- `plugins/ai-native-delivery/README.md`（改）：看板节补全景视图口径（内嵌 /tour、归档族可用）+ 版本段 0.3.12
- `.agents/config/mechanism-registry.md`（改）：实时看板行载体「五视图」→「六视图（含全景内嵌）」——措辞等长替换防常驻面超限；`.agents/notes/engine-map.md` 重渲
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.12（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位 0.3.12（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-workbench-tour.md`：本单

## 约束与风险

- 约束：iframe 同源只读（/tour 页自身零写面不变）；白名单只加 archive 段，防穿越/拒绝对路径逻辑不动；工作台零写面不变
- 风险：iframe 嵌套页各自 SSE 连接（工作台 1 条 + 全景 1 条，同服务可承受）；归档 plan 的 dev-tour 模型若有解析边角（归档件模板差异）由 ⑰ 夹具覆盖

## 验证计划

- `node plugins/ai-native-delivery/test/board-server.test.mjs` 全绿（⑰⑱ + 既有 16 零回归）
- 真仓冒烟：/workbench#tour 选中归档族（如 worktree-ops-panel-findings）iframe 出全景六视图；chrome 走查
- `node plugins/ai-native-delivery/scripts/verify.mjs` 全绿

## 验收标准（可测试）

- [ ] /api/tour?file=workflow/archive/<月>/plans/x.md 返回 200 模型（归档可用），../ 穿越仍 400（证据：测试 ⑰ + curl）
- [ ] /workbench#tour 六视图在列：选交付 → iframe 加载对应 /tour 全景（归档族可看）（证据：chrome 走查）
- [ ] board-server 测试全绿（⑰⑱ + 零回归）（证据：测试输出）
- [ ] 0.3.12 发版版本位同步 + README/台账等长更新（证据：release 输出 + verify 全绿）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（2026-11-14 用户对话指令「tour全景融进去这个工作台吧」）；done（关单时回填）
- 确认门记录：P1/P2 单已过确认门（同族延续）；改动清单 = 本单「改动方案」节
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
