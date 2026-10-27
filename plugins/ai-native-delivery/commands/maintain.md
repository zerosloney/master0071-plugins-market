---
description: Maintain 阶段:立 incident + 复盘三件套(修复 / 防复发 / 规范条目)
stage: Maintain
triggers:
  - "立个 incident"
  - "线上出事了"
  - "记一笔 incident"
  - "出事了,根因 xxx"
delegation:
  - role: implementer
    instructions: agents/implementer.md
    when: 用户已选定止血或结构性修复方案,复现路径与授权文件均明确,且任务满足角色契约
    required: false
    fallback: main
approval_required: true
next: commands/plan.md(若复盘需要新 intent)
---

# Maintain · 立 incident + 复盘三件套

L1 且不是线上事故、复发、数据或契约：只做 §1 立档，然后回 `commands/new-task.md` §L1 快速道。§0 止血和 §2 复盘三件套留给线上事故和 L2/L3。incident 仍然要立。

## 0. 紧急止血 (Active Incident)
**Input**: 故障现象 / 日志
**Process**:
1. **诊断**: 读日志 + 代码 $\rightarrow$ 给出 [止血选项 (回退/回滚/热修/降级)] + [影响面/耗时]
2. **执行**: 方案由用户拍板 $\rightarrow$ AI 仅执行选定方案 (禁自行推送修复)
3. **验证**: 热修后跑 `node <插件根>/scripts/verify.mjs --scope`
**Output**: 服务恢复 $\rightarrow$ 进复盘流程

## 1. 起草 incident
**Input**: 止血完成后的故障上下文
**Process**:
1. **同类检索**: `node <插件根>/scripts/kb-search.mjs "<关键词>" --scope workflow --type incidents` $\rightarrow$ 引用既有防复发条目
2. **创建文档**: 复制 `_TEMPLATE.md` $\rightarrow$ `workflow/incidents/{name}.md`
3. **填写内容**: [时间线 (发现$\rightarrow$恢复)] / [影响面] / [根因 (深层原因)] / [门禁失效分析]
**Output**: `workflow/incidents/{name}.md` (Status: Draft)

## 2. 起草复盘三件套 (The Trio)
**Requirement**: 三件套缺一不可，防复发承诺禁止仅停留在文档中。
**Process**:
1. **结构性修复**: 记录 [修复 commit SHA + 文件清单] $\rightarrow$ 判定是否需立新 intent (根因属门禁缺位/规范未落地 $\rightarrow$ 强制立 `workflow/intents/`)。**攻击前提**：同一前提下两种修法都过不了同一道验证时，停下把前提本身写下来直接测试——防「换皮修复」混过复盘
2. **防复发验证**: 必须落地为 [自动化用例 / `test.md` 步骤 / `regression-checklist.md` 条目]；fixed/closed 建档日起 check-loop 检查 3 扩展硬拦「无自动化用例/回归清单引用」（禁「已人工验证」）
3. **规范条目**: 按照优先级落点：`regression-checklist.md` $\rightarrow$ `hooks/` $\rightarrow$ `skills/` $\rightarrow$ `notes/` $\rightarrow$ `commands/` (禁落 root `AGENTS.md`)。**修复强度阶梯**：落点序是位置序，强度序另判——架构收口/钩子/CI > 自动化用例 > 规范文本；落规范文本时必须在复盘写明「为什么更强的层级拦不住」（agent 跳过文档时，没有任何东西会失败）
**Output**: 落地验证计划 + 规范变更记录

## 3. 确认与落地
L1 且不是线上事故、复发、数据或契约的，已在文首回快速道。本节从线上事故和 L2/L3 起。
**Process**:
1. **HALT**: 输出 incident + 三件套草稿 $\rightarrow$ 等待用户确认
2. **确认分步**: incident 草稿 / spec / plan 分别独立确认 (禁合并)
3. **前置校验**: L2/L3 确认前 $\rightarrow$ `fill-spec`/`confirm-doc` 校验「时间线含用户确认」留痕 $\rightarrow$ 未过则回补
4. **落地执行**:
   - **配 plan**: 必须建立同名 `workflow/plans/{name}.md` (incident $\equiv$ intent, 但 plan 不可免)
   - **实施修复**: L1 $\rightarrow$ 回 `commands/new-task.md` §L1 快速道（同名 L1 plan 即入口，不打开 `build.md`）；L2/L3 $\rightarrow$ `design.md` $\rightarrow$ `build.md` $\rightarrow$ `test.md`
   - **三件套落地**: 执行 §2 中的验证与规范变更
**Next**: 若需追踪系统性问题 $\rightarrow$ `commands/plan.md` 立新 intent

## 4. 确认后关单
**Process**:
1. **状态迁移**: `open` $\rightarrow$ `fixed` (三件套落地) $\rightarrow$ `closed` (防复发验证通过)
2. **落态入口**: 必须通过 `node <插件根>/scripts/confirm-doc.mjs <path>` 逐跳迁移 (禁单跳)
3. **对账**: `check-loop 15` 校验 [关单编辑 $\rightarrow$ closed 确认] 的顺序
4. **关单后裁定回填**: done/closed 文档确需回填裁定 $\rightarrow$ 改正文**同批**在 `.agents/confirmations.jsonl` 追加**重确认补偿行**——同 doc+stage、fingerprint=改后内容指纹 (bindingSha256)、prev 沿用原行、quote=用户裁定原话 (source: chat-delegated)；append-only 不改历史行，check-loop 15 按末次 done 行生效 (重确认场景)。注意 `confirm-doc` 对终态文档无前向跳转，补偿行直接追加台账。**生成器（2026-10-24 起）**：`node <插件根>/scripts/append-compensation.mjs <doc...> --quote "<用户原话>"`——指纹按 bindingSha256 单源计算、写入走 appendLedger（分片口径同确认门），手搓哈希会被 s15 内容漂移门拦（2026-10-24 实证） 

## 🚫 禁止项
| 操作 | 后果 / 机器行为 | 例外 |
|---|---|---|
| 承诺停留在文档 | → 视为未闭环 | 必须落地为代码/脚本/ checklist |
| 根 AGENTS 落地 | → 违反单源纪律 | 必须下沉至 notes/commands/hooks |
| 状态单跳 | check-loop 15 拦截 | 必须 fixed $\rightarrow$ closed |
| 关单后改正文不补录 | check-loop 15 指纹漂移拦截 | 裁定回填须同批补录重确认补偿行 (见 §4.4) |

## 🛠️ 辅助工具
- **根因诊断**: `diagnosing-bugs` 诊断循环
- **事故定性**: `triage` 状态机思路
