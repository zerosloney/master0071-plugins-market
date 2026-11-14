# pstack

poteto（Lauren Tan）风格的 agent 工作流栈，按 **Agent Plugins 1.0.0** 标准打包。66 个 skill + 4 个子智能体（`agents/`，名单与上游一致）+ 1 条会话启动 hook。Qwen Code 由 `scripts/build-qwen-extension.mjs` 生成自包含原生包（`dist/qwen-pstack`）：共享 66 个 skill，注册同一组 4 个子智能体与 Qwen 专属 SessionStart hook。**不能直接装 `plugins/pstack`**：Qwen 会先认 Agent Plugins 的 `plugin.json`，只加载 skill、忽略 agents/hooks。

一句话概括上游的自述：**"if you want to go fast, go deep first"** —— 先深挖，再快跑；少写代码，但写得更硬。

## 入口

| 入口 | 说明 |
|------|------|
| `poteto-mode` | **唯一总入口**。告诉它你的目标，它挑该走哪条工作流：复现并定位 bug、用 `architect` 起草设计、`arena` 竞速方案、`interrogate` 审 diff、`unslop` 削文案 |
| `setup-pstack` | 选模型分工、关闭会话 hook，写 `pstack-models.md`（路径按运行时而定，见该 skill 的 Other runtimes 表） |
| `poteto-help` | 自助问答：这个仓库里有什么、我该用哪个 skill |
| 其余 skill | 情境触发，由 `poteto-mode` 路由过去，或直接手动 `/<name>` 调用；Qwen Code 上扩展 skill 带命名空间，写成 `/pstack:<name>` |

在支持 Claude 式 hook 的宿主上，`SessionStart` hook 会自动注入路由令（startup / resume / clear / compact 时），不需要先手动叫 `poteto-mode`。Qwen Code 生成包由 `hooks/hooks.qwen.json` 复制出的 `hooks/hooks.json` 注册同一个脚本，`session hook: off` 同样生效。

## skill 分组

| 分组 | 数量 | 代表 |
|------|------|------|
| 路由 / 元 | 4 | `poteto-mode`、`poteto-help`、`setup-pstack`、`correct` |
| 设计 | 3 | `architect`（设计起草）、`arena`（方案竞速）、`blast-radius`（改动影响面） |
| 审查 | 6 | `interrogate`（对抗式审 diff）、`thermos` / `thermo-nuclear-review` / `thermo-nuclear-code-quality-review`、`no-comments`（去掉噪音评论）、`figure-it-out` |
| 写作 | 4 | `unslop`、`deslop`、`technical-writing`、`in-your-own-words` |
| 工程纪律 | 5 | `tdd`、`how`、`why`、`sharpen`、`benchmark-checklist` |
| PR / CI / 协作 | 9 | `make-pr-easy-to-review`、`fix-ci`、`fix-merge-conflicts`、`get-pr-comments`、`what-did-i-get-done`、`babysit`、`ketchup`、`ketchup-video`、`bro` |
| 并行 / 复盘 | 2 | `swarm`（覆盖矩阵 / 竞速 / 分区）、`recall` |
| 验证资产 | 5 | `create-verification-skill`、`maintain-verification-skill`、`create-formal-verification-skill`、`maintain-formal-verification-skill`、`teach` |
| 其他 | 4 | `automate-me`、`reflect`、`show-me-your-work`、`typescript-best-practices` |
| 原则 | 24 | `principle-laziness-protocol`、`principle-subtract-before-you-add`、`principle-model-the-domain`、`principle-type-system-discipline` 等 |

42 + 24 = 66。分组按 skill 目录名归类，具体触发条件以各 `SKILL.md` 的 `description` 为准（宿主据此决定是否自动调用）。

## 原则层

24 个 `principle-*` skill 是独立可用的判断准则，不依赖 `poteto-mode`：`principle-laziness-protocol`（偏向删除）、`principle-explain-the-number`（报告数字前先确认口径）、`principle-fix-root-causes`（修根因而不是症状）、`principle-test-behavior-not-implementation` 等。需要单独用某条准则时，直接加载对应 skill。

## 宿主支持

