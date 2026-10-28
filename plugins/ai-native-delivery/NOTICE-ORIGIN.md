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

**待决（需 owner 定案，非脱敏问题）**：`verify.mjs` 的 `frontend-lint` / `backend-build`（`dotnet build App.sln`）/ `backend-test` 三条产品门**未标 `optional`**——只有 `wiki-consistency` 有。消费项目装上即得三条红门，而插件承诺的是"装上即得"。建议给门表加 `requires: <路径>` 判据（缺 `App.sln` / `frontend/` 即 SKIP），复用已测试过的 `optionalGateMissing` 语义；本条因 `verify.mjs` 正处迁移改造中而未一并改动。

**建议后续**：`features/` 是源产品的界面地图，对消费项目无复用价值且暴露内部路由与提交历史。推荐随包只发一份 `features/_TEMPLATE.md`，由 `skills/verify-ui/scripts/gen-verify-feature.mjs --route <path>` 在使用项目里生成自己的地图；该删减动作影响面较大，留给 owner 执行。
