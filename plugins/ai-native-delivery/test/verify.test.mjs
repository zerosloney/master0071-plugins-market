#!/usr/bin/env node
// verify.mjs 的 fixture 测试（--test-cmd 注入假命令 + CHECK_LOOP_ROOT 注入夹具根，不触真实 npm test 与 dotnet）
// 断言：①绿路径（假过 + 空夹具闭环）exit 0；②步骤 1 假败 exit 1 且不出全绿；
// ③步骤 2 配对断裂夹具 exit 1（verify 自身标记断言——孙进程 stdio inherit 输出不进本测试管道）；
// ④⑤⑥凭证落账三态（绿落带 testCmd 标记 / check-loop 红不落 / 无汇总行省略计数键）；
// ⑦生产模式（不给 --test-cmd）夹具根缺引擎脚本 → 首门 scripts-syntax 红、exit 1、落失败行——
//   拒绝装户仓静默跳门的假绿回落（2026-10-09 guardian-selfcheck 改口径）。
// 用法：node .agents/scripts/verify.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasFreshVerifyLine } from '../scripts/policy.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(SCRIPT_DIR, '..', 'scripts', 'verify.mjs'); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

// 空闭环夹具（四目录齐全、无文档 → check-loop 无断档；枚举单源随 fixture 内联——check-loop 启动段 fail-loud 要求）
const mkfix = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fix-'));
  for (const s of ['intents', 'specs', 'plans', 'incidents']) fs.mkdirSync(path.join(d, 'workflow', s), { recursive: true });
  fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(d, '.agents', 'config', 'workflow-enums.txt'), [
    'doc.status.all=draft approved done superseded cancelled',
    'doc.status.confirmed=approved done superseded cancelled',
    'doc.status.active=draft approved',
    'doc.status.terminal=done superseded cancelled',
    'doc.status.abandoned=superseded cancelled',
    'incident.status.all=open fixed closed',
    'incident.status.active=open',
    'level.all=L1 L2 L3',
    '',
  ].join('\n'), 'utf8');
  return d;
};
// 配对断裂夹具（L1 intent 无同名 plan → hard-block）
const mkBroken = () => {
  const d = mkfix();
  // 第 1 批降档（2026-10-21）起配对断裂降 WARN——红路径载体改为红线判低（仍 hard）：
  // L1 plan 勾触达红线 → 协作道不受理 STOP 级改动。
  fs.writeFileSync(path.join(d, 'workflow', 'plans', '2026-09-12-lonely.md'), [
    '---', '状态: done', '级别: L1', '日期: 2026-09-12', '---', '# PLAN — lonely', '',
    '## 改动面', '',
    '- [x] 改公共接口签名 → 级别至少 L2', '',
  ].join('\n'), 'utf8');
  return d;
};
// 假命令（绝对路径直调，不依赖 PATH，跨平台无引号问题）；out 可选输出汇总行
const mkCmd = (code, out = '') => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cmd-')), `exit${code}.mjs`);
  fs.writeFileSync(f, `process.stdout.write(${JSON.stringify(out)});process.exit(${code});`, 'utf8');
  return f;
};
const run = (argv, opts = {}) => spawnSync(process.execPath, [VERIFY, ...argv], { encoding: 'utf8', ...opts });

