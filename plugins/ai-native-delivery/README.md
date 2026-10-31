# ai-native-delivery

AI-Native 交付治理引擎：把 Shipyard.Material 里跑通 14 个 policy version 的交付治理机制做成可安装插件（[Agent Plugins 1.0.0](https://agent-plugins.org) 标准）。它交付的不是"流水线"，而是三层闭环：

## 三层闭环定位

1. **任务级硬闭环**：任何任务先过"两问定级"进 L1（实现级）/ L2（规则契约）/ L3（数据与运行时结构）风险泳道，级别决定审计成本；L2 有触达面闭集（4 条），L1 plan 勾红线即判低拦截、强制升级；check-loop 硬门 5 段（判低 / 回归证据 / 验收勾验 / 确认指纹 / 收敛对账）在 init-engine 安装的 pre-commit / pre-push 两个 git hook 物理闸门上校验闭环证据；关单是程序性自检（skills/workflow-closeout §0 + confirm-doc/stage-gates），不经 check-loop。
2. **状态收敛闭环**：台账三件套（intents / specs / plans）+ INDEX 作为跨会话物理内存；收敛对账保证台账与 git 实际状态不背离；compact / archive 负责台账卫生，mechanism-retire-watch 治理检视由人工 / 项目自定期运行（不随 git hooks 自动跑），read_context + INDEX 支撑断崖恢复。
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

拦截按宿主能力降级，**插件自带两层**（PreToolUse 风险闸 + git hooks），第三层是项目适配点：

- **PreToolUse 风险闸**仅在 Claude 式 hook 宿主（Claude Code / ZCode 等）生效；
- 不支持该类 hook 的宿主**自动降级为 git hooks 单层拦截**，硬门语义不变，只是拦截时点从工具调用前推迟到提交 / 推送前；
- **CI 层是项目适配点，插件不附带 CI 模板**：项目可在自己的 CI 里跑 `node <插件安装路径>/scripts/check-loop.mjs --all`（插件随宿主常驻，CI 侧需能访问该路径），把合入前兜底补上；
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
| `update_ledger` | 台账原子更新：限 workflow/ 树内路径，写前过不变量校验（fail-closed）。`create` 走 tmp+rename 原子建文件；`append` 走 `appendFileSync`（O_APPEND），多会话并发追加不丢行 |
| `confirm` | 写任务级确认记录（kind:"task" 行，含指纹供台账校验对账）；带 `doc` 时按 confirm-doc 同款判据做引文接地 |
| `verify_gate` | 跑 check-loop 指定车道（hard / hygiene / all）并回报裁决 |
| `ledger_stats` | 台账体量与不变量状态，供 compact 决策 |
| `policy_status` | 治理进化可见性：policyVersion / 预算实测 / 退役候选（诚实口径）/ 棘轮计数 |

> **`confirm` 的引文接地**：`evidence` 是「用户真的放行过这件事」的唯一可对质证据，所以它复用文件侧同一模块 `scripts/quote-grounding.mjs`（逐字命中 / ≥8 字逐字锚点 / 纯放行语三层，任一成立即接地），而不是另立一套口径。传 `doc`（workflow/ 树内台账文档）才会接地，结果如实记进台账行的 `quoteGrounding`：`verbatim` / `anchor` / `generic` / `ungrounded` / `unanchored`（未带 doc）。**默认只留痕不拦**——该模块头注的 873 条历史委托实测显示，中文口语是复述而非引用，词面判据硬拦会误杀 8–18% 合规放行，而对无关文档仍有 71.2% 通过率（判别力不足）；要收硬请显式传 `strict_quote: true`。只有客观缺陷硬拒：`doc` 在活跃目录与归档里都不存在、路径逃逸出 workflow/ 树（与 `update_ledger` 同围栏）。task 行**恒不带 `stage`**——§15 的文档配对判据是 `doc && VALID_STAGES.has(stage)`，带上 stage 就等于给了任务级确认伪造文档关单凭证的能力（该不变量由 `test/mcp-tools.test.mjs` 钉住）。
>
> **`root` 参数（重要）**：本插件的 `mcp.json` 声明 `cwd: "${PLUGIN_ROOT}"`，即宿主默认把服务起在**插件安装目录**。此时服务进程的 cwd 落在插件根内，`requireRoot` 会**直接拒绝**并提示——这是刻意的 fail-closed（台账若落进插件目录，会被别的项目当成关单凭证）。因此在这种部署形态下，**每次工具调用都要显式传 `root=<使用项目的 git 仓库根>`**。想让工具免传 root，就把宿主启动本服务时的工作目录设为项目根（部分宿主可配）。

## 命令 / 角色 / skills 清单

命令（`commands/`，8 个）、角色（`agents/`，3 个）、技能（`skills/`，6 个）按各宿主约定目录加载（见「宿主与 hook 降级」），不支持对应约定的宿主跳过加载即可，MCP 工具不受影响。

### 命令（8 个）

| 命令 | 一句话用途 |
| --- | --- |
| `/new-task` | 闭环总入口：6 阶段指令索引（Plan→Design→Build→Test→Deploy→Maintain），含 L1 快速道 |
| `/plan` | Plan 阶段：L2/L3 立 intent（L1 plan 在 new-task 快速道内完成） |
| `/design` | Design 阶段：起 spec（仅 L2/L3；L1 不进本阶段） |
| `/build` | Build 阶段：起 plan + 实现代码 + 自验（确认后才动代码） |
| `/test` | Test 阶段：静态门（架构红线 + build + test）+ UI 实测（headless Chrome） |
| `/deploy` | Deploy 阶段：prod 上线清单（静态门 + 配对检查 + 回归 + DB + 授权 + 24h 观察；文档关单在 test） |
| `/maintain` | Maintain 阶段：立 incident + 复盘三件套（修复 / 防复发 / 规范条目） |
| `/review` | 代码评审标准（横切：合入前使用，不占 6 阶段之一）：机器兜底 + AI 自查出清单，用户决策定性和合入 |

### 角色（3 个）

| 角色 | 一句话定位 |
| --- | --- |
| `implementer` | 受控实施者：范围明确任务的实现与自验，最小 diff，授权边界外即 HALT |
| `independent-reviewer` | 独立复核者：独立上下文只读复核 spec/plan/diff，证据驱动，落盘行交主智能体写入 |
| `ui-verifier` | UI 实测者：只验证不修复的浏览器实测，DOM 几何取证，证据交还主智能体 |

### skills（6 个）

| 技能 | 一句话用途 |
| --- | --- |
| `autonomous-run` | 无人值守长跑合同：长任务/过夜时逐单元签收、自底向上落地、何时停机 |
| `decision-log` | 长跑/无人值守的决策轨迹：append-only TSV，一行一个决策（what/why/evidence/result） |
| `review-method` | 代码复核走查方法（Standards×Spec 双轴 + 坏味道清单 + 合入标尺），`commands/review.md` 的方法层单源 |
| `session-resume` | 会话重入与中断落盘：接手/切换 worktree/压缩续作前先用机器事实重建当前态 |
| `verify-ui` | 启动本地服务并用浏览器实测 UI 改动（只读验证、不留脏数据） |
| `workflow-closeout` | 关单序列：verify --scope、验收勾验、confirm-doc、索引与确认分片提交 |

## hooks

两层拦截，配置问题不卡死正常操作，但**deny 面有一道不可下调的内置地板**（2026-10-28 收紧，见下）：

- **PreToolUse 风险闸**（`hooks/pretool-risk.mjs`，Claude 式 hook 宿主生效）：shell 类命令对 deny / ask 两清单静态匹配（曾有的 `allow` 清单已于 2026-10-28 移除——它在判定链末端空转，且列着 `git commit`/`git push`，容易让人误以为这些命令已被预先批准）。清单来源为项目侧 `.agents/settings.json`（`permissions.deny` / `permissions.ask`）→ 插件种子 `config-templates/settings.json` → 代码内兜底，但两清单的信任边界不同：
  - **deny = 内置地板 ∪ 该来源追加**——`git reset --hard` / `git push --force` / `git push -f` / `git push --no-verify` / `git commit --no-verify` / `drop database` 六项**被治理项目删不掉**，只能加严。此前是「清单单源」：项目侧文件一在场就整体接管 deny 面，而项目目录正是 agent 能写文件的地方，自写 `{deny:["x"],ask:[]}` 或干脆把 settings.json 写成非法 JSON 触发 fail-open，就能单方面解除这一层——「两层拦截」名不副实。现在损坏文件只让它自己的追加项失效（stderr WARN 点名），地板照拦。
    - `--no-verify` 单列（2026-10-29 补）：它是从 shell 层关掉已安装 git hook 的唯一开关，能一条参数解除两层中的一层。
    - 匹配前先剥引号（2026-10-29 补）：`git push "--force"` 与 `git push --force` 是同一个命令，旧判据按原样切词元导致引号变体全部静默放行。
  - **ask 仍可被项目侧整体接管**（ask 只是多问一句，由项目自定是合理的；不写 `ask` 键则回退内置默认）。
  - 想放宽地板只能由**人**在宿主侧关掉这个插件的 hook，不提供项目内配置位——这是刻意的：治理引擎的门不该由被治理的仓库拆。
- **git hooks**（init-engine 安装到 `.git/hooks/`，任何宿主生效）：pre-commit / pre-push 执行 check-loop 硬门；卸载 = 删除两个钩子文件，种子正文在 `config-templates/githooks/`。

不支持对应 hook 约定的宿主自动降级为 git hooks 单层拦截，硬门语义不变（见「宿主与 hook 降级」）。

### 与 systemone-decision 共装时（双风险闸，2026-10-28 说明）

同一市场里的 `systemone-decision` 也注册 PreToolUse 风险闸，matcher 同为 shell 类、判定同样输出
`ask` / `deny`。宿主按插件各跑各的 hook，**两个闸之间没有仲裁通道**——插件内部看不到另一个插件
是否在场，也没有宿主 API 能让一个 hook 让位于另一个。所以共装时的实际行为是：

- 危险命令会被**两个闸各判一次**，可能出现两道确认提示，或一个 `ask` 叠一个 `deny`（最终按宿主
  对多个 hook 输出的合并规则取严）；
- 两套拒/允清单彼此独立（本插件读项目侧 `.agents/settings.json`，systemone 读自己的设置页），
  同一个命令在两边可能得到不同结论。

**约定**：只保留一道闸。保留本插件（它同时管 git hooks，语义更完整）时，把 systemone 的闸关掉
（`SYSTEMONE_HOOK_RISK_GATE=off`）；反过来则删除本插件 `hooks/hooks.json` 的 PreToolUse 段。
不做自动让位——靠猜安装布局去检测对方会让行为随目录结构漂移，比双提示更难排查。

### 门禁的适用性判据（`verify.mjs`，2026-10-28）

`verify.mjs` 的 20 门里有 6 门只对**特定技术栈**成立（前端 `npm run lint:check` / Vitest / vue-tsc、后端 `dotnet build App.sln` / 后端测试、Playwright E2E、wiki 一致性脚本）。这类门带一条适用性判据，缺失时判 **SKIP** 并显式出账，不挡关单、不计入通过数（没跑 ≠ 过了）：

| 判据字段 | 语义 | 现有门 |
| --- | --- | --- |
| `requires: <路径>` | 项目根下该路径存在才执法（目录 / 解决方案文件） | `frontend-lint`、`frontend-unit-test`、`frontend-build`、`frontend-e2e`、`backend-build`、`backend-test` |
| `optional: <脚本名>` | 项目自带脚本存在才执法（`scriptPath` 两处查找） | `wiki-consistency` |

两条硬约束（由 `test/verify.test.mjs` 场景 15 锁定）：**产品段每一门都必须带其中一个判据**，否则新增门会再退回「消费项目装上即红」；**跳过沿依赖边传播**——上游判不适用时下游同步跳过，避免「构建已跳过、测试照跑因无产物变红」的假红。路径一旦出现，该门自动恢复执法，无需改配置。

## 工程准入与验收

- 冒烟：`node test/smoke.mjs`（清单版本位 + MCP 7 工具探测）；
- 全量：`test/` 全部套件逐个可跑（CI 逐行接线）；设计文档 §10 十条验收断言收口在 `test/acceptance.mjs`（黑盒、全走 CLI/stdio 入口），样板仓端到端闭环在 `test/e2e-fixture.mjs`；
- 迁移口径见 [NOTICE-ORIGIN.md](NOTICE-ORIGIN.md)：只迁机制不迁运行数据；实现收口记录（v2.3 → 0.1.0 落地偏差与裁决）见设计文档 `design/ai-native-delivery.md` §12。
