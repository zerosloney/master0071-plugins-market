#!/usr/bin/env node
// agg-judgments.mjs — check-loop 判定流水月度聚合（judgment-ledger）
// 用法：node <插件根>/scripts/agg-judgments.mjs [--month=YYYY-MM]
//       node <插件根>/scripts/agg-judgments.mjs --retire-candidates [--months=6]
//       node <插件根>/scripts/agg-judgments.mjs --emit-month[=YYYY-MM]
// 源：.agents/judgments.jsonl（check-loop.mjs 每次真实运行追加一行，本地 gitignore；
//     缺文件 = 尚无运行记录，提示后 exit 0——与 delegations 台账「必在」不同，这是渐积数据）。
// 仓库级数据面（gate-metrics-shard 2026-10-22）：--emit-month 把某月聚合落成
//     workflow/gate-metrics.d/<YYYY-MM>.jsonl（每月一行，随提交入库；多机并集）。
//     --retire-candidates 读「本地台账 ∪ 分片」——换机/换树不再归零，退役判据才有燃料。
// 消费：mechanism-registry 月度对账（「触发统计口径」列的 WARN/BLOCK 计数）与 advisory→hard
//     升格 / 退役判定的直接查账面——替代原「人工 grep check-loop 输出」。
// --retire-candidates（2026-10-15 减重手段①，规则的死亡机制）：列出「连续 N 个有数据月零命中
//     （WARN+BLOCK 全为 0）」的规则作为退役候选——月度对账时按 mechanism-registry「退役判据」列
//     逐条裁决（安全主干/级别闭环主干等「不退役」行除外；「且 X 停滞」类附加条件由人判）。
//     台账不足 N 个数据月 → 数据不充分，不产候选（年轻遥测不得制造假候选）。判定口径 = 尾部
//     N 个「有运行的月」（非日历月——遥测断档的月不算零命中，防漏跑误判退役）。
// 测试：node <插件根>/test/agg-judgments.test.mjs（纯函数 aggFromRows / retireCandidates 进程内断言）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 路径收口（2026-10-27 插件化改道 paths.mjs）：项目根锚定单源。
import { findProjectRoot } from './paths.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// ROOT 解析（2026-10-27 插件化改道，与 check-query-contract / gen-effective-policy 同口径）：
//   项目 git 根（findProjectRoot）→ 旧锚 <script>/../..（源仓形态行为不变）。
// 修复前恒用旧锚：插件形态下 <plugin>/scripts/../.. = **插件目录的上级**（市场仓 plugins/）——
// 台账（项目级资产）读写到别人的 .agents/ 下，退役判据喂错数据面。
const ROOT = findProjectRoot() || path.resolve(SCRIPT_DIR, '..', '..');
const LEDGER = path.join(ROOT, '.agents', 'judgments.jsonl');

const argMonth = (process.argv.find((a) => a.startsWith('--month=')) || '').split('=')[1] || null;

// aggFromRows(rows, month)：按月×规则×级别聚合。rows = 已解析的台账行数组；
// month = 'YYYY-MM' 过滤（null = 全部）。输出 { byMonth: { 'YYYY-MM': { runs, rules: { rule: { WARN, BLOCK } } } } }。
export function aggFromRows(rows, month = null) {
  const byMonth = {};
  for (const row of rows || []) {
    if (typeof row.ts !== 'string' || !/^\d{4}-\d{2}/.test(row.ts)) continue;
    const ym = row.ts.slice(0, 7);
    if (month && ym !== month) continue;
    const b = (byMonth[ym] ||= { runs: 0, rules: {} });
    b.runs++;
    for (const r of Array.isArray(row.rules) ? row.rules : []) {
      if (!r || typeof r.rule !== 'string') continue;
      const cell = (b.rules[r.rule] ||= { WARN: 0, BLOCK: 0 });
      if (r.level === 'WARN') cell.WARN += r.count || 0;
      else if (r.level === 'BLOCK') cell.BLOCK += r.count || 0;
    }
  }
  return { byMonth };
}