| 能力 | 状态 |
|------|------|
| `skills/`（Agent Plugins 1.0.0 标准） | 所有兼容客户端按固定位置发现，无需清单声明 |
| `.omp-plugin/plugin.json` | **Oh My Pi 兼容垫片**：声明 `skills` 与 `agents`；也是根 `.omp-plugin/marketplace.json` 里的市场条目，omp 侧 `pstack@master0071-plugins` 已可安装（dry-run 通过）。omp 不加载 `hooks/`，所以没有会话启动自动路由 |
| `.codex-plugin/plugin.json` | **Codex 兼容垫片**：声明 `skills` 与 `SessionStart` hook，Codex 直接发现 `skills/` 下全部 66 个 skill，无需 prompts 垫片 |
| `.zcode-plugin/plugin.json` | **ZCode 兼容垫片**：声明 `skills` 与 `agents`；不含 `hooks` 字段——ZCode 按约定路径直接注册 `hooks/hooks.json`（实测面板与日志证实，见下） |
| `qwen/agents/`、`QWEN.md`、`hooks/hooks.qwen.json`、`scripts/build-qwen-extension.mjs` | **Qwen Code 适配源 + 生成器**：生成器把共享 `skills/`、Qwen 专属 4 个基础子智能体、Qwen hook 注册与 `QWEN.md` 组装成 `dist/qwen-pstack`（自包含、无根 `plugin.json`）。不提供根 `qwen-extension.json`——它会被 Agent Plugins 的 `plugin.json` 抢先，导致 Qwen 只加载 skill |
| `agents/` | **客户端约定**；Claude / ZCode / Qwen 生成包都注册 4 个上游基础子智能体（`poteto-agent`、`comment-sicko`、两个 thermo 审计子代理），本移植不新增面板席位、模型钉定或力度变体。ZCode 的 `Agent` 调用无 per-call 模型与力度参数，各角色统一跑 `poteto-agent`，模型与档位跟随会话；Qwen 的 `agent` 调用可逐次传 model grade，多模型面板用同一 `poteto-agent` 配不同 grade |
| `hooks/` | **客户端约定**，Claude 式 hook 宿主生效；Codex 走垫片里内联的那一份；ZCode 按约定路径注册同一份 `hooks/hooks.json`（node 入口）；Qwen 生成包把 `hooks/hooks.qwen.json` 复制为 `hooks/hooks.json`，以 `qwen` 运行时调用同一脚本，stdout 输出裸文本（Qwen 会把它加入 SessionStart 上下文）。`hooks/copilot-hooks.json` **未被任何清单引用**，Copilot 上需手工登记，见下 |
| `models.json` | skill 内多处引用它说明模型分工的出处；改它需要同步更新各 skill 的 Models 列表（各文件已注明，本移植未附带生成脚本） |

Codex 侧实测结论（codex-cli 0.163.0，2026-10-23）：`.codex-plugin` 里修正为 `hooks.hooks.SessionStart` 的嵌套结构后，用 `--dangerously-bypass-hook-trust` 运行 `codex exec` 仍未在系统上下文看到 `You have pstack.`，说明本机 Codex **没有执行插件的 SessionStart hook**，自动路由未生效。同一轮实测中 MCP 的 `${PLUGIN_ROOT}` 可以正常展开（systemone 的 `systemone_scenario` 已注册并可发起调用），所以问题不在变量展开，而在 Codex 对插件 hook 的加载/注入契约。结论：Codex 上请手动调用 `/poteto-mode`；`hooks` 字段保留为正确的嵌套声明，等宿主支持后无需再改插件。hook 脚本自身不依赖插件根环境变量（插件根由脚本路径推出），可零变量手工运行验证。**注意**：那份内联 hook 的命令用的是 `${CLAUDE_PLUGIN_ROOT}`（照 Claude 式宿主的变量名占位）——若 Codex 日后支持插件 hook 而契约要求别的变量名，需要按届时契约改这一处；脚本本身不读该变量，改与不改都不影响脚本行为。

hook 行为：会话开始时读取运行时的模型表（Claude Code `~/.claude/pstack-models.md`，`$CLAUDE_CONFIG_DIR` 可改；ZCode `~/.zcode/`，`$ZCODE_HOME` 可改；Codex `~/.codex/`；Copilot `~/.copilot/`；Qwen Code `~/.qwen/`，`$QWEN_HOME` 可改）。若文件里含 `session hook: off` 一行，则不注入路由令——**关掉自动路由的方式就是这个**，比删 hook 干净。

