#!/usr/bin/env node
// model-call.test.mjs — 无交互模型调用单源适配器测试（全 mock runner，不真调模型）
// 夹具：临时目录造假可执行（win32 .cmd 垫片 → node 替身 / POSIX sh 脚本 → 同一替身），替身按
//   MOCK_MODE 出 claude 契约 JSON / 纯文本 / 挂起；prompt 送达验证走替身回显（win32 shell+stdin
//   形态 / POSIX argv 直传，各自的真实路径）。覆盖 callModel 四态：ok / timeout / spawn 失败 /
//   非 JSON，加 runner 不在场与 --probe CLI 两态（ok / 缺席）。win32 探测逻辑（where.exe →
//   真 .exe 优先）按平台跑真探测或跳过。
// 用法：node test/model-call.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callModel, resolveRunner, RUNNER_ENV } from '../scripts/model-call.mjs';

const WIN = process.platform === 'win32';
const MODEL_CALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'model-call.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// ── mock runner 夹具 ─────────────────────────────────────────────────────────
// 替身行为由 MOCK_MODE 控制：''（默认）= claude 契约 JSON（回显 prompt 头与旗标可见性）；
// 'plain' = 纯文本（非 JSON 态）；'hang' = 挂起 60s（超时态）；'fail-gone' = prompt 含
// GONE_MARKER 时回纯文本、其余正常（单条失败不阻塞其余的语义复评场景）。
const MOCK_BODY = `const fs = require('fs');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* stdin 已关闭 */ }
if (!String(input).trim()) {
  const i = process.argv.indexOf('-p');
  if (i >= 0) input = process.argv[i + 1] || '';
}
const mode = process.env.MOCK_MODE || '';
const plain = mode === 'plain' || (mode === 'fail-gone' && String(input).includes('GONE_MARKER'));
if (mode === 'hang') { setTimeout(() => {}, 60000); return; }
if (plain) { process.stdout.write('这是纯文本输出，不是 JSON'); return; }
const body = JSON.stringify({ verdict: '仍成立', reason: 'mock 裁决', seenPromptHead: String(input).slice(0, 24),
  seenMaxTurns: process.argv.includes('--max-turns'), seenOutputFormat: process.argv.includes('--output-format') });
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: body }));
`;
const mkRunner = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-call-test-'));
  fs.writeFileSync(path.join(dir, 'mock-model.cjs'), MOCK_BODY, 'utf8');
  let mockPath;
  if (WIN) {
    mockPath = path.join(dir, 'mock.cmd');
    fs.writeFileSync(mockPath, `@node "%~dp0mock-model.cjs" %*\r\n`, 'utf8'); // %* 透传旗标给替身
  } else {
    mockPath = path.join(dir, 'mock.sh');
    fs.writeFileSync(mockPath, `#!/bin/sh\nexec node "$(dirname "$0")/mock-model.cjs" "$@"\n`, 'utf8');
    fs.chmodSync(mockPath, 0o755);
  }
  return { dir, mockPath };
};
const withMode = (mode, fn) => {
  const prev = process.env.MOCK_MODE;
  process.env.MOCK_MODE = mode;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = prev;
  }
};
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// ---- ① ok 态：契约 JSON 解析 + prompt 送达 + 旗标透传（win32 走 shell+stdin 真形态 / POSIX argv 直传） ----
{
  const { dir, mockPath } = mkRunner();
  const r = callModel({ prompt: 'PROMPTHEAD-abc 语义复评请求', runner: mockPath, maxTurns: 1, timeoutMs: 20000 });
  check('① ok=true 且 error=null 且 durationMs≥0', r.ok === true && r.error === null && r.durationMs >= 0, JSON.stringify(r).slice(0, 300));
  check('① 契约 JSON（is_error=false，result 内嵌正文可解析）', r.json && r.json.is_error === false && typeof r.json.result === 'string', JSON.stringify(r.json).slice(0, 200));
  const body = JSON.parse(r.json.result);
  check(`① prompt 经${WIN ? ' stdin（shell 垫片形态）' : ' argv'}送达替身`, body.seenPromptHead === 'PROMPTHEAD-abc 语义复评请求'.slice(0, 24), JSON.stringify(body));
  check('① --max-turns/--output-format 旗标透传替身', body.seenMaxTurns === true && body.seenOutputFormat === true, JSON.stringify(body));
  check('① text 留原始 stdout', r.text.includes('"type":"result"'), r.text.slice(0, 100));
  cleanup(dir);
}

// ---- ② 超时态：MOCK_MODE=hang + 小 timeoutMs → kind:'timeout'，不 throw ----
{
  const { dir, mockPath } = mkRunner();
  withMode('hang', () => {
    const r = callModel({ prompt: 'x', runner: mockPath, timeoutMs: 500 });
    check('② ok=false 且 kind=timeout（ETIMEDOUT）', r.ok === false && r.json === null && r.error && r.error.kind === 'timeout' && r.error.code === 'ETIMEDOUT', JSON.stringify(r.error));
  });
  cleanup(dir);
}

// ---- ③ spawn 失败态：显式路径指向不存在文件 → kind:'spawn'（win32 .exe 直 spawn ENOENT） ----
{
  const { dir } = mkRunner();
  const absent = path.join(dir, 'absent-runner.exe');
  const r = callModel({ prompt: 'x', runner: absent, timeoutMs: 10000 });
  check('③ ok=false 且 kind=spawn（不存在路径不 throw）', r.ok === false && r.error && r.error.kind === 'spawn' && r.error.code !== 'RUNNER_NOT_FOUND', JSON.stringify(r.error));
  cleanup(dir);
}

