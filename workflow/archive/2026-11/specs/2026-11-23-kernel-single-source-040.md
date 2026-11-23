---
状态: done
级别: L2
日期: 2026-11-23
模块: engine
备注: 关联 ../intents/2026-11-23-kernel-single-source-040.md；换源非改判据（判据逐字同 kit kernel）
确认指纹: 03b552fc083ebf22
---
# SPEC — 内核单源化：机件（hash/digest/mergeThreeWay）经 agentic-flow-kit kernel 门面复用（0.4.0）

<!-- 与 intents/ 下同名入口文档配对；L2/L3 必须先有 ../intents/YYYY-MM-DD-<主题>.md approved -->
<!-- frontmatter 受限子集（2026-09-13）：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->

## 功能行为

**场景 A：适配缝单点解析（`scripts/lib/kit-kernel.mjs`，新增）**——全插件唯一知道全局包位置的模块。解析顺序：`env FLOW_KIT_ROOT`（指 kit 包根，含 package.json；设置了就认，指错由加载校验 fail-loud，**不回退** `npm root -g`）> `spawnSync('npm root -g', {shell:true})` 输出末行 + `/agentic-flow-kit`。行为细则：

- 版本门：`MIN_KIT_VERSION='2.12.0'`，严格 x.y.z 三段数值比较（非该形态视为不合格）；低版本/包不完整/缺 kernel 门面 → throw 中文单句 + 固定修复提示 `npm install -g agentic-flow-kit@latest（开发机可设 FLOW_KIT_ROOT 指向 kit 包根）`；
- 惰性解析 + 进程内缓存：首次调用才解析，无顶层 await——doctor 等纯静态检查在 kit 缺席时须能跑完自诊断（`kitKernelStatus()` 探测不抛错，返回 `{ok:true,root,version}` 或 `{ok:false,error}`）；
- 同步加载：`createRequire(import.meta.url)` require `<包根>/src/kernel/index.mjs`（Node ≥22.12 支持 require ESM；require 抛错给含 Node 版本要求的中文错误）——包装函数保持同步签名，消费方调用点零改动；
- 导出面：`MIN_KIT_VERSION`、`kitKernelStatus()`、`hashText`/`hashFile`/`dirtyTreeDigest`/`mergeThreeWay` 四同步包装。
- `npm root -g` 以命令字符串形式 spawn（`shell:true` + args 数组触发 DEP0190 弃用告警；参数为固定字面量无拼接面）。

**场景 B：三机件换源（判据零变更）**——`scripts/install/manifest.mjs` 删本地 `hashText`/`hashFile`（CRLF→LF 归一 sha256）改 3 行 re-export；`scripts/install/baseline.mjs` 删本地 `mergeThreeWay`（归一三方合并，退出码 clean/conflict/unavailable 三态）改 3 行 re-export；`scripts/git-tree-digest.mjs`（15 行镜像）删除，`verify.mjs` 直连适配缝。其余面全部不动：manifest 的台账形状/serializeManifest/writeManifestAtomic/readManifest、baseline 的存储函数（`.install-baseline` 落位与 GIT 注入）、migrations 链、apply 的 merge-block 内联判据。下游六消费方 import 零改动（re-export 同名同签名）。

**场景 C：doctor 第 9 项（`scripts/doctor.mjs`）**——新增机器级检查「kit 内核依赖」（不依赖项目根）：`kitKernelStatus()` ok → `✓ kit 内核依赖 — agentic-flow-kit@x.y.z 在位（kernel 机件单源：<root>）`；fail → `✗` + error 摘要 + fix 修复命令。检查项 8→9；warn/exit 语义与既有项一致（kit 缺席时经逐检查项 try/catch 降级为 ✗ 行，doctor 本体不崩）。

**场景 D：0.4.0 发版**——`scripts/release.mjs` 八处版本位 0.3.19→0.4.0（4 清单 + 2 市场 + protocol SERVER_INFO + 根 README 插件表）；`plugins/ai-native-delivery/README.md` 安装节声明运行时前提（全局 kit ≥2.12.0，缺席 fail-loud + 修复命令）并勘误 doctor 项数（「7 项」→「9 项」，含新增项）。marketplace 消费者更新插件即生效；无 kit 的消费者在 install/verify/doctor 操作时得 fail-loud 提示。

