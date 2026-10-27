# ai-native-delivery

AI-Native 交付治理引擎：把 Shipyard.Material 里跑通 14 个 policy version 的交付治理机制做成可安装插件（[Agent Plugins 1.0.0](https://agent-plugins.org) 标准）。它交付的不是"流水线"，而是三层闭环：

## 三层闭环定位

1. **任务级硬闭环**：任何任务先过"两问定级"进 L1（实现级）/ L2（规则契约）/ L3（数据与运行时结构）风险泳道，级别决定审计成本；L2 有触达面闭集（4 条），L1 plan 勾红线即判低拦截、强制升级；check-loop 硬门 5 段（判低 / 回归证据 / 验收勾验 / 确认指纹 / 收敛对账）在关单与 pre-push 两个物理闸门上校验闭环证据。
2. **状态收敛闭环**：台账三件套（intents / specs / plans）+ INDEX 作为跨会话物理内存；收敛对账保证台账与 git 实际状态不背离；loop-watch 日检与 compact / archive 负责台账卫生，read_context + INDEX 支撑断崖恢复。
3. **治理进化闭环**：judgment-ledger 按 per-rule 计数积累判定事实，连续 6 月零命中的规则进退役候选，门禁段数棘轮锁死上限（只减不增），gate 预算以实测墙钟为据。

三层在 0.1.0 一次交付、不分段发布（安装即得全量机制面）。

## 台账项目级不变量

**台账与三本审计账（confirmations / judgments / verifications）永远是项目级资产：**

- 一律落在**使用项目的 git 仓库根**（锚定 git root 解析，不锚 cwd，防嵌套目录漂移）；
- 插件目录只承载代码与模板，用户 home 目录不落任何项目台账数据；
- MCP 服务无自有存储，一切读写以项目根为锚。

项目侧产物为两棵树：`.agents/`（引擎运行时：config / confirmations / judgments / verifications / cache 等）与 `workflow/`（人类可读交付台账），首次命令执行时幂等初始化，已存在则只校验 policyVersion、不覆盖项目改动。

## 与 agent-pipelines 的边界

**平行共存，互补不合并**：[agent-pipelines](../agent-pipelines/) 管**执行编排面**——一个任务内 orchestrator → builder → reviewer 怎么协作跑完；本插件管**治理面**——任务开工前怎么定级、落什么档、关单时要什么证据。消费时机不同（治理面在任务入口与出口，编排面在任务内部），可独立使用，也可叠加：编排的 review / gate 阶段可直接调用本插件的 MCP 工具（confirm / verify_gate）。

## 宿主与 hook 降级

三层拦截模型按宿主能力降级：

- **PreToolUse 风险闸**仅在 Claude 式 hook 宿主（Claude Code / ZCode 等）生效；
- 不支持该类 hook 的宿主**自动降级为 git hooks + CI 模板两层拦截**，硬门语义不变，只是拦截时点从工具调用前推迟到提交 / 推送前；
- 命令、角色委派（斜杠命令 / 子智能体）按各宿主约定目录加载，不支持对应约定的宿主跳过加载即可，MCP 工具全宿主可用。

## 安装

要求 **Node.js ≥ 18** 且 `node` 在宿主启动 MCP 服务使用的 PATH 里，无任何凭据与私有配置。

```
# ZCode
/plugin marketplace add zerosloney/master0071-plugins-market
/plugin install ai-native-delivery@master0071-plugins

# Agent Plugins 兼容客户端（VS Code / Cursor / Copilot / Kiro / OpenClaw 等）
直接加载插件目录 plugins/ai-native-delivery

# Codex / Oh My Pi
经本仓库各自的市场入口安装，见仓库根 README「安装」一节
```

## 初始化（init-engine）

台账是**项目级资产**（见上节不变量），使用前对使用项目的 git 仓库根做一次幂等初始化：

```
node <插件根>/scripts/init-engine.mjs            # 缺省锚定当前 git 仓库根
node <插件根>/scripts/init-engine.mjs --root <仓库根>   # 显式指定项目
```

- **幂等**：重复执行零改动；已存在的文件一律跳过不覆盖（项目改动不受初始化侵蚀）；
- **new-task 首步自动引导**：`commands/new-task.md` §1 定级前检测项目根无 `.agents/config/engine.json` 时，先执行本初始化再定级（命令文本驱动，MCP 工具不做静默自动写盘）；未初始化时 MCP 工具仍返回降级响应（如 `read_context` 的 `{initialized:false, hint}`）而非报错，亦可随时手动执行上面的命令；
- **落位**：`.agents/`（config 种子、settings.json、confirmations.jsonl + confirmations.d/、cache 等运行时目录）与 `workflow/`（INDEX + 台账骨架）；另写 `.gitignore` 标记块、安装 `.git/hooks/pre-commit` / `pre-push`（已存在同名钩子跳过不覆盖）；
- 项目侧 `.agents/config/engine.json` 的 policyVersion 与插件种子不同时 WARN 可升级、不自动覆盖。

## MCP 工具（7 个）

| 工具 | 一句话用途 |
| --- | --- |
| `grade_task` | 两问定级：任务描述 → L1/L2/L3 与命中依据 |
| `read_context` | 跨会话恢复：INDEX 头部 + 在途三件套 + 最近确认行（断崖恢复入口） |
| `update_ledger` | 台账原子更新：限 workflow/ 树内路径，写前过不变量校验（fail-closed） |
| `confirm` | 写任务级确认记录（kind:"task" 行，含指纹供台账校验对账） |
| `verify_gate` | 跑 check-loop 指定车道（hard / hygiene / all）并回报裁决 |
| `ledger_stats` | 台账体量与不变量状态，供 compact 决策 |
| `policy_status` | 治理进化可见性：policyVersion / 预算实测 / 退役候选（诚实口径）/ 棘轮计数 |

## hooks

两层拦截，均**fail-open**（配置损坏放行 + stderr WARN，绝不卡死用户）：

- **PreToolUse 风险闸**（`hooks/pretool-risk.mjs`，Claude 式 hook 宿主生效）：shell 类命令对 deny / ask / allow 三清单静态匹配；清单**单源项目侧 `.agents/settings.json`**（`permissions.deny/ask/allow`），缺文件回退插件种子，再缺代码内最小 deny 兜底。
- **git hooks**（init-engine 安装到 `.git/hooks/`，任何宿主生效）：pre-commit / pre-push 执行 check-loop 硬门；卸载 = 删除两个钩子文件，种子正文在 `config-templates/githooks/`。

不支持对应 hook 约定的宿主自动降级为 git hooks + CI 两层拦截，硬门语义不变（见「宿主与 hook 降级」）。

## 工程准入与验收

- 冒烟：`node test/smoke.mjs`（清单版本位 + MCP 7 工具探测）；
- 全量：`test/` 全部套件逐个可跑（CI 逐行接线）；设计文档 §10 十条验收断言收口在 `test/acceptance.mjs`（黑盒、全走 CLI/stdio 入口），样板仓端到端闭环在 `test/e2e-fixture.mjs`；
- 迁移口径见 [NOTICE-ORIGIN.md](NOTICE-ORIGIN.md)：只迁机制不迁运行数据；实现收口记录（v2.3 → 0.1.0 落地偏差与裁决）见设计文档 `design/ai-native-delivery.md` §12。
