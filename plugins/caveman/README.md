# caveman

超压缩通信模式插件：删废话，保技术准确。通过 hooks 在会话各事件点（启动、提问、工具调用、回答结束）自动注入压缩规则并统计 token 节省，支持 lite、full、ultra、wenyan 强度级别，附 cavecrew 多代理协作（builder / investigator / reviewer / general）。

本插件随 [master0071-plugins 市场](../../README.md)分发，市场安装支持 ZCode / CodeBuddy / omp / ChatGPT Codex / Dim / MiniMax Code / Qwen Code；opencode 走本地路径安装（`plugins/caveman` 自带包入口）。原 caveman4cn 上游仓库及其 installer 已退役：Trae / Qoder / Cline 不再提供安装通道，Qwen 的 hooks 自动合并改为一次性手动配置（见下节）。

## 压缩级别

| 级别 | 效果 |
|------|------|
| `lite` | 去除废话，保持完整句子 |
| `full`（默认） | 省略冠词，使用片段，短同义词 |
| `ultra` | 极限压缩，每句话只出现一次事实 |
| `wenyan` | 文言文输出，最大压缩比（另有 wenyan-lite / wenyan-full / wenyan-ultra） |

## 组件

- **命令**（9 个）：`/caveman`（切换强度）、`/caveman-commit`、`/caveman-review`、`/caveman-compress`、`/caveman-stats`、`/caveman-statusline`、`/caveman-init`、`/caveman-install`、`/caveman-help`
- **技能**（7 个）：`caveman`（规则本体）、`caveman-commit`、`caveman-compress`（含 Python 压缩脚本）、`caveman-help`、`caveman-review`、`caveman-stats`、`cavecrew`
- **代理**（4 个）：`cavecrew-builder` / `cavecrew-investigator` / `cavecrew-reviewer` / `cavecrew-general`
- **hooks**：按宿主分目录（`hooks/<host>/`），覆盖 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop 等事件

## 各宿主安装（市场内）

```sh
# ZCode / CodeBuddy / omp：先添加市场，再安装
/plugin marketplace add zerosloney/master0071-plugins-market
/plugin install caveman@master0071-plugins

# ChatGPT Codex CLI
codex plugin marketplace add zerosloney/master0071-plugins-market
codex plugin install caveman@master0071-plugins

# Qwen Code
qwen extensions install zerosloney/master0071-plugins-market:caveman
```

| 宿主 | 载荷 | 说明 |
|------|------|------|
| ZCode | commands + skills + agents + hooks（ZCode 原生格式） | 带设置页（userConfig），见下 |
| CodeBuddy | commands + agents + skills + hooks（Claude 式） | 状态行可配，见上游 README |
| omp | skills + commands + agents + extension hooks | marketplace 安装一键加载 |
| ChatGPT Codex / Dim | skills + hooks（`${CLAUDE_PLUGIN_ROOT}`） | 经 `.codex-plugin/plugin.json` 加载 |
| MiniMax Code | skills + UserPromptSubmit hook（`${PLUGIN_ROOT}`，8s 预算） | `.minimax-plugin/plugin.json` 清单；模式强化随每次输入注入，`/caveman` 系列在输入文本层拦截 |
| Qwen Code | commands + agents + skills（市场转换安装）+ hooks（手动配置一次） | `.claude-plugin/marketplace.json` 条目；Qwen hook 命令无插件根变量注入，见下方手动配置 |
| opencode | skills ×7 + 模式管理 prompt hook | 本地路径安装 `"plugins": ["…/plugins/caveman"]`；opencode 只能接 prompt 等价物，SessionStart / 工具事件 / token 统计不接线 |
| Trae / Qoder / Cline | 无 | caveman4cn 上游 installer 已退役，不再提供安装通道 |

### Qwen hooks 手动配置（installer 退役后）

市场安装把全部 hook 脚本装到 `~/.qwen/extensions/caveman/`（无版本号子目录，路径稳定），但 Qwen 不会为扩展注入插件根变量，hooks 需要把**绝对路径**写进 `~/.qwen/settings.json`——一次性操作，之后由 Qwen 直接调用。把下段合并进 `settings.json` 顶层（`<your-home>` 换成实际用户目录，Windows 同样用正斜杠）：

```jsonc
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|clear|compact", "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/session-start.js", "timeout": 10000, "name": "caveman-session-start", "description": "Activate caveman mode and inject compressed-communication rules" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/user-prompt.js", "timeout": 10000, "name": "caveman-user-prompt", "description": "Track caveman mode, handle /caveman commands, per-turn reinforcement" }] }],
    "PreToolUse": [{ "matcher": "run_shell_command|write_file|edit|Bash|Write|WriteFile|Edit", "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/pre-tool-use.js", "timeout": 5000, "name": "caveman-pre-tool-use", "description": "Block dangerous operations (rm -rf, system file writes, etc.)" }] }],
    "PostToolUse": [{ "matcher": "run_shell_command|write_file|edit|Bash|Write|WriteFile|Edit", "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/post-tool-use.js", "timeout": 5000, "name": "caveman-post-tool-use", "description": "Track tool usage for stats" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/stop.js", "timeout": 5000, "name": "caveman-stop", "description": "Check output quality when caveman mode is active" }] }],
    "PostToolUseFailure": [{ "matcher": "run_shell_command|write_file|edit|Bash|Write|WriteFile|Edit", "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/post-tool-use-failure.js", "timeout": 5000, "name": "caveman-post-tool-use-failure", "description": "Provide compressed recovery advice on tool failure" }] }],
    "PreCompact": [{ "matcher": "auto|manual", "hooks": [{ "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/hooks/qwen/pre-compact.js", "timeout": 5000, "name": "caveman-pre-compact", "description": "Inject caveman rules into compression guidance" }] }]
  },
  "ui": {
    "statusLine": { "type": "command", "command": "node <your-home>/.qwen/extensions/caveman/scripts/statusline.js" }
  }
}
```

说明：matcher 同时列 Qwen 原生 snake_case 工具名与 PascalCase 别名（无论传哪种都触发）；timeout 单位毫秒；未配置 `CAVEMAN_DEFAULT_MODE` / 项目配置时默认强度 `full`；`/caveman` 系列指令即使不配 hooks 也能靠 skill 生效，hooks 带来的是自动激活、工具事件统计与 token 省用量。

## 配置

**默认强度**解析顺序：`CAVEMAN_DEFAULT_MODE` 环境变量 → 项目级 `.caveman/config.json`（或 `.caveman.json`，向上查找）→ 用户级配置文件 → `full`。

**ZCode 设置页**（userConfig）：

| 配置项 | 说明 | 默认 |
|--------|------|------|
| Default Mode | 默认强度 lite / full / ultra / wenyan / off | `full` |
| Statusline Indicator | 终端提示里显示 caveman 模式标记 | 开 |
| Token Usage Stats | 统计压缩节省的 token | 开 |

每个宿主的运行状态互相隔离（`~/.caveman/<agent>/`），多宿主同机不串台。

## 维护（本仓库内）

八个宿主构建（codebuddy / claude / qoder / qwen / trae / zcode / minimax / opencode）共用的配置解析器由模板渲染：改 `shared/caveman-config.template.js`（不要直接改各 `hooks/<host>/caveman-config.js`），然后运行：

```sh
node scripts/sync-shared.js
```

脚本幂等，渲染后做占位符 / 语法 / 行为三重校验。新增宿主构建：在 `scripts/sync-shared.js` 的 `AGENTS` 表加条目并重跑。许可证 MIT。
