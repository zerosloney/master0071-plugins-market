// check-local-gate-config.test.mjs — 本地门禁挂载自检门测试（2026-10-25 优化1）
// 方法：临时 git 仓库夹具（全配 / 缺配 / TF_BUILD / 非 git 四形态）——零真实仓库副作用。
// 场景：S1 全配绿；S2 缺 hooksPath 默认 WARN 放行 + --strict 拦；S3 CI loud-skip；S4 非 git 跳过。
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

// mkfix(full)：临时 git 仓；full = 写齐 .gitattributes + 五钩子文件 + 三条 git config
const mkfix = (full) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgc-test-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, '.gitattributes'),
    'backend/shared/App.Api/appsettings.json merge=ours\n.agents/*.jsonl merge=jsonl-union\n'); // 脱敏泛化（2026-10-27）：appsettings 路径按使用项目替换
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
    fs.writeFileSync(path.join(root, '.githooks', h), '#!/bin/sh\nexit 0\n');
  }
  if (full) {
    git(root, ['config', 'core.hooksPath', '.githooks']);
    git(root, ['config', 'merge.ours.driver', 'true']);
    git(root, ['config', 'merge.jsonl-union.driver', 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B']);
  }
  return root;
};
const run = (root, args = [], env = {}) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

// ---- S1 全配 → 全绿退出 0，无 WARN 行 ----
{
  const root = mkfix(true);
  const r = run(root);
  check('S1 全配：exit 0 + 全 OK + 无 WARN/缺失',
    r.status === 0 && (r.stdout || '').includes('[OK] core.hooksPath') && !/\[缺失\]|WARN/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S2 缺 hooksPath：默认 WARN 放行（exit 0 + 修复提示）；--strict 拦（exit 1）----
{
  const root = mkfix(false); // 未挂 hooksPath（新 clone 漏配形态）
  const warn = run(root);
  check('S2 缺配默认 WARN：exit 0 + ⚠️ 告警 + 一键修复提示',
    warn.status === 0 && /⚠️ WARN core\.hooksPath/.test(warn.stdout || '') && /check-local-gates\.mjs --fix/.test(warn.stdout || ''),
    `exit=${warn.status}\n${warn.stdout}${warn.stderr}`);
  const strict = run(root, ['--strict']);
  check('S2 --strict：缺配即拦 exit 1 + 缺失标记',
    strict.status === 1 && /\[缺失\] core\.hooksPath/.test(strict.stdout || ''),
    `exit=${strict.status}\n${strict.stdout}${strict.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S3 CI（TF_BUILD）：缺配也 loud-skip（CI 不挂本地钩子属常态）----
{
  const root = mkfix(false);
  const r = run(root, [], { TF_BUILD: 'true' });
  check('S3 TF_BUILD：loud-skip exit 0 + 跳过说明',
    r.status === 0 && /⏭️ CI 环境/.test(r.stdout || '') && !/WARN/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S4 非 git 目录：无挂载面，跳过 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgc-nogit-'));
  const r = run(root);
  check('S4 非 git 仓：exit 0 + 跳过说明（fixture 合法形态）',
    r.status === 0 && /非 git 仓库/.test(r.stdout || ''),
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
