# extras/ — 按需启用的非核心组件

本目录集中存放**默认不参与运行、需要额外条件才能用**的组件。它们已移出标准目录树，宿主不会加载。

**分发**：这些文件都在 git 里（`git ls-files plugins/pstack/extras` 可查），所以按仓库安装的客户端会拿到它们——
不含 `node_modules`，那部分是 `bootstrap.ts` 首次运行时装的。

**索引**：仓库根 `.zcodeignore` 把 `poteto-mode-scripts/` 与 `upstream-reference/` 两棵子树挡在 ZCode 工作区索引之外
（bun 专属 TS 与上游 `.sh`/`.awk` 参考，读它们对理解本插件没有帮助）。本 README 与 `effort-agents/` 不在排除范围里。

⚠️ 未实测：ZCode 的**安装**路径是否也尊重 `.zcodeignore`（而不只是工作区索引）。若它也尊重，则 ZCode 装出来的副本
不含这两个子树——此时 `poteto-mode-scripts/` 的脚本需要另外取一份。这是「ZCode 运行时行为」，本仓库无从验证。

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
仅在上游 POSIX 环境验证过。**Windows 实测 253 例**（2026-10-29 第五轮）：
默认 5s 超时下 **250–251 pass / 2–3 fail**，起始是 217 / 36。剩余 2–3 条都是 `orch` 的
多进程锁竞争用例——单独跑能过，整套并行时在 5s 内跑不完；放宽到 30s 则 orch 42/42 全绿。

两类根因都已定位并修复（细节见插件 README 的「bun 套件的 Windows 平台性失败」一节）：

- `orch` store 锁：Windows 不允许 rename 到空目录（`EPERM`），而死 claimant 被清掉文件后会留下
  一个空 `.takeover` 把锁永久占住。`store.ts` 补了 sweep 与重建重试；测试侧另修了一处漏用
  跨平台 `writerWasKilled()` 的断言。
- `watch-pr`/`shipping-cli`：假 gh 改成 `bun build --compile` 出的真 `.exe`，入口改由 node 启动
  （`bun → bun.exe` 固定约 3.5s，而用例预算只有 5s）。206 例全绿，套件耗时 60s → 27s。

CI 不纳入该套件。
