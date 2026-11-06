#!/usr/bin/env node
// agg-judgments.test.mjs — 判定流水聚合纯函数套件（2026-10-11 judgment-ledger）
// aggFromRows 进程内断言：按月分桶 / --month 过滤 / WARN·BLOCK 计数 / 坏 rules 字段容忍。
// retireCandidates（2026-10-15 减重手段①）：零命中窗口候选 / 数据不充分守卫 / 断档月不按零计。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggFromRows, retireCandidates, mergeJudgmentRows, readAllJudgments, emitMonth, shardPath, RETIRE_STALE_MONTHS } from '../scripts/agg-judgments.mjs';
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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
