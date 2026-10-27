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
import { tallyJudgments, recordRun, LEDGER_REL } from '../scripts/judgment-ledger.mjs';

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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