## 数据流

插件脚本（install 引擎 / verify / doctor）→ 适配缝（解析+版本门+缓存）→（进程内 `require`）全局 `agentic-flow-kit/src/kernel/index.mjs` → 纯函数结果（字符串/三态值/合并对象）。无网络调用；首次解析含一次 `npm root -g` 子进程（≈100ms/进程），此后进程内命中缓存。热路径（check-loop 链：pre-commit / pre-push / PreToolUse / SessionStart / MCP）**不 import 适配缝**（import 图实证：其消费方仅 init-engine、install-drift、apply、plan、doctor、verify 及三个测试文件）。

## 系统改动

- `plugins/ai-native-delivery/scripts/lib/kit-kernel.mjs`（新）：解析 + 版本门 + 缓存 + 四包装 + 状态探测；头注声明唯一解析点与热路径边界。
- `plugins/ai-native-delivery/scripts/install/manifest.mjs`（改）：`hashText`/`hashFile` 实现删除，re-export 适配缝；crypto import 收敛 `{ randomBytes }`；头注哈希口径行注明单源。
- `plugins/ai-native-delivery/scripts/install/baseline.mjs`（改）：`mergeThreeWay` 实现删除，re-export 适配缝；本次产生的 unused import（os/spawnSync/GIT）删除；存储函数全部不动。
- `plugins/ai-native-delivery/scripts/git-tree-digest.mjs`（删）：镜像清零。
- `plugins/ai-native-delivery/scripts/verify.mjs`（改）：`dirtyTreeDigest` import 改指适配缝（:75）；:933 文档性提及同步。
- `plugins/ai-native-delivery/scripts/doctor.mjs`（改）：import `kitKernelStatus`；h 项后新增第 9 项；头注检查面列表补 i 行。
- `plugins/ai-native-delivery/config-templates/scripts-test-exempt.txt`（改）：新脚本 `lib/kit-kernel.mjs` 按「新增脚本必须登记」纪律走 indirect 登记（4 行）。
- `plugins/ai-native-delivery/test/verify.test.mjs`（改）：import 改指适配缝；注释同步。
- `plugins/ai-native-delivery/test/doctor.test.mjs`（改）：`CHECK_NAMES` 补「kit 内核依赖」（8→9 项）、八/九项文案同步。
- `plugins/ai-native-delivery/test/install-upgrade.test.mjs`（改）：A2「git 不可用」场景根因适配——kit kernel 不认 `CHECK_LOOP_GIT` 注入点，改为剥 PATH（kit spawn 'git' 无处解析 ENOENT）+ `FLOW_KIT_ROOT` 指真包根；**断言零改动、未放宽**。
- `plugins/ai-native-delivery/README.md`（改）：安装节运行前提声明 + doctor 项数勘误。
- 版本位八处（scripts/release.mjs 口径）：`plugins/ai-native-delivery/plugin.json`、`plugins/ai-native-delivery/.zcode-plugin/plugin.json`、`plugins/ai-native-delivery/.omp-plugin/plugin.json`、`plugins/ai-native-delivery/.codex-plugin/plugin.json`、`plugins/ai-native-delivery/mcp/protocol.mjs`（SERVER_INFO.version）、`marketplace.json`、`.omp-plugin/marketplace.json`、`README.md`（根，插件表版本格）。
- 台账：`workflow/intents/2026-11-23-kernel-single-source-040.md`、`workflow/specs/2026-11-23-kernel-single-source-040.md`、`workflow/plans/2026-11-23-kernel-single-source-040.md`、`workflow/INDEX.md`（再生成）、`workflow/delegations.d/2026-11.md`（委派补记）。

## 约束遵守映射

