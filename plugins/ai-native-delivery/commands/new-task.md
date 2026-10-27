---
description: AI-Native 闭环总入口:6 阶段指令索引(Plan→Design→Build→Test→Deploy→Maintain)
stage: entry
triggers:
  - "开工"
  - "发个任务"
  - "走闭环"
  - "从头跑"
  - "新需求 <主题>"
  - "要做个 <功能>"
approval_required: true
next: 按阶段路由
---

# New Task · 闭环总入口

## 1. 风险定级 (Step 0: 先定级再路由)

> **初始化前置**：项目根无 `.agents/config/engine.json` 时，先执行 `node <插件根>/scripts/init-engine.mjs` 完成幂等初始化（已存在的文件一律跳过不覆盖），再定级；已初始化则跳过本步。

| 泳道 | 级别 | 判据 | 确认与审计口径 |
|---|---|---|---|
| **协作道** | **L1** 实现级 | 未命中 L2/L3 的实现级改动 | 一份 plan 即入口（来源 / 目标 / 红线 / 改动 / 验证 / 验收）。不另立 intent。独立复核不设同步前置；`--batch` 仅 L1 |
| **防御道** | **L2** 规则/契约 | 见 §L2 触达面闭集 | 同步确认门：spec 确认 $\rightarrow$ plan 确认 $\rightarrow$ 动手 |
| | **L3** 数据/运行时结构 | schema / 迁移 SQL / DI 链 / 认证与中间件管线 | 同 L2 + spec 新会话独立复核，未确认不放行 |

> **两问定级**：结构面（schema / 迁移 SQL / DI / 认证管线）→ L3；契约或共享口径 → L2；两者都没有 → L1。不要按严重程度从 L1 往上滑。
> **提问分型（试挂，观察 papercuts 确认税频率再定去留）**：向用户提问前先分类——答案能跑出来/查出来的（行为/时序/布局/输出/存量数据/eval 可区分）是**可实验的**，预算内先原型/查库/跑 eval 让结果说话，禁停下来问；真正「任何实验都定不了」的产品或偏好判断才升级确认。与 STOP 线正交：可实验不豁免任何红线。
> **落位**: L1 写在 plan frontmatter `级别`；L2/L3 写在 intent。
> **判低拦截**: L1 plan 或 intent 勾触达红线 → check-loop「红线判低」hard 拦 → 升到 L2/L3 并补同名 spec。

### L2 触达面 (闭集，命中任一即 L2)

| # | 类别 | 判据 |
|---|---|---|
| 1 | **编码权威** | 一处生成、多处消费的编码/命名/取号规则 |
| 2 | **共享契约** | 跨模块共享的基类 / DTO 形状 / 公共接口签名 |
| 3 | **既有接口语义** | 既有参数或端点的行为变化（失效变生效、默认值/钳制口径改变） |
| 4 | **全局横切口径** | 错误响应出口、分页与校验口径、聚合投影键 |

> **负例 (落 L1)**: 纯页面表现/文案/布局/交互实现；纯新增端点或参数且行为不变；单模块内部重构且无对外契约变化。
> **自查句**: 能否列出 $\ge 2$ 个受影响的消费方（模块/端点/页面）？能 $\rightarrow$ L2。
> **默认档**: 红线全不勾即 L1。判级只回答「是否命中 L2 四类或 L3 结构面」。

## 1b. todo 播种（pstack 借鉴 2026-10-22）

定级后、动手前，把所选命令的步骤标题**逐字复制**到 todo 列表首项；不另写摘要。跳过的步骤保留在列表里并写 `skip: <理由>`。todo 是执行契约，命令文件是 playbook——本页不复制步骤正文（单源）。

## L1 快速道

命中 L2 或 L3 就离开本页。任务类型以根 `AGENTS.md` §4 为准。L1 做到下面 6 步为止，不打开 `build.md` / `test.md`。

> **接手/恢复**：先读 `.agents/skills/session-resume/SKILL.md` 重建当前态，再走下面 6 步。

