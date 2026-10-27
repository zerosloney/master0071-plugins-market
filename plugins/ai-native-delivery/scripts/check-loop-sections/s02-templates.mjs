// check-loop-sections/s02-templates.mjs — 2. 模板字段占位符残留 [warning]（排除运行时文件名格式与协议样板，口径沿 sh 版）---
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
// --- 2. 模板字段占位符残留 [warning]（排除运行时文件名格式与协议样板，口径沿 sh 版）---
{
  const phRe = /YYYY-MM-DD|<主题>|<日期 主题>|L1 \/ L2 \/ L3|draft \/ approved \/ done|open \/ fixed \/ closed/;
  const boilerRe = /\.\.\/specs\/[A-Za-z0-9-]*\.md|写明如何满足|防复发验证|_YYYY-MM-DD\.|format\('YYYY-MM-DD'\)|value-format="YYYY-MM-DD"|value-format YYYY-MM-DD|确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）/;
  // plan 确认节样板豁免（plan-confirm-boiler）：plan 模板「确认与复核」节自带
  // 「确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）」
  // 样板句，未回填不等于漏填占位（确认由 confirm-doc 机器兜底）——精确豁免整句，真实占位（如
  // `日期: YYYY-MM-DD`）照拦。
  // 命名约定豁免：`<主题>` 与 `.md` 同行 = 在描述文件命名规则（如 `.agents/pipelines/<主题>.md`、
  //   「复制本模板为 YYYY-MM-DD-<主题>.md」），非未填占位符；真未填的占位（标题 `# INTENT — <主题>`、
  //   `日期: YYYY-MM-DD`）不含 .md，仍照拦（2026-09-25-wf-runtime incident 记录的误报口径）
  const isNamingConv = (line) => line.includes('<主题>') && /\.md/.test(line);
  // 样例引用豁免（caliber-convergence 假阳性消除，先例=检查 18 行尾归一）：命中位于行内代码
  // （反引号包裹）或围栏代码块内 = 引用样例而非未填占位符，不报；正文裸占位符照报——真占位符均为
  // 裸文本（模板正文无反引号包裹），检测面不缩。
  // 日期显示格式豁免（check2-datetime-literal-exempt）：`YYYY-MM-DD HH:mm(:ss)` 是功能
  // 自实现的显示格式描述（文档叙述「匹配时间列显示为 YYYY-MM-DD HH:mm」属常态——cancel-export
  // intent/plan 实证 2 条 advisory、loop-audit intent 现场复现），非未填占位——行内剔除
  // 后再判；真占位（`日期: YYYY-MM-DD`，无时间后缀）不含该形态仍拦。只豁免实证形态，变体（斜杠日期
  // /十二小时制等）出现假阳性再扩。
  // 无引号属性形态豁免（2026-10-22 信噪比批）：`value-format="YYYY-MM-DD"` 已在豁免内，但正文多以
  // 无引号形态书写属性（实证 2026-10-20-po-search-grid-and-selects.md 第 20 行「（value-format
  // YYYY-MM-DD）」——纯误报，props 名与取值以空格分隔属 Vue/antd 模板常规写法）。同义形态一并豁免，
  // 检测面不缩：真占位（`日期: YYYY-MM-DD`）前面不是 value-format，照拦。
  const stripSamples = (lines) => {
    let inFence = false;
    return lines.map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return ''; }
      if (inFence) return '';
      return line.replace(/`[^`]*`/g, '').replace(/YYYY-MM-DD\s+HH:mm(:ss)?/g, '');
    });
  };
  const groups = new Map(); // file -> [ "行号:内容" ]（首现序）
  for (const sub of DOC_DIRS) {
    for (const f of docFiles(sub)) {
      const lines = linesOf(f) || [];
      const hits = [];
      stripSamples(lines).forEach((line, i) => {
        if (phRe.test(line) && !boilerRe.test(line) && !isNamingConv(line)) hits.push(`${i + 1}:${lines[i]}`);
      });
      if (hits.length) groups.set(f, hits);
    }
  }
  for (const [f, hits] of groups) {
    warnings.push(`- [WARN 模板未填] ${path.relative(ROOT, f).split(path.sep).join('/')} 含模板占位符:\n${hits.join('\n')}`);
  }
}
}
