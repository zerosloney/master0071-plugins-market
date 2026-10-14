#!/usr/bin/env node
// pretool-risk.mjs — PreToolUse hook：shell 类命令风险闸（Claude 式清单宿主共用）。
// 契约：stdin = hook JSON（取 tool_name / tool_input 字段）；判定 deny/ask 时输出
// hookSpecificOutput.permissionDecision，其余（放行、只读捷径、非 shell 工具、缺 Key、
// 异常）一律静默 exit 0（fail-open）——绝不阻塞工具调用，诊断走 stderr。
// 判定内核（门限 / 三问 / 理由文案）在 hooks/risk-gate.mjs。

import { assess } from './risk-gate.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

async function main() {
  // stdin 异常挂起时的兜底自毁，避免每次工具调用都吃满 hook 进程超时
  const killer = setTimeout(() => process.exit(0), 14000);
  const raw = await readStdin();
  clearTimeout(killer);
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const verdict = await assess(input.tool_name, input.tool_input);
  if (!verdict) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision, // 'deny' | 'ask'
      permissionDecisionReason: verdict.reason,
    },
  });
}

main()
  .then((out) => {
    if (!out || process.stdout.write(out)) process.exit(0);
    process.stdout.once('drain', () => process.exit(0));
  })
  .catch((e) => {
    process.stderr.write(`[systemone-decision hook] 风险闸跳过：${e && e.message ? e.message : e}\n`);
    process.exit(0);
  });
