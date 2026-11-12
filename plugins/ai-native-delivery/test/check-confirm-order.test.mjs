#!/usr/bin/env node
// check-confirm-order.test.mjs — 先确认后改代码顺序门（2026-11-12 L0/L1 快速道判据移植）
// L0 判定五态黑盒（tmp git 仓 spawn 真实 CLI）：① ≤5 产品文件 + 非空 L0 trailer → 放行；
// ② 超 L0_MAX 文件数 → 拒；③ 空判据行 → 拒（fail-closed）；④ 合并形态状态文件 → SKIP；
// ⑤ 导出面（coveringDocs / l0Judgement / l0JudgementFromText / isMergeLike / L0_MAX / isProductPath /
//   decide / collectStagedCoverage 经 CLI 间接）单测；另覆盖 approved 覆盖放行、豁免 B（同批 done plan）、
//   L0 放行落账（judgments 行 level=L0）。
// 零依赖，Node ≥ 18 直接运行：node test/check-confirm-order.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'check-confirm-order.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const NO_LEDGER = { ...process.env, CHECK_LOOP_NO_LEDGER: '1' };
delete NO_LEDGER.CHECK_LOOP_ROOT;

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-'));
  const g = (...a) => spawnSync(GIT, ['-c', 'core.quotepath=off', ...a], { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'README.md'), '# base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root, g };
};
const stage = (root, rel, body = '// p\n') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const run = (root, msgBody, env = NO_LEDGER) => {
  const msgFile = path.join(root, '.git', 'CCO_MSG');
  fs.writeFileSync(msgFile, msgBody);
  return spawnSync(process.execPath, [CLI, msgFile], { cwd: root, encoding: 'utf8', env });
};