ZCode 侧 hook：ZCode **按约定路径直接注册 `hooks/hooks.json`，不理会垫片里的 hooks 指针**（实测面板与日志证实），因此同一份注册要同时服务 Claude Code 与 ZCode——`session-start.mjs` 靠环境自检切换：检测到 `ZCODE_PLUGIN_ROOT` 或插件根在 `.zcode` 下即走 zcode 分支，读 `~/.zcode/pstack-models.md`、沿用 `session hook: off` 开关，输出 ZCode 要求的 `hookSpecificOutput.additionalContext` JSON；否则按参数走 claude/codex/copilot/qwen 分支。工具与模型映射见 `skills/poteto-mode/references/zcode-tools.md`。

Qwen Code 侧把不兼容点显式落到文件：`scripts/build-qwen-extension.mjs` 组装自包含包（复制共享 `skills/`、`qwen/agents/`、`hooks/hooks.qwen.json` → `hooks/hooks.json`、`QWEN.md`，不复制根 `plugin.json`）——**根清单不能直接复用**，因为 Qwen 0.26 的顺序是 Agent Plugins 优先，且原生加载器把 `skills/`、`agents/` 写死在扩展根；`hooks/hooks.qwen.json` 以 `qwen` 运行时调用同一脚本（读 `${QWEN_HOME:-~/.qwen}/pstack-models.md`，输出裸文本由 Qwen 加入 SessionStart 上下文）；`qwen/agents/` 只保留 4 个基础档，去掉 ZCode 的 `model` / `thoughtLevel` 钉值；`QWEN.md` 与 `skills/poteto-mode/references/qwen-tools.md` 说明 `pstack:` 命名空间、工具名与 model grade 映射；`skills/setup-pstack/qwen.md` 负责写 Qwen 表并配置 `agents.modelGrades`。**命名空间不对称**：扩展 skill 注册为 `pstack:<name>`（裸名不是别名），扩展子智能体却保留 frontmatter 的裸名——`subagent_type` 要写 `poteto-agent` / `thermo-nuclear-review-subagent`，pstack skill 里的 `pstack:<agent>` 在 Qwen 上必须剥前缀。**验证边界**：`test/qwen-extension-parity.mjs` 现跑生成器并逐项对账；另用 Qwen Code 0.26.8 在隔离 `QWEN_HOME` 实测 `extensions install dist/qwen-pstack` 成功，`ExtensionManager` 读到 `format=qwen`、66 skills、4 agents、SessionStart hook×1、`QWEN.md` 上下文，hook 命令中的 `${CLAUDE_PLUGIN_ROOT}` 已展开到安装路径。**未跑真实鉴权的模型会话**，故不宣称“已实测工具调用”。

**全部 hook 已 node 化（0.1.3 起）**：Windows 宿主经 shell 执行 `.sh` 会按文件关联"打开"脚本（弹 VS Code）而非运行，故 `session-start.sh` / `pre-tool-use.sh` 及其 awk 引擎已移植为 node 脚本——`hooks/session-start.mjs`（统一入口，claude/codex/copilot/zcode/qwen 五运行时分支 + 宿主自检）与 `hooks/pre-tool-use.mjs`（Copilot 权限闸），共享 `hooks/sheet.mjs`（表解码与校验）。**实际被宿主接上的注册有三份**：`hooks/hooks.json`（Claude 式宿主 + ZCode 约定路径）、`.codex-plugin` 内联那一份，以及 Qwen 生成包内由 `hooks/hooks.qwen.json` 复制成的 `hooks/hooks.json`，三者都改为 `node` 调用。测试见 `test/run-hook-tests.mjs`（hook 契约与表解码，在插件根执行）与 `test/sheet-parity.mjs`（awk↔mjs 一致性，无 awk 环境自动跳过）。原 `session-start.sh`、`pre-tool-use.sh`、`session-start.ps1` 与四个 `hooks/*.awk` 共 7 个文件移入 `extras/upstream-reference/` 保留为上游参考，不再被任何注册引用；hook 由此依赖宿主机上有 Node ≥ 18。

