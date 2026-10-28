#!/usr/bin/env node
// check-ledger-doc-presence — 台账指针存在性（ledger-doc-presence 2026-10-24）
// 动机：删除 plan/spec/incident 而不走 confirm-doc --to cancelled/superseded 时，台账行会悬空
//   （实证：2026-10-21 po-create-form 两个 L1 plan 被 git rm，台账 approved/done 行指向不存在的文件，
//   而唯一能判它的 check-ledger-invariant 是全史扫描 ~90s、本地默认跳过，悬空持续数日无人见）。
// 本门只做终树行级存在性检查（约 500 次 existsSync，<100ms），挂 verify 引擎段——删除动作下一次
// 验证即被拦。判据与 check-ledger-invariant 行级④同口径：doc 匹配四目录，活跃路径未命中再探
// workflow/archive/*/（归档是容量治理，不是失效）。
// 用法：node <插件根>/scripts/check-ledger-doc-presence.mjs [--root <仓库根>] [--staged]
//   --staged：除磁盘检查外，把**本次暂存删除**的四目录文档也视为缺失（pre-commit 用）——堵住
//   `git rm --cached` 形态：文件仍在磁盘、提交后却消失，纯磁盘判据会漏（2026-10-24 复核 m5）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllConfirmations } from './ledger-loader.mjs';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
const ROOT = argOf('--root') || execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const TERMINAL = new Set(['approved', 'done', 'fixed', 'closed', 'superseded', 'cancelled']);
const DOC_RE = /^workflow\/(intents|specs|plans|incidents)\/([^/]+\.md)$/;
const ARCHIVE = path.join(ROOT, 'workflow', 'archive');

// --staged：本次暂存删除的四目录文档也算「已消失」（git rm --cached 时磁盘仍有文件）
const stagedDeleted = new Set();
if (argv.includes('--staged')) {
  try {
    const out = execFileSync('git', [
      '-c', 'core.quotepath=off', 'diff', '--cached', '--name-status', '--diff-filter=D', '--',
      'workflow/intents', 'workflow/specs', 'workflow/plans', 'workflow/incidents',
    ], { cwd: ROOT, encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const rel = line.split('\t').pop();
      if (rel && DOC_RE.test(rel)) stagedDeleted.add(rel);
    }
  } catch { /* 非 git 环境：退化为纯磁盘判据 */ }
}

const exists = (rel) => {
  if (!stagedDeleted.has(rel) && fs.existsSync(path.join(ROOT, rel))) return true;
  const m = DOC_RE.exec(rel);
  if (!m || !fs.existsSync(ARCHIVE)) return false;
  for (const month of fs.readdirSync(ARCHIVE)) {
    if (fs.existsSync(path.join(ARCHIVE, month, m[1], m[2]))) return true;
  }
  return false;
};

const ledger = loadAllConfirmations(ROOT);
const missing = new Map();
for (const e of ledger) {
  if (!e || !e.doc || !TERMINAL.has(e.stage)) continue;
  if (!DOC_RE.test(e.doc) || exists(e.doc)) continue;
  missing.set(e.doc, (missing.get(e.doc) || 0) + 1);
}

if (missing.size) {
  console.error('台账指针存在性 — HARD-BLOCK:');
  for (const [rel, n] of missing) {
    console.error(`- [台账悬空] ${rel} 被台账引用 ${n} 行，但活跃与归档均不存在${stagedDeleted.has(rel) ? '（本次暂存删除）' : ''}——删除文档必须走 confirm-doc --to cancelled/superseded（禁直接 git rm）`);
  }
  console.error('\n修复：恢复被删文档并按放弃流程置态（confirm-doc --to cancelled|superseded），或按 ledger-prune-manifest 流程特许修剪。');
  process.exit(1);
}
console.log(`[ledger-doc-presence] ✅ 台账指针全部可解析（${ledger.length} 行）`);
