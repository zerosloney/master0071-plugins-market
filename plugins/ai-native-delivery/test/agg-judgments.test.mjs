#!/usr/bin/env node
// agg-judgments.test.mjs — 判定流水聚合纯函数套件（2026-10-11 judgment-ledger）
// aggFromRows 进程内断言：按月分桶 / --month 过滤 / WARN·BLOCK 计数 / 坏 rules 字段容忍。
// retireCandidates（2026-10-15 减重手段①）：零命中窗口候选 / 数据不充分守卫 / 断档月不按零计。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggFromRows, retireCandidates, mergeJudgmentRows, readAllJudgments, emitMonth, shardPath, RETIRE_STALE_MONTHS, nowYmOf, dismissStats, dismissTotals, DISMISS_RATE_FLAG, DISMISS_MIN_SAMPLE } from '../scripts/agg-judgments.mjs';
import { evaluate as evaluateRegistry } from '../scripts/mechanism-retire-watch.mjs'; // S12 两侧对账断言

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const ROWS = [
  { ts: '2026-10-01T01:00:00Z', mode: 'hard', rules: [{ rule: '三件套不全', level: 'WARN', count: 2 }] },
  { ts: '2026-10-02T01:00:00Z', mode: 'hygiene', rules: [{ rule: '三件套不全', level: 'WARN', count: 1 }, { rule: '配对断裂', level: 'BLOCK', count: 1 }] },
  { ts: '2026-09-30T01:00:00Z', mode: 'hard', rules: [{ rule: '归因缺字段', level: 'WARN', count: 3 }] },
  { ts: '2026-10-03T01:00:00Z', mode: 'hard', rules: [] },
  { ts: 'bad-ts', mode: 'hard', rules: [] },
  { ts: '2026-10-04T01:00:00Z', mode: 'hard', rules: 'not-array' },
];

// ---- S1 按月分桶 + 计数 ----
{
  const { byMonth } = aggFromRows(ROWS);
  check('S1 两个月桶（坏 ts 行不计）', Object.keys(byMonth).sort().join(',') === '2026-09,2026-10', JSON.stringify(Object.keys(byMonth)));
  check('S1 2026-10 运行 4 次', byMonth['2026-10'].runs === 4, String(byMonth['2026-10'].runs));
  check('S1 跨行同规则 WARN 累加（2+1=3）', byMonth['2026-10'].rules['三件套不全'].WARN === 3, JSON.stringify(byMonth['2026-10'].rules));
  check('S1 BLOCK 计数独立', byMonth['2026-10'].rules['配对断裂'].BLOCK === 1);
  check('S1 2026-09 归因缺字段 WARN×3', byMonth['2026-09'].rules['归因缺字段'].WARN === 3);
  check('S1 空 rules 行只计 runs', byMonth['2026-10'].runs === 4 && byMonth['2026-10'].rules['配对断裂'].WARN === 0);
}

// ---- S2 month 过滤 ----
{
  const { byMonth } = aggFromRows(ROWS, '2026-09');
  check('S2 过滤单月只留 2026-09', Object.keys(byMonth).join(',') === '2026-09' && byMonth['2026-09'].runs === 1);
  check('S2 过滤无命中 → 空桶', aggFromRows(ROWS, '2025-01').byMonth['2025-01'] === undefined);
}

// ---- S3 空入参 ----
check('S3 空行数组 → 空 byMonth', Object.keys(aggFromRows([]).byMonth).length === 0);
check('S3 null 入参不 throw', Object.keys(aggFromRows(null).byMonth).length === 0);

