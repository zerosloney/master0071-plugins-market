#!/usr/bin/env node
// agg-judgments.test.mjs — 判定流水聚合纯函数套件（2026-10-11 judgment-ledger）
// aggFromRows 进程内断言：按月分桶 / --month 过滤 / WARN·BLOCK 计数 / 坏 rules 字段容忍。
// retireCandidates（2026-10-15 减重手段①）：零命中窗口候选 / 数据不充分守卫 / 断档月不按零计。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggFromRows, retireCandidates, mergeJudgmentRows, readAllJudgments, emitMonth, shardPath } from '../scripts/agg-judgments.mjs';

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
{
  const mk = (ym, rule, level, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: [{ rule, level, count }] });
  const rows = [
    // 规则甲：2026-03 有命中（窗口 04..09 之外），其后零命中 → 候选（全历史 3）
    mk('2026-03', '规则甲', 'WARN', 3),
    // 规则乙：尾部窗口内 2026-08 仍有命中 → 在役
    mk('2026-08', '规则乙', 'BLOCK', 1),
    // 规则丙：仅 2026-03 出现过（窗口外）→ 候选（全历史 5，末次 2026-03）
    mk('2026-03', '规则丙', 'WARN', 5),
    // 6 个数据月铺满窗口 2026-04..2026-09（每月至少一次运行）
    ...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((ym) => mk(ym, '规则甲', 'WARN', 0)),
  ];
  const r = retireCandidates(rows, 6);
  check('S4 sufficient 且窗口起止正确', r.sufficient === true && r.windowFrom === '2026-04' && r.windowTo === '2026-09', JSON.stringify({ from: r.windowFrom, to: r.windowTo }));
  const cand = r.candidates.map((c) => c.rule);
  check('S4 规则甲/丙为候选、乙在役', cand.includes('规则甲') && cand.includes('规则丙') && !cand.includes('规则乙') && r.recentHits.some((x) => x.rule === '规则乙'), JSON.stringify(cand));
  check('S4 候选按全历史命中升序（甲3 < 丙5）', cand[0] === '规则甲' && cand[1] === '规则丙', JSON.stringify(cand));
  const jia = r.candidates.find((c) => c.rule === '规则甲');
  const bing = r.candidates.find((c) => c.rule === '规则丙');
  check('S4 全历史命中与末次命中月份', jia.total === 3 && jia.lastHit === '2026-03' && bing.total === 5 && bing.lastHit === '2026-03', JSON.stringify({ jia, bing }));
}

// ---- S5 数据不充分守卫：数据月 < 窗口 → 不产候选 ----
{
  const rows = [{ ts: '2026-10-01T00:00:00Z', mode: 'hard', rules: [{ rule: '规则甲', level: 'WARN', count: 1 }] }];
  const r = retireCandidates(rows, 6);
  check('S5 数据月 1 < 6 → sufficient=false 零候选', r.sufficient === false && r.dataMonths === 1 && r.candidates.length === 0, JSON.stringify(r));
}

// ---- S6 断档月不按零命中计：窗口取「有数据的月」（末 N 个数据月），断档月不参与 ----
{
  const mk = (ym, rule, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule, level: 'WARN', count }] : [] });
  // 数据月仅 2026-05 / 2026-08 / 2026-09（06-07 断档无运行）；规则甲 05 有命中、08/09 无 → 窗口=末 2 个数据月（08..09）
  const rows = [mk('2026-05', '规则甲', 2), mk('2026-08', '规则甲', 0), mk('2026-09', '规则甲', 0)];
  const r = retireCandidates(rows, 2);
  check('S6 窗口取末 2 个数据月（08..09，断档月跳过），甲窗口外命中 → 候选', r.sufficient === true && r.windowFrom === '2026-08' && r.windowTo === '2026-09' && r.candidates.some((c) => c.rule === '规则甲'), JSON.stringify(r));
}

// ---- S7 窗口边界：末月有命中不算候选 ----
{
  const mk = (ym, count) => ({ ts: `${ym}-15T00:00:00Z`, mode: 'hard', rules: count ? [{ rule: '规则乙', level: 'WARN', count }] : [] });
  const rows = [...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((ym) => mk(ym, 0)), mk('2026-09', 1)];
  const r = retireCandidates(rows, 6);
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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
