# pstack

poteto（Lauren Tan）风格的 agent 工作流栈，按 **Agent Plugins 1.0.0** 标准打包。63 个 skill + 14 个子智能体 + 1 条会话启动 hook。

一句话概括上游的自述：**"if you want to go fast, go deep first"** —— 先深挖，再快跑；少写代码，但写得更硬。

## 入口

| 入口 | 说明 |
|------|------|
| `poteto-mode` | **唯一总入口**。告诉它你的目标，它挑该走哪条工作流：复现并定位 bug、用 `architect` 起草设计、`arena` 竞速方案、`interrogate` 审 diff、`unslop` 削文案 |
| `setup-pstack` | 选模型分工、关闭会话 hook，写 `pstack-models.md`（默认路径 `~/.claude/`） |
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
| 验证资产 | 3 | `create-verification-skill`、`maintain-verification-skill`、`teach` |
| 其他 | 4 | `automate-me`、`reflect`、`show-me-your-work`、`typescript-best-practices` |
| 原则 | 24 | `principle-laziness-protocol`、`principle-subtract-before-you-add`、`principle-model-the-domain`、`principle-type-system-discipline` 等 |

39 + 24 = 63。分组按 skill 目录名归类，具体触发条件以各 `SKILL.md` 的 `description` 为准（宿主据此决定是否自动调用）。

## 原则层

24 个 `principle-*` skill 是独立可用的判断准则，不依赖 `poteto-mode`：`principle-laziness-protocol`（偏向删除）、`principle-explain-the-number`（报告数字前先确认口径）、`principle-fix-root-causes`（修根因而不是症状）、`principle-test-behavior-not-implementation` 等。需要单独用某条准则时，直接加载对应 skill。

## 宿主支持

| 能力 | 状态 |
|------|------|
| `skills/`（Agent Plugins 1.0.0 标准） | 所有兼容客户端按固定位置发现，无需清单声明 |
| `.omp-plugin/plugin.json` | **Oh My Pi 兼容垫片**：声明 `skills` 与 `agents`；也是根 `.omp-plugin/marketplace.json` 里的市场条目，omp 侧 `pstack@master0071-plugins` 已可安装（dry-run 通过）。omp 不加载 `hooks/`，所以没有会话启动自动路由 |
| `.codex-plugin/plugin.json` | **Codex 兼容垫片**：声明 `skills` 与 `SessionStart` hook，Codex 直接发现 `skills/` 下全部 63 个 skill，无需 prompts 垫片 |
| `agents/` + `effort-agents/` | **客户端约定**，仅支持子智能体的宿主生效；Codex 不加载 |
| `hooks/` | **客户端约定**，Claude 式 hook 宿主生效；Codex 走垫片里内联的那一份 |
| `models.json` | skill 内多处引用它说明模型分工的出处，改它需要重新生成，本移植未附带生成脚本 |

Codex 侧未验证项：垫片里的 hook 沿用上游的 `command` 类型与 `${CLAUDE_PLUGIN_ROOT}` 写法，本机 Codex 插件样本只出现过 `mcp_tool` 类型的 hook（Stop / SubagentStop / Interrupt），因此**会话启动是否真的注入路由令未实测**。若没生效，手动 `/poteto-mode` 即可，或在 `.codex-plugin/plugin.json` 里删掉 `hooks` 字段。

hook 行为：会话开始时读取 `~/.claude/pstack-models.md`（`$CLAUDE_CONFIG_DIR` 可改）。若文件里含 `session hook: off` 一行，则不注入路由令——**关掉自动路由的方式就是这个**，比删 hook 干净。

## 与上游的差异

移植自 [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) `plugins/pstack/`（版本 `0.9.86`，提交 `1dba27e`）。skill 正文、子智能体、hook 脚本逐字保留，**剔除了**：

| 剔除项 | 原因 | 影响 |
|--------|------|------|
| `assets/`、`.claude-plugin/icon.png` | 约 1.9 MB 图片，本仓库不打包二进制资源 | 仅少个图标 |
| `pi/` | Pi 扩展专属，其他宿主用不上 | Pi 上没有自动路由，skill 本身照常手动可用 |
| `.codex-plugin/` | Codex 命令垫片，由宿主各自的清单机制承担 | 已由本仓库重写为 `.codex-plugin/plugin.json`（见下），不是上游原文 |
| `.github/`、`tools/` | 上游 CI 与生成脚本 | skill 里提到的 `tools/generate.mjs` 仅是出处说明，不可执行 |

完整署名链见 [NOTICE-PORT.md](NOTICE-PORT.md) 与 [NOTICE.md](NOTICE.md)（上游原文）。**再分发须保留 `LICENSE`、`LICENSE-cursor-team-kit`、`LICENSE-thermos` 三份许可证。**

## 升级上游

本插件版本号只表示本仓库的移植包版本（当前 `0.1.0`），与上游版本解耦。升级步骤：

```bash
git clone --depth 1 https://github.com/michael-denyer/pstack-claude <临时目录>
# 只取 plugins/pstack/{skills,agents,effort-agents,hooks,models.json} 覆盖到本目录
# 再更新 NOTICE-PORT.md 的「源版本 / 源提交」两行
node scripts/release.mjs pstack <新版本>
```

## 使用

先跑一次 `setup-pstack` 确认模型分工是否符合你的账号与供应商；其余按目标直接说，或手动 `/poteto-mode`。
