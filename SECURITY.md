# 安全策略

## 支持的版本

本仓库按插件独立发版，安全修复只落在最新版本线：

| 插件 | 版本线 | 支持 |
| --- | --- | --- |
| systemone-decision | 0.5.x | ✅ |
| worktree-ops | 0.4.x | ✅ |
| agent-pipelines | 0.1.x | ✅ |
| pstack | 0.1.x | ✅ |
| ai-native-delivery | 0.1.x | ✅ |

旧版本不回溯发补丁，修复随下一个 patch 版本发布。

## 报告漏洞

**不要开公开 issue。**

- GitHub 私密渠道：仓库页 → Security → Report a vulnerability（Private vulnerability reporting）。
- 邮件兜底：见仓库所有者 GitHub 主页（@zerosloney）公开的联系方式，标题带 `[security] <插件名>`。

报告请包含：受影响插件与版本、复现步骤或 PoC、影响评估（数据丢失 / 凭据外发 / 越权执行 / 其他）、
你希望如何在致谢中署名。

## 响应目标

| 动作 | 目标时限 |
| --- | --- |
| 确认收到 | 3 天内 |
| 初步评估（是否成立、严重级） | 7 天内 |
| 修复发布（高危） | 30 天内 |
| 修复发布（中低危） | 90 天内 |

以上是尽力目标，非服务承诺——本仓库由个人维护。

## 处理范围说明

本仓库是 **Agent Plugins 市场仓**，装进宿主（Claude Code / Codex / ZCode / Oh My Pi 等）后，
插件会在你的机器上执行 hook 脚本、MCP 服务与命令。因此这里特别关注三类面：

1. **数据丢失 / 不可逆操作**——如 worktree-ops 删除工作树、ai-native 台账写入、agent-pipelines
   门禁判定。护栏必须在服务端成立，不能只靠提示词。
2. **凭据外发**——systemone 的 Bearer Key 走什么端点、错误文案回显什么内容。
3. **闸门绕过**——deny 地板被引号变体绕过、原型链越权、Host 头伪造等「看起来有闸、实际没有」的问题。

已知历史问题与修复记录在各插件 README 的版本变更段与提交历史。

## 与依赖漏洞的区别

本仓插件**零 npm 依赖**（CI 与运行均只用 Node 标准库），不存在 npm 侧的供应链面。
pstack `extras/poteto-mode-scripts/` 是上游 vendored 的 bun 工具链（默认不加载、需手工启用），
其依赖问题按上游处理。GitHub Actions 依赖走 Dependabot（`.github/dependabot.yml`）。