function readRowsAt(root) {
  const p = path.join(root, '.agents', 'judgments.jsonl');
  if (!fs.existsSync(p)) return null;
  const rows = [];
  let bad = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

function readRows() {
  return readRowsAt(ROOT);
}

// ---- 月度分片（gate-metrics-shard 2026-10-22）----
// judgments.jsonl 是 per-worktree / gitignore 的本地台账——换机、换 worktree 即归零，退役判据
// （连续 N 月 = 0）永远缺燃料。分片 = 仓库级事实：workflow/gate-metrics.d/<YYYY-MM>.jsonl，
// 每月一行（与台账同构：ts + rules），多机并集（.gitattributes merge=jsonl-union）。
// 读侧 mergeJudgmentRows 按月×规则取 max（分片是月末快照，本地可能更新；max 幂等、不重复计）。
export const SHARD_DIR_REL = path.join('workflow', 'gate-metrics.d');

export function shardPath(root, ym) {
  return path.join(root, SHARD_DIR_REL, `${ym}.jsonl`);
}

/** 读全部分片 → 行数组（坏行跳过；目录缺失 = 空）。 */
export function readShards(root) {
  return readShardsDetailed(root).rows;
}

/** 同 readShards，但带坏行计数（2026-10-27：坏行此前静默跳过，退役候选口径看不到账本破损）。
 *  坏行仍不中断聚合（不因一行坏数据丢失整月事实），但计数必须出声——不可判定 ≠ 已放行。 */
export function readShardsDetailed(root) {
  const dir = path.join(root, SHARD_DIR_REL);
  if (!fs.existsSync(dir)) return { rows: [], bad: 0 };
  const rows = [];
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { bad++; }
    }
  }
  return { rows, bad };
}

/** 按月×规则聚合（内部用；与 aggFromRows 同口径，不做 month 过滤）。 */
function monthRuleCounts(rows) {
  const out = {};
  for (const row of rows || []) {
    if (typeof row.ts !== 'string' || !/^\d{4}-\d{2}/.test(row.ts)) continue;
    const ym = row.ts.slice(0, 7);
    const b = (out[ym] ||= { runs: 0, rules: {} });
    b.runs++;
    for (const r of Array.isArray(row.rules) ? row.rules : []) {
      if (!r || typeof r.rule !== 'string') continue;
      const cell = (b.rules[r.rule] ||= { WARN: 0, BLOCK: 0 });
      if (r.level === 'WARN') cell.WARN += r.count || 0;
      else if (r.level === 'BLOCK') cell.BLOCK += r.count || 0;
    }
  }
  return out;
}

/**
 * 合并本地台账行 ∪ 分片行：按月×规则取 max（幂等；同月不重复计）。
 * 返回合成行（每月一行，ts = 月初），可直接喂 aggFromRows / evaluate。
 */
export function mergeJudgmentRows(localRows, shardRows) {
  const a = monthRuleCounts(localRows);
  const b = monthRuleCounts(shardRows);
  const months = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = [];
  for (const ym of months) {
    const rules = {};
    for (const src of [a[ym], b[ym]]) {
      if (!src) continue;
      for (const [rule, cell] of Object.entries(src.rules)) {
        const cur = (rules[rule] ||= { WARN: 0, BLOCK: 0 });
        cur.WARN = Math.max(cur.WARN, cell.WARN);
        cur.BLOCK = Math.max(cur.BLOCK, cell.BLOCK);
      }
    }
    const list = [];
    for (const rule of Object.keys(rules).sort()) {
      const c = rules[rule];
      if (c.WARN) list.push({ rule, level: 'WARN', count: c.WARN });
      if (c.BLOCK) list.push({ rule, level: 'BLOCK', count: c.BLOCK });
    }
    out.push({ ts: `${ym}-01T00:00:00.000Z`, mode: 'monthly', rev: null, blockers: 0, warnings: 0, rules: list });
  }
  return out;
}

