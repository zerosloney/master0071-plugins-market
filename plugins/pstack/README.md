# pstack

poteto（Lauren Tan）风格的 agent 工作流栈，按 **Agent Plugins 1.0.0** 标准打包。65 个 skill + 14 个子智能体（`agents/` 4 个基础；另 10 个 effort 分级变体在 `extras/`，当前无宿主加载）+ 1 条会话启动 hook。

一句话概括上游的自述：**"if you want to go fast, go deep first"** —— 先深挖，再快跑；少写代码，但写得更硬。

## 入口

| 入口 | 说明 |
|------|------|
| `poteto-mode` | **唯一总入口**。告诉它你的目标，它挑该走哪条工作流：复现并定位 bug、用 `architect` 起草设计、`arena` 竞速方案、`interrogate` 审 diff、`unslop` 削文案 |
| `setup-pstack` | 选模型分工、关闭会话 hook，写 `pstack-models.md`（路径按运行时而定，见该 skill 的 Other runtimes 表） |
| `poteto-help` | 自助问答：这个仓库里有什么、我该用哪个 skill |
| 其余 skill | 情境触发，由 `poteto-mode` 路由过去，或直接手动 `/<name>` 调用 |

在支持 Claude 式 hook 的宿主上，`SessionStart` hook 会自动注入路由令（startup / resume / clear / compact 时），不需要先手动叫 `poteto-mode`。

## skill 分组

| 分组 | 数量 | 代表 |
|------|------|------|
| 路由 / 元 | 4 | `poteto-mode`、`poteto-help`、`setup-pstack`、`correct` |
| 设计 | 3 | `architect`（设计起草）、`arena`（方案竞速）、`blast-radius`（改动影响面） |
| 审查 | 6 | `interrogate`（对抗式审 diff）、`thermos` / `thermo-nuclear-review` / `thermo-nuclear-code-quality-review`、`no-comments`（去掉噪音评论）、`figure-it-out` |
| 写作 | 4 | `unslop`、`deslop`、`technical-writing`、`in-your-own-words` |
| 工程纪律 | 5 | `tdd`、`how`、`why`、`sharpen`、`benchmark-checklist` |
| PR / CI / 协作 | 8 | `make-pr-easy-to-review`、`fix-ci`、`fix-merge-conflicts`、`get-pr-comments`、`what-did-i-get-done`、`babysit`、`ketchup`、`bro` |
| 并行 / 复盘 | 2 | `swarm`（覆盖矩阵 / 竞速 / 分区）、`recall` |
| 验证资产 | 5 | `create-verification-skill`、`maintain-verification-skill`、`create-formal-verification-skill`、`maintain-formal-verification-skill`、`teach` |
| 其他 | 4 | `automate-me`、`reflect`、`show-me-your-work`、`typescript-best-practices` |
| 原则 | 24 | `principle-laziness-protocol`、`principle-subtract-before-you-add`、`principle-model-the-domain`、`principle-type-system-discipline` 等 |

41 + 24 = 65。分组按 skill 目录名归类，具体触发条件以各 `SKILL.md` 的 `description` 为准（宿主据此决定是否自动调用）。

## 原则层

24 个 `principle-*` skill 是独立可用的判断准则，不依赖 `poteto-mode`：`principle-laziness-protocol`（偏向删除）、`principle-explain-the-number`（报告数字前先确认口径）、`principle-fix-root-causes`（修根因而不是症状）、`principle-test-behavior-not-implementation` 等。需要单独用某条准则时，直接加载对应 skill。

## 宿主支持

| 能力 | 状态 |
|------|------|
| `skills/`（Agent Plugins 1.0.0 标准） | 所有兼容客户端按固定位置发现，无需清单声明 |
| `.omp-plugin/plugin.json` | **Oh My Pi 兼容垫片**：声明 `skills` 与 `agents`；也是根 `.omp-plugin/marketplace.json` 里的市场条目，omp 侧 `pstack@master0071-plugins` 已可安装（dry-run 通过）。omp 不加载 `hooks/`，所以没有会话启动自动路由 |
| `.codex-plugin/plugin.json` | **Codex 兼容垫片**：声明 `skills` 与 `SessionStart` hook，Codex 直接发现 `skills/` 下全部 65 个 skill，无需 prompts 垫片 |
| `.zcode-plugin/plugin.json` | **ZCode 兼容垫片**：声明 `skills` 与 `agents`；不含 `hooks` 字段——ZCode 按约定路径直接注册 `hooks/hooks.json`（实测面板与日志证实，见下） |
| `agents/` | **客户端约定**；4 个基础子智能体（ZCode 实证注册）。10 个 effort 分级变体已移至 `extras/effort-agents/`：Agent Plugins 1.0.0 的 `extensions` 命名空间尚无客户端实现（Claude Code 用自有目录约定且只认 `agents/`），ZCode 也只注册 `agents/` 的 4 个，effort 语义不可用，按上游原样隔离保留 |
| `hooks/` | **客户端约定**，Claude 式 hook 宿主生效；Codex 走垫片里内联的那一份；ZCode 按约定路径注册同一份 `hooks/hooks.json`（node 入口）。`hooks/copilot-hooks.json` **未被任何清单引用**，Copilot 上需手工登记，见下 |
| `models.json` | skill 内多处引用它说明模型分工的出处；改它需要同步更新各 skill 的 Models 列表（各文件已注明，本移植未附带生成脚本） |

