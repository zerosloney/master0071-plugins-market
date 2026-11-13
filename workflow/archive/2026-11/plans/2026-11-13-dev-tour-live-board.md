---
状态: done
级别: L1
日期: 2026-11-13
模块: pipeline
确认指纹: 77508e8b70d1ad20
---
# PLAN — dev-tour-live-board——开发全景实时看板

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：2026-11-13 用户指令「dev-tour 实时版」（路线图里唯一缓期的形态级大件）
- 目标：dev-tour 从静态快照扩到实时看板——本地只读服务 + SSE 变更推送 + 用量埋点 + 幂等一键拉起，且安全面比源仓更窄（不做任意静态文件服务）
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `.agents/config/engine.json`：种子补 options.boardPort（装户侧可改端口的入口）
- `.agents/config/mechanism-registry.md`：登记表补「开发全景实时看板」行（[检出型]）；开发全景图行去掉「实时版不分发」
- `.agents/install-manifest.json`：本仓自举台账（update 通道同步 engine.json 与登记表的种子变更）
- `.github/workflows/ci.yml`：CI 清单接 3 个新测试行
- `.omp-plugin/marketplace.json`：实时看板相关改动
- `README.md`：实时看板相关改动
- `marketplace.json`：实时看板相关改动
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：实时看板相关改动
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：实时看板相关改动
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：实时看板相关改动
- `plugins/ai-native-delivery/README.md`：README 补实时看板节与 0.3.3 版本段
- `plugins/ai-native-delivery/config-templates/engine.json`：种子补 options.boardPort（装户侧可改端口的入口）
- `plugins/ai-native-delivery/config-templates/mechanism-registry.md`：登记表补「开发全景实时看板」行（[检出型]）；开发全景图行去掉「实时版不分发」
- `plugins/ai-native-delivery/mcp/protocol.mjs`：实时看板相关改动
- `plugins/ai-native-delivery/plugin.json`：实时看板相关改动
- `plugins/ai-native-delivery/skills/dev-tour/SKILL.md`：技能合同补实时看板节（命令/接口/端口口径/停服/安全面），边界节从「实时版不分发」改为「已随 0.3.3 分发但不做执法依赖」
- `plugins/ai-native-delivery/scripts/auto-tour.mjs`：一键打印实时链接；恒 exit 0（失败不阻断，错误进 stderr）
- `plugins/ai-native-delivery/scripts/board-port.mjs`：端口解析单源：显式 --port > engine.json options.boardPort > 基线 8933
- `plugins/ai-native-delivery/scripts/board-server.mjs`：实时看板本地只读服务：/tour 页面 + /api/tour 现场重建模型 + /api/events SSE + /api/tour/usage 埋点 + /api/health 探针；只绑 127.0.0.1、Host 校验、文档白名单、pid 文件
- `plugins/ai-native-delivery/scripts/ensure-board.mjs`：幂等拉起看板（端口已在跑则复用），打印可点链接，不开浏览器
- `plugins/ai-native-delivery/test/auto-tour.test.mjs`：一键拉起黑盒（4 断言）
- `plugins/ai-native-delivery/test/board-port.test.mjs`：端口解析单源黑盒（6 断言）
- `plugins/ai-native-delivery/test/board-server.test.mjs`：实时看板黑盒：health/tour 模型/页面注入/302/埋点/404/403/穿越拦截/SSE changed/ensure 幂等/auto-tour/端口序（13 断言）
- `plugins/ai-native-delivery/test/ensure-board.test.mjs`：幂等拉起黑盒（5 断言；占用端口走异步 spawn——spawnSync 阻塞事件循环会让假服务无法应答）

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 验证与验收（lite）

- 静态门：`node <插件根>/scripts/verify.mjs --scope` 绿（涉前端改动另附实测证据）
- 检索：粘贴第 2 步 kb-search 输出（无命中贴命令与空结果即可，免另写说明）
- 验收：见「验收标准」节

## 验收标准

- [x] 实时看板四套黑盒全绿：board-server 13 / board-port 6 / ensure-board 5 / auto-tour 4（证据：各套件输出合计）
- [x] 手工冒烟七项：health/tour 模型/页面 MODE=live 无残留锚点/埋点落盘/未知路由 404/坏 Host 403/路径穿越 400（证据：冒烟输出）
- [x] 脚本覆盖门缺失 0（证据：check-script-coverage --strict 输出 108 脚本 / 缺失 0）
- [x] update 通道实战：重跑 init 把变更的种子走 update 更新而非冲突（证据：init 输出「更新 2 项」+ doctor 7/7）
- [x] acceptance 全量绿（证据：acceptance 合计）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。约束与风险以一句话并入改动方案条目。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