/** 读本地台账 + 分片并合并（退役判据的仓库级数据面）。 */
export function readAllJudgments(root = ROOT) {
  const local = readRowsAt(root);
  const localRows = local ? local.rows : [];
  const localBad = local ? local.bad : 0;
  const shard = readShardsDetailed(root);
  return {
    rows: mergeJudgmentRows(localRows, shard.rows),
    localRows,
    shardRows: shard.rows,
    // 坏行计数（2026-10-27）：此前此处恒 0 → 「跳过坏行 N」提示永不出现，账本破损静默。
    bad: localBad + shard.bad,
    missing: localRows.length === 0 && shard.rows.length === 0,
  };
}

/** 生成某月分片（幂等：本地 ∪ 既有分片取 max）。无命中记录 → 不写空分片；内容未变 → 不重写。 */
export function emitMonth(root, ym) {
  const local = readRowsAt(root);
  const localRows = (local ? local.rows : []).filter((r) => String(r.ts || '').slice(0, 7) === ym);
  const existing = readShards(root).filter((r) => String(r.ts || '').slice(0, 7) === ym);
  const merged = mergeJudgmentRows(localRows, existing).find((r) => String(r.ts).slice(0, 7) === ym);
  if (!merged || !merged.rules.length) return { written: false, reason: 'no-data' };
  const p = shardPath(root, ym);
  const next = `${JSON.stringify(merged)}\n`;
  let prev = '';
  try { prev = fs.readFileSync(p, 'utf8'); } catch { /* 首次生成 */ }
  if (prev === next) return { written: false, unchanged: true, path: p, rules: merged.rules.length };
  fs.mkdirSync(path.join(root, SHARD_DIR_REL), { recursive: true });
  fs.writeFileSync(p, next);
  return { written: true, changed: true, path: p, rules: merged.rules.length };
}

/** 默认月 = 上一个 UTC 日历月（月度聚合只归档已结束的月）。 */
export function prevMonthKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// retireCandidates(rows, windowMonths)：退役候选 = 「尾部 windowMonths 个有数据月零命中」的规则。
// 口径：数据月 = 该月至少一次运行（断档月不参与，不按零命中计）；候选须在全历史出现过（含只剩
//   零命中的月）且尾部窗口内 WARN+BLOCK 全 0。输出按全历史命中数升序（最冷门在前）。
//   rows 不足 windowMonths 个数据月 → { sufficient:false }——年轻遥测不产候选。
export function retireCandidates(rows, windowMonths = 6) {
  const { byMonth } = aggFromRows(rows);
  const months = Object.keys(byMonth).sort();
  if (months.length < windowMonths) {
    return { sufficient: false, dataMonths: months.length, windowMonths, candidates: [], recentHits: [] };
  }
  const trailing = new Set(months.slice(-windowMonths));
  const allRules = new Set();
  for (const ym of months) for (const r of Object.keys(byMonth[ym].rules)) allRules.add(r);
  const candidates = [];
  const recentHits = [];
  for (const rule of allRules) {
    let total = 0;
    let lastHit = null;
    let inWindow = 0;
    for (const ym of months) {
      const cell = byMonth[ym].rules[rule];
      const n = cell ? (cell.WARN + cell.BLOCK) : 0;
      total += n;
      if (n > 0) {
        lastHit = ym;
        if (trailing.has(ym)) inWindow += n;
      }
    }
    const row = { rule, total, lastHit };
    if (inWindow === 0) candidates.push(row);
    else recentHits.push(row);
  }
  candidates.sort((a, b) => a.total - b.total || a.rule.localeCompare(b.rule));
  recentHits.sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule));
  return {
    sufficient: true,
    dataMonths: months.length,
    windowMonths,
    windowFrom: months.slice(-windowMonths)[0],
    windowTo: months[months.length - 1],
    candidates,
    recentHits,
  };
}

