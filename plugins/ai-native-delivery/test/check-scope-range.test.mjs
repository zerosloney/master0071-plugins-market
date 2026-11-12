#!/usr/bin/env node
// check-scope-range.test.mjs — 推送范围（old..new）plan 改动面对账（2026-11-12 判据移植）
// tmp git 仓 spawn 真实 CLI。断言：①越界红（--strict 点名未声明文件）；②未落件仅 advisory；
// ③盲面警告（产品面改动无 plan 变更）；④incident 立档 → 降级提示；⑤L0 按提交粒度豁免（含明细打印）；
// ⑥L0 超上限不豁免；⑦首父链：合并带入的目标分支变更不判越界（combined diff）；⑧新分支首推 skip；
// ⑨plan 不可读 fail-loud exit 2。
// 零依赖，Node ≥ 18 直接运行：node test/check-scope-range.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'check-scope-range.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-'));
  const g = (...a) => spawnSync(GIT, ['-c', 'core.quotepath=off', ...a], { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'README.md'), '# base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root, g };
};
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const commit = (g, msg) => {
  g('add', '-A');
  g('commit', '-qm', msg);
};
const run = (root, oldSha, newSha, extra = []) =>
  spawnSync(process.execPath, [CLI, oldSha, newSha, ...extra], { cwd: root, encoding: 'utf8' });
const rev = (g, ref) => g('rev-parse', ref).stdout.trim();

const PLAN_APPROVED = (name, declared) => `---\n状态: approved\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — ${name}\n\n## 改动面\n${declared.map((d) => `- ${d}`).join('\n')}\n`;

