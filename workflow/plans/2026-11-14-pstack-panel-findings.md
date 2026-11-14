---
状态: approved
级别: L1
日期: 2026-11-14
模块: pipeline
确认指纹: b220691aaf2ede4c
---
# PLAN — pstack-panel-findings

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：pr-review 面板跨插件第二跑（run pr-81c1f38-c3f8c4be，范围 7da6639..81c1f38 = pstack 0.1.25 弧）：7 镜头 21 原始 → 17 候选（4 带外拦下）→ 3 验证者 51 票全 confirm
- 目标：17 条 confirmed 全修（含 4 条同点重复的 cd 守卫、SAFE_FORCE 越界、render 大小写绕过）+ 带外三处（ci 接线/copilot 文档/构建器守卫），pstack 0.1.26 / agent-pipelines 0.1.28 / ai-native-delivery 0.3.7 三发版
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `.qwen/skills/verify/run.mjs`：C-001/C-006/C-011/C-017 cd 守卫加分隔符边界（next===ROOT || startsWith(ROOT+path.sep)）；C-002 doctor 对合法 JSON 缺 plugins 键输出可读 ✗ 不再裸栈；C-007 git --version 单次求值
- `.qwen/skills/verify/features/workflow-plugins.md`：C-016 子智能体计数 15→4（同 PR 删 11 后按旧态撰写）
- `plugins/agent-pipelines/scripts/render.mjs`：C-004 保留路径守卫大小写折叠（NTFS 不区分大小写——大小写变体 --out 即同一文件）
- `plugins/agent-pipelines/scripts/state.mjs`：C-010 死再导出删除（三缝拆分后零消费者）
- `plugins/agent-pipelines/README.md`：版本段 0.1.28
- `plugins/agent-pipelines/plugin.json`：版本 0.1.28（release.mjs）
- `plugins/agent-pipelines/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/agent-pipelines/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/agent-pipelines/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `.github/workflows/ci.yml`：带外——agent-pipelines 步骤接 test/scripts.mjs（m1/m3 修复原无 CI 守护）
- `plugins/pstack/hooks/pre-tool-use.mjs`：C-008 PSTACK_GATE_TRACE 转正常驻诊断（注释改口径）
- `plugins/pstack/test/run-hook-tests.mjs`：C-005/C-009 夹具基座锚定测试文件自身位置（原按 cwd 上跳两级）
- `plugins/pstack/README.md`：C-008 兑现——「hooks 诊断」节补文档 + 版本段 0.1.26
- `plugins/pstack/skills/setup-pstack/SKILL.md`：C-014「read-sheet.sh 零消费」改如实
- `plugins/pstack/skills/poteto-mode/references/zcode-tools.md`：C-015 会话模型全称句加 thermo 钉值例外
- `plugins/pstack/skills/poteto-mode/references/copilot-tools.md`：带外——与「Copilot 非 agent 注册宿主」对齐（agent 加载段改写 + effort 变体引用更新）
- `plugins/pstack/plugin.json`：版本 0.1.26（release.mjs）
- `plugins/pstack/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/pstack/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/pstack/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/scripts/verify.mjs`：C-012 M10 桩越界判据加分隔符边界
- `plugins/ai-native-delivery/hooks/pretool-risk.mjs`：C-013 SAFE_FORCE 中和收窄为仅内置地板规则（项目侧点名安全变体的规则恢复生效）
- `plugins/ai-native-delivery/test/hook.test.mjs`：C-013 回归断言两条（项目点名即拦 / 未点名照放）
- `plugins/ai-native-delivery/README.md`：版本段 0.3.7
- `plugins/ai-native-delivery/plugin.json`：版本 0.3.7（release.mjs）
- `plugins/ai-native-delivery/mcp/protocol.mjs`：SERVER_INFO 版本位（release.mjs）
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/ai-native-delivery/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `scripts/build-qwen-extension.mjs`：带外 Important——--out 在仓库内但插件树外一律拒绝（堵 rmSync 整树误删面，实测拒兄弟插件路径）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-pstack-panel-findings.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：SAFE_FORCE 豁免方向保留（地板不误拦安全变体），只收窄到地板——用户清单优先；C-003 ws-guard 为 pre-existing 按记录在案处置不动语义；测试面全绿前提下方可收口
- 风险：ci.yml 加一行拉长 CI 时长（scripts.mjs 约 +数秒）；构建器守卫收紧可能拒绝个别旧用法——语义为「仓库内必须在插件树内」，qwen/ 默认输出不受影响

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] 17 条 confirmed 全处置（16 fixed + C-003 pre-existing recorded，证据：dispose 输出 + 修复提交 SHA）
- [x] 受影响测试面全绿（证据：hook 160/0 含 2 新断言、pstack 五套 46/20/61/65、agent-pipelines 五套 133/161/83/117/59、acceptance 132/0）
- [x] 构建器守卫实测（证据：--out plugins/systemone-decision 被拒 / $TEMP 输出正常）
- [x] doctor 冒烟（证据：instance is worth driving）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