// ---- S4 retireCandidates：零命中窗口出候选（6 个数据月，2 条规则） ----
// 2026-11 统一口径：窗口 = 以末个有数据月为锚的 N 个**日历月**（本例数据月连续 → 与日历窗同窗）。
{
  const mk = (ym, rule, level, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: [{ rule, level, count }] });
  const now = new Date('2026-10-01T00:00:00Z'); // 锚 2026-09，距今 1 个月 → 新鲜
  const rows = [
    // 规则甲：2026-03 有命中（窗口 04..09 之外），其后零命中 → 候选（全历史 3）
    mk('2026-03', '规则甲', 'WARN', 3),
    // 规则乙：尾部窗口内 2026-08 仍有命中 → 在役
    mk('2026-08', '规则乙', 'BLOCK', 1),
    // 规则丙：仅 2026-03 出现过（窗口外）→ 候选（全历史 5，末次 2026-03）
    mk('2026-03', '规则丙', 'WARN', 5),
    // 6 个数据月铺满日历窗口 2026-04..2026-09（每月至少一次运行）
    ...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((ym) => mk(ym, '规则甲', 'WARN', 0)),
  ];
  const r = retireCandidates(rows, 6, { now });
  check('S4 sufficient 且窗口起止正确（锚 09 的 6 个日历月）', r.sufficient === true && r.windowFrom === '2026-04' && r.windowTo === '2026-09' && r.anchor === '2026-09', JSON.stringify({ from: r.windowFrom, to: r.windowTo, anchor: r.anchor }));
  const cand = r.candidates.map((c) => c.rule);
  check('S4 规则甲/丙为候选、乙在役', cand.includes('规则甲') && cand.includes('规则丙') && !cand.includes('规则乙') && r.recentHits.some((x) => x.rule === '规则乙'), JSON.stringify(cand));
  check('S4 候选按全历史命中升序（甲3 < 丙5）', cand[0] === '规则甲' && cand[1] === '规则丙', JSON.stringify(cand));
  const jia = r.candidates.find((c) => c.rule === '规则甲');
  const bing = r.candidates.find((c) => c.rule === '规则丙');
  check('S4 全历史命中与末次命中月份', jia.total === 3 && jia.lastHit === '2026-03' && bing.total === 5 && bing.lastHit === '2026-03', JSON.stringify({ jia, bing }));
}

// ---- S5 观测史守卫：首数据月晚于窗口起点（年轻遥测不满窗）→ 不产候选 ----
{
  const rows = [{ ts: '2026-10-01T00:00:00Z', mode: 'hard', rules: [{ rule: '规则甲', level: 'WARN', count: 1 }] }];
  const r = retireCandidates(rows, 6, { now: new Date('2026-10-14T00:00:00Z') });
  check('S5 观测史不满 6 个月窗 → sufficient=false 零候选', r.sufficient === false && r.dataMonths === 1 && r.candidates.length === 0, JSON.stringify(r));
}

// ---- S6 日历窗口含无数据月（2026-11 统一口径）：断档月按零命中计，与 evaluate 对账一致 ----
// 旧口径「末 N 个数据月」：05 的命中把甲判成在役；retire-watch 的旧日历口径又因缺月拒绝判定
// ——同一句「连续 2 月 = 0」两种结论。统一后：锚 09、窗口 = 日历 [08, 09]，08 无运行按零计 →
// 甲为候选；同数据喂 mechanism-retire-watch.evaluate 也出 threshold 动作（两侧同判）。
{
  const mk = (ym, rule, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule, level: 'WARN', count }] : [] });
  const now = new Date('2026-10-01T00:00:00Z'); // 锚 09 距今 1 个月 → 新鲜
  const rows = [mk('2026-05', '规则甲', 2), mk('2026-09', '规则甲', 0)]; // 06-08 断档无运行
  const r = retireCandidates(rows, 2, { now });
  check('S6 日历窗 [08,09]、无数据月按零计 → 甲为候选（旧数据月口径判在役）',
    r.sufficient === true && r.windowFrom === '2026-08' && r.windowTo === '2026-09' && r.candidates.some((c) => c.rule === '规则甲'), JSON.stringify(r));
  const ev = evaluateRegistry(
    [{ name: '甲门', criterion: '「规则甲」', threshold: '连续 2 月 = 0', status: '现役', deadline: '—' }],
    rows, now);
  check('S6 对账：同数据 evaluate 同结论（threshold 动作，窗口一致）',
    ev.actions.length === 1 && ev.actions[0].kind === 'threshold' && ev.actions[0].detail.includes('2026-08') && ev.actions[0].detail.includes('2026-09'),
    JSON.stringify(ev.actions));
}

// ---- S7 窗口边界：末月有命中不算候选 ----
{
  const mk = (ym, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule: '规则乙', level: 'WARN', count }] : [] });
  const rows = [...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((ym) => mk(ym, 0)), mk('2026-09', 1)];
  const r = retireCandidates(rows, 6, { now: new Date('2026-10-01T00:00:00Z') });
  check('S7 末月命中 → 在役非候选', r.sufficient === true && !r.candidates.some((c) => c.rule === '规则乙') && r.recentHits.some((x) => x.rule === '规则乙'), JSON.stringify(r.candidates));
}

