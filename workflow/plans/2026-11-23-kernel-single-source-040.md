---
状态: approved
级别: L2
日期: 2026-11-23
模块: engine
备注: 关联 ../intents/2026-11-23-kernel-single-source-040.md + ../specs/ 同名；三笔提交形态（docs 开单 / feat 0.4.0 / docs 关单）
确认指纹: abc812029b226c3c
---
# PLAN — 内核单源化：机件经 agentic-flow-kit kernel 门面复用（0.4.0）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：../intents/2026-11-23-kernel-single-source-040.md（approved，A1..A4）
对应 spec：../specs/2026-11-23-kernel-single-source-040.md（approved，场景 A-D）

## 改动方案

- `plugins/ai-native-delivery/scripts/lib/kit-kernel.mjs`（新）：唯一解析点——`FLOW_KIT_ROOT`（认死不回退）> `npm root -g` 末行 + `/agentic-flow-kit`；`MIN_KIT_VERSION='2.12.0'` 严格三段数值门禁；包不完整/低版本/缺门面/require 失败 → 中文 throw + 固定修复提示；惰性解析 + 进程内缓存、无顶层 await；`kitKernelStatus()` 探测不抛错；`hashText`/`hashFile`/`dirtyTreeDigest`/`mergeThreeWay` 四同步包装（createRequire require ESM，Node ≥22.12）
- `plugins/ai-native-delivery/scripts/install/manifest.mjs`（改）：`hashText`/`hashFile` 本地实现删除改 re-export；crypto import 收敛 `{ randomBytes }`；台账形状/serializeManifest/writeManifestAtomic/readManifest/CURRENT_SCHEMA_VERSION 全部不动
- `plugins/ai-native-delivery/scripts/install/baseline.mjs`（改）：`mergeThreeWay` 本地实现删除改 re-export；本次产生的 unused import（os/spawnSync/GIT）删除；存储函数（BASELINE_DIR_NAME/isBinaryPath/baselinePath/readBaseline/writeBaseline/removeBaseline/listBaselines/pruneBaselines）全部不动
- `plugins/ai-native-delivery/scripts/git-tree-digest.mjs`（删）：15 行镜像清零（判据随 kit kernel 单源）
- `plugins/ai-native-delivery/scripts/verify.mjs`（改）：`dirtyTreeDigest` import 改指 `./lib/kit-kernel.mjs`；:933 文档性提及同步
- `plugins/ai-native-delivery/scripts/doctor.mjs`（改）：import `kitKernelStatus`；h 项后新增第 9 项「kit 内核依赖」（机器级）；头注检查面列表补 i 行
- `plugins/ai-native-delivery/config-templates/scripts-test-exempt.txt`（改）：新脚本 `lib/kit-kernel.mjs` 按「新增脚本必须登记」纪律走 indirect 登记（4 行，指向 verify.test.mjs 25a 及消费方覆盖）
- `plugins/ai-native-delivery/test/verify.test.mjs`（改）：import 改指适配缝；:1199 注释同步
- `plugins/ai-native-delivery/test/doctor.test.mjs`（改）：`CHECK_NAMES` 补「kit 内核依赖」（8→9 项）及「八/九项」文案同步——本单唯一允许的断言改动
- `plugins/ai-native-delivery/test/install-upgrade.test.mjs`（改）：A2「git 不可用」场景根因适配——kit kernel 不认 `CHECK_LOOP_GIT` 注入点，改剥 PATH + `FLOW_KIT_ROOT` 指真包根（纯 fs 不受 PATH 影响）；断言零改动
- `plugins/ai-native-delivery/README.md`（改）：安装节补运行时前提声明（全局 `npm i -g agentic-flow-kit@≥2.12.0`，缺席 fail-loud，修复命令内建）+ doctor 项数勘误（「7 项」→「9 项」，含新增第 9 项）
- 版本位八处（scripts/release.mjs 口径，花括号展开——extractDeclared 不识别缩写）：0.4.0——plugins/ai-native-delivery/plugin.json、plugins/ai-native-delivery/.zcode-plugin/plugin.json、plugins/ai-native-delivery/.omp-plugin/plugin.json、plugins/ai-native-delivery/.codex-plugin/plugin.json、plugins/ai-native-delivery/mcp/protocol.mjs（SERVER_INFO.version）、marketplace.json、.omp-plugin/marketplace.json、README.md（根插件表，2026-11-20 关单补账：三处插件目录外路径单列）
- 台账（本单）：workflow/intents/2026-11-23-kernel-single-source-040.md、workflow/specs/2026-11-23-kernel-single-source-040.md、workflow/plans/2026-11-23-kernel-single-source-040.md、workflow/INDEX.md（gen-workflow-index 再生成）、workflow/delegations.d/2026-11.md（委派补记三行）

