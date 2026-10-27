#!/usr/bin/env node
// gen-verify-evidence.test.mjs — 验证凭证摘要生成器 fixture 套件（2026-10-09 P2-3）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPT_DIR, '..', 'scripts', 'gen-verify-evidence.mjs'); // 插件化落位（2026-10-27 迁移）

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};
const mkfix = (rows) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-evidence-test-'));
  fs.mkdirSync(path.join(d, '.agents'), { recursive: true });
  if (rows) fs.writeFileSync(path.join(d, '.agents', 'verifications.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return d;
};
const run = (root, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const GREEN = (headShort, ts, extra = {}) => ({ ts, exitCode: 0, suite: 'all-gates', gates: 14, passed: 664, failed: 0, headShort, ...extra });

// 场景 1：绿行渲染 + 同 SHA 去重取最新 + 失败行/无 SHA 行/坏行排除
{
  const d = mkfix([
    GREEN('abc1234', '2026-10-09T08:34:08Z'),
    GREEN('abc1234', '2026-10-09T09:14:44Z'), // 同 SHA 更新 ts → 只留此行
    GREEN('def5678', '2026-10-09T10:00:00Z', { runId: 'PIPE-1' }),
    { ts: '2026-10-09T11:00:00Z', exitCode: 1, suite: 'engine-tests', note: 'exit 1' }, // 失败行
    { ts: '2026-10-09T12:00:00Z', exitCode: 0, suite: 'all-gates', gates: 12 }, // 无 headShort（旧 schema）
    '{broken json', // 坏行
  ]);
  const r = run(d);
  const doc = fs.readFileSync(path.join(d, 'workflow', 'verify-evidence.md'), 'utf8');
  check('场景 1：只渲染绿行且同 SHA 取最新（abc1234 只出现一次且为 09:14）',
    r.code === 0 && (doc.match(/\| `abc1234`/g) || []).length === 1 && doc.includes('2026-10-09T09:14:44Z') && doc.includes('`def5678`') && doc.includes('PIPE-1') && !doc.includes('exit 1') && !doc.includes('broken'),
    doc);
  check('场景 1b：断言计数与门数列渲染', doc.includes('| 14 | PASS 664 / FAIL 0 |'), doc);
}
// 场景 2：无台账 → 空表骨架（新 clone 首跑）
{
  const d = mkfix(null);
  const r = run(d);
  const doc = fs.readFileSync(path.join(d, 'workflow', 'verify-evidence.md'), 'utf8');
  check('场景 2：无台账生成空表骨架', r.code === 0 && doc.includes('# 验证绿凭证摘要') && !doc.includes('`abc'), doc);
}
// 场景 3：--check 一致/漂移/再生成恢复
{
  const d = mkfix([GREEN('aaa1111', '2026-10-09T08:00:00Z')]);
  run(d);
  check('场景 3a：生成后 --check 一致', run(d, '--check').code === 0);
  fs.writeFileSync(path.join(d, '.agents', 'verifications.jsonl'), JSON.stringify(GREEN('bbb2222', '2026-10-09T09:00:00Z')) + '\n');
  const r2 = run(d, '--check');
  check('场景 3b：台账新增绿行 → --check 漂移 exit 1', r2.code === 1 && r2.out.includes('关单时跑'), r2.out);
  run(d);
  check('场景 3c：再生成后恢复一致', run(d, '--check').code === 0);
}

// 场景 4：追加保全——本地台账缺某 SHA 时，仓内既有行不被抹掉（2026-10-10 复核 S2）
{
  const d = mkfix([GREEN('aaa1111', '2026-10-09T08:00:00Z'), GREEN('ccc3333', '2026-10-09T09:00:00Z')]);
  run(d);
  const before = fs.readFileSync(path.join(d, 'workflow', 'verify-evidence.md'), 'utf8');
  // 换 worktree / 换机：本地台账被覆盖为只含 ddd4444
  fs.writeFileSync(path.join(d, '.agents', 'verifications.jsonl'), JSON.stringify(GREEN('ddd4444', '2026-10-09T10:00:00Z')) + '\n');
  const r = run(d);
  const doc = fs.readFileSync(path.join(d, 'workflow', 'verify-evidence.md'), 'utf8');
  check('场景 4：台账换机后仓内既有行保全（aaa1111/ccc3333 仍在，ddd4444 补入）',
    r.code === 0 && doc.includes('`aaa1111`') && doc.includes('`ccc3333`') && doc.includes('`ddd4444`') && before.includes('`aaa1111`'),
    doc);
  check('场景 4b：保全后 --check 一致（幂等）', run(d, '--check').code === 0);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