// ---- S8 月度分片：合并取 max / 幂等 / 无数据不写空分片 / 仓库级读 ----
{
  const local = [{ ts: '2026-09-10T00:00:00Z', rules: [{ rule: 'A', level: 'WARN', count: 3 }] }];
  const shard = [{ ts: '2026-09-01T00:00:00.000Z', rules: [{ rule: 'A', level: 'WARN', count: 5 }, { rule: 'B', level: 'BLOCK', count: 1 }] }];
  const merged = mergeJudgmentRows(local, shard);
  const sep = merged.find((r) => r.ts.startsWith('2026-09'));
  const a = sep.rules.find((r) => r.rule === 'A');
  const b = sep.rules.find((r) => r.rule === 'B');
  check('S8 合并取 max（A WARN 5 非 8）', a && a.count === 5, JSON.stringify(sep));
  check('S8 合并保留分片独有规则', b && b.count === 1, JSON.stringify(sep));
  check('S8 每月一行（同月不重复计）', merged.length === 1, JSON.stringify(merged));
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-shard-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'judgments.jsonl'), [
    JSON.stringify({ ts: '2026-09-10T00:00:00Z', rules: [{ rule: '规则甲', level: 'WARN', count: 2 }] }),
    JSON.stringify({ ts: '2026-10-01T00:00:00Z', rules: [{ rule: '规则乙', level: 'BLOCK', count: 1 }] }),
  ].join('\n') + '\n');
  const r1 = emitMonth(root, '2026-09');
  const shard = fs.readFileSync(shardPath(root, '2026-09'), 'utf8').trim();
  check('S8 emitMonth 写分片（只含目标月）', r1.written && shard.includes('规则甲') && !shard.includes('规则乙'), shard);
  const r2 = emitMonth(root, '2026-09');
  check('S8 emitMonth 幂等（重跑同内容 → unchanged，不重写）',
    r2.unchanged === true && fs.readFileSync(shardPath(root, '2026-09'), 'utf8').trim() === shard);
  const r3 = emitMonth(root, '2026-08');
  check('S8 无数据月不生成空分片', r3.written === false && !fs.existsSync(shardPath(root, '2026-08')));
  const all = readAllJudgments(root);
  check('S8 readAllJudgments 合并本地 ∪ 分片（2 个月，非 missing）',
    all.rows.length === 2 && all.missing === false && all.shardRows.length === 1, JSON.stringify(all.rows));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-empty-'));
  const all = readAllJudgments(root);
  check('S8 无台账无分片 → missing=true', all.missing === true && all.rows.length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S9 坏行计数出声（2026-10-27：--retire-candidates 路径此前恒传 bad=0，账本破损静默）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-bad-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'judgments.jsonl'), [
    JSON.stringify({ ts: '2026-09-10T00:00:00Z', rules: [{ rule: '规则甲', level: 'WARN', count: 2 }] }),
    '{ 这不是 JSON',           // 坏行 1
  ].join('\n') + '\n');
  fs.mkdirSync(path.join(root, 'workflow', 'gate-metrics.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'gate-metrics.d', '2026-09.jsonl'), [
    JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', rules: [{ rule: '规则甲', level: 'WARN', count: 4 }] }),
    '{ 也不是 JSON',            // 坏行 2
  ].join('\n') + '\n');
  const all = readAllJudgments(root);
  check('S9 坏行计数出声（本地 1 + 分片 1 = 2）', all.bad === 2, `bad=${all.bad}`);
  check('S9 坏行不中断聚合（好行仍入账）', all.rows.length === 1 && all.rows[0].rules.length === 1, JSON.stringify(all.rows));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S10 退役候选口径诚实化：无候选时不说「所有规则均有命中」（judgments 只记命中行）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-caliber-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  // 夹具须是 git 仓：agg-judgments 的 ROOT 按项目 git 根锚定（插件化改道 paths.mjs 同口径）
  spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', ['init', '-q'], { cwd: root });
  // 月份锚定「当前日历月往前 6 个月」（CLI 无 --now 注入口，固定月份夹具会在新鲜度守卫下随
  // 真实时钟漂红）：每月一行命中 → 账内规则窗口内均有命中 → 走「无候选」诚实化分支。
  const nowD = new Date();
  const months6 = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - 5 + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const row = (ym) => JSON.stringify({ ts: `${ym}-10T00:00:00Z`, rules: [{ rule: '规则甲', level: 'WARN', count: 1 }] });
  fs.writeFileSync(path.join(root, '.agents', 'judgments.jsonl'), months6.map(row).join('\n') + '\n');
  const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, '..', 'scripts', 'agg-judgments.mjs'), '--retire-candidates'], { cwd: root, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('S10 无候选 → 口径改为「账内规则」（不再宣称所有规则）',
    r.status === 0 && /无候选/.test(out) && /账内规则/.test(out) && !/所有规则均有命中/.test(out), out.slice(0, 400));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S11 新鲜度守卫（2026-11 统一口径）：锚月距今超过 RETIRE_STALE_MONTHS → 遥测陈旧不产候选 ----
// 旧口径无此守卫：停摆数月后旧的零命中照凑成「连续 N 月 = 0」照产候选。
{
  const mk = (ym, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule: '规则甲', level: 'WARN', count }] : [] });
  // 2026-01 留一次历史命中让规则甲入账（judgments 只记命中行，全零命中的规则不在账内）；
  // 窗口 = 锚 2026-05 的 3 个日历月 [03,04,05]，命中在窗外 → 新鲜时照产候选。
  const rows = [mk('2026-01', 2), ...['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((ym) => mk(ym, 0))];
  const staleNow = new Date('2026-09-01T00:00:00Z'); // 锚 2026-05 距今 4 个月 > RETIRE_STALE_MONTHS
  const r = retireCandidates(rows, 3, { now: staleNow });
  check('S11 锚月停摆 4 个月 → stale=true 且 sufficient=false 零候选',
    r.sufficient === false && r.stale === true && r.anchor === '2026-05' && r.candidates.length === 0, JSON.stringify(r));
  const freshNow = new Date('2026-06-15T00:00:00Z'); // 同数据、锚月距今 1 个月 → 新鲜，照常判定
  const r2 = retireCandidates(rows, 3, { now: freshNow });
  check('S11 对照：锚月新鲜 → 照常产候选（守卫只拦停摆，不拦正常断档）',
    r2.sufficient === true && r2.stale === false && r2.candidates.some((c) => c.rule === '规则甲'), JSON.stringify(r2));
  check('S11 RETIRE_STALE_MONTHS 导出面在位（两侧共用同一半径）', RETIRE_STALE_MONTHS === 2, String(RETIRE_STALE_MONTHS));
}

// ---- S12 两侧对账钉住（2026-11 统一口径）：同一月份数据，agg 候选与 evaluate 触达一致 ----
// 该夹具在旧双口径下两侧结论**相反**：旧 agg 取「末 3 个数据月」=[02,03,06]（02 的命中把甲判在役），
// 旧 evaluate 因缺月拒绝判定；统一日历窗后两侧都判「候选/触达」。
{
  const mk = (ym, rule, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule, level: 'WARN', count }] : [] });
  const now = new Date('2026-07-01T00:00:00Z'); // 锚 2026-06 距今 1 个月 → 新鲜
  const rows = [
    mk('2026-02', '规则甲', 2),      // 旧数据月口径会把这次命中算进末 3 个数据月 → 误判在役
    mk('2026-03', '填充运行', 0),
    mk('2026-06', '填充运行', 0),    // 04-05 断档无运行
  ];
  const rc = retireCandidates(rows, 3, { now });
  const ev = evaluateRegistry(
    [{ name: '甲门', criterion: '「规则甲」', threshold: '连续 3 月 = 0', status: '现役', deadline: '—' }],
    rows, now);
  const aggCand = rc.candidates.map((c) => c.rule);
  const evHit = ev.actions.filter((a) => a.kind === 'threshold').map((a) => a.name);
  check('S12 对账：agg 候选=[规则甲]，evaluate 触达=[甲门]（不再各说各话）',
    rc.sufficient === true && aggCand.join(',') === '规则甲' && evHit.join(',') === '甲门',
    JSON.stringify({ aggCand, evHit, rc: { from: rc.windowFrom, to: rc.windowTo, stale: rc.stale }, notAuto: ev.notAuto }));
  check('S12 对账：窗口一致（动作明细含同窗起止 2026-04..2026-06）',
    ev.actions.every((a) => a.detail.includes(rc.windowFrom) && a.detail.includes(rc.windowTo)),
    JSON.stringify(ev.actions));
}

