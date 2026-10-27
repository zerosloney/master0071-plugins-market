#!/usr/bin/env node
// --rev 扫的是该提交的树，不是当前工作区。pre-push 把 stdin 里的本地 sha 传进去。
// 2026-10-23 全量套件优化：原单文件拆三片并行（rev 语义 / hook+tree / ledger 回退），共享 fixture。
import fs from 'node:fs';
import path from 'node:path';
import { mkRepo, cleanup, loop, outOf, gitRun, Z, plan, planBad } from './check-loop-rev-fixture.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).slice(0, 800)}` : ''}`); }
};

const { root, good, bad, tip, planPath } = mkRepo();
try {
  const atGood = loop(root, ['--rev', good]);
  check('好提交：工作区稍后改断也不影响，--rev 退出 0', atGood.status === 0, outOf(atGood));
  const atBad = loop(root, ['--rev', bad]);
  check('断档提交：--rev 退出 1', atBad.status === 1 && outOf(atBad).includes('红线判低'), outOf(atBad));
  const atTip = loop(root, ['--rev', tip]);
  check('当前 HEAD 不是判定对象：--rev tip 退出 0', atTip.status === 0, outOf(atTip));

  fs.writeFileSync(planPath, planBad);
  const dirty = loop(root, []);
  check('不带 --rev：工作区违规文档仍 hard-block', dirty.status === 1 && outOf(dirty).includes('红线判低'), outOf(dirty));
  const dirtyRev = loop(root, ['--rev', tip]);
  check('同一脏工作区：--rev tip 仍退出 0', dirtyRev.status === 0, outOf(dirtyRev));

  const zeros = loop(root, ['--rev', Z]);
  check('--rev 全 0 exit 1 并打印 sha', zeros.status === 1 && outOf(zeros).includes(Z), outOf(zeros));
  const bogus = 'a'.repeat(40);
  const peeled = loop(root, ['--rev', bogus]);
  check('--rev 剥不到提交 exit 1 并打印 sha', peeled.status === 1 && outOf(peeled).includes(bogus), outOf(peeled));

  gitRun(root, ['tag', '-a', 'vbad', '-m', 't', bad]);
  const tag = gitRun(root, ['rev-parse', 'vbad']);
  const viaTag = loop(root, ['--rev', tag]);
  check('附注标签剥到提交后再读树', tag !== bad && viaTag.status === 1 && outOf(viaTag).includes('红线判低'), outOf(viaTag));

  const both = loop(root, ['--rev', tip], { CHECK_LOOP_ROOT: root });
  check('CHECK_LOOP_ROOT 与 --rev 同时出现 exit 1', both.status === 1 && outOf(both).includes('不能同时使用'), outOf(both));

  fs.writeFileSync(planPath, plan);
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-09-02-extra.md'), planBad.replace('2026-09-01', '2026-09-02').replace('# PLAN — bad', '# PLAN — extra'));
  gitRun(root, ['add', '--', '.']);
  gitRun(root, ['commit', '-q', '-m', 'extra']);
  const extra = gitRun(root, ['rev-parse', 'HEAD']);
  fs.rmSync(path.join(root, 'workflow', 'plans', '2026-09-02-extra.md'));
  gitRun(root, ['add', '--', '.']);
  gitRun(root, ['commit', '-q', '-m', 'drop-extra']);
  const atExtra = loop(root, ['--rev', extra]);
  check('断档文件不在当前 HEAD：--rev 仍退出 1', atExtra.status === 1 && outOf(atExtra).includes('2026-09-02-extra.md'), outOf(atExtra));
  const headNow = loop(root, []);
  check('当前 HEAD 没有该断档文件：不带 --rev 不点名它', headNow.status === 0 && !outOf(headNow).includes('2026-09-02-extra.md'), outOf(headNow));
} catch (e) {
  check('仓库准备', false, e.stack || e.message);
} finally {
  cleanup(root);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
