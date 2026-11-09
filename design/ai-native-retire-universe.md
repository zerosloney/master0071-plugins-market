# 退役管线规则全集与燃料语义设计（F4，2026-11-09 减重机制审查）

定位：ai-native-delivery 减重机制专项审查的 F4 决策项设计稿。审查发现与证据见会话报告；本文只写设计与交付切分，供 owner 批准后按步实现。

## 1. 问题重述（三处实证）

1. **retire-watch 死面**：`mechanism-retire-watch.mjs` 只认项目侧 `.agents/config/mechanism-registry.md`（`:61` REGISTRY_REL，缺文件即 `[ERROR] 台账不存在`——插件仓实跑复现）；`init-engine.mjs` 不播种该文件，无种子回退链（对照：`rule-budget.mjs:60-65` 与 `gen-engine-map.mjs:86` 均有回退）。装户未手工落表 → 机制级退役筛永远 ERROR，静默于治理之外。
2. **双筛分工未成文**：`agg-judgments --retire-candidates` 是**规则级**筛，universe=账内出现过的规则（`agg-judgments.mjs:263`，文档化语义）；`mechanism-retire-watch` 是**机制级**筛，universe=登记表全部现役行——`evaluate()` 的 `ruleNamesOf(口径列)` + 窗口零命中 → threshold 动作（`mechanism-retire-watch.mjs:181-204`）**本来就正确处理零命中机制**。审查初判「恒不触发永不进候选」对机制级不成立；真缺口是①retire-watch 面死（问题 1）②口径列没写规则名/燃料在 judgments 之外的行全落 `notAuto` 一个桶，语义糊。
3. **自饿判据**：PR 体积预算（registry :55 行）无任何调用方 → judgments 永无其规则名 → 只要台账有数据月且满窗，retire-watch 会正确产出退役候选（**系统按设计工作**，无调用方就该被退役审视）。但其口径列若不映射规则名则进 notAuto 眼不见心不烦；且「无遥测来源」与「阈值形态不支持」混在同一 notAuto 理由桶。

## 2. 设计（四步，每步独立可交付、可独立验收）

### 步骤 A：registry 读取种子回退统一（同款已验证修法）

`mechanism-retire-watch.mjs` 与 `s22-registry.mjs` 的 registry 定位改走「项目侧 `.agents/config/` → 插件种子 `config-templates/`」回退链（复用 2026-11-09 s16 修复同一模式与 rule-budget.mjs 既有实现）。
- 验收：插件仓实跑 retire-watch 不再 ERROR（读种子 49 行）；`test/mechanism-retire-watch.test.mjs` 加「无项目侧表 → 种子兜底」夹具用例；`check-loop.test.mjs` §22 同款。
- 风险：种子行携带源仓历史叙事（最近触发列日期为源项目口径）——装户首跑会看到源仓日期。可接受：登记表本来就是随插件分发的机器面，日期列在装户侧由其自身月度对账覆写。

### 步骤 B：口径列证据源声明（@src 语法）

口径列语法扩展：`规则 A、规则 B @src:judgments`。默认（无 @src）= judgments，零成本向后兼容；可选 `@src:gate-metrics`（分片月数据）、`@src:verify`（verifications.jsonl 绿行）、`@src:none`（显式声明无遥测来源）。
- `evaluate()` 按 src 取数；`@src:none` 行产**专属动作 `kind:no-fuel`**：「判据无燃料——接遥测或 owner 复评改判据」，从 notAuto 桶分离。
- PR 体积预算行标 `@src:none` → 每次月度对账显式催办，替代「永不出现」。
- 验收：纯函数 evaluate 新分支 TDD；registry 种子同步给相关行补 @src。

### 步骤 C：月度对账半自动挂载

不挂 git hook（README §治理进化闭环定调人工/自定期，维持）；在 `verify` 门 `workflow-metrics`（或 engine-map 门）尾部附 retire-watch 摘要段（有动作项才出，≤5 行）。月度跑 verify 的项目自动看到退役动作项，无需记得独立 CLI。
- 验收：verify 测试加「registry 有 threshold/no-fuel 动作 → 输出含摘要行」用例。
- 风险：verify 输出体积——限行数、无动作不出段。

### 步骤 D：分工成文（零行为变更）

`agg-judgments.mjs` 头注与 `--retire-candidates` 帮助文本写明：规则级筛（命中过的规则）；机制级筛（登记表全集，含零命中）用 mechanism-retire-watch。防后来者把 agg 当全集来源再误判盲区。

## 3. 明确不做

- **不给 agg-judgments 造规则全集**：机制级单源是登记表；规则级全集=check-loop SECTIONS 常量，再造一份即两源漂移。
- **不自动退役/降级**：退役=owner-fiat 物理删码+删行（既有纪律），管线只负责「让该看见的都被看见」。
- **不给 PR budget 强接调用方**：它该不该活是复评结论，不是设计前提。

## 4. 开放问题（owner 裁决）

1. no-fuel 催办频率：每次运行都出，还是每月首个运行日聚合一次（建议后者，噪声低）。
2. 种子回退后，装户侧是否允许本地改种子行（现状：init 只拷一次、之后项目自治——registry 同理，首拷进 `.agents/config/` 后脱离种子，推荐此语义而非每次读种子）。
