// check-loop-sections/s29-regr-enforcer.mjs — 29. 回归清单执法者配对 [hard-block]（2026-11-11 判据移植；锚 regrEnforcerSince）
// 背景：回归清单「执法者」列空置长期无告警——规则已写但没有任何东西执法 = 重犯信号（清单规则的
//   人工纪律没有机器面）。本段让锚（regrEnforcerSince）后新增行从此有门。
// 判据：主台账「## 防复发验证」节 + 全部分片 workflow/regression-checklist.d/<YYYY-MM>.md 的数据行
//   （双 | 包边、非表头非分隔行；首列剥反引号后以 \d{4}- 开头——反引号 slug 形态同认）。行日期 =
//   首列前 10 字符；< regrEnforcerSince → 跳过（存量不追溯，同 convergenceSince 惯例）。锚后行：
//   第 4 列（执法者）非空且非 —/- → 通过；为空或行被切成非 4 列 → HARD-BLOCK（填真执法资产：
//   测试类/脚本/门禁 §N/regression-smoke/verify-ui 证据路径，或显式 [prompt-only] 并登记 papercuts
//   挂债）。表头行/分隔行/非数据行跳过；主台账无该节不报错。
// 分工：check-regression-consistency.mjs（§27）查清单引用的资产存在性；本段查执法者配对——
//   两门互补，互不替代。
// 缺键（v1–v15 无 regrEnforcerSince）→ 整段跳过（存量项目零破坏）。
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 29. 回归清单执法者配对 [hard-block]（2026-11-11 判据移植；锚 regrEnforcerSince）---
{
  const anchor = kitPolicy.regrEnforcerSince;
  if (anchor) {
    // 行切分沿用 s23 / agg-delegations splitTables 口径：双 | 包边、slice(1,-1)、逐格 trim
    const cellsOf = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
    const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
    // 数据行 = 双 | 包边表行、非分隔行、首列（剥反引号）以 \d{4}- 开头；日期 = 首列前 10 字符
    const isDataRow = (l) => {
      if (!/^\s*\|.*\|\s*$/.test(l) || isSep(l)) return false;
      const first = (cellsOf(l)[0] || '').replace(/^`+|`+$/g, '').trim();
      return /^\d{4}-/.test(first);
    };
    const dateOf = (cells) => (cells[0] || '').replace(/^`+|`+$/g, '').trim().slice(0, 10);
    // 扫描面：主台账「防复发验证」节（## 级开节，### 子节不停）+ 全部分片整文件
    const targets = [];
    const secLines = [];
    let inSec = false;
    for (const l of linesOf(path.join(ROOT, WF, 'regression-checklist.md')) || []) {
      if (/^##\s+.*防复发验证/.test(l)) { inSec = true; continue; }
      if (inSec && /^##\s+/.test(l)) { inSec = false; continue; }
      if (inSec) secLines.push(l);
    }
    targets.push({ base: 'regression-checklist.md', lines: secLines });
    const shardDir = path.join(ROOT, WF, 'regression-checklist.d');
    for (const f of (readdirOrNull(shardDir) || []).filter((n) => n.endsWith('.md')).sort()) {
      targets.push({ base: f, lines: linesOf(path.join(shardDir, f)) || [] });
    }
    for (const t of targets) {
      const missed = [];
      for (const l of t.lines) {
        if (!isDataRow(l)) continue; // 表头行/分隔行/非数据行跳过
        const cells = cellsOf(l);
        const d = dateOf(cells);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < anchor) continue; // 不可判定或锚前存量不追溯
        const enforcer = cells.length === 4 ? cells[3] : '';
        if (enforcer && enforcer !== '—' && enforcer !== '-') continue; // [prompt-only] 合法显式声明
        const topic = (cells[1] || cells[0] || l).replace(/\s+/g, ' ').trim().slice(0, 40);
        missed.push(`${d}「${topic}」${cells.length === 4 ? '执法者列为空' : `行被切成 ${cells.length} 列（表头口径 4 列）`}`);
      }
      if (missed.length) {
        blockers.push(`- [回归执法者缺失] ${t.base} ${missed.length} 行执法者未配对（${missed.join('; ')}）——回归清单锚（${anchor}）后行须指认「复发时谁会红」：填真执法资产（测试类 / 脚本 / 门禁 §N / regression-smoke / verify-ui 证据路径）或显式 \`[prompt-only]\` 并登记 papercuts 挂债（检查 29；锚前存量不追溯）`);
      }
    }
  }
}
}
