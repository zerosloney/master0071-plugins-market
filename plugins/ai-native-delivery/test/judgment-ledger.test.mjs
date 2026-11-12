#!/usr/bin/env node
// judgment-ledger.test.mjs — 判定流水落账套件（2026-10-11 judgment-ledger）
// 纯函数 tallyJudgments 进程内断言 + recordRun 落账行为（临时根目录 + 环境守卫）。
// 守卫口径：CHECK_LOOP_ROOT（fixture 模式）/ CHECK_LOOP_NO_LEDGER 任一在即不落账——
// 进程内切换环境变量须保存/恢复，防污染同进程后续用例。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tallyJudgments, recordRun, recordDismiss, LEDGER_REL } from '../scripts/judgment-ledger.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

// ---- S1 tallyJudgments：标签解析 / 级别分流 / 计数 / 确定性排序 ----
{
  const out = tallyJudgments(
    ['- [配对断裂] incident 缺 plan:x.md', '- [配对断裂] incident 缺 plan:y.md', '- [回路断档] 选「是」未指明 intent'],
    ['- [WARN 三件套不全] x.md 缺之 2', '- [WARN 归因缺字段] x.md 缺「来源:」', '- [WARN 三件套不全] y.md 缺之 3', '无标签散行'],
  );
  check('S1 BLOCK/WARN 分流计数', out.some((r) => r.rule === '配对断裂' && r.level === 'BLOCK' && r.count === 2)
    && out.some((r) => r.rule === '回路断档' && r.level === 'BLOCK' && r.count === 1)
    && out.some((r) => r.rule === '三件套不全' && r.level === 'WARN' && r.count === 2)
    && out.some((r) => r.rule === '归因缺字段' && r.level === 'WARN' && r.count === 1), JSON.stringify(out));
  check('S1 无标签行归「未标注」WARN', out.some((r) => r.rule === '未标注' && r.level === 'WARN' && r.count === 1), JSON.stringify(out));
  const keys = out.map((r) => r.level + r.rule);
  // 与实现同款 localeCompare 排序比对——被测不变量是「确定性」而非特定 collation（中文 locale 与码位排序不同）
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  check('S1 输出按 level+rule 排序（确定性）', JSON.stringify(keys) === JSON.stringify(sorted), JSON.stringify(keys));
  check('S1 空入参 → 空数组', tallyJudgments([], []).length === 0);
}

// ---- S1b 规则名归一（2026-10-22 门禁收敛批 3）：严重度前缀剥除 + 严重度取来源数组 ----
// 动机：同一逻辑规则因前缀写法不同被拆成两条 rule → per-rule 计数与「连续 6 月 = 0」退役候选判据失真
// （实证：s27 的「[NOTE 回归清单临时脚本缺失]」以带 NOTE 的全名落账，与无前缀写法分裂）
{
  const out = tallyJudgments(
    [],
    ['- [NOTE 回归清单临时脚本缺失] tmp/x.mjs 当前不在', '- [NOTE 回归清单临时脚本缺失] tmp/y.mjs 当前不在', '- [WARN 三件套不全] z.md 缺之 2'],
  );
  check('S1b NOTE 前缀剥除后规则名归一（两条并为一条 count=2）',
    out.some((r) => r.rule === '回归清单临时脚本缺失' && r.level === 'WARN' && r.count === 2)
    && !out.some((r) => /NOTE|WARN/.test(r.rule)), JSON.stringify(out));
  const blk = tallyJudgments(['- [NOTE 阻断级标注] x'], []);
  check('S1b NOTE 在 blockers 侧仍记 BLOCK（严重度取来源数组，不由标签前缀改写）',
    blk.some((r) => r.rule === '阻断级标注' && r.level === 'BLOCK'), JSON.stringify(blk));
  const warnTag = tallyJudgments(['- [WARN 应记阻断] x'], []);
  check('S1b blockers 侧的 WARN 前缀标签仍记 BLOCK（判定面=来源数组，与 check-loop 退出码同源）',
    warnTag.some((r) => r.rule === '应记阻断' && r.level === 'BLOCK'), JSON.stringify(warnTag));
}

// ---- S2 recordRun：真落账（临时根，rev 为 null 因非 git 目录）----
{
  const saved = { loopRoot: process.env.CHECK_LOOP_ROOT, noLedger: process.env.CHECK_LOOP_NO_LEDGER };
  delete process.env.CHECK_LOOP_ROOT;
  delete process.env.CHECK_LOOP_NO_LEDGER;
  try {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jledger-'));
    const now = new Date('2026-10-11T01:02:03.000Z');
    recordRun({ root: T, mode: 'hygiene', blockers: ['- [配对断裂] a'], warnings: ['- [WARN 归因缺字段] b'], now });
    const p = path.join(T, LEDGER_REL);
    const rows = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    check('S2 追加一行且字段齐（ts/mode/rev/计数/rules）',
      rows.length === 1 && rows[0].ts === '2026-10-11T01:02:03.000Z' && rows[0].mode === 'hygiene'
      && rows[0].blockers === 1 && rows[0].warnings === 1
      && Array.isArray(rows[0].rules) && rows[0].rules.length === 2, JSON.stringify(rows));
    recordRun({ root: T, mode: 'hard', blockers: [], warnings: [], now });
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    check('S2 二次调用追加不覆盖（append-only）', lines.length === 2, String(lines.length));
  } finally {
    if (saved.loopRoot !== undefined) process.env.CHECK_LOOP_ROOT = saved.loopRoot;
    if (saved.noLedger !== undefined) process.env.CHECK_LOOP_NO_LEDGER = saved.noLedger;
  }
}