// ---- 场景 1：绿路径——假过 + 空夹具闭环 → exit 0 ----
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0)}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 1：exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  check('场景 1：两步全过且输出全绿', r.stdout.includes('✅ 1/2') && r.stdout.includes('✅ 2/2') && r.stdout.includes('全绿'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2：红路径步骤 1——假败 → exit 1、fail-fast 不出全绿；失败行留痕（2026-10-09）；
//              门输出留痕 tmp/verify-<id>.log + 尾部回显（2026-10-21 verify-diet ①）----
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(3, 'boom-line\n')}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 2：exit 1', r.status === 1, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  check('场景 2：步骤 1 失败标记在 stderr，且不输出全绿', r.stderr.includes('❌ 1/2') && !r.stdout.includes('全绿'), `${r.stdout}\n${r.stderr}`);
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const lines = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('场景 2：测试步红 → 失败行留痕（exitCode 3 + suite=test）',
    lines.length === 1 && lines[0].exitCode === 3 && lines[0].suite === 'test' && typeof lines[0].ts === 'string',
    `lines=${JSON.stringify(lines)}`);
  check('场景 2：失败行带归因（real）', lines[0].attribution === 'real', JSON.stringify(lines[0]));
  check('场景 2：stderr 回显归因', r.stderr.includes('归因 real'), r.stderr);
  const log = path.join(root, 'tmp', 'verify-test.log');
  const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  check('场景 2：失败门输出落 tmp/verify-<id>.log（头部事实 + 完整 stdout）',
    logText.includes('# gate=test') && logText.includes('status=3') && logText.includes('boom-line'),
    `log=${logText.slice(0, 300)}`);
  check('场景 2：stderr 回显门输出尾部（红可当场定性）',
    r.stderr.includes('门输出尾部') && r.stderr.includes('boom-line') && String(lines[0]?.note || '').includes('log'),
    `stderr=${r.stderr.slice(-500)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：红路径步骤 2——配对断裂夹具 → exit 1 ----
{
  const root = mkBroken();
  const r = run(['--test-cmd', `node ${mkCmd(0)}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 3：exit 1', r.status === 1, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  check('场景 3：步骤 2 失败标记在 stderr，且不输出全绿', r.stderr.includes('❌ 2/2') && !r.stdout.includes('全绿'), `${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：绿路径凭证落账（2026-10-07 verify-evidence）——全绿后 fixture 台账出合法绿行 ----
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0, '合计: PASS 3 / FAIL 0\n')}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const line = fs.existsSync(vp) ? JSON.parse(fs.readFileSync(vp, 'utf8').trim()) : null;
  check('场景 4：全绿 → verifications.jsonl 落绿行（exitCode 0 + 计数捕获 + testCmd 夹具标记防混生产）',
    r.status === 0 && line !== null && line.exitCode === 0 && line.passed === 3 && line.failed === 0
      && line.testCmd === true && typeof line.ts === 'string' && r.stdout.includes('凭证已落账'),
    `exit=${r.status} line=${JSON.stringify(line)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4b：fixture 全绿不得触发摘要生成（2026-10-11 C4 守卫——假门凭证只进本地台账，不产 committed 摘要） ----
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0, '合计: PASS 3 / FAIL 0\n')}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  const ev = path.join(root, 'workflow', 'verify-evidence.md');
  check('场景 4b：fixture 绿 → 不生成 workflow/verify-evidence.md、输出无摘要生成标记',
    r.status === 0 && !fs.existsSync(ev) && !r.stdout.includes('已生成'),
    `exit=${r.status} exists=${fs.existsSync(ev)}\n${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 5：check-loop 红 → 失败行留痕、无绿行（2026-10-09 失败也留痕；绿行语义 = verify 全绿不变）----
{
  const root = mkBroken();
  const r = run(['--test-cmd', `node ${mkCmd(0)}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const lines = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('场景 5：npm test 绿但 check-loop 红 → 仅失败行（suite=check-loop），无绿行',
    r.status === 1 && lines.length === 1 && lines[0].exitCode !== 0 && lines[0].suite === 'check-loop',
    `exit=${r.status} lines=${JSON.stringify(lines)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 5b：失败行零污染凭证判定（hasFreshVerifyLine 只认 exitCode===0，2026-10-09）----
{
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const ok = hasFreshVerifyLine([
    JSON.stringify({ ts: iso(3600 * 1000), exitCode: 2, suite: 'test', note: 'x' }),   // 新鲜失败行
    JSON.stringify({ ts: iso(3600 * 1000 * 30), exitCode: 0, suite: 'npm test' }),     // 30h 前绿行（超窗）
  ], now);
  const ok2 = hasFreshVerifyLine([
    JSON.stringify({ ts: iso(3600 * 1000), exitCode: 2, suite: 'test', note: 'x' }),   // 失败行
    JSON.stringify({ ts: iso(3600 * 1000), exitCode: 0, suite: 'npm test' }),          // 新鲜绿行
  ], now);
  const none = hasFreshVerifyLine([
    JSON.stringify({ ts: iso(3600 * 1000), exitCode: 2, suite: 'test', note: 'x' }),
  ], now);
const fixtureOnly = hasFreshVerifyLine([
  JSON.stringify({ ts: iso(3600 * 1000), exitCode: 0, suite: 'all-gates', gates: 2, testCmd: true }), // 夹具绿行
], now);
const scopeOk = hasFreshVerifyLine([
  JSON.stringify({ ts: iso(3600 * 1000), exitCode: 0, suite: 'all-gates', gates: 10, scope: { mode: 'diff', base: 'abc1234', baseSource: 'ledger', skipped: ['backend-build', 'backend-test', 'frontend-lint', 'frontend-unit-test', 'frontend-build'], fileCount: 3 } }), // scope 增量绿行
], now);
check('场景 5b：失败行 + 过期绿行 → 无凭证（失败行不算绿）', ok === false, `ok=${ok}`);
check('场景 5b：失败行 + 新鲜绿行 → 有凭证（失败行不遮蔽绿行）', ok2 === true, `ok2=${ok2}`);
check('场景 5b：仅失败行 → 无凭证', none === false, `none=${none}`);
check('场景 5b：仅夹具 testCmd 绿行 → 无凭证（--test-cmd 不落关单凭证，2026-10-09）', fixtureOnly === false, `fixtureOnly=${fixtureOnly}`);
check('场景 5b：scope 增量绿行 → 关单凭证（verify-diet ②；面计算担保 + 先提交后跑门口径）', scopeOk === true, `scopeOk=${scopeOk}`);
}

// ---- 场景 6：输出无汇总行 → 计数键省略（exitCode 才是硬事实）----
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0, 'ok\n')}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const line = fs.existsSync(vp) ? JSON.parse(fs.readFileSync(vp, 'utf8').trim()) : null;
  check('场景 6：无汇总输出 → 绿行落盘但计数键省略',
    r.status === 0 && line !== null && line.exitCode === 0 && !('passed' in line) && !('failed' in line),
    `line=${JSON.stringify(line)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 8：--list 锁定引擎段在产品段之前，不执行门 ----
{
  const expect = [
    'scripts-syntax', 'engine-tests', 'workflows-check', 'rule-budget', 'local-gate-config', 'effective-policy', 'engine-map',
    'workflow-index', 'workflow-metrics',
    'check-loop', 'ledger-doc-presence', 'ledger-invariant', 'lane-surface-ci',
    // 安全段（2026-10-14 决定 4 / G5 插队，引擎段之后产品段之前）——依赖漏洞审计三门
    // （nuget-audit / frontend-audit-prod / frontend-audit-devtool）已于 2026-10-16 退役，余密钥扫描
    'secrets-scan',
    'frontend-lint', 'frontend-unit-test',
    'wiki-consistency', 'backend-build', 'backend-test', 'frontend-build',
  ];
  const r = run(['--list'], { env: { ...process.env, RUN_E2E: '' } });
  const ids = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  check('场景 8：--list exit 0 且引擎 13 门领前、wiki 在产品段',
    r.status === 0 && ids.length === expect.length && expect.every((id, i) => ids[i] === id)
      && ids.indexOf('wiki-consistency') > ids.indexOf('check-loop')
      && !String(r.stdout).includes('开始全量'),
    `exit=${r.status}\n${r.stdout}`);
}

// ---- 场景 8b：--engine 引擎段增量门（2026-10-11 C7 方案②；2026-10-13 ledger-invariant-ci 挂入第 7 位；
//      2026-10-22 改进 3 引擎地图漂移门挂入第 6 位；2026-10-24 复核加索引/指标/台账指针三门；
//      2026-10-25 优化1 local-gate-config 挂入第 4 位 → 13 门）----
{
  const r = run(['--list', '--engine'], { env: { ...process.env, RUN_E2E: '' } });
  const ids = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  check('场景 8b：--engine --list = 恰 13 门且全为引擎段、序不变',
    r.status === 0 && ids.length === 13
      && ['scripts-syntax', 'engine-tests', 'workflows-check', 'rule-budget', 'local-gate-config', 'effective-policy', 'engine-map', 'workflow-index', 'workflow-metrics', 'check-loop', 'ledger-doc-presence', 'ledger-invariant', 'lane-surface-ci'].every((id, i) => ids[i] === id),
    `exit=${r.status}\n${r.stdout}`);
}
{
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const engineGreen = hasFreshVerifyLine([
    JSON.stringify({ ts: iso(3600 * 1000), exitCode: 0, suite: 'all-gates', gates: 7, engineOnly: true }), // 引擎段绿行（未来回归防御）
    JSON.stringify({ ts: iso(3600 * 1000 * 30), exitCode: 0, suite: 'all-gates', gates: 15 }),               // 30h 前全量绿（超窗）
  ], now);
  check('场景 8b：仅引擎段绿行（engineOnly）→ 不构成关单凭证（hasFreshVerifyLine 纵深拦截）', engineGreen === false, `engineGreen=${engineGreen}`);
}

// ---- 场景 7：生产模式（不给 --test-cmd）+ 夹具根 → exit 1，拒假绿回落 ----
// 插件化形态（2026-10-27 迁移）口径修订：引擎脚本本体随插件分发且 guardian 门（scripts-syntax）扫的
// 就是插件 scripts/（paths.mjs 改道后恒在场）——夹具根再无「缺引擎脚本首门红」的旧触发条件。
// 不变的核心契约：生产模式在无台账/无产品面的夹具根上必须 exit 1、不出全绿、失败行留痕且零绿行
// （首红落在引擎段并发面，具体门随并发时序不定——只锁「有红且全是红」，不锁具体 suite）。
{
  const root = mkfix();
  const r = run([], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 7：exit 1 且不出全绿', r.status === 1 && !r.stdout.includes('全绿'), `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const lines = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('场景 7：失败行留痕且零绿行（拒假绿回落——有红、且留痕行全是失败行）',
    lines.length >= 1 && lines.every((l) => l.exitCode !== 0),
    `lines=${JSON.stringify(lines)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7b：默认档 = diff 面增量 + 24h 全量兜底（verify-scope-default 2026-10-22）----
// 语义两向钉住：①无全量绿行 → 默认档退回全量并显式打印兜底行（不静默降档）；
//              ②--full 显式全量 → 不起 scope、不打兜底行。均复用场景 7 夹具（首门即红，零额外成本）。
{
  const root = mkfix();
  const r = run([], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 7b：默认档无 24h 内全量绿行 → 打印兜底行（本次全量执法）',
    r.stdout.includes('24h 内无全量绿行') && r.stdout.includes('兜底'),
    `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  const rf = run(['--full'], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 7b：--full 显式全量 → 不起 scope、不打兜底行，裁决同默认兜底（exit 1）',
    rf.status === 1 && !rf.stdout.includes('24h 内无全量绿行') && !rf.stdout.includes('scope=diff'),
    `exit=${rf.status}\n${rf.stdout}\n${rf.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7c：仓库凭证兜底基线（verify-evidence-fallback 2026-10-22）----
// 新 worktree 无本地台账（.agents/verifications.jsonl 不存在）时，默认档/--scope 从入库的
// workflow/verify-evidence.md 取最近全量绿行作基线——不再必然重付全量税；非祖先/scope 行拒用。
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const baseSha = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-22-doc-only.md'), '# doc\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'doc only']);
  const nowIso = new Date().toISOString();
  const writeEvidence = (rows) => fs.writeFileSync(path.join(root, 'workflow', 'verify-evidence.md'), [
    '# 验证绿凭证摘要（生成物，勿手改）', '',
    '| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |',
    '|---|---|---|---|---|',
    ...rows, '',
  ].join('\n'), 'utf8');
  writeEvidence([
    `| \`${baseSha}\` | ${nowIso} | 15 | PASS 100 / FAIL 0 | — |`,
    '| `deadbee` | 2026-10-22T00:00:00.000Z | 10 | PASS 90 / FAIL 0 | scope=diff(base=deadbee,skip=6) |',
  ]);

  const r = run(['--scope', '--list'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  check('场景 7c：无本地台账 → 仓库凭证作基线（仓库凭证 + 跳过 5 门）',
    r.status === 0 && r.stdout.includes(`基线 ${baseSha}（仓库凭证）`) && r.stdout.includes('跳过 5 门'),
    `exit=${r.status}\n${r.stdout}\n${r.stderr}`);

  const rs = run(['--stub-gate', `node ${mkCmd(0)}`, '--scope'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const rows = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const green = rows.filter((e) => e.exitCode === 0 && e.suite === 'all-gates');
  const ev = fs.readFileSync(path.join(root, 'workflow', 'verify-evidence.md'), 'utf8');
  check('场景 7c：凭证基线落账 baseSource=evidence，摘要行标 src=evidence',
    rs.status === 0 && green.length === 1 && green[0].scope && green[0].scope.baseSource === 'evidence'
      && ev.includes(',src=evidence,skip=5)'),
    `exit=${rs.status} rows=${JSON.stringify(rows)}\n${rs.stderr}`);

  const rd = run([], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  check('场景 7c：默认档认仓库凭证为 24h 全量锚（起 scope、不打兜底行）',
    rd.stdout.includes('scope=diff') && rd.stdout.includes('（仓库凭证）') && !rd.stdout.includes('24h 内无全量绿行'),
    `exit=${rd.status}\n${rd.stdout}\n${rd.stderr}`);

  // 非祖先（别的分支 / rebase 残留）→ 拒用，回落 origin/main
  writeEvidence([`| \`deadbee\` | ${nowIso} | 15 | PASS 100 / FAIL 0 | — |`]);
  const r2 = run(['--scope', '--list'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  check('场景 7c：凭证行非 HEAD 祖先 → 拒用，回落 origin/main',
    r2.status === 0 && r2.stdout.includes('（origin/main）') && !r2.stdout.includes('（仓库凭证）'),
    `exit=${r2.status}\n${r2.stdout}\n${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 9：--stub-gate 走生产尾段（无 testCmd；2026-10-15）----
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'stub\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const r = run(['--stub-gate', `node ${mkCmd(0)}`], { env: { ...process.env, CHECK_LOOP_ROOT: root, RUN_E2E: '' } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const lines = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ev = fs.existsSync(path.join(root, 'workflow', 'verify-evidence.md'))
    ? fs.readFileSync(path.join(root, 'workflow', 'verify-evidence.md'), 'utf8') : '';
  check('场景 9：stub 单门 exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  check('场景 9：落 all-gates 且无 testCmd',
    lines.length === 1 && lines[0].suite === 'all-gates' && lines[0].exitCode === 0 && !('testCmd' in lines[0]),
    JSON.stringify(lines));
  check('场景 9：输出含门禁成本', String(r.stdout).includes('门禁成本'), r.stdout);
  check('场景 9：生成 verify-evidence.md', ev.includes('GENERATED:END') && /`[0-9a-f]{7,40}`/.test(ev), ev.slice(0, 400));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const env = { ...process.env, RUN_E2E: '' };
  delete env.CHECK_LOOP_ROOT;
  const r = run(['--stub-gate', 'node -e "process.exit(0)"'], { env });
  check('场景 9b：无 CHECK_LOOP_ROOT → exit 2，不跑门',
    r.status === 2 && String(r.stderr).includes('CHECK_LOOP_ROOT') && !String(r.stdout).includes('全绿'),
    `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
}
// ---- 场景 9c：门禁成本预算 advisory（gate-budget 2026-10-22）----
// 预算 1ms → 任何真实墙钟都超；只告警不阻断（exit 0），并点名「下一批须退役一门」。
{
  const root = mkfix();
  fs.writeFileSync(path.join(root, '.agents', 'config', 'gate-budgets.json'), JSON.stringify({ fullMs: 1, scopeMs: 1 }), 'utf8');
  const r = run(['--stub-gate', `node ${mkCmd(0)}`], { env: { ...process.env, CHECK_LOOP_ROOT: root, RUN_E2E: '' } });
  check('场景 9c：墙钟超预算 → advisory 行（不阻断，exit 0）',
    r.status === 0 && r.stdout.includes('超预算') && r.stdout.includes('下一批须退役一门') && r.stdout.includes('预算 0s'),
    `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 9d：flaky 隔离重跑（gate-health 2026-10-22）----
// 首跑红且命中 flaky 签名 → 重跑一次；重跑绿 → 判 flaky、绿行记 flaky 字段、exit 0。
{
  const root = mkfix();
  fs.writeFileSync(path.join(root, '.agents', 'config', 'gate-budgets.json'),
    JSON.stringify({ flakyRetry: true, flakyRetryGates: ['test'] }), 'utf8');
  const counter = path.join(root, 'flaky-counter.txt');
  const cmdFile = path.join(root, 'flaky-cmd.mjs');
  fs.writeFileSync(cmdFile, [
    "import fs from 'node:fs';",
    `const p = ${JSON.stringify(counter)};`,
    "const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0;",
    "fs.writeFileSync(p, String(n + 1));",
    "if (n === 0) { console.error('SqlException 1205 事务被选作死锁牺牲品'); process.exit(1); }",
    "console.log('合计: PASS 3 / FAIL 0');",
  ].join('\n'), 'utf8');
  const r = run(['--test-cmd', `node ${cmdFile}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const line = fs.existsSync(vp) ? JSON.parse(fs.readFileSync(vp, 'utf8').trim()) : null;
  check('场景 9d：flaky 首跑红 → 重跑绿 → exit 0 且绿行记 flaky',
    r.status === 0 && r.stdout.includes('🔁') && r.stdout.includes('判 flaky')
      && line !== null && line.exitCode === 0 && Array.isArray(line.flaky) && line.flaky.includes('test'),
    `exit=${r.status} line=${JSON.stringify(line)}\n${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 10：并行编排（2026-10-16 verify-parallel）——裁决与凭证不因并发档位改变 ----
// 并发只改「等待时长」，不改「谁跑、谁红、落什么账」：同一夹具在 --jobs 2 / --serial 下须同裁决同绿行。
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0, '合计: PASS 3 / FAIL 0\n')}`, '--jobs', '2'], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const line = fs.existsSync(vp) ? JSON.parse(fs.readFileSync(vp, 'utf8').trim()) : null;
  check('场景 10：--jobs 2 绿路径 exit 0、两步全过、落绿行（并发不改裁决）',
    r.status === 0 && r.stdout.includes('✅ 1/2') && r.stdout.includes('✅ 2/2') && r.stdout.includes('全绿')
      && line !== null && line.exitCode === 0 && line.testCmd === true,
    `exit=${r.status} line=${JSON.stringify(line)}\n${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0, '合计: PASS 3 / FAIL 0\n')}`, '--serial'], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 10：--serial 串行回退仍绿（并发档位可回退）',
    r.status === 0 && r.stdout.includes('✅ 1/2') && r.stdout.includes('✅ 2/2') && r.stdout.includes('并发 1·串行'),
    `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkfix();
  const r = run(['--test-cmd', `node ${mkCmd(0)}`, '--jobs', '0'], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 10：--jobs 0 → exit 2 fail-loud，不跑门',
    r.status === 2 && String(r.stderr).includes('--jobs 须为正整数') && !String(r.stdout).includes('全绿'),
    `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 11：--scope 守卫（verify-diet ②）——互斥与 fail-loud ----
{
  const root = mkfix();
  const r1 = run(['--scope', '--test-cmd', `node ${mkCmd(0)}`], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 11：--scope 与 --test-cmd 互斥 → exit 2 不跑门',
    r1.status === 2 && r1.stderr.includes('互斥') && !r1.stdout.includes('全绿'),
    `exit=${r1.status}\n${r1.stdout}\n${r1.stderr}`);
  const r2 = run(['--scope', '--list'], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 11：非 git 夹具根 --scope → fail-loud exit 2（基线解析失败拒增量）',
    r2.status === 2 && r2.stderr.includes('--scope') && !r2.stdout.includes('全绿'),
    `exit=${r2.status}\n${r2.stdout}\n${r2.stderr}`);
  const r3 = run(['--scope', '--engine', '--list'], { env: { ...process.env, CHECK_LOOP_ROOT: root } });
  check('场景 11：--scope 与 --engine 互斥 → exit 2（复核 P2 补测）',
    r3.status === 2 && r3.stderr.includes('互斥') && !r3.stdout.includes('全绿'),
    `exit=${r3.status}\n${r3.stdout}\n${r3.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 12：--scope diff 面增量关单（verify-diet ②）——真 git 夹具端到端 ----
// 文档面分支 → 产品重门与引擎自检门被裁（--list 9 门：引擎主干 7 + 密钥 + wiki 恒跑；engine-tests
// 按引擎面裁剪——verify-diet 二批 P0-1）；触及 frontend → 门自动回列；
// stub+scope 走生产尾段 → entry.scope 落台账、摘要行渲染 scope=diff(base=…,skip=N)。
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-21-doc-only.md'), '# doc-only plan\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'doc only']);

  const idsOf = (r) => String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).filter((l) => !l.startsWith('[verify]'));
  const r1 = run(['--scope', '--list'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const ids1 = idsOf(r1);
  check('场景 12a：文档面 --scope --list = 15 门（local-gate-config 引擎段恒跑；engine-tests 快档回列；产品重门与引擎自检仍按面裁）',
    r1.status === 0 && ids1.length === 15 && ids1.includes('wiki-consistency') && ids1.includes('secrets-scan')
      && ids1.includes('engine-tests')
      && !ids1.includes('backend-build') && !ids1.includes('backend-test')
      && !ids1.includes('frontend-lint') && !ids1.includes('frontend-build'),
    `exit=${r1.status} ids=${JSON.stringify(ids1)}\n${r1.stderr}`);

  // 复核 P1：untracked 文件必须入面——工作区躺着一个未 add 的后端文件 → 面触 backend → 全量 20 门（引擎自检 8 + 产品重门 6 + 常跑 6，见 verify.mjs GATES）
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'B_untracked.cs'), 'class B { }\n');
  const r1b = run(['--scope', '--list'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const ids1b = idsOf(r1b);
  check('场景 12a-2：untracked 后端文件入面 → backend 对回列（17 门；frontend 三门仍按面跳，engine-tests 快档回列）',
    r1b.status === 0 && ids1b.length === 17 && ids1b.includes('backend-build') && ids1b.includes('backend-test')
      && !ids1b.includes('frontend-lint') && !ids1b.includes('frontend-build') && ids1b.includes('engine-tests'),
    `exit=${r1b.status} ids=${JSON.stringify(ids1b)}\n${r1b.stderr}`);
  fs.rmSync(path.join(root, 'backend', 'B_untracked.cs'));
  fs.rmdirSync(path.join(root, 'backend'));

  const r2 = run(['--stub-gate', `node ${mkCmd(0)}`, '--scope'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const lines = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ev = fs.existsSync(path.join(root, 'workflow', 'verify-evidence.md'))
    ? fs.readFileSync(path.join(root, 'workflow', 'verify-evidence.md'), 'utf8') : '';
  check('场景 12b：stub+scope 全绿 → entry.scope 落台账（mode/base/skipped=5 + fastTests）',
    r2.status === 0 && lines.length === 1 && lines[0].exitCode === 0 && lines[0].scope
      && lines[0].scope.mode === 'diff' && Array.isArray(lines[0].scope.skipped) && lines[0].scope.skipped.length === 5
      && !lines[0].scope.skipped.includes('engine-tests') && lines[0].fastTests === true
      && typeof lines[0].scope.base === 'string',
    `exit=${r2.status} lines=${JSON.stringify(lines)}\n${r2.stderr}`);
  check('场景 12b：摘要行渲染 scope=diff(base=…,skip=5)',
    ev.includes('scope=diff(base=') && ev.includes(',skip=5)'),
    ev.slice(0, 600));

  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'x.ts'), 'export {};\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'touch frontend']);
  const r3 = run(['--scope', '--list'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const ids3 = idsOf(r3);
  check('场景 12c：触及 frontend → 前端三门回列（18 门），backend 对仍跳',
    r3.status === 0 && ids3.length === 18 && ids3.includes('frontend-lint') && ids3.includes('frontend-build')
      && ids3.includes('engine-tests')
      && !ids3.includes('backend-build') && !ids3.includes('backend-test'),
    `exit=${r3.status} ids=${JSON.stringify(ids3)}\n${r3.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 12d：变截面全触及（零裁剪）→ 绿行不挂 scope 标记 ----
// verify-scope-default 2026-10-22 修复：零裁剪的 scope 跑实质就是全量跑；若仍打 scope 标记，
// 该行不被认作「全量绿锚」（24h 兜底 + 基线 hint 双锚），基线冻结 → 变截面越滚越大 → 默认档永久退化。
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'C.cs'), 'class C { }\n');
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'c.ts'), 'export {};\n');
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'scripts', 'probe.mjs'), '// probe\n');
  const r = run(['--stub-gate', `node ${mkCmd(0)}`, '--scope'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  const rows = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last = rows[rows.length - 1];
  check('场景 12d：面全触及（零裁剪）→ 绿行不挂 scope 标记（实质全量，可作全量绿锚）',
    r.status === 0 && last && last.exitCode === 0 && !('scope' in last),
    `exit=${r.status} line=${JSON.stringify(last)}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
// ---- 场景 12e：双面触+引擎未触 → fast-only 绿行（无 scope 标记）不得作全量锚（2026-10-24 复核 P1-5）----
// 46564eb2 起该形态 skipped 为空 → 绿行不挂 scope 但 fastTests=true（engine-tests 用了 --fast）；
// 不排除则被当 lastFull 基线，后续增量担保建立在漏跑慢套件的树上。修复后：台账候选排除
// fastTests 行、仓库凭证解析排除 fast= 行 → 第二跑基线必须回落（不吃 fast 行的 head）。
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const baseShort = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);

  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'D.cs'), 'class D { }\n');
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'd.ts'), 'export {};\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'both faces']);
  const fastHead = git(['rev-parse', '--short', 'HEAD']).stdout.trim();

  const r1 = run(['--stub-gate', `node ${mkCmd(0)}`, '--scope'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const vp1 = path.join(root, '.agents', 'verifications.jsonl');
  const rows1 = fs.existsSync(vp1) ? fs.readFileSync(vp1, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last1 = rows1[rows1.length - 1];
  check('场景 12e：双面触+引擎未触 → 绿行 fastTests=true 且无 scope 标记（裁剪绿的伪装形态成立）',
    r1.status === 0 && last1 && last1.exitCode === 0 && last1.fastTests === true && !('scope' in last1),
    `exit=${r1.status} line=${JSON.stringify(last1)}\n${r1.stderr}`);

  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-21-after-fast.md'), '# after\n');
  // 撤走双面触文件：base..HEAD 树差只剩 workflow 文档 → 第二跑为纯文档面（scope 落 base 可观测；
  // 不删则第二跑仍双面触、又落一条 fast 行，基线选择不可见）
  git(['rm', '-q', 'backend/D.cs', 'frontend/d.ts']);
  git(['add', '-A']);
  git(['commit', '-qm', 'doc after fast']);
  const r2 = run(['--stub-gate', `node ${mkCmd(0)}`, '--scope'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const rows2 = fs.existsSync(vp1) ? fs.readFileSync(vp1, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last2 = rows2[rows2.length - 1];
  check('场景 12e：fast-only 绿行不作全量锚——第二跑基线回落 merge-base（base ≠ fast 行 head）',
    r2.status === 0 && last2 && last2.scope && typeof last2.scope.base === 'string'
      && last2.scope.base !== fastHead && last2.scope.base === baseShort,
    `exit=${r2.status} fastHead=${fastHead} line=${JSON.stringify(last2)}\n${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
// ---- 场景 12f：envSkips 绿行不得作全量锚（2026-10-27 anchor-envskip）----
// 形态：本地 diff 档 loud-skip 了 CI-only 门（ledger-invariant）→ 绿行 gates < 门表、无 scope、带 envSkips。
// 该形态在摘要里此前显示 `—`（外观同全量），实测 11 条被下游当基线用了 20 次。修复后：
// ①台账候选排除带 envSkips 的行；②凭证渲染 `skip-env=` 且 parseEvidenceGreens 拒收。
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const baseShort = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);

  // 手工落一条「伪全量」绿行：gates=15（< 当前门表）、无 scope、带 envSkips、head=HEAD
  const vp = path.join(root, '.agents', 'verifications.jsonl');
  fs.mkdirSync(path.dirname(vp), { recursive: true });
  fs.writeFileSync(vp, `${JSON.stringify({
    ts: new Date().toISOString(), exitCode: 0, suite: 'all-gates', gates: 15,
    headShort: baseShort, passed: 100, failed: 0, envSkips: ['ledger-invariant'],
  })}\n`, 'utf8');

  // 变一个文档面，第二跑应：不吃该行作基线（回落 origin/main），也不打兜底行
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-27-probe.md'), '# probe\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'doc only']);
  const r = run(['--stub-gate', `node ${mkCmd(0)}`, '--scope'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  const rows = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last = rows[rows.length - 1];
  check('场景 12f：envSkips 行不作全量锚——基线回落 origin/main（base ≠ 伪全量 head）',
    r.status === 0 && last && last.scope && last.scope.base === baseShort
      && last.scope.baseSource === 'origin/main',
    `exit=${r.status} base=${JSON.stringify(last && last.scope)}\n${r.stderr}`);

  // ② 凭证面：渲染 skip-env，且解析器拒收该行
  const { parseEvidenceGreens } = await import('../scripts/verify-scope.mjs');
  const parsed = parseEvidenceGreens([
    '| `aaa1111` | 2026-10-27T00:00:00.000Z | 15 | PASS 1 / FAIL 0 | skip-env=ledger-invariant |',
    '| `bbb2222` | 2026-10-27T00:00:01.000Z | 20 | PASS 1 / FAIL 0 | — |',
  ].join('\n'));
  check('场景 12f：parseEvidenceGreens 拒收 skip-env 行，保留真全量行',
    parsed.length === 1 && parsed[0].headShort === 'bbb2222', JSON.stringify(parsed));
  fs.rmSync(root, { recursive: true, force: true });
}
// ---- 场景 13：分层跑（2026-10-23）——diff 档 engine-tests 用 --fast，全量档不用 ----
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'scripts', 'probe.mjs'), '// probe\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'engine only']);
  const r = run(['--scope', '--list', '--verbose'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  check('场景 13：engine-code 触面 → engine-tests 全量（无 --fast）',
    r.status === 0 && r.stdout.includes('engine-tests\tnpm test') && !r.stdout.includes('engine-tests\tnpm test -- --fast'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}
// ---- 场景 13c：业务面（backend）→ engine-tests 快档回列，不整门跳过 ----
{
  const root = mkfix();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).stdout.trim()]);
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'Biz.cs'), 'class Biz { }\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'backend only']);
  const r = run(['--scope', '--list', '--verbose'], { env: { ...process.env, RUN_E2E: '', CHECK_LOOP_ROOT: root } });
  check('场景 13c：业务面触面 → engine-tests 用 --fast（不整门跳过）',
    r.status === 0 && r.stdout.includes('engine-tests\tnpm test -- --fast'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const r = run(['--full', '--list', '--verbose'], { env: { ...process.env, RUN_E2E: '' } });
  check('场景 13b：--full --list --verbose → engine-tests 全量（无 --fast）',
    r.status === 0 && r.stdout.includes('engine-tests\tnpm test') && !r.stdout.includes('engine-tests\tnpm test -- --fast'), r.stdout);
}

// ---- 场景 14：wiki 一致性门 optional 降级（2026-10-27 插件化迁移）----
// wiki 内容源项目专有、verify-wiki-consistency.mjs 不随插件分发——门表计数与序不变（场景 8 锁 20 门），
// 脚本缺失 → 门降级 SKIP（不算门红，跳过可见）；项目自带脚本在场（.agents/scripts/ 优先，scriptPath
// 回退链）→ 照常执法。判据单源 = verify.mjs 导出的 optionalGateMissing（本场景锁两态语义）。
{
  const { optionalGateMissing } = await import('../scripts/verify.mjs');
  const wikiGate = { id: 'wiki-consistency', optional: 'verify-wiki-consistency.mjs' };
  const plainGate = { id: 'secrets-scan' }; // 无 optional 标记的门不受判据影响
  const root = mkfix();
  check('场景 14：项目无脚本且插件未分发 → optional 门判缺失（降级 SKIP）',
    optionalGateMissing(wikiGate, root) === true, `${optionalGateMissing(wikiGate, root)}`);
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'scripts', 'verify-wiki-consistency.mjs'), '// 项目自带\n', 'utf8');
  check('场景 14：项目自带脚本在场（.agents/scripts/ 优先）→ 不降级，照常执法',
    optionalGateMissing(wikiGate, root) === false, `${optionalGateMissing(wikiGate, root)}`);
  check('场景 14：无 optional 标记的门恒不降级',
    optionalGateMissing(plainGate, root) === false, `${optionalGateMissing(plainGate, root)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log('\n用法：node .agents/scripts/verify.test.mjs');
  process.exit(1);
}
process.exit(0);
