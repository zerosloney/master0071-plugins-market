# ai-native-delivery

AI-Native 交付治理引擎：把跑通 14 个 policy version 的交付治理机制做成可安装插件（[Agent Plugins 1.0.0](https://agent-plugins.org) 标准）。它交付的不是"流水线"，而是三层闭环：

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
- 种子的领域词表 `workflow-modules.txt` 是**模板种子示例**（领域无关最小集，2026-11-05 脱敏：不再携带源项目制造域词）：项目应改写为自有域词表——`kb-search --module` 与 check-loop 模块校验按项目侧这份文件判，已改写内容初始化不覆盖。

### 安装引擎（0.1.19 重构：plan/apply 两段式 + sha256 台账）

初始化拆两段：`install/plan.mjs` 把全部落盘行为描述为纯数据计划（零写盘副作用），`install/apply.mjs` 按安装台账 `.agents/install-manifest.json`（逐文件 CRLF 归一 sha256，入库共享，语义同 lock 文件）裁决落盘。两个新增通道：

```
node <插件根>/scripts/init-engine.mjs --dry-run   # 只裁决不写盘：预览 create/update/conflict 清单
node <插件根>/scripts/init-engine.mjs --force     # conflict 项强制覆盖回种子（用户改动不保留）
```

升级语义按台账哈希逐文件裁决：目标不存在 → `create`；目标与台账哈希一致而种子有新版 → `update`（**未改过的种子文件随插件升版自动更新**）；目标与台账哈希不一致（用户改过）→ `conflict` 跳过不覆盖，`--force` 才覆盖。**领养模式**：旧版 init-engine 初始化过的项目（文件在、台账整个缺失）首跑一个文件都不覆盖，现状哈希全部记入新账，此后进入正常的升级/保护裁决。

### 安装健康自检（doctor）

```
node <插件根>/scripts/doctor.mjs                  # 缺省锚定当前 git 仓库根
node <插件根>/scripts/doctor.mjs --root <仓库根>   # 显式指定项目
```

7 项静态检查：项目根锚定 / 安装台账在位可解析 / 已装文件与台账哈希逐文件一致 / git hooks（pre-commit / pre-push 在位且引擎指针有效）/ `.gitignore` 标记块成对 / settings.json deny 地板含内置基线 / engine.json policyVersion 与种子一致。逐项 `✓/✗` 输出，✗ 项下一行附可直接复制执行的修复命令；任一项 ✗ 退出码非 0，可接进项目侧脚本当安装健康门用。

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
  - **deny = 内置地板 ∪ 该来源追加**——`git reset --hard` / `git push --force` / `git push -f` / `git push --no-verify` / `git commit --no-verify` / `git commit -n` / `drop database` 七项**被治理项目删不掉**，只能加严。此前是「清单单源」：项目侧文件一在场就整体接管 deny 面，而项目目录正是 agent 能写文件的地方，自写 `{deny:["x"],ask:[]}` 或干脆把 settings.json 写成非法 JSON 触发 fail-open，就能单方面解除这一层——「两层拦截」名不副实。现在损坏文件只让它自己的追加项失效（stderr WARN 点名），地板照拦。
    - `--no-verify` 单列（2026-10-29 补，2026-11-01 补短写）：它是从 shell 层关掉已安装 git hook 的开关，能一条参数解除两层中的一层——而且它有**两个名字**：`git commit -h` 显示 `-n, --no-verify`，所以地板里 `git commit --no-verify` 与 `git commit -n` 两条都在。反面对照：`git push -n` 是 `--dry-run`（不解除任何东西），故有意不放进地板。
    - 匹配前先剥引号（2026-10-29 补）：`git push "--force"` 与 `git push --force` 是同一个命令，旧判据按原样切词元导致引号变体全部静默放行。
    - 短选项簇先展开（2026-11-01 补）：`git push -uf` 与 `git push -u -f` 是同一个命令，旧判据把 `-uf` 当一个词元，规则里的 `-f` 对不上、子串判据也落空，实测 `git push -uf` 与 `git commit -n` 双双静默放行——与引号变体是同一个洞的第二张脸。命令侧与规则侧同时展开，`rm -rf` 规则也才判得中 `rm -fr`。
  - **ask 仍可被项目侧整体接管**（ask 只是多问一句，由项目自定是合理的；不写 `ask` 键则回退内置默认）。
  - 想放宽地板只能由**人**在宿主侧关掉这个插件的 hook，不提供项目内配置位——这是刻意的：治理引擎的门不该由被治理的仓库拆。
- **git hooks**（init-engine 安装到 `.git/hooks/`，任何宿主生效）：pre-commit / pre-push 执行 check-loop 硬门；卸载 = 删除两个钩子文件，种子正文在 `config-templates/githooks/`。

不支持对应 hook 约定的宿主自动降级为 git hooks 单层拦截，硬门语义不变（见「宿主与 hook 降级」）。

三平台 hook 注册差异（机制事实）：`.zcode` 读插件 `./hooks/hooks.json` 拉起 PreToolUse 风险闸；`.codex` 由 `.codex-plugin/plugin.json` 内联同一段 PreToolUse；`.omp-plugin/` 仅为市场清单，未注册任何 hook——`.omp` 宿主不拉起 PreToolUse 风险闸，拦截靠 init-engine 装入 `.git/hooks/` 的 pre-commit / pre-push 兜底（即上句的单层拦截形态）。

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

退出码三态：`0` = 全绿（含 `--list`）；`1` = 有门红或 verify 运行时崩溃；`2` = 用法 / 门表契约违规（互斥参数、门表被裁剪出依赖孤儿、引擎门缺适用性判据等——verify 自身拒跑，不带病出凭证）。

## 工程准入与验收

- 冒烟：`node test/smoke.mjs`（清单版本位 + MCP 7 工具探测）；
- 全量：`test/` 全部套件逐个可跑（CI 逐行接线）；设计文档 §10 十条验收断言收口在 `test/acceptance.mjs`（黑盒、全走 CLI/stdio 入口），样板仓端到端闭环在 `test/e2e-fixture.mjs`；
- 实现收口记录（v2.3 → 0.1.0 落地偏差与裁决）见设计文档 `design/ai-native-delivery.md` §12。

## 项目侧约定（插件不附带）

`commands/` 与 `skills/` 里会提到下面这些路径，但它们属于**使用项目的资产**：插件不附带、`init-engine` 也不生成。首次接入的项目自行准备；缺失时按"按项目实际约定执行"处理——门禁脚本对项目侧目录一律"存在才守护"（`scripts/check-scripts-syntax.mjs`），不会因缺席判红。

- `.agents/notes/runtime-env.md`（`§6.1` 探活脚本、`§6.1b` 端口表等）——`commands/test.md`、`commands/deploy.md` 与若干门禁脚本的说明会指向它
- `scripts/verify/e2e/harness.mjs`、`scripts/verify/e2e/ports.mjs`——`verify-ui` 的 UI 实测单源与端口字面量单源
- 数据库访问技能提供的 python 脚本（如 database-explorer 的 `db_tool.py`），路径由宿主的 skill 目录映射决定

## 版本变更

**0.1.19**

装户层重构：初始化拆 plan/apply 两段式，落盘文件全部记入 sha256 安装台账（`.agents/install-manifest.json`），升级（未改种子自动 update）/ 领养（旧版 init 过的项目首跑只记录不覆盖）/ `--dry-run`（零写盘预览）/ `--force`（覆盖用户改动）通道落地；宿主三垫片改单源生成（`scripts/gen-host-manifests.mjs`，`--check` 漂移门接入 CI）；新增 `scripts/doctor.mjs` 安装健康自检（7 项，✗ 附修复命令）。

**0.1.18**

删除 Shipyard.Material 来源声明：`NOTICE-ORIGIN.md` 移除，plugin.json / README / 设计稿中的来源句清除。

**0.1.15**

审查 25 条 Minor 全量收口（行为改动均补/改写测试钉住）。

- **门禁判据根治**：s01 红线判低由「措辞枚举」改「结构判据」——触达红线节内勾选任一选项即触达（模板文本单源），旧措辞正则降为第二信号；「同义改写即逃逸」的 workaround 面消失。grade-task `\bauth` 收紧不再吞 author；check-lane-surface `/main$/` 锚定路径段；check-pr-size 拒全匹配 freePatterns 自我禁用；s23「人工」判据需走查日期（缺则 WARN「人工无凭据」，advisory 不阻断——存量空「人工」行会新增此告警）。
- **MCP/协议**：坏 JSON 行回 -32700（此前静默吞帧）；id 有限性双闸（server+protocol 同族两处，`1e999`→Infinity 不再回包成 null）；子进程信号杀归 `not-executed`（三态语义收口）。
- **风险闸降噪**：findProjectRoot=null 的降级出声；BashOutput/KillShell 等宿主辅助工具静默放行（每次转 ask 的弹窗噪音消除）。
- **台账/数据**：confirm-doc 活文档门 fail-closed（检查器崩溃不再放行关单）；TEST_NOW 双条件；JSONL 读点 BOM 剥除×4；read-context 坏行计数出声；锁释放 claim-rename 原子化；rewrite-file 台账面持锁+写前指纹；`__proto__` 空原型；退役月锚统一 UTC。
- **健壮/安装**：spawn 超时族 12 文件接线 GIT_TIMEOUT_MS（gitleaks 独立 120s）；gitignore 种子补确认账锁；warn 明细迁 `.agents/tmp/`；commands/agents skills 指针加插件形态回退；mechanism-registry 补「」规则名；裸 `'git'`×3 归 GIT 常量。

**0.1.14**

2026-11-08 专项审查收口：4 Critical + 14 Major 全修，全程 TDD、真实 hook 探针端到端验证。

- **deny 地板补全同族变体**（C1/C2）：长选项无歧义缩写（`git reset --har`、`--no-veri`）经 tokenHit 双向前缀归一拦截；反斜杠/caret 转义（`git push \-f`、`^-^f`）在 unquote 层剥除——0.1.10/0.1.12 两轮修复后仅存的两张绕过脸收口，探针矩阵 20/20。
- **台账主写面锁族**（C3/C4+M2-M7）：loader 主路径与 MCP confirm 追加共持 `<confirmations.jsonl>.lock`、compact 整写入锁；splitMain/分片/agg --write 改 tmp+rename；锁接管须持有者已死；悬挂 symlink 逐段 lstat 拒；create 分支入锁。
- **凭据与锚定**（M8-M14）：豁免标记行首锚定（stage-gates/s14，堵 s08 同族）；gitleaks 缺装记入 envSkips 失去全量锚；项目侧桩替换凭证同失全量锚资格（pluginStubSkips）；check-local-gates/gen-workflow-metrics 三处 ROOT 锚定；init-engine 陈旧钩子刷新改锚插件名（版本化缓存布局下 basename 是版本号）；mechanism-registry 执法点口径按实改写。标量 JSON stdin 转 ask（M1）。

**0.1.13**

审查 Minor 批量收口：六单元 ~35 项，另 4 项评估不修（回归证据宽匹配与 quote 8 字锚属已声明设计上限、workflows-check 深栈属病态输入、check-schema-residue 口令 argv 属源项目向脚本）。

- **服务层收尾**：stdin 单行 1MiB 上限（超限 -32700）；MCP 协议版本协商扩三版、`initialized` 带 id 回包；**空 stdin 转向 ask**（与非 JSON 同为 fail-closed，此前静默放行）；appendOnce 探测失败响亮中止（仅 ENOENT 视为新建）；append 后 stat 失败回执降级 `bytesUnknown` 而非误报失败；`fullMs` 封顶 600s（自定预算不再能拖死串行服务）；决策体写出背压 drain+EPIPE 双路收口。
- **check-loop 段**：「存量对账豁免（」须行首独占（嵌进任务描述不再触发整档豁免）；§23 证据路径禁 `..` 段与绝对形态；出账行拼接的外部字符串一律 JSON.stringify 定界。
- **台账族**：合并丢弃末尾崩溃半行、保留原有空行（compact 不再产出被自家门禁拦截的提交）；append 回执区分「新落盘/幂等跳过」；坏行 stderr 大声计数；**非 git 目录 CLI 写侧统一 fail-closed**（bare 仓误诊一并修正，与 MCP 同口径，不再落 cwd）；confirm-doc 文档写改原子（tmp+rename）且**台账先行 + 幂等守卫**（崩溃窗口从死态变为可重跑闭环）；跨源去重改「值与位置同取末次」；fill-* 加存在拒绝/目录围栏/自由文本剥换行；check-ledger-invariant 走 GIT 单源；**锁加固移植 agent-pipelines 模式**（rename 原子接管 + 持有者 pid 已死提前接管 + 释放归属比对）。
- **verify / pipeline-run**：git-core 统一 60s 超时（挂起 git 不再挂死门禁）；`core.quotepath=off` 补齐 pipeline-run/check-scope 两处（非 ASCII 路径不再假红）；`--run`/runId 白名单 + runs 目录围栏（封越界读写）；verify 退出码三态（2=用法错/1=门红/0=全绿）；latestRunId 改 mtime 次序；verify 单门 300s / pipeline 600s 看门狗——**门超时不放行**（fail-closed，事件留痕）。
- **生成器与口径**：engine-map 钩子取数锚 `gitHooksDir()`（插件形态不再恒 0）；gen-workflow-index/metrics 空仓不崩；kb-search 词表缺失带指引、防符号链接环、stat 竞态容错；check-query-contract 缺目录转 advisory；check-pr-size `--base/--head` 拒前导 `-` + 尾置 `--`；**退役窗口两侧统一**（锚最近数据月、连续 N 个日历月含无数据月、遥测停摆 >2 月不产候选）；.gitattributes jsonl-union 契约扩展覆盖 `workflow/gate-metrics.d/`；MCP stats 口径文案同步。
- **文档与模板**：deny 地板正文对齐七项；三平台 hook 注册差异说明（.omp 无 PreToolUse、靠 git hooks 兜底）；verify 三态口径；principles.md 失实自声明改真实口径；engine.json 死配置键删除；deploy.md 悬空指针改自足模板；init-engine WARN 文案；git hooks 模板引擎缺失预检（不再满屏 MODULE_NOT_FOUND）。

**0.1.12**

全量审查（测试 61 套 + 五单元代码审查：1 Critical / 19 Major / ~45 Minor）A→D 组修复：Critical 1 + Major 19 + 装配种子 4 项落地。

- **C1|陈旧钩子迁移刷新失效**：`init-engine` 判「自装钩子」此前用**当前**插件根前缀——宿主缓存升版换目录后 baked 的是旧根路径，前缀恒不中 → 判为第三方 skip，重跑 no-op、commit 持续 MODULE_NOT_FOUND（头注描述的正是该场景，修复条件排除了它）。现改为「路径含本插件名的独立路径段（带分隔符边界，`-old` 后缀不误命中）且引擎脚本已不存在」即刷新；测试改真实迁移形态（旧版目录 baked）+ 反例。
- **服务层六项**（多数移植 systemone-decision 姊妹先例）：deny 地板 `git.exe` 形态绕过（词元归一化剥可执行后缀，一处修双判据）；stdin 挂起 14s 预算 killer 先发 ask 再退出（挂起≠静默放行）；matcher↔内核粘连词尾缝收口（`nushell` 类纳入管辖 + 告警兜底）；协议四道闸（无 id 通知不回包不执行、非法 id/jsonrpc 拒收）；stdout EPIPE 静默退出；schema 类型/enum 协议层执行（`strict_quote:"yes"` 不再静默按 false，unknown tool 改回 -32602）。
- **硬门禁五项**：§1 判低拦截吃行首缩进与「升级至/升至」措辞变体；§15 确认指纹日期兜底回退 git 首加日（无日期+非日期文件名不再整段豁免）；rule-budget 等四门 git 调用 maxBuffer 64MB + ENOBUF fail-closed（>1MB 暂存清单不再静默全过）；泳道面定义与 lane 判定改读 git index/HEAD（工作区仅未跟踪回退，自我豁免面封死）；`policyVersion` 越界不再静默回落 v1 关停门禁——fail-closed 带支持版本列表指引。
- **凭证链 git 锚 + 来源可对质**：verify 落凭证行带 `head`（当时 HEAD sha）与逐门 `gates[{id,exit,src}]`（脚本实际解析路径，项目侧桩替换从此在凭证与入库视图可对质）；消费侧（confirm-doc hard 档 / closeout-l1 预检 / §8 对账）对带 head 的行校验 `merge-base --is-ancestor`，引用不在当前历史的行不认；无 head 存量行兼容放行。诚实定性：抬门槛 + 可对质的半步加固，非密码学终极。
- **台账并发补锁**：compact-ledgers 逐分片持锁收缩（并发确认行不再随 unlink 丢失）；splitMain 全程持分片锁（并发追加不再被整写抹掉）；不变量检查器「第二父创建路径」合并形态不再整文件跳过并集对账（跨父丢行可检出）；pipeline-run run 文件互斥（并发 next 响亮失败）+ writeConfirmation 走分片锁——锁统一 `withLedgerLock` 单源。
- **装配种子四项**：断链的 `commit-check.config.json`「单源」指针改真实口径；制造域词表（material/mto/inventory…）泛化为领域无关示例 + 种子标注（与 NOTICE 脱敏红线对齐）；源项目预算行改注释示例；两个源项目运行 manifest 不再随 init 种子（保留为格式样例）。
- 验证：五单元均失效测试先行（RED→GREEN）；全量 61 套测试门禁全绿。

**0.1.11**

- **台账写入不再随真实日历漂移**：`confirm-doc` 的四处台账 `ts` 改用与关单门同一个可注入时钟（`CONFIRM_DOC_TEST_NOW`），workflow 归档的目的地月不再跟着跑测试那天的月份走。此前每到新的一个月，`confirm-doc` 与 `acceptance` 两道 CI 门会同时变红。
- **台账并发追加不再丢行**：`ledger-shards --append` 走的是读-改-写整写，多进程并发时后写者用陈旧快照覆盖，丢行却回成功。现在文末追加改 `appendFileSync`、分片创建改独占、分节插入加指纹校验与重读重试，并与 MCP `update_ledger` 共用一把 `<分片>.lock` 写锁（拿不到锁即响亮报错，不降级成无锁写）。
- **deny 地板补短选项簇**：`git push -uf`、`git commit -n` 这类合写短路了"不可下调的 deny 地板"——`tokensOf` 现在展开短选项簇（命令侧与规则侧都展开），地板同时补 `git commit -n`（push 的 `-n` 是 dry-run，有意不加）。
- **陈旧自装 git hook 自动刷新**：插件安装目录迁移后，钩子里 baked 的引擎路径失效会让 commit 崩在 `MODULE_NOT_FOUND`，而钩子提示的"重跑 init-engine"此前是 no-op；现在只刷新"本插件装且引擎脚本已不存在"的那一类，别人的钩子仍不覆盖。
- `verify-ui` 里写死的用户主目录路径改为宿主中立表述；`.gitignore` 种子增台账写锁的临时文件。
- 文档补"项目侧约定路径"边界：`commands`/`skills` 里指向的 `.agents/notes/runtime-env.md`、`scripts/verify/e2e/*` 属**项目侧**文件，插件不附带也不生成。

**0.1.10**

- **`type: module` 项目的 git hooks 崩溃修复**：hook 由 shell 启动、按 CommonJS 解析时不再因包内 `"type": "module"` 报错。
- §23 收敛审计的命令白名单可经 `engine.json` 配置（`convergenceCommands`），不再写死。
- **风险闸 fail-closed 收紧**：任何异常转 `ask`（此前静默 exit 0 会凭 hook 自身故障放行本该命中 deny 的命令）；deny 取"内置地板 ∪ 来源追加"，被治理项目只能加严。
