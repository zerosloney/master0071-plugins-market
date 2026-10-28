// check-local-gate-config.test.mjs — 本地门禁挂载自检门测试（2026-10-25 优化1；2026-10-27 插件化修复扩展）
// 方法：临时 git 仓库夹具（源仓形态全配 / 源仓形态缺配 / 插件形态全配 / 插件形态缺钩 / TF_BUILD / 非 git）——零真实仓库副作用。
// 形态判别：项目侧存在 .agents/scripts/check-loop.mjs → 源仓形态（core.hooksPath + 五钩子老口径）；
//           否则 → 插件形态（判 git 实际会执行的 pre-commit / pre-push 两执法点）。
// 回归护栏（本次修复的核心）：插件形态下输出绝不可出现「设 core.hooksPath」的修复指引——
//   core.hooksPath 会整体接管 git 钩子查找，init-engine 装到 git 默认钩子目录的钩子会因此静默失效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-local-gate-config.mjs'); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/

let pass = 0, fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n       ${detail}` : ''}`); }
};
const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

// mkfix(full, form)：临时 git 仓；form='source-repo' 写齐 .githooks 五钩子 + .agents/scripts 标记；
//                     form='plugin' 写齐 git 默认钩子目录的 pre-commit / pre-push（init-engine 的安装面）。
const mkfix = (full, form = 'source-repo') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgc-test-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, '.gitattributes'),
    'backend/shared/App.Api/appsettings.json merge=ours\n.agents/*.jsonl merge=jsonl-union\n'); // 脱敏泛化（2026-10-27）：appsettings 路径按使用项目替换
  if (form === 'source-repo') {
    fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
    for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
      fs.writeFileSync(path.join(root, '.githooks', h), '#!/bin/sh\nexit 0\n');
    }
    // 源仓形态标记：项目侧自带引擎脚本副本 → 判 core.hooksPath/.githooks 老口径
    fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'scripts', 'check-loop.mjs'), '// fixture\n');
  } else {
    const hooksDir = path.join(root, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const h of ['pre-commit', 'pre-push']) {
      fs.writeFileSync(path.join(hooksDir, h), '#!/bin/sh\nexit 0\n');
    }
  }
  if (full) {
    if (form === 'source-repo') {
      git(root, ['config', 'core.hooksPath', '.githooks']);
      git(root, ['config', 'merge.ours.driver', 'true']);
      git(root, ['config', 'merge.jsonl-union.driver', 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B']);
    }
  }
  return root;
};
const run = (root, args = [], env = {}) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

// ---- S1 源仓形态全配 → 全绿退出 0，无 WARN 行 ----
{
  const root = mkfix(true, 'source-repo');
  const r = run(root);
  check('S1 源仓形态全配：exit 0 + 全 OK + 无 WARN/缺失',
    r.status === 0 && (r.stdout || '').includes('[OK] core.hooksPath') && !/\[缺失\]|WARN/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S2 源仓形态缺 hooksPath：默认 WARN 放行（exit 0 + 修复提示）；--strict 拦（exit 1）----
{
  const root = mkfix(false, 'source-repo'); // 未挂 hooksPath（新 clone 漏配形态）
  const warn = run(root);
  check('S2 源仓形态缺配默认 WARN：exit 0 + ⚠️ 告警 + 一键修复提示',
    warn.status === 0 && /⚠️ WARN core\.hooksPath/.test(warn.stdout || '') && /check-local-gates\.mjs"?\s+--fix/.test(warn.stdout || ''),
    `exit=${warn.status}\n${warn.stdout}${warn.stderr}`);
  const strict = run(root, ['--strict']);
  check('S2 --strict：缺配即拦 exit 1 + 缺失标记',
    strict.status === 1 && /\[缺失\] core\.hooksPath/.test(strict.stdout || ''),
    `exit=${strict.status}\n${strict.stdout}${strict.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S3 插件形态：钩子在 git 默认钩子目录 → 全绿，且绝不给 core.hooksPath 指引 ----
{
  const root = mkfix(true, 'plugin');
  const r = run(root);
  check('S3 插件形态钩子在位：exit 0 + 两执法点 OK + 无 WARN/缺失',
    r.status === 0 && /\[OK\] 钩子在位：pre-commit/.test(r.stdout || '')
    && /\[OK\] 钩子在位：pre-push/.test(r.stdout || '') && !/\[缺失\]|⚠️ WARN/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('S3 插件形态输出绝不含「设 core.hooksPath」指引（自伤回归护栏）',
    !/core\.hooksPath \.githooks/.test(r.stdout || ''),
    `stdout=${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S4 插件形态钩子缺失 → WARN + 修复指引指向 init-engine，且绝不含 core.hooksPath 指引 ----
{
  const root = mkfix(false, 'plugin');
  fs.rmSync(path.join(root, '.git', 'hooks', 'pre-push'));
  const warn = run(root);
  check('S4 插件形态缺钩：exit 0 + ⚠️ 告警点名 pre-push + 修复指向 init-engine',
    warn.status === 0 && /⚠️ WARN 钩子在位：pre-push/.test(warn.stdout || '') && /init-engine\.mjs/.test(warn.stdout || ''),
    `exit=${warn.status}\n${warn.stdout}${warn.stderr}`);
  check('S4 插件形态缺钩时输出绝不含「设 core.hooksPath」指引（自伤回归护栏）',
    !/core\.hooksPath \.githooks/.test(warn.stdout || ''),
    `stdout=${warn.stdout}`);
  const strict = run(root, ['--strict']);
  check('S4 --strict：插件形态缺钩即拦 exit 1',
    strict.status === 1 && /\[缺失\] 钩子在位：pre-push/.test(strict.stdout || ''),
    `exit=${strict.status}\n${strict.stdout}${strict.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S5 CI（TF_BUILD）：缺配也 loud-skip（CI 不挂本地钩子属常态）----
{
  const root = mkfix(false, 'source-repo');
  const r = run(root, [], { TF_BUILD: 'true' });
  check('S5 TF_BUILD：loud-skip exit 0 + 跳过说明',
    r.status === 0 && /⏭️ CI 环境/.test(r.stdout || '') && !/WARN/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S6 非 git 目录：无挂载面，跳过 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgc-nogit-'));
  const r = run(root);
  check('S6 非 git 仓：exit 0 + 跳过说明（fixture 合法形态）',
    r.status === 0 && /非 git 仓库/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
