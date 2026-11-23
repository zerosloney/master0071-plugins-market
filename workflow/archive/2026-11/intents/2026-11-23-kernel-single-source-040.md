---
状态: done
级别: L2
日期: 2026-11-23
模块: engine
备注: kit#75 领单产物随 2.12.0 首发；机件层切割（引擎孪生上收不在本单）
确认指纹: 2497b56f3e2b8c87
---
# INTENT — 内核单源化：机件（hash/digest/mergeThreeWay）经 agentic-flow-kit kernel 门面复用（0.4.0）

<!-- 复制本模板为 YYYY-MM-DD-<主题>.md 后填写；plans/ 下同名文件与本文件配对 -->
<!-- frontmatter 受限子集（2026-09-13）：每行 键: 值；状态∈draft/approved/done/superseded/cancelled（严格枚举，附注写备注键）；级别∈L1/L2/L3；check-loop 只扫 frontmatter 取机器字段，正文不再写状态/级别行 -->

## 背景与问题

- 来源：用户对话 2026-11-22「AI 交付治理插件与 agentic-flow-kit 同源，代码要维护 2 套——如何让插件版内核用已经安装的（npm install -g agentic-flow-kit@latest）包」→「我要最干净的手术式切割」→ 2026-11-23「走」。
- 问题本质：插件机件（安装台账哈希 / 升级基线三方合并 / 脏树摘要）长期以「判据级移植」双份维护，每次底座演进靠人工 kit-sync 工单同步；2.10.8 同步四项（0319 单）中两项即机件类——脏树摘要（BACKLOG 34）与 gitignore 块幂等（#68）。判据漂移风险随每次同步累积，且工单成本不可压缩。
- 解法定锚：kit 侧 issue #75 领单——kernel 门面（`exports ./kernel` + hashText/hashFile/dirtyTreeDigest/mergeThreeWay 四函数 + 契约测试），随 **2.12.0** 首发 registry；插件侧以单一适配缝 `scripts/lib/kit-kernel.mjs` 复用，删除 `git-tree-digest.mjs` 镜像，manifest/baseline 两文件保留同名 re-export（下游 import 零改动）。
- 程序如实备注：手术首轮在 kit 仓越序直改工作树（未经领单），经用户裁决纠正——补登 #75、未推送 commit 从历史摘除、kit 领单重做并发 2.12.0；本台账为事后立账，记录过程不美化。

## 历史教训/防复发

- 2026-11-20 kit-sync-0319（0.3.19）是「手工判据级移植」模式的最后一轮机件类工单；本单后机件判据演进只改 kit 一处，插件经版本门自然继承，该类同步绝迹。
- 治理教训（2026-11-22）：跨仓改动以 issue 领单制为前置确认门；AI 会话内确认门未获明确答复不视作批准。kit#75 事后补登即纠偏动作。

## 目标

- G1 四机件单源：hashText/hashFile/dirtyTreeDigest/mergeThreeWay 唯一定义在 agentic-flow-kit kernel；插件侧零本地实现（re-export / 直连）。
- G2 单点解析与版本门：适配缝唯一解析点（`FLOW_KIT_ROOT` > `npm root -g`），`MIN_KIT_VERSION=2.12.0`，缺席/低版本 fail-loud 中文修复提示，惰性解析 + 进程内缓存。
- G3 doctor 面同步：新增第 9 项「kit 内核依赖」（机器级，不依赖项目根）；检查项 8→9。
- G4 0.4.0 发版：版本位八处一致 + 插件 README 声明运行时前提（全局 kit ≥2.12.0，缺席 fail-loud）。

## 非目标（L1 微改动无实质内容可删本节，不硬填）

- 引擎孪生上收（69 个分叉引擎脚本经 `flow-kit run` 委托）——需先做分叉收敛决策（相似度双峰实测在案），独立战略单，不在本单。
- baseline 存储面 / migrations 链 / merge-block 内联判据——插件自有契约（存储落位 `.install-baseline`、静态迁移注册表、单块适配），无 kit 同判据演化压力，本单不切。
- kit 内部 install 链路迁移到 kernel 门面——kit 侧另行工单（#75 正文已声明）。

## 约束（L1 微改动无实质内容可删本节，不硬填）

