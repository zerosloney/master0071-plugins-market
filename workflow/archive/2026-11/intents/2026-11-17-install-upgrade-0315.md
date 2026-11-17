---
状态: done
级别: L2
日期: 2026-11-17
模块: infra
备注: 蓝本 agentic-flow-kit v2.6.1 baseline/migrations/upgrade/diff/prune 判据级移植，零运行时依赖
确认指纹: fb7efc882e8b4990
---
# INTENT — 装户升级面：基线三方合并 + manifest 迁移框架 + 漂移视图 + prune（0.3.15）

<!-- 复制本模板为 YYYY-MM-DD-<主题>.md 后填写；plans/ 下同名文件与本文件配对 -->
<!-- frontmatter 受限子集（2026-09-13）：每行 键: 值；状态∈draft/approved/done/superseded/cancelled（严格枚举，附注写备注键）；级别∈L1/L2/L3；check-loop 只扫 frontmatter 取机器字段，正文不再写状态/级别行 -->

## 背景与问题

- 来源：用户对话指令（2026-11-17）——插件版与引擎底座 agentic-flow-kit（v2.6.1）版本脱离很大，经两侧盘点（底座 2.2.0→2.6.1 新增约 47 项能力 vs 插件 v0.3.14 功能面）确认装户升级面为 P0 首单。
- 现状：init-engine plan/apply/sha256 台账（0.1.19 装户层重构，蓝本 kit 安装面）已有 create / update（种子升级传播）/ conflict-skip / 领养 四裁决，**未触及文件已有升级通道**。
- 缺口（对齐底座 src/install/{baseline,migrations}.mjs + src/commands/{upgrade,diff,prune}.mjs）：
  1. **冲突路径无三方合并**——用户改过的文件（目标≠台账）遇种子升级（种子≠台账）只会 conflict-skip；`--force` 整覆盖丢用户改动；
  2. **manifest 无版本化**——`.agents/install-manifest.json`（入库共享 lock）无 schemaVersion 与迁移链，台账结构演进无向前通道；
  3. **无只读漂移视图**——装户文件「谁改的/能不能升/孤儿」要靠 dry-run 逐项读裁决清单，无底座 diff/status 式分类汇总；
  4. **无 prune**——种子清单下线的文件在使用项目侧永久残留（台账登记也在），无孤儿清理。

## 历史教训/防复发

- 检索结果：incidents 无命中（`kb-search --type incidents 冲突` 0 命中）；按改动文件检索（`--files apply.mjs,manifest.mjs,init-engine.mjs`）命中两个先例 plan：
  - `2026-11-13-mutable-ledger-semantics`：台账 files 值有两种形态——sha256 哈希串 / `{mutable:true}` 对象（存在即在位、不比对哈希、不覆盖、不报 conflict）。**基线留存与三方合并通道必须跳过 mutable 条目**，否则破坏其「存在即在位」语义。
  - `2026-11-13-dev-tour-live-board`：本仓自举台账已有 update 通道实践（种子变更传播 + 本仓 `.agents/install-manifest.json` 同步），本单动 apply 裁决时本仓自身即为首个升级走查对象。
- 避坑指南：
  1. **哈希口径**：manifest.mjs hashText 为 CRLF→LF 归一后 sha256（Windows autocrlf 检出差异不构成假冲突，先例 confirm-doc computeFingerprint）——基线读写、merge 读盘、落盘后回写基线全链同口径，否则合并通道会在 Windows 上批量假冲突；
  2. **幂等字节契约**：serializeManifest 先比对再写（重复跑零改动，测试做全树 mtime 快照）——新增 schemaVersion 字段后，旧台账（无该字段）读取时**视作 0 而非每次补写**，否则每次 init 都重写台账字节、幂等契约破功（何时落字段进 spec 前提质询）；
  3. **领养语义不动**：台账缺失/损坏 → 领养（现状记账、不覆盖）是不丢数据方向，合并通道不得改变该兜底。

