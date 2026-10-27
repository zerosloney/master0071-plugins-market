#!/usr/bin/env node
// check-loop-rev-outside.test.mjs — --rev 在仓库外 / 不带 --rev 的行为
// 2026-10-23 全量套件优化：从 rev-hook 拆出，与 hook / tree 两片并行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, loop, outOf } from './check-loop-rev-fixture.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).slice(0, 800)}` : ''}`); }
};

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-outside-'));
try {
  const absent = 'a'.repeat(40);
  const outsideRev = loop(outside, ['--rev', absent]);
  check('仓库外 --rev：exit 1 并打印 sha', outsideRev.status === 1 && outOf(outsideRev).includes(absent), outOf(outsideRev));
  const outsidePlain = loop(outside, []);
  check('仓库外且不带 --rev：仍跳过且退出 0', outsidePlain.status === 0 && outOf(outsidePlain).includes('跳过扫描'), outOf(outsidePlain));
} finally {
  cleanup(outside);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
