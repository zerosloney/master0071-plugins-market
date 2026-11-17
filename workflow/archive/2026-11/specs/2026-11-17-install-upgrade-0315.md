---
状态: done
级别: L2
日期: 2026-11-17
模块: infra
备注: 关联 ../intents/2026-11-17-install-upgrade-0315.md（approved 2026-11-17，指纹 929baeabcc24c948）
确认指纹: 7f8e1aef2ac06a3a
---
# SPEC — 装户升级面：基线三方合并 + manifest 迁移框架 + 漂移视图 + prune（0.3.15）

<!-- 与 intents/ 下同名入口文档配对；L2/L3 必须先有 ../intents/YYYY-MM-DD-<主题>.md approved -->
<!-- frontmatter 受限子集（2026-09-13）：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->

## 功能行为

**场景 A：使用项目重复初始化（升级传播，现状已有，本单不改变）**——种子未变、项目未动 → 全 skip，台账字节不动（幂等契约）；种子变、文件未动 → update 自动落盘（0.1.19 通道）。

**场景 B：用户改过的文件遇种子升级（本单新增 merged 出口）**——init-engine 裁决到「目标≠台账 && 种子≠台账」时（现 conflict-skip 分支），若条目非 mutable 且基线存在：`git merge-file -p -q -L current -L baseline -L kit <ours> <base> <theirs>`（base=基线正文、ours=盘上正文、theirs=新种子正文）：
- clean（退出码 0）→ 落盘合并结果 + 台账记新哈希 + 基线写**新种子正文**（非合并结果——kit 蓝本 baselineText 同款：基线=工具已知的种子形态，用户在合并结果上的后续手改仍可与下一轮种子演进再合并），报告行进「合并」清单；
- conflict（1–127）→ 维持 conflict-skip 语义与输出不变（`--force` 仍整覆盖）；
- unavailable（>127 / git error / spawn 失败）→ 回退 conflict-skip，不炸不拦；
- 基线缺失（存量项目首升、尚未积累基线）→ conflict-skip（现状兜底）。

**githook 条目旁路 merged 通道**：钩子正文渲染时烘焙本机插件路径（@@ENGINE_SCRIPT@@ 实化），三方合并无意义且可产出指向失效路径的合并钩子——钩子裁决维持现状路径零改动（含陈旧自装钩子覆盖刷新例外），基线面与 prune 通道均不含钩子条目（孤儿钩子只报告、不自动删，防本地门禁面被静默拆除）。`--force` 优先于合并：显式覆盖时不尝试 merge。

**场景 C：manifest 版本化**——台账增 `schemaVersion`（当前 1）。**新建（create 首账）与领养（adopt）构造台账即带 `schemaVersion: CURRENT_SCHEMA_VERSION`**（kit emptyManifest 同款）——首装项目无迁移可跑、二次跑台账字节不动。读取：缺字段视作 0（向后兼容，存量台账不因此单独重写）。init-engine 每次运行先过迁移链 `scripts/install/migrations/<from>-<to>.mjs`（0→1 起步 = 补 schemaVersion:1 的 normalize 迁移）：全链成功才写、任一步失败零落盘、台账版本高于支持拒绝（exit 非零）。迁移只转换 manifest，不碰用户文件。

**场景 D：漂移体检（只读）**——`node <插件根>/scripts/install-drift.mjs [--root <仓库根>]`：一次输出六类分类 + 计数汇总——unchanged（三方一致）/ user-modified（用户改、种子未变）/ seed-updated（种子变、可自动 update）/ merge-needed（双方都改、基线在场可试合并）/ orphan（台账有、种子清单已无）/ missing（台账有、盘上无）。**mutable 条目恒归 unchanged**（存在即在位、不比对哈希，doctor 只核存在性先例）；**台账缺失/损坏**（= 未初始化或领养前形态）→ 输出一行「无台账——先跑 init-engine」恒 exit 0，不误报 orphan/missing。只读、恒 exit 0、不落任何文件。