**`hooks/copilot-hooks.json` 目前无人注册（已知缺口）**：本仓库的四份清单（根 `plugin.json`、`.codex-plugin`、`.omp-plugin`、`.zcode-plugin`）都不引用它，仓库里也没有 Copilot 专用的垫片目录，所以 **GitHub Copilot 宿主上 `pre-tool-use.mjs` 权限闸不会自动生效**——脚本本身有测试（`run-hook-tests.mjs` 覆盖其 view/task/bash 规则与解析器），只是缺一条把它交给宿主的注册路径。上游 pstack 的 Copilot 集成走的是宿主自有配置而非本仓库清单，具体登记方式本移植未实测，故不臆造 manifest 结构。要让它在你的 Copilot 上生效：按你所用 Copilot 客户端的 hook 配置约定，把 `hooks/copilot-hooks.json` 的内容登记进去（脚本根用 `${COPILOT_PLUGIN_ROOT}` 展开）。在那之前，请把 Copilot 视为 **skills-only 安装**：SessionStart 路由令可用（`session-start.mjs` 有 copilot 分支），脚本权限闸不可用。

### hooks 诊断

- `PSTACK_GATE_TRACE=1`：让 `hooks/pre-tool-use.mjs` 把 scriptRule 各早退分支的走向写 stderr（allow/deny 判定链排障用；不设 = 零行为变化）。

## extras/（按需启用的非核心组件）

bun 专属 vendored TypeScript（`watch-pr`、`orch` 及其 `bootstrap.ts` / `package.json` / `bun.lock`）与上游 hook 参考已统一隔离到 `extras/`（0.1.5 起）：宿主不加载、ZCode 工作区索引忽略、不装 bun 的安装可以完全无视。各目录的启用条件见 [`extras/README.md`](extras/README.md)；`skills/poteto-mode/scripts/` 只留 4 个零依赖 node 脚本（`check-plan` / `check-playbooks` / `resume` / `worktree-audit`），随装随用。

**bun 套件的 Windows 平台性失败（2026-10-29 市场审查根因批注）**：`bun test` 在 Windows 实测 253 例，起始 217 pass / 36 fail。根因分五类，已修掉三类：

| # | 根因 | 处置 |
|---|---|---|
| ① | `Bun.spawn(["true"])` 在 Windows ENOENT（`true` 是 POSIX coreutils） | 测试侧平台分支：Windows spawn 自身 `-e "process.exit(0)"` |
| ② | 假 forge stub 用 `pwd -P` 与 `realpathSync` 比对 cwd，Git Bash 报 POSIX 形态（`/tmp/...`）而 TS 侧是 `C:\...` | 测试侧两侧都归一到 `cygpath -m` 混合形态再比 |
| ③ | 假 forge 是无扩展名 shebang 脚本，CreateProcess 找不到可执行体 | 测试侧补同名 `.cmd` 转发 shim（`execFileSync` 经 PATHEXT 命中）；`store.ts` 另把 Windows rename 的 `EPERM` 并入「claim 竞争失败」容忍集（与 POSIX `ENOTEMPTY`/`EEXIST` 同义） |
| ④ | 测试的 `PATH: \`${bin}:${process.env.PATH}\`` 用 POSIX 冒号拼接——Windows 上整条 PATH 变成一段非法串，fake forge 完全不在搜索路径里 | 改用 `node:path` 的 `delimiter`（本条是全平台都有价值的真实修复） |
| ⑤ | afterEach 的 `rm` 在 SIGKILL 后句柄释放滞后窗口内 EBUSY | 短暂重试，仍失败则放弃该临时目录 |

修后 orch 19 fail → 6 fail、transport 7 fail → 6 fail。**2026-10-29 第三轮实测**：`bun test` 253 例，235 pass / 18 fail（orch 6 + watch-pr/transport 12）。**第四、五轮**又修掉两大类（见下），基线从 235 pass / 18 fail 提升到 **250–251 pass / 2–3 fail**（默认 5s 超时，253 例）。剩余 2–3 条都是 orch 的多进程锁竞争用例：单独跑能过，整套并行时在 5s 内跑不完（放宽到 30s 则 orch 42/42 全绿）。

**watch-pr/transport 的 12 条已全修**（206 例全绿，套件耗时 60s → 27s）。真正的原因不是「Windows 上没有可靠的进程替身」，而是两件事叠在一起：

