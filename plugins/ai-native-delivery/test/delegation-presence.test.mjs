// delegation-presence.test.mjs — 委派台账行解析与在场判定单测（2026-10-25 优化4）
// 单元面：节边界（只认委派结果/自做任务结果两节）、表头/分隔行排除、日期首列、rowCovers 判据。
// 端到端（CLI 关单拦截/放行/修复族豁免）在 confirm-doc.test.mjs S29b-S29d；检查 18 侧由 check-loop.test 覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDelegationRows, rowCovers, delegationRowsOf } from '../scripts/delegation-presence.mjs';

let pass = 0, fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n       ${detail}` : ''}`); }
};

const MD = [
  '# 台账头部说明（非数据）',
  '## 委派结果',
  '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
  '|------|----------------|------------|------|------|----------|',
  '| 2026-10-01 | glm-worker | 实现 2026-09-30-x | 一次通过 | - |  |',
  '## 自做任务结果',
  '| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |',
  '|------|------------|------|------|----------|',
  '| 2026-10-02 | 自做 2026-10-01-y.md 关单 | 返工×1 | - | 需求歧义 |',
  '## 月度聚合快照',
  '| 月份 | 有效任务 |',
  '|------|----------|',
  '| 2026-10 | 2 |',
].join('\n');

{
  const rows = parseDelegationRows(MD);
  check('S1 解析：两节共 2 行，快照表/表头/分隔行不入',
    rows.length === 2 && rows[0].date === '2026-10-01' && rows[1].date === '2026-10-02',
    JSON.stringify(rows));
  check('S2 rowCovers：日期 ≥ 文档日期且含文件名（带/不带 .md）→ 覆盖',
    rowCovers(rows, '2026-09-30-x.md', '2026-10-01') && rowCovers(rows, '2026-10-01-y', '2026-10-02'));
  check('S3 rowCovers：行日期早于文档日期 / 文件名不含 → 不覆盖',
    !rowCovers(rows, '2026-09-30-x.md', '2026-10-02') && !rowCovers(rows, '2026-10-01-zz.md', '2026-10-01'));
  check('S4 家族同名行同时覆盖 spec/plan（同名基名）',
    rowCovers(rows, '2026-10-01-y.md', '2026-10-02'));
  check('S5 空文本/undefined → 0 行不崩溃', parseDelegationRows('').length === 0 && parseDelegationRows(undefined).length === 0);
}
{
  // delegationRowsOf：主台账 ∪ 分片合并读（分片感知单源 ledger-shards）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-mod-'));
  fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'),
    '## 委派结果\n| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|----------------|------------|------|------|----------|\n| 2026-09-05 | w | 主表旧行 | 一次通过 | - |  |\n');
  fs.mkdirSync(path.join(root, 'workflow', 'delegations.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.d', '2026-10.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-10-20 | 自做 2026-10-20-q 关单 | 一次通过 | - |  |\n');
  const rows = delegationRowsOf(root);
  check('S6 delegationRowsOf：主表 ∪ 分片合并（2 行）且分片行可判在场',
    rows.length === 2 && rowCovers(rows, '2026-10-20-q.md', '2026-10-20'),
    JSON.stringify(rows.map((r) => r.date)));
  // 显式注入语义同 readDelegationsText：传「该根默认主台账路径」→ 仍走主表∪分片合并（防静默跳片）；
  // 传非默认路径（测试夹具另置文件）→ 只读该文件。
  const other = path.join(root, 'fixture-delegations.md');
  fs.writeFileSync(other, '## 委派结果\n| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|----------------|------------|------|------|----------|\n| 2026-08-01 | w | 另置文件行 | 一次通过 | - |  |\n');
  const onlyMain = delegationRowsOf(root, path.join(root, 'workflow', 'delegations.md'));
  const onlyOther = delegationRowsOf(root, other);
  check('S7 delegationRowsOf：默认主台账路径仍走合并（2 行）；非默认注入路径只读该文件',
    onlyMain.length === 2 && onlyOther.length === 1 && onlyOther[0].date === '2026-08-01',
    JSON.stringify({ main: onlyMain.length, other: onlyOther.length }));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