## 目标

- [ ] **基线三方合并**：目标≠台账（用户改过）且种子≠台账（种子升级）且非 mutable → `git merge-file`（base=基线留存、ours=盘上正文、theirs=新种子）clean → 落盘合并结果 + 基线更新 + 台账 update；conflict（带标记）→ 维持 conflict-skip 语义不变；git 不可用 → 回退 conflict-skip（判定语义同底座 mergeThreeWay：退出码 0=clean、1–127=conflict、>127/error=unavailable）
- [ ] **基线留存**：`.agents/.install-baseline/` 存上次落盘正文（文本种子 + git hook 渲染后正文；二进制扩展名防御性跳过）；create/update/merge-clean 后写基线；支持清无主基线
- [ ] **manifest 迁移框架**：schemaVersion=1 起步，`scripts/install/migrations/` 单向迁移链（`<from>-<to>.mjs` 导出 {from,to,migrate}）；全链成功才写、任一步失败零落盘；台账 schemaVersion 高于当前支持拒绝；只转换 manifest 不改用户文件
- [ ] **只读漂移视图**：`scripts/install-drift.mjs` 一次跑出六类分类——unchanged / user-modified / seed-updated（可直接 update）/ merge-needed（双方都改）/ orphan（台账有种子无）/ missing（台账有盘上无）+ 汇总行；只读、exit 0、不写任何文件
- [ ] **prune**：`init-engine.mjs --prune [--dry-run]` 删台账登记且当前种子已无的文件（盘上哈希==台账哈希才删，改过保留并报告），连带清无主基线与台账孤儿行；默认 dry-run 语义（不带 --dry-run 才真删）
- [ ] 版本 0.3.15 发版（release.mjs 七版本位）

## 非目标（L1 微改动无实质内容可删本节，不硬填）

- 不引入对 agentic-flow-kit 的任何运行时依赖（零 import、零 spawn；判据级移植、结构自建，不动 kit 源码）
- 不做底座 --explain-policy 策略差分、adopt 接管扩展、remove-host/uninstall、TUI 向导（插件由宿主市场安装，形态不匹配）
- 不做二进制种子基线合并（插件种子全文本；BINARY_EXT 清单仅防御性跳过）
- 不改 doctor 7 项检查面、不改 MCP 工具面（漂移视图为独立只读脚本，不进 MCP）
- 不做 upgrade 独立子命令（init-engine 即 install==upgrade 单入口，与底座差异为有意设计）

## 约束（L1 微改动无实质内容可删本节，不硬填）

- 复用：install/plan+apply+manifest 骨架、hashText 归一口径、writeManifestAtomic、领养模式、GITIGNORE 标记块机制
- 不许动：台账「入库共享」语义、mutable 条目语义、幂等契约（重复跑零改动 + mtime 快照测试口径）、git hooks 安装语义、门禁/CI/init 零模型原则
- 新脚本入 check-script-coverage 对账与 rule-budgets 棘轮；测试按 test/install.test.mjs 先例口径扩展或新增 test/install-upgrade.test.mjs
- 本仓自举：改完须在本仓自身跑一次真实升级走查（本仓 `.agents/install-manifest.json` 即首个用户）

## 影响面

- 模块：infra
- 数据库：无
- 装户面：`plugins/ai-native-delivery/scripts/install/{apply,manifest}.mjs`（改）+ `install/baseline.mjs`、`install/migrations.mjs`、`install/migrations/0-1.mjs`、`install-drift.mjs`（新）+ `scripts/init-engine.mjs`（改：--prune）+ `test/`（扩）+ `README.md` 装户节 + 本仓自举台账走查
- 前端页面：无

## 触达红线（对照 AGENTS.md，勾选仅标记触及范围；具体如何满足在同名 spec 或 Quick-Plan 中说明）

