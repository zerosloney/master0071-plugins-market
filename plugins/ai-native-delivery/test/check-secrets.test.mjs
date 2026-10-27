#!/usr/bin/env node
// check-secrets.mjs 的 fixture 测试（2026-10-14 G5 建门配套）
// 注缝：CHECK_SECRETS_ROOT 指夹具根；GITLEAKS_BIN 指 stub（.mjs——记录 argv 落盘 + 按 STUB_EXIT 退出）。
// 断言：①--staged → protect 参数映射；②detect → detect+基线参数映射；③基线缺失 exit 2；④gitleaks
//      非 0 透传；⑤缺二进制 loud-skip exit 0；⑥stub exit 2 透传（不止 0/1 两态）。
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

const mkfix = ({ baseline = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-fix-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  if (baseline) fs.writeFileSync(path.join(root, '.gitleaks-baseline.json'), '[]', 'utf8');
  const stub = path.join(root, 'gitleaks-stub.mjs');
  fs.writeFileSync(stub, STUB, 'utf8');
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

// ⑤ 缺二进制 → loud-skip exit 0
{
  const f = mkfix();
  const r = run(f.root, [], { GITLEAKS_BIN: path.join(f.root, 'no-such-gitleaks.exe'), STUB_OUT: outPath(f.root) });
  check('⑤ 缺二进制 → exit 0 且响亮跳过（文案含「未安装」）', r.status === 0 && /未安装/.test(r.stderr), `exit=${r.status} ${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// ⑥ stub exit 2 → 透传 exit 2（不止 0/1 两态）
{
  const f = mkfix();
  const r = run(f.root, [], { GITLEAKS_BIN: f.stub, STUB_EXIT: '2', STUB_OUT: outPath(f.root) });
  check('⑥ gitleaks exit 2 → wrapper exit 2', r.status === 2, `exit=${r.status} ${r.stderr}`);
  fs.rmSync(f.root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
