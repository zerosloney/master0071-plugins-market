// check-loop-sections/s10-migration.mjs — 10. 级别 vs 迁移文件一致性 [warning]（启发式：入口文档加入提交触及迁移 SQL/Migrations 
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
// --- 10. 级别 vs 迁移文件一致性 [warning]（启发式：入口文档加入提交触及迁移 SQL/Migrations → 疑似判低；非 git 跳过）---
if (gitOut(['rev-parse', '--git-dir']) !== null) {
  const log = gitOut(['log', '--diff-filter=A', '--format=@%H', '--name-only']);
  if (log !== null) {
    const addpath = new Map(); // 文件 → 首次加入 commit（新→旧序首遇）
    const cfiles = new Map();  // commit → 文件清单
    let cur = null;
    for (const line of log.split('\n')) {
      if (line.startsWith('@')) { cur = line.slice(1); cfiles.set(cur, []); continue; }
      if (line.trim() && cur && !addpath.has(line.trim())) {
        addpath.set(line.trim(), cur);
        cfiles.get(cur).push(line.trim());
      }
    }
    const docs = [...docFiles('intents'), ...docFiles('incidents')];
    // L1 plan 即入口：没有 intent/incident 的 L1 plan 同样参与「同提交触及迁移」启发式。
    for (const plan of docFiles('plans')) {
      if (fmGet(plan, '级别') !== 'L1') continue;
      const baseName = path.basename(plan);
      if (fs.existsSync(path.join(ROOT, WF, 'intents', baseName))) continue;
      if (fs.existsSync(path.join(ROOT, WF, 'incidents', baseName))) continue;
      docs.push(plan);
    }
    for (const doc of docs) {
      const rel = path.relative(ROOT, doc).split(path.sep).join('/');
      const lvl = fmGet(doc, '级别');
      if (lvl !== 'L1' && lvl !== 'L2') continue;
      const c = addpath.get(rel);
      if (!c) continue;
      const hits = (cfiles.get(c) || []).filter((f) => /(^|\/)docs\/scripts\/.*\.sql$/.test(f) || /(^|\/)Migrations\//.test(f));
      if (hits.length) {
        warnings.push(`- [WARN 级别疑似判低] ${path.basename(doc)} 级别 ${lvl} 但其加入提交触及迁移文件(混合改动应就高不就低,请复核级别):\n${hits.join('\n')}`);
      }
    }
  }
}
}
