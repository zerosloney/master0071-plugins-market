#!/usr/bin/env node
// check-secrets-lite.mjs 的黑盒测试（判据移植配套）
// 夹具 = 真 git 临时仓（lite 只扫 git 跟踪文件），密钥用假样本（AKIA 样式 / 高熵 generic 值）。
// 断言：①干净树绿；②真特征红（规则名 + redact 明细）；③基线缺失 exit 2 fail-closed；
//       ④基线豁免生效（弱特征文件入基线 → 绿）；⑤强特征不豁免（AKIA 入基线仍红——基线只豁免宽泛规则）。
// 用法：node test/check-secrets-lite.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LITE = path.join(SCRIPT_DIR, '..', 'scripts', 'check-secrets-lite.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${desc}`); }
  else { fail += 1; console.log(`FAIL  ${desc}\n${detail}`); }
};

const git = (args, cwd) => spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', args, { cwd, encoding: 'utf8' });

// 真 git 夹具仓：baseline 缺省落空豁免清单（[]），files 全部 add+commit 进跟踪面
const mkfix = ({ baseline = true, files = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-lite-fix-'));
  git(['init', '-q'], root);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  if (baseline) fs.writeFileSync(path.join(root, '.gitleaks-baseline.json'), '[]', 'utf8');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text, 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'fix'], root);
  return root;
};

const run = (root, args = []) => spawnSync(process.execPath, [LITE, '--root', root, ...args], { encoding: 'utf8', cwd: root });

const AKIA = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n';
const WEAK = 'token = "J8sK2mN9pQ4rS7tU1vW3xY5zA6bC8dE0"\n';

// ① 干净树 → 绿
{
  const root = mkfix({ files: { 'readme.md': 'clean tree\n' } });
  const r = run(root);
  check('① 干净树 → exit 0 无泄漏', r.status === 0 && /无泄漏/.test(r.stdout), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ② 真特征 → 红（规则名 + redact 明细）
{
  const root = mkfix({ files: { 'leak.txt': AKIA } });
  const r = run(root);
  check('② AKIA 真特征 → exit 1', r.status === 1, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('② 明细含规则名与 redact 后值（不回显全值）',
    r.stderr.includes('aws-access-key-id') && r.stderr.includes('leak.txt:1') && r.stderr.includes('AKIA***') && !r.stderr.includes('AKIAIOSFODNN7EXAMPLE'),
    r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 基线缺失 → exit 2（fail-closed：无豁免清单则全树必爆红，拒跑而非静默）
{
  const root = mkfix({ baseline: false, files: { 'readme.md': 'no baseline\n' } });
  const r = run(root);
  check('③ 基线缺失 → exit 2 且文案点名基线', r.status === 2 && /基线缺失/.test(r.stderr), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ④ 基线豁免生效：弱特征文件在基线外 → 红；入基线 → 绿（文件级豁免）
{
  const root = mkfix({ files: { 'weak.txt': WEAK } });
  const r1 = run(root);
  check('④ 弱特征（generic key=value，值含数字且熵达标）基线外 → exit 1',
    r1.status === 1 && r1.stderr.includes('generic-api-key'), `exit=${r1.status}\n${r1.stderr}`);
  fs.writeFileSync(path.join(root, '.gitleaks-baseline.json'), JSON.stringify([{ File: 'weak.txt', Fingerprint: 'x' }]), 'utf8');
  const r2 = run(root);
  check('④ 同文件入基线 → exit 0（文件级豁免生效）', r2.status === 0 && /基线豁免文件 1/.test(r2.stdout), `exit=${r2.status}\n${r2.stdout}${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑤ 强特征不豁免：基线豁免只作用于宽泛规则——AKIA 文件入基线仍红（fail-closed 判据）
{
  const root = mkfix({
    files: { 'leak.txt': AKIA },
    // mkfix 先落基线再 add；这里覆写基线含 leak.txt 后需重新 commit 吗——基线本身不在扫描判据内，落盘即可
  });
  fs.writeFileSync(path.join(root, '.gitleaks-baseline.json'), JSON.stringify([{ File: 'leak.txt', Fingerprint: 'x' }]), 'utf8');
  const r = run(root);
  check('⑤ AKIA 文件入基线 → 仍 exit 1（强特征不受基线豁免）', r.status === 1 && r.stderr.includes('aws-access-key-id'), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
