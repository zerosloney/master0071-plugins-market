# agent-pipelines

多代理编排管道套件，合并两条「Orchestrator → 执行者 → 审查者」流水线：

| 命令 | 用途 | 主控 | 执行者 | 审查者 |
|------|------|------|--------|--------|
| `/ralph-pipeline` | 通用任务编排执行审查（线性 TaskList，任意领域） | ralph-orchestrator | ralph-worker | ralph-reviewer |
| `/coding-pipeline` | 受控编码管道（scope 零容忍、根因分组修复、真实验证） | coding-orchestrator | coding-builder | coding-reviewer |

## 机制

两条管道共享同一套骨架，参数不同：

- **状态持久化**：`.loop-cli/state/ralph-pipeline.json` / `.loop-cli/state/coding-pipeline.json`（version=1，原子写入 tmp + rename，可断点恢复）。
- **背压熔断**：连续失败达阈值 ESCALATE；任务状态签名连续无变化判 STALL；轮次达 MAX_CYCLES 强制停止（ralph=10 / coding=8，`max_iterations > 0` 可覆盖）。
- **停止枚举**：`DONE | ESCALATE | HOLD | STALL | MAX_CYCLES | STOPPED`。
- **任务拆分预算**：子任务数 ≤ MAX_CYCLES × 系数（ralph 0.8 / coding 0.75），超限报 `decomposition_overflow` 交用户。

coding 管道额外约束：

- **scope 零容忍**：hard_scope 必做、soft_scope 可做、forbidden_scope 禁碰；diff 一行越界即 `scope_drift="FAIL"`，不允许 DONE。
- **根因分组修复**：多 issue 先归并根因组，一组一次最小修复，禁止逐条打补丁。
- **零证据禁令**：detected_stack 非空且验证脚本 MISSING 时禁止 PASS。
- **完成铁律**：动态检查无 FAIL + 审查 PASS + 零 critical/major + scope_drift PASS。

这些机制全部由 Markdown 指令驱动，插件没有运行时脚本强制执行。状态文件、熔断计数与 scope 判定都依赖 orchestrator 与 reviewer 按协议执行；`test/contract.mjs` 只静态校验文件结构、四份拷贝的参数一致性与 skill 自足性，不能证明管道在某个宿主上跑通。

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

**Codex 兼容垫片**：`.codex-plugin/plugin.json`（配合仓库根 `.agents/plugins/marketplace.json`）。Codex 只声明 `skills`，不加载 `commands/` 与 `agents/`，所以在 Codex 上用 skill 入口而不是斜杠命令；skill 本身是自足的（角色契约内联在 `references/`），不会因缺 agents 而退化。

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
```

零依赖，检查 6 个角色文件与 2 个 skill/command 入口齐全、agent frontmatter 不写死模型、`MAX_CYCLES` / `STALL_MAX` / 拆分预算 / `max_failures` 在三份拷贝中一致、标准 skill 不链接非标准目录、三个垫片都声明 skills 且版本一致。它不执行管道，也不替代真实宿主上的端到端验证。