- [x] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
  - 命中依据：①共享契约——install-manifest.json（入库共享 lock）形状演进（+schemaVersion）；②既有接口语义——init-engine 裁决出口新增 merged 态与 `--prune` 参数，conflict 路径行为变化。自查句：受影响消费方 ≥2（使用项目侧台账、本仓自举台账、test/install.test.mjs 契约用例）→ L2 成立
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3
  - 不命中依据（两问定级第一问）：无 DB schema/迁移 SQL/DI 链/认证管线；manifest schemaVersion 为 lock 文件兼容演进（缺字段视作 0 迁移到 1，不转换任何用户数据），`.agents/.install-baseline/` 为新增只写数据面，非运行时结构改造 → 判 L2

> 触及任一红线即为 L2 / L3，必须立 ../specs/YYYY-MM-DD-<主题>.md 写明如何满足，方可起草 plan。

## 验收标准（可测试）

- [x] A1 三方合并 clean 路径：用户改动与种子升级并存时落盘 merge-file 合并结果、台账 update、基线同步更新（证据：test/install-upgrade.test.mjs A1 组 14 断言——clean 落盘 LF/报告「合并 1 项」/台账记种子侧哈希/基线=新种子正文/二跑内容不丢/二轮演进重合）
- [x] A2 冲突/降级路径：合并冲突 → conflict-skip 语义与输出不变；git 不可用 → 回退 skip 不炸；`--force` 仍整覆盖（证据：A2 组 9 断言——同区域双改 conflict-skip 零变化/CHECK_LOOP_GIT 注入 unavailable 回退/force 优先于合并且基线随写）
- [x] A3 mutable 条目不进合并/基线通道，行为与 mutable-ledger-semantics 判据零变化（证据：A3 组 8 断言 + install.test.mjs 既有 mutable 用例 56/0 零改动全绿；钩子/mutable 基线面零文件全枚举断言）
- [x] A4 迁移链：0→1 全链成功才写台账；注入失败用例零落盘；schemaVersion 高于支持拒绝退出非零（证据：A4 组 13 断言——0→1 补字段 files 原样/已 1 changed=false/99 抛 MANIFEST_SCHEMA 非零退出；零落盘=迁移模块无 fs 写调用设计保证+CLI 99 零落盘断言）
- [x] A5 幂等零回归：重复跑 init-engine 台账字节不动（旧无 schemaVersion 台账读取不触发重写）；test/init.test.mjs + test/install.test.mjs 既有全绿（证据：node --test 三套 pass 3/0（56+56+79）；A5 组 6 断言 mtime/字节快照；本仓自举真跑后三次连跑 install-manifest.json sha256 逐字节一致 9ee6ab54…）
- [x] A6 install-drift.mjs 六类分类正确（构造六类 fixture 各断言）+ orphan prune 哈希一致才删、改过保留（证据：A6a 组 15 断言——六类计数/mutable 恒 unchanged/无台账单行 exit 0/零写盘快照；A6b 组 14 断言——孤儿哈希一致真删+台账行清+无主基线连清/改过、mutable、钩子双口径保留/dry-run 零删/不带 --prune 零删除）
- [x] A7 `node plugins/ai-native-delivery/scripts/verify.mjs --scope` 全绿；check-script-coverage 对账过；rule-budgets 线内（证据：verify --scope 13 门全绿（墙钟 7s/预算 15s，含 rule-budget 门 1.7s 过）；check-script-coverage 115 脚本直接 71/间接 41/缺失 0）

> **闭环对账**：关单在 test 阶段（不依赖 deploy）。intent 置 done 前逐条勾验，每条补证据——`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟脚本输出>）`。
> done 状态仍有未勾项会被 check-loop 拦截（2026-09-12 起新建 intent 为 hard-block，存量 intent 仅 warning 提示）；勾选但缺「证据：」为 hard-block。

## 确认与复核

- 确认日期：
- 确认人：用户（对话内明确放行即确认）
- 确认范围：目标/非目标/约束/验收标准（本文件全部小节）
- 复核：L2 → spec 阶段强制委派 independent-reviewer（design.md 口径）
