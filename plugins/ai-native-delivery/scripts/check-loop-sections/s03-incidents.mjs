// check-loop-sections/s03-incidents.mjs — 3. incidents 状态枚举（WARN）+ 三件套书写（WARN）+ 配对/回路（advisory）---
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出；2026-10-21 门禁极小化第 1 批降档：
//   incident 配对 ×2 与回路断档 ×2 由 blockers 降 WARN——三件套书写下沉 papercut-fix skill（第 2 批），
//   本段退出 hard 面；回归证据 hard 检查在 s03x（不动）。基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 3. incidents 复盘三件套 + 状态严格枚举 + 新 intent 回路（配对/回路断档 = WARN）---
for (const inc of docFiles('incidents')) {
  const name = path.basename(inc);
  const lines = linesOf(inc) || [];
  const incLvl = fmGet(inc, '级别');
  const incSt = fmGet(inc, '状态');

  if (!inSet(incSt, ENUMS['incident.status.all'])) {
    warnings.push(`- [WARN 状态非法] incident 状态必须为 open/fixed/closed:${name}（frontmatter 状态键当前值:『${incSt || '缺失'}』）`);
  }

  if (fmGet(inc, '流程') !== 'legacy') {
    if (!inSet(incLvl, ENUMS['level.all'])) {
      warnings.push(`- [WARN 级别缺失] ${name} 必须填写 L1/L2/L3（配对检查已跳过——补级别后重跑本脚本校验配对）`);
    } else {
      if (['L1', 'L2', 'L3'].includes(incLvl) && !fs.existsSync(path.join(ROOT, WF, 'plans', name))) {
        warnings.push(`- [WARN 配对断裂] incident 缺 plan:${name}（应在 ${WF}/plans/ 下同名）`);
      }
      if (['L2', 'L3'].includes(incLvl) && !fs.existsSync(path.join(ROOT, WF, 'specs', name))) {
        warnings.push(`- [WARN 配对断裂] incident 缺 spec:${name}（应在 ${WF}/specs/ 下同名）`);
      }
    }
  }

  // 三件套：正文行锚定 /^1\. /^2\. /^3\. （sh awk 同款）
  for (const n of [1, 2, 3]) {
    if (!lines.some((l) => l.startsWith(`${n}. `))) {
      warnings.push(`- [WARN 三件套不全] ${name} 缺复盘三件套之 ${n}`);
    }
  }
  const hasParent = lines.some((l) => l.includes('是否需要新 intent'));
  if (!hasParent) {
    warnings.push(`- [WARN 三件套不全] ${name} 缺「是否需要新 intent」子项`);
    continue;
  }
  const yesLine = lines.find((l) => l.includes('是 → '));
  if (yesLine) {
    const m = yesLine.match(/intents\/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[^ )]*\.md/);
    const ref = m ? m[0] : null;
    if (!ref) warnings.push(`- [WARN 回路断档] ${name} 选「是」但未指明 intent 文件路径`);
    else if (!fs.existsSync(path.join(ROOT, WF, ref))) warnings.push(`- [WARN 回路断档] ${name} 引用的 intent 不存在:${ref}`);
  }
}
}
