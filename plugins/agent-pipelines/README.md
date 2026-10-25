# agent-pipelines

多代理编排管道套件，合并两条「Orchestrator → 执行者 → 审查者」流水线：

| 命令 | 用途 | 主控 | 执行者 | 审查者 |
|------|------|------|--------|--------|
| `/ralph-pipeline` | 通用任务编排执行审查（线性 TaskList，任意领域） | ralph-orchestrator | ralph-worker | ralph-reviewer |
| `/coding-pipeline` | 受控编码管道（scope 零容忍、根因分组修复、真实验证） | coding-orchestrator | coding-builder | coding-reviewer |

## 机制

两条管道共享同一套骨架，参数不同：

- **状态持久化**：`.loop-cli/state/ralph-pipeline.json` / `.loop-cli/state/coding-pipeline.json`（version=1，原子写入 tmp + rename，可断点恢复）。路径按仓库固定：并发跑同类管道需把其中一条改成会话专属 `--file` 路径，否则互相覆盖状态。
- **背压熔断**：连续失败达阈值 ESCALATE；**单任务失败达 `max_attempts`（默认 4）立即 ESCALATE**；任务状态签名连续无变化判 STALL；轮次达 MAX_CYCLES 强制停止（ralph=10 / coding=8，`max_iterations > 0` 可覆盖）。
- **失败教训回填**：每轮委派执行者时，把 `fail_history` 聚合为"失败教训"注入 worker/builder 上下文，避免重复踩坑。
- **并行委派就绪任务**：每轮把全部 `pending` 且依赖已 `done` 的任务按拓扑顺序委派，多个就绪任务并行执行，不串行等待。
- **停止枚举**：`DONE | ESCALATE | BUDGET | HOLD | STALL | MAX_CYCLES | STOPPED`。
- **任务拆分预算**：子任务数 ≤ MAX_CYCLES × 系数（ralph 0.8 / coding 0.75），超限报 `decomposition_overflow` 交用户。

coding 管道额外约束：

- **scope 零容忍**：hard_scope 必做、soft_scope 可做、forbidden_scope 禁碰；diff 一行越界即 `scope_drift="FAIL"`，不允许 DONE。
- **根因分组修复**：多 issue 先归并根因组，一组一次最小修复，禁止逐条打补丁。
- **零证据禁令**：detected_stack 非空且验证脚本 MISSING 时禁止 PASS。
- **完成铁律**：动态检查无 FAIL + 审查 PASS + 零 critical/major + scope_drift PASS。

这些机制默认由 Markdown 指令驱动；插件另附零依赖脚本，宿主能执行 shell 时优先使用，不能执行时按文本规则继续，行为不变。

## 可选脚本

| 脚本 | 作用 |
|---|---|
| `scripts/state.mjs` | `init` / `validate` / `write`（stdin + 原子写，自动记录任务状态迁移）/ `gate`（按 `max_failures`、`STALL_MAX`、`MAX_CYCLES`、`scope_drift`、`budget` 计算 `stop_reason`，`--apply` 写回）/ `events`（读事件日志） |
| `scripts/scope.mjs` | `git diff --name-only <base>` 加未跟踪文件，对比 hard/soft/forbidden scope，输出 `scope_drift=PASS/FAIL`；默认排除 `.loop-cli/**` |
| `scripts/graph.mjs` | 依赖拓扑排序、循环依赖检测、子任务预算检查（ralph 8 / coding 6） |

| `scripts/render.mjs` | 只读渲染：状态文件 + 事件日志 → 自包含单文件 HTML（依赖图 DAG、事件轨迹、预算） |
| `scripts/serve.mjs` | 本地实时看板：HTTP + SSE 监听状态文件与事件日志，浏览器自动刷新（默认只绑 127.0.0.1） |

```bash
node scripts/state.mjs init --pipeline coding --prompt "修复登录问题"
node scripts/state.mjs gate --pipeline coding --file .loop-cli/state/coding-pipeline.json --json
node scripts/scope.mjs --base <base-commit> --file .loop-cli/state/coding-pipeline.json --json
node scripts/graph.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json --json
node scripts/state.mjs events --pipeline coding --tail 20
node scripts/render.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json --out .loop-cli/state/coding-pipeline.html
node scripts/serve.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json --port 8787
```

`render.mjs` 是只读可视化：读取状态文件与事件日志，生成**自包含单文件 HTML**（内联 CSS、无外链），含摘要卡片、按依赖分层布局的任务 DAG（状态着色）、事件时间线、预算与 `stop_reason`。`state.mjs write` 每次会对比旧状态，把任务状态变化（含新任务注册）作为 `transitions` 记录到事件日志，渲染时在事件行内联展示（如 `t2:pending→done`）。输出默认是状态文件同名 `.html`；不写状态、不追加事件、不取锁。