1. **定级**：用 §1 两问和 L2 闭集。未命中即 L1，`级别` 写在 plan frontmatter。完成标准：plan 头里的级别与两问结论一致。
2. **检索**：`node <插件根>/scripts/kb-search.mjs --scope workflow --module <token> "<关键词>"`。命中的 incident 根因写进下一步 plan 的自查。完成标准：检索命令跑过；有命中就准备好要写进 plan 的根因，无命中就写明无命中。命中同功能 spec / features $\rightarrow$ 按 `workflow/README.md`「同功能续作」改原件不新建。
3. **立 plan**：`node <插件根>/scripts/fill-plan.mjs --level L1 --topic <主题> --output workflow/plans/<YYYY-MM-DD>-<主题>.md`。填实入口（来源、目标、红线）、改动方案、约束与风险、验证计划、验收标准，并把第 2 步的检索结果写进自查。frontmatter `模块` 改成主导模块。不写 intent，不写预判字段。完成标准：这五节都有正文，检索结论已在 plan 里；验收标准写不出可测试判据就停；红线要么勾中并升到 L2/L3，要么明确不勾。
4. **确认后动手**：`node <插件根>/scripts/confirm-doc.mjs <plan> --delegated "<用户原话>"` 把 draft 收到 approved，然后再改代码。只改 plan 列出的文件。四条红线：不提交密钥或 `.env`、不用 `--no-verify`、最小改动、偏离 plan 先停。**承诺面锁定（2026-10-27）**：approved 之后改「承诺面」（验收判据文本 / 红线 / 目标 / 改动方案）须先让用户重新点头——跑 `confirm-doc.mjs <plan> --reconfirm --delegated "<用户原话>"` 重录承诺面指纹；否则关单被拒、推送被检查 15 hard 拦（勾验收 + 证据回填不算改承诺）。改完后把 approved 的 plan 和代码放进同一笔提交，这一笔不把 plan 标成 done。完成标准：该提交已入库，plan 仍是 approved。
5. **验证**：`node <插件根>/scripts/verify.mjs --scope`。有前端改动再打开 `.agents/skills/verify-ui/SKILL.md`。失败就改代码，不在本页改门禁。完成标准：命令退出码 0，前端改动另有实测证据。
6. **关单**：打开 `.agents/skills/workflow-closeout/SKILL.md`。L1 只关这份 plan。完成标准：plan 为 done，关单提交已入库。

下面才打开别的文件：委派 implementer → `build.md` §3；改了库连接 → `test.md` §2；全量首跑红、隔离重跑转绿 → `test.md` §1；L2/L3 独立复核 → `test.md` §4。

## 2. 级别子路由（纯指针）

任务类型路由**单源** = 根 `AGENTS.md` §4。修复类按级别分流**单源** = `commands/maintain.md` §3（L1 立档后回本页 §L1 快速道；L2/L3 走 `design.md` → `build.md` → `test.md`；根因属门禁/规范缺位另立同名 intent）——本页不复制路由表（2026-10-21 第 3 批两表收敛）。

## 3. intent 豁免规则

| 场景 | 判据 | 处理 |
|---|---|---|
| **AI-Native 引擎面** | 根 `AGENTS.md` §4 引擎面豁免口径（`.agents/` 全部、`.githooks/`、CI yaml、workflow 模板与台账/生成物） | 豁免三件套（intent/spec/plan 与确认门），Conventional Commits 直接 commit；触及业务代码的部分按其级别走 |
| **bootstrap 类改动** | 引入规则本身 | 豁免 intent，commit message 显式声明 `bootstrap` |

## 4. 闭环兜底

- **门禁清单**: 以 `.githooks/` / `.agents/hooks/` / `<插件根>/scripts/check-loop.mjs` 头部注释为准（本文不复述）。
- **hard-block**: 红线判低 / L3 状态 / 回归证据 / 新建 done 未勾验 / 确认指纹 / 承诺面漂移 / 收敛对账；配对断裂与回路断档已降 WARN，自查走 closeout skill §0。
- **禁令**: 本地钩子是本地机器门，禁 `--no-verify`（见根 `AGENTS.md`）。
