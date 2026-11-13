#!/usr/bin/env node
// check-secrets.mjs 的 fixture 测试（2026-10-14 G5 建门配套）
// 注缝：CHECK_SECRETS_ROOT 指夹具根；GITLEAKS_BIN 指 stub（.mjs——记录 argv 落盘 + 按 STUB_EXIT 退出）。
// 断言：①--staged → protect 参数映射；②detect → detect+基线参数映射；③基线缺失 exit 2；④gitleaks
//      非 0 透传；⑤缺二进制自动接续 lite（执法者=lite，不再 loud-skip）；⑥stub exit 2 透传（不止 0/1 两态）；
//      ⑦SECRETS_SCAN_LITE=1/--lite 强制（gitleaks 探测整体跳过）；⑧REQUIRE_GITLEAKS=1 缺二进制 exit 2；
//      ⑨缺二进制 + 树内真特征 → lite 透传 exit 1。
// 用法：node test/check-secrets.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const WRAPPER = path.join(SCRIPT_DIR, '..', 'scripts', 'check-secrets.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${desc}`); }
  else { fail += 1; console.log(`FAIL  ${desc}\n${detail}`); }
};

const STUB = `import fs from 'node:fs';
fs.writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.STUB_EXIT || '0'));
`;

const git = (args, cwd) => spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', args, { cwd, encoding: 'utf8' });

const mkfix = ({ baseline = true, gitRepo = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-fix-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  if (baseline) fs.writeFileSync(path.join(root, '.gitleaks-baseline.json'), '[]', 'utf8');
  const stub = path.join(root, 'gitleaks-stub.mjs');
  fs.writeFileSync(stub, STUB, 'utf8');
  if (gitRepo) {
    git(['init', '-q'], root);
    git(['config', 'user.email', 't@t'], root);
    git(['config', 'user.name', 't'], root);
    fs.writeFileSync(path.join(root, 'README.md'), 'clean fixture\n', 'utf8');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'fix'], root);
  }
  return { root, stub };
};

const run = (root, args, env = {}) => spawnSync(process.execPath, [WRAPPER, ...args], {
  encoding: 'utf8',
  cwd: root,
  env: { ...process.env, CHECK_SECRETS_ROOT: root, ...env },
});

const outPath = (root) => path.join(root, 'stub-out.json');
const readStubArgs = (root) => JSON.parse(fs.readFileSync(outPath(root), 'utf8'));