1. **假 gh 必须是真 `.exe`**。裸名 `gh` 只按 PATHEXT 解析，无扩展名 shebang 永远 ENOENT；补 `gh.cmd` 转发则被 Node/Bun 硬性拒绝（`ERR_INVALID_ARG_VALUE`：GraphQL 参数含 cmd.exe 特殊字符，两个宿主都拒绝）；把 `gh.exe` 做成 node 副本靠 `NODE_OPTIONS=--import` 接管也不行（node 会先解析 `-f`：`gh: bad option: -f`）。只能用 `bun build --compile` 产出真 exe。
2. **入口必须由 node 启动**。`bun → bun.exe` 固定约 3.5s（`bun → node.exe` 93ms、`bun → cmd.exe` 20ms、`node → bun.exe` 65ms），与 `--compile` 无关、与继承的环境变量无关。而用例的子进程预算只有 5s——这才是「全部 timed out after 5000ms」的真因。改用 `node --experimental-transform-types` 跑 `cli.ts`（`deadline.ts` 用了参数属性）后，假 gh 每次调用 40–80ms，四个典型场景各 450–500ms。

踩过的坑（都在 `watch-pr/fake-gh.test-helper.ts` 里写明了）：编译与预热各约 4s，「每个用例各编译一份」会直接撞满超时（`exit null` = 被自身超时打断），必须按 fixture 内容缓存；node 的 ESM 加载器只接受 `file://` URL，裸 Windows 路径会得到 `ERR_UNSUPPORTED_ESM_URL_SCHEME`；但 `bun build` 打包时又不认 `file://` 说明符——两者用途不同，不能混用。

- **orch 锁竞争（已修，默认超时下 6 → 1 条）**：根因是产品代码里一个真实的 Windows 语义缺口，不是测试缺陷。上游锁算法靠「目录 rename 成功即持锁」：POSIX 允许 rename 到**空目录**（覆盖它），Windows 一律 `EPERM`。`claimed()` 清掉死 claimant 的**文件**后，`.orch.lock.takeover` 目录本身还空着，于是这个已经死透的 claim 会把锁永久占住，后来者怎么试都拿不到。修法：新增 `sweepEmptyClaim()`，在 rename 因 `EPERM/EEXIST/ENOTEMPTY` 失败后，**若目标目录确认为空**就 `rmdir` 再重建 staged 重试一次（读到任何条目说明有活跃 claim，仍按竞争失败返回 false）。另修了一处测试侧遗漏：`replaces a stale lock after a writer was killed while replacing it` 直接用 `signalCode === "SIGKILL"` 断言，而本文件已有跨平台的 `writerWasKilled()`，Windows 上 `process.kill(self, SIGKILL)` 不产生 signal（`exitCode=1`、`signalCode=null`）。修后放宽超时 42/42 全绿；默认 5s 下 41/42，剩下一条是整套件并行时的时间预算问题（单独跑 3.98s 通过）。
两类都属 [`extras/README.md`](extras/README.md) 已声明的「仅上游 POSIX 验证、Windows 有平台性失败」，故按上游原样保留，CI 仍不纳入该套件。已发布的 `check-plan.mjs` 由 `test/check-plan.test.mjs` 的 node:test 重写版守护（进 CI、双平台零依赖）。

## 与上游的差异

移植自 [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) `plugins/pstack/`（版本 `0.9.86`，提交 `1dba27e`），并在此基础上合入了 [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) v0.15.26–v0.15.28 及 v0.15.28→v0.15.36 的 skill 级变更（基线为 fork 同步自的 v0.15.25；ketchup-video 已纳入，statechart 与 benny 自动化未纳入，orchestrate 的 agentic 改写未采纳——orch 保留本地 Windows 加固版）。skill 的 frontmatter 按 Agent Skills 规范统一改写（剥除 Cursor / Claude 专有键 `user-invocable`、`paths`，只保留 `name` / `description` / `license` / `compatibility`）；正文里写死的 Claude 路径改为宿主中立表述，各宿主的具体值见 `skills/poteto-mode/references/<host>-tools.md` 的路径对照表。正文的 Claude Code 工具名与模型名保留为参考平台口径，各宿主通过自己的映射文件翻译；新合入的上游变更沿用同一套适配约定（剥除 Cursor 专有 frontmatter、Claude Code 工具名与模型口径、技能间相对链接）。0.1.5 起把 bun 专属 vendored 脚本从 `skills/poteto-mode/scripts/` 迁到 `extras/poteto-mode-scripts/`（无 bun 的宿主跑不了它们，playbook 与映射文档已同步改路径）。

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

