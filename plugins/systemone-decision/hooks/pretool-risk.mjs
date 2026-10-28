#!/usr/bin/env node
// pretool-risk.mjs — PreToolUse hook：shell 类命令风险闸（Claude 式清单宿主共用）。
// 契约：stdin = hook JSON（取 tool_name / tool_input 字段）；判定 deny/ask 时输出
// hookSpecificOutput.permissionDecision，其余（放行、只读捷径、非 shell 工具、缺 Key、
// 异常）一律静默 exit 0（fail-open）——绝不阻塞工具调用，诊断走 stderr。
// stdin/stdout 协议壳在 hooks/hook-io.mjs；判定内核（门限 / 三问 / 理由文案）在 hooks/risk-gate.mjs。

import { main, NO_BUDGET_MS } from './hook-io.mjs';
import { assess } from './risk-gate.mjs';

main(async (input, timeoutMs, truncated) => {
  // truncated 透传给内核：stdin 被截断时输入不可信，风险闸必须 fail-closed（不得按只读捷径放行）
  // 预算耗尽（stdin 到达过慢）同样按「输入不可信」处理：没有时间发判定请求，
  // 只能转人工确认，绝不静默放行（空输出 = 宿主看不到任何提示）。
  const budgetExhausted = timeoutMs <= NO_BUDGET_MS;
  const verdict = await assess(input.tool_name, input.tool_input, process.env, {
    timeoutMs,
    truncated: truncated || budgetExhausted,
    budgetExhausted,
  });
  if (!verdict) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision, // 'deny' | 'ask'
      permissionDecisionReason: verdict.reason,
    },
  };
}, '风险闸跳过');
