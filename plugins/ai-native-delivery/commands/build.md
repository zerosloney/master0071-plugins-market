---
description: Build 阶段:起 plan + 实现代码 + 自验(确认后才动代码)
stage: Build
triggers:
  - "起个 plan"
  - "spec 没问题"
  - "开始写吧"
  - "动手吧"
  - "计划可以了"
delegation:
  - role: implementer
    instructions: agents/implementer.md
    when: plan 与改动文件清单均已确认,且工作包边界满足角色契约
    required: false
    fallback: main
approval_required: true
next: commands/test.md
---

# Build · 起 plan + 写代码

L1 不在本文件起草 plan。「开始写吧」「动手吧」「起个 plan」回 `commands/new-task.md` §L1 快速道第 4 步。打开本文件只为 L2/L3 实现，或委派 implementer（§3）、处理偏离 plan。

## 1. 起草 plan
**Input**: `workflow/intents/{name}.md` (Approved) + `workflow/specs/{name}.md` (Approved)
**Process**:
1. **创建文档**: 复制 `_TEMPLATE.md` $\rightarrow$ `workflow/plans/{name}.md`，填写改动方案 / 任务拆解(带判据) / 执行顺序 / 验证计划
2. **HALT**: 输出刚起草的 plan 全文 $\rightarrow$ 等待用户逐件确认。
**Output**: `workflow/plans/{name}.md` (Status: Approved)
**Gates**:
- **确认门 (confirm-doc)**: $\text{draft} \rightarrow \text{approved}$
- **要求**: 逐件调用 (禁并录) + 逐件原话 (禁复用)
- **依据**: `workflow/papercuts.md`

## 2. 进计划模式列改动
**Input**: `workflow/plans/{name}.md` (Approved)
**Process**:
1. **坑点检索**: `node <插件根>/scripts/kb-search.mjs --scope workflow --module <token> "<关键词>"` $\rightarrow$ 提取 incident 根因入自查项
2. **列清单**: 明确 [读后改/新建] 文件清单 + [动作 $\rightarrow$ 对象] 执行步骤
3. **同步审计**: 改动命中 `commands/` 或 `agents/` 时，正文只改权威源，宿主壳保持指针（见 §🛠️ 辅助与同步）
4. **红线核对**: 对照根 `AGENTS.md` 及目录级 `AGENTS.md` 标注触达红线
5. **HALT**: 输出改动清单 $\rightarrow$ 等待用户确认
**Output**: 确认的改动清单 $\rightarrow$ **回填 plan「改动面/任务拆解」落盘**（session-context：对话留痕仅供当次，重入以 plan 为准——改动面 + 任务勾选态 + git status = 会话重入三锚）

## 3. 实现与自验
**Input**: `workflow/plans/{name}.md` (Approved，含落盘的改动面与任务清单)
**Process**:
1. **会话重入**（压缩 / 新会话 / 交接续作必走）: 读 plan 任务清单勾选态 + `git status` / `git diff` 现场比对 $\rightarrow$ 重建进度再继续。勾选态与工作树不符（勾了未提交 / 提交了未勾）$\rightarrow$ 先对齐再写新代码；改动清单只在对话里时，以 plan 改动面 + 工作树为准并回填 plan
2. **推进实现**: 按依赖执行任务——**frontier = 任务拆解中「依赖」行无未决阻塞的任务**，可并行派发（多 worktree 各自分支 / 委派「新开+合并范围」），纯顺序链即自上而下；**每完成一项立刻回填任务清单勾选与留痕**（commit SHA / 测试名 / 实测输出），并解锁依赖它的下游任务。满足 `agents/implementer.md` 边界时可委派 `implementer`（模型取 `model-roles.json`，本地覆盖优先，皆空 = 宿主默认）
3. **架构约束**: 严禁自创旁路数据访问，必须遵循根/目录级 `AGENTS.md` 红线
4. **L3 专项**: Schema 变更必须走项目约定维护方式，禁擅自引入迁移机制
5. **变更管控**: 若需偏离 plan (改公共接口 / 动未列文件 / 引新依赖) $\rightarrow$ **HALT** $\rightarrow$ 确认后继续
6. **自验闭环**: 运行 [项目构建 / 类型检查 / 自动化测试] (详见 `test.md` §1)；范围对账 `node <插件根>/scripts/check-scope.mjs workflow/plans/{name}.md`——越界件即收口（回填 plan 或回滚），`--strict` 供门禁化调用
**Output**: 实现的代码变更 + 自验通过证据

## 4. 确认后收尾
**Process**:
1. **状态迁移**: plan 保持 `approved`，不在此置 `done`。本文件只服务 L2/L3：关单在 `test.md` §5，经 confirm-doc 置 `done`。
2. **提交留痕**: intent/spec 在 design 确认后单独 `docs(workflow)`。plan 确认后同样单独 `docs(workflow)`，不与代码同一提交。Conventional Commits 中文。
3. **脚本化改写**：改 workflow 文档或台账用 `node <插件根>/scripts/rewrite-file.mjs <文件> --find <字面串> --replace <字面串>`。禁止 `node -e` 配 `writeFileSync`（CRLF 检出上会静默没改到还打印成功）。
**Next**: `commands/test.md`

## 🚫 禁止项
| 操作 | 机器行为 | 例外 |
|---|---|---|
| 直改 frontmatter | 状态迁移失效 | 必须通过 `confirm-doc` |
| draft $\rightarrow$ done | check-loop 15 拦截 | 必须经 approved 中转 |
| 摘要确认 | confirm-doc 拒绝 | 必须全文过目 |

## 🛠️ 辅助与同步
- **复杂任务**: 在 plan 任务拆解写「依赖」行。无未决阻塞的任务即可开工
- **宿主是指针壳**：改 `commands/` 或 `agents/` 不要把正文抄进 opencode / trae / codebuddy。壳只保留宿主 frontmatter，并写明权威路径。`check-loop --hygiene` 检查壳不断线、不过厚。
- **改动面纪律**: plan 改动面列权威源路径。宿主壳未改就不要把 `wf-*.md` 写进改动面。
- **自检**: 改 check-loop 后跑 `node <插件根>/scripts/check-loop.mjs`
