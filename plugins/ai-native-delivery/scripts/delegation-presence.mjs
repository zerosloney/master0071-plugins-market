// delegation-presence.mjs — 委派台账行解析与在场判定单源（2026-10-25 优化4）
// 消费方：check-loop-kit.delegationResultRows（检查 18 事后对账）+ confirm-doc done 前置门
// （写入时拦截）——两个执法点共用同一套解析与判据，事后 WARN 与关单拦截不漂移。
// 解析语义与 kit 原内联实现逐字一致：`## 委派结果`/`## 自做任务结果` 节内、管道行、首列 YYYY-MM-DD。
// 测试：node <插件根>/test/delegation-presence.test.mjs（另由 check-loop.test / confirm-doc.test 端到端覆盖）
import { readDelegationsText } from './ledger-shards.mjs';

export function parseDelegationRows(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  const targetSec = (line) => /^##\s+(委派结果|自做任务结果)\s*$/.test(line);
  let inSec = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSec = targetSec(line);
      continue;
    }
    if (!inSec || !/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!cells.length || cells.every((c) => /^[-: ]*$/.test(c))) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) continue;
    rows.push({ date: cells[0], line });
  }
  return rows;
}

// rowCovers(rows, base, date)：在场判据——存在日期 ≥ 文档日期、且行内含文件名（带/不带 .md）的行。
// 与检查 18 原判据逐字一致（家族同名行同时覆盖 intent/spec/plan 三件）。
export function rowCovers(rows, base, date) {
  const stripped = base.replace(/\.md$/, '');
  return rows.some((r) => r.date >= date && (r.line.includes(base) || r.line.includes(stripped)));
}

// delegationRowsOf(root, file)：分片感知读（主台账 ∪ delegations.d/*.md）+ 解析。
// file 为显式注入路径时只读该文件（测试语义同 kit.delegationResultRows）。
export function delegationRowsOf(root, file = null) {
  return parseDelegationRows(readDelegationsText(root, file));
}
