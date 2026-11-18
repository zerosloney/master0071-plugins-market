# tech-code-refactoring（技术债重构工作台）

技术债重构全流程插件：从量化摸底到减法收尾，七个技能、六步编排，全程以「行为不变」为安全底线。

## 技能一览

| 技能 | 定位 | 输入 → 输出 |
|---|---|---|
| `code-analyzer` | 深度结构分析，多语言 AST 量化摸底 | 目标路径 → 结构报告（复杂度/依赖/循环依赖 + 人工研判） |
| `agent-git-oracle` | Git 历史技术债检测 | 仓库提交历史 → 热点与债区清单 + 重构优先级建议 |
| `uncle-bob` | SOLID 与整洁代码评审 | 代码文件 → 按文件分级的 P0-P2 findings |
| `code-refactoring` | 经典重构手法安全执行 | 评审发现 → 原子提交 + 重构记录 |
| `system-architect` | 目标架构与模块化对齐 | 摸底报告 + 债区清单 → ARCHITECTURE.md + ADR |
| `simplify` | 行为不变的减法收尾 | 已验证代码 → 删除与收缩提交 + 减法清单 |
| `refactoring-workflow` | 六步编排路由入口 | 重构类请求 → 全流程编排与出圈保护 |

调用方式随宿主而定：支持插件命名空间的宿主写作 `/<插件名>:<技能名>`，其余按技能名直接调用。

## 六步工作流

```
① code-analyzer 量化摸底（多语言 AST）
        │ report.md（复杂度/依赖/循环依赖）
        ▼
② agent-git-oracle 历史侦债
        │ 债区清单 + 优先级建议
        ▼
③ uncle-bob 质量评审
        │ P0-P2 findings
        ▼
④ code-refactoring 执行重构
        │ 原子提交 + 重构记录
        ▼
⑤ system-architect 架构对齐（仅当债区反映结构问题）
        │ ARCHITECTURE.md + ADR
        ▼
⑥ simplify 减法收尾
          减法清单 + 干净工作树
```

单文件小任务走轻道 ③→④→⑥；任一步出现行为改变、跨模块扩散、公共 API 变更或需要新依赖，立即停下确认——出圈保护规则详见 refactoring-workflow 技能。

## 脚本环境要求

- Node ≥ 18（含 WebAssembly 支持）；code-analyzer 的量化脚本（`scripts/analyze.mjs`）的 AST 引擎为随插件分发的 vendored tree-sitter，无需任何包管理器安装。
- 其余技能为纯方法指导，不依赖脚本；agent-git-oracle 只要求目标仓库有 git 历史。

## 目录结构

```
tech-code-refactoring/
  plugin.json                     # 标准清单（Agent Plugins 1.0.0，版本权威来源）
  skills/<name>/SKILL.md          # 七个技能
  .zcode-plugin/  .codex-plugin/  .omp-plugin/   # 宿主兼容垫片，非标准
```

## 安装

安装方式见仓库根 README 的各宿主安装节。

## 配置

无私有配置：除 code-analyzer 的量化脚本（Node ≥ 18 零依赖）外均为纯 skills 包，装上即用。

## 版本变更

### 0.2.0

- code-analyzer 升级多语言 AST 分析：基于随插件分发的 vendored tree-sitter（9 语言：JS/TS/TSX/Python/Java/Go/Rust/C/C++），函数级与文件级精确指标、函数级复杂度热点 top10、依赖图精确提取；启发式层保留为降级路径（vendor 缺失/加载失败自动回退，`--heuristic` 可强制）；vendored 资产来源与许可见 NOTICE.md。

### 0.1.0

- 首版：全新原创实现——7 个技能（量化摸底、Git 侦债、SOLID 评审、安全重构、架构对齐、减法收尾、六步编排路由）+ 标准清单与三宿主兼容垫片。
- code-analyzer 量化脚本接口锁定为 `node <skill目录>/scripts/analyze.mjs --path <目标> [--output report.md] [--exclude 片段]`，零外部依赖（Node ≥ 18）。
- 全流程以「行为不变」为安全底线，内置出圈保护：行为改变、跨模块扩散、新依赖、公共 API 变更即停。