**场景 E：prune（显式才删）**——`init-engine.mjs --prune`（可叠加 `--dry-run`）：不带 `--prune` 永不删任何文件；`--prune` 真删、`--prune --dry-run` 只出报告（intent 括号句「不带 --dry-run 才真删」即此操作语义）。删除条件：台账登记 && 当前种子已无 && 盘上哈希==台账哈希 && 非钩子条目（mutable 条目无哈希 → 保留并报告；用户改过 → 保留并报告；孤儿钩子 → 只报告不删）；连带清台账孤儿行与无主基线。**钩子条目识别口径**：台账键 basename ∈ 已知钩子名单（pre-commit / pre-push / post-commit / commit-msg）∪ hooksDir 解析前缀命中，二者任一即视为钩子——worktree/core.hooksPath 下键可为 `../..` 形态、跨盘极端退化为绝对路径（plan.mjs 头注口径），仅按前缀匹配会漏、漏网键进哈希比对通道即被删——**宁保留不删**，识别不了的键按钩子处理只报告。

**边界与异常**：git merge-file 缺席/异常 → unavailable 降级；台账损坏/缺失 → 领养模式（现状，不动）；二进制扩展名防御性跳过基线（插件种子全文本）；mutable 条目全程旁路合并/基线/prune 通道。

## 数据流

init-engine CLI（或 MCP doctor 只读面）→ buildPlan（种子清单 + 排除口径，现状）→ readManifest（缺 schemaVersion→0）→ migrateManifest（0→1，changed 且非 dry-run 才写，原子写；新建/领养台账构造即带 schemaVersion，无迁移可跑）→ applyPlan 逐条裁决 [create / update / conflict-skip / merged / adopt / skip]（merged 新增，钩子条目旁路；create/update/merged-clean 后 writeBaseline，基线=新种子正文）→ writeManifestAtomic（tmp+rename）→ 文本报告（新增「合并 N 项」与 prune 清单行）。

install-drift.mjs：种子清单 ∪ 台账 files ∪ 盘上存在性 → 纯函数分类（mutable 恒 unchanged；无台账单行提示）→ stdout，零写盘。

prune：台账 files − 种子清单 − 钩子条目 = 孤儿候选 → 哈希比对 → unlink + 清台账行 + pruneBaselines（向上清空目录）。

**持久化面**：`.agents/install-manifest.json`（+schemaVersion）；`.agents/.install-baseline/`（新增，本机不入库——进 init-engine gitignore 标记块）；无服务/表/缓存/第三方调用（git merge-file 为本地子进程，同 kit 判据）。

## 系统改动

