// check-loop-sections/s26-funnel-action.mjs — 26. 闭环漏斗「协议前」占比动作阈值 [warning]（funnel-action-threshold）---
// 背景：workflow/metrics.md 闭环漏斗早就在记「协议前」（收口却无确认链）件数，但该数据**只有观测没有动作**——
//   门禁零触发有退役阈值、指标超额有对账，唯独「闭环被绕开」这一项无任何阈值，等于默许可绕。
//   本段补动作面：漏斗表里**日历相邻两月**协议前占比均 >30% → WARN 并要求一轮归因。
// 判据口径：
//   - 占比 = 协议前 / 收口；收口 = 0 的月份无占比（0/0 不判），只按有分母的月参与相邻比对；
//   - 「相邻」= nextMonth(前一月) === 当前月（行已按月升序）——单月波动（批量迁移 / 集中补录）不触发；
//   - 阈值单源 metrics-core.FUNNEL_LEGACY_RATIO_LIMIT（生成器与本节共用，2026-10-23 P2）。
// 纯 WARN advisory（沿 §25 先例）：这是**月度节奏的过程事实**，不是每次提交的正确性事实——
//   拿它做 hard-block 会把月度问题钉成每日拦路，逼人绕的正是门自己。升格判据见 mechanism-registry §26 行。
// 数据源是生成物（gen-workflow-metrics.mjs 单源写入），单元格形如 `79（45%） ⚠️` 或存量裸 `79`——
//   解析只取首个整数，两种形态都认（生成器升级当月不会整表重算，混合形态必须可读）。
// ROOT 由 kit 供给：--rev 模式下 kit 已把 ROOT 指向该提交的临时 worktree，故本段在 pre-push --rev
// 与工作区两种模式下读的都是同一棵树（无需自建旁路）。
import {
  fs, path, warnings, WF, ROOT,
} from '../check-loop-kit.mjs';
import { FUNNEL_LEGACY_RATIO_LIMIT } from '../metrics-core.mjs';

export function run() {
// --- 26. 闭环漏斗「协议前」占比动作阈值 [warning] ---
const RATIO_LIMIT = FUNNEL_LEGACY_RATIO_LIMIT;
const metricsPath = path.join(ROOT, WF, 'metrics.md');
if (!fs.existsSync(metricsPath)) return; // 装户/新仓无快照 = 未启用该观测，静默跳过（沿 lane-surfaces「缺失即跳过」惯例）
const rows = [];
let inFunnel = false;
for (const line of fs.readFileSync(metricsPath, 'utf8').split(/\r?\n/)) {
  if (/^##\s+闭环漏斗/.test(line)) { inFunnel = true; continue; }
  if (inFunnel && /^##\s+/.test(line)) break; // 漏斗段到下一节为止
  if (!inFunnel) continue;
  const m = line.match(/^\|\s*(\d{4}-\d{2})\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (!m) continue; // 表头/分隔行
  rows.push({ month: m[1], closed: Number(m[2]), legacy: Number(m[4]) });
}
if (rows.length < 2) return;
rows.sort((a, b) => a.month.localeCompare(b.month));
const ratioOf = (r) => (r.closed > 0 ? r.legacy / r.closed : null);
const nextMonthKey = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1];
  const cur = rows[i];
  if (nextMonthKey(prev.month) !== cur.month) continue;
  const ra = ratioOf(prev);
  const rb = ratioOf(cur);
  if (ra === null || rb === null) continue;
  if (ra > RATIO_LIMIT && rb > RATIO_LIMIT) {
    warnings.push(`- [WARN 漏斗协议前超标] ${prev.month} ${(ra * 100).toFixed(0)}% → ${cur.month} ${(rb * 100).toFixed(0)}%（阈值 ${(RATIO_LIMIT * 100).toFixed(0)}%，相邻两月）——闭环在被系统性绕开：跑一轮归因（哪一环在逼人绕路：确认门太重 / 级别判错 / 批量豁免滥用？），结论记 workflow/papercuts.md 或立 incident，并在 mechanism-registry 月度对账登记处置`);
  }
}
}
