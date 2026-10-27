// check-loop-sections/s16-metric-claims.mjs — 16. 量化断言指标签名对账 [warning]（claim-exceeds-fix；登记表单源 
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';
// 路径收口（2026-10-27 插件化迁移）：判定脚本定位项目侧优先、插件内回退（脚本留插件内，不落用户项目）。
import { scriptPath } from '../paths.mjs';

export function run() {
// --- 16. 量化断言指标签名对账 [warning]（claim-exceeds-fix；登记表单源 .agents/metric-claims.txt）---
// 判据要点：活跃态文档（draft/approved/open）中的 `{{指标名}}`（小写点分）签名须替换为实时值，留签名=未回填=
//   warning；只查显式签名、不全文扫数字（历史叙述假阳性恒 0）；未登记签名 / 取数器缺失 → fail-loud 出账；
//   登记表缺失 → 静默跳过（未启用该检查的装户零噪声）；装户自有指标走 .agents/metric-derivers.cjs（CJS 契约，
//   内置优先）。实现自 check16-inline-debt 起迁出至 check-metric-claims.mjs（原内联块，判据语义/
//   消息文案/exit 语义零变化，迁出经全量输出 diff 基线验证）。ctx 显式携带本检查引用的外层符号
//   （ROOT/ENUMS/docFiles/fmGet/inSet/isTracked/linesOf/readdirOrNull/warnings，以代码实际引用集为准）；
//   调用位置须保持在检查 15 之后、输出段之前——warnings 按插入序输出，位置变化会改变输出行序。
runCheck16({ ROOT, ENUMS, docFiles, fmGet, inSet, isTracked, linesOf, readdirOrNull, warnings });
// --- 13. 常驻面体积预算 [warning]（2026-10-16 并入§16：段体逐字，§13 编号留疤；判定单源 rule-budget.mjs）---
// 并入§16 位（§15 之后）——§16 原注释要求调用位置在检查 15 之后，本合并保持该序（§13 原位亦在§15 之后）。
{
  // 判定脚本定位（2026-10-27 插件化迁移改道）：原写死 <root>/.agents/scripts/rule-budget.mjs；
  // 现项目侧优先（源仓形态 / 测试夹具副本不变）、回退插件内本体（paths.mjs scriptPath）。
  const rb = scriptPath(ROOT, 'rule-budget.mjs');
  const budgets = path.join(ROOT, '.agents', 'config', 'rule-budgets.txt');
  if (fs.existsSync(rb) && fs.existsSync(budgets)) {
    const r = spawnSync(process.execPath, [rb, '--all'], { cwd: ROOT, encoding: 'utf8' });
    if (!r.error && r.status !== 0) {
      const head = `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(0, 5).map((l) => '    ' + l).join('\n');
      warnings.push(`- [WARN 常驻面超限] 常驻面体积超预算(先删除或下沉被取代条目再增——一进一出):\n${head}`);
    }
  }
}
}