| 模块/文件 | 动作 | 内容 |
|---|---|---|
| `plugins/ai-native-delivery/scripts/install/baseline.mjs` | 新增 | 基线读写/清无主/向上清空目录/mergeThreeWay（判据级移植 kit src/install/baseline.mjs：路径改 `.agents/.install-baseline/`、BINARY_EXT 防御保留、退出码三分 clean/conflict/unavailable；基线面不含钩子条目） |
| `plugins/ai-native-delivery/scripts/install/migrations.mjs` | 新增 | 单向迁移链框架（`<from>-<to>.mjs` 导出 {from,to,migrate}；全链成功才写；超前拒绝；migrate 只转 manifest） |
| `plugins/ai-native-delivery/scripts/install/migrations/0-1.mjs` | 新增 | 首个迁移：补 schemaVersion:1（normalize） |
| `plugins/ai-native-delivery/scripts/install/manifest.mjs` | 修改 | CURRENT_SCHEMA_VERSION=1；readManifest 容忍缺 schemaVersion；台账构造（新建/领养）即带 schemaVersion |
| `plugins/ai-native-delivery/scripts/install/apply.mjs` | 修改 | conflict 分支插 merged 出口（非 mutable + 非钩子 + 基线在场才试 merge；merged-clean 基线写新种子正文）；create/update/merged-clean 后写基线；init 流程接迁移链 |
| `plugins/ai-native-delivery/scripts/init-engine.mjs` | 修改 | `--prune`/`--dry-run` 接线（prune 旁路钩子条目）；报告新增合并/prune 清单；gitignore 标记块加 `.agents/.install-baseline/` 条目 |
| `plugins/ai-native-delivery/scripts/install-drift.mjs` | 新增 | 六类只读漂移分类 + 汇总（mutable 恒 unchanged；无台账单行提示） |
| `plugins/ai-native-delivery/config-templates/scripts-test-exempt.txt` | 修改 | 4 个新脚本 indirect 登记指向 test/install-upgrade.test.mjs（同 install/ 三件先例）；本仓 `.agents/config/` 运行份随自举升级传播 |
| `plugins/ai-native-delivery/test/install-upgrade.test.mjs` | 新增 | merge 三路径/mutable+钩子旁路/迁移链（含首装即带 schemaVersion 二次跑字节不动）/幂等/drift 六类（含 mutable/无台账）/prune 四态（含钩子只报告）用例 |
| `plugins/ai-native-delivery/test/install.test.mjs` | 修改 | 既有契约用例零改动全绿（回归底线） |
| `plugins/ai-native-delivery/README.md` | 修改 | 装户节补升级/合并/漂移/prune 口径 |
| `.agents/config/rule-budgets.txt` | 不动 | 现有预算面无一覆盖 `plugins/ai-native-delivery/scripts/*`（本单无对应预算行管辖）；intent「rule-budgets 棘轮」约束以 check-script-coverage 对账满足（新脚本经 exempt indirect 行入账） |
| 版本位（release.mjs 八处） | 修改 | 0.3.15（markets×2 + 插件清单×4 + mcp/protocol.mjs SERVER_INFO + 根 README；intent「七版本位」为笔误，以本表八处为准） |

## 约束遵守映射

本仓无根/目录级 `AGENTS.md`；对照 intent §约束 与引擎既有红线逐条回应：

- **零运行时依赖底座**：不 import / 不 spawn agentic-flow-kit；mergeThreeWay 只调本机 git（判据级移植，先例 doctor.mjs/装户层）→ 满足。
- **幂等契约（重复跑零改动）**：迁移链 changed 才写；新建/领养台账构造即带 schemaVersion（首装无迁移可跑）；merged/update/create 后基线与台账落定，二次跑全 skip；mtime 快照测试口径不变 → 满足（场景 A/C）。
- **mutable 条目语义（mutable-ledger-semantics 判据）**：合并/基线/prune/drift 通道前置 mutable 检查旁路（drift 恒 unchanged）；用例断言零变化 → 满足。
- **git hooks 安装语义不动（intent 明文红线）**：merged/基线/prune 通道全部旁路钩子条目；applyHook 裁决路径零改动（init.test.mjs「不覆盖」断言钉住）；孤儿钩子只报告 → 满足。
- **台账入库共享 / 三本审计账 append-only 不碰**：本单只动 install-manifest.json（lock 语义）与新增基线目录（本机）；confirmations/judgments/verifications 零接触 → 满足。
- **门禁/CI/init 零模型**：全链无模型调用 → 满足。
- **CRLF→LF 归一口径**：种子/盘上/基线/merge 三方 IO 全链同口径，Windows autocrlf 不假冲突 → 满足。
- **领养兜底不动**：台账缺失/损坏 → 领养（现状记账不覆盖），合并通道不改变该方向；领养构造的台账即带 schemaVersion → 满足。

## 验收判据