// ---- ④ 非 JSON 态：MOCK_MODE=plain → kind:'non-json'，原始 stdout 留 text ----
{
  const { dir, mockPath } = mkRunner();
  withMode('plain', () => {
    const r = callModel({ prompt: 'x', runner: mockPath, timeoutMs: 10000 });
    check('④ ok=false 且 kind=non-json（附 exit 与 stdout 头）', r.ok === false && r.json === null && r.error && r.error.kind === 'non-json' && /EXIT_\d/.test(r.error.code), JSON.stringify(r.error));
    check('④ text 保留原始非 JSON 输出', typeof r.text === 'string' && r.text.includes('不是 JSON'), r.text.slice(0, 100));
  });
  cleanup(dir);
}

// ---- ⑤ runner 不在场：bogus 名（win32 真探测 where.exe 落空 → RUNNER_NOT_FOUND；POSIX 直 spawn ENOENT 同 kind） ----
{
  const bogus = 'definitely-not-a-runner-xyz-模型面自检';
  const r = callModel({ prompt: 'x', runner: bogus, timeoutMs: 10000 });
  const okWin = WIN && r.error && r.error.kind === 'spawn' && r.error.code === 'RUNNER_NOT_FOUND';
  const okPosix = !WIN && r.error && r.error.kind === 'spawn';
  check(`⑤ ok=false 且 kind=spawn（${WIN ? 'RUNNER_NOT_FOUND，where.exe 探测' : 'ENOENT 直 spawn'}）`, okWin || okPosix, JSON.stringify(r.error));
}

// ---- ⑥ resolveRunner：显式路径原样采信 + .cmd/.bat → shell 形态；POSIX 名不作探测 ----
{
  const winShim = 'C:\\tools\\claude.cmd';
  const rr1 = resolveRunner(winShim);
  check('⑥ 显式路径原样采信（不再探测）', rr1.path === winShim, JSON.stringify(rr1));
  check(`⑥ 显式 .cmd → shell=${WIN}（${WIN ? 'win32 垫片退 shell 形态' : 'POSIX 无垫片概念'}）`, rr1.shell === WIN, JSON.stringify(rr1));
  const rr2 = resolveRunner('/usr/local/bin/claude');
  check('⑥ POSIX 显式路径 shell=false', rr2.path === '/usr/local/bin/claude' && rr2.shell === false, JSON.stringify(rr2));
  if (WIN) {
    const rr3 = resolveRunner('definitely-not-a-runner-xyz');
    check('⑥ win32 bogus 名 → null（探测落空）', rr3 === null, JSON.stringify(rr3));
  }
}

// ---- ⑦ 环境变量换 runner：MODEL_CALL_RUNNER 优先于默认名、显式参数优先于环境变量 ----
{
  const { dir, mockPath } = mkRunner();
  const prev = process.env[RUNNER_ENV];
  process.env[RUNNER_ENV] = mockPath;
  const r1 = callModel({ prompt: 'env-runner', timeoutMs: 20000 });
  check('⑦ MODEL_CALL_RUNNER 缺省生效（无显式 runner 参数时）', r1.ok === true, JSON.stringify(r1.error || {}).slice(0, 200));
  const r2 = callModel({ prompt: 'explicit-wins', runner: path.join(dir, 'absent.exe'), timeoutMs: 10000 });
  check('⑦ 显式 runner 参数优先于环境变量', r2.ok === false && r2.error && r2.error.kind === 'spawn' && r2.error.code !== 'RUNNER_NOT_FOUND', JSON.stringify(r2.error).slice(0, 200));
  if (prev === undefined) delete process.env[RUNNER_ENV];
  else process.env[RUNNER_ENV] = prev;
  cleanup(dir);
}

// ---- ⑧ --probe CLI：mock runner → exit 0 报 ok=true；缺席 runner → exit 1 报 ok=false；未知选项 exit 2 ----
{
  const { dir, mockPath } = mkRunner();
  const run = (args) => spawnSync(process.execPath, [MODEL_CALL, ...args], { encoding: 'utf8', timeout: 60000 });
  const ok = run(['--probe', '--runner', mockPath]);
  check('⑧ --probe mock runner → exit 0 且报 ok=true', ok.status === 0 && /\[probe\] ok=true/.test(ok.stdout), `exit=${ok.status} ${ok.stdout}${ok.stderr}`);
  check('⑧ probe 输出带 runner 实化路径与耗时', ok.stdout.includes(mockPath) && /durationMs=\d+/.test(ok.stdout), ok.stdout);
  const bad = run(['--probe', '--runner', path.join(dir, 'absent.exe')]);
  check('⑧ --probe 缺席 runner → exit 1 且报 ok=false kind=spawn', bad.status === 1 && /\[probe\] ok=false/.test(bad.stdout) && bad.stdout.includes('kind=spawn'), `exit=${bad.status} ${bad.stdout}${bad.stderr}`);
  const unk = run(['--wat']);
  check('⑧ 未知选项 exit 2', unk.status === 2, `exit=${unk.status}`);
  const noOp = run([]);
  check('⑧ 无操作 exit 2（模型调用 opt-in，不默认发起）', noOp.status === 2 && /opt-in/.test(noOp.stderr), `exit=${noOp.status} ${noOp.stderr}`);
  const help = run(['--help']);
  check('⑧ --help exit 0 且带 opt-in 纪律声明', help.status === 0 && help.stdout.includes('opt-in') && help.stdout.includes('callModel'), `exit=${help.status}`);
  cleanup(dir);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
