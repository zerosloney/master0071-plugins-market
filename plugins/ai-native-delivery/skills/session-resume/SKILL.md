---
name: session-resume
description: 会话重入与中断落盘——接手、切换 worktree、压缩/新会话续作时，先用机器事实重建当前态再动手；供主智能体在任何级别开工前使用。
---

# session-resume — 会话重入与中断落盘

## 触发

- 新会话 / 上下文压缩后继续既有任务；接手他人分支或 worktree。
- 用户问「做到哪了 / 还有什么没提交」。
- 动手前发现工作树不干净，但说不清改动归属。

## 1. 重建（机器事实优先，不靠记忆）

按序跑，全部只读：

| 问 | 命令 | 读什么 |
|---|---|---|
| 在哪 | `node skills/session-resume/scripts/worktree-audit.mjs`（分类 + 清理建议，只读） | 主区 / 活跃 / 可清理 / 失效，一次看全 |
| 什么没落盘 | `git status --porcelain -uall` + `git stash list` | 未跟踪文件与 stash（最易漏） |
| 在飞什么 | `workflow/{plans,specs,intents,incidents}` 活跃态 + `.agents/cache/pipeline-runs/*.json` 末次 | 任务清单勾选态、编排 run 的 stage 进度 |
| 上次绿在哪 | `.agents/verifications.jsonl` 末行（钉 headShort + 24h 窗） | 当前 HEAD 是否已有绿凭证 |

> L2/L3 的 plan 勾选态对齐口径单源 = `commands/build.md`「会话重入」；本技能不复制，只补 L1 与跨 worktree 场景。

## 2. 对齐（不符先停手）

- 勾了未提交 / 提交了未勾 / 工作树有来源不明的改动 → 先确认归属再继续，不覆盖。
- 跨 worktree：未提交改动**不会**自动跟过来。用 `git diff | sha1sum` 比对两树，确认是否同一批改动，避免双份提交。
- 两分支指向同一提交但各有一份改动 = 两套独立工作树，不是共享。

## 3. 输出（4 行简报，先给结论）

```
位置：<worktree> @ <branch> (<headShort>)，ahead/behind
未落盘：<N 改 / M 删 / K 未跟踪 / stash 数>
下一步：<活跃 plan 的下一未勾项 或 run 的下一 stage>
阻塞：<需用户决定的唯一事项；没有写「无」>
```

## 4. 中断落盘（pause）

写 `.agents/cache/handoff.md`（gitignore，本地运行态，可丢弃；git 才是真相）：

```
日期 / 分支 / worktree / HEAD
在飞任务：<workflow 文件>
已完成：<勾选项>
下一步：<第一条>
未提交：<文件清单 + 归属>
阻塞：<无 / 事项>
```

恢复时先读它，再按 §1 核验；两者不符以 git 为准，并回写 handoff。

## 红线

- 不凭记忆续作；不覆盖来源不明的未提交改动。
- 不自动 commit / push WIP；落盘不等于入库，需用户明确要求。
- 不把 `.agents/cache/` 当权威：删除后必须能从 git + 台账重建。
