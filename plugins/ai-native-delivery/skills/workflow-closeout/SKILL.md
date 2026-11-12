---
name: workflow-closeout
description: 关单序列：verify --scope、验收勾验、closeout 单命令落终态/索引/提交、失败恢复重入。用于把 workflow 文档收到 done/closed，以及 L0 免立档收口。
---

# 关单确认门操作序列

## 目标
把已批准的 workflow 文档收到终态，并留下可对账的验证凭证、确认分片和索引。固定序列收成一次调用：`node <插件根>/scripts/closeout.mjs`（L0–L3 统一入口）。

## 触发条件
- `workflow/{intents,specs,plans,incidents}` 文档要进入 `done` 或 `closed`（incident 两跳 `open→fixed` / `fixed→closed` 各跑一次）。
- L0 极简道收口（免立档，消息体带 `L0: <判据>` 行）走同一入口的 `--l0` 车道。

## 前置
`approved`（incident 为 `open`/`fixed`）已经在当前分支的 git 历史里。还是 `draft` 时，先 `confirm-doc` 到 `approved` 并单独提交，再走下面的关单。

状态行只由 `confirm-doc.mjs` 改。代录使用用户对话里的原话。提交不用 `--no-verify`（closeout 也不提供绕过参数）。自做 L1 不往 `workflow/delegations.md` 写结果行；委派任务和 L2/L3 自做仍按 `commands/test.md` §5 留痕。**承诺面被改写时的出路**：`node <插件根>/scripts/confirm-doc.mjs <doc> --reconfirm --delegated "<用户原话>"`——重录指纹与承诺面指纹，状态仍为 approved（状态行仍由脚本写，不手改 frontmatter）。

## 执行序列

### 0. 关单自核（原 check-loop §1/§3 hard 职责下沉，2026-10-21 门禁极小化第 2 批）
对要关的文档族核对三项，缺任一 → 先补齐再关单，禁带着缺口写 done：

1. **配对自核**：同族同名件齐否——L2/L3 intent 须有同名 spec 与 plan；intent（含存量 L1）须有同名 plan；incident 须有同名 plan（L2/L3 另须同名 spec）。
2. **incident 三件套自核**（关 incident 时）：复盘三件套 `1. 结构性修复 / 2. 防复发验证 / 3. 规范条目` 三节齐 +「是否需要新 intent」行；选「是」→ 引用的 intent 路径存在。
3. **L2/L3 复核上下文必填**：L2/L3 关单前核 intent/spec 正文有 `agents/independent-reviewer.md` 规定的落盘行：以 `- 独立复核：` 起行，且行内含「复核上下文：」。缺则 **HALT** 回 `commands/test.md` §4 补复核后再关。L1 无此前置。
4. **承诺面未被改写（2026-10-27 新增）**：approved 之后若改过**承诺面**（判据文本 / 红线 / 目标 / 改动方案），须先让用户**重新点头**再关单——跑 `node <插件根>/scripts/confirm-doc.mjs <doc> --reconfirm --delegated "<用户原话>"` 重录承诺面指纹（不推进状态）。**勾验收 + 证据回填 / `确认结果` / 复核行改锚不算改承诺**（已归一，正常关单不受影响）。

完成标准：前两项与第 3 项全过；第 4 项在「承诺确有变更」时须先完成重新确认。

### 1. 验证
跑 `node <插件根>/scripts/verify.mjs --scope`。快速道第 5 步刚刚跑过、而且之后没有再改文件时，沿用那次退出码 0 的结果。

完成标准：有一次退出码 0（24h 内绿行落 `.agents/verifications.jsonl`，closeout 预检与 confirm-doc →done 都认它）。scope 判定要全量时脚本自己回落，不手改 `workflow/verify-evidence.md`。

### 2. 勾验收
在文档里逐条勾上验收项并写上证据。L1 勾 plan。L2/L3 新需求勾 intent。修复勾 incident，路径是 `open` → `fixed` → `closed`。

完成标准：每一条验收都能指到证据（命令输出、路径或实测记录）。

### 3. 一次调用关单（代录终态 + 索引 + 提交）
首选一次调用（串接下面 3–5 步，用法与失败恢复见 §5.1）：

```
node <插件根>/scripts/closeout.mjs <workflow/{intents,specs,plans,incidents}/x.md> --delegated "<用户对话原话>" [--msg "<提交主题>"]
```

