// check-loop-sections/s22-registry.mjs — 22. 机制使用量台账（mechanism-registry；复杂度棘轮的出口）---
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';
// 状态列解析单源（2026-10-22 收敛）：状态值后允许追加机制类型标记（`现役 [检出型]` 等），
//   标记不参与状态判定。此前本段自带一套内联解析、与 gen-engine-map / mechanism-retire-watch
//   各自按精确字符串比对状态列——标记一上线三处同时失配（本段产出 35 条纯噪声）。现统一
//   消费 mechanism-retire-watch 的 statusOf + STATUSES，结构上消除第二套解析。
import { STATUSES, statusOf } from '../mechanism-retire-watch.mjs';

export function run() {
// --- 22. 机制使用量台账（mechanism-registry；复杂度棘轮的出口）---
// 背景：门禁只增不减（每道门都有事故背书，但无退役机制）——本检查给「低频机制退役」装强制处置环。
// .agents/config/mechanism-registry.md 在场才启用（历史 clone / 装户缺文件 = 跳过，沿 lane-surfaces.txt
// 「缺失即跳过」惯例，不制造一次性噪声）。表格式 markdown 管道表，列序固定：
//   | 机制 | 门禁位置 | 触发统计口径 | 退役阈值 | 最近触发 | 状态 | 处置期限 |
// 判据：状态 ∈ {现役,待退役,已退役}；「待退役」必须填处置期限（日期或批次号）——台账的目的不是记录
// 而是强制处置：没有时间表的退役意向等于永不变退役。触发计数本身半自动（口径列写明统计方法），
// 不进机器门——先有账，再谈自动化。
// 体量（2026-10-23 棘轮）：单行 > 800B WARN——流水账全塞「最近触发」列会把台账撑成史书，细节留 git 史；
// 总量另由 rule-budgets.txt 的预算行硬拦（超限须先压缩/外迁再提交）。
{
  const regPath = path.join(ROOT, '.agents', 'config', 'mechanism-registry.md');
  if (fs.existsSync(regPath)) {
    const dataRows = (linesOf(regPath) || [])
      .filter((l) => /^\|/.test(l))
      .filter((l) => !/^\|[\s:|-]+\|?\s*$/.test(l))          // 分隔行
      .filter((l) => (l.split('|')[1] || '').trim() !== '机制'); // 表头行
    if (!dataRows.length) {
      warnings.push('- [WARN 机制台账] 无数据行——表格式：| 机制 | 门禁位置 | 触发统计口径 | 退役阈值 | 最近触发 | 状态 | 处置期限 |');
    }
    for (const l of dataRows) {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length !== 7) {
        warnings.push(`- [WARN 机制台账] 行列数 ${cells.length} ≠ 7（机制|门禁位置|触发统计口径|退役阈值|最近触发|状态|处置期限）:${cells[0] || l.slice(0, 30)}`);
        continue;
      }
      const [name, , , , , statusRaw, deadline] = cells;
      // 单行体量（2026-10-23）：行是台账的最小单位，流水账全塞「最近触发」列会把台账撑成史书——
      // 超 800B 提示压缩（细节留 git 史），总量另有 rule-budgets.txt 预算行约束。
      const rowBytes = Buffer.byteLength(l);
      if (rowBytes > 800) {
        warnings.push(`- [WARN 机制台账] 「${name}」单行 ${rowBytes}B > 800B——压缩「最近触发」流水账（细节留 git 史），或拆为独立机制行`);
      }
      const status = statusOf(statusRaw);
      if (!STATUSES.includes(status)) {
        warnings.push(`- [WARN 机制台账] 「${name}」状态非法（须 现役/待退役/已退役）:${statusRaw}`);
        continue;
      }
      if (status === '待退役' && !deadline) {
        warnings.push(`- [WARN 机制台账] 「${name}」待退役但缺处置期限——补时间表，或改回现役并在阈值列写保留理由`);
      }
    }
  }
}
}
