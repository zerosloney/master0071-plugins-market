# deep-research-evolve（深度研究·自主进化）

深度研究全流程插件：让调研从"一次性问答"变成"持续进化的研究档案库"。

## 技能一览

| 技能 | 职责 |
|---|---|
| `deep-research <主题>` | 拆题 → 多源检索 → 交叉验证 → 带引用报告 → 归档 |
| `evolve revisit\|list\|schedule` | 主题档案库管理、增量复研修订旧结论、定时自动重访 |
| `visual-report <slug>` | 单文件交互式 HTML 报告（内联 SVG、暗亮双主题、引用溯源） |
| `benchmark A vs B ...` | 加权维度打分、对比矩阵、雷达图、敏感性检验与推荐 |

调用方式随宿主而定：支持插件命名空间的宿主写作 `/<插件名>:<技能名>`，其余按技能名直接调用。

## 共享状态

所有技能读写同一档案库（默认当前工作区 `research/`）：

```
research/
  INDEX.md               # 主题台账（置信度、最后复研、下次复研建议）
  research-log.jsonl     # append-only 事件流
  <slug>/notes.md        # 累积事实片段（增量复研的基线）
  <slug>/report-*.md     # 各期报告（不可变历史）
  <slug>/report-*.html   # 可视化交付
```

## 目录结构

```
deep-research-evolve/
  plugin.json                     # 标准清单（Agent Plugins 1.0.0，版本权威来源）
  skills/<name>/SKILL.md          # 四个技能
  skills/visual-report/assets/report-skeleton.html
  CONNECTORS.md                   # 可选连接器说明
  .zcode-plugin/  .codex-plugin/  .omp-plugin/   # 宿主兼容垫片，非标准
```

## 连接器

零外部 MCP 依赖，内置 WebSearch/WebFetch 即用；browser-use 与 repowiki 为可选增强，周期自动重访由宿主定时任务（cron）支撑。能力层级、连接器清单与缺失降级见 [CONNECTORS.md](CONNECTORS.md)。

## 安装

安装方式见仓库根 README 的各宿主安装节。

## 配置

无私有配置，也不需要 Node：纯 skills 包，无脚本、无 MCP 声明，装上即用。

## 版本变更

### 0.1.0

- 初始版本：从源宿主本地插件移植为 Agent Plugins 标准包——根 `plugin.json` + 4 个 skills + 三宿主垫片 + 三份市场条目。
- skill frontmatter 去除客户端专有键 `argument-hint`；原宿主专有的定时任务工具名表述改为宿主中立（宿主定时任务 / cron）。