`serve.mjs` 是实时看板：本地 HTTP 服务提供页面与 SSE（`/events`），用 `fs.watch` + 轮询兜底监听状态文件和事件日志，变化时向浏览器推送 `render` 事件自动刷新。默认只绑 `127.0.0.1`，只读不写状态。`--interval` 控制轮询间隔（默认 1000ms）。

scope 也可直接传 `--hard "src/**,test/**" --soft "docs/**" --forbidden "dist/**"`；或把 `scope` 对象写进状态文件（可选字段，`state.mjs` 不强制）。脚本退出码：0 PASS / 1 FAIL / 2 参数或环境错误。

预算：状态文件可写可选 `budget` 对象 `{ max_tokens?, max_cost_usd?, spent_tokens?, spent_cost_usd? }`；达到上限时 gate 判 `BUDGET`。Reviewer 的 PASS 必须附 `evidence`（`file:line`、命令与输出摘要、accept_criteria 对照），无证据按 NEEDS_FIX 处理。

加锁与事件日志：`init` / `write` / `gate --apply` 会取 `<state>.lock`（30 秒陈旧锁自动清理，最多等 2 秒），并向 `<state>.events.jsonl` 追加事件。事件日志用于断点恢复和事后审计，写失败不影响主流程。

宿主加载矩阵（0.1.3 实测）：Codex 0.163.0 安装后 skills 可见，模型报告 `agent-pipelines:coding-pipeline` 与 `agent-pipelines:ralph-pipeline`；commands/agents 按 Codex 规则不加载。Oh My Pi 18.12.6 安装后缓存含 2 skills / 2 commands / 6 agents，模型确认两个 skill 可用。ZCode 没有 CLI 安装入口，需 GUI，未实测。contract 继续检查三个垫片声明的路径真实存在。

`test/contract.mjs` 校验静态契约（89 断言），`test/pipeline.mjs` 跑状态机、scope、锁、事件日志、任务状态迁移、预算、依赖图、可视化渲染、实时看板与单任务上限（81 断言），`test/equivalence.mjs` 把 4 份提示词文档写死的编排规则与 `scripts/state.mjs` 的源码常量及 `gate` 实际行为做等价性锚定。三者都不替代真实宿主上的端到端运行。

## 使用

两种入口，机制完全一致：

| 入口 | 宿主要求 | 文件 |
|------|---------|------|
| `/ralph-pipeline <目标>` / `/coding-pipeline <编码任务>` | 支持斜杠命令的宿主 | `commands/`（客户端约定） |
| 加载 `ralph-pipeline` / `coding-pipeline` skill | 支持 Agent Skills 的宿主 | `skills/`（**Agent Plugins 1.0.0 标准**） |

Orchestrator 全程通过子代理工具委派，不直接产出业务代码；每轮写入状态文件并按门禁决定停止。

## 子智能体模型策略

agents frontmatter **不写死 `model`**，一律回退宿主会话的默认模型——换账号、换供应商、换宿主的用户装完即可直接用，不需要改文件。

需要分层模型（主控用强模型、执行/审查用轻模型）时，在各 agent frontmatter 里自行补 `model` 字段即可，其余内容不用动。

## 宿主支持

