#!/usr/bin/env node
// agg-judgments.mjs — check-loop 判定流水月度聚合（judgment-ledger）
// 用法：node <插件根>/scripts/agg-judgments.mjs [--month=YYYY-MM]
//       node <插件根>/scripts/agg-judgments.mjs --retire-candidates [--months=6]
//       node <插件根>/scripts/agg-judgments.mjs --emit-month[=YYYY-MM]
//       （默认输出含「误拦面」节：每规则 命中/dismiss/误拦率——dismiss 由 judgment-ledger --dismiss
//        人工登记；≥50% 且样本 ≥3 点名「建议复评判据」advisory，不改退役判据）
// 源：.agents/judgments.jsonl（check-loop.mjs 每次真实运行追加一行，本地 gitignore；
//     另含人工登记的 kind:"dismiss" 误拦行（judgment-ledger --dismiss，见误拦面段注释）；
//     缺文件 = 尚无运行记录，提示后 exit 0——与 delegations 台账「必在」不同，这是渐积数据）。
// 仓库级数据面（gate-metrics-shard 2026-10-22）：--emit-month 把某月聚合落成
//     workflow/gate-metrics.d/<YYYY-MM>.jsonl（每月一行，随提交入库；多机并集——并集语义由
//     .gitattributes 的 merge=jsonl-union 保证，契约须同时覆盖 .agents/*.jsonl 与
//     workflow/gate-metrics.d/*.jsonl 两面，对质门 = check-local-gates ③ / check-local-gate-config）。
//     --retire-candidates 读「本地台账 ∪ 分片」——换机/换树不再归零，退役判据才有燃料。
// 消费：mechanism-registry 月度对账（「触发统计口径」列的 WARN/BLOCK 计数）与 advisory→hard
//     升格 / 退役判定的直接查账面——替代原「人工 grep check-loop 输出」。
// 双筛分工（2026-11-09 设计稿 ai-native-retire-universe 步骤 D 成文）：本脚本的退役筛是**规则级**
//     （universe = judgments 账内出现过的规则）；**机制级**筛（universe = 登记表全部现役行、含零命中
//     机制）在 mechanism-retire-watch——两筛窗口口径同款（日历窗 + 双守卫，注释互指如上）。
// --retire-candidates（2026-10-15 减重手段①，规则的死亡机制）：列出「连续 N 个日历月零命中
//     （WARN+BLOCK 全为 0）」的规则作为退役候选——月度对账时按 mechanism-registry「退役判据」列
//     逐条裁决（安全主干/级别闭环主干等「不退役」行除外；「且 X 停滞」类附加条件由人判）。
//     判定口径（2026-11 统一，与 mechanism-retire-watch.evaluate 同款、注释互指）：以「最近一个
//     有数据的月」为锚取 N 个**日历月**窗口（含无数据月，按零命中计）+ 双守卫——新鲜度守卫
//     （锚月距今超过 RETIRE_STALE_MONTHS 月 = 遥测停摆，不产候选，出「遥测陈旧」告警）与
//     观测史守卫（首数据月晚于窗口起点 = 年轻遥测不满窗，数据不充分不产候选）。
//     此前本侧取「末 N 个有数据的月」、retire-watch 取「日历窗+缺月拒判」，同一句「连续 N 月 = 0」
//     同数据两种结论（双口径漂移），本次统一为日历窗口语义。
//     universe 口径（2026-11-09 步骤 D 成文）：本筛是**规则级**筛——universe = judgments 账内出现过的
//     规则（零命中规则不入账、不入 universe）；登记表全集（含零命中机制）的**机制级**筛用
//     mechanism-retire-watch——勿把本筛当全集来源再误判盲区。
// 测试：node <插件根>/test/agg-judgments.test.mjs（纯函数 aggFromRows / retireCandidates 进程内断言）
import fs from 'node:fs';
import path from 'node:path';
// 路径收口（2026-10-27 插件化改道 paths.mjs）：项目根锚定单源。
import { findProjectRoot, projectRoot } from './paths.mjs';

