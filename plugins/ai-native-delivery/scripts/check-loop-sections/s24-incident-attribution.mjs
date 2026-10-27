// check-loop-sections/s24-incident-attribution.mjs — 24. incident 归因字段核查 [warning]（2026-10-11；锚 attributionSince）
// 背景（incident-attribution，据深度调研核查结论）：incident 无「来源」标准字段，
// 「来源×环境」分布只能逐件人工判读，两轮口径相抵（prod 触达 2 件 vs 字段原文 ≥11 件）不可机器复算。
// 本段把归因变成机器校验收敛面：模板新增「来源:」/「影响环境:」两枚枚举键（单源 workflow-enums.txt），
// 锚起的件「发现」日 ≥ attributionSince 时必填且值须在枚举内 → 否则 WARN。
// 只查字段存在性与枚举合法性，不判读内容（判读留给 gen-workflow-metrics 的机器复算表）。
// 存量豁免：发现日 < 锚 → 整体跳过；`流程: legacy` 回填件 → 跳过（同检查 3 口径）。
// 缺键（v1–v8）→ attributionSince 为空 → 整段跳过（存量零噪声，向后兼容不放松）。
import {
 fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
 loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
 SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
 spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
 addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
 delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 24. incident 归因字段核查 [warning]（2026-10-11；锚 attributionSince）---
{
 const anchor = kitPolicy.attributionSince;
 if (anchor) {
 const KEY_SOURCE = '来源';
 const KEY_ENV = '影响环境';
 for (const inc of docFiles('incidents')) {
 const name = path.basename(inc);
 if (fmGet(inc, '流程') === 'legacy') continue; // 回填件豁免（同检查 3）
 // 生效日锚：发现日优先、缺则取文件名前缀（与检查 12 moduleSince 同款退化）
 let d = fmGet(inc, '发现') || fmGet(inc, '日期');
 if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = /^\d{4}-\d{2}-\d{2}/.test(name) ? name.slice(0, 10) : '';
 if (!d || d < anchor) continue; // 锚前存量不回填
 const src = fmGet(inc, KEY_SOURCE);
 const env = fmGet(inc, KEY_ENV);
 if (!src) warnings.push(`- [WARN 归因缺字段] ${name} 缺「${KEY_SOURCE}:」字段（${anchor} 起新建 incident 必填，取值见 .agents/config/workflow-enums.txt incident.source.all）`);
 else if (!inSet(src, ENUMS['incident.source.all'])) warnings.push(`- [WARN 归因非法值] ${name}「${KEY_SOURCE}: ${src}」不在枚举（${ENUMS['incident.source.all'].join('/')}）`);
 if (!env) warnings.push(`- [WARN 归因缺字段] ${name} 缺「${KEY_ENV}:」字段（${anchor} 起新建 incident 必填，取值见 .agents/config/workflow-enums.txt incident.env.all）`);
 else if (!inSet(env, ENUMS['incident.env.all'])) warnings.push(`- [WARN 归因非法值] ${name}「${KEY_ENV}: ${env}」不在枚举（${ENUMS['incident.env.all'].join('/')}）`);
 }
 }
}
}
