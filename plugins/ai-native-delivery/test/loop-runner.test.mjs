#!/usr/bin/env node
// loop-runner.test.mjs — 无人闭环 runner 测试（全 mock runner，不真调模型；手法收敛自 model-call.test.mjs）
// 断言分组：
//   A 授权三态：①无 autoRunner（真种子 bands.json）→ 输出=check-bands 原文 + 未授权注明 + 配置面提示，
//     exit 1，零写盘；②有授权越带（diagnose + propose 双 band，mock 回严格 JSON）→ 双 intent 草案在场
//     （frontmatter draft + 自动生成声明 + JSON 字段落位）+ 台账行 agentOk/intentWritten + exit 0；
//     快照证明新增面 ⊆ intents/ + runs/（propose 档 v1 只到草案不越界）；③maxPerDay 耗尽 → 跳过注明、
//     不落账不调模型、exit 1。
//   B 坏输出三态：非 JSON / 超时 / agent is_error（外加 runner 缺席 spawn 态）→ 台账 failed、无 intent、
//     exit 1 且指认失败带。
//   C 幂等：重跑同名草案不覆盖（顺延 -2 后缀，原文件字节不变）。
//   D 纯函数：buildPrompt 含 band 名/带宽/tier/建议指令行/只读纪律/JSON 契约；parseDiagnosis 栅栏容错
//     与坏形态拒绝。
//   E CLI：--root + --runner 真跑 exit 0；未授权 exit 1；--help / 未知参数。
// 用法：node test/loop-runner.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBandCheck } from '../scripts/check-bands.mjs';
import { runLoopRunner, parseDiagnosis, buildPrompt } from '../scripts/loop-runner.mjs';

const WIN = process.platform === 'win32';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOOP = path.join(TEST_DIR, '..', 'scripts', 'loop-runner.mjs');
const SEED = path.join(TEST_DIR, '..', 'config-templates', 'bands.json');
const DAY = new Date().toISOString().slice(0, 10); // 与 runner utcDay 同口径（UTC 日）
// win32：被 spawnSync 超时杀掉的 shell 孙进程可能短暂握有句柄——rm 带重试
const rmdir = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// ── mock runner 夹具（model-call.test.mjs 同款：win32 .cmd 垫片 / POSIX sh → node 替身）──
// MOCK_MODE：''（默认）= 严格诊断 JSON；'badjson' = result 纯散文；'iserror' = 契约 JSON is_error:true；
// 'hang' = 挂起（配 timeoutMs 测超时态）。
const MOCK_BODY = `const fs = require('fs');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
if (!String(input).trim()) {
  const i = process.argv.indexOf('-p');
  if (i >= 0) input = process.argv[i + 1] || '';
}
const mode = process.env.MOCK_MODE || '';
if (mode === 'hang') {
  // win32 垫片超时只杀 shell，孙进程会存活——把 cwd 挪出夹具目录，测试的 rmSync 不被 cwd 锁卡死
  try { process.chdir(require('os').tmpdir()); } catch {}
  setTimeout(() => {}, 60000);
  return;
}
const DIAG = JSON.stringify({ summary: '验证失败率越带：全绿基线后新现一条失败行', evidence: ['.agents/verifications.jsonl 末行 exitCode=1', 'gen-workflow-metrics --dry-run 明细可复核'], suspectedCause: '最近一次 verify 红行（疑似单次环境性失败）', proposedIntent: { title: '复核 verify 红行根因', problem: 'verify-fail-rate band 越带：全绿基线上出现失败点', proposedOutcome: '定位红行根因并在台账登记处置结论', affected: ['.agents/verifications.jsonl'], openQuestions: ['红行是否环境性偶发'] } });
let result = DIAG;
if (mode === 'badjson') result = '这不是 JSON——模型回了散文（验收的坏输出态）';
if (mode === 'shape') result = JSON.stringify({ summary: '缺 proposedIntent 的不齐输出' });
process.stdout.write(JSON.stringify({ type: 'result', subtype: mode === 'iserror' ? 'error' : 'success', is_error: mode === 'iserror', result }));
`;
const mkRunner = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-runner-mock-'));
  fs.writeFileSync(path.join(dir, 'mock-model.cjs'), MOCK_BODY, 'utf8');
  let mockPath;
  if (WIN) {
    mockPath = path.join(dir, 'mock.cmd');
    fs.writeFileSync(mockPath, `@node "%~dp0mock-model.cjs" %*\r\n`, 'utf8');
  } else {
    mockPath = path.join(dir, 'mock.sh');
    fs.writeFileSync(mockPath, `#!/bin/sh\nexec node "$(dirname "$0")/mock-model.cjs" "$@"\n`, 'utf8');
    fs.chmodSync(mockPath, 0o755);
  }
  return mockPath;
};
const withMode = (mode, fn) => {
  const prev = process.env.MOCK_MODE;
  if (mode === null) delete process.env.MOCK_MODE;
  else process.env.MOCK_MODE = mode;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = prev;
  }
};