// ROOT 解析（2026-10-28 收口，与 check-query-contract / gen-effective-policy 同口径）：
//   项目 git 根（findProjectRoot）→ cwd（projectRoot 的回退）。
// 此前回退是旧锚 <script>/../..：源仓形态下等于 <repo>（因为脚本在 <repo>/scripts/），但**插件形态下
// 它解析到插件目录的上级**（市场仓的 plugins/）——台账是项目级资产，读写到那里等于对别人的数据面
// 出手，且不会有任何报错。projectRoot() 的回退是 cwd：源仓测试夹具（脚本被复制进 <tmp>/.agents/scripts/
// 并以 cwd=<tmp> 运行）行为不变，插件形态则落在调用者所在的项目里。
const ROOT = findProjectRoot() || projectRoot();
const LEDGER = path.join(ROOT, '.agents', 'judgments.jsonl');

const argMonth = (process.argv.find((a) => a.startsWith('--month=')) || '').split('=')[1] || null;

// aggFromRows(rows, month)：按月×规则×级别聚合。rows = 已解析的台账行数组；
// month = 'YYYY-MM' 过滤（null = 全部）。输出 { byMonth: { 'YYYY-MM': { runs, rules: { rule: { WARN, BLOCK } } } } }。
// kind:"dismiss" 行跳过（2026-11 误拦遥测）：误拦登记非 check-loop 运行，不计 runs、不入 rules——
// 误拦另有 dismissStats 度量面，两面分开（命中面不被误拦行膨胀）。
export function aggFromRows(rows, month = null) {
  const byMonth = {};
  for (const row of rows || []) {
    if (typeof row.ts !== 'string' || !/^\d{4}-\d{2}/.test(row.ts)) continue;
    if (row.kind === 'dismiss') continue;
    const ym = row.ts.slice(0, 7);
    if (month && ym !== month) continue;
    const b = (byMonth[ym] ||= { runs: 0, rules: Object.create(null) });
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
  for (const line of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
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
// 每月一行（与台账同构：ts + rules），多机并集（.gitattributes 的 merge=jsonl-union 契约须同时
// 覆盖 workflow/gate-metrics.d/*.jsonl——月分片跨机合并走默认策略会静默丢别机快照；对质门见
// check-local-gates ③ / check-local-gate-config，2026-11 契约扩展）。
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

/** 按月×规则聚合（内部用；与 aggFromRows 同口径，不做 month 过滤）。
 *  误拦行（2026-11）路由到 dismissals 计数（不计 runs、不混 rules）；rules/dismissals 均空原型——
 *  规则名可来自跨机 merge=jsonl-union 提交，__proto__ 落普通对象即污染 Object.prototype
 *  （与 aggFromRows / mergeJudgmentRows 的空原型收口同纪律）。 */
function monthRuleCounts(rows) {
  const out = {};
  for (const row of rows || []) {
    if (typeof row.ts !== 'string' || !/^\d{4}-\d{2}/.test(row.ts)) continue;
    const ym = row.ts.slice(0, 7);
    const b = (out[ym] ||= { runs: 0, rules: Object.create(null), dismissals: Object.create(null) });
    if (row.kind === 'dismiss') {
      if (row.rule && typeof row.rule === 'string') b.dismissals[row.rule] = (b.dismissals[row.rule] || 0) + 1;
      continue;
    }
    b.runs++;
    for (const r of Array.isArray(row.rules) ? row.rules : []) {
      if (!r || typeof r.rule !== 'string') continue;
      const cell = (b.rules[r.rule] ||= { WARN: 0, BLOCK: 0 });
      if (r.level === 'WARN') cell.WARN += r.count || 0;
      else if (r.level === 'BLOCK') cell.BLOCK += r.count || 0;
    }
    // 月分片快照行自带 dismissals 数组（emitMonth 落的月末快照，非 kind 行）——同样入账；
    // 快照计数是月内合计，同月多行（跨机并集读出）取 max，与 rules 的幂等口径一致
    for (const d of Array.isArray(row.dismissals) ? row.dismissals : []) {
      if (d && typeof d.rule === 'string') b.dismissals[d.rule] = Math.max(b.dismissals[d.rule] || 0, d.count || 0);
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
    // 空原型（2026-11-09 审查收口）：规则名来自台账行，__proto__ 落普通对象即污染 Object.prototype
    const rules = Object.create(null);
    const dismissals = Object.create(null);
    for (const src of [a[ym], b[ym]]) {
      if (!src) continue;
      for (const [rule, cell] of Object.entries(src.rules || {})) {
        const cur = (rules[rule] ||= { WARN: 0, BLOCK: 0 });
        cur.WARN = Math.max(cur.WARN, cell.WARN);
        cur.BLOCK = Math.max(cur.BLOCK, cell.BLOCK);
      }
      // dismiss 并集同 max 语义（2026-11 误拦遥测）：分片是月末快照，本地可能更新，取 max 幂等不重复计
      for (const [rule, n] of Object.entries(src.dismissals || {})) {
        dismissals[rule] = Math.max(dismissals[rule] || 0, n);
      }
    }
    const list = [];
    for (const rule of Object.keys(rules).sort()) {
      const c = rules[rule];
      if (c.WARN) list.push({ rule, level: 'WARN', count: c.WARN });
      if (c.BLOCK) list.push({ rule, level: 'BLOCK', count: c.BLOCK });
    }
    const row = { ts: `${ym}-01T00:00:00.000Z`, mode: 'monthly', rev: null, blockers: 0, warnings: 0, rules: list };
    // dismissals 仅非空时携带——无 dismiss 的月与旧格式逐字节一致（emitMonth 幂等不重写既有分片）
    const dList = Object.keys(dismissals).sort().map((rule) => ({ rule, count: dismissals[rule] }));
    if (dList.length) row.dismissals = dList;
    out.push(row);
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

// ---- 误拦面（2026-11 误拦遥测：dismiss 记录由 judgment-ledger --dismiss 人工登记）----
// 「哪条规则在误伤」的度量面：每规则 命中数 / dismiss 数 / 误拦率 = dismiss/(命中+dismiss)。
// DISMISS_RATE_FLAG / DISMISS_MIN_SAMPLE：「建议复评判据」点名阈值（advisory）——误拦率 ≥50% 且
// 样本（命中+dismiss）≥3。只作点名与退役候选优先级旁注，不改任何判据（--retire-candidates 的
// 候选判据仍是零命中窗口，mechanism-retire-watch.evaluate 同判据不受影响）。
export const DISMISS_RATE_FLAG = 0.5;
export const DISMISS_MIN_SAMPLE = 3;

// dismissTotals(rows)：每规则 dismiss 计数（空原型——规则名可来自账外提交）。双源并计：
// 本地台账 kind:"dismiss" 行（一次一行）+ 月度分片/合并行的 dismissals 数组（月末快照计数）。
export function dismissTotals(rows) {
  const out = Object.create(null);
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind === 'dismiss') {
      if (row.rule && typeof row.rule === 'string') out[row.rule] = (out[row.rule] || 0) + 1;
      continue;
    }
    for (const d of Array.isArray(row.dismissals) ? row.dismissals : []) {
      if (d && typeof d.rule === 'string') out[d.rule] = (out[d.rule] || 0) + (d.count || 0);
    }
  }
  return out;
}

// dismissStats(rows, month)：误拦面。每规则 命中数（WARN+BLOCK 合计）/ dismiss 数 / 误拦率；
// 无 dismiss 记录的规则不出行。flagged = 点名清单（率 ≥ DISMISS_RATE_FLAG 且样本 ≥ DISMISS_MIN_SAMPLE）。
// month = 'YYYY-MM' 过滤（null = 全部），与 aggFromRows 同款行级过滤。
export function dismissStats(rows, month = null) {
  const scoped = (rows || []).filter((row) => row && typeof row === 'object'
    && typeof row.ts === 'string' && /^\d{4}-\d{2}/.test(row.ts)
    && (!month || row.ts.slice(0, 7) === month));
  const hits = Object.create(null);
  for (const row of scoped) {
    if (row.kind === 'dismiss') continue;
    for (const r of Array.isArray(row.rules) ? row.rules : []) {
      if (!r || typeof r.rule !== 'string') continue;
      hits[r.rule] = (hits[r.rule] || 0) + (r.count || 0);
    }
  }
  const dTotals = dismissTotals(scoped);
  const out = [];
  for (const rule of Object.keys(dTotals).sort()) {
    const hitsN = hits[rule] || 0;
    const dN = dTotals[rule];
    const total = hitsN + dN;
    out.push({ rule, hits: hitsN, dismiss: dN, total, rate: dN / total });
  }
  return { rows: out, flagged: out.filter((x) => x.rate >= DISMISS_RATE_FLAG && x.total >= DISMISS_MIN_SAMPLE) };
}

// calendarWindow(endYm, n)：以 endYm 为终点向前取 n 个日历月（含终点）。
// （2026-11 退役口径统一时自 mechanism-retire-watch.mjs 迁入：retireCandidates 与 evaluate 共用
// 同一窗口构造，单源在本文件；mechanism-retire-watch 转出该名，导出面不变。）
export function calendarWindow(endYm, n) {
  const [y, m] = String(endYm).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// monthDistance(fromYm, toYm)：两个 YYYY-MM 之间的日历月数（to − from，跨年安全）。
export function monthDistance(fromYm, toYm) {
  const [y1, m1] = String(fromYm).split('-').map(Number);
  const [y2, m2] = String(toYm).split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

// nowYmOf(d)：日历月 YYYY-MM，**UTC 基**（2026-11-09 审查收口）。数据侧 judgment-ledger.recordRun
// 落的是 UTC ISO ts（月键 = ts.slice(0,7)），旧实现取本地月——东区月初 0-8 点时锚月与数据月错位 1，
// 新鲜度守卫与命中归属整体偏移。两侧同基后此偏差消失。
export function nowYmOf(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 7);
}

// RETIRE_STALE_MONTHS：退役判定的新鲜度半径（日历月）。锚月（最近一个有数据的月）距今超过该
// 月数 = 遥测停摆，停摆期的零命中不可作退役证据。取 2 留余量：月度分片在次月初归档，当月或
// 上月有运行即算新鲜。两侧共用（mechanism-retire-watch.evaluate 同一守卫，注释互指）。
export const RETIRE_STALE_MONTHS = 2;

// retireCandidates(rows, windowMonths, { now, staleMonths })：退役候选 = 「以末个有数据月为锚的
// windowMonths 个日历月（含无数据月）零命中」的规则。
// 口径（2026-11 统一，与 mechanism-retire-watch.evaluate 同款、注释互指）：
//   - 锚 = 最近一个有数据的月；窗口 = calendarWindow(锚, N) 的 N 个**日历月**——窗口内无数据的
//     月按零命中计（不再「只数有数据的月」：旧口径同一句「连续 N 月 = 0」与 retire-watch 的
//     日历窗两解，同数据可出相反结论）。
//   - 新鲜度守卫：锚月距今（nowYmOf(now)）超过 staleMonths（默认 RETIRE_STALE_MONTHS）→ 遥测
//     停摆，不产候选（stale=true，sufficient=false，调用方出「遥测陈旧」告警）。
//   - 观测史守卫：首数据月晚于窗口起点 → 观测史不满窗（年轻遥测），数据不充分不产候选。
// 候选须在全历史出现过（judgments 只记命中行，全账零命中的规则不入账）且窗口内 WARN+BLOCK 全 0。
// 输出按全历史命中数升序（最冷门在前）。sufficient=false（含 stale）→ candidates 恒 []。
// 候选行附 dismiss 字段（2026-11 误拦遥测）= 该规则全账 dismiss 计数，作「高误拦率退役候选优先级」
// 旁注；**不进判据**——候选判据不变（窗口零命中），dismiss 多的零命中规则只是排序审视时更该先看。
export function retireCandidates(rows, windowMonths = 6, { now = new Date(), staleMonths = RETIRE_STALE_MONTHS } = {}) {
  const { byMonth } = aggFromRows(rows);
  const dTotals = dismissTotals(rows);
  const months = Object.keys(byMonth).sort();
  const base = { stale: false, anchor: null, dataMonths: months.length, windowMonths, windowFrom: null, windowTo: null, candidates: [], recentHits: [] };
  if (!months.length) return { sufficient: false, ...base };
  const anchor = months[months.length - 1];
  const window = calendarWindow(anchor, windowMonths);
  const common = { ...base, anchor, windowFrom: window[0], windowTo: anchor };
  if (monthDistance(anchor, nowYmOf(now)) > staleMonths) {
    return { sufficient: false, ...common, stale: true }; // 遥测停摆——零命中窗口不可作退役证据
  }
  if (months[0] > window[0]) {
    return { sufficient: false, ...common }; // 年轻遥测不满窗
  }
  const trailing = new Set(window);
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
    const row = { rule, total, lastHit, dismiss: dTotals[rule] || 0 };
    if (inWindow === 0) candidates.push(row);
    else recentHits.push(row);
  }
  candidates.sort((a, b) => a.total - b.total || a.rule.localeCompare(b.rule));
  recentHits.sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule));
  return { sufficient: true, ...common, candidates, recentHits };
}

function printRetireCandidates(read) {
  const wArg = Number((process.argv.find((a) => a.startsWith('--months=')) || '').split('=')[1]);
  const windowMonths = Number.isFinite(wArg) && wArg >= 1 ? Math.floor(wArg) : 6;
  const r = retireCandidates(read.rows, windowMonths);
  if (!r.sufficient) {
    if (r.stale) {
      // 新鲜度守卫（2026-11 统一口径）：锚月（末个有数据月）距今超半径 = 遥测停摆，不产候选。
      console.log(`agg-judgments: 遥测陈旧——末个有数据月 ${r.anchor} 距今超过 ${RETIRE_STALE_MONTHS} 个日历月（停摆期的零命中不可作退役证据），不产候选。先恢复 check-loop 运行 / 分片归档，再判退役。`);
    } else {
      console.log(`agg-judgments: 退役候选窗口 ${windowMonths} 个日历月（锚 ${r.anchor || '—'}）——观测史不满窗（数据月 ${r.dataMonths} 个、台账 ${read.rows.length} 行），数据不充分不产候选。继续积累运行记录。`);
    }
    if (read.bad) console.error(`agg-judgments: 跳过坏行 ${read.bad}（JSON 解析失败，不中断聚合）`);
    return;
  }
  console.log(`退役候选（零命中窗口 ${r.windowFrom}..${r.windowTo}，共 ${r.windowMonths} 个日历月、含无数据月）——仅机械筛查，裁决走 mechanism-registry「退役判据」列（「不退役」主干除外）：`);
  if (!r.candidates.length) {
    // 口径诚实化（2026-10-27）：judgments 台账**只记命中行**——「全账零命中」的规则根本不在账内，
    // 因此「无候选」只说明「账内规则在尾部窗口内都有命中」，不代表「所有规则都有命中」（设计文档 §12.5）。
    console.log('  （无候选——尾部窗口内**账内规则**均有命中；全账零命中的规则不入账、不产候选，见设计文档 §12.5）');
  }
  for (const c of r.candidates) {
    // dismiss 旁注（2026-11 误拦遥测）：高误拦率的退役候选优先级信号——仅展示，判据仍是零命中窗口
    const dNote = c.dismiss > 0 ? `  dismiss ${c.dismiss}` : '';
    console.log(`  候选  ${c.rule.padEnd(24)} 全历史命中 ${String(c.total).padStart(4)}  末次命中 ${c.lastHit || '—'}${dNote}`);
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
  // 误拦面（2026-11 误拦遥测）：dismiss/(命中+dismiss)——「哪条规则在误伤」的度量面。
  // 无 dismiss 记录的规则不出行；≥50% 且样本 ≥3 的规则单独点名「建议复评判据」（advisory，
  // 不改 --retire-candidates 的零命中窗口判据）。登记入口：judgment-ledger --dismiss。
  const surface = dismissStats(read.rows, argMonth);
  console.log('📊 误拦面（误拦率 = dismiss/(命中+dismiss)；无 dismiss 的规则不出行）：');
  if (!surface.rows.length) {
    console.log('    （无 dismiss 记录——登记：node scripts/judgment-ledger.mjs --dismiss <规则名> --reason <一句话>）');
  } else {
    for (const x of surface.rows) {
      console.log(`    ${x.rule.padEnd(24)} 命中 ${x.hits}  dismiss ${x.dismiss}  误拦率 ${(x.rate * 100).toFixed(1)}%`);
    }
    for (const x of surface.flagged) {
      console.log(`    ⚠ ${x.rule} 误拦率 ${(x.rate * 100).toFixed(1)}%（样本 ${x.total}，判据：≥${DISMISS_RATE_FLAG * 100}% 且样本 ≥${DISMISS_MIN_SAMPLE}）——建议复评判据（advisory）`);
    }
  }
  if (read.bad) console.error(`agg-judgments: 跳过坏行 ${read.bad}（JSON 解析失败，不中断聚合）`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('agg-judgments.mjs');
if (isMain) main();
