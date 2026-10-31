// check-loop-sections/s23-convergence-audit.mjs — 23. 判据级收敛对账（2026-10-11；锚 convergenceSince / convergenceHardSince）
// 背景（convergence-audit，参照 GitHub spec-kit converge 机理「完成声明不是证据」）：
// spec 的验证承诺此前只落在叙述节（检查 21 对节内引用做存在性扫描），没有逐判据 × 逐证据的机器对账。
// 本段把「验收判据」表（workflow/specs/_TEMPLATE.md 承重节）变成机器输入：L2/L3 done spec（锚后）逐行解析
//   判据 → 证据。状态列自报「覆盖」而证据无效 → 仍判未覆盖。
// 两档（convergence-hard）：
//   advisory（有 convergenceSince、无 hard 键，或日期 < convergenceHardSince）：证据 = 存在的路径，或命令白名单声明。WARN。
//   hard（日期 ≥ convergenceHardSince）：路径仍只认存在，不读正文、不判与判据是否相关（判断题留给新会话复核）；
//     命令必须是 verify.mjs 全量门实际跑的那几个，且 workflow/verify-evidence.md 有不早于本 spec 日期的全绿行。
//     答不了（空、路径不存在、命令不在全量门、没有对应全绿行）= 未覆盖，HARD-BLOCK。人工走查且证据为空仍合法。
// 无「验收判据」节或表无数据行 → 两档都是 WARN「收敛无判据」。
// 存量豁免：日期 < convergenceSince → 跳过。缺键（v1–v9）→ 整段跳过。缺 hard 键（v1–v10）→ 不升 hard。
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

// 与 s21 命令面同源的声明白名单（advisory 档：文本命中即认）。hard 档不再凭命中放行。
const CMD_RE_BASE = /npm\s+(run\s+)?test|dotnet\s+test|run-tests|regression-smoke|verify\.mjs|check-scope|verify-ui|ui-verifier|vue-tsc|dotnet\s+build|npm\s+run\s+build/;
// 引用切分：长选项在前，避免 npm run build 被更短的模式截断。verify-ui 先于不会与 verify.mjs 重叠的独立词。
const CITE_RE_BASE = /npm\s+run\s+build|npm\s+(?:run\s+)?test|dotnet\s+build|dotnet\s+test|verify\.mjs|verify-ui|ui-verifier|regression-smoke|run-tests|check-scope|vue-tsc/g;
// 项目可扩展命令（2026-10-31 市场审查）：GATE_CMD 原是源项目工具链硬编码（npm/dotnet/vue-tsc/
// verify.mjs），使用项目引用自己的工具链（pytest、go test 等）永远过不了硬档收敛。engine.json 的
// convergenceCommands 数组按项目声明扩展三处口径（advisory 白名单 / 引用切分 / 全量门集合）；
// 「有不早于 spec 日期的全绿行」要求不变——项目声明的命令仍须由其 verify.mjs 全量门实际跑出来。
const EXTRA_CMD = (Array.isArray(kitPolicy && kitPolicy.convergenceCommands) ? kitPolicy.convergenceCommands : [])
  .filter((c) => typeof c === 'string' && c.trim() !== '');
const escCmd = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const extraAlt = EXTRA_CMD.slice().sort((a, b) => b.length - a.length).map(escCmd).join('|');
const CMD_RE = EXTRA_CMD.length ? new RegExp(`${extraAlt}|${CMD_RE_BASE.source}`) : CMD_RE_BASE;
const CITE_RE = EXTRA_CMD.length ? new RegExp(`${extraAlt}|${CITE_RE_BASE.source}`, 'g') : CITE_RE_BASE;
// verify.mjs 全绿行（suite=all-gates）实际覆盖的命令。不在此集的白名单命令没有对应绿记录。
// vue-tsc（2026-10-21 verify-diet ④）：本地关单前端门 = npm run type-check（vue-tsc -b），
// vite bundle 分离到 deploy/CI（TF_BUILD 下 frontend-build 门仍 npm run build）——两形态都是门实跑命令。
// 方向注意（复核 P2）：npm run build 的绿记录只在 **CI 行**（runId 有值）；本地全绿行实跑 vue-tsc。
// 按行环境严格对账挂 papercuts 2026-10-21（摘要行 runId 列已可辨 CI/本地）。
const GATE_CMD = new Set(['npm run build', 'npm test', 'npm run test', 'dotnet build', 'dotnet test', 'verify.mjs', 'vue-tsc', ...EXTRA_CMD]);
// 扩展名交替**最长优先**（2026-10-20 修复：原 `mjs|js|ts|tsx|...|json` 中 js/ts 是 mjs/json/tsx 的
// 前缀且交替无尾锚，`.json`/`.tsx` 路径被截断成 `.js`/`.ts` → existsSync 恒 false → 证据永不可验，
// po-close-replace-mark-completed 关单实证）
const PATH_EXT = 'tsx|mjs|json|html|sql|vue|cs|md|ts|js';
// 路径体 = 原 ASCII 路径字符 + 字母（中文目录），单字符类，避免 (A|B)+ 在长说明上回溯。
// 标点（如路径后的「（说明）」）不在类内，仍截断。
const PATH_RE = new RegExp(`(?:^|[\\s\`'"（(])([\\w.@\\-\\\\/\\p{L}]+\\.(?:${PATH_EXT}))`, 'gu');
const SEC_RE = /^##\s+.*验收判据/;
// 与 gen-verify-evidence.mjs 数据行同形态：短 SHA | ISO 时间 | …。只取日期，不复述门数。
const EVIDENCE_ROW_RE = /^\|\s*`[0-9a-f]{7,40}`\s*\|\s*([^|]+?)\s*\|/;