// 信任边界收口（2026-11-09 审查收口）
{
  // ① rule 名为 __proto__ 的台账行（可来自跨机 merge=jsonl-union 提交）不得污染 Object.prototype
  const before = Object.prototype.WARN;
  const agg = aggFromRows([{ ts: '2026-01-15T00:00:00.000Z', rules: [{ rule: '__proto__', level: 'WARN', count: 3 }] }]);
  check('__proto__ 规则名不污染 Object.prototype', Object.prototype.WARN === before && ({}).WARN === undefined);
  const b = agg.byMonth['2026-01'];
  check('__proto__ 仍作自有键入账（计数不静默丢失）',
    Object.hasOwn(b.rules, '__proto__') && b.rules.__proto__.WARN === 3, JSON.stringify(Object.keys(b.rules)));
  // ② 月锚统一 UTC：东八区月初 0-8 点锚月与数据月（UTC ts 派生）不再错位 1
  check('nowYmOf 取 UTC 月（与 judgment-ledger 的 ISO ts 同基）',
    nowYmOf(new Date('2026-11-01T02:00:00+08:00')) === '2026-10' && nowYmOf(new Date('2026-10-31T23:00:00Z')) === '2026-10',
    nowYmOf(new Date('2026-11-01T02:00:00+08:00')));
}

