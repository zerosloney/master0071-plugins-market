// metrics-core.mjs — workflow 指标口径共享内核（2026-10-23 board-engine-views A2 抽取）
// 单源纪律：闭环漏斗 / 复核效果 / 中位周期的**计算口径**只此一份——gen-workflow-metrics.mjs（metrics.md
// 月度快照）与 workflow-board-server.mjs（看板引擎视图）共同 import；改动任一消费方不得复制逻辑。
// 本模块只放纯函数与一次性只读采集（git log / 台账分片扫描），无写盘、无主流程。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 闭环漏斗「协议前」占比阈值（单源，2026-10-23 P2）：s26 动作阈值与 gen-workflow-metrics 的
// legacy 占比告警共用；此前两处各写 0.30 字面量，靠测试钉同值。
export const FUNNEL_LEGACY_RATIO_LIMIT = 0.30;

export function cycleDays(addedIso, terminalTs) {
  if (!addedIso || !terminalTs) return null;
  const days = (Date.parse(terminalTs) - Date.parse(addedIso)) / 86400000;
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}

// 日历整月差（2026-10-23 P2）：退役窗口「连续 6 月」按日历月算，不用 183 天近似。
// 未满整月不计（1-15 → 7-14 = 5，1-15 → 7-15 = 6）；非法输入 null；未来时间按 0。
export function calendarMonthsBetween(from, to = Date.now()) {
  const a = new Date(from);
  const b = new Date(to);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return null;
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  return Math.max(0, months);
}

// 一次 git log：路径 → 首次加入提交的 committer 时间。失败（非 git / 命令失败）返回 null，调用方整列写 —。
export function loadFirstAdded(cwd = process.cwd()) {
  let r;
  try {
    r = spawnSync('git', [
      'log', '--reverse', '--diff-filter=A', '--format=%cI', '--name-only', '--',
      'workflow/intents', 'workflow/specs', 'workflow/plans', 'workflow/incidents', 'workflow/archive',
    ], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  if (!r || r.status !== 0) return null;
  const map = new Map();
  let ts = null;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) { ts = trimmed; continue; }
    const p = trimmed.replace(/\\/g, '/');
    if (ts && !map.has(p)) map.set(p, ts);
  }
  return map;
}

export function funnelFromLedger(entries, month, firstAdded) {
  const byDoc = new Map();
  for (const e of entries) {
    if (typeof e.doc !== 'string' || typeof e.ts !== 'string') continue;
    if (!byDoc.has(e.doc)) byDoc.set(e.doc, []);
    byDoc.get(e.doc).push(e);
  }
  const res = { closed: 0, full: 0, legacy: 0, once: 0, rework: 0, ledgerRows: 0, days: [], items: [] };
  for (const e of entries) if (typeof e.ts === 'string' && e.ts.slice(0, 7) === month) res.ledgerRows++;
  for (const [doc, rs] of byDoc) {
    rs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const nonRevert = rs.filter((r) => !/^revert-/.test(String(r.stage || '')));
    const terminals = nonRevert.filter((r) => r.stage === 'done' || r.stage === 'closed');
    if (!terminals.length) continue; // 未收口件不进漏斗桶（仍计台账行数）
    const lastTerm = terminals[terminals.length - 1];
    if (String(lastTerm.ts).slice(0, 7) !== month) continue; // 月度归桶 = 终态行所在月
    // 确认阶段按件型（复核 P2-3 收口）：docs=approved；incidents=fixed（两跳确认门 fixed→closed，
    // 永无 approved 行——按 approved 判会把已走确认门的 incident 误归协议前）
    const isInc = doc.includes('/incidents/');
    const confirmStage = isInc ? 'fixed' : 'approved';
    const confirms = nonRevert.filter((r) => r.stage === confirmStage);
    const hasChain = confirms.length >= 1;
    const hasRevert = rs.some((r) => /^revert-/.test(String(r.stage || '')));
    const kind = !hasChain ? 'legacy' : (hasRevert || confirms.length >= 2 || terminals.length >= 2 ? 'rework' : 'once');
    const added = firstAdded ? firstAdded.get(String(doc).replace(/\\/g, '/')) : null;
    const days = cycleDays(added, lastTerm.ts);
    res.closed++;
    if (kind === 'legacy') res.legacy++;
    else { res.full++; res[kind === 'once' ? 'once' : 'rework']++; }
    if (days != null) res.days.push(days);
    res.items.push({ doc, kind, days: days == null ? '—' : days.toFixed(1) });
  }
  return res;
}

// 中位周期渲染（median-display）：真实的极小值不得被印成 `0.0`——四舍五入会得 0.0 时写 `<0.1`
// 显式表达「非零但极小」；null 仍写 `—`（口径与 metrics.md 表头声明一致）。
export function fmtMedianDays(v) {
  if (v == null) return '—';
  const s = v.toFixed(1);
  return s === '0.0' && v > 0 ? '<0.1' : s;
}

// 复核效果台账扫描（workflow/reviews.d/ 意见级处置分片）：一行 = 一次独立复核事件，
// 采纳+拒绝+误报 = 意见数。坏分片/自洽破坏抛错不静默（与 gen-workflow-metrics 同一口径）。
export function scanReviews(workflowDir = 'workflow') {
  const dir = path.join(workflowDir, 'reviews.d');
  if (!fs.existsSync(dir)) return {};
  const byMonth = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(dir, f);
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      throw new Error(`复核效果台账分片不可读：${p}（${e.message}）——坏分片不静默跳过`);
    }
    for (const line of text.split(/\r?\n/)) {
      if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue; // 表头/分隔线/注记行跳过
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const bad = cells.length < 8 || [3, 4, 5, 6].some((i) => !/^\d+$/.test(cells[i]));
      if (bad) throw new Error(`复核效果台账行字段非法（8 列起，意见数/采纳/拒绝/误报须为非负整数）：${p}\n  行：${line.trim()}`);
      const [total, adopted, rejected, misreport] = [3, 4, 5, 6].map((i) => Number(cells[i]));
      if (adopted + rejected + misreport !== total) {
        throw new Error(`复核效果台账自洽破坏（采纳 ${adopted} + 拒绝 ${rejected} + 误报 ${misreport} = ${adopted + rejected + misreport} ≠ 意见数 ${total}）：${p}\n  行：${line.trim()}`);
      }
      const b = (byMonth[cells[0].slice(0, 7)] ||= { events: 0, total: 0, adopted: 0, rejected: 0, misreport: 0 });
      b.events++;
      b.total += total;
      b.adopted += adopted;
      b.rejected += rejected;
      b.misreport += misreport;
    }
  }
  return byMonth;
}
