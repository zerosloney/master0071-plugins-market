#!/usr/bin/env node
// check-loop-rev-ledger.test.mjs — --rev 的委派台账 / 验证凭证回退场景
// 2026-10-23 全量套件优化：从 check-loop-rev.test.mjs 拆出，与 rev 语义 / hook+tree 并行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, loop, outOf, gitRun, ENUMS, plan } from './check-loop-rev-fixture.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).slice(0, 800)}` : ''}`); }
};

// 委派表随 ROOT 读：--rev 看不到工作区后补的行。
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-del-'));
  try {
    gitRun(repo, ['init', '-q']);
    fs.mkdirSync(path.join(repo, '.agents', 'config'), { recursive: true });
    fs.copyFileSync(ENUMS, path.join(repo, '.agents', 'config', 'workflow-enums.txt'));
    for (const sub of ['intents', 'specs', 'plans']) fs.mkdirSync(path.join(repo, 'workflow', sub), { recursive: true });
    const name = '2026-09-12-gap.md';
    fs.writeFileSync(path.join(repo, 'workflow', 'intents', name), `---
状态: done
级别: L2
日期: 2026-09-12
---
# INTENT — gap

## 验收标准（可测试）

- [x] 用例通过（证据:fixture）
`);
    fs.writeFileSync(path.join(repo, 'workflow', 'specs', name), `---
状态: approved
级别: L2
日期: 2026-09-12
---
# SPEC — gap
`);
    fs.writeFileSync(path.join(repo, 'workflow', 'plans', name), `---
状态: approved
级别: L2
日期: 2026-09-12
---
# PLAN — gap
`);
    gitRun(repo, ['add', '--', '.']);
    gitRun(repo, ['commit', '-q', '-m', 'gap']);
    const sha = gitRun(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'workflow', 'delegations.md'), `## 委派结果

| 日期 | 被委派方 | 任务一句话 | 结果 | 备注 |
|------|----------|------------|------|------|
| 2026-09-12 | x | y | 一次通过 | ${name} |
`);
    const atOld = loop(repo, ['--rev', sha, '--all']);
    check('委派行只在工作区：--rev --all 旧提交仍输出委派台账',
      outOf(atOld).includes('委派台账') && outOf(atOld).includes(`intents/${name}`),
      outOf(atOld));
    const dirty = loop(repo, ['--all']);
    check('同一工作区 --all：后补的委派行消掉警告',
      dirty.status === 0 && !outOf(dirty).includes('委派台账'),
      outOf(dirty));
  } catch (e) {
    check('委派 --rev 仓库准备', false, e.stack || e.message);
  } finally {
    cleanup(repo);
  }
}

// --rev 临时工作树不含未跟踪的 verifications.jsonl。凭证是本机事实：
// 只在被查的树里没有这份文件时回退主工作区；树上已有文件仍以树为准。非 --rev 不回退。
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-verify-'));
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-verify-iso-'));
  const seed = (dir) => {
    gitRun(dir, ['init', '-q']);
    fs.mkdirSync(path.join(dir, '.agents', 'config'), { recursive: true });
    fs.copyFileSync(ENUMS, path.join(dir, '.agents', 'config', 'workflow-enums.txt'));
    // v5 起才有 verifySince；缺这份文件时对账整体跳过，夹具会假绿。
    fs.writeFileSync(path.join(dir, '.agents', 'config', 'engine.json'), '{"policyVersion":5}\n');
    for (const sub of ['intents', 'plans']) fs.mkdirSync(path.join(dir, 'workflow', sub), { recursive: true });
    const name = '2026-10-14-green.md';
    // 日期写在确认门生效日之前，检查 15 走存量豁免；git 加入日用 --date 钉在 verifySince 之后。
    fs.writeFileSync(path.join(dir, 'workflow', 'intents', name), `---
状态: done
级别: L1
日期: 2026-09-01
模块: pipeline
---
# INTENT — green

## 验收标准（可测试）

- [x] 用例通过（证据:测试全绿）
`);
    fs.writeFileSync(path.join(dir, 'workflow', 'plans', name), plan);
    gitRun(dir, ['add', '--', '.']);
    gitRun(dir, ['commit', '-q', '-m', 'green', '--date', '2026-10-14T08:00:00']);
    return gitRun(dir, ['rev-parse', 'HEAD']);
  };
  try {
    const sha = seed(repo);
    const ledger = path.join(repo, '.agents', 'verifications.jsonl');
    const freshLine = () => `${JSON.stringify({ ts: new Date().toISOString(), exitCode: 0, suite: 'npm test' })}\n`;
    const missing = loop(repo, ['--rev', sha]);
    check('--rev 树与主工作区都无凭证：报测试绿缺凭证',
      missing.status === 0 && outOf(missing).includes('测试绿缺凭证'), outOf(missing));

    fs.writeFileSync(ledger, freshLine());
    const backed = loop(repo, ['--rev', sha]);
    check('--rev 树上无凭证、主工作区有 24h 绿行：不报测试绿缺凭证',
      backed.status === 0 && !outOf(backed).includes('测试绿缺凭证') && outOf(backed).includes('证据豁免 verify'),
      outOf(backed));

    fs.writeFileSync(ledger, `${JSON.stringify({ ts: new Date().toISOString(), exitCode: 0, testCmd: true })}\n`);
    const fixtureRow = loop(repo, ['--rev', sha]);
    check('--rev 回退行若只是 testCmd：仍报测试绿缺凭证',
      fixtureRow.status === 0 && outOf(fixtureRow).includes('测试绿缺凭证'), outOf(fixtureRow));

    fs.writeFileSync(ledger, `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', exitCode: 0 })}\n`);
    gitRun(repo, ['add', '--', '.agents/verifications.jsonl']);
    gitRun(repo, ['commit', '-q', '-m', 'stale-ledger', '--date', '2026-10-14T09:00:00']);
    const staleSha = gitRun(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(ledger, freshLine());
    const treeWins = loop(repo, ['--rev', staleSha]);
    check('--rev 提交树里已有过期凭证：不改读主工作区的新绿行',
      treeWins.status === 0 && outOf(treeWins).includes('测试绿缺凭证'), outOf(treeWins));

    seed(isolated);
    const cross = loop(isolated, [], { CHECK_LOOP_ROOT: isolated });
    check('CHECK_LOOP_ROOT 无凭证：不回退其它工作区的绿行',
      cross.status === 0 && outOf(cross).includes('测试绿缺凭证'), outOf(cross));
  } catch (e) {
    check('凭证回退 --rev 仓库准备', false, e.stack || e.message);
  } finally {
    cleanup(repo);
    cleanup(isolated);
  }
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