// ---- S13 误拦面（2026-11 误拦遥测）：误拦率行 / 无 dismiss 不出行 / 高误拦率点名 / dismiss 行不污染命中面 ----
// 口径：误拦率 = dismiss/(命中+dismiss)；点名 = 率 ≥ DISMISS_RATE_FLAG(0.5) 且样本 ≥ DISMISS_MIN_SAMPLE(3)。
{
  const mkHit = (ts, rule, level, count) => ({ ts, mode: 'hard', rules: [{ rule, level, count }] });
  const mkD = (ts, rule) => ({ ts, kind: 'dismiss', rule, reason: '误拦' });
  const rows = [
    mkHit('2026-11-01T00:00:00Z', '规则甲', 'WARN', 5),
    mkD('2026-11-02T00:00:00Z', '规则甲'),
    mkD('2026-11-03T00:00:00Z', '规则甲'),
    mkHit('2026-11-04T00:00:00Z', '规则乙', 'BLOCK', 1),
    mkD('2026-11-05T00:00:00Z', '规则乙'),
    mkD('2026-11-06T00:00:00Z', '规则乙'),
    mkD('2026-11-07T00:00:00Z', '规则乙'),
    mkHit('2026-11-08T00:00:00Z', '规则丙', 'WARN', 2), // 无 dismiss → 不出行
  ];
  const s = dismissStats(rows);
  const jia = s.rows.find((x) => x.rule === '规则甲');
  const yi = s.rows.find((x) => x.rule === '规则乙');
  check('S13 甲行 命中5/dismiss2/误拦率=2/7（28.6%）',
    jia && jia.hits === 5 && jia.dismiss === 2 && jia.total === 7 && Math.abs(jia.rate - 2 / 7) < 1e-9, JSON.stringify(s.rows));
  check('S13 乙行 命中1/dismiss3/误拦率=0.75', yi && yi.hits === 1 && yi.dismiss === 3 && Math.abs(yi.rate - 0.75) < 1e-9, JSON.stringify(s.rows));
  check('S13 无 dismiss 的规则丙不出行', !s.rows.some((x) => x.rule === '规则丙'), JSON.stringify(s.rows));
  check('S13 高误拦率点名（乙 ≥50% 且样本 4 ≥3；甲 28.6% 不点名）',
    s.flagged.length === 1 && s.flagged[0].rule === '规则乙' && s.flagged[0].total === 4, JSON.stringify(s.flagged));
  check('S13 点名阈值导出在位（两面同阈值单源）', DISMISS_RATE_FLAG === 0.5 && DISMISS_MIN_SAMPLE === 3,
    `${DISMISS_RATE_FLAG}/${DISMISS_MIN_SAMPLE}`);
  check('S13 month 过滤（只看 2026-10 → 无行）', dismissStats(rows, '2026-10').rows.length === 0);
  // dismiss 行不污染命中面：非运行行（不计 runs）、不入 rules 计数
  const { byMonth } = aggFromRows(rows);
  check('S13 dismiss 行不计 runs（3 行命中运行）', byMonth['2026-11'].runs === 3, String(byMonth['2026-11'].runs));
  check('S13 dismiss 行不入 rules 计数（甲 WARN 5 / 乙 BLOCK 1）',
    byMonth['2026-11'].rules['规则甲'].WARN === 5 && byMonth['2026-11'].rules['规则乙'].BLOCK === 1,
    JSON.stringify(byMonth['2026-11'].rules));
  // dismissTotals 双源并计：本地 kind 行 + 分片/合并行 dismissals 数组
  const dt = dismissTotals([{ ts: '2026-11-02T00:00:00Z', kind: 'dismiss', rule: '规则甲' },
    { ts: '2026-11-01T00:00:00.000Z', dismissals: [{ rule: '规则甲', count: 2 }] }]);
  check('S13 dismissTotals 双源并计（1+2=3）', dt['规则甲'] === 3, JSON.stringify(dt));
}

