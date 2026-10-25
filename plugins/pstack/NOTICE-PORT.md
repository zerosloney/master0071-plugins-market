# pstack 移植说明（NOTICE）

本目录是 **第三方 MIT 插件的打包移植**，按 [Agent Plugins 1.0.0](https://agent-plugins.org) 标准重新打包进 master0071-plugins 市场仓库。fork 基线内的 skill 正文、子智能体与 hook 脚本逐字保留；上游 v0.15.26–v0.15.28 的 skill 级变更已按同一套适配约定合入（见「本移植所做的修改」第 6 条）。

## 上游来源

| 项 | 值 |
| --- | --- |
| 移植源 | [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) 的 `plugins/pstack/` |
| 源版本 | `0.9.86`（仓库 `VERSION` 文件） |
| 源提交 | `1dba27e50e8f18f146bb80f137f0690f8d773c2e`（2026-10-15），其内容同步自 cursor/plugins `99743e9`（v0.15.25） |
| 内容同步 | [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) @ `d4575673`（v0.15.28，2026-10-19）——相对 fork 基线 v0.15.25 的全部 skill 级 delta 已按本移植既有适配风格合入（见下） |
| 移植版权 | © 2026 Michael Denyer（port），MIT |
| 本仓库改写层 | © 2026 master0071（本仓库对打包层、hook 的 node 重写、清单垫片与文档的改写与新增），MIT |
| 原始作品 | [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)，© 2026 Lauren Tan (poteto)，MIT |
| 另含组件 | `deslop` / `make-pr-easy-to-review` / `fix-ci` / `fix-merge-conflicts` / `get-pr-comments` / `what-did-i-get-done`（© 2026 Cursor，MIT）；`thermos` / `thermo-nuclear-*`（© 2026 Cursor，MIT） |

完整的逐组件归属表见 [`NOTICE.md`（上游原文）](NOTICE.md)，技能级归属见 [`NOTICE-skills.md`](NOTICE-skills.md)。对应许可证正文：[`LICENSE`](LICENSE)、[`LICENSE-cursor-team-kit`](LICENSE-cursor-team-kit)、[`LICENSE-thermos`](LICENSE-thermos)。

**再分发条件**：保留上述全部版权声明与许可证文件。上游 README 中提到的 Pi 扩展、Codex 命令垫片、图片资源在本移植中已剔除（见插件 README「与上游的差异」）；Codex 侧改用本移植自己写的 `.codex-plugin/plugin.json`，不影响任何 skill 的可用性。

## 本移植所做的修改

1. 位置改写：上游仓库的 `.claude-plugin/plugin.json`（Claude 专用清单）→ 本目录根 `plugin.json`（Agent Plugins 标准清单，封闭 schema）；上游仓库根的 `.claude-plugin/marketplace.json` → 本仓库根 `marketplace.json`。
2. 剔除：`.claude-plugin/icon.png`、`assets/`（约 1.9 MB 图片）、`pi/`（Pi 扩展，`skills/poteto-mode/references/pi-tools.md` 映射文档一并剔除）、`skills/poteto-mode/references/licenses/`（上游 skills-only 分发用的许可证副本，与本目录根三份 LICENSE 重复）、`.github/`（上游 CI 配置）、`tools/`（上游生成脚本；skill 内对该脚本的引用已改为「编辑 `models.json` 后手工同步各 Models 列表」，本移植不附带生成脚本）。`skills/poteto-mode/references/agents/comment-sicko.md` 与 `agents/comment-sicko.md` 双份保留是有意拷贝（codex-tools.md 引用前者）。
3. 新增（非上游原文，属本移植的打包层）：`.codex-plugin/plugin.json`——上游那份 `.codex-plugin/` 已随第 2 条剔除，本仓库按 Codex 插件 schema 重写了一份，只声明 `skills`、`SessionStart` hook 与 `interface` 展示信息，不含上游的 `prompts/` 命令垫片。
4. 改写 hook 执行层（非上游原文）：上游的 `session-start.sh` / `pre-tool-use.sh` / `session-start.ps1` 及其 awk 引擎在 Windows 宿主上经 shell 执行 `.sh` 会被按文件关联"打开"而非运行，故本移植将其全部移植为 node 脚本——`hooks/session-start.mjs`（统一 SessionStart 入口：宿主自检——检测到 `ZCODE_PLUGIN_ROOT`，或插件根路径含 `.zcode` 目录段（大小写不敏感、按段精确比对，`ZCODE_HOME` 可改模型表位置），即走 zcode 分支，否则按参数走 claude/codex/copilot；claude/codex 输出原文路由令，copilot 输出含角色行的 JSON，zcode 输出 `hookSpecificOutput.additionalContext` JSON）、`hooks/pre-tool-use.mjs`（Copilot PreToolUse 权限闸，含严格 JSON 解析与脚本契约；路径围栏用 `path.isAbsolute` 判定绝对路径并支持 Windows 盘符，`cwd` 全程显式传参，hook 输入缺 `cwd` 时向 stderr 记一行诊断后静默放行）、共享的 `hooks/sheet.mjs`（表解码与校验，移植 read-sheet.sh 与 sheet.awk）。三份 hook 注册（`hooks/hooks.json`、`hooks/copilot-hooks.json`、`.codex-plugin` 内联）全部改为 node 调用；ZCode 实测按约定路径注册 `hooks/hooks.json`、不理会垫片 hooks 指针，靠脚本内自检切换分支。原 `.sh`/`.ps1`/`.awk` 共 7 个文件移入 `extras/upstream-reference/` 保留为上游参考（0.1.5 前位于 `hooks/upstream-reference/`），不再被任何注册引用；hook 依赖宿主机 Node ≥ 18。测试：`test/run-hook-tests.mjs`（hook 契约与表解码，含 resume/log/transcript 契约正反例）与 `test/sheet-parity.mjs`（awk↔mjs 一致性，无 awk 环境自动跳过）。另新增 `skills/poteto-mode/references/zcode-tools.md`（ZCode 工具与模型映射），setup-pstack 的运行时表补 ZCode 行，poteto-mode 的 Platform Adaptation 节补 ZCode 句。
5. 版本号独立：本插件以 `0.1.x` 发布，与上游 `0.9.86` / `0.15.x` 解耦；升级上游时对照上面的「源版本 / 源提交 / 内容同步」三行。
6. fork 基线内的 skill 正文、playbooks、scripts 与子智能体定义**以本移植的中性化改写为准**，不再逐字保留。改写有两条约定：① frontmatter 按 [Agent Skills 规范](https://agentskills.io/specification) 统一改写——剥除 Cursor / Claude 专有键（`user-invocable`、`paths`），只保留规范字段 `name` / `description` / `license` / `compatibility`（`license` 统一为 MIT，`compatibility` 只在确有环境依赖时写）；② 正文里写死的 Claude 路径与清单名改为宿主中立表述——`.claude/skills/`、`~/.claude/skills/` 改为「宿主的项目级 skill 目录 / 用户级 skill 目录」，`~/.claude/projects/` 改为「宿主的按项目 transcript 目录」，`~/.claude/orchestrate/` 改为「宿主的 agent store」，`~/.claude/plugins/` 与 `.claude-plugin/plugin.json` 改为「宿主的插件目录」与标准清单 `plugin.json`；各宿主的具体路径由 `skills/poteto-mode/references/<host>-tools.md` 新增的路径对照表给出。正文的 **Claude Code 工具名与模型名保留为参考平台口径**，各宿主仍通过自己的映射文件翻译。相对 fork 基线新合入的上游 delta（v0.15.26–v0.15.28）沿用同一套适配约定：剥除 Cursor 专有 frontmatter 键（`disable-model-invocation` 等）、Claude Code 工具名与模型口径、技能间相对链接。唯一例外早于本轮：`skills/setup-pstack/scripts/read-sheet.sh` 与 `hooks/session-start.ps1` 补了 1 MiB 读取上限（超限按缺失同方向降级，shell 与 PowerShell 两侧对称），见提交 815c1da。
7. 上游 v0.15.28 的 `docs/guide/`（指南）与 `make-bot-ui` skill（Grok Bot webhook 唤醒，Cursor 生态绑定）未随同步纳入，与移植源的剔除决策一致。
8. 0.1.5 布局调整：bun 专属 vendored 脚本（`watch-pr` / `orch` / `bootstrap.ts` 及其 `package.json` / `bun.lock` / `tsconfig.json`）从 `skills/poteto-mode/scripts/` 迁至 `extras/poteto-mode-scripts/`，10 个 effort 分级子智能体从根目录迁至 `extras/effort-agents/`，上游 hook 参考文件迁至 `extras/upstream-reference/`——三者均为「默认不加载、需额外条件」的非核心组件（见 `extras/README.md`），playbook 与各宿主映射文档的调用路径已同步更新；`skills/poteto-mode/scripts/` 仅保留 4 个零依赖 node 脚本。文件内容未改动，纯位置迁移。

本移植只增加打包层（清单、注册项、说明文档），未新增上游以外的功能代码。
