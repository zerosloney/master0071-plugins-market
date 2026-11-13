#!/usr/bin/env node
// pr-body.test.mjs — PR 体三件套生成器黑盒测试（2026-11-13 新增）
// 断言：①Summary 来自真实 diff（文件数/行数/提交列表）②Evidence 取不到时明写「未运行」③Danger
// 三要素齐全（Door/Rollback）④有 verifications.jsonl 绿行时引用之 ⑤空 diff 拒生成 exit 1
// ⑥core.quotepath=true 下非 ASCII 路径原样输出（C-004 回归锁——git 上游默认会 C 转义）。
// 零依赖，Node ≥ 18 直接运行：node test/pr-body.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'pr-body.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = (withGreen = false) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-test-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'a.js'), 'const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(d, 'README.md'), '# base\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'base');
  // head 提交
  fs.writeFileSync(path.join(d, 'src', 'a.js'), 'const a = 2;\n', 'utf8');
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'const b = 1;\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'feat: 改 a 加 b');
  if (withGreen) {
    fs.mkdirSync(path.join(d, '.agents'), { recursive: true });
    const headShort = g('rev-parse', '--short', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(d, '.agents', 'verifications.jsonl'),
      JSON.stringify({ ts: '2026-11-13T10:00:00Z', suite: 'all-gates', exitCode: 0, headShort }) + '\n', 'utf8');
  }
  return d;
};
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

// ①②③ 无 verify 绿行
{
  const d = mkRepo(false);
  const r = run(['--base', 'HEAD~1'], d);
  const out = r.stdout;
  check('① exit 0 且含 Summary 节', r.status === 0 && /## Summary/.test(out), `status=${r.status}`);
  check('① Summary 来自真实 diff（2 个文件 + 提交消息在场）', /2 个文件变更/.test(out) && /feat: 改 a 加 b/.test(out), out.slice(0, 200));
  check('② Evidence 明写「未运行」', /## Evidence/.test(out) && /未运行/.test(out), out.slice(out.indexOf('## Evidence'), out.indexOf('## Evidence') + 200));
  check('③ Danger 三要素齐全（Door / Blast Radius / Rollback）',
    /## Merge Danger/.test(out) && /\*\*Door\*\*/.test(out) && /\*\*Blast Radius\*\*/.test(out) && /\*\*Rollback\*\*/.test(out),
    out.slice(out.indexOf('## Merge Danger'), out.indexOf('## Merge Danger') + 200));
  check('③ 每节标数据来源（禁编造口径）', /数据来源/.test(out) && (out.match(/数据来源/g) || []).length >= 3, out.slice(0, 400));
  fs.rmSync(d, { recursive: true, force: true });
}

// ④ 有 verify 绿行时引用
{
  const d = mkRepo(true);
  const r = run(['--base', 'HEAD~1'], d);
  check('④ Evidence 引用 verify 绿行（非「未运行」）', r.status === 0 && /verify 全绿凭证行/.test(r.stdout) && !/未运行/.test(r.stdout), r.stdout.slice(r.stdout.indexOf('## Evidence'), r.stdout.indexOf('## Evidence') + 200));
  fs.rmSync(d, { recursive: true, force: true });
}

// ⑤ 空 diff 拒生成
{
  const d = mkRepo(false);
  const r = run(['--base', 'HEAD'], d);
  check('⑤ 空 diff 拒生成 exit 1', r.status === 1 && /没有文件变更/.test(r.stderr), `status=${r.status} err=${r.stderr.slice(0, 120)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ⑥ core.quotepath=true 下非 ASCII 路径不转义（C-004 回归锁）
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-qp-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  g('config', 'core.quotepath', 'true'); // git 上游默认；本机全局常为 false 故显式设 true
  fs.writeFileSync(path.join(d, 'README.md'), '# base\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'base');
  fs.mkdirSync(path.join(d, '文档'), { recursive: true });
  fs.writeFileSync(path.join(d, '文档', '说明.md'), '# 说明\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'add 文档');
  const r = run(['--base', 'HEAD~1'], d);
  check('⑥ quotepath=true 下中文路径原样输出（无 C 转义、区域分组正确）',
    r.status === 0 && /文档\(1\)/.test(r.stdout) && !/\\3[0-9]{2}/.test(r.stdout),
    `status=${r.status} out=${r.stdout.slice(0, 200)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