## 任务拆解（L2/L3 必填；L1 仅多文件多步骤时用，单任务微改动删本节）

- [x] 1. kit 侧 kernel 门面（#75 领单重做 + 2.12.0 首发；kit 仓，经 issue 流程）
   - 文件（kit 仓）：src/kernel/index.mjs（新）、package.json（exports）、tests/kernel.test.mjs（新）——不在本仓提交面，仅作前置依赖登记
   - 判据：registry 2.12.0 tarball 含 kernel 与 `exports {"./kernel"}`；四导出齐全；CRLF 判据成立；kit 侧测试绿
   - 风险：低（纯增量；kit 内部链路不经门面）
   - 留痕：registry 工件复验通过（777 文件含 src/kernel/index.mjs，exports 一致）；全局 2.12.0 装机；四导出 / CRLF 对拍冒烟通过（首轮实现经 #75 摘除重做，最终以 2.12.0 工件为准）
- [x] 2. 插件侧 T1：适配缝 + 三机件换源 + 删镜像 + 测试改指（委派 coding-worker）
   - 文件：plugins/ai-native-delivery/scripts/lib/kit-kernel.mjs、plugins/ai-native-delivery/scripts/install/manifest.mjs、plugins/ai-native-delivery/scripts/install/baseline.mjs、plugins/ai-native-delivery/scripts/git-tree-digest.mjs、plugins/ai-native-delivery/scripts/verify.mjs、plugins/ai-native-delivery/test/verify.test.mjs、plugins/ai-native-delivery/test/install-upgrade.test.mjs
   - 判据：re-export 同名同签名、下游六消费方零改动；`git-tree-digest` 功能引用清零；防呆 fail-loud；全量测试绿
   - 风险：中（install 引擎/verify 凭证落账路径；失败面必须 fail-loud 不得静默）
   - 留痕：89 套件 107/107 绿（3m17s）；防呆——`FLOW_KIT_ROOT=<空目录>` throw 含修复命令、指真包根 CRLF 对拍 true；A2 注入机制根修（断言零放宽）；DEP0190 弃用告警主会话补修（spawn 命令字符串形式）
- [x] 3. 插件侧 T2：doctor 第 9 项 + 断言 8→9 + 豁免表登记（随 T1 委派同批）
   - 文件：plugins/ai-native-delivery/scripts/doctor.mjs、plugins/ai-native-delivery/test/doctor.test.mjs、plugins/ai-native-delivery/config-templates/scripts-test-exempt.txt
   - 判据：9 项出列；kit 项 ✓ 含 root+version；warn/exit 语义不变；既有断言仅项数相关改动
   - 风险：低
   - 留痕：本仓实跑 9/9 全通过（`✓ kit 内核依赖 — agentic-flow-kit@2.12.0 在位`）；doctor.test 47/0
- [x] 4. 2.12.0 收口 + MIN 门对齐（主会话自做）
   - 文件：plugins/ai-native-delivery/scripts/lib/kit-kernel.mjs（MIN_KIT_VERSION 2.11.0→2.12.0 一行）、全局安装（环境动作）
   - 判据：registry 工件含 kernel/exports；全局 2.12.0；版本门对齐后全量门绿
   - 风险：低
   - 留痕：`npm view` version=2.12.0 + exports 一致；全局升级后 107/107 绿（跑在 registry 工件上）；doctor 9/9
- [ ] 5. 0.4.0 发版 + 关单（主会话自做）
   - 文件：版本位八处、plugins/ai-native-delivery/README.md、台账三件 + INDEX + delegations.d
   - 判据：`release --check` 八处一致 0.4.0；verify --scope 全绿并落凭证；三件 done 指纹；INDEX 活跃清零；三笔提交形态
   - 风险：低
   - 留痕：本笔完成时补记

## 验证步骤

- 逐任务：跑对应 test 文件（`node --test plugins/ai-native-delivery/test/<name>.test.mjs`），既有用例零回归为底线
- 全量：`node --test plugins/ai-native-delivery/test/*.test.mjs`（89 套件）；`node scripts/release.mjs --check` 八处 0.4.0 一致；`verify --scope` 全绿落凭证
- 自举走查：本仓 doctor 9/9 实跑（第 9 项 kit 在位实证）；防呆演示（FLOW_KIT_ROOT 指错 fail-loud）；job 边缘——version=2.12.0 严判（低版本拒载用例在 kit-kernel 解析路径，防呆演示间接覆盖）