// ---- S14 dismiss 走同分片机制：mergeJudgmentRows 并集携带 dismissals（max）/ emitMonth 落分片 / 退役候选旁注 ----
{
  const local = [
    { ts: '2026-11-05T00:00:00Z', mode: 'hard', rules: [{ rule: '规则甲', level: 'WARN', count: 2 }] },
    { ts: '2026-11-06T00:00:00Z', kind: 'dismiss', rule: '规则甲', reason: 'x' },
  ];
  const shard = [{ ts: '2026-11-01T00:00:00.000Z', rules: [{ rule: '规则甲', level: 'WARN', count: 4 }], dismissals: [{ rule: '规则甲', count: 2 }] }];
  const merged = mergeJudgmentRows(local, shard);
  const m = merged.find((r) => r.ts.startsWith('2026-11'));
  check('S14 合并行携带 dismissals（max：本地 1 ∪ 分片 2 → 2）',
    m && Array.isArray(m.dismissals) && m.dismissals.some((d) => d.rule === '规则甲' && d.count === 2), JSON.stringify(m));
  const mergedNoD = mergeJudgmentRows([{ ts: '2026-10-05T00:00:00Z', rules: [{ rule: 'A', level: 'WARN', count: 1 }] }], []);
  check('S14 无 dismiss 的月不带 dismissals 键（旧分片逐字节一致，幂等不重写）',
    !('dismissals' in mergedNoD[0]), JSON.stringify(mergedNoD[0]));
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-dismiss-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'judgments.jsonl'), [
    JSON.stringify({ ts: '2026-11-05T00:00:00Z', mode: 'hard', rules: [{ rule: '规则甲', level: 'WARN', count: 5 }] }),
    JSON.stringify({ ts: '2026-11-06T00:00:00Z', kind: 'dismiss', rule: '规则甲', reason: 'x' }),
    JSON.stringify({ ts: '2026-11-07T00:00:00Z', kind: 'dismiss', rule: '规则甲', reason: 'y' }),
  ].join('\n') + '\n');
  emitMonth(root, '2026-11');
  const shard = JSON.parse(fs.readFileSync(shardPath(root, '2026-11'), 'utf8').trim());
  check('S14 emitMonth 分片携带 dismissals（本地 2 次 dismiss）',
    Array.isArray(shard.dismissals) && shard.dismissals[0].rule === '规则甲' && shard.dismissals[0].count === 2, JSON.stringify(shard));
  check('S14 emitMonth 幂等（重跑 unchanged，不重写）', emitMonth(root, '2026-11').unchanged === true);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 退役候选旁注：窗口零命中判据不变（有 dismiss 也照出候选）；候选行只添 dismiss 计数
  const mk = (ym, rule, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule, level: 'WARN', count }] : [] });
  const now = new Date('2026-10-01T00:00:00Z'); // 锚 2026-09，距今 1 个月 → 新鲜
  const rows = [
    mk('2026-03', '规则甲', 3), // 窗口 2026-04..2026-09 之外 → 零命中窗口 → 候选（判据不变）
    ...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((ym) => mk(ym, '规则甲', 0)),
    { ts: '2026-09-20T00:00:00Z', kind: 'dismiss', rule: '规则甲', reason: '误拦' },
  ];
  const r = retireCandidates(rows, 6, { now });
  const jia = r.candidates.find((c) => c.rule === '规则甲');
  check('S14 候选判据不变（窗口零命中仍出候选）且旁注 dismiss=1',
    r.sufficient === true && jia && jia.total === 3 && jia.dismiss === 1, JSON.stringify(jia));
  const r2 = retireCandidates(rows.filter((x) => x.kind !== 'dismiss'), 6, { now });
  check('S14 对照：无 dismiss 行时候选照出、dismiss=0（旁注缺席不改变候选集）',
    JSON.stringify(r2.candidates.map((c) => c.rule)) === JSON.stringify(r.candidates.map((c) => c.rule))
    && r2.candidates[0].dismiss === 0, JSON.stringify(r2.candidates));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
