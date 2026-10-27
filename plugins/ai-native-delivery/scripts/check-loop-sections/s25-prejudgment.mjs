// check-loop-sections/s25-prejudgment.mjs — 25. 路由预判一致性 [warning]（prejudgment-ledger，advisory 灰度）---
// 背景：类型误路由（修复被当新需求 → 跳过 incident 立项与 kb-search 历史检索）是路由自动识别的静默盲区；
//   级别判低已有「红线判低」hard 与 CI 泳道门兜底，但「入口预判 vs 实际落位」的偏离本身不可见。
//   本段只做 advisory 比对：frontmatter「预判: kind=<kind> level=<L1|L2|L3>」在场才检——
//   kind 与入口类型不符 / level 与「级别」字段不符 / 词表非法 → WARN，不阻断。
//   kind 语义源 = pipeline-run.mjs KINDS（require/fix/verify/review/deploy）；类型只对 intents(≡require)/
//   incidents(≡fix) 执法——plans/specs 是两道共用件不判类型、只比对级别。
//   缺字段零告警（存量宽容不回填，不做强制前置）——灰度数据经 judgments.jsonl（WARN 预判* 计数）
//   月度对账后再议升格，退役/升格阈值由 mechanism-registry §25 行承载。
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';
import { KINDS } from '../pipeline-run.mjs';

export function run() {
// --- 25. 路由预判一致性 [warning] ---
const rankOf = (lv) => Number(String(lv).replace(/^L/, '')) || 0;
for (const sub of DOC_DIRS) {
  const dir = path.join(ROOT, WF, sub);
  for (const f of readdirOrNull(dir) || []) {
    if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
    const abs = path.join(dir, f);
    if (!isTracked(abs)) continue;
    const pj = fmGet(abs, '预判');
    if (!pj) continue;
    const rel = `${WF}/${sub}/${f}`;
    // 终态文档（2026-10-15）：形态/词表类告警跳过——终态受检查 15 内容绑定不可修订，此类 WARN 永不可
    // 消（「不可消除噪声」红线）；类型/级别比对保留——那是路由审计的本体信号，灰度对账照常采集。
    const terminalDoc = ['done', 'superseded', 'cancelled', 'fixed', 'closed'].includes(fmGet(abs, '状态'));
    const kv = {};
    for (const m of pj.matchAll(/(kind|level)=([^\s]+)/g)) kv[m[1]] = m[2];
    if (!Object.keys(kv).length) {
      if (!terminalDoc) warnings.push(`- [WARN 预判字段不可解析] 须形如「预判: kind=<kind> level=<L1|L2|L3>」:${rel}`);
      continue;
    }
    if (kv.kind && !KINDS.includes(kv.kind) && !terminalDoc) {
      warnings.push(`- [WARN 预判字段不可解析] kind=${kv.kind} 不在词表（${KINDS.join('/')}）:${rel}`);
    }
    if (kv.level && !inSet(kv.level, ENUMS['level.all']) && !terminalDoc) {
      warnings.push(`- [WARN 预判字段不可解析] level=${kv.level} 不在枚举 level.all:${rel}`);
    }
    // 类型比对：intents ≡ require、incidents ≡ fix（plans/specs 两道共用，不判类型）
    // 词表外 kind 已由上行报「不可解析」——此处不再叠报「类型不符」（同一根因双计，2026-10-14 修）
    const actualKind = sub === 'incidents' ? 'fix' : sub === 'intents' ? 'require' : null;
    if (kv.kind && actualKind && kv.kind !== actualKind && KINDS.includes(kv.kind)) {
      warnings.push(`- [WARN 预判类型不符] 预判 kind=${kv.kind} 但落位 ${sub}（实际 kind=${actualKind}）——类型误路由会跳过对应道的检索与立档，确认是否有意:${rel}`);
    }
    // 级别比对：与 frontmatter「级别」字段
    if (kv.level) {
      const lv = fmGet(abs, '级别');
      if (lv && lv !== kv.level) {
        const hint = rankOf(lv) < rankOf(kv.level) ? '（判低信号——落位低于预判，复核两问判据）' : '（判高——流程偏重，无害）';
        warnings.push(`- [WARN 预判级别不符] 预判 ${kv.level} 落位 ${lv}${hint}:${rel}`);
      }
    }
  }
}
}