function printRetireCandidates(read) {
  const wArg = Number((process.argv.find((a) => a.startsWith('--months=')) || '').split('=')[1]);
  const windowMonths = Number.isFinite(wArg) && wArg >= 1 ? Math.floor(wArg) : 6;
  const r = retireCandidates(read.rows, windowMonths);
  if (!r.sufficient) {
    console.log(`agg-judgments: 退役候选窗口 ${windowMonths} 个月——数据月仅 ${r.dataMonths} 个（台账 ${read.rows.length} 行），数据不充分不产候选。继续积累运行记录。`);
    return;
  }
  console.log(`退役候选（零命中窗口 ${r.windowFrom}..${r.windowTo}，共 ${r.windowMonths} 个数据月）——仅机械筛查，裁决走 mechanism-registry「退役判据」列（「不退役」主干除外）：`);
  if (!r.candidates.length) {
    // 口径诚实化（2026-10-27）：judgments 台账**只记命中行**——「全账零命中」的规则根本不在账内，
    // 因此「无候选」只说明「账内规则在尾部窗口内都有命中」，不代表「所有规则都有命中」（设计文档 §12.5）。
    console.log('  （无候选——尾部窗口内**账内规则**均有命中；全账零命中的规则不入账、不产候选，见设计文档 §12.5）');
  }
  for (const c of r.candidates) {
    console.log(`  候选  ${c.rule.padEnd(24)} 全历史命中 ${String(c.total).padStart(4)}  末次命中 ${c.lastHit || '—'}`);
  }
  for (const c of r.recentHits) {
    console.log(`  在役  ${c.rule.padEnd(24)} 全历史命中 ${String(c.total).padStart(4)}  末次命中 ${c.lastHit}`);
  }
  if (read.bad) console.error(`agg-judgments: 跳过坏行 ${read.bad}（JSON 解析失败，不中断聚合）`);
}

function main() {
  // --emit-month[=YYYY-MM]：把某月判定聚合落成入库分片（默认上一个 UTC 月）。
  const emitArg = process.argv.find((a) => a === '--emit-month' || a.startsWith('--emit-month='));
  if (emitArg) {
    const explicit = emitArg.includes('=') ? emitArg.split('=')[1] : '';
    const ym = explicit || prevMonthKey();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      console.error(`agg-judgments: --emit-month 须为 YYYY-MM（现 ${ym}）`);
      process.exit(2);
    }
    const r = emitMonth(ROOT, ym);
    if (r.reason === 'no-data') {
      console.log(`agg-judgments: ${ym} 无命中记录——不生成空分片（本地台账 ${(readRows()?.rows || []).length} 行）`);
      return;
    }
    if (r.unchanged) {
      console.log(`agg-judgments: ${ym} 分片已是最新（${r.rules} 条规则）`);
      return;
    }
    console.log(`✅ 已生成 ${path.relative(ROOT, r.path)}（${r.rules} 条规则）——随同提交入库（退役判据的仓库级燃料）`);
    return;
  }
  if (process.argv.includes('--retire-candidates')) {
    // 仓库级数据面：本地台账 ∪ 月度分片（换机/换树不再归零）。
    const all = readAllJudgments(ROOT);
    if (all.missing) {
      console.error(`agg-judgments: ${path.relative(ROOT, LEDGER)} 与 ${SHARD_DIR_REL} 均无记录——尚无运行记录（check-loop 真实运行一次即有一行）`);
      process.exit(0);
    }
    printRetireCandidates({ rows: all.rows, bad: all.bad });
    return;
  }
  const read = readRows();
  if (!read) {
    console.error(`agg-judgments: ${path.relative(ROOT, LEDGER)} 不存在——尚无运行记录（check-loop 真实运行一次即有一行）`);
    process.exit(0);
  }
  const { byMonth } = aggFromRows(read.rows, argMonth);
  const months = Object.keys(byMonth).sort();
  if (!months.length) {
    console.log(`agg-judgments: ${argMonth || '全部月份'} 无记录（台账共 ${read.rows.length} 行）`);
    return;
  }
  for (const ym of months) {
    const b = byMonth[ym];
    console.log(`📅 ${ym}｜运行 ${b.runs} 次`);
    const rules = Object.keys(b.rules).sort();
    if (!rules.length) { console.log('    （无规则判定）'); continue; }
    for (const rule of rules) {
      const { WARN, BLOCK } = b.rules[rule];
      console.log(`    ${rule.padEnd(24)} WARN×${WARN}  BLOCK×${BLOCK}`);
    }
  }
  if (read.bad) console.error(`agg-judgments: 跳过坏行 ${read.bad}（JSON 解析失败，不中断聚合）`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('agg-judgments.mjs');
if (isMain) main();
