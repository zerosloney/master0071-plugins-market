#!/usr/bin/env node
// failure-attribution.test.mjs — 失败归因纯函数套件（2026-10-22 gate-health）
// 断言：env（缺依赖/缺二进制/网络）优先；flaky（共享库死锁/句柄争用）次之；其余 real。
import { classifyFailure } from '../scripts/failure-attribution.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

check('env：NU1100 还原失败', classifyFailure('error NU1100: 无法解析 BCrypt.Net-Next') === 'env');
check('env：eslint 未安装', classifyFailure('eslint: not found') === 'env');
check('env：gitleaks 未安装', classifyFailure('gitleaks 未安装（loud-skip）') === 'env');
check('env：node_modules 缺失', classifyFailure('Cannot find module vue-tsc') === 'env');
check('flaky：SQL 1205 死锁', classifyFailure('SqlException 1205 事务被选作死锁牺牲品') === 'flaky');
check('flaky：rm syscall 争用', classifyFailure('Error: ENOENT: no such file or directory, rm ... syscall: rm') === 'flaky');
check('flaky：Execution Timeout', classifyFailure('Execution Timeout Expired. The timeout period elapsed') === 'flaky');
check('real：断言失败', classifyFailure('Assert.Equal() Failure: Values differ') === 'real');
check('real：栈含 node_modules 但非缺件（不误判 env）',
  classifyFailure('at foo (C:\\repo\\node_modules\\lib\\x.js:1:1)\nAssert.Equal() Failure') === 'real');
check('real：空输出', classifyFailure('') === 'real');
check('env 优先于 flaky（同时命中取 env）', classifyFailure('NU1100 ... Msg 1205') === 'env');

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