// ---- ① 越界红 + ② 未落件 advisory（同一夹具） ----
{
  const { root, g } = mkRepo();
  const base = rev(g, 'HEAD');
  write(root, 'workflow/plans/p1.md', PLAN_APPROVED('p1', ['src/ok1.md', 'src/ghost.md']));
  commit(g, 'feat(p1): plan 先行');
  write(root, 'src/ok1.md', 'ok\n');
  write(root, 'src/rogue.md', 'rogue\n'); // 未声明 → 越界
  commit(g, 'feat(p1): 代码落件');
  const head = rev(g, 'HEAD');
  const r = run(root, base, head, ['--strict']);
  check('① 越界红：--strict exit 1 且点名未声明文件', r.status === 1 && r.stdout.includes('越界件') && r.stdout.includes('src/rogue.md'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  const r2 = run(root, base, head);
  check('② 未落件仅 advisory：无 --strict exit 0 且点名 ghost', r2.status === 0 && r2.stdout.includes('未落件') && r2.stdout.includes('src/ghost.md'), `exit=${r2.status}\n${r2.stdout}`);
  const r3 = run(root, base, head, ['--strict']);
  check('②b 未落件不升 hard：--strict 仍只判越界方向 exit 1（同 ①）', r3.status === 1);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 盲面警告（范围无 plan 变更 + 产品面改动 → advisory 不拦截） ----
{
  const { root, g } = mkRepo();
  const base = rev(g, 'HEAD');
  write(root, 'frontend/x.ts', 'export {};\n');
  commit(g, 'feat: 无 plan 的产品改动');
  const head = rev(g, 'HEAD');
  const r = run(root, base, head, ['--strict']);
  check('③ 盲面警告：产品面改动无 plan 变更 → 警告行 + exit 0（--strict 不升硬）',
    r.status === 0 && r.stdout.includes('推送含产品面改动但范围内无 plan 变更') && r.stdout.includes('frontend/x.ts'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ incident 立档 → 降级提示 ----
{
  const { root, g } = mkRepo();
  const base = rev(g, 'HEAD');
  write(root, 'frontend/y.ts', 'export {};\n');
  write(root, 'workflow/incidents/2026-11-12-hotfix.md', '---\n状态: open\n---\n# INCIDENT\n');
  commit(g, 'fix: 事故线立档 + 产品改动');
  const head = rev(g, 'HEAD');
  const r = run(root, base, head, ['--strict']);
  check('④ incident 立档 → 警告降级提示 + exit 0', r.status === 0 && r.stdout.includes('（降级）') && r.stdout.includes('incident 立档'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ L0 豁免（按提交粒度，明细打印）+ ⑥ 超上限不豁免 ----
{
  const { root, g } = mkRepo();
  const base = rev(g, 'HEAD');
  write(root, 'frontend/l0a.ts', 'a\n');
  write(root, 'frontend/l0b.ts', 'b\n');
  commit(g, 'fix: 小修\n\nL0: 修文案错字\n'); // L0 提交：2 产品件 ≤5
  write(root, 'workflow/plans/p2.md', PLAN_APPROVED('p2', ['src/ok2.md']));
  commit(g, 'docs(p2): plan 变更'); // 范围内含 plan 变更（触发对账）
  const head = rev(g, 'HEAD');
  const r = run(root, base, head, ['--strict']);
  check('⑤ L0 提交产品件免声明：--strict exit 0 且打印豁免明细',
    r.status === 0 && r.stdout.includes('L0 豁免') && r.stdout.includes('frontend/l0a.ts') && !r.stdout.includes('越界件'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const { root, g } = mkRepo();
  const base = rev(g, 'HEAD');
  for (let i = 1; i <= 6; i++) write(root, `frontend/big${i}.ts`, `${i}\n`);
  commit(g, 'feat: 超上限\n\nL0: 想整批豁免\n'); // 6 产品件 > L0_MAX → 不豁免
  write(root, 'workflow/plans/p3.md', PLAN_APPROVED('p3', ['src/ok3.md']));
  commit(g, 'docs(p3): plan 变更');
  const head = rev(g, 'HEAD');
  const r = run(root, base, head, ['--strict']);
  check('⑥ L0 超 5 件 → 不豁免，越界红 exit 1', r.status === 1 && r.stdout.includes('越界件') && r.stdout.includes('frontend/big1.ts'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ 首父链：合并带入的目标分支变更不判越界（combined diff 只出冲突解决件） ----
{
  const { root, g } = mkRepo();
  const mainBranch = g('symbolic-ref', '--short', 'HEAD').stdout.trim();
  const base = rev(g, 'HEAD');
  g('checkout', '-qb', 'side');
  write(root, 'side/from-side.ts', 'side\n'); // 被合入分支侧产物，本地范围无 plan 声明
  commit(g, 'feat: side 工作');
  g('checkout', '-q', mainBranch);
  write(root, 'workflow/plans/pm.md', PLAN_APPROVED('pm', ['src/main.md']));
  commit(g, 'docs(pm): plan');
  g('merge', '--no-ff', '-qm', 'feat: 合入 side（不带 L0）', 'side'); // 合并提交：combined diff 不含 side 文件
  const head = rev(g, 'HEAD');
  const r = run(root, base, head, ['--strict']);
  check('⑦ 合并带入的 side 文件不判越界（首父链 + combined diff）→ exit 0',
    r.status === 0 && !r.stdout.includes('越界件'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑧ 新分支首推（old 全零）→ skip ----
{
  const { root, g } = mkRepo();
  write(root, 'frontend/first.ts', 'x\n');
  commit(g, 'feat: 首推');
  const r = run(root, '0'.repeat(40), rev(g, 'HEAD'), ['--strict']);
  check('⑧ old 全零（新分支首推）→ skip exit 0', r.status === 0 && r.stdout.includes('新分支首推'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑨ plan 不可读 fail-loud exit 2 ----
{
  const { root, g } = mkRepo();
  const base = rev(g, 'HEAD');
  write(root, 'workflow/plans/gone.md', PLAN_APPROVED('gone', []));
  commit(g, 'docs(gone): plan');
  fs.rmSync(path.join(root, 'workflow', 'plans', 'gone.md')); // 工作区删掉（只在 HEAD 里）
  const r = run(root, base, rev(g, 'HEAD'), ['--strict']);
  check('⑨ 范围内 plan 工作区不可读 → exit 2 fail-loud', r.status === 2 && r.stderr.includes('plan 不可读'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
