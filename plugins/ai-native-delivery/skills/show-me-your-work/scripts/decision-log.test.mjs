#!/usr/bin/env node
// decision-log.test.mjs — 决策 TSV 追加器套件（2026-10-22 show-me-your-work）
// 覆盖：首用写表头 / 追加不重复表头 / tab 与换行清洗 / =+-@ 前缀转义 / 缺参 exit 2。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'decision-log.mjs');
let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};
const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-log-'));
const log = path.join(dir, 'decisions.tsv');

{
  const r = run([log, 'frame', 'counted the work first', 'size before starting', 'commit 3a9f1c2', 'found 5 things']);
  const text = fs.readFileSync(log, 'utf8');
  const rows = text.trim().split(/\r?\n/);
  check('T1 首用写表头 + 一行', r.code === 0 && rows.length === 2 && rows[0].startsWith('ts\tphase\tdecision'), text);
  check('T1 ts 为 ISO8601', /^\d{4}-\d{2}-\d{2}T/.test(rows[1].split('\t')[0]), rows[1]);
}
{
  const r = run([log, 'widget', 'moved styles', 'keep change small', 'commit 7c21e0a', 'pixel-diff 0']);
  const rows = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  check('T2 追加不重复表头（2 数据行）', r.code === 0 && rows.length === 3 && rows.filter((l) => l.startsWith('ts\t')).length === 1, rows.join('\n'));
}
{
  run([log, 'phase\twith\ttabs', 'decision\nwith\nnewlines', 'why', 'evidence', 'result']);
  const last = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).pop();
  check('T3 tab/换行清洗为单行单格', last.split('\t').length === 6 && !/[\r\n]/.test(last), last);
}
{
  run([log, 'phase', '=SUM(A1)', '+cmd', '-flag', '@ref']);
  const last = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).pop();
  const cells = last.split('\t');
  check('T4 = + - @ 前缀加单引号', cells[2] === "'=SUM(A1)" && cells[3] === "'+cmd" && cells[4] === "'-flag" && cells[5] === "'@ref", last);
}
{
  const r = run([log, 'phase']);
  check('T5 缺参 → exit 2', r.code === 2 && r.out.includes('用法'), JSON.stringify(r));
}
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
