---
状态: done
级别: L1
日期: 2026-11-14
模块: board
确认指纹: 246ef2691c85d75b
---
# PLAN — workbench 热修升版 0.3.11（windowsHide 弹窗根修的版本位落地）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。
对应 spec：省略

## 入口

- 来源：0.3.10 发布后用户实证缺陷——board-server 无控制台父进程下 workbench-model gitRun 漏 windowsHide，每 git 子进程弹 cmd 窗（产品修复已在 4abcd61 推送，归属 workbench-p2 名下）；本单只做版本位落地使客户端更新可拉到修复
- 目标：ai-native-delivery 0.3.10 → 0.3.11，触碰面即 release.mjs 全部版本位，无其他产品面
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/ai-native-delivery/README.md`：版本段 0.3.11（热修一行：gitRun 补 windowsHide，用户实证 cmd 弹窗根修）
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.11（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位 0.3.11（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-workbench-hotfix-0311.md`：本单

## 约束与风险

- 约束：本单零产品面（产品修复已在 4abcd61）；只动 release.mjs 触碰面与本单文件
- 风险：无（版本位机械同步）

## 验证计划

- `node plugins/ai-native-delivery/scripts/verify.mjs` 全绿（版本位变更过语法/棘轮门）

## 验收标准（可测试）

- [x] release.mjs 输出 7 处版本位 0.3.11 且触碰面与本单声明一致（证据：release 输出清单逐条一致）
- [x] verify 全绿（证据：13 项通过；途中机制台账常驻面超限 35B——今日两行扩写累计，按 0.3.4 先例措辞压缩回线内 40909B，语义不变）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（2026-11-14 用户对话指令「提交 升版 推送」——对已推送热修 4abcd61 的版本位落地指令）；done（关单时回填）
- 确认门记录：产品修复已在 workbench-p2 名下过门；本单为版本位补记单（readme-scope-note 先例）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
