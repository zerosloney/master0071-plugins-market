// check-loop-sections/s18-delegations.mjs — 18. 委派台账对账 [warning] ---
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
// --- 18. 委派台账对账 [warning] ---
// L2/L3 的 intent、spec、plan 状态为 done 时，「委派结果」表与「自做任务结果」表均没有
// 日期不早于文档日期、且含该文件名（带/不带 .md 均匹配）的一行，则警告。
// 缺级别、缺日期、以及其他状态不警告。audit:false 时 warnings.push 已被换成空函数。
// 两表解析口径与 agg-delegations.mjs splitTables 保持一致，一边改另一边须跟。
// 修复族豁免（2026-10-21 止血批）：台账记法明文「修复类不记（自做表）」——incident 面与
// 修复族同名 spec/plan（修复子路由伴生件）退出对账（自做修复无行=按记法合法；委派修复
// 行在委派表，本门不再覆盖该窄面——审计面收窄登记机制台账）。intent 领头新需求族照查。
{
  const rows = delegationResultRows(path.join(ROOT, WF, 'delegations.md'));
  const incidentNames = new Set(docFiles('incidents').map((a) => path.basename(a).replace(/\.md$/, '')));
  for (const sub of ['intents', 'specs', 'plans']) {
    for (const abs of docFiles(sub)) {
      const lvl = fmGet(abs, '级别');
      if (lvl !== 'L2' && lvl !== 'L3') continue;
      const st = fmGet(abs, '状态');
      if (st !== 'done') continue;
      const base = path.basename(abs);
      // 日期：frontmatter 优先，缺则回落文件名前缀（plan 无「日期」字段——沿检查 15 / 19 既有口径；
      // 缺日期即整段跳过会让本门对绝大多数 L2/L3 plan 静默失效，2026-10-27 修）
      const date = fmGet(abs, '日期') || (/^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      // delegationSince 生效日豁免（policy v4，loop-audit-remediation）：锚前文档为存量回溯件
      // ——台账记法约定（delegations.md 头部「任务一句话含文件名」）自生效日才立，存量不回填；缺键
      // （v1-v3）→ 维持原全量对账行为（向后兼容，检查面不放松）
      if (typeof kitPolicy.delegationSince === 'string' && date < kitPolicy.delegationSince) continue;
      const stripped = base.replace(/\.md$/, '');
      if (incidentNames.has(stripped)) continue; // 修复族伴生 spec/plan（同名 incident 在场）
      if (rows.some((r) => r.date >= date && (r.line.includes(base) || r.line.includes(stripped)))) continue;
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      warnings.push(`- [WARN 委派台账] ${rel} 在 ${date} 及之后的委派结果/自做任务结果表中没有该文件名`);
    }
  }
}
}