// ---- S3 双守卫：CHECK_LOOP_ROOT / CHECK_LOOP_NO_LEDGER 任一在 → 不落账 ----
{
  const saved = { loopRoot: process.env.CHECK_LOOP_ROOT, noLedger: process.env.CHECK_LOOP_NO_LEDGER };
  try {
    for (const guard of ['CHECK_LOOP_ROOT', 'CHECK_LOOP_NO_LEDGER']) {
      delete process.env.CHECK_LOOP_ROOT;
      delete process.env.CHECK_LOOP_NO_LEDGER;
      process.env[guard] = '1';
      const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jledger-guard-'));
      recordRun({ root: T, mode: 'hard', blockers: [], warnings: [] });
      check(`S3 ${guard} 在 → 不落账`, !fs.existsSync(path.join(T, LEDGER_REL)));
    }
  } finally {
    if (saved.loopRoot !== undefined) process.env.CHECK_LOOP_ROOT = saved.loopRoot; else delete process.env.CHECK_LOOP_ROOT;
    if (saved.noLedger !== undefined) process.env.CHECK_LOOP_NO_LEDGER = saved.noLedger; else delete process.env.CHECK_LOOP_NO_LEDGER;
  }
}

// ---- S4 落账失败 fail-open（root 指向文件而非目录 → append 必败，只 stderr 不 throw）----
{
  const saved = { loopRoot: process.env.CHECK_LOOP_ROOT, noLedger: process.env.CHECK_LOOP_NO_LEDGER };
  delete process.env.CHECK_LOOP_ROOT;
  delete process.env.CHECK_LOOP_NO_LEDGER;
  try {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jledger-bad-'));
    const filePath = path.join(T, '.agents'); // 占住 .agents 为普通文件 → mkdirSync 必败
    fs.writeFileSync(filePath, 'not a dir');
    let threw = false;
    try {
      recordRun({ root: T, mode: 'hard', blockers: [], warnings: [] });
    } catch {
      threw = true;
    }
    check('S4 落账失败不 throw（fail-open）', threw === false);
  } finally {
    if (saved.loopRoot !== undefined) process.env.CHECK_LOOP_ROOT = saved.loopRoot; else delete process.env.CHECK_LOOP_ROOT;
    if (saved.noLedger !== undefined) process.env.CHECK_LOOP_NO_LEDGER = saved.noLedger; else delete process.env.CHECK_LOOP_NO_LEDGER;
  }
}

// ---- S5 端到端：真实 check-loop.mjs fixture 运行不落账（CHECK_LOOP_ROOT 守卫在 spawn 态同样生效）----
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jledger-e2e-'));
  for (const s of ['intents', 'specs', 'plans', 'incidents']) fs.mkdirSync(path.join(T, 'workflow', s), { recursive: true });
  fs.mkdirSync(path.join(T, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(T, '.agents', 'config', 'workflow-enums.txt'), 'doc.status.all=draft approved done superseded cancelled\ndoc.status.confirmed=approved done superseded cancelled\ndoc.status.active=draft approved\ndoc.status.terminal=done superseded cancelled\ndoc.status.abandoned=superseded cancelled\nincident.status.all=open fixed closed\nincident.status.active=open\nincident.source.all=self user test monitor\nincident.env.all=dev staging prod none\nlevel.all=L1 L2 L3\n');
  // 插件化落位：引擎脚本在 ../scripts/（2026-10-27 迁移；原与测试同目录的源仓形态）
  const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'check-loop.mjs'), '--hygiene'],
    { env: { ...process.env, CHECK_LOOP_ROOT: T }, cwd: T, encoding: 'utf8' });
  check('S5 fixture 态 spawn 运行不落账（守卫在子进程同样生效）',
    !fs.existsSync(path.join(T, LEDGER_REL)), `exit=${r.status} ${r.stderr || ''}`);
  fs.rmSync(T, { recursive: true, force: true });
}

