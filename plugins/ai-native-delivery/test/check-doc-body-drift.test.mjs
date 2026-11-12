#!/usr/bin/env node
// check-doc-body-drift.test.mjs — 已关单正文漂移 advisory 的 fixture 测试（2026-11-11 判据移植配套）
// 注缝：临时 git 仓 + CHECK_DOC_DRIFT_ROOT / run(root)。git 只 add 不 commit（脚本恒查暂存面）。
// 断言：①终态 doc 改正文无台账 → advisory 且 exit 0（不合门）；②仅状态行变更不警；③同笔暂存
//      分片台账行（含 "doc" 键）豁免；④主台账行豁免；⑤draft 状态不在 advisory 面；⑥无文档面静默。
// 用法：node test/check-doc-body-drift.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/check-doc-body-drift.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-doc-body-drift.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${desc}`); }
  else { fail += 1; console.log(`FAIL  ${desc}\n${detail}`); }
};

const gitRaw = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const mkRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'confirmations.d'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), '', 'utf8');
  if (gitRaw(['init', '-q'], root).status !== 0) throw new Error('git init 失败');
  gitRaw(['config', 'core.autocrlf', 'false'], root);
  gitRaw(['config', 'user.email', 'test@example.com'], root);
  gitRaw(['config', 'user.name', 'test'], root);
  // 首个空提交：无 HEAD 时 git diff --cached 对空树展开全文件加行，仅状态行变更场景无法构造
  gitRaw(['commit', '-q', '--allow-empty', '-m', 'init'], root);
  return root;
};

const writeDoc = (root, name, status, body) => {
  fs.writeFileSync(path.join(root, 'workflow', 'intents', name),
    `---\n标题: 测试\n状态: ${status}\n---\n\n${body}\n`, 'utf8');
};

// 逐场景重建仓（暂存面互不污染）
const stage = (root) => gitRaw(['add', '-A'], root);

// ① 终态 doc 改正文、同笔无台账变更 → advisory + exit 0
{
  const root = mkRepo();
  writeDoc(root, 'a.md', 'done', '正文 v1');
  stage(root);
  fs.writeFileSync(path.join(root, 'workflow', 'intents', 'a.md'),
    `---\n标题: 测试\n状态: done\n---\n\n正文 v2 改了能力口径\n`, 'utf8');
  stage(root);
  const errs = [];
  const code = run(root);
  check('① 终态 doc 改正文无台账 → run() 恒 0（advisory 不合门）', code === 0, `code=${code}`);
  // stderr 面经脚本 CLI 实跑捕获（run() 直接 console.error，这里用子进程复跑取证）
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_DOC_DRIFT_ROOT: root } });
  check('① CLI 实跑 exit 0 且 stderr 含 advisory 明细（文件名 + 状态）',
    cli.status === 0 && /advisory\]\[doc-body-drift\]/.test(cli.stderr) && /workflow\/intents\/a\.md/.test(cli.stderr) && /done/.test(cli.stderr),
    `exit=${cli.status} stderr=${cli.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ② 仅「状态:」行变更（confirm-doc 自身流转）→ 不警（基线版须在 HEAD 里，diff 才是行级修改）
{
  const root = mkRepo();
  writeDoc(root, 'b.md', 'done', '正文 v1');
  stage(root);
  gitRaw(['commit', '-q', '-m', 'wip'], root);
  fs.writeFileSync(path.join(root, 'workflow', 'intents', 'b.md'),
    `---\n标题: 测试\n状态: superseded\n---\n\n正文 v1\n`, 'utf8');
  stage(root);
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_DOC_DRIFT_ROOT: root } });
  check('② 仅状态行变更 → 无 advisory（confirm-doc 流转面）', cli.status === 0 && !/doc-body-drift/.test(cli.stderr), `stderr=${cli.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 同笔暂存分片台账行（含 "doc" 键的重录行）→ 豁免不警
{
  const root = mkRepo();
  writeDoc(root, 'c.md', 'done', '正文 v1');
  stage(root);
  fs.writeFileSync(path.join(root, 'workflow', 'intents', 'c.md'),
    `---\n标题: 测试\n状态: done\n---\n\n正文 v2 改了能力口径\n`, 'utf8');
  fs.appendFileSync(path.join(root, '.agents', 'confirmations.d', 'c.jsonl'),
    JSON.stringify({ doc: 'workflow/intents/c.md', note: '重录' }) + '\n', 'utf8');
  stage(root);
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_DOC_DRIFT_ROOT: root } });
  check('③ 同笔分片重录行 → 无 advisory（对账口径成立）', cli.status === 0 && !/doc-body-drift/.test(cli.stderr), `stderr=${cli.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ④ 主台账混入本 doc 的行 → 豁免；他份 doc 的行 → 不豁免本份
{
  const root = mkRepo();
  writeDoc(root, 'd1.md', 'closed', '正文 v1');
  writeDoc(root, 'd2.md', 'closed', '正文 v1');
  stage(root);
  for (const n of ['d1', 'd2']) {
    fs.writeFileSync(path.join(root, 'workflow', 'intents', `${n}.md`),
      `---\n标题: 测试\n状态: closed\n---\n\n正文 v2 改了能力口径\n`, 'utf8');
  }
  fs.appendFileSync(path.join(root, '.agents', 'confirmations.jsonl'),
    JSON.stringify({ doc: 'workflow/intents/d1.md', note: '重录' }) + '\n'
    + JSON.stringify({ doc: 'workflow/intents/other.md', note: '他份' }) + '\n', 'utf8');
  stage(root);
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_DOC_DRIFT_ROOT: root } });
  check('④ 主台账行级判据：d1 豁免 / d2（他份行不豁免）仍 advisory',
    cli.status === 0 && /d1\.md/.test(cli.stderr) === false && /d2\.md（状态 closed）/.test(cli.stderr),
    `stderr=${cli.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑤ draft 状态不在 advisory 面；⑥ 无 workflow 文档面 → 静默 exit 0
{
  const root = mkRepo();
  writeDoc(root, 'e.md', 'draft', '正文 v1');
  stage(root);
  fs.writeFileSync(path.join(root, 'workflow', 'intents', 'e.md'),
    `---\n标题: 测试\n状态: draft\n---\n\n正文 v2 改了能力口径\n`, 'utf8');
  stage(root);
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_DOC_DRIFT_ROOT: root } });
  check('⑤ draft 状态改正文 → 无 advisory（非终态不在面内）', cli.status === 0 && !/doc-body-drift/.test(cli.stderr), `stderr=${cli.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkRepo();
  stage(root);
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CHECK_DOC_DRIFT_ROOT: root } });
  check('⑥ 暂存面无 workflow 文档 → 静默 exit 0', cli.status === 0 && !cli.stdout && !cli.stderr, `stdout=${cli.stdout} stderr=${cli.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
