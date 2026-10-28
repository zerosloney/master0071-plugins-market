# AI-Native 交付治理引擎插件 · 设计文档 v2.3

> 源项目：`E:\Git\Shipyard.Material`（AI-Native 治理引擎面：`.agents/` + `.zcode/` + `workflow/` + `.githooks/`）
> 目标：本仓 `plugins/ai-native-delivery`，按 Agent Plugins 1.0.0 标准打包进市场
> v1 审查修订版；v2.1 重划 MVP（安装即全三层闭环）；v2.2 定案公共插件；v2.3 定案台账项目级不变量，见 §0.1–§0.3 与 §5.2

---

## 0. v1 → v2 变更记录

| 审查意见 | v2 处置 | 落点 |
|---|---|---|
| P0-1 遗漏风险分级泳道 | 以 L1/L2/L3 定级 + 判低拦截 + 硬门 5 段为核心机制重写 | §2 |
| P0-2 与 agent-pipelines 重叠未处理 | 裁决为平行共存、互补边界，给出集成点 | §1.2 |
| P0-3 不满足本仓工程准入 | 补清单 / 市场条目 / release 接线 / 测试同迁 / CI | §6 |
| P1-4 "强制拦截"路径未验证 | 改为三层拦截模型，逐层标注覆盖面与逃逸面 | §3.2 |
| P1-5 目录混淆插件资产与项目产物 | 两边界分立；初始化时机改为首次命令执行（幂等）；目录名保留不改 | §5 |
| P1-6 配置命名与原项目脱节 | 放弃 v1 的改名（roles.json/gates.json），改为逐资产对照清单 + "保真不改名"原则 | §4 |
| P1-7 台账缺维护机制 | compact-ledgers / archive-sweep / check-ledger-invariant / 重建清单全部列入必迁 | §3.3、§4.2 |
| P2 验收标准不可测 | 全部改为可执行命令断言 | §10 |
| P2 Roadmap 无工作量概念 | 先定 MVP 切面（L1 泳道全链），四阶段各自有退出判据 | §9 |
| P2 多宿主遗漏 | 承接本仓垫片机制，dwf 工作流单独归置 | §7 |
| P2 合规缺失 | 脱敏红线 + 运行时数据绝不迁移 + NOTICE 衍生声明 | §8 |

### 0.1 v2.1 修订记录（2026-10-27）

- **用户裁决：安装即获得全部三层闭环**（任务级硬闭环 / 状态收敛环 / 治理进化环），不接受"任务级先闭环、其余后补"。MVP 从"L1 泳道全链"扩为"机制面近全量"，§23 / §3x / 进化环全部进 MVP，路线图重划（§9）。
- MCP 工具 6 → 7：新增 `policy_status` 承载第三层的可见性（§3.3）。
- 验收标准新增收敛对账 / 回归证据 / 进化环三组断言（§10）。
- board 看板从 Phase 3 提至 Phase 2（§4.2）。

### 0.2 v2.2 修订记录（2026-10-27）

- **用户定案：本插件即公共插件**——外发授权不是阻塞项，§11.2 关闭。发布前仍走 §8 的脱敏与数据面审查（一次性人工过检、留档），但不构成实现前置。

### 0.3 v2.3 修订记录（2026-10-27）

- **用户定案：台账项目级**——`workflow/` 台账与三本审计账一律保存在**使用项目的 git 仓库根**，不进插件目录、不进用户目录；§5.2 立为不变量，并补入库口径表（依据源项目 .gitignore 与 git ls-files 实测：`workflow/` 622 文件、`.agents/` 533 文件入库；judgments / verifications / cache 为本机机器事实，项目内但不入库，聚合结果经 agg-* 进共享台账）。

---

## 1. 定位与边界

### 1.1 插件定位

把 Shipyard.Material 里跑通 14 个 policy version 的交付治理引擎，做成任何项目可安装的插件。它交付的不是"流水线"，而是四件事：

1. **开工前定级**：任何任务先过"两问定级"进泳道，级别决定后续审计成本；
2. **过程中门禁**：check-loop 硬门在关单 / pre-push / CI 三个时点校验闭环证据；
3. **全程台账**：`workflow/` 三件套 + 索引作为跨会话物理内存；
4. **事后审计**：confirmations / judgments / verifications 三本账留痕。

### 1.2 与 agent-pipelines 的关系（P0-2 裁决）

**裁决：平行共存，互补不合并。**

| | agent-pipelines（已有，v0.1.15） | ai-native-delivery（本插件） |
|---|---|---|
| 职责 | **执行编排面**：一个任务内 orchestrator→builder→reviewer 怎么协作跑完 | **治理面**：任务开工前怎么定级、落什么档、关单时要什么证据 |
| 关键词 | scope 零容忍、背压熔断、多代理轮转 | 风险泳道、判低拦截、台账三件套、确认指纹 |
| 无对方时 | 可独立用（无治理的执行管道） | 可独立用（人工执行 + 机器验收） |

理由：合并会让 agent-pipelines 从"编排"膨胀成"编排+治理"两个关注点；两者消费时机不同（治理面在任务入口与出口，编排面在任务内部）。集成点为松耦合：

