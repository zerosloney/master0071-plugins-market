// check-loop-sections/s27-regression-consistency.mjs — 27. 回归清单活文档引用一致性 [hygiene warning]---
// （2026-10-17 关单活文档门 A1 新增；独立复核反复抓到「清单/wiki 残留旧口径」却只在复核阶段可见，
//  本段把「清单引用的资产还在吗」前移到提交时 hygiene 提示。判定单源 = check-regression-consistency.mjs。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';
import { scanRegressionRefs } from '../check-regression-consistency.mjs';

export function run() {
// --- 27. 回归清单活文档引用一致性 [hygiene]（2026-10-17 A1）---
// 清单条目引用的 *Tests.cs / workflow/*.md 须仍存在（弱档存在性，不猜语义——语义对账需结构化契约，
// 自由文本无此面，显式不做）。tmp/*.mjs 因 tmp/ 在 .gitignore 易失，只 advisory 不 hard，防恒误报。
// 残留处理 = 删/改清单过时条目（维护规则 4），让复核不再返工这类债。
try {
  const r = scanRegressionRefs(ROOT);
  for (const c of r.danglingClasses) {
    warnings.push(`- [WARN 回归清单悬空引用] 测试类 ${c} 已不在 tests/ 项目但清单仍引用——按维护规则 4 删除或改写过时条目`);
  }
  for (const d of r.danglingDocs) {
    warnings.push(`- [WARN 回归清单悬空引用] 流程文档 ${d} 不存在但清单仍引用——更新为正确路径或删除过时条目`);
  }
  for (const t of r.missingTmp) {
    warnings.push(`- [NOTE 回归清单临时脚本缺失] ${t} 当前不在（tmp/ 易失，advisory 不拦）`);
  }
} catch (err) {
  warnings.push(`- [WARN 回归清单一致性检查执行失败] ${err.message}——检查器异常非残留，但须人工看一眼`);
}
}