// ---- S6 dismiss 登记三态（2026-11 误拦遥测）：正常落账 / 缺 reason 拒 / 规则名未知警告从权 ----
// dismiss 是人工登记动作（agent 被误拦后由人或 agent 代登记），append-only 同库；universe = 账内出现过的规则。
{
  const saved = { loopRoot: process.env.CHECK_LOOP_ROOT, noLedger: process.env.CHECK_LOOP_NO_LEDGER };
  delete process.env.CHECK_LOOP_ROOT;
  delete process.env.CHECK_LOOP_NO_LEDGER;
  try {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jledger-dismiss-'));
    const now = new Date('2026-11-12T00:00:00.000Z');
    // 先落一条命中——dismiss 的「未知规则名」判定以账内出现过的规则为 universe
    recordRun({ root: T, mode: 'hard', blockers: ['- [配对断裂] x'], warnings: [], now });
    const p = path.join(T, LEDGER_REL);
    const readRows = () => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    // ① 正常落账：kind:"dismiss" 行（规则名/原因/ts/rev 锚），追加不覆盖 run 行
    const r = recordDismiss({ root: T, rule: '配对断裂', reason: '误拦：白名单路径被拦', now });
    const rows = readRows();
    const d = rows.find((x) => x.kind === 'dismiss');
    check('S6 dismiss 正常落账（kind/rule/reason/ts 齐，非 git 目录 rev=null）',
      rows.length === 2 && d && d.rule === '配对断裂' && d.reason === '误拦：白名单路径被拦'
      && d.ts === '2026-11-12T00:00:00.000Z' && d.rev === null && r.ok === true && r.unknown === false,
      JSON.stringify(rows));
    check('S6 追加不覆盖（run 行在前，append-only 同库）', Array.isArray(rows[0].rules) && rows[1].kind === 'dismiss', JSON.stringify(rows.map((x) => Object.keys(x))));
    // ② 缺 reason 拒（fail-closed：登记动作垃圾进=账被污染）——throw 且不落账
    let threw = '';
    try { recordDismiss({ root: T, rule: '配对断裂', reason: '   ' }); } catch (e) { threw = String(e.message); }
    check('S6 缺 reason 拒（throw 且不落账）', threw.includes('reason') && readRows().length === 2, threw);
    let threwRule = '';
    try { recordDismiss({ root: T, rule: '', reason: 'x' }); } catch (e) { threwRule = String(e.message); }
    check('S6 缺规则名拒', threwRule.includes('规则名') && readRows().length === 2, threwRule);
    // ③ 规则名未知：stderr 警告一行，照登不误（从权）
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    let r3 = null;
    try { r3 = recordDismiss({ root: T, rule: '不存在规则', reason: 'x' }); } finally { console.error = orig; }
    const rows3 = readRows();
    check('S6 规则名未知警告从权（照登 + unknown=true + stderr 一行）',
      r3 && r3.unknown === true && rows3.some((x) => x.kind === 'dismiss' && x.rule === '不存在规则')
      && errs.some((m) => m.includes('不存在规则') && m.includes('从权')), JSON.stringify({ errs, n: rows3.length }));
    fs.rmSync(T, { recursive: true, force: true });
  } finally {
    if (saved.loopRoot !== undefined) process.env.CHECK_LOOP_ROOT = saved.loopRoot; else delete process.env.CHECK_LOOP_ROOT;
    if (saved.noLedger !== undefined) process.env.CHECK_LOOP_NO_LEDGER = saved.noLedger; else delete process.env.CHECK_LOOP_NO_LEDGER;
  }
}

// ---- S7 CLI 面：--dismiss/--reason 落账 + 缺 --reason 拒（exit 2）+ 未知规则名 stderr 警告 ----
// 写侧 fail-closed（与 confirm-doc 同口径）：CLI 须在使用项目的 git 仓库内运行——夹具 git init。
{
  const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jledger-cli-'));
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  spawnSync(git, ['init', '-q'], { cwd: T });
  // 留一个提交：rev 锚（shortRev）需 HEAD 存在——顺带让 S7 断言到「root 锚真的落了账」
  fs.writeFileSync(path.join(T, 'seed.txt'), 'seed\n');
  spawnSync(git, ['add', '.'], { cwd: T });
  spawnSync(git, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], { cwd: T });
  const p = path.join(T, LEDGER_REL);
  const r1 = spawnSync(process.execPath, [path.join(SCRIPTS, 'judgment-ledger.mjs'), '--dismiss', '规则甲', '--reason', '误拦样例', '--root', T], { cwd: T, encoding: 'utf8' });
  const rows1 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('S7 CLI 正常落账（exit 0 + kind:dismiss 行 + rev=git 短 rev）',
    r1.status === 0 && rows1.length === 1 && rows1[0].kind === 'dismiss' && rows1[0].rule === '规则甲'
    && typeof rows1[0].rev === 'string' && rows1[0].rev.length > 0,
    `exit=${r1.status} ${r1.stderr || ''}`);
  check('S7 CLI 未知规则名警告走 stderr（账空 → 从权照登）', /未知规则名/.test(r1.stderr || ''), r1.stderr || '');
  const n1 = rows1.length;
  const r2 = spawnSync(process.execPath, [path.join(SCRIPTS, 'judgment-ledger.mjs'), '--dismiss', '规则甲', '--root', T], { cwd: T, encoding: 'utf8' });
  const n2 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
  check('S7 CLI 缺 --reason 拒（exit 2、不落账、stderr 提示 reason）',
    r2.status === 2 && n2 === n1 && /reason/.test(r2.stderr || ''), `exit=${r2.status} ${r2.stderr || ''}`);
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