- **工具层**：本插件注册 MCP 工具（§3.3），宿主内全局可见，coding-pipeline 的 review/gate 阶段可直接调用 `confirm` / `verify_gate`；
- **文档层**：两个插件 README 互相引用，标明"执行编排用 agent-pipelines、交付治理用本插件"。

### 1.3 不做什么

- 不做多代理执行编排（agent-pipelines 领域）；
- 不做需求预检决策（systemone-decision 领域，hooks 侧已有先例，本插件不重复注册）;
- 不迁移 `pipeline-run.md`（源项目 2026-10 起已停用，台账无使用记录）；
- 不迁移 dwf 原生编排（宿主专属格式，见 §7）。

---

## 2. 核心机制：风险分级泳道（P0-1）

这是引擎的灵魂，v1 完全遗漏。以下机制逐字保真迁移，来源 `.agents/commands/new-task.md`。

### 2.1 泳道定义

| 泳道 | 级别 | 判据 | 审计口径 |
|---|---|---|---|
| 协作道 | **L1** 实现级 | 未命中 L2/L3 的实现级改动 | 一份 plan 即入口（来源/目标/红线/改动/验证/验收），不另立 intent |
| 防御道 | **L2** 规则/契约 | 命中 L2 触达面闭集任一条 | 同步确认门：spec 确认 → plan 确认 → 动手 |
| 防御道 | **L3** 数据/运行时结构 | schema / 迁移 SQL / DI 链 / 认证与中间件管线 | 同 L2 + spec 新会话独立复核，未确认不放行 |

**两问定级**（写进定级 skill，禁止按严重程度从 L1 往上滑）：

1. 结构面（schema / 迁移 SQL / DI / 认证管线）命中吗？→ 命中即 L3；
2. 契约或共享口径命中吗？→ 命中即 L2；
3. 都没有 → L1。

### 2.2 L2 触达面闭集（4 条）

1. **编码权威**：一处生成、多处消费的编码/命名/取号规则；
2. **共享契约**：跨模块共享的基类 / DTO 形状 / 公共接口签名；
3. **既有接口语义**：既有参数或端点的行为变化（失效变生效、默认值/钳制口径改变）；
4. **全局横切口径**：错误响应出口、分页与校验口径、聚合投影键。

自查句：能否列出 ≥ 2 个受影响的消费方？能 → L2。
负例（落 L1）：纯页面表现/文案/布局；纯新增端点且行为不变；单模块内部重构无对外契约变化。

闭集是**配置驱动**的（`workflow-enums.txt` / `lane-surfaces.txt`），插件允许项目按闭集格式扩展条目，不允许改成开集。

### 2.3 判低拦截（闭环的强制面入口）

L1 的 plan 若勾到红线 → check-loop §1 **hard 阻断** → 强制升级到 L2/L3 并补同名 spec。级别一经 `new-task` 定档，后续命令**禁重新定级**（源项目 plan.md 原文约束）。

### 2.4 硬门 5 段（源项目 2026-10-23 现状）

check-loop 22 段 = hard 5 + hygiene 17，hard 段全部有阻断力：

| 段 | 校验内容 | 拦什么 |
|---|---|---|
| §1 | 红线判低 / L3 状态 | L1 plan 勾红线、L3 未过独立复核 |
| §3x | 回归证据 | 关单缺回归验证记录 |
| §8 | 验收勾验 | 验收项勾了但无对应证据 |
| §15 | 确认指纹 | 确认记录与文档指纹不匹配（防事后篡改） |
| §23 | 收敛对账 | 台账与 git 实际状态不收敛 |

hygiene 段（索引/宿主/词表/指标签名/委派等 17 段）只告警不阻断；WARN 按"信噪比"规则折叠输出（同规则归一计数，BLOCK 一律不折）——warn-format.mjs 的 S1-S7 测试锁住折叠行为，随迁。

---

## 3. 四平面架构（修订版）

### 3.1 编排面：9 命令全量 + 去留标注

源项目命令带 frontmatter（`stage` / `triggers` / `approval_required` / `delegation` / `next`），插件命令逐字保真迁移（frontmatter 即路由协议，`next` 字段构成 6 阶段状态机：Plan→Design→Build→Test→Deploy→Maintain；review 为横切，不占阶段位）。

| 命令 | 去留 | 说明 |
|---|---|---|
| `new-task` | **迁** | 闭环总入口，含 Step 0 定级与 L1 快速道 |
| `plan` | **迁** | L2/L3 立 intent；L1 走 new-task §快速道 |
| `design` | **迁** | Design 阶段 |
| `build` | **迁** | Build 阶段 |
| `test` | **迁** | Test 阶段 |
| `review` | **迁** | 横切评审；frontmatter 的 `delegation → independent-reviewer` 映射到插件 agents/（§3.5） |
| `deploy` | **迁骨架** | 阶段骨架与门禁保留，azure 专有步骤降为项目适配点（配置注入） |
| `maintain` | **迁** | Maintain 阶段 |
| `pipeline-run` | **不迁** | 源项目已停用 |

插件形态：`commands/` 目录（本仓 agent-pipelines 先例）。

### 3.2 治理面：三层拦截模型（P1-4）

放弃 v1 "MCP 工具拦截" 的说法——MCP 工具只能拦住经过它的调用，拦不住 agent 直接写文件。实际拦截分三层，各层覆盖面与逃逸面明示如下：