Codex 侧实测结论（codex-cli 0.163.0，2026-10-23）：`.codex-plugin` 里修正为 `hooks.hooks.SessionStart` 的嵌套结构后，用 `--dangerously-bypass-hook-trust` 运行 `codex exec` 仍未在系统上下文看到 `You have pstack.`，说明本机 Codex **没有执行插件的 SessionStart hook**，自动路由未生效。同一轮实测中 MCP 的 `${PLUGIN_ROOT}` 可以正常展开（systemone 的 `systemone_scenario` 已注册并可发起调用），所以问题不在变量展开，而在 Codex 对插件 hook 的加载/注入契约。结论：Codex 上请手动调用 `/poteto-mode`；`hooks` 字段保留为正确的嵌套声明，等宿主支持后无需再改插件。hook 脚本自身不依赖插件根环境变量（插件根由脚本路径推出），可零变量手工运行验证。**注意**：那份内联 hook 的命令用的是 `${CLAUDE_PLUGIN_ROOT}`（照 Claude 式宿主的变量名占位）——若 Codex 日后支持插件 hook 而契约要求别的变量名，需要按届时契约改这一处；脚本本身不读该变量，改与不改都不影响脚本行为。

hook 行为：会话开始时读取运行时的模型表（Claude Code `~/.claude/pstack-models.md`，`$CLAUDE_CONFIG_DIR` 可改；ZCode `~/.zcode/`，`$ZCODE_HOME` 可改；Codex `~/.codex/`；Copilot `~/.copilot/`）。若文件里含 `session hook: off` 一行，则不注入路由令——**关掉自动路由的方式就是这个**，比删 hook 干净。

ZCode 侧 hook：ZCode **按约定路径直接注册 `hooks/hooks.json`，不理会垫片里的 hooks 指针**（实测面板与日志证实），因此同一份注册要同时服务 Claude Code 与 ZCode——`session-start.mjs` 靠环境自检切换：检测到 `ZCODE_PLUGIN_ROOT` 或插件根在 `.zcode` 下即走 zcode 分支，读 `~/.zcode/pstack-models.md`、沿用 `session hook: off` 开关，输出 ZCode 要求的 `hookSpecificOutput.additionalContext` JSON；否则按参数走 claude/codex/copilot 分支。工具与模型映射见 `skills/poteto-mode/references/zcode-tools.md`。

**全部 hook 已 node 化（0.1.3 起）**：Windows 宿主经 shell 执行 `.sh` 会按文件关联"打开"脚本（弹 VS Code）而非运行，故 `session-start.sh` / `pre-tool-use.sh` 及其 awk 引擎已移植为 node 脚本——`hooks/session-start.mjs`（统一入口，claude/codex/copilot/zcode 四运行时分支 + 宿主自检）与 `hooks/pre-tool-use.mjs`（Copilot 权限闸），共享 `hooks/sheet.mjs`（表解码与校验）。**实际被宿主接上的注册有两份**：`hooks/hooks.json`（Claude 式宿主 + ZCode 约定路径）与 `.codex-plugin` 内联那一份，两者都改为 `node` 调用。测试见 `test/run-hook-tests.mjs`（hook 契约与表解码，在插件根执行）与 `test/sheet-parity.mjs`（awk↔mjs 一致性，无 awk 环境自动跳过）。原 `session-start.sh`、`pre-tool-use.sh`、`session-start.ps1` 与四个 `hooks/*.awk` 共 7 个文件移入 `extras/upstream-reference/` 保留为上游参考，不再被任何注册引用；hook 由此依赖宿主机上有 Node ≥ 18。

**`hooks/copilot-hooks.json` 目前无人注册（已知缺口）**：本仓库的四份清单（根 `plugin.json`、`.codex-plugin`、`.omp-plugin`、`.zcode-plugin`）都不引用它，仓库里也没有 Copilot 专用的垫片目录，所以 **GitHub Copilot 宿主上 `pre-tool-use.mjs` 权限闸不会自动生效**——脚本本身有测试（`run-hook-tests.mjs` 覆盖其 view/task/bash 规则与解析器），只是缺一条把它交给宿主的注册路径。上游 pstack 的 Copilot 集成走的是宿主自有配置而非本仓库清单，具体登记方式本移植未实测，故不臆造 manifest 结构。要让它在你的 Copilot 上生效：按你所用 Copilot 客户端的 hook 配置约定，把 `hooks/copilot-hooks.json` 的内容登记进去（脚本根用 `${COPILOT_PLUGIN_ROOT}` 展开）。在那之前，请把 Copilot 视为 **skills-only 安装**：SessionStart 路由令可用（`session-start.mjs` 有 copilot 分支），脚本权限闸不可用。

