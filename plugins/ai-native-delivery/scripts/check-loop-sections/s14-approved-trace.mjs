// check-loop-sections/s14-approved-trace.mjs — 14. 新 done 的 spec/plan 须在 git 历史里出现过 `状态: approved`（WARN）
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出；2026-10-21 门禁极小化第 1 批降档：锚后 hard → WARN——
//   「事后扫」降档，approved 写入动作本身保留（confirm-doc/stage-gates 在动作时刻执法）。基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 14. 新 done 的 spec/plan 须在 git 历史里出现过 `状态: approved`（v7 锚后 [hard-block] / 锚前 [warning]；非 git 跳过）---
if (gitOut(['rev-parse', '--git-dir']) !== null && gitOut(['rev-parse', '-q', '--verify', 'HEAD']) !== null) {
  // pickaxe 批量化（perf-pickaxe-batch）：段内合格文档首次需要时一次全仓扫描建索引，
  // 循环内 Map 查询替代逐文档 spawn（与 approvedTraceHit 语义等价的实证与口径见 stage-gates 注释；
  // -G 字面量两形态共用同一常量）。null=git 失败 → traceHitOf 回 null，沿本段 fail-open 口径不报。
  let approvedIdx;
  const traceHitOf = (rel) => {
    if (approvedIdx === undefined) approvedIdx = approvedTraceIndex(ROOT);
    return approvedIdx === null ? null : (approvedIdx.get(rel) || '');
  };
  for (const sub of ['specs', 'plans']) {
    for (const doc of docFiles(sub)) {
      if (fmGet(doc, '状态') !== 'done') continue;
      const base = path.basename(doc);
      let d = fmGet(doc, '日期') || fmGet(doc, '发现');
      if (!d) d = /^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '';
      // 豁免锚（2026-10-15 调整）= check14HardSince 优先：advisory 窗口（confirmDocsEffective..check14HardSince）
      // 并入存量豁免——窗口期已关单文档受检查 15 内容绑定不可修订，WARN 属「不可消除噪声」（policy v4
      // delegationSince 注释所立红线），留痕价值让位于信噪比；锚后（hard 档）行为不变。无 check14HardSince
      // 的历史 policy（v1-v6）维持原 advisory 口径——该档位 WARN 是唯一执法面，不豁免。
      // 原 2026-10-09「窗口期留痕不豁免」决定就此收口；缺键（异常态）逐级回退保持兼容。
      const anchor14 = kitPolicy.check14HardSince || kitPolicy.confirmDocsEffective || kitPolicy.check14Since;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < anchor14) continue;
      const lines = linesOf(doc) || [];
      if (lines.some((l) => l.includes('存量确认态豁免（'))) continue;
      const rel = path.relative(ROOT, doc).split(path.sep).join('/');
      // 命中判据单源（stage-gates，confirm-gate-approved-history；2026-10-10 起段内走
      // 批量索引 approvedTraceIndex，等价口径见 stage-gates.mjs 注释）：
      // 返回 ''=从未出现 / <sha>=命中 / null=git 调用失败（不报，沿本段 fail-open 口径）
      const hit = traceHitOf(rel);
      if (hit !== null && hit === '') {
        const msg = `${base} 状态已 done 但 git 历史中从未出现行首「状态: approved」——确认环节未留痕(draft 直跳 done)`;
        // 2026-10-21 第 1 批降档：锚后 hard 并入 WARN（统一 advisory——降的是事后扫描，写入动作执法不变）
        warnings.push(`- [WARN 确认态缺失] ${msg}`);
      }
    }
  }
}
}
