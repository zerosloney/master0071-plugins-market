---
状态: approved
级别: L1
日期: 2026-11-14
模块: board
确认指纹: 2938ef6b971cc966
---
# PLAN — 交付工作台主题切换（深/浅双主题 + 记忆 + 全景联动，0.3.14）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。
对应 spec：省略（0.3.13 已给 dev-tour 双套变量；本单给工作台补浅色侧与切换面）

## 入口

- 来源：用户对话指令「页面颜色支持切换」——工作台当前仅深色（原型设计语言），需手动切换浅色并记忆
- 目标：顶栏主题切换钮（深/浅二态）；偏好记忆（localStorage）；内嵌全景 iframe 的 theme 参数跟随联动；无记忆时默认深色（零回归）
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 方案

- **浅色变量组**：workbench 现有 `:root` 深色变量不动（默认零回归）；加 `html[data-theme="light"]` 覆盖组——冷白系与深色一一对应（底 #f4f6f5 / panel 白卡 / 线 #d9dedb / 文字深墨 / mint 等语义色压深保浅底可读 / 阴影减弱），逐变量对照深色版校对比度
- **切换面**：topbar 放 icon-btn（日月/对比度图标，原型 ICONS 体系）；点击切换 `data-theme`（light↔dark），`localStorage.workbenchTheme` 记忆；启动读记忆（无记忆默认 dark）；角标文案「深色/浅色」
- **全景联动**：主题切换时全景视图 iframe src 的 `&theme=dark` 参数同步（dark→带参；light→去参还原 dev-tour 默认浅色）；仅全景视图在当前 src 存在时即时换 src
- **边界**：SSE/数据面零改动；只影响 workbench 页与内嵌 iframe 参数

## 改动方案

- `plugins/ai-native-delivery/board/workbench.html`（改）：浅色变量覆盖组 + topbar 切换钮（含图标/记忆/启动恢复）+ 全景 iframe theme 参数联动
- `plugins/ai-native-delivery/test/board-server.test.mjs`（改）：+⑳ 页含 data-theme 切换锚点（light 变量组 / localStorage 键 / 切换钮 token）
- `plugins/ai-native-delivery/README.md`（改）：看板节补主题切换口径 + 版本段 0.3.14
- `.agents/config/mechanism-registry.md`（改）：实时看板行「含深色 0.3.13」→「双主题 0.3.14」等长替换（余量 20B 内）；`.agents/notes/engine-map.md` 重渲
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.14（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位 0.3.14（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-workbench-theme-0314.md`：本单

## 约束与风险

- 约束：默认深色不变（无记忆/首开零回归）；数据面与 SSE 零改动；dev-tour 独立页不受影响
- 风险：浅色对比度需走查校验（语义色/状态 chips 在浅底可读性）；1940 行 CSS 变量消费面大，覆盖组漏配某变量会露深色残块——走查六视图逐视图核对

## 验证计划

- `node plugins/ai-native-delivery/test/board-server.test.mjs` 全绿（⑳ + 零回归）
- chrome 真仓走查：切换钮往返切六视图无深色残块、刷新记忆保持、全景 iframe 联动换参、默认（清记忆）深色
- `node plugins/ai-native-delivery/scripts/verify.mjs` 全绿

## 验收标准（可测试）

- [ ] 顶栏切换钮二态生效：浅色下六视图无深色残块，深浅往返刷新记忆保持，无记忆默认深色（证据：chrome 走查）
- [ ] 全景 iframe theme 参数联动（浅色→去参还原 dev-tour 浅色）（证据：走查 src 变化）
- [ ] board-server 测试全绿（⑳ + 零回归）（证据：测试输出）
- [ ] 0.3.14 发版版本位同步 + README/台账等长更新（证据：release 输出 + verify 全绿）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（2026-11-14 用户对话指令「页面颜色支持切换」）；done（关单时回填）
- 确认门记录：P1/P2/tour/dark 单已过确认门（同族延续）；改动清单 = 本单「改动方案」节
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
