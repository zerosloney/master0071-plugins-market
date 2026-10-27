#!/usr/bin/env node
// agg-delegations.mjs 的 fixture 驱动测试（2026-09-24 随「台账结构漂移静默吞数据」修复引入）
// 被测脚本以脚本自身路径定位台账，故复制脚本进临时根（<tmp>/.agents/scripts/）后以 cwd=<tmp> 运行。
// 断言：①节标题缺失但表头合规 → 数据照常入账（本次事故形态回归）；②日期数据行在但表头不可识别 → exit 1 fail-loud；
//       ③空台账（表头合规、无数据行）→ exit 0 且提示为空；⑥表体内空行两侧数据行都入账；⑦部分截断 fail-loud；
//       ⑧主表+分片联合入账；⑨分片读失败 fail-loud；⑩分片内漂移文案带分片提示（2026-10-10 读失败出账）。
// 用法：node test/agg-delegations.test.mjs（在仓库任意目录执行均可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const SRC = path.join(SCRIPT_DIR, '..', 'scripts', 'agg-delegations.mjs');
const USAGE = '用法：node test/agg-delegations.test.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const mkfix = (ledgerText) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-delegations-test-'));
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'incidents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'), ledgerText, 'utf8');
  fs.copyFileSync(SRC, path.join(root, '.agents', 'scripts', 'agg-delegations.mjs'));
  // 分片读单源（2026-10-13）：agg-delegations 现 import ledger-shards，fixture 须一并复制
  fs.copyFileSync(path.join(SCRIPT_DIR, '..', 'scripts', 'ledger-shards.mjs'), path.join(root, '.agents', 'scripts', 'ledger-shards.mjs'));
  // ROOT 解析单源（2026-10-27 插件化改道）：agg-delegations 现 import paths.mjs（→git-core.mjs），fixture 一并复制
  fs.copyFileSync(path.join(SCRIPT_DIR, '..', 'scripts', 'paths.mjs'), path.join(root, '.agents', 'scripts', 'paths.mjs'));
  fs.copyFileSync(path.join(SCRIPT_DIR, '..', 'scripts', 'git-core.mjs'), path.join(root, '.agents', 'scripts', 'git-core.mjs'));
  return root;
};
const runAgg = (root, args = []) => spawnSync(process.execPath, [path.join(root, '.agents', 'scripts', 'agg-delegations.mjs'), ...args], { cwd: root, encoding: 'utf8' });