| 层 | 载体 | 拦截时点 | 覆盖面 | 逃逸面 |
|---|---|---|---|---|
| **L-hook** | 插件 `hooks/`（PreToolUse） | 动作执行前 | Bash / Edit / Write 类工具调用：deny 清单（`git reset --hard`、`git push -f`、`drop database` 等，源自源项目 settings.json permissions）、ask 清单、破坏性命令风险闸 | 仅支持 Claude 式 hook 的宿主生效（本仓 systemone-decision `pretool-risk.mjs` 同款限制，README 需标注）；白名单绕过 |
| **L-git** | 项目侧 git hooks（初始化时安装，pre-commit / pre-push） | 提交/推送前 | 一切落盘改动：check-loop hard 段 + loop-watch 日检接线 | `--no-verify`、绕过 git 的操作 |
| **L-ci** | CI workflow 模板（项目适配点） | 合入/构建时 | 全量：check-loop `--all` + 测试矩阵，最后一道兜底 | 本地不推、私有分支不跑 CI |

三层职责递进：hook 拦"动作"、git 拦"提交"、CI 拦"合入"。任何单层都可被绕过，三层叠加后逃逸需要蓄意规避——这是"强制"的真实强度，插件文档按此口径宣传，不承诺绝对拦截。

治理配置（保真不改名，来源 `.agents/config/`）：

- `model-roles.json`：code / judgment / review 三角色，`review.heterogeneous=true`（复核模型必须与实现模型不同），fallback `host-default`，支持 `model-roles.local.json` 项目覆盖；
- `gate-budgets.json`：墙钟预算（advisory，超限告警不阻断）+ flaky 隔离重跑策略；
- `principles.md` / `mechanism-registry.md` / `rule-budgets.txt`（门禁段数棘轮：退役一段同降上限，防止门禁无序回潮）；
- `engine.json`：policyVersion + hosts + stack + boardPort。**stack 字段是泛化点**——源项目为 `dotnet`，脚本中 dotnet 专有调用（如 backend-test 门）须在迁移时审计并按 stack 分派（开放问题 §11.4）。

### 3.3 状态面：台账系统 + 维护机制（P1-7、P1-5 相关）

台账本体（项目侧，人类可读）：`workflow/` 保真迁移——

```
workflow/
├── INDEX.md                 # 交付总索引（跨会话恢复的入口）
├── intents/ specs/ plans/   # 三件套（L2/L3 全量，L1 仅 plans）
├── delegations.md + .d/     # 委派记录
├── metrics.md + gate-metrics.d/   # 交付指标
├── papercuts.md + .d/       # 确认税/摩擦记录（判"提问分型"机制去留的依据）
├── regression-checklist.md + .d/  # 回归清单（§3x 的证据源）
├── evidence/ verify-evidence.md   # 验证证据
├── incidents/ reviews.d/ research/ archive/
└── effective-policy.md      # gen-effective-policy 生成物
```

维护机制（**必迁**，v1 全漏——markdown 台账的膨胀与漂移是源项目实证过的痛点）：`compact-ledgers`（压缩）、`archive-sweep`（归档清扫）、`check-ledger-invariant`（不变量校验）、`ledger-prune-manifest.json` / `ledger-rebuild-manifest.json`（修剪与重建清单）。

MCP 工具集（注册 7 个，控制 schema 开销，对齐本仓 systemone-decision "只注册 2 个工具"的克制口径；三个闭环层各至少一个入口工具）：

| 工具 | 职责 |
|---|---|
| `grade_task` | 两问定级 + L2 闭集比对，返回级别与依据 |
| `read_context` | 汇总 INDEX + 在途三件套，跨会话恢复（断崖恢复入口） |
| `update_ledger` | 台账状态原子更新（内部走 fill-* 脚本，不绕过校验） |
| `confirm` | 写确认记录（含指纹，供 §15 校验） |
| `verify_gate` | 跑 check-loop 指定车道（hard / hygiene / all）并回报 |
| `ledger_stats` | 台账体量/不变量状态，供 compact 决策 |
| `policy_status` | 第三层可见性：policyVersion / 预算实测对比 / 退役候选 / 棘轮计数 |

### 3.4 审计面：三本账

- `confirmations.jsonl` + `confirmations.d/<task>.jsonl`（双层：总账 + 按任务分片）；
- `judgments.jsonl`（check-loop 判定账，含 per-rule 计数，驱动"连续 6 月 = 0"的规则退役判据）；
- `verifications.jsonl`（验证存根）。

三本账均为**项目级落位**（§5.2 不变量），但入库口径分两档：confirmations 跨机入库；judgments / verifications 为本机机器事实（项目内、gitignore），各机各自产生，聚合结果经 agg-* 进共享台账——这正是第三层进化环的数据源。

### 3.5 角色面：roles → 插件 agents

源项目 `.agents/roles/` 三角色（implementer / independent-reviewer / ui-verifier）迁移为插件 `agents/` 目录（本仓 agent-pipelines 先例）；源项目 `.zcode/agents/*.md` 是这三角色的 zcode 宿主薄壳，插件形态下由插件清单承担，不再单独迁移。review 命令 frontmatter 的 delegation 引用改指向插件内路径。

---

## 4. 资产对照清单（P1-6）

