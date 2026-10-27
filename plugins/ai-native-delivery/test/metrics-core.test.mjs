// metrics-core.test.mjs — 指标口径共享内核：周期 / 中位渲染 / 闭环漏斗 / 复核效果台账
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cycleDays, fmtMedianDays, funnelFromLedger, scanReviews, calendarMonthsBetween, FUNNEL_LEGACY_RATIO_LIMIT } from '../scripts/metrics-core.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// ---- cycleDays ----
check('S1 正常周期 2.5 天', cycleDays('2026-10-01T00:00:00Z', '2026-10-03T12:00:00Z') === 2.5);
check('S2 缺任一端点返回 null', cycleDays(null, '2026-10-03T00:00:00Z') === null && cycleDays('2026-10-01T00:00:00Z', '') === null);
check('S3 负周期返回 null', cycleDays('2026-10-03T00:00:00Z', '2026-10-01T00:00:00Z') === null);
check('S4 非法时间返回 null', cycleDays('not-a-date', '2026-10-01T00:00:00Z') === null);

// ---- calendarMonthsBetween / 漏斗阈值单源 ----
check('S4a 漏斗阈值单源为 0.30', FUNNEL_LEGACY_RATIO_LIMIT === 0.30);
check('S4b 满 6 个日历月', calendarMonthsBetween('2026-01-15T00:00:00Z', '2026-07-15T00:00:00Z') === 6);
check('S4c 差一天不满 6 月', calendarMonthsBetween('2026-01-15T00:00:00Z', '2026-07-14T00:00:00Z') === 5);
check('S4d 未来按 0 / 非法输入 null', calendarMonthsBetween('2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z') === 0
  && calendarMonthsBetween('bad', '2026-10-01T00:00:00Z') === null);

// ---- fmtMedianDays ----
check('S5 null 写 —', fmtMedianDays(null) === '—');
check('S6 真零写 0.0', fmtMedianDays(0) === '0.0');
check('S7 极小非零写 <0.1', fmtMedianDays(0.04) === '<0.1');
check('S8 常规值一位小数', fmtMedianDays(2.66) === '2.7', fmtMedianDays(2.66));

// ---- funnelFromLedger ----
{
  const month = '2026-10';
  const entries = [
    { doc: 'workflow/intents/a.md', stage: 'approved', ts: '2026-10-01T00:00:00Z' },
    { doc: 'workflow/intents/a.md', stage: 'done', ts: '2026-10-02T00:00:00Z' },
    { doc: 'workflow/intents/b.md', stage: 'done', ts: '2026-10-03T00:00:00Z' },
    { doc: 'workflow/intents/c.md', stage: 'approved', ts: '2026-10-04T00:00:00Z' },
    { doc: 'workflow/intents/c.md', stage: 'approved', ts: '2026-10-04T01:00:00Z' },
    { doc: 'workflow/intents/c.md', stage: 'done', ts: '2026-10-05T00:00:00Z' },
    { doc: 'workflow/intents/d.md', stage: 'approved', ts: '2026-10-06T00:00:00Z' },
    { doc: 'workflow/intents/d.md', stage: 'revert-approved', ts: '2026-10-06T01:00:00Z' },
    { doc: 'workflow/intents/d.md', stage: 'approved', ts: '2026-10-06T02:00:00Z' },
    { doc: 'workflow/intents/d.md', stage: 'done', ts: '2026-10-07T00:00:00Z' },
    { doc: 'workflow/incidents/e.md', stage: 'fixed', ts: '2026-10-08T00:00:00Z' },
    { doc: 'workflow/incidents/e.md', stage: 'closed', ts: '2026-10-09T00:00:00Z' },
    { doc: 'workflow/intents/f.md', stage: 'approved', ts: '2026-09-30T00:00:00Z' },
    { doc: 'workflow/intents/f.md', stage: 'done', ts: '2026-11-01T00:00:00Z' },
    { doc: 'workflow/intents/g.md', stage: 'approved', ts: '2026-10-10T00:00:00Z' },
  ];
  const firstAdded = new Map([['workflow/intents/a.md', '2026-10-01T00:00:00Z']]);
  const r = funnelFromLedger(entries, month, firstAdded);
  check('S9 收口件数 = 5（未终态与跨月不计）', r.closed === 5, r.closed);
  check('S10 完整链 4 / 协议前 1', r.full === 4 && r.legacy === 1, JSON.stringify(r));
  check('S11 一次通过 2（a、e）/ 返工 2（c、d）', r.once === 2 && r.rework === 2, JSON.stringify(r));
  check('S12 台账行数按 ts 月份计 = 13', r.ledgerRows === 13, r.ledgerRows);
  check('S13 incident 按 fixed 判确认链（e 归一次通过）', r.items.some((i) => i.doc.endsWith('incidents/e.md') && i.kind === 'once'));
  check('S14 周期仅对可取首加日的件计算', r.days.length === 1 && r.days[0] === 1, JSON.stringify(r.days));
}

// ---- scanReviews ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-core-test-'));
  try {
    const dir = path.join(tmp, 'reviews.d');
    fs.mkdirSync(dir, { recursive: true });
    const header = [
      '# 独立复核效果台账 — 2026-10',
      '',
      '| 日期 | 对象 | 复核员(宿主) | 意见数 | 采纳 | 拒绝 | 误报 | 备注 |',
      '|---|---|---|---|---|---|---|---|',
    ];
    fs.writeFileSync(path.join(dir, '2026-10.md'), [
      ...header,
      '| 2026-10-16 | diff a | X | 3 | 2 | 1 | 0 | ok |',
      '| 2026-10-17 | diff b | Y | 4 | 1 | 2 | 1 | ok |',
      '',
    ].join('\n'), 'utf8');

    const agg = scanReviews(tmp);
    check('S15 复核台账按事件与意见数聚合', agg['2026-10'] && agg['2026-10'].events === 2 && agg['2026-10'].total === 7
      && agg['2026-10'].adopted === 3 && agg['2026-10'].rejected === 3 && agg['2026-10'].misreport === 1,
      JSON.stringify(agg));

    fs.writeFileSync(path.join(dir, '2026-10.md'), [...header, '| 2026-10-16 | diff a | X | 3 | x | 1 | 0 | bad |', ''].join('\n'), 'utf8');
    let badField = null;
    try { scanReviews(tmp); } catch (e) { badField = e; }
    check('S16 非整数字段 fail-loud', Boolean(badField) && /字段非法/.test(badField.message), badField && badField.message);

    fs.writeFileSync(path.join(dir, '2026-10.md'), [...header, '| 2026-10-16 | diff a | X | 3 | 1 | 1 | 0 | bad |', ''].join('\n'), 'utf8');
    let inconsistent = null;
    try { scanReviews(tmp); } catch (e) { inconsistent = e; }
    check('S17 采纳+拒绝+误报≠意见数 fail-loud', Boolean(inconsistent) && /自洽破坏/.test(inconsistent.message), inconsistent && inconsistent.message);

    check('S18 reviews.d 缺失返回空对象', JSON.stringify(scanReviews(path.join(tmp, 'no-such-workflow'))) === '{}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
