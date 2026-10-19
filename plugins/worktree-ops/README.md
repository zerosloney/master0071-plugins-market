# worktree-ops

Git worktree 操作台：**在仓库之外的可配置目录**里创建、查看、审计、合并回主干与安全清理 worktree，附带把工作交接到新会话的完整指引。

解决的问题很简单：多数 agent 宿主在会话启动时就固定了工作目录，子 agent 继承这个目录，所以"开一个隔离的分支工作区"要么被写死在某个路径（`isolation: "worktree"`），要么根本做不到。这个插件接管 worktree 的生命周期，把**建在哪**变成配置项，并把"换目录开工"变成一段可以直接粘贴的交底文本。

宿主中立：不绑定任何一家客户端的目录约定、hook 或斜杠命令，只用标准 MCP stdio server + 标准 skill。

## 可移植组件

| 组件 | 路径 |
|------|------|
| MCP server（10 个工具） | `mcp/server.mjs`，`mcp.json` 里注册为 `worktree` |
| Skill | `skills/worktree-manager/` |

工具清单：

| 工具 | 作用 |
|------|------|
| `worktree_create` | 在配置根目录下从基线新建分支，或检出既有分支（如 PR 分支）做验证，产出绝对路径 + 新会话交底 |
| `worktree_list` | 列出全部 worktree：分支、HEAD、是否干净、领先/落后、是否已合并、闲置天数 |
| `worktree_status` | 单个 worktree 的完整详情，含脏文件、最后提交、当前会话是否已在其中 |
| `worktree_audit` | 清理前分桶审计：`safe` / `review` / `hold` + 原因 + 可回收空间，**只读不删** |
| `worktree_remove` | 删除 worktree（可选删分支），脏/未合并拒绝（可显式 `force`）；受管目录外一律拒绝，`force` 也不放宽 |
| `worktree_lock` | 锁定 worktree（`git worktree lock`，可记原因）：remove / merge_back 一律拒绝碰锁定的工作树 |
| `worktree_unlock` | 解锁，恢复 remove / merge_back |
| `worktree_merge_back` | 默认只出计划；`rebase` / `merge` / `remove` 开启后执行，遇冲突停下交还 |
| `worktree_set_root` | 读写根目录等配置，`scope: global` 或单仓库覆盖 |
| `worktree_handoff` | 生成可粘贴的交接简报（路径、分支、基线、任务、约束） |

## 目录策略

根目录**没有内置默认值**：未配置时 `worktree_create` 直接拒绝并提示三种配置方式。推荐先设一处仓库外的集中目录（如 `E:\Demo\worktrees`）。根目录**也可以设在仓库工作树内**：`worktree_create` 会先把该目录幂等写入 `.git/info/exclude`（本地忽略，不改动仓库里被跟踪的 `.gitignore`），主检出 `git status` 同样保持干净；只有 `.git` 目录内部是例外，一律拒绝。

配置优先级（高 → 低）：

1. 环境变量 `WORKTREE_ROOT` / `WORKTREE_BASE_REF` / `WORKTREE_BRANCH_PREFIX` / `WORKTREE_STALE_DAYS`
2. 配置文件里的单仓库覆盖（`worktree_set_root` 的 `scope: "repo"`）
3. 配置文件里的全局值（`scope: "global"`）
4. 内置默认：`baseRef=auto`（跟随会话仓库当前检出分支，detached 时回退仓库默认分支）、`branchPrefix=wt/`、`staleDays=14`——注意 `root` 没有默认值，必须显式配置

配置文件位置：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\worktree-ops\config.json` |
| macOS / Linux | `$XDG_CONFIG_HOME/worktree-ops/config.json`（默认 `~/.config`） |

用 `WORKTREE_CONFIG_HOME` 可以整体改掉这个目录。支持设置页的宿主（ZCode）会把设置项映射成上面那组环境变量，用户在界面里填的值优先级最高。

## 安全边界

这些是有意为之的拒绝，不是 bug：

- 删主工作树：永远拒绝。
- 删脏工作树 / 有未合并提交的 worktree：拒绝，必须显式 `force`。
- 删受管根目录之外的 worktree：一律拒绝，`force` 只覆盖脏工作树 / 未合并提交，不放宽受管根边界。
- 合并时主工作树检出的不是目标分支：拒绝，并告知先 `git checkout`。
- rebase / merge 冲突：停下并列出冲突文件，不自动解决。
- skill 层面：任何破坏性调用前先向用户确认。

## 安装

按 **Agent Plugins 1.0.0** 打包（根 `plugin.json` + `mcp.json` + `skills/`），兼容客户端直接加载 `plugins/worktree-ops` 目录即可；ZCode / Codex / Oh My Pi 通过各自的垫片安装。

## 依赖

- Node.js ≥ 18（在 PATH 上）
- `git`（在 PATH 上）

零第三方依赖，无网络调用，无凭据。

## 测试

```
node test/smoke.mjs
```

在临时目录里建一个一次性 git 仓库，跑完整工具链（创建 / 列表 / 状态 / 交接 / 审计 / 合并 / 删除拦截 / 主工作树保护 / 未配置拒绝 / 非 git 目录报错 / 环境变量覆盖优先级），不需要真实仓库，也不需要任何凭据。测完自动清理临时目录。