### 4.1 原则：保真不改名

v1 的 roles.json/gates.json 改名方案废弃。理由：源项目 80+ 脚本与全部命令文本互相引用 `.agents/config/<原名>`，改名意味着全量引用重写，不一致风险藏在暗处。且路径常量已半集中在 `check-loop-kit.mjs`（check-loop.mjs 从 kit 解构 `WF`、`DOC_DIRS`、`SCRIPT_DIR` 等），迁移时把路径收口到单一 `paths.mjs` 即可，无需借改名之名做无关重构。

### 4.2 资产分组与去留

| 分组 | 内容（源项目实测） | 去留 |
|---|---|---|
| 命令 | §3.1 九命令 | 8 迁 1 弃 |
| 角色文档 | roles/ ×3 | 迁（→ agents/） |
| 定级/立档 | fill-intent / fill-spec / fill-plan（各带测试） | 迁（MVP 只需 fill-plan） |
| 门禁 | check-loop + kit + sections/（22 段）+ warn-format + judgment-ledger | 迁（MVP 先 hard 3 段，见 §9） |
| 台账维护 | compact-ledgers / archive-sweep / check-ledger-invariant / check-ledger-doc-presence / ledger-*-manifest | 迁 |
| 关单/确认 | closeout-l1 / confirm-doc / stage-gates 相关 | 迁 |
| 聚合/归因 | agg-judgments / agg-delegations / failure-attribution / check-metric-claims | 迁 |
| 门禁外围 | check-pr-size / check-secrets / check-scope / check-regression-consistency / check-query-contract / check-schema-residue | 迁 |
| CI 接线 | ci-push-before / ci-install-gitleaks | 迁骨架（CI 供应商差异留适配点） |
| 面板 | ensure-board + board/index.html + marked.min.js | Phase 2（本仓 agent-pipelines serve.mjs 有看板先例，可复用经验） |
| 产出器 | gen-effective-policy | 迁 |
| dwf 编排 | .zcode/workflows/ ×5（close-loop / code-review / contract-audit / repo-doctor / verify-gate）+ drafts + runs | 不随插件分发（§7） |
| skills | autonomous-run（长跑合同）等 | 挑通用者迁，逐个标注 |
| **运行时数据** | confirmations.d/*.jsonl、judgments.jsonl、cache/、loop/、tmp/、workflow/ 全部内容、.zcode/workflow-runs/ | **绝不迁移**（§8 红线） |

脚本迁移硬规则：**脚本与其 `.test.mjs` 同迁同改**——源项目约半数脚本自带测试（如 check-loop-rev-*.test.mjs 四件、fill-*.test.mjs 三件），这些测试就是行为保真的验收件。源项目已有 `scripts-test-exempt.txt` 豁免表，随迁。

### 4.3 配置改名映射表

结论：**无改名**。仅新增插件侧自有文件（plugin.json、mcp.json、hooks 配置），项目侧文件名与源项目 1:1。

---

## 5. 目录规范：插件资产 vs 项目侧产物（P1-5）

插件格式没有"安装时执行脚本"的生命周期，本仓 4 个插件也无安装即写项目目录的先例（worktree-ops 是运行时按需创建）。因此两边界分立：

### 5.1 插件资产（仓库内，随市场分发）

```
plugins/ai-native-delivery/
├── plugin.json                    # Agent Plugins 1.0.0（版本权威来源）
├── .zcode-plugin/plugin.json      # ZCode 垫片
├── .codex-plugin/plugin.json      # Codex 垫片
├── .omp-plugin/plugin.json        # Oh My Pi 垫片
├── mcp.json                       # MCP server 声明（6 工具）
├── commands/                      # 8 命令
├── agents/                        # 3 角色
├── skills/                        # 定级 skill、autonomous-run 等挑迁项
│   └── <skill>/SKILL.md
├── scripts/                       # 治理脚本 + paths.mjs（路径收口）
├── hooks/                         # PreToolUse 风险闸（pretool-risk 风格）
├── config-templates/              # §3.2 治理配置模板（首次初始化的种子）
├── test/                          # 测试同迁 + 新增验收测试（§10）
├── NOTICE-ORIGIN.md               # 衍生来源声明（pstack NOTICE-PORT 先例）
└── README.md
```

### 5.2 项目侧产物（台账项目级不变量 + 首次命令执行时幂等初始化）

**不变量（v2.3，用户定案）——台账与三本审计账永远是项目级资产：**

1. 一律落在**使用项目的 git 仓库根**（锚定 git root 解析，不锚 cwd，防嵌套目录漂移）；
2. 插件目录只承载代码与模板，用户 home 目录不落任何项目台账数据；
3. MCP 工具无自有存储，一切读写以项目根为锚。

用户项目只生成两棵树，**名字与源项目一致**（保真，理由见 §4.1）：

```
.agents/            # 引擎运行时（机器读写）
├── config/         # 从 config-templates 种子化，项目可改
├── confirmations.jsonl + confirmations.d/
├── judgments.jsonl / verifications.jsonl
├── scripts/        # 脚本落位（或由 paths.mjs 指回插件目录，二选一，见开放问题 §11.1）
├── cache/ loop/ board/ notes/ tmp/
└── settings.json   # permissions allow/deny/ask
workflow/           # 交付台账（人类可读）
```

**入库口径**（与源项目 .gitignore / git ls-files 实测一致：`workflow/` 622 文件、`.agents/` 533 文件入库）：

| 数据 | 路径 | 口径 |
|---|---|---|
| 交付台账全量（含 archive/） | `workflow/` | **入库**，跨机共享 |
| 确认账（双层） | `.agents/confirmations.jsonl` + `confirmations.d/` | **入库**，跨机共享的审计事实 |
| 治理配置 / 命令 / 脚本 / 角色 / settings / loop / board | `.agents/` 其余 | **入库**（除下行本机项） |
| 判定流水 | `.agents/judgments.jsonl` | 项目内、**本机不入库**（各机各自产生；月度聚合经 agg-judgments 进共享台账） |
| 验证凭证 | `.agents/verifications.jsonl` | 项目内、**本机不入库**（24h 窗口机器事实） |
| 缓存 / 临时 | `.agents/cache/`、`.agents/tmp/` | 本机不入库 |
| 本机环境 / 个人模型映射 | `notes/runtime-env.local.md`、`config/model-roles.local.json` | 本机不入库（模板入库） |

初始化契约：任意命令首次执行时检测缺什么补什么；已存在则只校验 policyVersion，不覆盖项目改动（幂等）。git hooks 安装在同一时机，带卸载说明。config-templates 附带同口径 `.gitignore` 种子段，首次初始化写入项目——装完即与源项目同入库口径，无需用户手配。

### 5.3 所有权与碰撞评估

插件安装后，commands/skills/agents 归宿主缓存目录，**不落**项目 `.agents/`；项目 `.agents/` 仅承载运行时数据（jsonl / cache / loop），与常见 `.agents/commands|skills` 工具约定是不同子路径，碰撞面小。残余风险与本仓自身事实（本仓根 `.agents/plugins/` 已被 Codex 市场清单占用）列入开放问题 §11.1。两点澄清：① §11.1 的"脚本留插件内"选项仅指**代码**落位，台账与三本账的数据路径恒为项目根，不受 §11.1 裁决影响；② `engine.root` 逃生门（若启用）仅重命名项目内的引擎目录前缀，**不得**把台账移出项目仓库（§5.2 不变量优先于逃生门）。

---

## 6. 工程准入（P0-3）

### 6.1 清单与市场条目

- 四份 plugin.json（权威 + 三垫片），schema 同本仓现有插件；
- 根 `marketplace.json` + `.omp-plugin/marketplace.json` 新增条目：name / source / version / description / displayName(+i18n) / description_i18n（中英双语，对齐现有 4 条目格式）。

### 6.2 版本接线

含 MCP server，版本同步处数 **8 处**（对齐 worktree-ops：2 市场 + 4 清单 + `mcp/protocol.mjs` 的 SERVER_INFO.version + 根 README 版本表）。`scripts/release.mjs` 的 `PLUGINS` 注册表新增条目；发布前 `node scripts/release.mjs --check` 必须通过。

### 6.3 测试同迁原则

- 迁移脚本自带 `.test.mjs` 一律同迁，落 `test/`；
- 源测试已用 fixture 注入（`CHECK_LOOP_ROOT` 环境变量），可移植性好，迁移时保持该模式；
- 新增验收测试见 §10；
- 插件内脚本遵守源项目同等纪律：`check-scripts-syntax` + `check-script-coverage` 随迁后即为本插件的自我门禁（吃自己的狗粮）。

### 6.4 CI

复用本仓现有矩阵（ubuntu/windows × node 20/22），新插件 test/ 自动纳入；`scripts-test-exempt.txt` 同步豁免表。

---

## 7. 多宿主适配（P2）

源引擎五宿主经验（engine.json `hosts: opencode/trae/zcode/omp/codebuddy`）是资产，插件化后的承接方式：

- **清单层**：`.zcode-plugin` / `.codex-plugin` / `.omp-plugin` 三垫片即宿主适配，与源项目 `.opencode/`、`.trae/` 等薄壳目录职责同构，不再迁移那些目录本体；
- **hook 层**：PreToolUse hook 仅 Claude 式宿主生效，README 显式标注降级行为（无 hook 宿主退化为 L-git + L-ci 两层拦截）；
- **dwf 层**：`.zcode/workflows/` ×5 是 zcode 原生编排（TypeScript 工作流），与插件格式正交，**不随插件分发**；如 zcode 未来支持工作流随插件分发，另立 addendum。归档为插件仓库的可选附加包（Phase 3 评估）。

---

## 8. 合规与脱敏（P2 红线）

1. **定位定案**：本插件即公共插件（用户裁决 2026-10-27），无外发授权阻塞。发布前走一次性人工过检：下 3 条全部执行并留档，不构成实现前置。
2. **只迁机制，不迁数据**：confirmations / judgments / cache / workflow 台账内容 / workflow-runs 一律不迁移；`workflow/` 只迁目录约定与 `_TEMPLATE` 类模板。
3. **脱敏扫描**：源码注释携带业务上下文（实证：后端 FormulaEngine.cs 注释含 "yzgy 存量模板" 字样），全部迁移面过 `check-secrets` + 人工 grep 公司专名（yzgy / 内部端点 / azure 资源名 / 人名）。
4. **衍生声明**：`NOTICE-ORIGIN.md` 说明源自 Shipyard.Material 治理引擎、policyVersion 14 基线、MIT 双向兼容确认。

---

## 9. MVP 切面与路线图（v2.1 重划：装上即全三层）

用户裁决（2026-10-27）：**安装插件即获得全部三层闭环**，不接受"任务级先闭环、收敛环与进化环后补"。MVP 从 v2 初版的"L1 泳道全链"扩为"机制面近全量"。

### MVP：三层闭环全量（0.1.0）

**第一层 · 任务级硬闭环（全泳道）**

| 件 | 内容 |
|---|---|
| 定级器 | 两问定级 + L2 闭集 + `grade_task`；L1/L2/L3 全泳道（含 plan/design/review 的 L2/L3 分叉：spec 双确认、新会话独立复核、review 委派 independent-reviewer） |
| 命令 | §3.1 全部 8 个 |
| 硬门 | check-loop hard 5 段全量：§1 判低拦截与 L3 状态 / §3x 回归证据 / §8 验收勾验 / §15 确认指纹 / §23 收敛对账 |
| 关闸点 | closeout（关单）与 pre-push 两个物理闸门接线 |
| 拦截 | 拦截模型前两层全量：PreToolUse 风险闸 + git hooks；CI 层为项目适配点（插件不附带 CI 模板，裁决见 §12.8） |
| 台账 | 三件套 + INDEX + delegations + regression-checklist + evidence/verify-evidence + incidents |
| 审计 | confirmations 双层账 + judgments + verifications |

**第二层 · 状态收敛闭环**

| 件 | 内容 |
|---|---|
| 对账 | §23 收敛对账进 MVP（v2 初版后置项提前） |
| 日检 | loop-watch 接线 pre-push 每日一次 hygiene |
| 台账卫生 | compact-ledgers / archive-sweep / check-ledger-invariant + 修剪/重建清单 |
| 断崖恢复 | `read_context` + INDEX |
| hygiene 段 | 17 段随迁，按 workflow-modules.txt 配置启用：引擎通用段默认开，项目特异段（dotnet 迁移检查等）默认关 |

**第三层 · 治理进化闭环**

| 件 | 内容 |
|---|---|
| 计量 | gate-metrics 采集 + metrics.md 台账（预算的实测基础） |
| 判定账 | judgment-ledger per-rule 计数 + agg-judgments 聚合 |
| 退役判据 | "连续 6 月 = 0" 候选识别 + 段数棘轮（rule-budgets.txt 上限锁死） |
| 预算 | gate-budgets 以实测均值为据（首版沿用源项目口径，装后自校准） |
| 归因 | failure-attribution + incidents 台账 + check-metric-claims |
| 政策版本 | policyVersion 机制 + gen-effective-policy 产出 effective-policy.md |
| 可见性 | `policy_status`：版本 / 预算实测 / 退役候选 / 棘轮计数一屏读 |

**工程与测试**：§6 全量 + §10 全部断言。

**规模与批次**：迁移面从 v2 初版约 1/3 引擎扩至机制面近全量（80+ 脚本的大多数及其测试同迁）。内部按"第一层批次 → 第二、三层批次"两个合入里程碑推进，但对外**单版本 0.1.0 一次交付、不分段发布**——分层只决定合入顺序，不构成功能缺席。

### Phase 2：可视化与集成

board 看板（ensure-board，借鉴 agent-pipelines serve.mjs）、metrics 面板深化、与 agent-pipelines 的 gate 阶段集成文档、提问分型机制开关（papercuts 数据自安装即累积，Phase 2 依数据定去留）、`engine.root` 逃生门、deploy 命令项目适配深度。

### Phase 3：dwf 附加包与生态

dwf 工作流附加包评估（以宿主支持随插件分发票据为前提）、跨项目治理基准对比、市场生态联动。

每阶段退出判据 = 该阶段机制全部有测试断言 + 样板仓实测一轮闭环。**MVP 退出判据** = §10 全部断言 + 样板仓完成一次 L1 关单 + 一次 L2/L3 全链 + 一次收敛对账拦截 + 一次退役候选识别。

---

## 10. 验收标准（可测化，P2）

全部为可执行断言，落 `plugins/ai-native-delivery/test/`：

1. **定级可测**：`grade.test.mjs` —— 命中闭集第 2 条（公共接口签名）的描述 → 断言 L2；纯页面文案描述 → 断言 L1；schema 变更 → 断言 L3。
2. **判低拦截可测**：`gate-hard.test.mjs` —— fixture 构造勾红线的 L1 plan → check-loop §1 退出码 ≠ 0；修正为 L2 立档后退出码 = 0。
3. **台账闭环可测**：`ledger.test.mjs` —— update → invariant 校验通过 → compact 前后关键字段不丢。
4. **断崖恢复可测**：同 fixture，新调用 `read_context` 输出包含在途 plan 与 `next` 指向的下一命令。
5. **hook 可测**：`hook.test.mjs` —— deny 清单命令（`git push -f`）→ PreToolUse 返回 block（对齐 systemone-decision hook.smoke 模式）。
6. **确认指纹可测**：确认后篡改 plan 文档 → §15 退出码 ≠ 0。
7. **收敛对账可测**：`gate-convergence.test.mjs` —— fixture 构造台账记录与 git 实际状态背离 → §23 退出码 ≠ 0；修正后 = 0。
8. **回归证据可测**：fixture 关单缺 regression-checklist 证据行 → §3x 退出码 ≠ 0；补齐后 = 0。
9. **进化环可测**：`evolution.test.mjs` —— 跑 N 次 gate 后 judgment-ledger per-rule 计数与实际一致；构造"连续零命中"规则 → 退役候选被 `policy_status` 识别；在 rule-budgets 上限之外新增段 → 棘轮拒绝；gate-budgets 超限 → advisory 告警触发且退出码仍为 0（只告警不阻断的口径被锁死）。
10. **工程准入**：`node scripts/release.mjs --check` 通过；本仓 CI 全绿。

---

## 11. 开放问题

1. **`.agents/` 脚本落位**：脚本复制进项目（源项目形态，独立演化）vs 留插件内由 `paths.mjs` 指引（统一升级，但项目离线不可用）——倾向后者，MVP 期定案；含 §5.3 碰撞残余风险的最终裁决。
2. **外发授权**：已裁决（2026-10-27）——本插件即公共插件，无阻塞；发布前审查项见 §8。
3. **插件命名与市场分类**：`ai-native-delivery` vs `delivery-governance`；分类建议 productivity / workflow。
4. **stack 泛化深度**：dotnet 专有门禁（backend-test）按 `engine.json.stack` 分派的最小实现边界，迁移时逐脚本审计定案。
5. **提问分型机制**：源项目标注"试挂，观察 papercuts 确认税频率再定去留"——机制开关默认关，papercuts 数据自安装起即累积，Phase 2 依数据定去留。

---

## 12. 实现记录（v2.3 → 0.1.0 落地偏差与裁决）

实现收口单元（2026-10-27）对设计假设与实现事实的偏差逐条留档；各条对应的代码/测试落点随文标注。

### 12.1 confirm 台账行的 kind:"task" 判别（§3.3 / §3.4 延伸）

MCP `confirm` 工具写 `.agents/confirmations.jsonl` 的行形态为 `{ts, task, decision, evidence, fingerprint}`——任务级确认记录，没有也不该有 `doc`/`stage` 两键。而 `check-ledger-invariant.mjs` 的行级校验（终树、有提交史路径）按 **doc 绑定行**假设执法（④ doc 四目录协议、⑤ stage 合法终态集），confirm 行一旦入库即被误拦。裁决与落地：

- **根因在校验器，单点改**：`checkRows` 开头按 `kind` 判别分流——无 `kind` 走既有 doc 绑定校验（存量行为零变化）；`kind:"task"` 只验 `{ts,task,decision,evidence,fingerprint}` 五字段在场 + 指纹 64 hex + 时序单调，不要求 doc/stage；**其他 kind 值 = 违规行**（判别键拼错即拦，防未知形态静默溜账）。
- `mcp/core.mjs` 的 confirm 实现同步写 `kind:"task"`（判别键由写入侧诚实声明，读取侧不必反推行形态）。
- §15 确认指纹对账（s15-fingerprint）核实**无需改**：其配对判据 `e.doc === rel && VALID_STAGES.has(e.stage)` 与并录批次审计（同 stage 判据）对无 doc/stage 的 task 行天然不命中——该节只认 doc 绑定行，task 行零影响。
- 测试：`check-ledger-invariant.test.mjs` S13 三态（task 行合法通过 / 缺合法指纹拦 / 未知 kind 拦）；`mcp-tools.test.mjs` confirm 断言补 `kind==="task"`；check-loop.test 281 断言回归全绿（s15 相关断言零改动——核实结论的直接证据）。

### 12.2 wiki 门 optional 降级（§6/§9 工程准入面）

verify 全量门的 `wiki-consistency` 门依赖**项目自带**脚本（wiki 内容源项目专有，不随插件分发）。插件化后通用装户必然缺该脚本——按「缺失降级 SKIP、在场即执法」处置：门表计数与序不变（`--list` 恒 20 仍含本门），判据单源 `verify.mjs` 的 `optionalGateMissing`（缺失合成 SKIP、不 spawn、不计时；`verify.test.mjs` 锁语义）。这是全门表唯一的 optional 位，不构成先例扩散口——新门默认非 optional。

### 12.3 interrogate / blast-radius / tfs-pr 不迁裁决（§4.2 skills 挑选）

三技能不随插件分发，正文引用**保留**并降级为指针：`interrogate`（多镜拆解）与 `blast-radius`（影响面证明）属源项目自建实验件未出库；`tfs-pr` 深度绑定源项目 Azure DevOps PR 流程（供应商专有）。保留引用的理由：`principles.md` / `review.md` 的机制叙述需要指位，`review.md` 已写明降级话术（影响面证明脚本随 PR 或落 `tmp/`）；`test/contract-commands.mjs` 以 `SKILL_REF_ALLOW` 闭集钉住「引用存在但技能本体不迁」的形态，防引用面失控。与市场 `pstack` 插件重名的技能一律以 pstack 侧为准，本插件不复刻。

### 12.4 MTO / PML / ygy 类词残留清单与裁定（§8 脱敏红线）

本单元复查的全量残留（`ygy` 全仓零命中；`MTO`/`PML` 命中如下）：

| 落点 | 形态 | 保留理由 |
| --- | --- | --- |
| `scripts/check-ledger-invariant.mjs` 头注 | `feature/phase2-MTO-PML` 分支名（历史事件叙述） | 机制沿革——历史基线前移的 owner 声明原文，改写即失真 |
| `scripts/check-query-contract.mjs` 头注 | `PMLQuery.projectID` incident 沿革 | 机制沿革——豁免表「现无登记项」的判据出处 |
| `scripts/quote-grounding.mjs` 头注 | 「多条MTO单明细…」引文接地反例 | 机制沿革——判据设计的实证原话 |
| `config-templates/rule-budgets.txt` 注释 | 「MTO 批 commands 增改」轮次记录 | 机制沿革——预算上限轮次惯例的出处链 |
| `test/check-regression-consistency.test.mjs` | `PMLSubmitGuardTests` / `MTOServiceTests` 夹具类名 | 夹具正则联动——提取/悬空判据锚定具体类名，换名即削弱断言 |
| `test/check-scope.test.mjs` 注释 | worktree 命名实例 | 机制沿革——URL 编码缺陷的实证说明 |

裁定：上述均为**机制沿革叙述与夹具判据锚**，非运行时依赖、非业务数据；作为「类词通用化」的诚实边界保留（源项目治理机制本就生长于真实业务，抽掉实证词句的机制叙述反而不可对质）。skills 侧 `review-method` / `verify-ui`（含 features/*）的业务专名随「挑通用者迁」的技能裁定同迁，详见 `NOTICE-ORIGIN.md`「残留词与脱敏裁定」节。

### 12.5 policy_status 退役候选的诚实口径（§3.3 工具表延伸）

设计原文「连续 6 月零命中 → 退役候选」在实现口径上有一处必须诚实声明的边界：judgments 台账只记**命中行**，「全账零命中」的规则不会出现在账内——`agg-judgments.retireCandidates` 的「尾部 6 个有数据月全零命中」判据因此只对「曾经命中过、近 6 月沉默」的规则产候选；数据月不足 6 时不产候选、只报数据月数，**不伪造候选**。`policy_status` 输出以 `caliber` 字段如实标注该口径，并保留 per-rule 全账命中总数（totals）供人工对账（`mcp/core.mjs` toolPolicyStatus）。验收对应 `acceptance.mjs` §10.9②：构造 7 个有数据月、候选规则尾部 6 月全零 → 候选被识别；在役规则不入列。

### 12.6 §11.1 裁决：脚本留插件内

开放问题 §11.1（`.agents/` 脚本落位）定案为**倾向项**：引擎脚本留插件内（统一升级、单源演进），项目侧不复制脚本本体。路径收口单源 `scripts/paths.mjs`（`scriptPath`：项目侧 `.agents/scripts/` 优先、回退插件内本体）；`init-engine` 安装 git hooks 时把占位符实化为该口径解析出的绝对路径。装户离线场景的代价（插件不在则引擎不可用）由插件随宿主常驻的形态兜底；§5.3 碰撞残余风险（项目侧已有同名脚本时优先项目侧）转为显式语义而非缺陷。

### 12.7 skills 最终清单（6 个）

`autonomous-run`（长跑合同）、`review-method`（评审方法论）、`session-resume`（会话恢复）、`decision-log`（过程留痕，2026-10-28 由 `show-me-your-work` 更名以避开与 pstack 的同名冲突）、`verify-ui`（UI 实测，含 features/* 验证件与生成器）、`workflow-closeout`（关单工序）。§10 验收断言落位说明：十条全部收进 `test/acceptance.mjs`（黑盒、全走 CLI/stdio 入口），样板仓端到端为 `test/e2e-fixture.mjs`；两者均接入仓根 CI。

**初始化触发接线（§5.2「首次命令执行触发」的定案形态，2026-10-27 收口）**：按命令文本驱动——`new-task.md` §1 定级前置检测项目根无 `.agents/config/engine.json` 时引导执行 `init-engine.mjs`；**不做 MCP 工具静默自动写盘**（工具面保持只读守门与显式 hint，初始化始终是用户/会话可见的显式动作）。closeout skill 与 review 命令核实无「未初始化假红」场景（其前提是 workflow 文档已在手），不加同款前置。

### 12.8 §3.2 L-ci 裁决：CI 层是项目适配点，插件不附带 CI 模板

§3.2 的拦截模型表把 L-ci 写为「CI workflow 模板（**项目适配点**）」，而 v1 文案（根 `plugin.json`、两份市场清单、插件 README）把它宣传成「PreToolUse 风险闸 + git hooks + **CI 模板**三层拦截」——插件内实际不含任何 CI workflow 模板（`config-templates/` 无 yml），文案与实物不符。

**裁决**：0.1.0 只随插件交付前两层（PreToolUse 风险闸 + git hooks），CI 层保持为**项目适配点**——项目在自己的 CI 里跑 `node <插件安装路径>/scripts/check-loop.mjs --all` 即可补上合入前兜底，插件不代为生成 workflow 模板（生成器/供应商差异属项目侧资产，插件无权替项目选 CI 供应商）。文案侧全部对齐为「前两层随插件 + CI 层为项目适配点」，不再宣称不存在的模板。

