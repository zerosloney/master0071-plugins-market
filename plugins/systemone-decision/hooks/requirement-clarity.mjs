#!/usr/bin/env node
// requirement-clarity.mjs — UserPromptSubmit hook：SystemOne 需求明确度预检（Claude 式清单宿主共用）。
// 契约：stdin = hook JSON（取 prompt 字段）；stdout 仅在判定"需求不明确"时输出一条
// hookSpecificOutput.additionalContext 注入上下文，其余一律静默 exit 0（fail-open）——
// 无 Key、寒暄捷径、网络失败都不阻塞用户输入，诊断走 stderr。
// 判定内核（门限 / 三问 / 结论文案）在 hooks/clarity.mjs。本文件只负责 stdin/stdout
// 协议；插件根目录变量 ${CLAUDE_PLUGIN_ROOT} 由 hooks.json 清单展开，不在代码里区分。

import { precheck } from './clarity.mjs';

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
  // stdin 异常挂起时的兜底自毁，避免每次输入都吃满 hook 进程超时
  const killer = setTimeout(() => process.exit(0), 14000);
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const additionalContext = await precheck(input.prompt);
  if (!additionalContext) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  });
}

main()
  .then((out) => {
    if (!out || process.stdout.write(out)) process.exit(0);
    process.stdout.once('drain', () => process.exit(0));
  })
  .catch((e) => {
    process.stderr.write(`[systemone-decision hook] 预检跳过：${e && e.message ? e.message : e}\n`);
    process.exit(0);
  });
