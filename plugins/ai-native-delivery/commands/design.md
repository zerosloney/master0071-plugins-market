---
description: Design 阶段:起 spec（仅 L2/L3；L1 不进本阶段）
stage: Design
triggers:
  - "起个 spec"
  - "接着起 spec"
  - "intent 看过了"
  - "spec 走一下"
delegation:
  - role: independent-reviewer
    instructions: agents/independent-reviewer.md
    when: L2 / L3 spec 草稿完成且用户确认前
    required: true
approval_required: true
next: commands/build.md
---

# Design · 起 spec

## 1. 准入与级别判断
**Input**: `workflow/intents/{name}.md` (Approved) 或已确认的 incident 草稿。级别为 L2 或 L3。
**Process**:
1. **L1 禁入本阶段**: 遇到 L1 $\rightarrow$ **HALT** $\rightarrow$ 回 `commands/new-task.md` §L1 快速道。本阶段只起草 L2/L3 spec
2. **前置校验**: 若入口文档未过确认门 $\rightarrow$ **HALT** $\rightarrow$ 回 `plan.md` / `maintain.md` (exit 2)
3. **级别判定** (对照 `new-task.md` 两问):
   - **L2** (规则/契约): 必须起草 spec $\rightarrow$ **强制独立复核**（独立子智能体或新会话）
   - **L3** (结构/Schema): 必须起草 spec $\rightarrow$ **强制独立复核**（同上，跨模型优先）
**Output**: 确定的设计级别 (L2/L3)

## 2. 起草 spec
**Input**: 选定的级别 + 入口文档
**Process**:
0. **先查后建**: 同功能已有 spec（含归档）/ `verify-ui/features` $\rightarrow$ 原件修订不新建（单源 `workflow/README.md`「同功能续作」）
1. **生成草稿**: 运行 `node <插件根>/scripts/fill-spec.mjs --level <L2|L3> --topic <主题> --output workflow/specs/<date>-<主题>.md`
2. **填实内容**: 复制 `_TEMPLATE.md` $\rightarrow$ 填写 [功能行为 / 数据流 / 系统改动 / 约束遵守映射 / 风险评估]
3. **约束核对**: 对照根 `AGENTS.md` 及目录级 `AGENTS.md` 红线逐条说明满足方式
4. **交互确认**: 明确标注入口形态 (表单/选择器/弹窗)，禁自行推定
5. **入口验证**: [前端专有] 搜按钮事件 $\rightarrow$ 追 router/Drawer $\rightarrow$ 定位真实渲染文件 $\rightarrow$ 在「系统改动清单」标注 **入口证据 (文件+行号)**
6. **方案取舍**: 多方案时 $\rightarrow$ 列出 [方案对照表(取舍+建议)] $\rightarrow$ **HALT** $\rightarrow$ 用户选定。分叉真实且推理定不了（契约形状 / 数据流 / 性能取舍）时，先开 **2 路并行方案**（子代理各一方案，只读仓库、产物落对话或 `tmp/`，禁改仓库文件），按「方案 | 关键取舍 | 风险 | 证据」比选；2 路封顶，推理能定夺的不跑，不占实现面委派并发额度
7. **歧义扫描**: 写「歧义清单」，6 维各一行——状态与边界 / 数据口径 / 失败路径 / 契约对称 / 存量数据 / 验收可测性。列序 `维度 | 结论 | 依据 | 状态`。
   - 可实验 → 先实验，依据写实验结果，**禁问用户**。
   - 实验定不了 → 状态写 `待澄清`，当轮问清。
   - 上界：每维 ≤2 行、合计 ≤12、单轮问询 ≤5。
   - 推断类结论 → 另记「假设与推断」。
   - 缺节 / 缺维 / 待澄清 ≠ 0 / 依据空 / 超界 → 确认门拒。
**Output**: `workflow/specs/{name}.md` (Status: Draft)

## 3. 独立复核 (L2/L3 强制)
**Input**: spec 草稿 + 根/目录级 `AGENTS.md` 红线
**Process**:
1. **委派复核**: 调用 `independent-reviewer`（独立上下文）。必填输入与落盘行以 `agents/independent-reviewer.md` 为准。草稿 spec 尚无 plan 时 Plan 可缺
2. **结果回填**: 主智能体把角色给出的落盘行写入 spec「确认与复核」
**Output**: 复核通过的 spec 草稿。未过则回 §2 改 spec

## 4. 确认与落态
**Process**:
1. **HALT**: 输出 spec 全文 $\rightarrow$ 等待用户确认。确认前自查歧义清单：待澄清归零、6 维齐、每行有依据（不满足则落态被拒）
2. **状态迁移**: $\text{draft} \rightarrow \text{approved}$
3. **落态入口**: 运行 `node <插件根>/scripts/confirm-doc.mjs <path>` (详情见 `build.md` §1. Gates)
4. **留痕提交**: 立即 `docs(workflow)` 单独提交
**Next**: `commands/build.md`

## 🚫 禁止项
| 操作 | 后果 / 机器行为 | 例外 |
|---|---|---|
| 路由认定入口 | → 整轮返工 | 必须提供文件+行号的实测证据 |
| 自行推定交互 | → UI 与需求不符 | 必须由用户确认形态 |
| L3 自查冒充 | `.agents/skills/workflow-closeout/SKILL.md` §0.3 HALT。check-loop 对缺复核上下文只 WARN | 必须由 `independent-reviewer` 执行 |
| 带着「待澄清」走确认门 | `confirm-doc` 拒（歧义未清，exit 2，不落盘不记账）；缺维 / 依据为空同样拒 | 先问用户拿判定再落态 |
| 把可实验项问用户 | 多一轮确认税，且答案本就跑得出来 | 先查库 / 跑 eval / 原型，依据写实验结论 |
| 「已定」不写依据 | `confirm-doc` 拒（等于没想过） | 依据须可指认（节号 / 代码路径 / 查库结果） |

## 🛠️ 辅助工具
- **深度设计**: `codebase-design` (接口收窄) / `domain-modeling` (术语/ADR)
- **压力测试**: `grilling` (方案压力测试)
