#!/usr/bin/env node
// pretool-risk.mjs — PreToolUse hook：shell 类命令风险闸（Claude 式清单宿主共用）。
// 契约：stdin = hook JSON（取 tool_name / tool_input 字段）；判定 deny/ask 时输出
// hookSpecificOutput.permissionDecision，其余（放行、只读捷径、非 shell 工具、缺 Key、
// 异常）一律静默 exit 0（fail-open）——绝不阻塞工具调用，诊断走 stderr。
// stdin/stdout 协议壳在 hooks/hook-io.mjs；判定内核（门限 / 三问 / 理由文案）在 hooks/risk-gate.mjs。

import { main, NO_BUDGET_MS } from './hook-io.mjs';
import { assess } from './risk-gate.mjs';

// ask 载荷封装：预算耗尽分支与 stdin 挂起兜底（killer emit-ask）共用同一构造，一处定义两处用——
// 宿主拿到的 JSON 必须同形（permissionDecision + 理由文案），不因触发路径不同而变格式。
const askOutput = (verdict) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: verdict.decision, // 'deny' | 'ask'
    permissionDecisionReason: verdict.reason,
  },
});

// stdin 挂起/滴流吃满 14s 共享预算时的兜底载荷（挂起场景下 tool_name / tool_input 没到达，
// 判定请求也没有时间发）：风险闸按不可判处理转人工确认——把「挂起=静默放行（空输出）」
// 变成「挂起=人工确认」，并赶在宿主 15s 超时前送达。
export const killerAsk = () =>
  askOutput({
    decision: 'ask',
    reason:
      '[SystemOne 风险闸] hook 在 14s 共享预算内未读完整条输入（stdin 挂起或滴流过慢），风险闸按不可判处理，无法分析该命令：请向用户展示命令并确认后再执行。',
  });

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
  return askOutput(verdict);
}, '风险闸跳过', { killPolicy: 'emit-ask', askPayload: killerAsk });