序列：① confirm-doc 落终态 → ② gen-workflow-index 重生成 → ③ git add 固定路径清单 → ④ 暂存区核对（外来路径即拒）→ ⑤ git commit。incident 两跳各跑一次。不带 `--delegated` 时只做预检快筛（报差距不落态）。

手工等价路径（closeout 不可用时的三步）：
- 代录：`node <插件根>/scripts/confirm-doc.mjs <doc> --delegated "<用户原话>"`
- 索引：`node <插件根>/scripts/gen-workflow-index.mjs`
- 提交：`git add` 这些路径——`.agents/confirmations.d/<文档基名>.jsonl`、`workflow/INDEX.md`、`workflow/verify-evidence.md`，以及被关的文档（关单即归档时为 `workflow/archive/<月>/<类型>/<同名>.md`）。`.agents/confirmations.jsonl` 只有这次 diff 碰到它才加入。提交信息：`docs(workflow): <批次> 关单`。

完成标准：目标文档状态已是 `done` 或 `closed`，关单提交已入库（钩子通过）。

### 4. 索引
`closeout.mjs` 第 ② 步已做。手工路径：跑 `node <插件根>/scripts/gen-workflow-index.mjs`。

完成标准：`workflow/INDEX.md` 已按磁盘重生成。

### 5. 提交
`closeout.mjs` 第 ③–⑤ 步已做：固定候选清单自动 `git add`；**暂存区有候选清单之外的路径即拒绝提交**（不夹带其它在途改动，先单独提交或撤销外来路径再重跑）；提交一律 `git commit -m`，无 `--no-verify`。

### 5.1 一次调用与失败恢复（重入）

任一步失败即停，修因后**重跑同一命令**（幂等：已终态跳过代录——含已随关单归档的件，按归档路径重入；索引生成幂等；无暂存改动跳过 commit）：

- 预检拒（exit 2）：按逐条差距补齐（级别 / 状态受理面 / 验收勾验 / 24h verify 绿行）后重跑。
- confirm-doc 拒：该份未落账、未写盘；按报错补齐（配对 / 三件套 / 复核行 / 验收证据 / 委派台账）后重跑。
- 暂存区夹带外来路径：脚本拒绝提交并列出（步骤 ④）；单独提交或撤销这些路径后重跑（代录与索引已完成，重跑幂等跳过）。
- 钩子拒绝提交：修钩子原因后重跑，不要 `--no-verify`。

### 5.2 L0 免立档车道（不进本序列 0–2 步）

L0 没有文档可关（new-task.md §L0：产品面 ≤5 文件、不立 intent/spec/plan），关单走同一入口：

```
node <插件根>/scripts/closeout.mjs --l0 "<为何够小的判据>" [产品文件…]
```

前置同守 24h verify 绿行；提交消息体自动带行首 `L0: <判据>` 行（commit-msg 顺序门的放行判据）；暂存区护栏同款（候选 = 声明的产品文件 + `workflow/INDEX.md` + `workflow/verify-evidence.md`）。L0 仍须回填与留痕（下面 §6），确认税免的是立档不是记录。

### 6. 回填特性文档

本次行为变化写进对应活文档，并在 plan / incident 留指针；同一特性只保留一个文档：

| 变化类型 | 回填目标 |
|---|---|
| 用户可见交互 / 路径 | `skills/verify-ui/features/<feature>.md` |
| 契约 / 规则 / 数据口径 | 原 spec 原地修订（`workflow/README.md` spec 生命周期） |
| 防复发断言 | `workflow/regression-checklist.md` 对应模块节 |
| 架构 / 方案 | `wiki/开发方案/` |

只追加变化事实与证据指针，不复制整篇；回填随关单提交。没有对应文档时新建一个，topic 带特性键。

### 7. 配方回收（长任务 / 绕路，非事故）

判据（任一）：同一动作在本次会话重复 $\ge 2$ 次；同一处返工 $\ge 2$ 次；为定位入口或环境试探 $\ge 2$ 轮。

动作：把配方写回权威文件一处——优先改现有命令 / 技能 / 角色正文，不新立技能。落点层级按能力分级阶梯判（如宿主装有提供该阶梯的插件可配合使用，否则按本句自身口径执行），本回路通常落第 5 层（文本）。

写法：一句触发条件 + 一步动作 + 一个可指认的验证；引用本次卡点，禁写泛泛建议。

不做：一次性环境故障（进 `.agents/notes/runtime-env.local.md` 或 papercuts `[env]`）；事故走 `commands/maintain.md` 三件套。

提交：`docs(engine)` 单独提交，不夹带业务代码。
