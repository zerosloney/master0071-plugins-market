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
