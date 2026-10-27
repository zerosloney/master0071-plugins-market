// check-loop-sections/s21-spec-verif.mjs — 21. spec 验证落地核查 [warning]（2026-10-09；锚 specVerifSince）---
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
// --- 21. spec 验证落地核查 [warning]（2026-10-09；锚 specVerifSince）---
// review P1「spec 承诺落地：spec §测试用例须真落到测试」的机器面：L2/L3 done spec 且建档日 ≥ 锚，
// 其「测试用例 / 验证计划 / 验证方式」节无测试文件或验证命令引用 → WARN（advisory——spec 可能以
// UI 实测等人工可复跑方式验证，不做 hard）。缺键（v1-v5）→ 整体跳过；存量（< 锚）豁免。
{
  const anchor = kitPolicy.specVerifSince;
  if (anchor) {
    const VERIF_SEC_RE = /^##\s+.*(测试用例|验证计划|验证方式|测试与验证)/;
    const VERIF_EVIDENCE_RE = /\.test\.mjs|backend\/[^\s]*[Tt]ests?[\/.]|\w+Tests\.cs|frontend\/[^\s]*(?:__tests__|tests?)\/|regression-smoke|npm\s+test|dotnet\s+test|run-tests|check-scope|verify\.mjs|verify-ui/;
    for (const spec of docFiles('specs')) {
      const st = fmGet(spec, '状态');
      const lvl = fmGet(spec, '级别');
      if (st !== 'done' || !['L2', 'L3'].includes(lvl)) continue;
      const add = addedDateOf(spec);
      if (!add || add < anchor) continue;
      const lines = linesOf(spec) || [];
      const secLines = [];
      let inSec = false;
      for (const l of lines) {
        if (VERIF_SEC_RE.test(l)) { inSec = true; continue; }
        if (inSec && /^##\s+/.test(l)) { inSec = false; continue; }
        if (inSec) secLines.push(l);
      }
      if (secLines.length && !secLines.some((l) => VERIF_EVIDENCE_RE.test(l))) {
        warnings.push(`- [WARN spec 验证落地] ${path.basename(spec)} 验证节无测试文件/验证命令引用——review P1「spec 承诺落地」要求落到可复跑验证资产`);
      }
    }
  }
}
}
