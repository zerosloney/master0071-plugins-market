#!/usr/bin/env node
// check-ledger-doc-presence.test.mjs — 台账指针存在性门（2026-10-24）
// 判据：① 台账终态行指向的 doc 不存在 → exit 1 + 点名；② 活跃文件存在 → 放行；
//       ③ 归档同路径存在 → 放行（归档感知）；④ 非四目录 doc → 忽略（不误报历史杂行）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 插件化落位（2026-10-27 迁移）：被测脚本在 ../scripts/（原与测试同目录的源仓形态）
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-ledger-doc-presence.mjs');
let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const mkRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ldp-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'),
    JSON.stringify({ ts: '2026-10-24T00:00:00.000Z', doc: 'workflow/plans/x.md', stage: 'done', fingerprint: 'a'.repeat(64) }) + '\n');
  return root;
};
const run = (root) => spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });
const write = (root, rel) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), '# doc\n');
};

{
  const root = mkRoot();
  const r = run(root);
  check('缺文档 → exit 1 且点名台账悬空', r.status === 1 && r.stderr.includes('台账悬空') && r.stderr.includes('workflow/plans/x.md'), r.stderr);
  write(root, 'workflow/plans/x.md');
  const r2 = run(root);
  check('活跃文件存在 → exit 0', r2.status === 0, r2.stderr);
  fs.rmSync(path.join(root, 'workflow', 'plans', 'x.md'));
  write(root, 'workflow/archive/2026-10/plans/x.md');
  const r3 = run(root);
  check('归档同路径存在 → exit 0（归档感知）', r3.status === 0, r3.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ldp-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'),
    JSON.stringify({ ts: '2026-10-24T00:00:00.000Z', doc: 'legacy-note', stage: 'approved', fingerprint: 'b'.repeat(64) }) + '\n');
  const r = run(root);
  check('非四目录 doc → 忽略（exit 0，不误报）', r.status === 0, r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// --staged（2026-10-24 复核 m5）：git rm --cached 后文件仍在磁盘，纯磁盘判据会漏——暂存删除须视为缺失
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ldp-git-'));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'),
    JSON.stringify({ ts: '2026-10-24T00:00:00.000Z', doc: 'workflow/plans/y.md', stage: 'done', fingerprint: 'c'.repeat(64) }) + '\n');
  write(root, 'workflow/plans/y.md');
  g('add', '-A');
  g('commit', '-qm', 'seed');
  const ok = spawnSync(process.execPath, [CLI, '--root', root, '--staged'], { encoding: 'utf8' });
  check('--staged：无暂存删除 → exit 0', ok.status === 0, ok.stderr);
  g('rm', '--cached', '-q', 'workflow/plans/y.md');
  const bad = spawnSync(process.execPath, [CLI, '--root', root, '--staged'], { encoding: 'utf8' });
  check('--staged：git rm --cached（磁盘仍在）→ exit 1 且标注暂存删除',
    bad.status === 1 && bad.stderr.includes('本次暂存删除'), bad.stderr);
  const plain = spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });
  check('无 --staged 时纯磁盘判据仍放行（对照，证明该缺口只由 --staged 堵）', plain.status === 0, plain.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
