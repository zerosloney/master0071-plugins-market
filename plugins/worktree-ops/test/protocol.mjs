#!/usr/bin/env node
// worktree-ops 协议层单测（白盒，直连 mcp/protocol.mjs 的 handle 导出）。
//
// 纯内存：reply / replyError 直接写 process.stdout，这里把 write 打桩成收集器，
// await handle 后解析回包；「放行到工具」的路径用临时替换 handler 的 spy 隔离，
// 全程不落盘、不起 server。
//
//   node test/protocol.mjs
//
// 退出码非 0 表示有断言失败。

import { handle } from '../mcp/protocol.mjs';
import { tools } from '../mcp/tools.mjs';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n${title}`);

// ---- 纯内存收包：handle 内部的 reply/replyError 直接写 stdout，打桩收集后按行解析。
const realWrite = process.stdout.write.bind(process.stdout);
async function rpc(message) {
  const lines = [];
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await handle(message);
  } finally {
    process.stdout.write = realWrite;
  }
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const call = (id, name, args) =>
  rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

// 临时把某工具的 handler 换成 spy：放行路径只验证「到达了工具、参数原样」，
// 不执行真实 handler（真实 handler 会读写配置与磁盘）。
async function withSpy(name, fn) {
  const tool = tools.find((t) => t.name === name);
  const real = tool.handler;
  const seen = [];
  tool.handler = (args) => {
    seen.push(args);
    return { content: [{ type: 'text', text: '__spy_ok__' }] };
  };
  try {
    await fn(seen);
  } finally {
    tool.handler = real;
  }
}

const CONFIG = 'worktree_config';

try {
  section('enum 约束：拼错的枚举值在协议层被点名拒绝');
  {
    const r = (await call(1, CONFIG, { action: 'bogus' }))[0];
    check(
      'action "bogus" 被协议层拒绝并点名合法集合',
      r && r.result?.isError && /invalid action/.test(r.result.content[0].text) && /expected one of/.test(r.result.content[0].text) && /get, set/.test(r.result.content[0].text),
      r && r.result?.content[0].text,
    );
    const s = (await call(2, CONFIG, { action: 'get', scope: 'bogus' }))[0];
    check(
      'scope "bogus" 被协议层拒绝并点名合法集合',
      s && s.result?.isError && /invalid scope/.test(s.result.content[0].text) && /global, repo/.test(s.result.content[0].text),
      s && s.result?.content[0].text,
    );
  }

  section('enum 约束：合法值放行到工具');
  await withSpy(CONFIG, async (seen) => {
    const args = { action: 'set', scope: 'repo', repoPath: 'E:/repo', root: 'E:/wt' };
    const r = (await call(3, CONFIG, args))[0];
    check(
      '合法 action/scope 到达工具且参数原样',
      r && !r.result?.isError && r.result?.content[0].text === '__spy_ok__' && seen.length === 1 && seen[0] === args,
      `seen=${seen.length}`,
    );
    // 空串在本仓是「未传」约定（工具内 stringArg("") 视同缺省），enum 校验同样放行
    const empty = (await call(4, CONFIG, { action: '' }))[0];
    check(
      '空串 action 按「未传」约定放行',
      empty && !empty.result?.isError && seen.length === 2,
      `seen=${seen.length}`,
    );
  });

  section('array 类型判定：若 schema 声明 type:"array"（当前无现役工具，钉住行为）');
  {
    const props = tools.find((t) => t.name === CONFIG).inputSchema.properties;
    props.__testArray__ = { type: 'array', description: 'test-only' };
    try {
      await withSpy(CONFIG, async (seen) => {
        const ok = (await call(5, CONFIG, { __testArray__: ['a', 'b'] }))[0];
        check('数组实参匹配 "array" 声明，放行到工具', ok && !ok.result?.isError && seen.length === 1, ok && JSON.stringify(ok.result));
        const str = (await call(6, CONFIG, { __testArray__: 'not-array' }))[0];
        check(
          '字符串实参按 "array" 声明被拒',
          str && str.result?.isError && /__testArray__: expected array, got string/.test(str.result.content[0].text),
          str && str.result?.content[0].text,
        );
        const obj = (await call(7, CONFIG, { __testArray__: { 0: 'a' } }))[0];
        check(
          '非数组对象不匹配 "array" 声明（typeof [] === "object" 不再误判）',
          obj && obj.result?.isError && /__testArray__: expected array, got object/.test(obj.result.content[0].text),
          obj && obj.result?.content[0].text,
        );
      });
    } finally {
      delete props.__testArray__;
    }
  }

  section('ping 语义：notification（无 id）不回包');
  {
    const notification = await rpc({ jsonrpc: '2.0', method: 'ping' });
    check('无 id 的 ping 不产生任何回包', notification.length === 0, JSON.stringify(notification));
    const r = (await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }))[0];
    check('有 id 的 ping 仍回 result', r && r.id === 7 && r.jsonrpc === '2.0' && r.result !== undefined && r.error === undefined, JSON.stringify(r));
  }

  section('unknown tool：回 JSON-RPC error（-32602，消息含工具名）');
  {
    const r = (await call(9, '__no_such_tool__', {}))[0];
    check(
      '未知工具回 error 对象（code -32602）且不回 result',
      r && r.jsonrpc === '2.0' && r.id === 9 && r.error && r.error.code === -32602 && /__no_such_tool__/.test(r.error.message) && !('result' in r),
      JSON.stringify(r),
    );
  }

  section('既有校验路径不回归');
  {
    const unknownKey = (await call(11, CONFIG, { action: 'get', forse: true }))[0];
    check(
      '未知参数仍被拒并点名',
      unknownKey && unknownKey.result?.isError && /unknown parameter/.test(unknownKey.result.content[0].text) && /forse/.test(unknownKey.result.content[0].text),
      unknownKey && unknownKey.result?.content[0].text,
    );
    const missing = (await call(12, 'worktree_status', {}))[0];
    check(
      '缺 required（name）仍被拒',
      missing && missing.result?.isError && /missing required parameter/.test(missing.result.content[0].text) && /name/.test(missing.result.content[0].text),
      missing && missing.result?.content[0].text,
    );
    const badType = (await call(13, CONFIG, { staleDays: 'abc' }))[0];
    check(
      '类型不匹配仍被拒并报实际类型',
      badType && badType.result?.isError && /invalid parameter type/.test(badType.result.content[0].text) && /staleDays: expected number, got string/.test(badType.result.content[0].text),
      badType && badType.result?.content[0].text,
    );
    await withSpy(CONFIG, async (seen) => {
      const lenient = (await call(14, CONFIG, { staleDays: '5' }))[0];
      check(
        '数字串仍按既有约定无损放行',
        lenient && !lenient.result?.isError && seen.length === 1,
        lenient && JSON.stringify(lenient.result),
      );
    });
  }
} catch (err) {
  failures += 1;
  console.error(`  ✗ 测试本体抛错（修复不完整或接线变化）: ${err && err.stack ? err.stack : err}`);
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