- fail-loud 无降级：全局包缺席/低版本时抛错并给修复命令，不提供静默 fallback（「最干净」口径，用户裁决）。
- 判据零变更：kernel 判据与插件现行逐字一致（CRLF→LF 归一哈希 / 三态摘要 / 归一三方合并）；本单是换源不是改判据。
- 跨仓纪律：kit 侧改动一律经 #75 领单；本单不触碰 kit 仓。

## 影响面

- 装户面：`scripts/lib/kit-kernel.mjs`（新）、`scripts/install/manifest.mjs`、`scripts/install/baseline.mjs`、`scripts/git-tree-digest.mjs`（删）、`scripts/verify.mjs`、`scripts/doctor.mjs`、`config-templates/scripts-test-exempt.txt`、`test/verify.test.mjs`、`test/doctor.test.mjs`、`test/install-upgrade.test.mjs`、版本位八处（release.mjs 口径）、`plugins/ai-native-delivery/README.md`（运行前提 + doctor 项数勘误）。
- 消费方零改动实证：init-engine / install-drift / apply / plan / doctor 及测试对 manifest/baseline 的 import 面全部不变（re-export 同名同签名）。
- 热路径结论：check-loop 链（pre-commit/pre-push/MCP）不经适配缝；适配缝消费方仅 install 引擎、verify、doctor 三类冷路径 + 三个测试文件。

## 触达红线（对照 AGENTS.md，勾选仅标记触及范围；具体如何满足在同名 spec 或 Quick-Plan 中说明）

- [x] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2
  - 命中依据：①新增运行时依赖——全局 `agentic-flow-kit ≥2.12.0`，缺席 fail-loud，属插件对外契约变更（marketplace 消费者前提）；②doctor 输出契约变更——检查项 8→9；③机件函数实现换源（共享口径从插件本地迁到 kit 单源）。受影响消费方 ≥2 → L2 成立
- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3
  - 不命中依据：无 DB schema / 迁移 SQL / DI / 认证管线；install-manifest schemaVersion 与迁移链零改动

> 触及任一红线即为 L2 / L3，必须立 ../specs/YYYY-MM-DD-<主题>.md 写明如何满足，方可起草 plan。

## 验收标准（可测试）

- [x] A1 四机件单源：manifest/baseline 本地实现删除、re-export 指向适配缝；`git-tree-digest.mjs` 删除；verify.mjs 直连；下游消费方 import 零改动；`rg` 镜像实现与 `git-tree-digest` 功能引用清零（证据：89 套件 107/107 绿；豁免表仅 1 行历史注记，功能引用 0）
- [x] A2 适配缝门禁：默认 `npm root -g` 解析成功；`FLOW_KIT_ROOT` 指错 fail-loud 中文修复提示；版本低于 2.12.0 拒载；`hashText('a\r\nb')===hashText('a\nb')` 全路径成立（证据：防呆演示 throw 文案含修复命令；status {ok:true,version:"2.12.0"}；CRLF 对拍 true）
- [x] A3 doctor 第 9 项：9 项全 ✓ 形态（健康仓）；`✓ kit 内核依赖 — agentic-flow-kit@2.12.0 在位`；项数断言 8→9 同步（证据：本仓实跑 9/9 全通过；doctor.test.mjs 47/0）
- [x] A4 0.4.0 发版：`release --check` 八处一致 0.4.0；plugin README 运行前提声明在场；全量门绿（证据：release --check 八处一致 0.4.0；README 运行前提 + doctor 项数勘误已入 10584cc；verify --scope 13 门全绿（墙钟 7.9s，绿凭证 19 行已落账）；全量 89 套件 107/107）

> **闭环对账**：关单在 test 阶段（不依赖 deploy）。intent 置 done 前逐条勾验，每条补证据——`- [x]` 行缺证据视为未验。

## 确认与复核

- 用户确认：「走」（2026-11-23 对话内明确确认 0.4.0 发行全流程；push 前停——外发动作留用户终审）。
- 复核：kit 侧经 #75 领单独立落地（2.12.0 registry 工件复验：tarball 含 kernel + exports）；插件侧单仓单模块（engine 机件面），无跨模块独立复核需求。
- 独立复核：降级自查通过——独立复核子代理 2026-11-23 15:29 因 5 小时配额耗尽未成（17:07 重置后可补真复核）；主会话按 independent-reviewer 判据逐项自查：spec 场景 A-D 与实现一致、判据零变更、下游零改动、版本位八处一致（复核上下文：主会话自查，证据见 spec 验收判据表 A1-A4）
