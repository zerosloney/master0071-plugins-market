# 闭环自治与记忆校错设计（G 系列，2026-11-12 AI-Native 原理对齐审查）

定位：以两篇公开方法论为基准（Anthropic《The components of agent memory》2026-11-06；Claude《The AI-native SDLC playbook》2026-08-21）对 ai-native-delivery 做第一性原理对齐审查后的缺口设计稿。审查结论：工件链（台账三件套+指纹+收敛对账）、分层执法（skill 建议层 / hook+4 git hooks 确定层 / confirm 人类门）、配置回归（97 脚本+棘轮+退役管线燃料遥测）三轴**领先或持平基准**；缺口集中在**闭环自治层（G1/G3/G4）**与**记忆校错面（G2/G5）**，另有宿主安全面成文缺口（G6）。本文只写设计与交付切分，供 owner 批准后按步实现。

基准的第一性原理五条（审查依据，全文见二文）：①瓶颈守恒——代码生产成本坍缩后约束迁移到人速环节与治理面，每道控制归位三层之一（确定性检查 / 新鲜上下文代理判断 / 人类 intent 与 risk 裁决）；②状态外置为版本化工件，被接受的工件触发下一道门，工件链即审计链；③记忆即预测——只存无法从环境重读出的东西，错注记需离线（dreaming）拿 ground truth 校正；④指挥 agent 的配置本身要回归测试，事故沉淀为 eval，且验证回路自保护；⑤检测确定性、响应分层自治（1σ 记录 / 2σ 只读诊断 / 3σ 仅经 PR 或预批 runbook 行动），agent 做到生产门之前的一切。

## 1. 问题重述（六处缺口，附实证）

**G1 无人触发闭环缺失（最大缺口）**。`/maintain` incident 三件套是人工入口；无确定性控制带监测（bands）、无 σ 分层响应档、无无交互唤起通道；CI 适配点连模板都不附（marketplace 描述自述"CI 层为项目适配点，插件不附带 CI 模板"）。对照基准⑤：触发路径中无人，检测纯确定性，档位版本化。

**G2 dreaming 只判冷、不校错**。`scripts/dream-run.mjs` 只消费计数遥测（kb-usage.jsonl）产出冷候选与归档建议；从不拿 ground truth（confirmations.jsonl 指纹、evidence 台账、verify 绿行）校验知识文档内容是否仍被支撑。对照基准③：dreaming 首要功能是对照 transcript 校正错误记忆（原文实证：错误方位注记导致三次循环，一次 dreaming 校正即救回）。

**G3 事故→执法只到"指认"、未到"存在且会红"**。s29 判据为锚后行第 4 列执法者非空，`[prompt-only]`+papercuts 挂债放行——不验证被指认的执法资产存在、可达。对照基准④：每个生产事故沉淀为一条 eval 且进套件常跑。

**G4 阶段流转指标缺位**。`gen-workflow-metrics.mjs` 产出门禁/预算面，不产 intent→spec→plan→close 流转时长与 build 后 spec/plan 修订数（返工代理，git 时间戳全可推导）；judgment-ledger 只记命中不记冤枉，门的误拦率无从审视。

**G5 注入层无提升/降层纪律**。INDEX+`read_context` 承担跨会话物理记忆，但无"会话头部注入层"容量纪律与 dreaming 驱动的提升/降层；INDEX 随任务数单调膨胀——原文 Sonnet 3.7 的 413 记忆文件陷阱的慢速版本（维护成本逐渐吃掉任务本身）。

**G6 托管安全面未成文**。deny/ask 只拦 shell 命令串；check-secrets 扫 diff，但 agent 仍可经 Read 工具把密钥读进上下文。对照基准：managed settings 的文件读取拒绝面（`Read(.env*)`）、沙箱网络白名单、凭据剥离。属宿主能力边界，插件层至少应成文为项目侧适配要求（当前完全未提及）。

## 2. 设计（七步，每步独立可交付、可独立验收）

### 步骤 A（G1 半）：响应档配置与确定性带监测
- `config-templates/bands.json` 种子（沿用仓内 JSON 惯例）：`metric / baseline / rules / tiers` 四段；tier 动作枚举 `log / diagnose（只读工具白名单）/ propose（仅经 PR）`。
- 新增 `scripts/check-bands.mjs`：纯确定性读指标源（首版两内置源：`verifications.jsonl` 绿行、`gen-workflow-metrics` 输出），判定越带并按档输出**建议指令行**（不自动执行，见「明确不做」）。
- 验收：夹具指标越带 → 输出含 tier 与建议指令；无越带 exit 0；CLI 与库双面测试。
- 风险：指标源异构——首版只做两个内置源，外部源留 `--metric-source` 扩展位。

### 步骤 B（G1 另半）：CI 适配点模板
- `config-templates/ci/`：可播种的无交互 runner 示例（GitHub Actions YAML：无模型步跑 check-loop/verify + 可选 `claude -p` 诊断步的注释样例）+ 插件 README「CI 层项目适配指南」节。不默认接线任何宿主。
- 验收：模板进临时仓无模型步可跑通；manifest-lint 文案护栏不破。