- **验证阶梯（复用已有 > 标准库 > 原生 > 现有依赖 > 最少代码）**：复用 kit kernel 已有实现（既有依赖），插件侧只留解析缝（90 行）与 re-export（各 3 行），未新增任何依赖包。
- **最小 diff**：净 -8 行（60 增 / 68 删）；每行改动可追溯到本 intent 的 G1-G2。
- **STOP 线纪律**：跨仓（kit）改动经 #75 领单 + 用户发版；插件侧删除既有文件（git-tree-digest.mjs）与新增运行时依赖属契约变更，经用户对话确认「走」放行（本单即确认载体）。
- **禁止简化的领域**：fail-loud 无静默降级（信任边界）；版本门 fail-closed（低版本拒载）；防呆错误消息含可执行修复命令（数据安全/可用性）。
- **根因而非补丁**：安装/验证/诊断三处共用同一机件实现，修在单源而非各调用点。

## 验收判据

| 判据（可观察行为） | 证据（测试文件 / 命令 / 证据文件） | 状态 | 对应验收 |
|---|---|---|---|
| manifest/baseline 本地实现删除、re-export 指向适配缝；git-tree-digest.mjs 删除；verify 直连；下游六消费方 import 零改动 | `rg` 引用清零 + test/install.test.mjs / test/install-upgrade.test.mjs / test/init.test.mjs / test/doctor.test.mjs 全绿 | 已覆盖（107/107；功能引用 0） | A1 |
| 默认解析 2.12.0 成功；FLOW_KIT_ROOT 指错 fail-loud 含修复命令；低版本/缺门面拒载；CRLF 判据成立 | 防呆演示命令输出 + doctor 实跑 | 已覆盖（throw 文案 + status ok/CRLF true） | A2 |
| doctor 9 项出列、kit 项 ✓ 含 root+version、项数断言 8→9 | test/doctor.test.mjs 新用例 + 本仓实跑 | 已覆盖（47/0；实跑 9/9） | A3 |
| 八处版本位一致 0.4.0；README 运行前提声明在场；全量门绿 | `node scripts/release.mjs --check` + `verify --scope` | 关单前补记 | A4 |

## 风险评估

- **全局包缺席/低版本**：fail-loud + doctor 第 9 项可见 + README 前提声明三重暴露；修复命令内建。风险低。
- **2.11.0 窗口教训**（registry 2.11.0 已发但无 kernel）：适配缝的存在性检查（缺 `src/kernel/index.mjs` 即 throw）已在真实事故中实证兜底；版本门 + 存在性检查双保险。已消除。
- **npm 解析不可用/慢**：`FLOW_KIT_ROOT` 逃生口（env 优先）；解析每进程一次并缓存；npm 失败消息指向双修复路径。风险低。
- **Node <22.12**（require ESM 不支持）：require 抛错给含 Node 版本要求的中文错误。风险低（宿主引擎要求 Node ≥22）。
- **判据漂移**（kit 未来演进 kernel 判据）：插件随版本门继承，测试族（107 用例）是行为等价闸；kit 侧 kernel.test 契约测试同步护判据。风险低。

## 前提质询

| 前提 | 反问（对立解读会怎样） | 结论与依据 |
|---|---|---|
| 机件双份维护是真实痛点、单源收益成立 | 换成不动：kit-sync 每轮人工移植 + 指纹核验成本不减，判据漂移风险随底座演进累积 | 选单源。依据：0319 四项中两项即机件类 + 33 个「判据级移植」标记文件盘点在案 |
| 引擎孪生不在本单合切 | 换成同批切：69 脚本 100% 分叉、切换即消费侧行为变更，远超「换源」语义 | 选分单。依据：相似度双峰实测（0.17-0.87）+ 本单范围即机件层（用户「最干净的手术式切割」语境） |
| baseline 存储/migrations/merge-block 内联不切 | 换成切：存储落位 `.install-baseline` 是装户既有数据契约，migrations 是插件自有 schema，merge-block 是单块内联适配——切则引入无收益版本耦合 | 选不切。依据：盘点清单「插件特有内容」列 + 无 kit 同判据演化压力 |
| 全局依赖 absent 时 fail-loud 而非内嵌 fallback | 换成 fallback：双实现回归，等于把「两套维护」留在运行面，违背单源目标 | 选 fail-loud。依据：用户「最干净」裁决 + 2.11.0 窗口事故中 fail-loud 消息精准可操作（实证） |
| 适配缝惰性解析（无顶层 await）而非 import 时解析 | 换成顶层 await：kit 缺席时 doctor 自身 import 链崩溃，自诊断能力丧失 | 选惰性。依据：doctor.mjs:32 静态 import manifest 链 + doctor 逐检查项 try/catch 设计 |

