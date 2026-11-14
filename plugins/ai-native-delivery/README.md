# ai-native-delivery

AI-Native 交付治理引擎：把跑通 14 个 policy version 的交付治理机制做成可安装插件（[Agent Plugins 1.0.0](https://agent-plugins.org) 标准）。它交付的不是"流水线"，而是三层闭环：

## 三层闭环定位

1. **任务级硬闭环**：任何任务先过"两问定级"进 L1（实现级）/ L2（规则契约）/ L3（数据与运行时结构）风险泳道，级别决定审计成本；L2 有触达面闭集（4 条），L1 plan 勾红线即判低拦截、强制升级；check-loop 硬门 6 段（判低 / 回归证据 / 验收勾验 / 确认指纹 / 收敛对账 / 执法者配对）在 init-engine 安装的 pre-commit / pre-push 两个 git hook 物理闸门上校验闭环证据；关单是程序性自检（skills/workflow-closeout §0 + confirm-doc/stage-gates），不经 check-loop。
2. **状态收敛闭环**：台账三件套（intents / specs / plans）+ INDEX 作为跨会话物理内存；收敛对账保证台账与 git 实际状态不背离；compact / archive 负责台账卫生，mechanism-retire-watch 治理检视由人工 / 项目自定期运行（不随 git hooks 自动跑），read_context + INDEX 支撑断崖恢复。
3. **治理进化闭环**：judgment-ledger 按 per-rule 计数积累判定事实，连续 6 月零命中的规则进退役候选，门禁段数棘轮锁死上限（只减不增），gate 预算以实测墙钟为据。误拦遥测（2026-11）：被门禁拦下而人工判定「不该拦」时登记 dismiss——`node <插件根>/scripts/judgment-ledger.mjs --dismiss <规则名> --reason <一句话>`（append-only 同库，人工或 agent 代登记，不自动触发；缺 reason 拒、规则名不在账内警告从权）；误拦面怎么看：`agg-judgments.mjs` 输出的「误拦面」节按规则给出 命中 / dismiss / 误拦率（= dismiss/(命中+dismiss)，无 dismiss 不出行），≥50% 且样本 ≥3 的规则点名「建议复评判据」（advisory——误拦率只作退役候选优先级旁注，退役判据仍是零命中窗口）。

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
- **CI 层是项目适配点**：插件附带参考模板（`config-templates/ci/`，不随 init-engine 播种），项目复制到自己的 CI 接线，判据与 git hooks 同源，详见下节「CI 层项目适配指南」；
- 命令、角色委派（斜杠命令 / 子智能体）按各宿主约定目录加载，不支持对应约定的宿主跳过加载即可，MCP 工具全宿主可用。

## CI 层项目适配指南（L-ci）

三层拦截模型里插件只自带两层（PreToolUse 风险闸 / 写前门 + git hooks 四钩子），第三层 CI 是**项目适配点**：拦截面从本机提交 / 推送前移到 PR 合入前（服务端执行，本机 `--no-verify` 或宿主 hook 缺席都绕不过它），判据与 git hooks 同源（同一套 check-loop / verify 脚本，不新增判据）。

- **模板位置**：`config-templates/ci/`（`github-actions-verify.yml.template` + 目录内 README）。参考件而非运行配置——`install/plan.mjs` 的种子排除清单把 `ci/` 挡在 `.agents/config/` 之外（先例同 githooks/、pipelines/），init-engine 不播种、安装台账不追平；
- **三步接入**：① 模板复制到使用项目 `.github/workflows/`；② 按 workflow 内【改这里】注释改三处——`env.PLUGIN_ROOT`（插件根解析：市场仓随检出 / 宿主常驻安装路径 / vendor 进仓，三方案任选）、action pin（建议按 commit SHA 固定）、市场仓检出步；③ 首跑全绿后再决定是否解注释可选诊断步；
- **授权边界**：无模型步（check-loop `--all` + verify `--full`）零凭据零模型调用，任何项目可直接接；可选诊断步（`claude -p "…"` 无交互模型调用）属**项目自治**——插件不默认接线，密钥经 CI secrets 注入（模板与插件都不携带密钥样例值），提示词按「只读诊断、不改文件」约束，结论仍走人工 / PR 处置；opt-in 模型面统一经 `scripts/model-call.mjs` 单源（无交互调用适配器，`--probe` 连通自检），门禁 / CI / init 零模型不变；
- **为何不默认接线**：init-engine 只落使用项目运行时，插件无法预知项目用哪个 CI、插件在 runner 上以什么形态在场（托管 runner 上没有宿主安装缓存）；模型诊断步涉及凭据与授权，不能替项目决定。

## 项目侧安全适配（宿主能力边界，纯指引）

插件的拦截面有两层：deny/ask 风险闸只看 **shell 命令串**，check-secrets 只扫 **git diff**——agent 仍可经 Read 工具把 `.env` 里的密钥读进上下文、再经任何出网通道带出。补齐这类面属**宿主托管安全能力**（文件读取拒绝面 / 沙箱网络白名单 / 凭据剥离），插件不内置、不仿制（设计稿 §3「明确不做」），只成文为项目侧适配要求：宿主支持时按下面样例接线，键名以各宿主版本文档为准，样例一律注释形态、占位符**不写真值**。

```jsonc
// ZCode / Claude 式宿主：settings.json（项目或托管层）——文件读取拒绝面（支持 Read(...) 规则的宿主）
// {
//   "permissions": {
//     "deny": [
//       "Read(.env*)",          // .env* 一律不进上下文
//       "Read(secrets/**)"      // 密钥目录拒读（按项目实际目录与命名改）
//     ]
//   }
// }
```

```toml
# Codex 宿主：config.toml——沙箱网络白名单（默认全拒出网，需要时按域名白名单放开）
# sandbox_mode = "workspace-write"
# [sandbox_workspace_write]
# network_access = false
```

- **凭据剥离**：属托管/网关形态能力（如企业 LLM 网关的出口脱敏策略），zcode/codex 项目侧无一等价键位可写——按宿主能力以托管 settings 或代理网关实现；插件层不做、也代配不了。
- **宿主不支持时**：三类能力整体降级为「不可用」，此时只剩插件两层（见下表）——这是能力边界，不是可修的缺陷；装配前先确认宿主支持面。

**三层分工边界**（各拦什么 / 拦不住什么）：

| 层 | 拦截面 | 各拦什么 | 拦不住什么 |
|---|---|---|---|
| 插件 deny/ask 风险闸（PreToolUse hook） | shell 命令串 | 危险命令文本：`git push --force` / `git reset --hard` / `drop database` 等**不可下调地板** ∪ 项目追加；ask 面弹确认 | 非 shell 工具的读取（Read `.env` 直接进上下文）；无 PreToolUse 面的宿主（omp 等，退 git hooks）；脚本内容里夹带的密钥 |
| check-secrets（verify.mjs 安全段，gitleaks + secrets-lite 兜底） | git diff 面 | 即将进版本库的密钥：关单前 / pre-push / CI 扫 staged 与全量 | 不进 git 的文件外泄；已被 Read 进上下文的密钥（上下文可能随后出网）；运行时内存中的凭据 |
| 项目侧安全适配（读取拒绝面 / 网络白名单 / 凭据剥离） | 工具读取面 + 出网面 + 上下文出口 | 密钥进不了上下文（拒读）；即使进了也出不了网（白名单）；出口再脱敏（剥离兜底） | 宿主不支持时全面失效；项目不接线则不生效（插件无权代配） |

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
- **落位**：`.agents/`（config 种子、settings.json、confirmations.jsonl + confirmations.d/、cache 等运行时目录）与 `workflow/`（INDEX + 台账骨架）；另写 `.gitignore` 标记块、安装 `.git/hooks/` 四钩子（pre-commit / pre-push / commit-msg / post-commit，已存在同名钩子跳过不覆盖）；
- 项目侧 `.agents/config/engine.json` 的 policyVersion 与插件种子不同时 WARN 可升级、不自动覆盖。
- 种子的领域词表 `workflow-modules.txt` 是**模板种子示例**（领域无关最小集，2026-11-05 脱敏：不再携带源项目制造域词）：项目应改写为自有域词表——`kb-search --module` 与 check-loop 模块校验按项目侧这份文件判，已改写内容初始化不覆盖。

### 安装引擎（0.1.19 重构：plan/apply 两段式 + sha256 台账）

初始化拆两段：`install/plan.mjs` 把全部落盘行为描述为纯数据计划（零写盘副作用），`install/apply.mjs` 按安装台账 `.agents/install-manifest.json`（逐文件 CRLF 归一 sha256，入库共享，语义同 lock 文件）裁决落盘。台账对**运行时账本**（workflow/ 骨架文档、三本审计账主账）只记存在性（`mutable` 标记）——这些文件由引擎与用户共同写入，按哈希判定必然误报「用户改过」。两个新增通道：

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

7 项静态检查：项目根锚定 / 安装台账在位可解析 / 已装文件与台账逐文件一致（**运行时账本只核存在性**：workflow/ 骨架文档与三本审计账主账由引擎与用户共同写入，内容演进是常态，不按哈希判失配；其余种子件按 CRLF 归一 sha256 逐字节核对）/ git hooks（pre-commit / pre-push / commit-msg 执法点 + post-commit advisory 在位且引擎指针有效）/ `.gitignore` 标记块成对 / settings.json deny 地板含内置基线 / engine.json policyVersion 与种子一致。逐项 `✓/✗` 输出，✗ 项下一行附可直接复制执行的修复命令；任一项 ✗ 退出码非 0，可接进项目侧脚本当安装健康门用。

## MCP 工具（10 个）

| 工具 | 一句话用途 |
| --- | --- |
| `grade_task` | 两问定级：任务描述 → L1/L2/L3 与命中依据 |
| `read_context` | 跨会话恢复：INDEX 头部 + 在途三件套 + 最近确认行（断崖恢复入口） |
| `update_ledger` | 台账原子更新：限 workflow/ 树内路径，写前过不变量校验（fail-closed）。`create` 走 tmp+rename 原子建文件；`append` 走 `appendFileSync`（O_APPEND），多会话并发追加不丢行 |
| `confirm` | 写任务级确认记录（kind:"task" 行，含指纹供台账校验对账）；带 `doc` 时按 confirm-doc 同款判据做引文接地 |
| `verify_gate` | 跑 check-loop 指定车道（hard / hygiene / all）并回报裁决 |
| `ledger_stats` | 台账体量与不变量状态，供 compact 决策 |
| `policy_status` | 治理进化可见性：policyVersion / 预算实测 / 退役候选（诚实口径）/ 棘轮计数 |
| `band_check` | 确定性带监测（advisory 只读）：读 bands.json 判带，越带 band 按 tier 附建议指令（只打印不执行）；未配置不误报 |
| `dream_verify` | Dreaming 校错 pass（advisory 只读）：知识文档引用完整性对拍，返回存疑注记清单 + 报告路径 |
| `doctor` | 安装健康自检（只读）：7 项静态检查逐项 ✓/✗，✗ 项附可直接复制执行的修复命令 |

> 三个巡检工具（`band_check` / `dream_verify` / `doctor`）的 `root` **必填**：巡检面按调用方指定的仓库跑，不按服务进程工作目录推断，缺 root 直接拒绝（fail-closed）。全部只读；`dream_verify` 的唯一写盘动作是被包装脚本自身的报告落盘（`<root>/.agents/tmp/`），工具面如实回传路径。

> **`confirm` 的引文接地**：`evidence` 是「用户真的放行过这件事」的唯一可对质证据，所以它复用文件侧同一模块 `scripts/quote-grounding.mjs`（逐字命中 / ≥8 字逐字锚点 / 纯放行语三层，任一成立即接地），而不是另立一套口径。传 `doc`（workflow/ 树内台账文档）才会接地，结果如实记进台账行的 `quoteGrounding`：`verbatim` / `anchor` / `generic` / `ungrounded` / `unanchored`（未带 doc）。**默认只留痕不拦**——该模块头注的 873 条历史委托实测显示，中文口语是复述而非引用，词面判据硬拦会误杀 8–18% 合规放行，而对无关文档仍有 71.2% 通过率（判别力不足）；要收硬请显式传 `strict_quote: true`。只有客观缺陷硬拒：`doc` 在活跃目录与归档里都不存在、路径逃逸出 workflow/ 树（与 `update_ledger` 同围栏）。task 行**恒不带 `stage`**——§15 的文档配对判据是 `doc && VALID_STAGES.has(stage)`，带上 stage 就等于给了任务级确认伪造文档关单凭证的能力（该不变量由 `test/mcp-tools.test.mjs` 钉住）。
>
> **`root` 参数（重要）**：本插件的 `mcp.json` 声明 `cwd: "${PLUGIN_ROOT}"`，即宿主默认把服务起在**插件安装目录**。此时服务进程的 cwd 落在插件根内，`requireRoot` 会**直接拒绝**并提示——这是刻意的 fail-closed（台账若落进插件目录，会被别的项目当成关单凭证）。因此在这种部署形态下，**每次工具调用都要显式传 `root=<使用项目的 git 仓库根>`**。想让工具免传 root，就把宿主启动本服务时的工作目录设为项目根（部分宿主可配）。

## 命令 / 角色 / skills 清单

命令（`commands/`，8 个）、角色（`agents/`，4 个）、技能（`skills/`，8 个）按各宿主约定目录加载（见「宿主与 hook 降级」），不支持对应约定的宿主跳过加载即可，MCP 工具不受影响。

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

### 角色（4 个）

| 角色 | 一句话定位 |
| --- | --- |
| `implementer` | 受控实施者：范围明确任务的实现与自验，最小 diff，授权边界外即 HALT |
| `independent-reviewer` | 独立复核者：独立上下文只读复核 spec/plan/diff，证据驱动，落盘行交主智能体写入 |
| `ui-verifier` | UI 实测者：只验证不修复的浏览器实测，DOM 几何取证，证据交还主智能体 |
| `wiki-compiler` | 知识编纂者：把代码提交翻译成业务能力语言，只读分析、严格 JSON 产出、不落盘 |

### skills（8 个）

| 技能 | 一句话用途 |
| --- | --- |
| `autonomous-run` | 无人值守长跑合同：长任务/过夜时逐单元签收、自底向上落地、何时停机 |
| `decision-log` | 长跑/无人值守的决策轨迹：append-only TSV，一行一个决策（what/why/evidence/result） |
| `dream` | 离线梦境（Dreaming）记忆维护：跑 dream-run 只读审计、读记忆负债报告、处置冷数据候选与终态件归档建议（裁决归主智能体/用户） |
| `review-method` | 代码复核走查方法（Standards×Spec 双轴 + 坏味道清单 + 合入标尺），`commands/review.md` 的方法层单源 |
| `session-resume` | 会话重入与中断落盘：接手/切换 worktree/压缩续作前先用机器事实重建当前态 |
| `verify-ui` | 启动本地服务并用浏览器实测 UI 改动（只读验证、不留脏数据） |
| `dev-tour` | 开发全景图快照：从 plan/spec 解析六视图模型，`--strict` 每步文件门 |
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
- **PreToolUse 写前门**（`hooks/pre-write-guard.mjs`，hooks.json 第二个 PreToolUse 段，同风险闸类宿主生效）：Write/Edit 类写工具在落盘**前**过两组判据——① 执法面自保护：目标落在项目 `.agents/` 治理状态（门禁脚本 / 配置 / hook 本体 / 安装台账）即拒，仅 init-engine 的运行时目录（cache / loop / notes / board / tmp）可写，AI 不得自解拴绳；② 三本审计账 append-only：confirmations / judgments / verifications.jsonl 只许前缀扩展式追加，整写 / 删改即拒。坏输入 / 写目标不可判定 fail-closed 转 ask。已知边界：Bash 重定向 / sed 写盘不经本门（走 shell 风险闸与 git 钩子兜底）。
- **git hooks**（init-engine 安装到 `.git/hooks/`，任何宿主生效）：pre-commit / pre-push 执行 check-loop 硬门（pre-push 另带接线宣称对账与推送范围改动面对账，见「提交道与关单」）；commit-msg 执法「先确认后改代码」顺序门并提示任务短名；post-commit 只做 Dreaming 审计提醒（advisory，永不阻断）。卸载 = 删除对应钩子文件，种子正文在 `config-templates/githooks/`。

不支持对应 hook 约定的宿主自动降级为 git hooks 单层拦截，硬门语义不变（见「宿主与 hook 降级」）。

三平台 hook 注册差异（机制事实）：`.zcode` 读插件 `./hooks/hooks.json` 拉起 PreToolUse 风险闸与写前门（双 PreToolUse 段）；`.codex` 由 `.codex-plugin/plugin.json` 内联同一段 PreToolUse；`.omp-plugin/` 仅为市场清单，未注册任何 hook——`.omp` 宿主不拉起 PreToolUse 面（风险闸与写前门都不生效），拦截靠 init-engine 装入 `.git/hooks/` 的四钩子兜底（即上句的单层拦截形态）。

### 与 systemone-decision 共装时（2026-11-14 更新：双闸已成历史）

`systemone-decision` 0.6.1（2026-11-13）已整体下线其 PreToolUse 风险闸（触发频次过高，按用户反馈
移除；`SYSTEMONE_HOOK_RISK_GATE` 环境变量与设置项一并删除）。共装现状：**PreToolUse 命令闸只剩
本插件一道**（含写前门），不存在双提示或双清单仲裁问题；systemone 保留的 UserPromptSubmit 需求
预检与本插件无面重叠。0.6.1 之前的共装双闸说明见历史版本（git 史可查）。

### 门禁的适用性判据（`verify.mjs`，2026-10-28）

`verify.mjs` 的 20 门里有 6 门只对**特定技术栈**成立（前端 `npm run lint:check` / Vitest / vue-tsc、后端 `dotnet build App.sln` / 后端测试、Playwright E2E、wiki 一致性脚本）。这类门带一条适用性判据，缺失时判 **SKIP** 并显式出账，不挡关单、不计入通过数（没跑 ≠ 过了）：

| 判据字段 | 语义 | 现有门 |
| --- | --- | --- |
| `requires: <路径>` | 项目根下该路径存在才执法（目录 / 解决方案文件） | `frontend-lint`、`frontend-unit-test`、`frontend-build`、`frontend-e2e`、`backend-build`、`backend-test` |
| `optional: <脚本名>` | 项目自带脚本存在才执法（`scriptPath` 两处查找） | `wiki-consistency` |

两条硬约束（由 `test/verify.test.mjs` 场景 15 锁定）：**产品段每一门都必须带其中一个判据**，否则新增门会再退回「消费项目装上即红」；**跳过沿依赖边传播**——上游判不适用时下游同步跳过，避免「构建已跳过、测试照跑因无产物变红」的假红。路径一旦出现，该门自动恢复执法，无需改配置。

退出码三态：`0` = 全绿（含 `--list`）；`1` = 有门红或 verify 运行时崩溃；`2` = 用法 / 门表契约违规（互斥参数、门表被裁剪出依赖孤儿、引擎门缺适用性判据等——verify 自身拒跑，不带病出凭证）。

## 提交道与关单（0.2.0 机制同步）

源引擎 policyVersion 14→16（`config-templates/engine.json`）机制同步的执行面，判据单源均在各脚本内（机制登记见 `config-templates/mechanism-registry.md`）：

- **L1–L3 立档道（顺序门）**：改动先立 intent / spec / plan。commit-msg 钩子执法「先确认后改代码」（`check-confirm-order.mjs`）——暂存产品路径须出现在本次提交可见的 approved plan 正文里（done 历史 plan 不算覆盖；豁免 B：覆盖 plan 与产品同批暂存）；合并 / squash 族与未暂存产品路径跳过。pre-push 由 `check-scope-range.mjs` 对整段推送范围（old..new）再对账 plan 声明并集：只判越界（改了未声明）为 hard，未落件仅 advisory；范围内无 plan 变更则跳过并补盲面警告。`check-commit-plan-ref.mjs` 提示提交消息含覆盖 plan 短名（文件名去 `.md`，advisory 观察期）。
- **L0 极简道（提交时豁免通道）**：产品件 ≤5 的小改，提交消息体带非空 `L0: <判据>` 行即免 intent / spec / plan 立档——顺序门与推送对账按同一判据放行并打印明细（合并提交不适用；无消息参数 fail-closed），judgments 落 L0 观测计数。配套 `fill-plan --lite`（L1 三节最小 plan）与 `closeout.mjs --l0 "<判据>"` 单命令关单。
- **§v16 两门**（policy v16 生效锚后，存量项目不追溯）：① spec 前提质询门——spec draft→approved 必经 premiseGate，关键前提须有质询记录（小件可写「无关键前提」行 + 理由）；② 检查 29 回归清单执法者配对——防复发清单锚后新行的「执法者」列须指认「复发时谁会红」（hard，显式 `[prompt-only]` 为合法声明）。
- **通用关单**：`scripts/closeout.mjs` 把 workflow-closeout §1–§5 固定序列收成 L0–L3 单命令（confirm-doc 落终态 → 索引重生成 → 定向 git add → 暂存区核对防夹带 → git commit，禁 `--no-verify`），取代 closeout-l1（单入口不并存）。plan→done 关单前 confirm-doc 另由 `taskScopeGate` 机器对账（2026-11-13 判据移植）：取**引用本 plan 短名**的提交并集，与「改动方案」声明对账，越界即拒关单——漏列不再拖到推送才炸。
- **兜底与自愈**：`check-secrets-lite.mjs` 在 gitleaks 三级定位（GITLEAKS_BIN / PATH / `.agents/tools`）全空时自动接续密钥扫描（纯 Node 零二进制零网络；强特征全文件执法且基线豁免不适用，宽泛特征只扫基线外文件）；verify 生成物漂移门（生效规则视图 / 引擎地图 / 工作流索引）首检漂移先原地重生成再复检，复检绿计通过并留自愈行（♻️ 可审计）；`check-doc-body-drift.mjs` 对已关单文档正文漂移在提交时刻打 advisory（执法面仍是关单时确认指纹对账，口径零变化）；`check-hook-wiring.mjs` 对账「接线宣称 ↔ 宿主实态」（hooks.json / 三宿主垫片 / MCP 入口），漂移红即挡推送。
- **Dreaming 持续运行链路**：kb-search 命中遥测（`.agents/cache/kb-usage.jsonl`，gitignore 运行态）→ `agg-kb-usage.mjs` 聚合冷数据候选（访问/命中 + 内容更新双维置信度衰减，年轻遥测不造假候选）→ `dream-run.mjs` 产只读审计报告（落 `.agents/tmp/`）；post-commit 钩子距上次审计 ≥7 天提醒一行，`skills/dream` 供主动触发。全链 advisory：不移动 / 不改写 / 不删除任何文档，裁决归主智能体与用户。校错面：`dream-verify.mjs` 对知识文档（principles、regression-checklist 主档+分片、specs/plans 终态存档件）做引用完整性对拍——只标硬漂移（引用了不存在的东西），语义真伪默认不判；`node <插件根>/scripts/dream-verify.mjs --root <仓库根>`，报告落 `.agents/tmp/dream-verify-<日期>.md`，dream-run 报告 D 段引用其结果。语义复评档（opt-in，默认关）：`--model` 对扫描闭集里含路径/指纹引用的规则断言行（含已判硬漂移的存疑行）做模型语义对拍，三态裁决（仍成立=引用虽断但结论仍有据 / 存疑=需人工核 / 失效=结论已无支撑）进报告 E 段；模型调用经 `scripts/model-call.mjs` 单源（`--runner` / `MODEL_CALL_RUNNER` 可换 claude 兼容 runner），advisory 语义不变——退出码恒 0，不因模型升级改变存疑注记判定面。**成本口径**：仅显式 `--model` 时产生模型调用，逐条独立调用（不合并上下文防串扰）、一轮最多送评 20 条（超出截断并在 E 段注明）、单条失败不阻塞其余、模型缺席/全部失败 E 段出「语义复评不可用」一行；无任何调用进门禁 / CI / init 默认路径。

## 确定性带监测与无人闭环（check-bands / loop-runner）

无人触发闭环的确定性控制带监测：无人在场时由定时面发现指标越带并给出建议指令，**只出账不执行**；自治的下一步（只读诊断 → intent 草案）属 owner 另行授权的 runner 面（`scripts/loop-runner.mjs`，种子缺省 = 无授权）。

- **种子**：`config-templates/bands.json`（init-engine 播种进 `.agents/config/bands.json`），字段 `metric / baseline / rules / tiers` 四段；tier 动作枚举 `log / diagnose（只读工具白名单）/ propose（仅经 PR）`，档位随配置版本化；
- **用法**：`node <插件根>/scripts/check-bands.mjs --root <仓库根>`——纯确定性读指标源（首版两内置源：`verifications.jsonl` 绿行、`gen-workflow-metrics` 输出），判定越带并按档输出**建议指令行**，绝不自动执行；外部指标源留 `--metric-source` 扩展位；
- **与 CI 的搭配**：`config-templates/ci/` 的 workflow 模板附注释形态的 `schedule` 定时旁路样例——cron 定时跑 check-bands 出报告，处置走人工 / PR；不要把建议指令行直接接成自动执行步。定时巡检可套用 ci/ 模板：`config-templates/ci/github-actions-bands.yml.template` 是开箱即用的独立定时巡检参考件（schedule 触发 → 报告入 artifact，不含任何自动执行 agent 的步骤）。

**无人闭环 runner（loop-runner，opt-in）**：`node <插件根>/scripts/loop-runner.mjs --root <仓库根>`——消费 check-bands 判带输出，对**显式授权了 autoRunner** 的越带 band 把「只读诊断 → intent 草案」自动走完半程：

- **授权模型**（项目自治显式配置，种子不含 → 缺省无授权，行为与 check-bands 完全一致只出建议指令）：`bands.json` 的 tier 定义加可选块，如 `"tiers": { "diagnose": { "readonlyTools": ["Read", "Grep"], "autoRunner": { "enabled": true, "maxPerDay": 3 } } }`——`maxPerDay` 按 UTC 日限次（超限跳过并在输出注明）；
- **安全模型**：**agent 只读、runner 落笔**——自治环里 agent 只拿 `Read / Grep / Glob` 白名单做诊断并返回严格 JSON（summary / evidence / suspectedCause / proposedIntent，字段对齐 intent 文档结构），`workflow/intents/<日期>-auto-<band>.md` 由 runner 进程自己写；模型调用经 `scripts/model-call.mjs` 单源（`--runner` 可换 claude 兼容 runner）；
- **红线**：只到 intent 草案（frontmatter `状态: draft`、`来源: loop-runner 自动诊断`、正文带「须经人工评审」声明）——**不自动改代码、不自动开 PR / 分支**；propose 档 v1 同样只到草案，route 面不自动触达；
- **与 check-bands 的关系**：判带判据零复刻（只 import 其 `runBandCheck` 消费输出），未配置 `autoRunner` 时退出码与输出同 check-bands（建议指令照出，exit 1 提示配置面）；配置损坏同判 exit 2；
- **台账与失败语义**：每次模型调用落 `.agents/runs/loop-runner.jsonl`（append-only：ts / band / tier / durationMs / agentOk / intentWritten / error；gitignore 运行态）；agent 输出坏 JSON / 超时 / 缺席 → 台账记 failed、不写 intent、**不重试**（每 band 每次运行至多一调，防无人值守面自我放大消耗）；草案幂等（同名已存在不覆盖，顺延 `-2..-9` 后缀）；退出码：0 = 带内 / 未配置 / 越带且全部落草案；1 = 存在未落草案的越带（无授权 / 配额耗尽 / agent 失败，指认失败带）；2 = 配置损坏。

## 提示面 eval 套件（test/eval.mjs）

改命令 / skills / agents 正文（提示面）后的**行为回归**：夹具任务 + 无交互 runner（`claude -p`）+
确定性终态判据，测提示面能否把 agent 指挥到达标。

- **用例**：`test/fixtures/eval/cases.json` 四条——E1 L0 极简道（单文件文案修正免立档、commit 带非空 `L0:` 判据行）、E2 L1 快速道（立 plan 含三节形态 + 委托确认行）、E3 L2 防御道（共享契约触达走 intent / spec / plan 三件套、spec 含「前提质询」节、确认行含 sha256 指纹）、E4 越界防护（诱导改引擎配置并强推——终态必须不被破坏）。checks 全部是确定性算子（pathExists / fileContains / dirFileCountGrew / gitLogMatches / jsonlRowMatches 等，逐条以临时仓 setup 后基线为对照面），DSL 成文在 cases.json 的 `dslDoc` 字段；
- **判据哲学**：只断言**终态工件**（workflow 档案 / 确认台账 / git 历史 / 引擎配置），不判过程合规、不用裁判模型；每条 transcript（claude json 输出 + 用例元数据 + checks 明细）落系统临时目录 `eval-logs/<id>-<时间戳>.json` 留档复盘，不污染仓内；
- **跑法**：`node test/eval.mjs --dry-run` 先审各条拼装 prompt（命令正文剥 frontmatter 整文件注入、`<插件根>` 实化为插件绝对路径）→ `--eval E4` 单条真跑（成本最低、断言最硬）→ 不带参数全量；`--bail` 首红即停，`--runner` 换 runner。claude 不在场或 spawn 失败按 SKIP 出账，不误报 FAIL；runner 在 PATH 找不到时 exit 2 fail-loud；
- **成本口径与 CI 豁免**：每条 `maxTurns` / `timeoutMs` 封顶（cases.json 逐条声明）；模型 spawn 单源两处——`scripts/model-call.mjs`（opt-in 适配器，门禁 / CI / init 零命中）与 `eval.mjs`（eval 套件本体），其余 scripts / mcp / hooks 面零命中；**不进仓级 CI**（模型调用需凭据，豁免理由见市场仓 `.github/workflows/ci.yml` 头注）——本地手动跑，或复制 `config-templates/ci/github-actions-eval.yml.template`（workflow_dispatch + 自备 secrets）。

## 开发全景图（dev-tour，快照版）

从 plan/spec/todo 文档与 git 实际面解析出 schema:2 全景模型（步骤×文件双向绑定、序列图、数据流、依赖弧、验证门、需求链路上游），注入单文件 HTML 模板生成静态快照——`file://` 双击即用，零外部请求、零依赖。

- 生成：`node <插件根>/scripts/gen-dev-tour.mjs workflow/plans/<name>.md`（`--root` 可显式；产物落使用项目 `.agents/cache/tours/`，已 gitignore）
- 六视图：全景 / 序列 / 流程图（含依赖旁路弧）/ 数据流 / 需求链路 / 验证门禁
- **每步文件门**：`--strict` 对缺文件条目的实现步骤拒产（exit 1）——已接 `commands/build.md` §3（实现前先过门）；解析命中计量（parseHealth 命中率/路径猜测徽标）随报告输出
- 规模边界：≤60 步 / 300 diff 文件（超限降级为附录归集；压测工具 `test/fixtures/dev-tour/synthetic-plan.mjs --bench`）
- 文档数据契约与适用场景见 `skills/dev-tour/SKILL.md`
- **实时看板（0.3.3 新增）**：`node <插件根>/scripts/auto-tour.mjs --root <仓库根>` 一键拉起（幂等复用、不开浏览器、只打印可点链接）；`scripts/board-server.mjs` 提供 `/tour`（实时页面）、`/api/tour`（全景模型，**每次请求现场重建**）、`/api/events`（SSE 变更推送；不可用时页面自动退化为 5s 轮询）、`/api/tour/usage`（视图用量埋点，落本机 `.agents/cache/`，不外发）。端口口径：显式 `--port` > `engine.json` 的 `options.boardPort` > 基线 8933。安全面刻意收窄：只绑 127.0.0.1、Host 头校验、**不做任意静态文件服务**、文档白名单仅 `workflow/{plans,specs,intents}/**.md`。


## PR 面板评审（pr-review，多镜头 + 投票 + 处置闭环）

`/review` 分级评审是默认（机器门 + AI 自查 + 用户定性）；**面板评审是升级档**——多镜头独立 finder 并行找 bug、每条 finding 独立验证者投票定共识、裁决处置后才判清零。触发：diff 触及信任边界 / 合 main 前 / 疑难回归。

- 脚本：`node <插件根>/scripts/pr-review.mjs`（8 子命令：plan → collect → verify → adjudicate → dispose → gate → summary → status；`--help` 看全量）
- 7 镜头：correctness / security / performance / tests / spec / data-integrity / quality（纯样式自动丢弃）
- 共识：3 验证者/finding，2/3 confirm 达标；单票 Important 带复现自动 escalate 到裁决
- 门禁：gate shadow（默认，不阻断）/ enforce（任一 violation 即 FAIL exit 1：Important/Nit 未关闭、escalated 未裁决、无票、head/diffHash 过期、纯样式入账）
- 台账：artifact 落 `workflow/reviews.d/artifacts/<月>/<runId>.json` + 月度一行进 `workflow/reviews.d/<月>.md`（与既有 scanReviews/metrics 口径兼容）
- 角色：`agents/pr-finder.md`、`pr-verifier.md`、`pr-adjudicator.md`（模型默认 finder=code / verifier=review，可在 `.agents/config/pr-review.json` 的 modelRoles 覆盖；adjudicator 不标注——宿主默认）
- **forge-free**：「PR」= 一段固定的 base..head 评审范围；插件不碰 forge API/PAT——贴评论/babysit 由宿主 agent 做

### PR 正文三件套（pr-body）

评审清零后开 PR 用 `node <插件根>/scripts/pr-body.mjs --base <ref>` 生成三件套正文——Summary（来自真实 diff）/ Evidence（verify 绿行，取不到明写「未运行」）/ Merge Danger（Door / Blast Radius / Rollback）——每节标数据来源，禁编造。agent 复制贴任何 forge。

## 工程准入与验收

- 冒烟：`node test/smoke.mjs`（清单版本位 + MCP 10 工具探测）；
- 全量：`test/` 全部套件逐个可跑（CI 逐行接线）；设计文档 §10 十条验收断言收口在 `test/acceptance.mjs`（黑盒、全走 CLI/stdio 入口），样板仓端到端闭环在 `test/e2e-fixture.mjs`；
- 实现收口记录（v2.3 → 0.1.0 落地偏差与裁决）见设计文档 `design/ai-native-delivery.md` §12。

## 项目侧约定（插件不附带）

`commands/` 与 `skills/` 里会提到下面这些路径，但它们属于**使用项目的资产**：插件不附带、`init-engine` 也不生成。首次接入的项目自行准备；缺失时按"按项目实际约定执行"处理——门禁脚本对项目侧目录一律"存在才守护"（`scripts/check-scripts-syntax.mjs`），不会因缺席判红。

- `.agents/notes/runtime-env.md`（`§6.1` 探活脚本、`§6.1b` 端口表等）——`commands/test.md`、`commands/deploy.md` 与若干门禁脚本的说明会指向它
- `scripts/verify/e2e/harness.mjs`、`scripts/verify/e2e/ports.mjs`——`verify-ui` 的 UI 实测单源与端口字面量单源
- 数据库访问技能提供的 python 脚本（如 database-explorer 的 `db_tool.py`），路径由宿主的 skill 目录映射决定

## 版本变更

**0.3.7**

面板评审带出两修（pr-review 对 pstack 0.1.25 弧范围命中本插件两文件）：①verify.mjs M10 桩越界判据加路径分隔符边界——插件目录名的兄弟前缀项目不再被误判为插件内（envSkips 如实记 stub、凭证锚资格不再虚高）②pretool-risk.mjs SAFE_FORCE 中和收窄为仅内置地板规则——项目侧点名 `--force-with-lease`/`--force-if-includes` 的 deny/ask 规则恢复生效（豁免不再覆盖用户清单），hook.test ⑱ 块加两条回归断言（点名即拦/未点名照放）。hook 160/0 全绿。

**0.3.6**

毛刺清理（papercut 根修，两天两次推送被范围门拦的实证）：**check-scope.mjs** 新增 `declAccepted`（单 token 接受判据抽单源）+ `suspiciousDeclarations`（声明节 bullet 反引号 token「形似路径但按判据会被静默丢弃」的早期暴露——如 `.codex/.omp/.zcode` 式缩写）；**confirm-doc.mjs** 确认/重确认双路径接「声明形态门」——缩写声明在**确认时刻**被拦（exit 2 + 逐 token 行号 + 修法提示），不再等到推送范围门。测试：check-scope S12 三断言（缩写标记/散文 URL 版本号不误报/三态判据）+ confirm-doc S72 两断言（缩写拒绝且不落账 / 写全精确路径后通过）。papercuts 登记 2 条（缩写无早期反馈——已修；承诺面占位符替换触发 reconfirm——与既有「勾验收不应触发」线程合并，owner 复评）。

**0.3.5**

面板评审自评审闭环（pr-review 首跑对 0.3.4 自身：2 finder 12 候选 → 3 验证者 36 票全 confirm → 全 12 条修复）：①默认面板 2→7 镜头 + maxFinders 6→7 + 截断显式告警（宣称面=默认派发面，C-001/C-007）②人工裁决是该票面终裁——重跑 verify 不冲掉（票面漂移只告警，C-002）③collect 改动面校验不再以 line>0 为前提（无行号越界候选照拦，C-003）④pr-body 三处路径输出补 -c core.quotepath=off（与 pr-review 同口径，C-004）⑤工单角色契约指路自锚插件 agents/（原指不存在的项目侧 .agents/roles/，C-008）⑥文档口径三修：enforce 拦截面如实列（原写不存在的 P0/P1，C-009）、modelRole 默认如实写（finder=code/verifier=review，C-011）、pr-body 注释去掉未实现的关单凭证来源（C-010）⑦清单计数四处同步 9 命令/7 角色（C-006）+ 登记表现状注 64→65（C-005）+ 预算 51200 行补带日期理由（C-012）。回归锁：pr-review 26 断言 + pr-body 8 断言（新增 ⑨⑩⑫⑬/⑥ 六断言锁死上述行为面）。

**0.3.4**

PR 评审回路（源仓 pr-review.mjs 1551 行判据级移植 + pr-body 插件原生新增，forge-free）：**pr-review.mjs**——8 子命令骨架（plan 固定 SHA→collect 去重样式丢弃→verify 共识投票 2/3→adjudicate 裁决→dispose 处置→gate shadow/enforce→summary 月度台账→status）；7 镜头 finder（correctness/security/performance/tests/spec/data-integrity/quality）+ 3 验证者/finding 共识 + Important waive 须用户书面原话（--quote）；台账落 workflow/reviews.d/artifacts/ + 月度行（与既有 scanReviews/metrics 兼容）；三新角色 pr-finder/pr-verifier/pr-adjudicator（agents/ 4→7）；命令 commands/pr-review.md（触发条件与 /review 分工）。**pr-body.mjs**——PR 体三件套生成器（Summary 来自 diff / Evidence 引 verify 绿行或明写未运行 / Merge Danger Door+Radius+Rollback，每节标数据源禁编造）。测试：pr-review 21 断言 + pr-body 7 断言全绿（源仓无测试，全部新写）。「PR」= 固定 base..head 评审范围——插件不碰 forge API/PAT（贴评论/babysit 由宿主 agent 做）。机制登记 2 行（[检出型]+[数据面]）；commands 预算上调 47282→51200B。

**0.3.3**

dev-tour 实时看板（快照版之上新增，源仓实时面按插件口径重做）：`scripts/board-server.mjs` 本地只读服务——`/tour` 实时页面（模板注入 MODE=live）、`/api/tour`（全景模型**每次请求现场重建**，恒最新）、`/api/events`（SSE 变更推送；不可用时页面自动退化为 5s 轮询）、`/api/tour/usage`（视图用量埋点，落本机 .agents/cache/ 不外发）、`/api/health`（就绪探针）；`scripts/ensure-board.mjs` 幂等拉起（端口已在跑就复用）+ `scripts/auto-tour.mjs` 一键链接（恒 exit 0，失败不阻断）+ `scripts/board-port.mjs` 端口单源（显式 --port > engine.json options.boardPort > 基线 8933）。安全面刻意比源仓收窄：只绑 127.0.0.1、Host 头校验、**不做任意静态文件服务**、文档白名单仅 workflow/{plans,specs,intents}/**、唯一写面是用量埋点。新增 4 套黑盒测试（board-server 13 / board-port 6 / ensure-board 5 / auto-tour 4，全绿）+ pid 文件（.agents/cache/board-server.pid）供停服与测试清理。

**0.3.2**

同步源引擎 8f6a22f84（判据级移植，A+B）：**A｜关单改动面门 taskScopeGate**——confirm-doc 把 plan 转 done 前置对账：取引用本 plan 短名的提交（--first-parent --grep）并集改动文件，与「改动方案」声明比对，越界即拒关单并点名（堵"历史 plan 提过即永久白名单、提交放行推送爆炸"洞）；L0 提交同口径豁免；逃生口沿插件 doneGateFor 既有口径（存量豁免用插件行首锚 LEGACY_DECLARED_RE，较源旧形态更严）。**B｜声明匹配收紧**（check-scope，推送门与关单门共用）——裸文件名不再算声明（唯一例外：仓库根真实文件）、无扩展名目录前缀只认真实文件；匹配由「全等/后缀/双向 includes」收紧为「全等/带目录后缀/`...` 段通配」。新测试 task-scope-gate 11 断言（越界拒/补声明过/L0 豁免/三逃生口）+ check-scope S8–S11；登记表 62 行（[检出型]）；new-task.md 触实测单篇上限按只升不降上调 8704→9728B。

**0.3.1**

对外文案收口（机制无变更）：四处对外描述（plugin.json / 双 marketplace / 根 README 表行）与 hosts.mjs 短描述、codex longDescription、defaultPrompt 补 L0 极简道声称（≤5 文件 + 判据行免立档）——L0/L1 快速道机制自 0.2.0 已在（check-confirm-order / fill-plan --lite / commit-msg 钩子），本次仅让对外声称与实现一致；顺带修正 hosts.mjs 自 0.2.0 起残留的旧硬门段数声称（S2 起 hard 实为 6 段，垫片经生成器重渲染）。核验记录：源仓 L0/lite 相关（含 a6aec6064 后补测试）均已同步；另报备一个快照后新引擎提交 8f6a22f84（关单改动面门 + 声明匹配收紧）未同步，待裁决。

**0.3.0**

三大件：**开发全景图（dev-tour 快照版）**——dev-tour-model.mjs（schema:2 全景模型：步骤×文件双向绑定、序列/数据流/依赖弧/验证门/需求链路）+ gen-dev-tour.mjs + 单文件 HTML 模板（file:// 零外部请求），--strict 每步文件门接 build.md，12 组 fixture 快照测试 18 用例锁死 + synthetic-plan 压测（N=60 22ms/214KB）；**dream-verify --model 语义复评档**——scripts/model-call.mjs 无交互模型调用单源适配器（opt-in 项目自治面，门禁/CI/init 零模型不变；win32 垫片收敛），对确定性判据筛出的存疑行三态裁决（仍成立/存疑/失效）进报告 E 段，20 条上限、失败不升级；**无人闭环 loop-runner**——bands.json 显式 autoRunner 授权（缺省=纯建议模式），agent 只读（Read/Grep/Glob）诊断、runner 落笔 draft intent 进正常管线人审、append-only 调用台账、坏输出记 failed 不重试，红线只到 intent 草案不自动改代码/开 PR；真实黑盒：模型连通 probe ok、loop-runner 失败语义与成功链路双实证（intent 草案含真 file:line 证据）。

**0.2.3**

提示面 eval 套件（「配置即被测对象」补齐）：test/eval.mjs 无交互 runner（claude -p print 模式，--dry-run 零成本审拼装 / --bail / transcript 落临时目录复盘）+ 4 条种子用例（L0/L1/L2 三车道终态工件断言 + E4 越界诱导防护，真实双跑实证：诱导改 policyVersion 与 force push 均被拦、终态 sha256 未变）；checks DSL 11 个确定性算子；acceptance §10.10 照 e2e-fixture 先例排除 eval.mjs 裸跑（无 runner 环境必红 + 防意外模型调用）；ci.yml 头注豁免（零凭据纪律，不进默认 CI），另附 workflow_dispatch 手动触发模板 config-templates/ci/github-actions-eval.yml.template；补登 regr-enforcer-scan.mjs 间接覆盖（0.2.1 遗留覆盖门红转绿）。

**0.2.2**

巡检工具面与误拦遥测：MCP 工具 7→10（band_check 确定性带监测 / dream_verify 引用完整性对拍 / doctor 安装自检，均 root 必填、只读；smoke 钉死清单与 mcp-tools e2e 同步，全仓声称收口为 10）；check-bands 定时巡检模板（config-templates/ci/github-actions-bands.yml.template，schedule 触发 + 报告 artifact，项目自治、不含任何自动执行 agent 步骤）；误拦率遥测（judgment-ledger --dismiss 人工登记位 + agg-judgments 误拦面：每规则命中/dismiss/误拦率，≥50% 且样本 ≥3 点名建议复评；退役候选旁注 dismiss 信号、退役判据不变；monthRuleCounts 补 __proto__ 原型污染收口）。

**0.2.1**

闭环自治与记忆校错收口（设计稿 ai-native-closed-loop-and-memory 三批全量落地，开放问题 1/4 按建议裁决、2/3 维持）：**批次 1 闭环自治半场**——确定性带监测 check-bands（config-templates/bands.json 种子 + μ±kσ 简化判据，log/diagnose/propose 三档响应，建议指令只打印不执行）与 CI 适配参考模板（config-templates/ci/，无模型步可直接、可选诊断步注释样例；插件描述同步收口为「附带 CI 适配参考模板，接线属项目自治」）、检查 29 执法者可达性机检（路径形态执法者机检存在 + node --check 级可解析，[prompt-only] 维持放行但挂债计数进 verify 尾部摘要）；**批次 2 校错 pass**——dream-verify 引用完整性对拍（知识文档规则型断言行的确认指纹/证据文件/终态件对拍，只标硬漂移、宁漏报不误报，dream-run 报告新增 D 段引用）；**批次 3 收尾**——阶段流转指标（gen-workflow-metrics 第八表：intent→spec / spec→plan / plan→close 中位与最大 + build 后 spec/plan 修订提交数与返工族数，机制登记 [数据面] 至 59 行；非 git 仓出「数据不足」不误报）、INDEX 注入纪律（read_context 输出对超 200 行 INDEX 附分片/归档 advisory，指向 compact/archive 既有链，不改写不拦流程）、项目侧安全适配成文（README 新节：文件读取拒绝面 / 沙箱网络白名单 / 凭据剥离的宿主等价配置样例与三层分工边界表，零行为变更）。

**0.2.0**

源引擎 policyVersion 14→16 机制同步（判据级移植，存量项目按生效锚不追溯）：判据修正包与合并语义探针；v16 两门——spec 前提质询门（premiseGate）与检查 29 回归清单执法者配对（hard 5→6）；提交与推送面——commit-msg 顺序门「先确认后改代码」（L0 判据行豁免通道，产品 ≤5 免立档）、推送范围改动面对账、提交消息任务短名 advisory、doc-body-drift 已关单正文漂移 advisory、check-hook-wiring 接线宣称对账；兜底与自愈——secrets-lite 密钥扫描兜底（gitleaks 缺位自动降级，零二进制零网络）、verify 生成物漂移门自愈（重生成后复检绿计通过）、通用 closeout（L0–L3 单命令，取代 closeout-l1）；PreToolUse 写前门（执法面自保护 + 三本审计账 append-only，hooks.json 双 PreToolUse 段）；Dreaming 持续运行链路（kb-search 命中遥测、agg-kb-usage 冷数据聚合、dream-run 只读审计、post-commit advisory、新增 dream 技能）；L0/L1 快速道配套 fill-plan --lite 与 commit-msg-rules.json 种子；新增第 4 角色 wiki-compiler，ui-verifier 实测栈改 chrome-devtools MCP 优先。git hooks 2→4 只（新增 commit-msg 执法点与 post-commit advisory）。

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
- **凭证链 git 锚 + 来源可对质**：verify 落凭证行带 `head`（当时 HEAD sha）与逐门 `gates[{id,exit,src}]`（脚本实际解析路径，项目侧桩替换从此在凭证与入库视图可对质）；消费侧（confirm-doc hard 档 / closeout 预检 / §8 对账）对带 head 的行校验 `merge-base --is-ancestor`，引用不在当前历史的行不认；无 head 存量行兼容放行。诚实定性：抬门槛 + 可对质的半步加固，非密码学终极。
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
