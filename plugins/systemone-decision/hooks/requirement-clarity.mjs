#!/usr/bin/env node
// requirement-clarity.mjs — UserPromptSubmit hook：SystemOne 需求明确度预检（Claude 式清单宿主共用）。
// 契约：stdin = hook JSON（取 prompt 字段）；stdout 仅在判定"需求不明确"时输出一条
// hookSpecificOutput.additionalContext 注入上下文，其余一律静默 exit 0（fail-open）——
// 无 Key、寒暄捷径、网络失败、stdin 超限都不阻塞用户输入，诊断走 stderr。
// stdin/stdout 协议壳在 hooks/hook-io.mjs；判定内核（门限 / 三问 / 结论文案）在 hooks/clarity.mjs；
// 插件根目录变量 ${CLAUDE_PLUGIN_ROOT} 由 hooks.json 清单展开，不在代码里区分。

import { main } from './hook-io.mjs';
import { precheck } from './clarity.mjs';

main(async (input, timeoutMs, truncated) => {
  // stdin 超过 100K 上限：读到的输入不完整，无法判定也不假装判定——按既有失败路径
  // 静默放行（不发请求、不阻塞），诊断注明 input too large，stdout 契约不变。
  if (truncated) {
    process.stderr.write('[systemone-decision hook] 预检跳过：input too large（stdin 超过 100K 字符上限，已截断）\n');
    return null;
  }
  const additionalContext = await precheck(input.prompt, process.env, { timeoutMs });
  if (!additionalContext) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}, '预检跳过');
