# 衍生来源声明（NOTICE）

本插件的治理机制移植自 **Shipyard.Material 治理引擎**（内部项目的交付治理引擎），按 Agent Plugins 1.0.0 标准重新打包进 master0071-plugins 市场仓库。

| 项 | 值 |
| --- | --- |
| 机制来源 | Shipyard.Material 治理引擎 |
| 机制基线 | policyVersion 14（源引擎在跑的第 14 版治理政策） |
| 迁移口径 | **只迁机制，不迁运行数据**：confirmations / judgments / verifications / workflow 台账内容 / workflow-runs 一律不迁移；`workflow/` 只迁目录约定与 `_TEMPLATE` 类模板 |
| 资产命名 | 机制资产逐字保真不改名（泳道、硬门段号、台账三件套、命令名等与源项目一致，便于机制文档互认） |
| 许可 | MIT（与本仓库根 [LICENSE](../../LICENSE) 一致） |

## 迁移原则

1. **机制保真**：定级两问、L2 触达面闭集、check-loop 硬门段号（§1 / §3x / §8 / §15 / §23）、台账三件套等机制语义逐字迁移，不重命名、不裁剪语义；仅承载形态从"项目内目录"改写为"插件分发"（清单、垫片、MCP 声明为本仓库新增的打包层）。
2. **运行数据不迁**：源项目的全部运行时数据（判定流水、确认账、验证凭证、台账正文、缓存）不进入本仓库；本插件安装后产生的台账与审计账一律落在**使用项目的 git 仓库根**，与本声明和插件 README 的项目级不变量一致。
3. **脱敏红线**：迁移面过脱敏扫描，不携带源项目的业务上下文（公司专名、内部端点、资源名、人名）；发现即阻断合入。

## 残留词与脱敏裁定

脱敏扫描（2026-10-27 实现收口单元复查）后保留的源项目业务类词（MTO / PML 等；`ygy` 全仓零命中）及其裁定：

