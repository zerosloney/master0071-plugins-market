#!/usr/bin/env node
// task-scope-gate.test.mjs — 关单改动面门（taskScopeGate，2026-11-13 判据移植，源 8f6a22f84 A 件）
// 被测面 = confirm-doc CLI 全链（spawn 子进程，不 import 内部函数）：plan→done 前取**引用本 plan
// 短名**的提交（`git log --first-parent --grep=<短名>`）并集其改动文件，与「改动方案」声明对账。
// 断言：①越界拒关单并点名未声明文件；②补声明（--reconfirm）后放行；③L0 提交同口径豁免；
// ④legacy 逃生口；⑤存量豁免声明逃生口；⑥非 git 逃生口；⑦无引用提交 → 过（无从对账）。
// 零依赖，Node ≥ 18 直接运行：node test/task-scope-gate.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(TEST_DIR, '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'confirm-doc.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'; // Windows spawn 不补 .exe 扩展名

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const gitAt = (root, ...args) => spawnSync(GIT, ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8' });
const commitAll = (root, msg) => {
  gitAt(root, 'add', '-A');
  const r = gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);
  if (r.status !== 0) throw new Error(`git commit 失败: ${r.stderr}`);
};
const mkRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsg-'));
  gitAt(root, 'init', '-q');
  write(root, 'README.md', '# base\n'); // 首笔须有内容，否则 commit「nothing to commit」非零退出
  commitAll(root, 'init');
  return root;
};
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const confirm = (root, doc, extra = []) =>
  spawnSync(process.execPath, [CLI, doc, '--delegated', '关单原话：按方案收口', ...extra], { cwd: root, encoding: 'utf8' });

// 独立 L1 plan 夹具：验收节全勾 + 逐条「证据：」（过 acceptanceEvidenceGate），
// 改动方案节声明由 declared 给出。frontmatter approved 态由夹具直写（approved 留痕由提交承担）。
const PLAN = (name, declared, opts = {}) => `---\n状态: approved\n级别: L1\n日期: 2026-11-13\n模块: demo\n${opts.extraFm || ''}---\n# PLAN — ${name}\n\n## 改动方案\n${declared.map((d) => `- ${d}：改`).join('\n')}\n\n## 验证计划\n- 跑冒烟脚本确认输出\n\n## 验收标准\n- [x] 改动面全部落件（证据：git diff 核对）\n${opts.body || ''}`;

