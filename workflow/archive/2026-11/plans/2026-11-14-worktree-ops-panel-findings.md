---
状态: done
级别: L1
日期: 2026-11-14
模块: pipeline
确认指纹: e2be1b580bd3ec92
---
# PLAN — worktree-ops-panel-findings

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：pr-review 面板第五跑（run pr-baf1e6e-753574e2，范围 46f1468..baf1e6e = worktree-ops 0.4.16 单提交）：7 镜头 16 原始 → 簇聚 15 候选（1 blast-radius）→ 45 票全 confirm（用户指令「继续跑worktree-ops」）
- 目标：15 条 confirmed 全修（2 Important：CI 接线 + saveConfig 写路径兑现）+ 3 白盒新断言，0.4.17 发版
- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3

> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。

## 改动方案

- `plugins/worktree-ops/mcp/core.mjs`：C-001 baseRef 写路径空串归一（branchPrefix 同款 !=="" 守卫）；C-002/C-011 round-trip 改 defineProperty（__proto__ 原型 setter 堵口）；C-003 rename 前二次归属复核；C-010 acquireConfigLock 的 release 携带 lockPath（锁路径单源）；C-004 loadConfig 对相对 WORKTREE_CONFIG_HOME 上报 issue；C-009 git log 行解析抽 parseLogLine 单源（lastCommit/lastCommits 归一）
- `plugins/worktree-ops/mcp/tools.mjs`：C-005 prunable 豁免收紧为目录确已不存在（fs.existsSync 守卫 + 注释前提修正）；C-008 协议 enum 单源化（工具侧生产不可达分支移除）；C-014 mergedLabel 三态标签抽单源（两处渲染归一）
- `plugins/worktree-ops/test/config.mjs`：+2 断言（C-002 __proto__ round-trip 原样保留 / C-011 全局原型未污染；夹具用原始 JSON 串——对象字面量 __proto__: 是设原型不是建键）
- `plugins/worktree-ops/test/lock.mjs`：C-006 fd 泄漏段 waitMs=250 短路死限（产品默认不变，墙钟减半）
- `.github/workflows/ci.yml`：C-013（Important）worktree-ops 步骤接 test/config.mjs + test/protocol.mjs
- `plugins/worktree-ops/README.md`：C-012 契约表 remove 行补 prunable 例外；C-007 已知限制落档（3 项不修决定 + 理由）；版本段 0.4.17
- `plugins/worktree-ops/plugin.json`：版本 0.4.17（release.mjs）
- `plugins/worktree-ops/.zcode-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/worktree-ops/.codex-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/worktree-ops/.omp-plugin/plugin.json`：版本垫片（release.mjs）
- `plugins/worktree-ops/mcp/protocol.mjs`：SERVER_INFO 版本位（release.mjs）
- `marketplace.json`：市场版本（release.mjs）
- `.omp-plugin/marketplace.json`：市场版本（release.mjs）
- `README.md`（根）：市场表版本格（release.mjs）
- `workflow/plans/2026-11-14-worktree-ops-panel-findings.md`：本单

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 约束与风险

- 约束：双标志确认门语义不放松（prunable 收紧方向是更严不是更宽）；协议 enum 校验语义不变（只去重复分支）；C-003 二次校验为收窄窗口非宣称闭合（已知限制同锁接管）
- 风险：prunable 收紧后「目录在场 + prunable」场景从裸 git 报错变为要求双标志——更严方向（原来靠 git 顺带兜底）；C-013 接 CI 拉长该步骤约 +2s（config/protocol 均秒级）

## 验证计划

- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）
- 前端：cd frontend && npm run build（vue-tsc）
- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）
- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>
- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>

## 验收标准（可测试）

- [x] 15 条 confirmed 全处置 fixed（证据：dispose 输出 + 本单提交 SHA）
- [x] 十套件全绿（证据：bucket 14/config/exclude 10/inside 7/lock/merge-main 15/paths 13/protocol/smoke/timeout 11）
- [x] 新断言 3 组全绿（证据：C-002/C-011 config 白盒 + C-017 smoke）
- [x] 0.4.17 五处版本位同步（证据：release.mjs 输出）

> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