function greenEvidenceDates() {
  const dates = [];
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, WF, 'verify-evidence.md'), 'utf8'); } catch { return dates; }
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(EVIDENCE_ROW_RE);
    if (!m) continue;
    const day = m[1].trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dates.push(day);
  }
  return dates;
}

// 命令格：每一处引用都须落在全量门里，且有不早于 spec 日期的全绿行。解析不出引用 → 不放行。
// 两侧日期同须 UTC 口径（台账渲染 UTC ts；spec「日期」fill-spec 默认 UTC，手写见 _TEMPLATE.md 验收判据注）：
// 本地时区手写日期会在 UTC+8 0–8 点窗与全绿行错位一天——fail-closed，不误放。
function commandCovered(ev, specDate, greenDates) {
  const cites = ev.match(CITE_RE) || [];
  if (!cites.length) return false;
  const fresh = greenDates.some((g) => g >= specDate);
  return cites.every((c) => GATE_CMD.has(c) && fresh);
}

export function run() {
// --- 23. 判据级收敛对账（2026-10-11；锚 convergenceSince / convergenceHardSince）---
{
 const anchor = kitPolicy.convergenceSince;
 const hardAnchor = kitPolicy.convergenceHardSince;
 if (anchor) {
 const greenDates = greenEvidenceDates();
 const isPlaceholder = (s) => !s || /^<.*>$/.test(s);
 for (const spec of docFiles('specs')) {
 const st = fmGet(spec, '状态');
 const lvl = fmGet(spec, '级别');
 if (st !== 'done' || !['L2', 'L3'].includes(lvl)) continue;
 // 生效日锚：frontmatter「日期」优先（fill-spec 必写），缺则 git 首加日 / 文件名前缀（同检查 12 退化序）
 let d = fmGet(spec, '日期') || addedDateOf(spec);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = /^\d{4}-\d{2}-\d{2}/.test(path.basename(spec)) ? path.basename(spec).slice(0, 10) : '';
 if (!d || d < anchor) continue; // 锚前存量不回填
 const hard = !!(hardAnchor && d >= hardAnchor);
 const lines = linesOf(spec) || [];
 const secLines = [];
 let inSec = false;
 for (const l of lines) {
 if (SEC_RE.test(l)) { inSec = true; continue; }
 if (inSec && /^##\s+/.test(l)) { inSec = false; continue; }
 if (inSec) secLines.push(l);
 }
 // 解析表数据行（表头才是数据边界——沿用 agg-delegations splitTables 口径；分隔行/表头行/占位行跳过）
 const rows = secLines
 .filter((l) => /^\|.*\|\s*$/.test(l))
 .filter((l) => !/^\|[\s:|-]+\|\s*$/.test(l))
 .map((l) => l.split('|').slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, '')))
 .filter((cells) => cells.length >= 3)
 .filter((cells) => !cells[1].startsWith('证据（')) // 表头行
 .filter((cells) => !isPlaceholder(cells[0])); // 模板占位行
 const base = path.basename(spec);
 if (!rows.length) {
 warnings.push(`- [WARN 收敛无判据] ${base} 无「验收判据」表或表为空——L2/L3 done spec 须逐条登记可验判据（检查 23，模板 workflow/specs/_TEMPLATE.md）`);
 continue;
 }
 const missed = [];
 for (const [crit, ev, stat] of rows.map((c) => [c[0], c[1], (c[2] || '').trim()])) {
 if (stat === '人工' && isPlaceholder(ev)) continue; // 人工走查判据：空证据合法
 let ok = false;
 if (!isPlaceholder(ev)) {
 if (hard && CMD_RE.test(ev)) ok = commandCovered(ev, d, greenDates);
 else if (CMD_RE.test(ev)) ok = true; // advisory：命令白名单认声明
 else {
 const cands = [];
 for (const m of ev.matchAll(PATH_RE)) cands.push(m[1].replace(/\\/g, '/'));
 ok = cands.some((p) => fs.existsSync(path.join(ROOT, p)));
 }
 }
 if (!ok) missed.push(`${crit}→${ev || '（空）'}`);
 }
 if (missed.length) {
 const detail = `${base} ${rows.length} 条判据中 ${missed.length} 条证据无效（${missed.join('; ')}）`;
 if (hard) blockers.push(`- [收敛未覆盖] ${detail}——状态列自报不作数；命令须是全量门（npm test / dotnet test / dotnet build / npm run build / verify.mjs）且 workflow/verify-evidence.md 有不早于本 spec 日期的全绿行；本项目的全量门命令可在 .agents/config/engine.json 的 convergenceCommands 数组里声明扩展；路径只认存在（检查 23，含 .vue 与中文目录）。若本 spec 已标 done：先标后补会与本门互为前提（verify 门序含 check-loop）——解锁序：改正文 → 状态改回 approved（勿改 draft，L3 必须 approved/done）→ confirm-doc 重录指纹 → 再标 done。中间态不要提交`);
 else warnings.push(`- [WARN 收敛未覆盖] ${detail}——状态列自报不作数，证据须存在或为验证命令（检查 23）`);
 }
 }
 }
}
}