按 [Agent Plugins 1.0.0](https://agent-plugins.org) 打包，根 `plugin.json` 是标准清单（`$schema` + `name` 必填，版本以此为准）。

### 可移植核心（标准，Agent Plugins 兼容客户端会加载）

| 路径 | 内容 |
|------|------|
| `skills/ralph-pipeline/SKILL.md` | Ralph 管道编排协议（状态 schema、拆分判据、委派契约、停止枚举） |
| `skills/ralph-pipeline/references/worker-role.md` | ralph-worker 角色契约（内联，可移植宿主不加载 `agents/`） |
| `skills/ralph-pipeline/references/reviewer-role.md` | ralph-reviewer 角色契约 |
| `skills/coding-pipeline/SKILL.md` | Coding 管道编排协议（含 scope 零容忍、根因分组、零证据禁令） |
| `skills/coding-pipeline/references/builder-role.md` | coding-builder 角色契约 |
| `skills/coding-pipeline/references/reviewer-role.md` | coding-reviewer 角色契约 |

skill 是**自足**的：不引用 `agents/` 与 `commands/`，角色契约内联在 `references/`（相对 skill 根恰一层深，符合 Agent Skills 引用规则）。任何支持 Agent Plugins 的宿主装上即可用。

### 客户端约定（非标准，可移植宿主会忽略）

| 路径 | 状态 | 谁在用 |
|------|------|--------|
| `commands/` | 客户端约定 | 支持斜杠命令的宿主（`/ralph-pipeline`、`/coding-pipeline`），走 `agents/` 的 `agent:` frontmatter |
| `agents/` | 客户端约定 | 支持子智能体的宿主（6 个 .md，含 `color` / `thoughtLevel` / `tools` 等宿主字段） |
| `.zcode-plugin/` | **非标准 ZCode 兼容垫片** | ZCode 的设置页与 `/plugin marketplace add` 装法 |
| `.codex-plugin/` | **非标准 Codex 兼容垫片** | Codex 的插件发现（`skills` + `interface`）；Codex 不加载 `commands/` 与 `agents/` |
| `.omp-plugin/` | **非标准 Oh My Pi 兼容垫片** | Oh My Pi（`omp`）；同时加载 `skills`、`commands`、`agents` |

`commands/` 与 `skills/` 是**两套等价入口**，不是薄封装——刻意保持各自完整，因为各宿主加载的组件类型不同（有的只认斜杠命令、有的只认 skill），无法假设命令入口总能唤起 skill；让 `commands/` 依赖 skill 加载会把部分宿主上的唯一入口变成空壳。

> **维护提示**：改动编排判据（`MAX_CYCLES`、`STALL_MAX`、拆分预算、完成标准、停止枚举）时，**必须同步改 4 处**：
> `commands/<pipeline>.md`、`skills/<pipeline>/SKILL.md`、对应 `agents/<pipeline>-orchestrator.md`、本 README 的「机制」表。
> 改完运行 `node test/contract.mjs`，它会拦截参数漂移、缺失的角色文件、垫片漏声明 skills 与版本不一致。

**ZCode 兼容垫片**：`.zcode-plugin/plugin.json` 与仓库根 `marketplace.json` 保留，ZCode 装法不变。两处版本必须一致（`node scripts/release.mjs --check` 校验）。代价：规范要求包内有且仅有一个根 `plugin.json`。

**Codex 兼容垫片**：`.codex-plugin/plugin.json`（配合仓库根 `.agents/plugins/marketplace.json`）。Codex 只声明 `skills`，不加载 `commands/` 与 `agents/`，所以在 Codex 上用 skill 入口而不是斜杠命令；skill 以 `agent-pipelines:` 命名空间出现（如 `agent-pipelines:ralph-pipeline`）。skill 本身是自足的（角色契约内联在 `references/`），不会因缺 agents 而退化。

**Oh My Pi 兼容垫片**：`.omp-plugin/plugin.json`（配合仓库根 `.omp-plugin/marketplace.json`）。omp 同时加载 `skills`、`commands`、`agents`，是唯一能拿到 6 个编排子智能体的宿主——想用子代理委派就装 omp。

`injectAgentsMd` / `thoughtLevel` 等是宿主增强 frontmatter 字段：支持的宿主按其语义生效，不支持的宿主忽略未知字段，不影响加载。

## 委派机制的宿主差异

两个 orchestrator 只声明语义（委派给哪个子代理、注入哪些 `=== X ===` 段落），参数名按宿主实际 schema 填写：

| 语义 | 宿主子代理工具（如 ZCode `task`） | Claude Code `Task` |
|------|-----------------------------|---------------------|
| 目标子代理 | `target` | `subagent_type` |
| 任务标题（3-5 个词） | `description` | `description` |
| 完整上下文正文 | `query` | `prompt` |

宿主若不支持子代理委派，命令正文会退化为主会话直接扮演 orchestrator，不会静默失败。

状态文件写在**项目工作区**的 `.loop-cli/state/` 下，不写入插件目录。

## 测试

```
node test/contract.mjs
node test/pipeline.mjs
node test/equivalence.mjs
```

零依赖。`contract.mjs` 检查 6 个角色文件与 2 个 skill/command 入口齐全、agent frontmatter 不写死模型、`MAX_CYCLES` / `STALL_MAX` / 拆分预算 / `max_failures` 在三份拷贝中一致、标准 skill 不链接非标准目录、三个垫片都声明 skills 且版本一致。`pipeline.mjs` 跑状态机、scope、锁、事件日志、任务状态迁移、预算、依赖图与可视化渲染。`equivalence.mjs` 把 4 份提示词文档（commands/ + skills/）写死的编排规则（`MAX_CYCLES` / `STALL_MAX` / 默认值 / `stop_reason` 枚举）锚定到 `scripts/state.mjs` 的源码常量，并用最小合法状态验证文档声明的判停规则与优先级和 `gate` 实际输出一致——文档与脚本漂移时以脚本为准修文档。它们不执行管道，也不替代真实宿主上的端到端验证。
