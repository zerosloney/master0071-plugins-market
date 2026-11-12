---
name: dream
description: 离线梦境（Dreaming）记忆维护——跑 dream-run 只读审计、读记忆负债报告、处置冷数据候选与终态件归档建议；供主智能体在 post-commit 提示或会话重入发现报告时执行。
---

# dream — 离线梦境（Dreaming）审计链路

## 触发

- post-commit 出现 `[dream]` advisory（距上次审计 ≥7 天或尚无报告）。
- session-resume 重建时发现 `.agents/tmp/dream-report-*.md`。
- 用户主动要求「跑梦境审计 / Dreaming」。

## 1. 运行审计

```bash
node <插件根>/scripts/dream-run.mjs              # advisory 只读审计，报告落 <项目>/.agents/tmp/
node <插件根>/scripts/dream-run.mjs --stale-days 180   # 调冷数据阈值（默认 90 天）
```

- 聚合读 kb-search 命中遥测（`.agents/cache/kb-usage.jsonl`，gitignore 运行态）；遥测数据月不足 3 个时只积累不产候选。
- 本脚本是**只读审计**：不移动、不改写、不删除任何文档，不自动 commit / push。

## 2. 读报告

读最新 `.agents/tmp/dream-report-*.md`，三段：

- **A 记忆负债聚合**：冷数据候选 = 最近 N 天既未被 kb-search 命中、内容也未更新的文档（访问/命中 + 内容更新双维度置信度衰减）。
- **B 终态件归档建议**：仍留在活跃目录的终态件机械粗筛（家族准入与引用终判归 archive-sweep）。
- **C 处置建议**：逐候选的状态 / 命中月数 / 引用数与路由提示。

## 3. 处置（裁决由主智能体/用户，脚本与审计都不代裁）

1. **归档**：`node <插件根>/scripts/archive-sweep.mjs --execute`（终态件家族滚动归档，21 天窗口 + 零引用终判）。
2. **更新**：被转冷但仍有价值的知识走知识维护更新，恢复可检索性与命中。
3. **删除**：**须用户单独指令**（不可逆操作红线；审计建议里的「提名退役」不等于可删）。

## 红线

- dream-run 与本技能只产建议；移动/改写/删除文档必须落到上述对应脚本或用户指令。
- 不自动 commit / push；报告与遥测是本地运行态（gitignore），删除可从台账与 git 重建。
- 遥测数据月不足时不产候选——年轻遥测不得制造假候选，不催办。
