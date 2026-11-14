---
状态: done
级别: L1
日期: 2026-11-14
模块: pipeline
确认指纹: f1187612819b1169
---
# PLAN — ws-guard-fail-closed

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：pstack 面板评审挂账 C-003（pr-81c1f38-c3f8c4be，deferred 2027-02-14）——用户指示收账
- 目标：虚构工作区 fail-closed——cwd 无已存在祖先时不为契约脚本建锚、不自动放行；回归锁落盘；pstack 0.1.27 发版
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/pstack/hooks/pre-tool-use.mjs`：scriptRule 在 ws-guard 前加 existsSync(w) 守卫——resolve(cwd) 未解析（虚构工作区）时 gateTrace 记 reject:fictional-workspace 并静默出闸（回落宿主常规权限流，与未注册脚本同处理）
- `plugins/pstack/test/run-hook-tests.mjs`：回归锁 +1——fictional cwd（含时间戳的不存在路径）+ 契约脚本 + 相对操作数 → 输出为空（不自动放行）
- `plugins/pstack/README.md`：版本段 0.1.27
- `plugins/pstack/plugin.json`：版本 0.1.27（release.mjs）
- `plugins/pstack/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/pstack/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/pstack/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-ws-guard-fail-closed.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：只收紧不放松——真实存在的 cwd 路径行为零变化（既有 46 断言全绿不动）；resolve() 对操作数的语义不动（相对操作数拼锚后判定仍适用）
- 风险：极端场景（宿主在 cwd 尚未创建时调 hook）契约脚本不再自动放行——该场景下放行本身即缺陷本义，回落常规权限流是正确方向

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] 回归锁绿（证据：run-hook-tests 47 passed 含 fictional cwd: silent）
- [x] 既有行为零回归（证据：hook 47/0、sheet 20/0、role 61、qwen 65）
- [x] 面板 C-003 处置升级 deferred → fixed（证据：dispose 输出 + 本单提交 SHA）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
