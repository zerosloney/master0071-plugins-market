# 当前生效规则视图（生成物，勿手改）

> 生成器 `node <插件根>/scripts/gen-effective-policy.mjs`（policy.mjs 单源渲染；漂移由 verify.mjs `effective-policy` 门 --check 把关——改 policy 后须重生成并随同提交）。
> 当前生效：**policyVersion 16**（engine.json 声明 16）；视图日期 2026-11-13。

| 锚键 | 生效日/锚 | 消费检查项 | 语义 | 分级 | 现状 |
|---|---|---|---|---|---|
| `moduleSince` | 2026-09-22 | 检查 12 | frontmatter「模块:」枚举合法性 | advisory | 已生效 |
| `check14Since` | 2026-09-23 | 检查 14 | 新 done 的 spec/plan 须有 approved git 历史——advisory 生效锚 | advisory | 已生效 |
| `confirmDocsEffective` | 2026-10-06 | 检查 15 | docs 确认台账两条件准入（台账行 ∪ 自报日期≥锚） | hard | 已生效 |
| `confirmIncidentsEffective` | 2026-10-06 | 检查 15 | incidents 档确认阈值（fixed/closed 配对） | hard | 已生效 |
| `bindingTs` | 2026-09-28 | 检查 15 | 四终态内容绑定（台账行 ts≥锚 才比对 sha256） | hard | 已生效 |
| `delegationSince` | 2026-10-06 | 检查 18 | 委派台账对账——锚前存量豁免 | advisory | 已生效 |
| `verifySince` | 2026-10-07 | 检查 8 | 测试绿声明对账（无 SHA 声明「测试绿」须 24h 内凭证）+ confirm-doc →done 前置 | advisory | 已生效 |
| `incidentRegrSince` | 2026-10-09 | 检查 3 | 防复发验证证据门（fixed/closed 须落自动化用例/回归清单引用） | hard | 已生效 |
| `specVerifSince` | 2026-10-09 | 检查 21 | spec 验证落地核查（L2/L3 done 的验证计划须引用测试文件/命令） | advisory | 已生效 |
| `check14HardSince` | 2026-10-10 | 检查 14 | 同上——锚日起升 hard-block | hard | 已生效 |
| `verifyHardSince` | 2026-10-10 | confirm-doc | →done 测试绿凭证——锚日起升 hard（拒无凭证关单） | hard | 已生效 |
| `attributionSince` | 2026-10-11 | 检查 24 | incident 归因字段（来源/影响环境 枚举存在性与合法性）——锚前存量豁免 | advisory | 已生效 |
| `convergenceSince` | 2026-10-11 | 检查 23 | 判据级收敛对账（L2/L3 done spec 验收判据表逐条对证据——完成声明不是证据）——锚前存量豁免 | advisory | 已生效 |
| `convergenceHardSince` | 2026-10-12 | 检查 23 | 同上——证据无效升 hard（命令须有不早于 spec 日期的 verify-evidence 全绿行；路径只认存在） | hard | 已生效 |
| `reviewerSince` | 2026-10-12 | 检查 1 | 独立复核上下文标识（复核行须含「复核上下文：<会话/子代理 id>」——独立性声明可证伪化）——锚前存量豁免 | advisory | 已生效 |
| `clarifySince` | 2026-10-22 | — | （未登记消费方——policy 加新键时同步登 CONSUMERS） | — | 已生效 |
| `coverageSince` | 2026-10-22 | — | （未登记消费方——policy 加新键时同步登 CONSUMERS） | — | 已生效 |
| `check1HardSince` | 2026-11-10 | 检查 1 | 红线判低 / L3 状态未确认两 hard——锚前存量降 WARN（消息带「存量豁免」前缀），锚起新档照常 hard | hard | 已生效 |
| `premiseSince` | 2026-10-30 | confirm-doc（stage-gates premiseGate） | spec 确认门前提质询门——锚起新建 spec 须有非空且非占位的「前提质询」表（拦「自信的错误解读」进事实源；无解读风险写「无关键前提」行 + 理由） | hard | 已生效 |
| `regrEnforcerSince` | 2026-11-12 | 检查 29 | 回归清单执法者配对——锚起数据行「执法者」列须非空（真执法资产或显式 [prompt-only]）——锚前存量不追溯 | hard | 已生效 |

<!-- GENERATED:BEGIN — gen-effective-policy.mjs 整段重写，手工说明写在本行之前 -->