// T1 拒关单并点名越界文件：plan 声明 2 件、实改 3 件（提交消息含短名）→ confirm-doc done 拒绝
{
  const root = mkRepo();
  const slug = '2026-11-13-t1';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t1', ['backend/a.md', 'backend/b.md']));
  write(root, 'backend/a.md', 'a\n');
  write(root, 'backend/b.md', 'b\n');
  write(root, 'backend/c.md', 'c 未声明\n');
  commitAll(root, `feat(${slug}): plan + 代码同笔入库`);
  const r = confirm(root, docRel);
  check('T1 越界拒关单：exit 非 0 + 点名「关单改动面门」', r.status !== 0 && /关单改动面门/.test(r.stderr), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('T1b 点名未声明文件 backend/c.md', /backend[\\/]c\.md/.test(r.stderr), r.stderr);
  const after = fs.readFileSync(path.join(root, docRel), 'utf8');
  check('T1c 零写盘（plan 仍 approved）', after.includes('状态: approved') && !after.includes('状态: done'), after.slice(0, 80));
  fs.rmSync(root, { recursive: true, force: true });
}

// T2 补声明后过：越界件补进「改动方案」→ --reconfirm 重录承诺面 → done 放行
{
  const root = mkRepo();
  const slug = '2026-11-13-t2';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t2', ['backend/a.md', 'backend/b.md']));
  write(root, 'backend/a.md', 'a\n');
  write(root, 'backend/b.md', 'b\n');
  write(root, 'backend/c.md', 'c\n');
  commitAll(root, `feat(${slug}): plan + 代码同笔入库`);
  const refused = confirm(root, docRel);
  check('T2 前置：补声明前拒关单', refused.status !== 0 && /关单改动面门/.test(refused.stderr), `exit=${refused.status}`);
  write(root, docRel, PLAN('t2', ['backend/a.md', 'backend/b.md', 'backend/c.md']));
  const rc = confirm(root, docRel, ['--reconfirm']);
  check('T2b --reconfirm 重录承诺面 → exit 0', rc.status === 0, `exit=${rc.status}\n${rc.stdout}${rc.stderr}`);
  const done = confirm(root, docRel);
  check('T2c 补声明后关单放行：exit 0 + plan 落 done', done.status === 0 && fs.readFileSync(path.join(root, docRel), 'utf8').includes('状态: done'), `exit=${done.status}\n${done.stdout}${done.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// T3 L0 豁免：引用短名的提交消息含 L0: 判据行且产品件 ≤5 → 产品件免声明，关单放行
{
  const root = mkRepo();
  const slug = '2026-11-13-t3';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t3', ['backend/a.md']));
  commitAll(root, 'docs: plan approved 留痕'); // 消息不含短名——留痕提交不入对账集
  write(root, 'backend/a.md', 'a\n');
  write(root, 'backend/l0-extra.md', 'L0 小改\n');
  commitAll(root, `fix(${slug}): L0 小修\n\nL0: 补一行说明文案，判据=输出含新文案`);
  const r = confirm(root, docRel);
  check('T3 L0 提交同口径豁免：关单放行 exit 0 + plan 落 done', r.status === 0 && fs.readFileSync(path.join(root, docRel), 'utf8').includes('状态: done'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// T4 legacy 逃生口：流程: legacy 行 → 跳过对账（有越界提交也不拦）
{
  const root = mkRepo();
  const slug = '2026-11-13-t4';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t4', ['backend/a.md'], { body: '流程: legacy\n' }));
  write(root, 'backend/undeclared-t4.md', 'x\n');
  commitAll(root, `feat(${slug}): plan + 未声明改动`);
  const r = confirm(root, docRel);
  check('T4 legacy 逃生口：关单放行 exit 0', r.status === 0 && fs.readFileSync(path.join(root, docRel), 'utf8').includes('状态: done'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// T5 存量豁免声明逃生口：行首「存量确认态豁免（」→ 跳过对账
{
  const root = mkRepo();
  const slug = '2026-11-13-t5';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t5', ['backend/a.md'], { body: '\n存量确认态豁免（T5 构造：声明式逃生口覆盖关单改动面门）\n' }));
  write(root, 'backend/undeclared-t5.md', 'x\n');
  commitAll(root, `feat(${slug}): plan + 未声明改动`);
  const r = confirm(root, docRel);
  check('T5 存量豁免声明逃生口：关单放行 exit 0', r.status === 0 && fs.readFileSync(path.join(root, docRel), 'utf8').includes('状态: done'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// T6 非 git 逃生口：目录无 .git → 跳过对账（不误拦）。夹具沿 confirm-doc.test 同款仅测试逃生门
//（LEDGER_CLI_TEST_ANYROOT + NODE_ENV=test）——生产态 confirm-doc 在台账根解析处先行 fail-closed，
// 本门 no-git skip 属纵深防御（closeout 直呼 / 其他调用方仍受保护）。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsg-nogit-'));
  const slug = '2026-11-13-t6';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t6', ['backend/a.md']));
  const r = spawnSync(process.execPath, [CLI, docRel, '--delegated', '关单原话：按方案收口'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, LEDGER_CLI_TEST_ANYROOT: '1', NODE_ENV: 'test' },
  });
  check('T6 非 git 逃生口：关单放行 exit 0', r.status === 0 && fs.readFileSync(path.join(root, docRel), 'utf8').includes('状态: done'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// T7 无引用提交 → 过：`--first-parent --grep` 无命中 = 无从对账，不拦关单
{
  const root = mkRepo();
  const slug = '2026-11-13-t7';
  const docRel = `workflow/plans/${slug}.md`;
  write(root, docRel, PLAN('t7', ['backend/a.md']));
  write(root, 'backend/a.md', 'a\n');
  write(root, 'backend/sneaky-t7.md', '未声明但消息无短名\n');
  commitAll(root, 'feat: 消息不含短名——提交门兜底口径，关单门无从对账');
  const r = confirm(root, docRel);
  check('T7 无引用提交 → 关单放行 exit 0（对账时点无债可查）', r.status === 0 && fs.readFileSync(path.join(root, docRel), 'utf8').includes('状态: done'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