// ── 夹具仓 ──────────────────────────────────────────────────────────────────
const mkfix = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-runner-fix-'));
  fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
  return d;
};
// 验证行夹具（check-bands.test.mjs 同款）：10 绿 + 1 红 → σ=0 全平基线上越上带（两 band 同越）
const w = (root, rel, content) => fs.writeFileSync(path.join(root, rel), content);
const writeVerif = (root) => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(JSON.stringify({ ts: `2026-11-${String(i).padStart(2, '0')}T00:00:00.000Z`, exitCode: 0, suite: 'all-gates' }));
  rows.push(JSON.stringify({ ts: '2026-11-11T00:00:00.000Z', exitCode: 1, suite: 'check-loop', note: 'exit 1' }));
  w(root, path.join('.agents', 'verifications.jsonl'), `${rows.join('\n')}\n`);
};
const RULES2 = {
  'auto-diagnose-band': { metric: 'verify-green', k: 2, side: 'upper', streak: 1, tier: 'diagnose' },
  'auto-propose-band': { metric: 'verify-green', k: 2, side: 'upper', streak: 1, tier: 'propose' },
};
const TIERS_AUTH = {
  log: { desc: '仅记录' },
  diagnose: { readonlyTools: ['Read', 'Grep'], autoRunner: { enabled: true, maxPerDay: 2 } },
  propose: { route: ['pull_request'], autoRunner: { enabled: true, maxPerDay: 1 } },
};
const TIERS_NOAUTH = {
  log: { desc: '仅记录' },
  diagnose: { readonlyTools: ['Read', 'Grep'] },
  propose: { route: ['pull_request'] },
};
const writeBands = (root, tiers, rules = RULES2) => w(root, path.join('.agents', 'config', 'bands.json'), JSON.stringify({
  metric: { 'verify-green': { source: 'verify-green', value: 'recent-fail-rate', window: 20 } },
  baseline: { 'verify-green': { window: 10, minPoints: 5 } },
  rules, tiers,
}, null, 2));
const authFix = () => { const T = mkfix(); writeBands(T, TIERS_AUTH); writeVerif(T); return T; };
const ledgerOf = (root) => path.join(root, '.agents', 'runs', 'loop-runner.jsonl');
const ledgerRows = (root) => fs.readFileSync(ledgerOf(root), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const intentsOf = (root) => (fs.existsSync(path.join(root, 'workflow', 'intents')) ? fs.readdirSync(path.join(root, 'workflow', 'intents')) : []);
const snap = (root, base = root, out = []) => {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) snap(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
};

// ---- A 授权三态 ----
{
  // ① 无 autoRunner（真种子 bands.json + 越带夹具）→ check-bands 口径 + 提示配置面 + 零写盘
  const T = mkfix();
  fs.copyFileSync(SEED, path.join(T, '.agents', 'config', 'bands.json'));
  writeVerif(T);
  const before = snap(T);
  const cb = runBandCheck(T);
  const r = withMode(null, () => runLoopRunner(T));
  check('A1 无授权 → exit 1（建议指令照出，提示可配置）', r.code === 1, `code=${r.code}\n${r.lines.join('\n')}`);
  check('A1 输出前缀 = check-bands 原文（口径一致）', JSON.stringify(r.lines.slice(0, cb.lines.length)) === JSON.stringify(cb.lines), '');
  check('A1 建议指令行在场', r.lines.some((l) => l.includes('建议指令')), r.lines.join('\n'));
  check('A1 未授权注明 + 配置面提示', r.lines.some((l) => l.includes('未启用 autoRunner')) && r.lines.some((l) => l.includes('autoRunner = {"enabled": true, "maxPerDay"')), r.lines.join('\n'));
  check('A1 零写盘（无台账无草案）', JSON.stringify(snap(T)) === JSON.stringify(before) && intentsOf(T).length === 0, `${snap(T)} vs ${before}`);
  check('A1 库结果 unauthorized 指认 band', r.auto.unauthorized.includes('verify-fail-rate-2s') && r.auto.done.length === 0, JSON.stringify(r.auto));
  rmdir(T);

  // ② 有授权越带（diagnose + propose 双 band）→ 双草案 + 台账 + 只到草案不越界
  const T2 = authFix();
  const before2 = snap(T2);
  const r2 = withMode(null, () => runLoopRunner(T2, { runner: mkRunner() }));
  check('A2 有授权全处理 → exit 0', r2.code === 0, `code=${r2.code}\n${r2.lines.join('\n')}`);
  check('A2 双 band 草案在场', intentsOf(T2).includes(`${DAY}-auto-auto-diagnose-band.md`) && intentsOf(T2).includes(`${DAY}-auto-auto-propose-band.md`), intentsOf(T2).join(', '));
  const draft = fs.readFileSync(path.join(T2, 'workflow', 'intents', `${DAY}-auto-auto-diagnose-band.md`), 'utf8');
  check('A2 草案 frontmatter draft + 来源', draft.includes('状态: draft') && draft.includes('来源: loop-runner 自动诊断'), draft.slice(0, 200));
  check('A2 自动生成声明（须人工评审）', draft.includes('自动生成') && draft.includes('须经人工评审'), draft.slice(0, 400));
  check('A2 JSON 字段落位（title/summary/证据/outcome/疑问）',
    draft.includes('# INTENT — 复核 verify 红行根因') && draft.includes('全绿基线后新现一条失败行')
    && draft.includes('exitCode=1') && draft.includes('定位红行根因并在台账登记处置结论') && draft.includes('红行是否环境性偶发'), draft);
  check('A2 建议指令原文照录', draft.includes('建议指令（check-bands 原文照录'), draft.slice(-400));
  const rows2 = ledgerRows(T2);
  check('A2 台账两行 agentOk/intentWritten', rows2.length === 2 && rows2.every((x) => x.agentOk === true && x.intentWritten === true && typeof x.durationMs === 'number' && x.error === null), JSON.stringify(rows2));
  check('A2 台账字段齐（ts/band/tier/intent）', rows2.every((x) => typeof x.ts === 'string' && x.band && x.tier && typeof x.intent === 'string'), JSON.stringify(rows2));
  const added = snap(T2).filter((f) => !before2.includes(f));
  check('A2 propose 档只到草案（新增 ⊆ intents/ + runs/）', added.every((f) => f.startsWith('workflow/intents/') || f.startsWith('.agents/runs/')), added.join(', '));
  check('A2 结果行点名红线', r2.lines.some((l) => l.includes('只到 intent 草案') && l.includes('不自动开 PR')), r2.lines.at(-1));
  rmdir(T2);

  // ③ maxPerDay 耗尽 → 跳过注明、不落账不调模型
  const T3 = mkfix();
  writeBands(T3, { log: { desc: '' }, diagnose: { readonlyTools: ['Read'], autoRunner: { enabled: true, maxPerDay: 1 } }, propose: { route: ['pull_request'] } },
    { 'auto-diagnose-band': RULES2['auto-diagnose-band'] });
  writeVerif(T3);
  fs.mkdirSync(path.join(T3, '.agents', 'runs'), { recursive: true });
  fs.appendFileSync(ledgerOf(T3), `${JSON.stringify({ ts: `${DAY}T01:00:00.000Z`, band: 'auto-diagnose-band', tier: 'diagnose', durationMs: 5, agentOk: true, intentWritten: true, intent: 'workflow/intents/x.md', error: null })}\n`, 'utf8');
  const r3 = withMode(null, () => runLoopRunner(T3, { runner: mkRunner() }));
  check('A3 配额耗尽 → exit 1 + 跳过注明', r3.code === 1 && r3.lines.some((l) => l.includes('已达 maxPerDay=1') && l.includes('跳过')), `code=${r3.code}\n${r3.lines.join('\n')}`);
  check('A3 不新增台账行（跳过不落账）', ledgerRows(T3).length === 1, JSON.stringify(ledgerRows(T3)));
  check('A3 不写草案', intentsOf(T3).length === 0, intentsOf(T3).join(', '));
  rmdir(T3);
}

// ---- B 坏输出三态（台账 failed、无 intent、exit 1 且指认失败带）----
{
  const badCase = (label, mode, opts, wantErr) => {
    const T = mkfix();
    writeBands(T, { log: { desc: '' }, diagnose: { readonlyTools: ['Read'], autoRunner: { enabled: true, maxPerDay: 3 } }, propose: { route: ['pull_request'] } },
      { 'auto-diagnose-band': RULES2['auto-diagnose-band'] });
    writeVerif(T);
    const r = withMode(mode, () => runLoopRunner(T, { runner: mkRunner(), ...opts }));
    const rows = fs.existsSync(ledgerOf(T)) ? ledgerRows(T) : [];
    check(`B ${label} → exit 1 且指认失败带`, r.code === 1 && r.lines.some((l) => l.includes('auto-diagnose-band')) && r.auto.failed.includes('auto-diagnose-band'), `code=${r.code}\n${r.lines.join('\n')}`);
    check(`B ${label} → 台账 failed 行`, rows.length === 1 && rows[0].agentOk === false && rows[0].intentWritten === false && String(rows[0].error).includes(wantErr), JSON.stringify(rows));
    check(`B ${label} → 无 intent`, intentsOf(T).length === 0, intentsOf(T).join(', '));
    rmdir(T);
  };
  badCase('非 JSON', 'badjson', {}, '诊断输出');
  badCase('超时', 'hang', { timeoutMs: 600 }, 'timeout');
  badCase('agent is_error', 'iserror', {}, 'is_error');
  // 附加态：runner 缺席（spawn RUNNER_NOT_FOUND——claude 不在场最常见的真实失败）
  const T4 = mkfix();
  writeBands(T4, { log: { desc: '' }, diagnose: { readonlyTools: ['Read'], autoRunner: { enabled: true, maxPerDay: 3 } }, propose: { route: ['pull_request'] } },
    { 'auto-diagnose-band': RULES2['auto-diagnose-band'] });
  writeVerif(T4);
  const r4 = runLoopRunner(T4, { runner: 'no-such-runner-xyz-9x7' });
  const rows4 = ledgerRows(T4);
  check('B runner 缺席 → exit 1 + 台账 failed（RUNNER_NOT_FOUND）', r4.code === 1 && rows4.length === 1 && rows4[0].agentOk === false && String(rows4[0].error).includes('RUNNER_NOT_FOUND') && intentsOf(T4).length === 0, JSON.stringify(rows4));
  rmdir(T4);
}

// ---- C 幂等：重跑同名草案不覆盖（顺延 -2，原文件字节不变）----
{
  const T = mkfix();
  writeBands(T, { log: { desc: '' }, diagnose: { readonlyTools: ['Read'], autoRunner: { enabled: true, maxPerDay: 5 } }, propose: { route: ['pull_request'] } },
    { 'auto-diagnose-band': RULES2['auto-diagnose-band'] });
  writeVerif(T);
  const mock = mkRunner();
  withMode(null, () => runLoopRunner(T, { runner: mock }));
  const first = path.join(T, 'workflow', 'intents', `${DAY}-auto-auto-diagnose-band.md`);
  const content1 = fs.readFileSync(first, 'utf8');
  const r2 = withMode(null, () => runLoopRunner(T, { runner: mock }));
  const second = path.join(T, 'workflow', 'intents', `${DAY}-auto-auto-diagnose-band-2.md`);
  check('C 重跑顺延 -2 后缀且原草案字节不变', fs.existsSync(second) && fs.readFileSync(first, 'utf8') === content1, intentsOf(T).join(', '));
  check('C 重跑台账两行（append-only）', ledgerRows(T).length === 2, JSON.stringify(ledgerRows(T)));
  check('C 重跑仍 exit 0（授权配额内全处理）', r2.code === 0, `code=${r2.code}\n${r2.lines.join('\n')}`);
  rmdir(T);
}

// ---- D 纯函数：buildPrompt 契约面 / parseDiagnosis 容错与拒绝 ----
{
  const band = { name: 'b1', source: 'verify-green', value: 'recent-fail-rate', metric: 'verify-green', tier: 'diagnose', mean: 0, sigma: 0, lo: 0, hi: 0, k: 2, side: 'upper', cur: [{ v: 0.5 }] };
  const p = buildPrompt(band, [], '/r');
  check('D prompt(空明细回退) 含 band 名/当前值/带宽/tier', p.includes('b1') && p.includes('当前=0.5') && p.includes('带宽=[0, 0]') && p.includes('tier=diagnose'), p);
  const p2 = buildPrompt(band, ['[band] b1 | 源=verify-green | 当前=0.5 | 越带', '  建议指令（diagnose）：node x.mjs --dry-run'], '/r');
  check('D prompt 含建议指令行原文 + 只读纪律 + 工具白名单', p2.includes('建议指令（diagnose）：node x.mjs --dry-run') && p2.includes('只读') && p2.includes('Read / Grep / Glob') && p2.includes('禁止'), p2);
  check('D prompt 含严格 JSON 契约字段', ['summary', 'evidence', 'suspectedCause', 'proposedIntent', 'title', 'problem', 'proposedOutcome', 'affected', 'openQuestions'].every((k) => p.includes(`"${k}"`)), p);
  const okDiag = parseDiagnosis('{"summary":"s","evidence":["e1"],"suspectedCause":"c","proposedIntent":{"title":"t","problem":"p","proposedOutcome":"o","affected":["a"],"openQuestions":[]}}');
  check('D parse 合格 JSON → ok + 字段收口', okDiag.ok && okDiag.diag.proposedIntent.title === 't' && okDiag.diag.evidence.length === 1, JSON.stringify(okDiag));
  check('D parse 栅栏包裹 → 剥栅栏后放行', parseDiagnosis('```json\n{"summary":"s","evidence":[],"suspectedCause":"c","proposedIntent":{"title":"t","problem":"p","proposedOutcome":"o"}}\n```').ok, '');
  check('D parse 散文 → 拒', !parseDiagnosis('前情提要：{"summary":"s"} 如上').ok, '');
  check('D parse 缺 proposedIntent / 缺 title → 拒并点名', !parseDiagnosis('{"summary":"s"}').ok && !parseDiagnosis('{"summary":"s","evidence":[],"suspectedCause":"c","proposedIntent":{"problem":"p","proposedOutcome":"o"}}').ok, '');
  check('D parse evidence 非数组 → 拒', !parseDiagnosis('{"summary":"s","evidence":"x","suspectedCause":"c","proposedIntent":{"title":"t","problem":"p","proposedOutcome":"o"}}').ok, '');
}

// ---- E CLI（--root/--runner 真跑；--help；未知参数）----
{
  const T = authFix();
  const mock = mkRunner();
  const cli = (args, env = {}) => spawnSync(process.execPath, [LOOP, ...args], { encoding: 'utf8', cwd: T, env: { ...process.env, ...env } });
  const ok = cli(['--root', T, '--runner', mock]);
  check('E CLI 授权 + mock → exit 0 + 草案 + 台账', ok.status === 0 && intentsOf(T).length === 2 && ledgerRows(T).length === 2, `exit=${ok.status}\n${ok.stdout}${ok.stderr}`);
  const noAuth = mkfix();
  fs.copyFileSync(SEED, path.join(noAuth, '.agents', 'config', 'bands.json'));
  writeVerif(noAuth);
  const na = cli(['--root', noAuth]);
  check('E CLI 未授权 → exit 1 + 配置面提示', na.status === 1 && na.stdout.includes('未启用 autoRunner') && na.stdout.includes('maxPerDay'), `exit=${na.status}\n${na.stdout}${na.stderr}`);
  const badArg = cli(['--root', T, '--what']);
  check('E CLI 未知参数 → exit 2', badArg.status === 2, `exit=${badArg.status}`);
  rmdir(T);
  rmdir(noAuth);
  const h = spawnSync(process.execPath, [LOOP, '--help'], { encoding: 'utf8' });
  check('E CLI --help → exit 0 + 用法', h.status === 0 && h.stdout.includes('用法') && h.stdout.includes('autoRunner'), `exit=${h.status}`);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
