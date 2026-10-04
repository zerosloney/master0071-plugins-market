---
description: 检查当前宿主的 caveman hooks 接线状态；市场已接线的宿主直接报告，Qwen 引导一次性手动配置（上游 installer 已退役）。
---

# Caveman Install Helper

## 背景

原 caveman4cn 上游 installer（`install-*.js`）已退役。当前各宿主的 hooks 接线方式：

| 宿主 | hooks 接线 | 本命令要做的 |
|---|---|---|
| ZCode / CodeBuddy / omp / Codex / Dim / MiniMax | 市场安装自动接线 | 检测后报告"无需操作" |
| opencode | prompt hook 随适配器接线（无工具事件 hooks） | 同上 |
| Qwen Code | 需一次性手动合并 `~/.qwen/settings.json` | 引导/代为执行下方配置 |
| Trae / Qoder / Cline | 无通道 | 明确告知不支持 |

## Step 0 — Detect the host agent (do this first)

Detection order (same as `scripts/statusline.js::detectAgentId`):

1. `CAVEMAN_AGENT` env var — explicit override. `echo $CAVEMAN_AGENT` (bash) or `$env:CAVEMAN_AGENT` (PowerShell).
2. Host env hints — `CODEBUDDY_TMUX_SESSION` or `CODEBUDDY_INSTANCE_META_PURPOSE` present ⇒ CodeBuddy.
3. Live `active` flag on disk — whichever of `codebuddy`/`qwen`/`qoder`/`trae`/`zcode` has a file at `~/.caveman/<agent>/active` wins. Check with: `ls ~/.caveman/*/active` and ignore the "no such file" noise from the shell.
4. Fallback — `qwen` (the only host that still needs manual wiring).

Report the detected host to the user before proceeding.

## What to do

1. **市场已接线的宿主**（ZCode / CodeBuddy / omp / Codex / Dim / MiniMax / opencode）：报告 hooks 已随插件自动接线，无需任何安装步骤。若用户报告 hooks 未生效，建议重装插件或检查宿主版本。

2. **Qwen Code**：读 `~/.qwen/settings.json`，检查 `hooks` 下是否已有 `name` 以 `caveman-` 开头的条目。没有则按 `plugins/caveman/README.md` 的「Qwen hooks 手动配置」节，把 hooks 片段（7 事件 + 可选 `ui.statusLine`）合并进 `settings.json`——command 用 `~/.qwen/extensions/caveman/` 下脚本（含 `hooks/qwen/`）的绝对 POSIX 路径。合并前向用户展示将写入的内容并确认；合并后提示重启 Qwen Code 或运行 `/extensions` 重载。

3. **Trae / Qoder / Cline**：告知不支持——上游 installer 已退役，本仓库未提供替代通道。

4. **不要运行任何 `install-*.js`**——它们已不存在。本命令只做宿主检测与（Qwen 的）手动合并引导，不要直接改写 settings.json 之外的文件。
