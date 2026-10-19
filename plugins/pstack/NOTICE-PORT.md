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
| 原始作品 | [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)，© 2026 Lauren Tan (poteto)，MIT |
| 另含组件 | `deslop` / `make-pr-easy-to-review` / `fix-ci` / `fix-merge-conflicts` / `get-pr-comments` / `what-did-i-get-done`（© 2026 Cursor，MIT）；`thermos` / `thermo-nuclear-*`（© 2026 Cursor，MIT） |

完整的逐组件归属表见 [`NOTICE.md`（上游原文）](NOTICE.md)，技能级归属见 [`NOTICE-skills.md`](NOTICE-skills.md)。对应许可证正文：[`LICENSE`](LICENSE)、[`LICENSE-cursor-team-kit`](LICENSE-cursor-team-kit)、[`LICENSE-thermos`](LICENSE-thermos)。

**再分发条件**：保留上述全部版权声明与许可证文件。上游 README 中提到的 Pi 扩展、Codex 命令垫片、图片资源在本移植中已剔除（见插件 README「与上游的差异」）；Codex 侧改用本移植自己写的 `.codex-plugin/plugin.json`，不影响任何 skill 的可用性。

## 本移植所做的修改

1. 位置改写：上游仓库的 `.claude-plugin/plugin.json`（Claude 专用清单）→ 本目录根 `plugin.json`（Agent Plugins 标准清单，封闭 schema）；上游仓库根的 `.claude-plugin/marketplace.json` → 本仓库根 `marketplace.json`。
2. 剔除：`.claude-plugin/icon.png`、`assets/`（约 1.9 MB 图片）、`pi/`（Pi 扩展）、`.github/`（上游 CI 配置）、`tools/`（上游生成脚本，`skills/` 内多处注释提及的 `tools/generate.mjs` 因此仅为出处说明，不可执行）。
3. 新增（非上游原文，属本移植的打包层）：`.codex-plugin/plugin.json`——上游那份 `.codex-plugin/` 已随第 2 条剔除，本仓库按 Codex 插件 schema 重写了一份，只声明 `skills`、`SessionStart` hook 与 `interface` 展示信息，不含上游的 `prompts/` 命令垫片。
4. 新增（ZCode 适配层，非上游原文）：`hooks/session-start-zcode.mjs` + `hooks/zcode/hooks.json`——ZCode 的 SessionStart 注入走 node 进程入口（`process` 型 hook），读 `~/.zcode/pstack-models.md`、沿用 `session hook: off` 开关语义，输出 ZCode 要求的 `hookSpecificOutput.additionalContext` JSON（ZCode 对 hook stdout 按严格 JSON 解析，且其 Windows shell 无法执行裸 `.sh`）。`.zcode-plugin/plugin.json` 的 `hooks` 字段相应指向 `hooks/zcode`，并移除 ZCode 不识别的 `effort-agents` 声明。Claude 版 `hooks/hooks.json` 与 `session-start.sh` 原样保留。另新增 `skills/poteto-mode/references/zcode-tools.md`（ZCode 工具与模型映射），setup-pstack 的运行时表补 ZCode 行，poteto-mode 的 Platform Adaptation 节补 ZCode 句。
5. 版本号独立：本插件以 `0.1.x` 发布，与上游 `0.9.86` / `0.15.x` 解耦；升级上游时对照上面的「源版本 / 源提交 / 内容同步」三行。
6. fork 基线内的 skill frontmatter、正文、playbooks、scripts 与子智能体定义逐字未改；相对 fork 基线新合入的上游 delta（v0.15.26–v0.15.28）沿用同一套适配约定：剥除 Cursor 专有 frontmatter 键（`disable-model-invocation` 等）、Claude Code 工具名与模型口径、技能间相对链接。
7. 上游 v0.15.28 的 `docs/guide/`（指南）与 `make-bot-ui` skill（Grok Bot webhook 唤醒，Cursor 生态绑定）未随同步纳入，与移植源的剔除决策一致。

本移植只增加打包层（清单、注册项、说明文档），未新增上游以外的功能代码。
