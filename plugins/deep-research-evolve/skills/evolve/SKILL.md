---
name: evolve
description: 研究档案自主进化：维护 research/ 主题档案库（INDEX.md 主题台账 + 每主题 notes/report），对已研究过的主题做增量复研（revisit）——只检索自上次结论以来的新信息并修订旧报告、追踪置信度演变，可配合宿主定时任务（cron）能力实现周期性自动重访。当用户说「继续研究 X / 复研 / revisit」「上次那个结论现在还成立吗」「有哪些研究主题」「设置定期跟踪 X」「更新修订研究报告」，或定时任务以 revisit 指令自动触发时使用。首次调研某新主题请改用 deep-research。
---

# Evolve 自主进化复研

## Overview

以 `research/` 为持久状态，让调研"越用越准"：复用旧证据、只查增量、修订结论、记录演变、按需自动重访。

## 档案库约定（单源，deep-research 同样遵循）

```
research/
  INDEX.md               # | slug | 标题 | 最后复研 | 当前置信度 | 建议下次复研 |
  research-log.jsonl     # 每行一事件，append-only
  <slug>/
    notes.md             # 累积事实片段（复研的差量基线）
    report-YYYYMMDD.md   # 各期报告，永不删除旧期
    report-YYYYMMDD.html # 可视化产物（由 visual-report 生成）
```

`research-log.jsonl` 行 schema：

```json
{"date":"2026-10-16","topic":"<slug>","action":"research|revisit|report|score|schedule","summary":"一句话变化","confidence":"high|medium|low"}
```

## 三种指令

### `revisit <slug>`（核心回路）

1. 读 `research/<slug>/notes.md` 与最新一期报告，提取"当前结论 + 置信度 + 报告日期"作为基线。
2. 只检索增量：查询词强制带时间限定（如 "after:2026-09"、版本号、"2026 最新"），目标回答两个问题——旧结论是否仍成立？有无推翻性新证据？
3. 差异判定，三选一：
   - **维持**：无实质变化 → 不改报告，只更新 INDEX 的"最后复研"日期与 log。
   - **修订**：局部变化 → 在最新报告末尾追加 `## 修订 YYYY-MM-DD` 段（原结论/新证据/修订后结论/置信度变化），旧结论保留不删，形成可追溯演变链。
   - **推翻**：出现相反的一手证据 → 新写一期 `report-YYYYMMDD.md`，摘要里显式声明"推翻上期结论 X，原因……"，并 log。
4. 每次 revisit 结束输出简短对比：`上期结论 → 本期结论（置信度 高→中，因单新源冲突）`。

深度控制：revisit 检索预算默认为首次调研的 1/3；若发现推翻性信号再升级为完整 deep-research。

### `list`

读 INDEX.md 输出主题台账总览（主题、置信度、距上次复研天数、建议动作），并按 staleness 排序提示哪些主题该 revisit。INDEX 缺失时从 `research/` 目录扫描重建。

### `schedule <slug> <周期>`（自动进化入口）

若宿主提供定时任务工具（cron 类 MCP 工具或宿主内置调度）：

1. 创建周期任务，payload 命令按宿主写法：无命名空间宿主为 `/evolve revisit <slug>`，命名空间宿主为 `/deep-research-evolve:evolve revisit <slug>`；命令后接固定提示词「自动定时复研，沿用既有档案基线；无变化则只更新 INDEX」。
2. 周期建议：快速变化领域（前端框架/AI 模型）7–14 天；缓慢领域（数据库、标准）30–90 天。
3. 创建前向用户确认周期与通知方式；把 cron 任务 id 写入该主题 notes.md 头部注释，log 记 `action:"schedule"`。
4. 宿主无定时工具时，退化为在 INDEX"建议下次复研"列写入目标日期，由人工或下次会话触发。

## 硬约束

- 只读增量检索同样遵守 deep-research 的引用与置信度规则，禁止无证据改判。
- 旧报告与旧 log 行是不可变历史：只追加，不改写、不删除。
- 写入仅限 `research/` 目录。
- 连续两次 revisit 均"维持"且主题非跟踪型（log 无 schedule）时，提示用户可延长周期或退役该主题（移入 INDEX"已归档"节），避免无效检索烧钱。
