// warn-format.mjs — check-loop 告警输出降噪（2026-10-22 门禁收敛批 2「信噪比」）
// 职责单一、无副作用、可直接单测：把 advisory 告警（WARN/NOTE）按方括号标签折叠为
// 「×N 条同类」单行，明细落盘；**BLOCK 一律不折**——阻断项必须逐条可读（判读与呈现分离）。
// 动机（实测）：一次 --all 跑出 17 条 WARN + 19 条 NOTE，同类多行 + 多行告警把 actionable 项
// 淹没——告警不精确比告警多更伤，输出一旦不可读，门禁即退化形式。折叠后逐条明细仍完整落盘
// （供排障与事后对质），不丢信息、不降判据。
// 落位说明：本模块独立成文件而非并入 check-loop-kit.mjs——kit 被 import 即执行（argv 解析遇
// 未知参数即 usage() 退出），测试套件带 --shard 参数导入即死；无副作用模块才能被直接单测。

import fs from 'node:fs';
import path from 'node:path';

// 明细落盘的相对路径（对外只报相对路径，避免把绝对路径写进门禁输出）
export const WARN_LOG_REL = 'tmp/check-loop-warn.log';

// formatWarnings(list, opts) → 折叠后的告警文本
//   list：advisory 告警行数组（每行形如 "- [WARN 标签] 内容"）
//   opts.enabled=false → 逐条原样返回（排障 / 夹具口径）
//   opts.logPath      → 明细落盘路径（落盘失败不改裁决）
//   opts.logNote      → 输出中提示的明细位置（默认相对路径）
export function formatWarnings(list, { enabled = true, logPath = null, logNote = WARN_LOG_REL } = {}) {
  if (!enabled) return list.join('\n');
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, `${list.join('\n')}\n`);
    } catch { /* 明细落盘失败不改裁决（同 recordFailure 容错口径） */ }
  }
  // 归组键 = 方括号标签全文（WARN / NOTE 同级折叠）：同类同因多条只留一行计数。
  // **无标签条目一律不折叠**（2026-10-22 单测 S6 钉住）：原实现用「首行」作 raw 键兜底，
  // 会把两条首行相同的无标签告警合并成「- [] ×2」——既丢了内容又造了个空标签，
  // 比不折叠更坏（读者以为是一条）。无标签条目逐条原样输出。
  const order = [];
  const groups = new Map();
  const loose = [];
  for (const line of list) {
    const m = /^- \[([^\]]*)\]/.exec(line);
    if (!m) { loose.push(line); continue; }
    const key = `tag:${m[1]}`;
    if (!groups.has(key)) { groups.set(key, { tag: m[1], lines: [] }); order.push(key); }
    groups.get(key).lines.push(line);
  }
  const out = [];
  for (const key of order) {
    const g = groups.get(key);
    if (g.lines.length === 1) { out.push(g.lines[0]); continue; }
    out.push(`- [${g.tag}] ×${g.lines.length} 条同类（明细 ${logNote}）`);
  }
  // 无标签条目附在末尾，保持原顺序内的相对次序（不与标签条目交错）
  out.push(...loose);
  return out.join('\n');
}