| 判据（可观察行为） | 证据（测试文件 / 命令 / 证据文件） | 状态 | 对应验收 |
|---|---|---|---|
| 用户改动+种子升级并存 → merge-file clean 落盘、台账 update、基线写新种子正文 | test/install-upgrade.test.mjs（用例：merge clean 路径） | 覆盖（A1 组 14 断言） | A1 |
| merge conflict → conflict-skip 输出不变；git 缺席 → 回退 skip；--force 仍整覆盖且优先于合并 | test/install-upgrade.test.mjs（用例：conflict/unavailable/force） | 覆盖（A2 组 9 断言） | A2 |
| mutable 条目与 githook 条目均不进合并/基线/prune 通道，行为与现状逐字节一致 | test/install-upgrade.test.mjs（用例：mutable/钩子旁路）+ test/install.test.mjs 既有 mutable 用例全绿 | 覆盖（A3 组 8 断言 + 既有 56/0） | A3 |
| 迁移链 0→1 全链成功才写；注入失败零落盘；schemaVersion 超前拒绝；首装即带 schemaVersion 二次跑台账字节不动 | test/install-upgrade.test.mjs（用例：迁移三态 + 首装幂等） | 覆盖（A4 组 13 断言） | A4、A5 |
| 重复跑 init-engine 台账字节不动（旧无 schemaVersion 台账二次跑起不动） | test/init.test.mjs + test/install.test.mjs（mtime 快照）+ test/install-upgrade.test.mjs（幂等用例） | 覆盖（三套 pass 3/0 + A5 组 6 断言 + 自举三次跑 sha256 一致） | A5 |
| install-drift.mjs 六类各 fixture 断言正确；mutable 恒 unchanged；无台账单行提示恒 exit 0；只读零写盘 | test/install-upgrade.test.mjs（用例：drift 六类 + 边界） | 覆盖（A6a 组 15 断言） | A6 |
| prune：哈希一致才删、改过/mutable/钩子保留、--dry-run 只报告、不带 --prune 零删除 | test/install-upgrade.test.mjs（用例：prune 四态） | 覆盖（A6a 组 15 断言） | A6 |
| verify.mjs --scope 全绿 + check-script-coverage 过（exempt indirect 四行生效）+ rule-budgets 线内 | `node plugins/ai-native-delivery/scripts/verify.mjs --scope` 输出 | 覆盖（verify --scope 13 门全绿输出） | A7 |
| 本仓自举升级走查：--dry-run 报告合理后真跑，本仓台账/基线落定 | .agents/install-manifest.json（schemaVersion:1）+ 走查输出存证 | 人工（已走查：dry-run 报告经用户放行后真跑，update 通道传 exempt、双改无基线 2 项保留、三次跑台账字节一致） | — |

## 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| 语义冲突被 git 判 clean（机器合上了、语义错） | 中 | merged 清单显式出报告行（用户可见每处合并）；drift 视图可体检；种子面以人读配置文档为主，语义冲突面小；--force/手动改回路径不变 |
| 存量项目首升无基线 → 合并通道空转（仍 conflict-skip） | 低 | 属预期兜底非缺陷；本轮 create/update 后开始积累基线；README 说明 |
| 迁移链写失败半态 | 低 | 全链成功才写 + writeManifestAtomic（tmp+rename）；失败零落盘用例钉住 |
| 本仓自举真跑破坏本仓台账 | 中 | 先 --dry-run 走查、git 可回滚；自举走查进验收（人工项） |
| 基线目录膨胀 | 低 | 文本量小；prune 清无主基线；gitignore 不入仓 |

## 前提质询

| 前提 | 反问（对立解读会怎样） | 结论与依据 |
|---|---|---|
| 合并默认开启：clean 即自动落盘（与 update 通道对称），非「只报告、人工确认后落盘」 | 换成只报告：每次升级逐文件手工套用，等于没解决 conflict-skip 痛点，且与 update 自动落盘不对称 | 选默认落盘。依据：0.1.19 update 通道已自动传播（先例）；kit apply 五态同款 clean→写；merged 清单显式可见保留可追责性 |
| 基线口径：本机不入库（进 gitignore 标记块）+ merged-clean 后写**新种子正文**（非合并结果） | 换成入库：多人协作时他人基线与本地盘上正文错位（merge base 失配）→ 假合并；换成写合并结果：用户改动被 base 吸收，后续种子演进对这些行的差异不再显式可辨，且与 kit 蓝本 baselineText 分叉 | 选本机不入库 + 写新种子正文。依据：基线语义=「本机上一次由工具写入的种子正文」（本机性是正确性前提，kit BASELINE_DIR 同款默认忽略）；基线内容 kit src/install/apply.mjs baselineText=text（新模板）同款，用户后续手改仍可从 ours 侧进入下一轮合并 |
| 不设 upgrade 独立子命令：init-engine 单入口即安装即升级 | 换成分命令：两入口两套裁决语义，面翻倍；kit 分离源于安装器形态（多宿主/多栈重放），插件无此形态 | 选单入口。依据：intent 非目标已排除（用户确认的承诺面）；0.1.19 起单入口先例 |
| 迁移 changed 即写台账（含旧台账首次补 schemaVersion:1 的一次性字节变更），非「等下次自然写」 | 换成等自然写：漂移视图/后续迁移每次读到缺字段都视作 0 重跑链，状态不收敛 | 选 changed 即写。依据：kit migrateManifest changed&&!dryRun→writeManifest 同款；一次性升级写不违反「重复跑零改动」（第二次起不动，用例钉住） |
| prune 为显式 flag（不带永不删），非「init 顺带自动清理」 | 换成自动删：init 语义从「装」扩为「装+删」，误删孤儿文件（如项目有意保留的旧种子改）风险不对称 | 选显式 flag。依据：intent 目标原文「--prune」+ 哈希一致才删的保守判据；kit prune 亦为独立显式命令 |