// ---- 场景 1：无 `## ` 节标题、表头合规（2026-09-24 事故形态）→ 数据照常入账 ----
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    '| 2026-09-23 | general-purpose(子代理) | 示例委派任务 | 一次通过 | fixture |',
    '| 2026-09-24 | executor(子代理) | 结果列拼错的示例行 | 成功 | fixture |',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 1：节标题缺失 + 表头合规 → exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 1：数据行入账（有效任务 1，非「台账为空」）', /有效任务 1（/.test(r.stdout) && !r.stdout.includes('台账为空'), r.stdout);
  check('场景 1：未知结果单列计数（不混入待修，2026-09-24 口径分离）', r.stdout.includes('待修 0、未知结果 1'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2：日期数据行在但表头不可识别 → fail-loud（不再静默「台账为空」）----
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| when | who | what | result | note |',
    '|------|-----|------|--------|------|',
    '| 2026-09-23 | executor | 表头被改的行 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 2：表头不可识别 → exit 1', r.status === 1, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 2：报错点名结构漂移', (r.stderr || '').includes('结构漂移'), r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：空台账（表头合规、无数据行）→ exit 0 且提示为空 ----
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '## 委派结果',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    '',
    '## 自做任务结果',
    '',
    '| 日期 | 任务一句话 | 结果 | 备注 |',
    '|------|------------|------|------|',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 3：空台账 → exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 3：提示台账为空', r.stdout.includes('台账为空'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6：表体内空行不截断（2026-10-10）→ 空行两侧数据行都入账 ----
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    '| 2026-10-09 | independent-reviewer | 空行前 | 一次通过 | fixture |',
    '',
    '| 2026-10-09 | executor | 空行后 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 6：表体内空行 → exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 6：空行两侧数据行都入账（有效任务 2）', /有效任务 2（/.test(r.stdout) && !r.stdout.includes('台账为空'), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6b：未记数在 stdout 与快照行按锚前/锚后分列（2026-10-17 unrecorded-anchor-split）----
// 政策明写存量不回填，故「未记 2」既可能是 2 条欠账、也可能是 1 欠账 + 1 存量——渲染必须可区分。
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|----------------|------------|------|------|----------|',
    '| 2026-10-08 | executor | 锚前存量行 | 返工×1 | fixture | |',
    '| 2026-10-13 | executor | 锚后欠记行 | 返工×1 | fixture | |',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 6b：exit 0', r.status === 0, `exit=${r.status}\n${r.stderr}`);
  check('场景 6b：stdout 分列「锚前存量1·锚后待记1」', /锚前存量1·锚后待记1/.test(r.stdout), r.stdout);
  check('场景 6b：快照行备注点名锚后待记与存量豁免', /返工原因锚后待记1（另有存量1按政策不回填）/.test(r.stdout), r.stdout);
  check('场景 6b：总数口径仍渲染在未记桶里（未记2，兼容旧读法）', /未记2/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6c：全为锚前存量的月 → 快照不得读成欠账 ----
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|----------------|------------|------|------|----------|',
    '| 2026-10-08 | executor | 存量甲 | 返工×1 | fixture | |',
    '| 2026-10-09 | executor | 存量乙 | 返工×1 | fixture | |',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 6c：全存量月 → 备注写「全为锚前存量（政策不回填，非欠账）」', /返工原因未记2全为锚前存量（政策不回填，非欠账）/.test(r.stdout), r.stdout);
  check('场景 6c：全存量月不出现「锚后待记」字样（避免误读为欠账）', !/锚后待记[1-9]/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7：说明文字把表结束后仍有日期行 → 部分截断 fail-loud（不再只在零行时报）----
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    '| 2026-10-09 | executor | 入账行 | 一次通过 | fixture |',
    '',
    '说明文字（非空、非表行，结束当前表）',
    '',
    '| 2026-10-09 | executor | 落在已结束的表之外 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  const r = runAgg(root);
  check('场景 7：部分截断 → exit 1', r.status === 1, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 7：报错点名台账被截断', (r.stderr || '').includes('台账被截断'), r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4-5：扩容门口径（2026-09-27 board-kb-p1 对齐 delegations.md：返工 0 / 无主兜底 / 连续两月）----
//     纯函数经动态 import（isMain 守卫下 import 不执行 main；2026-10-08 agents-hygiene 随 .cjs→.mjs 由 require 改 import）
const { metrics, gateMonth, expansionVerdict, readLedger, causeSummary, taskKey, countIncidents } = await import(pathToFileURL(path.join(SCRIPT_DIR, '..', 'scripts', 'agg-delegations.mjs')).href);

// 场景 4：审查反例——30 任务、2 主兜底、平均返工 0.25（旧口径四门全过，声明口径下必须 ❌）
{
  const rows = [
    ...Array.from({ length: 22 }, (_, i) => ({ scope: '委派', result: '一次通过' })),
    ...Array.from({ length: 6 }, (_, i) => ({ scope: '委派', result: '返工×1' })),
    { scope: '委派', result: '主兜底' }, { scope: '委派', result: '主兜底' },
  ];
  const m = metrics(rows);
  const g = gateMonth(m);
  check('场景 4：反例（2 主兜底 + 平均返工 0.25）门3 返工=0 ❌', g.items.find((i) => i.no === 3).ok === false, JSON.stringify(g.items));
  check('场景 4：反例门4 主兜底=0 ❌ 且 monthOk=false（声明口径下不达标）',
    g.items.find((i) => i.no === 4).ok === false && g.monthOk === false, `monthOk=${g.monthOk}`);
  const good = metrics([{ scope: '自做', result: '一次通过' }, { scope: '委派', result: '一次通过' }]);
  const g2 = gateMonth(good);
  check('场景 4：返工 0 + 无主兜底月 → 口径项全 ✅（样本护栏项单独列出）',
    g2.items.filter((i) => i.kind === '口径').every((i) => i.ok === true) && g2.items.find((i) => i.no === 1).ok === false,
    JSON.stringify(g2.items));
}
// 场景 4b：复核采纳不计入门 3；主兜底不因同一原因豁免门 4，也不再顺带撞开门 3（2026-10-12）
{
  const adopted = [
    ...Array.from({ length: 20 }, () => ({ scope: '委派', result: '一次通过', cause: '' })),
    ...Array.from({ length: 4 }, () => ({ scope: '委派', result: '返工×1', cause: '复核采纳' })),
    { scope: '委派', result: '返工×2', cause: '复核采纳' },
    { scope: '委派', result: '返工×1', cause: '' },
  ];
  const ma = metrics(adopted);
  const ga = gateMonth(ma);
  check('场景 4b：复核采纳 6 次留在测量列，门 3 只看未豁免的 1 次',
    ma.adoptedRework === 6 && ma.blockingRework === 1 && ma.reworkSum === 7 && ga.items.find((i) => i.no === 3).ok === false,
    JSON.stringify(ma));
  const cleanAdopt = [
    ...Array.from({ length: 20 }, () => ({ scope: '委派', result: '一次通过', cause: '' })),
    ...Array.from({ length: 5 }, () => ({ scope: '委派', result: '返工×1', cause: '复核采纳' })),
  ];
  const mc = metrics(cleanAdopt);
  const gc = gateMonth(mc);
  check('场景 4b：只有复核采纳时门 3 ✅，实现面一次通过率 100%（(20+5)/25）→ 门 2 ✅；混合 80% 仅测量列（2026-10-14 度量分层）',
    mc.blockingRework === 0 && gc.items.find((i) => i.no === 3).ok === true
    && mc.implPassRate === 1 && gc.items.find((i) => i.no === 2).ok === true && mc.passRate === 0.8,
    JSON.stringify({ passRate: mc.passRate, implPassRate: mc.implPassRate, items: gc.items }));
  const fb = metrics([
    ...Array.from({ length: 20 }, () => ({ scope: '委派', result: '一次通过', cause: '' })),
    { scope: '委派', result: '主兜底', cause: '复核采纳' },
  ]);
  const gf = gateMonth(fb);
  check('场景 4b：主兜底写复核采纳仍 ❌ 门 4，且不计入门 3',
    gf.items.find((i) => i.no === 4).ok === false && gf.items.find((i) => i.no === 3).ok === true && fb.blockingRework === 0 && fb.fallback === 1,
    JSON.stringify(gf.items));
}
// 场景 17：实现面一次通过率（2026-10-14 度量分层）——门 2 改挂实现面，复核采纳行计入分子；门 7 观察项不挡门
{
  const rows = [
    ...Array.from({ length: 15 }, () => ({ scope: '委派', result: '一次通过', cause: '' })),
    ...Array.from({ length: 5 }, () => ({ scope: '委派', result: '返工×1', cause: '角色契约' })),
    ...Array.from({ length: 5 }, () => ({ scope: '委派', result: '返工×1', cause: '复核采纳' })),
  ];
  const m = metrics(rows);
  const g = gateMonth(m);
  check('场景 17：实现面一次通过率 =（15 一次通过 + 5 复核采纳）/25 = 80% ❌ 门 2；混合 60% 仅测量',
    m.implPassRate === 0.8 && m.adoptedRows === 5 && m.passRate === 0.6 && g.items.find((i) => i.no === 2).ok === false,
    JSON.stringify({ implPassRate: m.implPassRate, passRate: m.passRate, items: g.items }));
  const i7 = g.items.find((i) => i.no === 7);
  check('场景 17：门 7 评审 P2 密度为观察项（ok=null 不挡门，报出复核采纳行数 5）',
    i7 && i7.ok === null && i7.desc.includes('5') && i7.kind === '观察' && g.monthOk === false,
    JSON.stringify(i7));
  const clean = metrics([
    ...Array.from({ length: 20 }, () => ({ scope: '委派', result: '一次通过', cause: '' })),
    ...Array.from({ length: 5 }, () => ({ scope: '委派', result: '返工×1', cause: '复核采纳' })),
  ]);
  const gc = gateMonth(clean);
  check('场景 17：复核采纳抬实现面到 100% 而非拉低（混合 80% 不再误伤实现面达标月）→ 门 2 ✅',
    clean.implPassRate === 1 && gc.items.find((i) => i.no === 2).ok === true,
    JSON.stringify({ implPassRate: clean.implPassRate, items: gc.items }));
}
// 场景 5：连续两月判定四态
{
  check('场景 5：本月+上月均达标 → ✅ 可扩容', expansionVerdict(true, true, false, []).includes('✅'));
  check('场景 5：本月达标、上月无数据 → ⚠️ 1/2', expansionVerdict(true, undefined, true, []).includes('⚠️'));
  check('场景 5：本月达标、上月未达标 → ⚠️ 1/2', expansionVerdict(true, false, false, []).includes('⚠️'));
  check('场景 5：本月未达标 → ❌ 且列出未达标项号', expansionVerdict(false, true, false, [{ no: 3, ok: false }, { no: 4, ok: false }]).match(/❌.*3\+4/));
}

// 场景 5c：返工原因聚合（2026-10-11 C3）——枚举入桶、空/非枚举计未记、一次通过行不入统计
{
  const rows = [
    { scope: '委派', result: '返工×1', cause: '任务边界' },
    { scope: '委派', result: '返工×2', cause: '任务边界' },
    { scope: '委派', result: '返工×1', cause: '角色契约' },
    { scope: '委派', result: '主兜底', cause: '' },                 // 存量/漏填 → 未记
    { scope: '自做', result: '返工×1', cause: '备注文本占位' },      // 非枚举 → 未记（存量行备注位不误伤）
    { scope: '委派', result: '一次通过', cause: '' },                // 一次通过不入原因统计
  ];
  const c = causeSummary(rows);
  check('场景 5c：枚举值直方图（任务边界2·角色契约1）', c.hist['任务边界'] === 2 && c.hist['角色契约'] === 1, JSON.stringify(c));
  check('场景 5c：空与非枚举计未记（2）', c.unrecorded === 2, `unrecorded=${c.unrecorded}`);
  check('场景 5c：渲染串含桶与未记', c.text.includes('任务边界2') && c.text.includes('未记2'), c.text);
  const none = causeSummary([{ scope: '委派', result: '一次通过', cause: '' }]);
  check('场景 5c：全一次通过 → 空串（不输出原因行）', none.text === '' && none.unrecorded === 0, JSON.stringify(none));
  const adopted = causeSummary([{ scope: '委派', result: '返工×1', cause: '复核采纳' }]);
  check('场景 5c：复核采纳是枚举，不计未记', adopted.hist['复核采纳'] === 1 && adopted.unrecorded === 0, JSON.stringify(adopted));
  const judged = causeSummary([{ scope: '委派', result: '返工×1', cause: '', judgedFailure: true }]);
  check('场景 5c：判读表的实现失败单列，不计未记', judged.hist['实现失败'] === 1 && judged.unrecorded === 0, JSON.stringify(judged));
}

// 场景 5d：未记数锚前/锚后分列（2026-10-17 unrecorded-anchor-split）——
// 锚前留空是政策（存量不回填），锚后留空才是真欠记；混报会让快照读起来像欠账。
{
  const rows = [
    { scope: '委派', date: '2026-10-08', result: '返工×1', cause: '' },      // 锚前存量
    { scope: '委派', date: '2026-10-10', result: '主兜底', cause: '乱填值' }, // 锚前存量（非枚举同归未记）
    { scope: '委派', date: '2026-10-13', result: '返工×1', cause: '' },      // 锚后待记（政策要求必填却空）
    { scope: '委派', date: '2026-10-14', result: '返工×1', cause: '环境' },  // 已记，不入未记
  ];
  const c = causeSummary(rows);
  check('场景 5d：总数口径不变（unrecorded=3，兼容旧断言与直方图串）', c.unrecorded === 3 && c.text.includes('未记3'), JSON.stringify(c));
  check('场景 5d：锚前存量 2 / 锚后待记 1 分列', c.unrecordedPre === 2 && c.unrecordedSince === 1, JSON.stringify(c));
  check('场景 5d：分列之和等于总数（不重不漏）', c.unrecordedPre + c.unrecordedSince === c.unrecorded, JSON.stringify(c));
  const noDate = causeSummary([{ scope: '委派', result: '返工×1', cause: '' }]);
  check('场景 5d：无日期行按待记对待（不静默归入存量）', noDate.unrecordedSince === 1 && noDate.unrecordedPre === 0, JSON.stringify(noDate));
  const allPre = causeSummary([{ scope: '委派', date: '2026-09-01', result: '返工×1', cause: '' }]);
  check('场景 5d：全存量月 → 待记 0（快照据此判「非欠账」）', allPre.unrecordedSince === 0 && allPre.unrecordedPre === 1, JSON.stringify(allPre));
  // 分列不得改判据：同一批行，门 3 只看 blockingRework，与未记数无关
  const g = gateMonth(metrics(rows.map((r) => ({ ...r, scope: '委派' }))));
  check('场景 5d：未记分列不影响门 3 判据（仍读实现失败返工 3）',
    g.items.find((i) => i.no === 3).desc.includes('实现失败返工 3=0'), JSON.stringify(g.items));
}

// ---- 场景 8-10：readLedger(root) 参数化后进程内测（2026-10-10 读失败 fail-loud + 分片提示）----

// 场景 8：主台账 + delegations.d/ 分片联合读取 → 两边数据行都入账
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 任务一句话 | 结果 | 备注 |',
    '|------|------------|------|------|',
    '| 2026-10-01 | 主表自做任务 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  const shardDir = path.join(root, 'workflow', 'delegations.d');
  fs.mkdirSync(shardDir);
  fs.writeFileSync(path.join(shardDir, 'a.md'), [
    '',
    '| 日期 | 任务一句话 | 结果 | 备注 |',
    '|------|------------|------|------|',
    '| 2026-10-02 | 分片自做任务 | 一次通过 | fixture |',
    '',
  ].join('\n'), 'utf8');
  const rows = readLedger(root);
  check('场景 8：主表+分片联合读取 → 共 2 行', rows.length === 2, JSON.stringify(rows));
  check('场景 8：主表行与分片行都在', rows.some((r) => r.date === '2026-10-01') && rows.some((r) => r.date === '2026-10-02'), JSON.stringify(rows));
  fs.rmSync(root, { recursive: true, force: true });
}

// 场景 9：分片读失败 → fail-loud 抛错（不再静默吞掉导致指标缺数）
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 任务一句话 | 结果 | 备注 |',
    '|------|------------|------|------|',
    '| 2026-10-01 | 主表自做任务 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  const shardDir = path.join(root, 'workflow', 'delegations.d');
  fs.mkdirSync(shardDir);
  fs.mkdirSync(path.join(shardDir, 'bad.md')); // 目录 → readFileSync 抛 EISDIR
  let thrown = null;
  try { readLedger(root); } catch (err) { thrown = err; }
  check('场景 9：分片读失败 → 抛 Error（fail-loud）', thrown instanceof Error, String(thrown));
  check('场景 9：报错含分片文件名与「分片读取失败」', !!thrown && thrown.message.includes('bad.md') && thrown.message.includes('分片读取失败'), thrown && thrown.message);
  fs.rmSync(root, { recursive: true, force: true });
}

// 场景 10：分片内结构漂移（孤立日期行不入账）→ 漂移/截断文案点名分片
{
  const root = mkfix([
    '# 量化证据台账（fixture）',
    '',
    '| 日期 | 任务一句话 | 结果 | 备注 |',
    '|------|------------|------|------|',
    '| 2026-10-01 | 主表自做任务 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  const shardDir = path.join(root, 'workflow', 'delegations.d');
  fs.mkdirSync(shardDir);
  // 孤立表格行：日期开头数据行但不带表头 → splitTables 不入账，dated 计数（2）> 入账数（1）触发哨兵
  fs.writeFileSync(path.join(shardDir, 'a.md'), '\n| 2026-01-01 | x | 一次通过 |\n', 'utf8');
  let thrown = null;
  try { readLedger(root); } catch (err) { thrown = err; }
  check('场景 10：分片内漂移 → 抛错且文案带分片提示', !!thrown && thrown.message.includes('分片'), thrown && thrown.message);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 11-14：--write 机器落表（2026-10-11 snapshot-machine-write）----
// 端到端（spawn，脚本复制进临时根 → ROOT 解析到 fixture）：只写目标月、历史行冻结、verdict 走全月链、幂等、缺标记 fail-loud。
const GEN_BEGIN = '<!-- GENERATED:BEGIN — agg-delegations.mjs --write 托管（同月重写、他月不触碰、按月升序；手工行写在本标记之外） -->';
const GEN_END = '<!-- GENERATED:END -->';
{
  const region = [
    GEN_BEGIN,
    '',
    '| 月份 | 有效任务 | 一次通过率 | 平均返工次数 | 主兜底占比 | 月度 incident | 扩容门 | 备注 |',
    '|------|----------|------------|--------------|------------|---------------|--------|------|',
    '| 2026-08 | 30 | 90% | 0.00 | 0% | 1 | 手工历史行（冻结） | 手工 |',
    '',
    GEN_END,
  ].join('\n');
  const ledger = [
    '# 台账 fixture',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    ...Array.from({ length: 20 }, (_, i) => `| 2026-08-${String(i + 1).padStart(2, '0')} | executor | 任务${i} 2026-08-01-x.md | 一次通过 | f |`),
    '| 2026-09-15 | executor | 任务 2026-09-15-y.md | 返工×1 | f |',
    ...Array.from({ length: 20 }, (_, i) => `| 2026-10-${String(i + 1).padStart(2, '0')} | executor | 任务${i} 2026-10-01-z.md | 一次通过 | f |`),
  ].join('\n');
  const root = mkfix(ledger + '\n\n## 月度聚合快照\n\n' + region + '\n');
  let r = runAgg(root, ['--month=2026-10', '--write']);
  check('场景 11：--write exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  const after = fs.readFileSync(path.join(root, 'workflow', 'delegations.md'), 'utf8');
  check('场景 11：目标月机器行落表（20 全过 + 落表时点备注）',
    /\| 2026-10 \| 20 \| 100% \| 100% \| 0\.00 \| — \| 0% \| 0 \|/.test(after) && /；落表 \d{4}-\d{2}-\d{2} \|/.test(after), after);
  check('场景 11：新列表头在位（实现面一次通过率 / 返工原因分布，2026-10-14 度量分层）',
    after.includes('| 月份 | 有效任务 | 一次通过率 | 实现面一次通过率 | 平均返工次数 | 返工原因分布 | 主兜底占比 | 月度 incident | 扩容门 | 备注 |'), after);
  check('场景 11：verdict 走全月链（10 月达标 + 9 月未达标 → ⚠️ 连续性 1/2，非「上月无数据」）',
    after.includes('⚠️ 本月达标（连续性 1/2——上月未达标）'), after);
  check('场景 11：历史 2026-08 手工行冻结不触碰', after.includes('| 2026-08 | 30 | 90% | 0.00 | 0% | 1 | 手工历史行（冻结） | 手工 |'), after);
  check('场景 11：GEN 标记保留在位', after.includes(GEN_BEGIN) && after.includes(GEN_END));
  r = runAgg(root, ['--month=2026-10', '--write']);
  const after2 = fs.readFileSync(path.join(root, 'workflow', 'delegations.md'), 'utf8');
  check('场景 12：二跑幂等（内容零变化，非重复插入）', r.status === 0 && after2 === after, r.stdout + r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 场景 13：缺 GENERATED 标记 → fail-loud（不在手工内容区静默写表）
  const ledger = [
    '# 台账 fixture',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    '| 2026-10-05 | executor | 任务 2026-10-05-x.md | 一次通过 | f |',
  ].join('\n');
  const root = mkfix(ledger + '\n\n## 月度聚合快照\n\n（尚未安装标记区）\n');
  const r = runAgg(root, ['--month=2026-10', '--write']);
  check('场景 13：缺 GENERATED 标记 → exit 1 且点名缺标记',
    r.status === 1 && (r.stdout + r.stderr).includes('缺 GENERATED 标记'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 场景 14：目标月无台账数据 → exit 1 拒写（不静默落空行）
  const ledger = [
    '# 台账 fixture',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 |',
    '|------|----------------|------------|------|------|',
    '| 2026-09-15 | executor | 任务 2026-09-15-y.md | 一次通过 | f |',
  ].join('\n');
  const root = mkfix(ledger + '\n\n## 月度聚合快照\n\n' + [GEN_BEGIN, '', GEN_END].join('\n') + '\n');
  const r = runAgg(root, ['--month=2026-05', '--write']);
  check('场景 14：目标月无数据 → exit 1 拒写',
    r.status === 1 && (r.stdout + r.stderr).includes('无台账数据'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// 场景 15：空原因的返工×N 只读 rework-cause-legacy.md。显式原因优先。主兜底不豁免。
{
  const adoptTask = '采纳任务 workflow/specs/2026-10-01-a.md';
  const failTask = '失败任务 workflow/specs/2026-10-02-b.md';
  const explicitTask = '已写原因 workflow/specs/2026-10-03-c.md';
  const root = mkfix([
    '# 台账 fixture',
    '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|----------------|------------|------|------|------|',
    `| 2026-10-01 | reviewer | ${adoptTask} | 返工×1 | P0 0 / P1 0 | |`,
    `| 2026-10-02 | reviewer | ${failTask} | 返工×1 | P1×1 | |`,
    `| 2026-10-03 | reviewer | ${explicitTask} | 返工×1 | 备注 | 角色契约 |`,
    '| 2026-10-04 | reviewer | 兜底任务 | 主兜底 | 配额中断 | |',
    ...Array.from({ length: 20 }, (_, i) => `| 2026-10-${String(i + 5).padStart(2, '0')} | executor | 通过${i} | 一次通过 | f | |`),
  ].join('\n'));
  const legacy = [
    '# legacy fixture',
    '',
    '| 日期 | 范围 | 结果 | 任务键 | 判定 | 判据 |',
    '|---|---|---|---|---|---|',
    `| 2026-10-01 | 委派 | 返工×1 | ${taskKey(adoptTask)} | 复核采纳 | P0 与 P1 均为 0 |`,
    `| 2026-10-02 | 委派 | 返工×1 | ${taskKey(failTask)} | 实现失败 | P1 大于 0 |`,
    `| 2026-10-03 | 委派 | 返工×1 | ${taskKey(explicitTask)} | 复核采纳 | 不得覆盖显式原因 |`,
    `| 2026-10-04 | 委派 | 主兜底 | ${taskKey('兜底任务')} | 复核采纳 | 主兜底不读 |`,
    `| 2026-10-01 | 委派 | 返工×1 | ${taskKey(adoptTask)} | 实现失败 | 重复行应被忽略 |`,
  ].join('\n');
  fs.mkdirSync(path.join(root, 'workflow', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'archive', 'rework-cause-legacy.md'), legacy, 'utf8');
  const rows = readLedger(root);
  const adopt = rows.find((r) => r.date === '2026-10-01');
  const failed = rows.find((r) => r.date === '2026-10-02');
  const explicit = rows.find((r) => r.date === '2026-10-03');
  const fb = rows.find((r) => r.date === '2026-10-04');
  check('场景 15：空原因 + 复核采纳 → 原因列按表补上', adopt && adopt.cause === '复核采纳', JSON.stringify(adopt));
  check('场景 15：空原因 + 实现失败 → judgedFailure，原因仍空', failed && failed.judgedFailure === true && !failed.cause, JSON.stringify(failed));
  check('场景 15：显式原因优先于判读表', explicit && explicit.cause === '角色契约', JSON.stringify(explicit));
  check('场景 15：主兜底不因判读表改判', fb && fb.result === '主兜底' && fb.cause !== '复核采纳', JSON.stringify(fb));
  const g = gateMonth(metrics(rows.filter((r) => r.date.startsWith('2026-10'))));
  check('场景 15：门 3 被实现失败与显式返工挡住（2 次），主兜底仍挡门 4',
    g.items.find((i) => i.no === 3).ok === false && g.items.find((i) => i.no === 4).ok === false
    && metrics(rows).blockingRework === 2 && metrics(rows).adoptedRework === 1,
    JSON.stringify(g.items));
  fs.rmSync(root, { recursive: true, force: true });
}

// 场景 16：归档 incident 仍按文件名月份出账（2026-10-13 关单即归档——git mv 进 workflow/archive/<月>/incidents/
// 后文件名不变；若归档不出账，月度 incident 计数随归档静默缩水，扩容门的月度 incident 列失真）
{
  const root = mkfix([
    '# 台账 fixture',
    '',
    '| 日期 | 任务一句话 | 结果 | 备注 |',
    '|------|------------|------|------|',
    '| 2026-10-01 | 占位任务 | 一次通过 | fixture |',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-10-05-live.md'), '# 活跃', 'utf8');
  const archDir = path.join(root, 'workflow', 'archive', '2026-10', 'incidents');
  fs.mkdirSync(archDir, { recursive: true });
  fs.writeFileSync(path.join(archDir, '2026-10-08-archived.md'), '# 归档（10 月）', 'utf8');
  fs.writeFileSync(path.join(archDir, '2026-09-30-older.md'), '# 归档（9 月）', 'utf8');
  const c = countIncidents(root);
  check('场景 16：活跃 + 归档合并计数（2026-10 共 2 起）', c['2026-10'] === 2, JSON.stringify(c));
  check('场景 16：归档件按文件名月份入账（2026-09 共 1 起）', c['2026-09'] === 1, JSON.stringify(c));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log(`\n${USAGE}`);
  process.exit(1);
}
process.exit(0);