// ---- ① ≤5 产品文件 + 非空 L0 trailer → 放行（豁免 A） ----
{
  const { root, g } = mkRepo();
  for (const f of ['backend/a.cs', 'frontend/src/b.vue', 'tests/c.cs']) stage(root, f);
  g('add', '-A');
  const r = run(root, 'feat: 小修\n\nL0: 修文案错字\n');
  check('① 3 产品件 + 非空 L0 trailer → exit 0 放行', r.status === 0 && r.stdout.includes('放行（豁免 A · L0 极简道）') && r.stdout.includes('「修文案错字」'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② 超 L0_MAX（6 件）→ 拒（BLOCK，附 L0 指引） ----
{
  const { root, g } = mkRepo();
  for (let i = 1; i <= 6; i++) stage(root, `backend/f${i}.cs`);
  g('add', '-A');
  const r = run(root, 'feat: 大改\n\nL0: 想蒙混过关\n');
  check('② 6 产品件 + L0 trailer → exit 1 BLOCK（超上限不豁免）', r.status === 1 && r.stderr.includes('BLOCK: 先确认后改代码') && r.stderr.includes('L0 极简道'), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 空判据行 → 拒（fail-closed：`L0:` 后无非空内容不构成豁免） ----
{
  const { root, g } = mkRepo();
  stage(root, 'backend/only.cs');
  g('add', '-A');
  const r1 = run(root, 'feat: x\n\nL0:\n');
  const r2 = run(root, 'feat: x\n\nL0:   \n');
  const r3 = run(root, 'feat: x\n'); // 无 L0 行
  check('③ `L0:` 空判据 / 纯空白 / 无该行 → 均 exit 1',
    r1.status === 1 && r2.status === 1 && r3.status === 1
    && r1.stdout.includes('BLOCK') === false, // BLOCK 走 stderr
    `exits=${r1.status}/${r2.status}/${r3.status}\n${r1.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ 合并形态 → SKIP（状态文件探测：MERGE_HEAD / SQUASH_MSG 均试） ----
{
  const { root, g } = mkRepo();
  stage(root, 'backend/m.cs');
  g('add', '-A');
  for (const state of ['MERGE_HEAD', 'SQUASH_MSG', 'CHERRY_PICK_HEAD']) {
    const rel = g('rev-parse', '--git-path', state).stdout.trim();
    fs.writeFileSync(path.resolve(root, rel), 'fixture\n');
    const r = run(root, 'feat: x\n');
    check(`④ 状态文件 ${state} 在场 → SKIP exit 0（收树不重判）`, r.status === 0 && r.stdout.includes('SKIP: 先确认后改代码'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
    fs.rmSync(path.resolve(root, rel), { force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ approved plan 覆盖放行 / done 历史 plan 不算 / 豁免 B（同批 done plan） ----
{
  const { root, g } = mkRepo();
  stage(root, 'workflow/plans/p.md', '---\n状态: approved\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — p\n\n## 改动方案\n- backend/covered.cs：改\n');
  stage(root, 'backend/covered.cs');
  g('add', '-A');
  const r = run(root, 'feat: covered\n');
  check('⑤a 路径在 approved plan 正文 → exit 0（豁免 A 不必触发）', r.status === 0 && r.stdout.includes('已写在 approved plan 里'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // done 历史 plan（HEAD 里已 done 且不在本批暂存）不算覆盖 → 无 L0 → BLOCK
  const { root, g } = mkRepo();
  stage(root, 'workflow/plans/p.md', '---\n状态: approved\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — p\n\n## 改动方案\n- backend/covered.cs：改\n- backend/covered2.cs：改\n');
  g('add', '-A');
  g('commit', '-qm', 'plan approved');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p.md'),
    fs.readFileSync(path.join(root, 'workflow', 'plans', 'p.md'), 'utf8').replace('状态: approved', '状态: done'));
  g('add', '-A');
  g('commit', '-qm', 'plan done');
  stage(root, 'backend/covered2.cs', '// p2\n');
  g('add', 'backend/covered2.cs'); // 只暂存产品件，done plan 不入本批
  const r2 = run(root, 'feat: y\n');
  check('⑤b done 历史 plan 不算覆盖 → exit 1', r2.status === 1, `exit=${r2.status}\n${r2.stdout}${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 豁免 B：done plan 与产品件同批暂存（均未入库）→ 放行（L1 单笔提交）
  const { root, g } = mkRepo();
  stage(root, 'workflow/plans/p.md', '---\n状态: approved\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — p\n\n## 改动方案\n- backend/covered.cs：改\n- backend/covered2.cs：改\n');
  g('add', '-A');
  g('commit', '-qm', 'plan approved');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p.md'),
    fs.readFileSync(path.join(root, 'workflow', 'plans', 'p.md'), 'utf8').replace('状态: approved', '状态: done'));
  stage(root, 'backend/covered2.cs', '// p2\n');
  g('add', '-A'); // done plan + 产品件同批暂存
  const r3 = run(root, 'feat: 单笔关单\n');
  check('⑤c 豁免 B：done plan 同批暂存 → exit 0', r3.status === 0 && r3.stdout.includes('已写在 approved plan 里'), `exit=${r3.status}\n${r3.stdout}${r3.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑥ L0 放行落账：judgments 行 mode=commit-msg / level=L0（不设 NO_LEDGER） ----
{
  const { root, g } = mkRepo();
  stage(root, 'backend/ledger.cs');
  g('add', '-A');
  const env = { ...process.env };
  delete env.CHECK_LOOP_ROOT;
  delete env.CHECK_LOOP_NO_LEDGER;
  const r = run(root, 'feat: z\n\nL0: 计数落账验证\n', env);
  const ledgerFile = path.join(root, '.agents', 'judgments.jsonl');
  let row = null;
  try {
    const lines = fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/).filter(Boolean);
    row = JSON.parse(lines[lines.length - 1]);
  } catch { /* 读不到 = 落账失败 */ }
  check('⑥ L0 放行落账：judgments 末行 rule=先确认后改代码 / level=L0 / mode=commit-msg / count=1',
    r.status === 0 && row && row.mode === 'commit-msg'
    && row.rules && row.rules[0].rule === '先确认后改代码' && row.rules[0].level === 'L0'
    && row.rules[0].count === 1 && row.rules[0].judgement === '计数落账验证',
    `exit=${r.status} row=${JSON.stringify(row)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ 导出面（下游 check-scope-range / check-commit-plan-ref 依赖） ----
{
  const mod = await import(pathToFileURL(CLI).href);
  check('⑦a L0_MAX=5（档二放宽单源）', mod.L0_MAX === 5);
  check('⑦b l0JudgementFromText：行首 L0: 取判据、非行首不认、空判据 null',
    mod.l0JudgementFromText('fix: t\n\nL0:  判据 abc \n') === '判据 abc'
    && mod.l0JudgementFromText('xL0: y') === null
    && mod.l0JudgementFromText('L0:') === null
    && mod.l0JudgementFromText('') === null
    && mod.l0JudgementFromText(null) === null, JSON.stringify({
      a: mod.l0JudgementFromText('fix: t\n\nL0:  判据 abc \n'),
      b: mod.l0JudgementFromText('xL0: y'),
      c: mod.l0JudgementFromText('L0:'),
    }));
  check('⑦c l0Judgement(msgFile)：目录/缺失文件读不出 → null（fail-closed）',
    mod.l0Judgement(os.tmpdir()) === null
    && mod.l0Judgement(path.join(os.tmpdir(), 'definitely-missing-cco-msg')) === null
    && mod.l0Judgement('') === null);
  {
    const { root } = mkRepo();
    const msgFile = path.join(root, 'MSG');
    fs.writeFileSync(msgFile, 'feat: t\n\nL0: 文件版判据\n');
    check('⑦c2 l0Judgement 实文件 → 取判据', mod.l0Judgement(msgFile) === '文件版判据');
    fs.rmSync(root, { recursive: true, force: true });
  }
  check('⑦d isProductPath：PRODUCT_FACES 单源（backend/tests/frontend 面；台账/README 不算）',
    mod.isProductPath('backend/a.cs') && mod.isProductPath('tests/t.cs')
    && mod.isProductPath('frontend/src/x.vue') && mod.isProductPath('frontend/x.ts')
    && !mod.isProductPath('README.md') && !mod.isProductPath('workflow/plans/p.md'));
  check('⑦e coveringDocs：approved 算 / done 同批算 / done 不同批不算 / draft 不算 / 无正文不算',
    JSON.stringify(mod.coveringDocs([
      { rel: 'p1.md', status: 'approved', text: 'x' },
      { rel: 'p2.md', status: 'done', text: 'x' },
      { rel: 'p3.md', status: 'draft', text: 'x' },
      { rel: 'p4.md', status: 'done', text: '' },
    ], new Set(['p2.md'])).map((d) => d.rel)) === JSON.stringify(['p1.md', 'p2.md']));
  check('⑦f decide：未覆盖路径过滤',
    JSON.stringify(mod.decide(['a.cs', 'b.cs'], [{ rel: 'p.md', status: 'approved', text: 'has a.cs inside' }])) === JSON.stringify({ uncovered: ['b.cs'] }));
  check('⑦g statusOf：frontmatter 状态行解析',
    mod.statusOf('---\n状态: approved\n级别: L1\n---\nbody') === 'approved' && mod.statusOf('no frontmatter') === '');
  check('⑦h isMergeLike：--merge 旗标 / 默认非合并仓 false',
    mod.isMergeLike(['node', 'x', '--merge']) === true && mod.isMergeLike(['node', 'x']) === false);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