先跑一次 `setup-pstack` 确认模型分工是否符合你的账号与供应商；其余按目标直接说，或手动 `/poteto-mode`。Qwen Code 上先用 `node scripts/build-qwen-extension.mjs` 生成 `dist/qwen-pstack` 再安装；随后按 `skills/setup-pstack/qwen.md` 把 `opus` / `fable` / `sonnet` / `haiku` 配成 `agents.modelGrades`，再跑 `/pstack:setup-pstack`；否则各 skill 的 `model` 会被 Qwen 拒绝并回退到父会话模型。

若宿主的用户级 skill 目录里已有 `tdd`、`teach`，安装可能被同名检查拒绝；先移开或禁用用户级版本，再安装 pstack。ZCode / Codex 的同名策略由宿主决定。

## 版本变更

**0.1.26**

面板评审收口（pr-review 对 0.1.25 弧 7da6639..81c1f38：7 镜头 → 17 候选 → 51 票全 confirm）：①PSTACK_GATE_TRACE 诊断通道转正常驻（原自注「可移除」但测试断言已依赖——README「hooks 诊断」节补文档）②run-hook-tests 夹具基座锚定测试文件自身位置（原按 cwd 上跳两级，从非插件根调用会把夹具撒到仓库外）③文档三处对齐：setup-pstack「read-sheet.sh 零消费」改如实（check-sheet.sh 是树内调用方）、zcode-tools「每次派发跟随会话模型」加 thermo 双审计钉 GLM-5.3@max 例外、verify 特性地图 15→4 子智能体；copilot-tools 与「Copilot 非 agent 注册宿主」对齐（带外）。五套测试全绿（hook 46 / sheet 20 / role 61 / qwen 65 / agent-pipelines 全量）。

**0.1.25**

- **子智能体列表回归上游**：删除 0.1.22 引入的移植新增 agent——`poteto-agent-strong`、4 个 `panelist-*` 席位与 `{effort,poteto-agent}-{low,high,max}` 六个力度变体，连同 `extras/effort-agents/` 的 10 个五档参考一并移除；`agents/` 只剩 4 个上游基础子智能体。`models.json` 删除 `zcode` 映射块；ZCode 上模型与力度跟随会话（`Agent` 调用没有 per-call 参数），`@level` 后缀只记录、不改变派发。同步更新 `zcode-tools.md`、7 项 skill 的 Reasoning effort 段、`setup-pstack`、Qwen 映射文档、README 与 `test/role-table-parity.mjs` / `test/qwen-extension-parity.mjs`；`manifest-lint` 去掉 extras 力度参考的计数面。

**0.1.24**

- **Qwen Code 原生扩展落地**：新增 `scripts/build-qwen-extension.mjs` 生成自包含 `dist/qwen-pstack`（复制共享 `skills/`、Qwen 专属 `qwen/agents/`、`hooks/hooks.qwen.json` → `hooks/hooks.json`、`QWEN.md`；**不复制根 `plugin.json`**），因为 Qwen 0.26 先认 Agent Plugins 清单，且原生加载器把 `skills/`、`agents/` 写死在扩展根——直接在 `plugins/pstack` 上放 `qwen-extension.json` 会被 `plugin.json` 抢先，只加载 skill。新增 `QWEN.md`、`qwen/agents/`（4 个基础子智能体，去掉 ZCode 的 `model` / `thoughtLevel` 钉值）、`hooks/hooks.qwen.json`（`qwen` 运行时，读 `${QWEN_HOME:-~/.qwen}/pstack-models.md`，裸文本输出）。
- **不兼容点适配**：扩展 skill 使用 `pstack:<name>` 命名空间，扩展子智能体保留裸名（Qwen 按 frontmatter `name:` 查找，加前缀反而解析不到；skill 里的 `pstack:<agent>` 需剥前缀）；新增 `references/qwen-tools.md`（工具名、model grade、路径、per-skill notes）；新增 `setup-pstack/qwen.md`（写表 + 配 `agents.modelGrades` + QWEN.md 导入）；`session-start.mjs` 增加 qwen 分支；`setup-pstack` 的 Other runtimes 表补 Qwen 行。ZCode 的 `panelist-*` / `strong` / `effort-*` 不进入 Qwen 树，面板改用逐次 model grade。
- **守护**：`test/qwen-extension-parity.mjs` 现跑生成器到临时目录，对账无 `plugin.json`、skills / agents 数量与白名单、hook 注册、`${CLAUDE_PLUGIN_ROOT}` 路径、QWEN.md 与映射文档；`manifest-lint.mjs` 守源与生成器，并禁止根目录再出现 `qwen-extension.json`；CI 增加 parity 步骤。`run-hook-tests.mjs` 覆盖 qwen 的 no-sheet / off / QWEN_HOME 三种状态。**验证**：Qwen Code 0.26.8 隔离 `QWEN_HOME` 实测安装成功，`ExtensionManager` 读到 `format=qwen` / 66 skills / 4 agents / SessionStart hook×1 / `QWEN.md`；**live 鉴权模型会话未跑**。

