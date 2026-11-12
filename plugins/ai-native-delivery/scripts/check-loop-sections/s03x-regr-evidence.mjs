// check-loop-sections/s03x-regr-evidence.mjs — 3 扩展. incident 防复发验证证据门 [hard-block]（2026-10-09）---
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 3 扩展. incident 防复发验证证据门 [hard-block]（2026-10-09）---
// 模板行 38 强制项的机器面：「防复发验证必须落到自动化用例或回归清单条目，禁止只写已人工验证」。
// fixed/closed 且建档日 ≥ incidentRegrSince 的 incident，正文无自动化用例 / 回归清单引用 → hard。
// 判据 = 宽匹配正则（引擎 .test.mjs / 后端 xunit / 前端测试目录 / 回归清单 / 冒烟 / 测试命令）——
// 门的是「落到可复跑的验证资产」，不是猜具体测试名；存量（< 锚）豁免。kitPolicy.incidentRegrSince
// 缺键（v1-v5）→ 整体跳过。
{
  const anchor = kitPolicy.incidentRegrSince;
  if (anchor) {
    // 回归清单引用含分片路径（判据移植）：regression-checklist.md 分片制下防复发条目落
    // workflow/regression-checklist.d/<YYYY-MM>.md（append-only 追加区），主台账读侧自动合并——
    // 门禁正则须同认分片，否则只引分片的 incident 被误判「未落回归清单」。
    const REGR_EVIDENCE_RE = /\.test\.mjs|backend\/[^\s]*[Tt]ests?[\/.]|\w+Tests\.cs|frontend\/[^\s]*(?:__tests__|tests?)\/|workflow\/regression-checklist\.md|workflow\/regression-checklist\.d\/|regression-smoke|npm\s+test|dotnet\s+test|run-tests/;
    for (const inc of docFiles('incidents')) {
      const incSt = fmGet(inc, '状态');
      if (!['fixed', 'closed'].includes(incSt)) continue;
      const add = addedDateOf(inc);
      if (!add || add < anchor) continue; // 存量豁免（不可判定亦不拦——无判定依据不出 hard）
      const lines = linesOf(inc) || [];
      if (!lines.some((l) => REGR_EVIDENCE_RE.test(l))) {
        blockers.push(`- [回归证据缺失] ${path.basename(inc)} 已 ${incSt} 但防复发验证未落自动化用例/回归清单引用（模板强制项，禁「已人工验证」）`);
      }
    }
  }
}
}