### 步骤 C（G2）：dreaming 校错 pass
- 新增 `scripts/dream-verify.mjs`：对 workflow 知识文档（principles、regression-checklist、spec/plan 存档）中"规则型断言行"做**引用完整性对拍**——引用的确认指纹行、证据文件、终态件是否存在；产出"存疑注记清单"（advisory 报告落 `.agents/tmp/`，`dream-run` 报告新增 D 段引用）。
- 判据保守：只标"引用了不存在的证据"的硬漂移；语义级对错不判（离线脚本无模型）。
- 验收：夹具造"引用已删证据的规则行"→ 点名；正常引用零误报（首版宁漏报不误报）；测试。
- 风险：范围蔓延——首版只做引用完整性；语义校验见开放问题 3。

### 步骤 D（G3）：执法者可达性机检
- s29 扩展：被指认执法者为仓内文件路径时，机检**存在 + 语法/`--check` 级可跑**；`[prompt-only]` 维持放行，但挂债行计数进 verify 尾部摘要（复用 retire-watch 摘要先例，≤5 行）。
- 验收：指认不存在文件 → hard 红；存在 → 绿；测试。锚前不追溯语义保持。

### 步骤 E（G4）：阶段流转指标
- `gen-workflow-metrics.mjs` 增流转面：从台账三件套 + git 时间戳推导 intent→spec、spec→plan、plan→close 时长分布，及 build 开始后 spec/plan 修订数（返工代理）。误拦率（judgments 增 dismiss 原因位）**暂缓**，首版只做流转。
- 验收：夹具仓产指标行；月度快照格式向后兼容。

### 步骤 F（G5）：INDEX 注入纪律
- `read_context` 输出加容量纪律：INDEX 头部超阈值（行数上限进 `gate-budgets.json` 或独立常量，从权）时输出"分片/归档建议"advisory（与 compact/archive 既有链衔接），不自动改写。
- 验收：超长 INDEX 夹具 → 建议行；正常 INDEX 静默。

### 步骤 G（G6）：托管安全适配成文
- 插件 README 增「项目侧安全适配」节：宿主支持时的文件读取拒绝面、沙箱网络白名单、凭据剥离的配置样例（zcode/codex 各自等价键），及与插件 deny/ask 的分工边界。零行为变更，纯文档。

## 3. 明确不做

- **不自动唤起 agent**：check-bands 输出"建议指令"而非 spawn——自治执行属 owner 另行授权的 runner 面（与「退役=owner-fiat」同纪律）。
- **dreaming 不做语义真伪判定**：离线脚本无模型，校错止于引用完整性；语义级校验留给会话内 agent 或未来带模型的定时任务。
- **不内置沙箱/托管策略**：宿主能力边界，插件只成文指引，不仿制 managed settings。
- **不为 s29 造 eval 运行器**：可达性机检止于"存在+可跑"；跑通断言属 CI/项目侧职责。

## 4. 开放问题（owner 裁决）

1. bands 指标源优先级：verify 绿行 vs workflow-metrics vs 外部（Prometheus 类）——建议首版两内置。
2. check-bands 挂载点：仅 CLI/CI，还是 post-commit advisory 轻提醒——建议仅 CLI/CI（post-commit 已有 dream 提醒，不叠噪）。
3. dream-verify 是否预留"带模型档"（未来接无交互模型调用做语义对拍）的接口位——建议只留头注锚，不实现。
4. 流转指标是否登记 mechanism-registry 判据面（成为可退役机制）——建议登记 `[数据面]`。

## 5. 交付切分建议

A→B→D 一批（闭环自治半场：带监测+CI 模板+执法可达）；C 单独一批（校错 pass，判据面独立）；E→F→G 收尾批（指标/纪律/文档）。每批收口跑全套件与 acceptance。

## 6. 实现记录（2026-11-12，版本 0.2.1，三批全量落地）

- 步骤 A → `config-templates/bands.json` + `scripts/check-bands.mjs`（0.2.1，批次 1）；开放问题 1 按建议裁决：首版两内置源（verify-green / workflow-metrics），外部源留 `--metric-source` 扩展位。
- 步骤 B → `config-templates/ci/`（github-actions-verify.yml.template + 目录 README）+ 插件 README「CI 层项目适配指南」（0.2.1，批次 1）；marketplace 描述「不附带 CI 模板」句已按实收口为「附带 CI 适配参考模板，接线属项目自治」（§1 G1 所引为设计时原文，历史留痕）。
- 步骤 C → `scripts/dream-verify.mjs` + `scripts/dream-run.mjs` D 段引用（0.2.1，批次 2）；开放问题 3 维持：只留头注锚，未实现带模型档。
- 步骤 D → `scripts/regr-enforcer-scan.mjs`（判据单源）+ check-loop §29 指认可达性扩展 + verify 尾部 [prompt-only] 挂债计数（0.2.1，批次 1）。
- 步骤 E → `scripts/gen-workflow-metrics.mjs` 第八表「阶段流转」+ mechanism-registry 补登 [数据面] 至 59 行（0.2.1，批次 3）；开放问题 4 按建议裁决：登记 [数据面]。
- 步骤 F → `scripts/read-context.mjs` INDEX 注入纪律 advisory（阈值独立常量 `INDEX_MAX_LINES = 200`，超阈值附分片/归档建议；带内输出键形不变）（0.2.1，批次 3）。
- 步骤 G → 插件 README「项目侧安全适配」节（读取拒绝面 / 网络白名单 / 凭据剥离样例 + 三层分工边界表；零行为变更）（0.2.1，批次 3）。
- 开放问题 2 维持：check-bands 现挂 CLI/CI（按建议实现为项目自接线），post-commit 轻提醒未做、未裁决关闭。