## 歧义清单

| 维度 | 结论 | 依据 | 状态 |
|---|---|---|---|
| 状态与边界 | 裁决六态：create/update/conflict-skip/**merged**/adopt/skip；merged 仅在「非 mutable + 非钩子 + 基线在场 + 双方都改」时尝试；--force 优先于合并 | apply.mjs 现四态 + 本 spec 场景 B 插入点 | 已定 |
| 状态与边界 | prune 读法取操作语义：`--prune` 真删、`--prune --dry-run` 只报告、不带 `--prune` 永不删（intent 括号句「不带 --dry-run 才真删」即此义） | intent 目标第 5 条原文 + 本 spec 场景 E | 已定 |
| 数据口径 | 哈希与正文 IO 全链 CRLF→LF 归一（种子/盘上/基线/merge 三方）；基线存种子正文（钩子条目不入基线面） | manifest.mjs hashText 先例；intent 防复发 #1；场景 B 基线口径 | 已定 |
| 失败路径 | git 缺席/merge-file >127 → unavailable → conflict-skip 降级；迁移任一步失败零落盘；台账写恒 tmp+rename | kit mergeThreeWay 退出码三分 + writeManifestAtomic | 已定 |
| 契约对称 | manifest +schemaVersion 向后兼容（旧读作 0；新建/领养即带 1）；mutable 与钩子旁路；--force/领养/adopt 语义不变；不带 --prune 与现状逐字节一致 | 幂等契约 + mutable-ledger-semantics 判据 + kit emptyManifest | 已定 |
| 存量数据 | 已装项目（有台账无基线）首升维持 conflict-skip，本轮起积累基线；本仓自举台账同路径走查 | 领养/兜底语义不动；验收人工项 | 已定 |
| 验收可测性 | 全部判据映射 test/install-upgrade.test.mjs 用例 + verify --scope（exempt indirect 四行保 coverage 对账）；自举走查单列人工项 | 验收判据表 9 行 + scripts-test-exempt 先例 | 已定 |

## 确认与复核

- 确认日期：
- 复核：L2 → 独立复核（independent-reviewer，独立子智能体）；落盘行：
- 独立复核：通过——上轮 3 项 P1 / 6 项 P2 全部修订到位（9/9 对照核验成立，修订未引入新矛盾）；残余 2 项 P2 不阻断（rule-budgets 棘轮目标线未指认、prune 钩子键识别口径未定义），建议实现期同批收口（复核上下文：independent-reviewer 独立子代理会话 2026-11-17 第二轮；reviewed by GLM-5.3-Flash）
- 主智能体注：两项残余 P2 已于 spec 期按复核者建议文案收口——①rule-budgets 行改为「不动 + 无对应预算面声明」（系统改动表）；②prune 钩子键识别口径写死「basename ∈ 钩子名单 ∪ hooksDir 前缀命中，宁保留不删」（场景 E）。

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「系统改动」的模块/文件分组，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