- **残留落点**：引擎脚本与配置的头注/注释（`check-ledger-invariant.mjs`、`check-query-contract.mjs`、`quote-grounding.mjs`、`rule-budgets.txt`）、测试夹具类名（`check-regression-consistency.test.mjs` 的 `PMLSubmitGuardTests` / `MTOServiceTests`）、skills 方法论文档（`review-method`、`verify-ui` 及 features/* 验证件）。
- **保留理由**：① 机制沿革——治理机制的判据与豁免表生长自源项目真实事件，抽掉实证词句后叙述不可对质；② 夹具正则联动——测试断言锚定具体类名/实例，换名即削弱判据；③ 技能裁定——`review-method` / `verify-ui` 按「挑通用者迁」随迁，其文档中的业务专名属方法论反例的实证锚，非运行时依赖。
- **裁定**：上述类词均为叙述性/夹具性残留，不构成运行时数据迁移（与「运行数据不迁」红线不冲突）；全量清单与逐条理由见设计文档 `design/ai-native-delivery.md` §12.4。不迁移的源项目技能（interrogate / blast-radius / tfs-pr）见同节 §12.3。

## 2026-10-27 二次脱敏（市场审查发现，已按红线 3 清除）

首轮脱敏漏掉了 `skills/verify-ui` 里的三处，均属红线 3 明令「发现即阻断合入」的个人数据与产品内部实现，已从分发包移除：

| 残留 | 原形态 | 处置 |
| --- | --- | --- |
| 真实人名 ↔ 内部工号绑定 | `features/mto-change-edit-drawer.md` 列出三个可过「本人创建」门的账号（工号与姓名成对） | 删除具体账号，改写为「见项目侧记录」并保留取号方法 |
| 登录接口与身份字段名 | 两处验证件与 `SKILL.md` 写明了源产品登录接口的完整路径、响应身份字段名及前端会话存储的键名 | 改为「你所测产品自己的登录响应 / 该产品前端的会话存储」，方法保留、实现名移除（本表不复述被移除的具体名字） |
| 鉴权绕过披露 | `SKILL.md` 声称自造 `header.payload.sig` 注入即可过源产品的会话校验 | 删除该做法与相关 store 内部实现；仅保留真正通用的教训（`exp` 取远端会因 `setTimeout` 的 int32 溢出立即登出） |

**仍保留**（属方法论实证锚，不含个人数据与凭证）：源产品路由（`/mto-orders` 等）、内部 commit 短 SHA（`5e4c41bc`、`803029f3` 等）、`features/*.md` 19 份源产品界面地图、`verify.mjs` 门表中的源产品构建命令。

**已解决（2026-10-28）**：`verify.mjs` 的 `frontend-lint` / `frontend-unit-test` / `frontend-build` / `backend-build`（`dotnet build App.sln`）/ `backend-test` 五条产品门补齐 `requires` 判据，加上 E2E 条件门共六条——所需项目侧路径不在即判「不适用」SKIP 并显式出账，跳过沿依赖边传播（`backend-build` 跳过 → `backend-test` 同步跳过，不再产生「无产物却照跑」的假红）。产品段"每门必带 optional 或 requires"与"跳过传播"两条不变量由 `test/verify.test.mjs` 场景 15 锁定。消费项目空仓实测：6 门全部 SKIP，无真跑产品门。

**建议后续**：`features/` 是源产品的界面地图，对消费项目无复用价值且暴露内部路由与提交历史。推荐随包只发一份 `features/_TEMPLATE.md`，由 `skills/verify-ui/scripts/gen-verify-feature.mjs --route <path>` 在使用项目里生成自己的地图；该删减动作影响面较大，留给 owner 执行。

**已执行（2026-10-29）**：上一段的建议已落地——19 份 `features/*.md` 源产品界面地图已从分发包移除（含本段所列的内部路由与 commit 短 SHA），只保留一份 `_TEMPLATE.md`；「仍保留」清单中的 `features/*.md` 一项随之作废，`verify-ui` SKILL.md 的选点说明改指项目侧地图目录。残留的注释类词（MTO / PML 等机制沿革叙述）不在本次裁剪面，理由见上方「残留词与脱敏裁定」。

## 上游许可的可核实性（2026-10-29 市场审查补注）

上表「许可 MIT」的裁定依据是源引擎随附的内部许可声明，但 **Shipyard.Material 为内部项目，没有公开仓库、公开版权声明或可外部核实的上游链接**——第三方审阅者无法像 pstack 的 NOTICE 那样对到一条公开 commit。如实标注这一点而非维持「可核实」的假象：

- 机制代码（check-loop 各段、确认门、verify 门表）的**原始作者**是源引擎团队，本仓库按 MIT 再分发并保留其机制语义；
- 若源引擎的权利人对该分发有异议，或能提供可公开引用的上游许可文本，以权利人声明为准修订本节；
- 本仓库对打包层（清单、垫片、hook 的 node 重写、文档）的改写属自有作品，见仓库根 LICENSE。

## 有意偏离源项目的命名（2026-10-28）

源项目的 `show-me-your-work` skill 在本插件中更名为 **`decision-log`**。原因是市场级重名而非机制需要：同市场的 pstack 插件已提供同名 skill，且实现不同（`log.sh` + bash/perl vs 本插件的 `decision-log.mjs` + Node）。扁平命名空间下两者会互相覆盖，或第二个插件被安装器拒绝；无论谁赢，另一个插件的内部流程都会静默失去留痕步骤——而这些流程正是无人值守长跑，丢了发现不了。

机械面保持不变：六参数 CLI、TSV 表头（`ts/phase/decision/why/evidence/result`）、append-only 语义、模板文件均与源项目一致，历史 `decisions.tsv` 可直接沿用。机制语义未改写，仅调用名变更。

**同步注意**：从源引擎再次同步该 skill 时勿把目录名与 frontmatter `name` 改回 `show-me-your-work`，否则重名会复现。市场级检查 `scripts/manifest-lint.mjs` 现已断言「skill 名跨插件唯一」与「name 必须等于目录名」，该偏离由机器守住。
