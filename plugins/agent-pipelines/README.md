# agent-pipelines

多代理编排管道套件，合并两条「Orchestrator → 执行者 → 审查者」流水线：

| 命令 | 用途 | 主控 | 执行者 | 审查者 |
|------|------|------|--------|--------|
| `/ralph-pipeline` | 通用任务编排执行审查（线性 TaskList，任意领域） | ralph-orchestrator | ralph-worker | ralph-reviewer |
| `/coding-pipeline` | 受控编码管道（scope 零容忍、根因分组修复、真实验证） | coding-orchestrator | coding-builder | coding-reviewer |

## 机制

两条管道共享同一套骨架，参数不同：

- **状态持久化**：`.loop-cli/state/ralph-pipeline.json` / `.loop-cli/state/coding-pipeline.json`（version=1，原子写入 tmp + rename，可断点恢复）。
- **背压熔断**：连续失败达阈值 ESCALATE；任务状态签名连续无变化判 STALL；轮次达 MAX_CYCLES 强制停止（ralph=10 / coding=8，`max_iterations > 0` 可覆盖）。
- **停止枚举**：`DONE | ESCALATE | HOLD | STALL | MAX_CYCLES | STOPPED`。
- **任务拆分预算**：子任务数 ≤ MAX_CYCLES × 系数（ralph 0.8 / coding 0.75），超限报 `decomposition_overflow` 交用户。

coding 管道额外约束：

- **scope 零容忍**：hard_scope 必做、soft_scope 可做、forbidden_scope 禁碰；diff 一行越界即 `scope_drift="FAIL"`，不允许 DONE。
- **根因分组修复**：多 issue 先归并根因组，一组一次最小修复，禁止逐条打补丁。
- **零证据禁令**：detected_stack 非空且验证脚本 MISSING 时禁止 PASS。
- **完成铁律**：动态检查无 FAIL + 审查 PASS + 零 critical/major + scope_drift PASS。

## 使用

```
/ralph-pipeline <目标描述>
/coding-pipeline <编码任务描述>
```

Orchestrator 全程通过子代理工具委派，不直接产出业务代码；每轮写入状态文件并按门禁决定停止。

## 子智能体模型说明

agents frontmatter 中 pin 了 `GLM-5.3`（主控）与 `GLM-5.3-Flash`（执行/审查）分层。若模型不可用，可在安装后编辑各 agent 定义或移除 `model` 字段回退会话默认模型。
