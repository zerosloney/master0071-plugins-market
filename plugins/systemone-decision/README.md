# systemone-decision

ZCode 插件：接入 SystemOne 决策协议（默认 unisound u2-decision），提供 4 个预设决策工具和 1 个通用决策工具，供 Agent 在流程中做结构化判定：

- **工单分流** `ticket_triage` — 归属团队 + 严重程度 + 是否升级值班
- **内容审核** `content_moderate` — 处置动作 + 违规类型 + 风险等级
- **Agent 路由** `agent_route` — 执行 Agent + 复杂度 + 是否转人工
- **结果校验** `verify_result` — 是否满足要求 + 主要问题 + 质量等级
- **自定义决策** `systemone_decide` — 任意 choice / noul / score 问题组合

零依赖 MCP 服务器（stdio），要求 Node ≥ 18。

## 配置（环境变量）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SYSTEMONE_API_KEY` | 是（或 `UNISOUND_API_KEY`） | — | API Key，unisound 在 [API Key 管理](https://maas.unisound.com/admin/project/api-key) 创建 |
| `SYSTEMONE_BASE_URL` | 否 | `https://maas-api.unisound.com/v1` | SystemOne 兼容端点根地址 |
| `SYSTEMONE_MODEL` | 否 | `u2-decision` | 模型编码 |
| `SYSTEMONE_TIMEOUT_MS` | 否 | `30000` | 请求超时（毫秒） |

Windows 设置示例（设置后重启 ZCode）：

```
setx SYSTEMONE_API_KEY "你的Key"
```

## 切换供应商

插件与厂商解耦：所有请求收敛于 `mcp/server.mjs` 的 `callSystemone()`，协议字段（`model` / `state` / `questions` → `answers`）遵循 SystemOne 规范。换厂商 = 换环境变量，插件代码零改动：

```
setx SYSTEMONE_BASE_URL "https://你的供应商/v1"
setx SYSTEMONE_MODEL "你的决策模型"
setx SYSTEMONE_API_KEY "对应的Key"
```

## 需求明确度预检 hook（随插件自动安装）

插件通过 `hooks/hooks.json` 声明了一个 UserPromptSubmit hook：每次用户提交输入时，先用决策模型对需求做一次明确度判定（clarity / missing / proceed 三问），仅在判定为"不明确"（clarity ≤ 1 或 proceed < 0.6）时把结论注入对话上下文，提醒 Agent 先澄清再动手。需求明确、寒暄捷径（如"好的""继续"）或预检失败时静默放行，不产生任何输出。

安装插件即自动生效，卸载即自动移除，无需手动注册；复用 `SYSTEMONE_*` 环境变量，未配置 Key 时自动跳过。hook 内部请求超时上限 12 秒（hook 进程上限 15 秒），失败绝不阻塞用户输入。

## 开发与测试

```
node test/smoke.mjs
node test/hook.smoke.mjs
```

冒烟测试启动本地 mock 端点，对 MCP 服务器做端到端验证（initialize / tools/list / tools/call / 参数校验 / 缺 Key 报错），不需要真实 API Key。
