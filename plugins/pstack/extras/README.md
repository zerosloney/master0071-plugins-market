# extras/ — 按需启用的非核心组件

本目录集中存放**默认不参与运行、需要额外条件才能用**的组件。它们仍随插件一起分发（不额外下载），
但已移出标准目录树：宿主不会加载它们，ZCode 工作区索引也忽略整个目录（见仓库根 `.zcodeignore`）。
用到时按各目录的启用条件操作即可，不需要的安装可以完全无视这里。

| 目录 | 内容 | 启用条件 |
|------|------|----------|
| `poteto-mode-scripts/` | 上游 vendored 的 bun 专属 TypeScript：`watch-pr` PR 监视器与 `ship-pr`（babysit/shipping playbook 用）、`orch` 状态 CLI（orchestrate playbook 用）、`bootstrap.ts` 及其 `package.json` / `bun.lock` / `tsconfig.json` | 需要 **bun**（`bootstrap.ts` 在纯 node 下会明确报错退出）与 `gh` CLI；首次运行 `bun extras/poteto-mode-scripts/bootstrap.ts` 安装依赖。playbook 与宿主映射文档按本路径调用。**注意**：`watch-pr/` 下的 `ship-pr` 与 `watch-pr` 两个入口是无扩展名的 shebang 脚本（上游原样），Windows 上不能直接双击/直接执行——按 playbook 的命令形式调用（走 bun），或 `bun run <脚本>` |
| `effort-agents/` | 10 个 effort 分级子智能体变体（`effort-low` ~ `effort-max` 与对应 `poteto-agent-*`） | **当前无宿主加载**：Agent Plugins 1.0.0 的 `extensions` 命名空间尚无客户端实现，Claude Code 只认 `agents/`，ZCode 只注册 `agents/` 下 4 个基础代理。按上游原样保留，待宿主支持后移回根目录即可 |
| `upstream-reference/` | 移植前的上游 hook 原文（`session-start.sh` / `.ps1`、`pre-tool-use.sh` 与 4 个 awk 引擎） | **纯参考，无启用条件**：不被任何注册引用，仅用于对照 node 移植版（`hooks/*.mjs`）与上游行为的差异 |

不装 bun 时，`watch-pr` / `orch` 相关的 playbook 步骤（babysit 的 GitHub 监视、orchestrate 的状态簿记）
不可用；playbook 文中已同时给出无 bun 场景的替代路径（`gh` / `origin` 直查）。`skills/poteto-mode/scripts/`
下的 4 个 node 脚本（`check-plan.mjs` / `check-playbooks.mjs` / `resume.mjs` / `worktree-audit.mjs`）
零依赖、随装随用，与 bun 无关。

bun 测试套件（`poteto-mode-scripts/` 下的 `bun test`，覆盖 `orch`、`watch-pr` 与 `check-plan.test.ts`）
仅在上游 POSIX 环境验证过。Windows 下它有三类已知失败：fake 可执行文件无 `.exe` 后缀、`orch` store
锁竞争时序、`watch-pr` 默认 5s 超时，均属平台兼容问题而非本移植回归。
