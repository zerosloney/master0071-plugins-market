#!/usr/bin/env node
// worktree-audit.mjs 的 fixture 测试（2026-10-22 多 worktree 运维）
// 判据：分类必须来自机器事实——脏/未合入 = 活跃，干净且已合入 = 可清理，缺失 = 失效；
// 脚本只读（不删 worktree）。夹具：主区 + 已合并干净树 + 未提交脏树。
// 用法：node .agents/skills/session-resume/scripts/worktree-audit.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worktree-audit.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${desc}`); }
  else { fail += 1; console.log(`FAIL  ${desc}\n${detail}`); }
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-audit-'));
const main = path.join(base, 'main');
const clean = path.join(base, 'wt-clean');
const dirty = path.join(base, 'wt-dirty');
fs.mkdirSync(main, { recursive: true });

const run = (args, cwd) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const must = (args, cwd) => {
  const r = run(args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
};

try {
  must(['init', '-q', '-b', 'main'], main);
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  must(['add', '-A'], main);
  must(['commit', '-qm', 'init'], main);

  must(['worktree', 'add', '-q', '-b', 'feat-clean', clean], main);
  fs.writeFileSync(path.join(clean, 'b.txt'), 'b\n');
  must(['add', '-A'], clean);
  must(['commit', '-qm', 'clean work'], clean);
  must(['merge', '--no-ff', '-qm', 'merge clean', 'feat-clean'], main);

  must(['worktree', 'add', '-q', '-b', 'feat-dirty', dirty], main);
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'wip\n');

  const r = spawnSync(process.execPath, [SCRIPT], { cwd: main, encoding: 'utf8' });
  check('退出码 0（只读审计）', r.status === 0, r.stderr);
  const text = r.stdout;
  check('主区被识别', /主区/.test(text), text);
  check('已合入干净树 = 可清理', new RegExp(`可清理[^\\n]*wt-clean`).test(text), text);
  check('未提交树 = 活跃', new RegExp(`活跃\\(未提交\\)[^\\n]*wt-dirty`).test(text), text);
  check('给出删除建议但不执行', text.includes('git worktree remove'), text);
  check('三个 worktree 都还在（未删除）', fs.existsSync(clean) && fs.existsSync(dirty), text);

  const j = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: main, encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(j.stdout); } catch { /* 下方断言 */ }
  check('--json 可解析', parsed !== null, j.stdout);
  if (parsed) {
    check('--json 含 3 个 worktree', parsed.worktrees.length === 3, JSON.stringify(parsed.worktrees.map((w) => w.kind)));
    const byPath = Object.fromEntries(parsed.worktrees.map((w) => [w.path.replace(/\\/g, '/'), w]));
    const cleanRow = byPath[clean.replace(/\\/g, '/')];
    const dirtyRow = byPath[dirty.replace(/\\/g, '/')];
    check('--json 分类正确', cleanRow && cleanRow.kind === '可清理' && dirtyRow && dirtyRow.kind === '活跃(未提交)',
      JSON.stringify({ clean: cleanRow && cleanRow.kind, dirty: dirtyRow && dirtyRow.kind }));
  }

  // --execute：只删可清理，活跃/主区不动
  const ex = spawnSync(process.execPath, [SCRIPT, '--execute'], { cwd: main, encoding: 'utf8' });
  check('--execute 删除可清理树', ex.status === 0 && /已删除[^\n]*wt-clean/.test(ex.stdout), `${ex.stdout}\n${ex.stderr}`);
  check('--execute 不动活跃树与主区', fs.existsSync(dirty) && fs.existsSync(main), ex.stdout);
  check('--execute 后 clean 目录已消失', !fs.existsSync(clean), ex.stdout);

  // 失效：目录被外部删除
  fs.rmSync(dirty, { recursive: true, force: true });
  const r2 = spawnSync(process.execPath, [SCRIPT], { cwd: main, encoding: 'utf8' });
  check('目录缺失 = 失效', /失效/.test(r2.stdout), r2.stdout);
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', clean], { cwd: main });
  spawnSync('git', ['worktree', 'remove', '--force', dirty], { cwd: main });
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