**0.1.23**

- **effort 注册口径文档收口**：7 项 skill（arena / interrogate / architect / how / swarm / reflect / why）的 Reasoning effort 段仍是「无宿主注册 effort agents」的 0.1.22 前旧口径，统一替换为与 `poteto-mode` SKILL.md 一致的表述（ZCode 自 0.1.22 起注册 `effort-*` / `poteto-agent-*` 两族三档，medium→high、xhigh→max；其余宿主仍不注册，fallback 规则照旧）；`extras/README.md` 的「ZCode 只注册 4 个基础代理」同步改为「全部 15 个」。纯文档对齐，无代码/映射表改动，`test/role-table-parity.mjs`（68 断言）通过。

**0.1.22**

- **ZCode 派发能力落地**：`models.json` 新增 `zcode` 块（tier/level → subagent_type 映射表），`agents/` 注册 `poteto-agent-strong`、4 个 `panelist-*` 多模型席位与 6 个 effort 力度变体（medium→high、xhigh→max 折映射），thermo 双审计子代理补钉 GLM-5.3@max——ZCode 的 `Agent` 调用无 per-call 模型，模型与力度改由 agent 类型 frontmatter 钉定；`zcode-tools.md`、`setup-pstack` 运行时表、`test/role-table-parity.mjs`（新增 zcode 块 ↔ agents/ frontmatter 对账）联动。
- **席位按宿主模型清单实测重钉**（2026-11-06）：panelist 定为 `minimax-m3.1-flash` / `spark-x2.6` / zai 路线 `GLM-5.3-Flash` / 计费档 `GLM-5.3-Flash`；跨家族真多样性为 MiniMax 与 Spark 两族，zai 帧为同族二次采样。钉定不在宿主清单内的 ID 会静默回退会话模型（实测结论），供应商增删后应对照清单重钉。

**0.1.21**

- **同步上游 v0.15.28→v0.15.36 的 skill 级变更**（`c742dd6`）：swarm 步骤编号修复、sharpen 重写、interrogate 重构为 arena 驱动的对抗验证（`references/` 四文件随上游删除）、arena 弃座回填与 cross-judge 家族规则、poteto-mode 首条消息触发器与模型拒绝回退链、6 个 playbook 更新、check-plan.mjs 行内代码定界符正则修复；watch-pr 的 fork 识别与 deadline 封顶经核对已由本地实现覆盖，无需改动。
- **新增 `ketchup-video` skill**（66 个 skill）；orchestrate 的上游 agentic 改写未采纳，orch 保留本地 Windows 加固版；statechart 与 benny 未纳入。取舍明细见 `NOTICE-PORT.md` 第 9 条。

**0.1.20**

- **`NOTICE.md` 自标为上游原文**：该文件按上游 pstack-claude 的布局列出"port-authored files"，其中若干路径在本包内并不存在（本包已按 `NOTICE-PORT.md` 的搬迁记录改布局），"六个 cursor-team-kit skill 逐字复制"一句也与本包的 frontmatter 中性化改写不符。文件头补一句"本文件为上游原文，本包实际布局与差异以 NOTICE-PORT.md 为准"，并修正该处与 `CHANGES.md` 归属的矛盾。

**0.1.19**

- **`orch` 多进程锁套件在 Windows 稳定全绿**（253/253 连续两轮），`store.ts` 的静默失败路径同批修掉。
- `skills/poteto-mode/scripts/worktree-audit.mjs` 兼容新版 transcript 目录布局。
