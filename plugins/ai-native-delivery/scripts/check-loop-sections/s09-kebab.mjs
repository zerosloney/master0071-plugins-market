// check-loop-sections/s09-kebab.mjs — 9. 文件名英文 kebab-case [warning] ---
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
// --- 9. 文件名英文 kebab-case [warning] ---
for (const sub of DOC_DIRS) {
  const dir = path.join(ROOT, WF, sub);
  for (const f of readdirOrNull(dir) || []) {
    if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
    const abs = path.join(dir, f);
    if (!isTracked(abs)) continue;
    if (!/^[\x20-\x7e]*$/.test(f)) {
      warnings.push(`- [WARN 文件名非英文] 文件名含非 ASCII 字符,应为英文 kebab-case:${WF}/${sub}/${f}`);
    }
  }
}
// --- 12. frontmatter「模块:」合法性 [warning]（2026-10-16 并入§9：段体逐字，§12 编号留疤；词表单源 workflow-modules.txt）---
{
  const modsFile = path.join(ROOT, '.agents', 'config', 'workflow-modules.txt');
  if (fs.existsSync(modsFile)) {
    const mods = linesOf(modsFile).filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim());
    const vocab = new Set(mods);
    for (const sub of ['intents', 'specs', 'plans', 'incidents']) {
      for (const doc of docFiles(sub)) {
        const base = path.basename(doc);
        const mod = fmGet(doc, '模块');
        let d = fmGet(doc, '日期') || fmGet(doc, '发现');
        if (!d) d = /^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '';
        if (mod) {
          if (!vocab.has(mod)) warnings.push(`- [WARN 模块元数据] ${base}「模块: ${mod}」不在词表(见 .agents/config/workflow-modules.txt)`);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= kitPolicy.moduleSince) {
          warnings.push(`- [WARN 模块元数据] ${base} 缺「模块:」字段(${kitPolicy.moduleSince} 起新建文档必填)`);
        }
      }
    }
  }
}
}