## extras/（按需启用的非核心组件）

bun 专属 vendored TypeScript（`watch-pr`、`orch` 及其 `bootstrap.ts` / `package.json` / `bun.lock`）、`effort-agents/` 与 `upstream-reference/` 已统一隔离到 `extras/`（0.1.5 起）：宿主不加载、ZCode 工作区索引忽略、不装 bun 的安装可以完全无视。各目录的启用条件见 [`extras/README.md`](extras/README.md)；`skills/poteto-mode/scripts/` 只留 4 个零依赖 node 脚本（`check-plan` / `check-playbooks` / `resume` / `worktree-audit`），随装随用。

## 与上游的差异

移植自 [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) `plugins/pstack/`（版本 `0.9.86`，提交 `1dba27e`），并在此基础上合入了 [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) v0.15.26–v0.15.28 的全部 skill 级变更（基线为 fork 同步自的 v0.15.25）。skill 的 frontmatter 按 Agent Skills 规范统一改写（剥除 Cursor / Claude 专有键 `user-invocable`、`paths`，只保留 `name` / `description` / `license` / `compatibility`）；正文里写死的 Claude 路径改为宿主中立表述，各宿主的具体值见 `skills/poteto-mode/references/<host>-tools.md` 的路径对照表。正文的 Claude Code 工具名与模型名保留为参考平台口径，各宿主通过自己的映射文件翻译；新合入的上游变更沿用同一套适配约定（剥除 Cursor 专有 frontmatter、Claude Code 工具名与模型口径、技能间相对链接）。0.1.5 起把 bun 专属 vendored 脚本从 `skills/poteto-mode/scripts/` 迁到 `extras/poteto-mode-scripts/`（无 bun 的宿主跑不了它们，playbook 与映射文档已同步改路径）。

**剔除项**（上游有、本移植不随附）：

| 剔除项 | 原因 | 影响 |
|--------|------|------|
| `assets/`、`.claude-plugin/icon.png` | 约 1.9 MB 图片，本仓库不打包二进制资源 | 仅少个图标 |
| `pi/` | Pi 扩展专属，其他宿主用不上 | Pi 上没有自动路由，skill 照常手动可用；`pi-tools.md` 映射文档已一并剔除（上游原文仍在 michael-denyer/pstack-claude） |
| `.codex-plugin/` | Codex 命令垫片，由宿主各自的清单机制承担 | 已由本仓库重写为 `.codex-plugin/plugin.json`（见下），不是上游原文 |
| `.github/`、`tools/` | 上游 CI 与生成脚本 | skill 里提到的 `tools/generate.mjs` 仅是出处说明，不可执行 |
| `docs/guide/`、`docs/harness/` | 上游指南文档，本 README 已覆盖使用面 | 不影响 skill 行为 |
| `make-bot-ui` skill | 通过 webhook 唤醒 Grok Bot，Cursor 生态绑定，其他宿主无从使用 | 少一个 Cursor 专属 skill |
| `automations/benny/`、`.cursor-plugin/`、`.gitignore`、`worktree-audit.sh` | fork 基线即未随附（benny 为 Cursor 自动化专属；worktree-audit 由本地 `worktree-audit.mjs` 等价承担） | 无 |

完整署名链见 [NOTICE-PORT.md](NOTICE-PORT.md) 与 [NOTICE.md](NOTICE.md)（上游原文）。**再分发须保留 `LICENSE`、`LICENSE-cursor-team-kit`、`LICENSE-thermos` 三份许可证。**

## 升级上游

本插件版本号只表示本仓库的移植包版本（当前版本见 [`plugin.json`](plugin.json)，`release.mjs --check` 保证四份清单一致），与上游版本解耦。上游变更以 [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) 为准（fork 的最后一次同步停在 v0.15.25，之后的提交需直接从原仓取）：

```bash
gh api "repos/cursor/plugins/compare/<上次同步提交>...HEAD" --jq '.files[] | select(.filename | test("^pstack/skills/")) | .filename'
# 逐个把上游变更按适配约定落到 skills/ 下，再更新 NOTICE-PORT.md 的「内容同步」一行
node scripts/release.mjs pstack <新版本>
```

## 使用

先跑一次 `setup-pstack` 确认模型分工是否符合你的账号与供应商；其余按目标直接说，或手动 `/poteto-mode`。

若宿主的用户级 skill 目录里已有 `tdd`、`teach`，安装可能被同名检查拒绝；先移开或禁用用户级版本，再安装 pstack。ZCode / Codex 的同名策略由宿主决定。