// ① --staged → protect 参数映射（基线不参与 protect）
{
  const f = mkfix({ baseline: false });
  const r = run(f.root, ['--staged'], { GITLEAKS_BIN: f.stub, STUB_EXIT: '0', STUB_OUT: outPath(f.root) });
  check('① --staged → exit 0', r.status === 0, `exit=${r.status} ${r.stderr}`);
  check('① 参数映射 protect --staged --redact --no-banner',
    JSON.stringify(readStubArgs(f.root)) === JSON.stringify(['protect', '--staged', '--redact', '--no-banner']),
    JSON.stringify(readStubArgs(f.root)));
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ② detect → detect + 基线绝对路径参数映射
{
  const f = mkfix();
  const r = run(f.root, [], { GITLEAKS_BIN: f.stub, STUB_EXIT: '0', STUB_OUT: outPath(f.root) });
  const got = readStubArgs(f.root);
  check('② detect → exit 0', r.status === 0, `exit=${r.status} ${r.stderr}`);
  check('② 参数映射 detect --source . --baseline-path <root> --redact --no-banner',
    got[0] === 'detect' && got[1] === '--source' && got[2] === '.'
    && got[3] === '--baseline-path' && got[4] === path.join(f.root, '.gitleaks-baseline.json')
    && got[5] === '--redact' && got[6] === '--no-banner', JSON.stringify(got));
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ③ detect 基线缺失 → exit 2（配置失守 fail-closed）
{
  const f = mkfix({ baseline: false });
  const r = run(f.root, [], { GITLEAKS_BIN: f.stub, STUB_OUT: outPath(f.root) });
  check('③ detect 基线缺失 → exit 2 且文案点名基线', r.status === 2 && /基线缺失/.test(r.stderr), `exit=${r.status} ${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ④ gitleaks exit 1（发现泄漏）→ 透传 exit 1
{
  const f = mkfix();
  const r = run(f.root, [], { GITLEAKS_BIN: f.stub, STUB_EXIT: '1', STUB_OUT: outPath(f.root) });
  check('④ gitleaks exit 1 → wrapper exit 1', r.status === 1, `exit=${r.status} ${r.stdout}${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ⑤ 缺二进制 → 自动接续 lite（判据移植「装不上也要扫」：不再 loud-skip，恒执法）
{
  const f = mkfix({ baseline: true, gitRepo: true });
  const r = run(f.root, [], { GITLEAKS_BIN: path.join(f.root, 'no-such-gitleaks.exe'), STUB_OUT: outPath(f.root) });
  check('⑤ 缺二进制 → exit 0 且接续 lite（文案含「执法者=lite」）', r.status === 0 && /执法者=lite/.test(r.stderr), `exit=${r.status} ${r.stderr}`);
  check('⑤ 接续后不再发 GATE_SKIPPED 标记（门已执法，verify 绿行保留全量锚资格）',
    !/GATE_SKIPPED/.test(r.stdout), `stdout=${JSON.stringify(r.stdout)}`);
  check('⑤ lite 实扫跟踪文件（扫描面非 0，非空扫假绿）', /｜[1-9]\d* 文件｜/.test(r.stdout), `out=${r.stdout} err=${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ⑥ stub exit 2 → 透传 exit 2（不止 0/1 两态）
{
  const f = mkfix();
  const r = run(f.root, [], { GITLEAKS_BIN: f.stub, STUB_EXIT: '2', STUB_OUT: outPath(f.root) });
  check('⑥ gitleaks exit 2 → wrapper exit 2', r.status === 2, `exit=${r.status} ${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ⑦ SECRETS_SCAN_LITE=1 / --lite 强制 → gitleaks 探测整体跳过（stub 在场也不被调用）
{
  const f = mkfix({ baseline: true, gitRepo: true });
  const r = run(f.root, [], { GITLEAKS_BIN: f.stub, SECRETS_SCAN_LITE: '1', STUB_OUT: outPath(f.root) });
  check('⑦ SECRETS_SCAN_LITE=1 → exit 0 且 stub 未被调用（探测整体跳过）',
    r.status === 0 && /执法者=lite/.test(r.stderr) && !fs.existsSync(outPath(f.root)), `exit=${r.status} ${r.stderr}`);
  const r2 = run(f.root, ['--lite'], { GITLEAKS_BIN: f.stub, STUB_OUT: outPath(f.root) });
  check('⑦ --lite 旗标同效', r2.status === 0 && /执法者=lite/.test(r2.stderr) && !fs.existsSync(outPath(f.root)), `exit=${r2.status} ${r2.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ⑧ SECRETS_SCAN_REQUIRE_GITLEAKS=1 + 缺二进制 → exit 2 fail-closed（恢复强执法面口径）
{
  const f = mkfix({ baseline: true, gitRepo: true });
  const r = run(f.root, [], { GITLEAKS_BIN: path.join(f.root, 'no-such-gitleaks.exe'), SECRETS_SCAN_REQUIRE_GITLEAKS: '1', STUB_OUT: outPath(f.root) });
  check('⑧ REQUIRE_GITLEAKS=1 缺二进制 → exit 2 且文案点名配置', r.status === 2 && /REQUIRE_GITLEAKS/.test(r.stderr), `exit=${r.status} ${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ⑨ 缺二进制 + 树内真特征 → lite 判红且透传 exit 1（恒执法不只对干净树成立）
{
  const f = mkfix({ baseline: true, gitRepo: true });
  fs.writeFileSync(path.join(f.root, 'leak.txt'), 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n', 'utf8');  // secrets-lite:allow 测试夹具
  git(['add', '-A'], f.root);
  git(['commit', '-qm', 'leak'], f.root);
  const r = run(f.root, [], { GITLEAKS_BIN: path.join(f.root, 'no-such-gitleaks.exe'), STUB_OUT: outPath(f.root) });
  check('⑨ 缺二进制 + 真特征 → 接续 lite 判红透传 exit 1', r.status === 1 && r.stderr.includes('aws-access-key-id'), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