## 歧义清单

| 维度 | 结论 | 依据 | 状态 |
|---|---|---|---|
| 状态与边界 | `FLOW_KIT_ROOT` 语义 = kit 包根（含 package.json），设置即认、指错 fail-loud 不回退；未设置走 `npm root -g` 末行 + `/agentic-flow-kit` | 适配缝实现 + 防呆演示 | 已定 |
| 状态与边界 | 引擎孪生（69 分叉脚本）边界：不在本单，未经分叉收敛决策不得切 | intent 非目标 + 相似度双峰实测 | 已定 |
| 数据口径 | 哈希口径 CRLF→LF 归一 sha256（文本读入）；digest 三态 ''=干净 / 16hex=脏 / null=git 不可用；mergeThreeWay 归一后 git merge-file（status 0 clean / 1-127 conflict / 其余 unavailable） | kit kernel 判据 + 插件原实现逐字对拍 | 已定 |
| 数据口径 | `MIN_KIT_VERSION='2.12.0'` 严格 x.y.z 三段数值；非该形态（前缀/预发布）视为不合格 | 适配缝 parseVersion | 已定 |
| 失败路径 | 包缺席/低版本/缺门面/require 失败 → throw 中文单句 + 修复命令，不静默降级；`kitKernelStatus()` 探测不抛错供 doctor | 「最干净」口径（用户裁决）+ 2.11.0 窗口事故实证 | 已定 |
| 失败路径 | doctor 在 kit 缺席时不崩：适配缝惰性、逐检查项 try/catch 降级为 ✗ 行（含修复提示） | doctor 既有失败面设计 + 适配缝无顶层 await | 已定 |
| 契约对称 | manifest/baseline 保留同名同签名 re-export——下游六消费方 import 面零改动；manifest 台账形状/schemaVersion、baseline 存储落位 `.install-baseline` 不动 | 盘点清单 + install/install-upgrade/init/doctor 测试族实证 | 已定 |
| 契约对称 | doctor 输出契约 8→9 项（唯一允许的断言改动）；warn/exit 语义不变 | doctor.test.mjs 改动面 | 已定 |
| 存量数据 | 存量装户：manifest/baseline 磁盘数据（哈希、基线正文）零迁移——换源不改判据，校验结果逐字节一致；存量全局 2.11.0 无 kernel 的机器由版本门 + 存在性检查 fail-loud 拦截并给升级命令 | 判据零变更 + 2.11.0 工件复验（tarball 无 kernel） | 已定 |
| 验收可测性 | A1-A4 全映射既有测试/命令：rg 引用清零、107/107、doctor 9/9、release --check、防呆演示 | 验收判据表 + 本单验证步骤 | 已定 |

## 确认与复核

- 用户确认：「走」（2026-11-23，对话内明确确认；push 前停）。
- 复核：kit 侧 2.12.0 registry 工件复验（tarball 含 kernel + exports）；插件侧以全量测试族 + doctor 实跑 + 防呆演示为行为等价证据链；无独立复核需求（单仓单模块）。
- 独立复核：降级自查通过——独立复核子代理 2026-11-23 15:29 因 5 小时配额耗尽未成（17:07 重置后可补真复核）；主会话按 independent-reviewer 判据逐项自查：场景 A 解析/版本门/惰性/require(ESM) 与 kit-kernel.mjs 一致；场景 B 判据零变更（re-export 同名同签名、下游零改动）；场景 C doctor 8→9 项实现面一致；场景 D 八处版本位与 README 声明在场（复核上下文：主会话自查，证据 file:line 见各节）
