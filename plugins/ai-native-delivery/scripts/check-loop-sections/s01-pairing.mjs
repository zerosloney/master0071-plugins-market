// check-loop-sections/s01-pairing.mjs — 1. 红线判低 + L3 状态（hard）＋ 同名配对/L3 确认三件（advisory）
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出；2026-10-21 门禁极小化第 1 批降档：
//   配对完整性 ×4 与 L3 确认三件 ×3 由 blockers 降 WARN——「事后扫」移交 closeout skill 自查（第 2 批），
//   红线判低与 L3 状态未确认保 hard：前者是判低逃逸的唯一机器面，后者是状态机主干。）
// （基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

// 红线判低：非 high 勾了「→ 级别 / 级别至少 L2|L3」即 hard。L1 plan 即入口后，plan 正文同样扫描。
// （2026-11-09 审查收口：措辞枚举 → 结构判据。旧实现逐条追加同义措辞（行首缩进、「升级至/升至/升到/升」）
//   属 workaround 面——任何集外改写（「级别 ≥ L2」「改判 L2」「至少 L2」）即逃逸。红线本是「触达红线」
//   节下的固定勾选清单（模板单源 fill-intent 红线选项 + _TEMPLATE）：勾任一选项即触达，与升级声明的
//   措辞无关。旧措辞正则保留为第二信号（正文任意勾选行声明升级仍计），方向只增不减。）
const REDLINE_SECTION_RE = /^#{2,3}\s*.*触达红线/;
const REDLINE_CHECKED_RE = /^\s*- \[[xX]\]/;
const REDLINE_ESCALATE_RE = /(\$\\rightarrow\$|→)\s*级别|级别至少\s*L[23]|(?:升级至|升至|升到|升)\s*L[23]/;
function redlineTouched(file) {
  let inSection = false;
  for (const l of linesOf(file) || []) {
    if (/^#{1,3}\s/.test(l)) { inSection = REDLINE_SECTION_RE.test(l); continue; }
    if (REDLINE_CHECKED_RE.test(l)) {
      if (inSection) return true;
      if (REDLINE_ESCALATE_RE.test(l)) return true;
    }
  }
  return false;
}
// 两 hard 的存量豁免锚（2026-11-09，policy v15 check1HardSince，命名沿 check14HardSince 先例）：
// 红线判低与 L3 状态未确认此前对所有存量文档永久执法（每次 commit/push 恒 exit 1 直到改旧文档），
// 与其余 4 段 hard 的「首加日 < 锚 → 豁免、存量不回填」纪律不一致。日期三级解析沿 s15-fingerprint
// 先例：frontmatter「日期」→ 文件名前 10 位 → addedDateOf（git 首加日，kit 单源）；三级全缺/不可
// 判定 → ''（视为存量豁免，沿 s03x「不可判定→豁免」fail-open 先例）。缺键（v1–v14）→ legacy 恒
// false——本键是放宽锚，缺键必须保持现行全量 hard 口径，不适用「缺键跳过」。
const check1DateOf = (doc, base) => {
  let d = fmGet(doc, '日期');
  if (!d) d = /^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '';
  if (!d) d = addedDateOf(doc);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
};
const check1Legacy = (doc, base) => kitPolicy.check1HardSince
  ? ((d) => d === '' || d < kitPolicy.check1HardSince)(check1DateOf(doc, base))
  : false;
function pushRedline(file, base, lvl, legacy) {
  if (laneOfDoc(lvl) === 'high') return;
  if (redlineTouched(file)) {
    const msg = `${base} 级别为 ${lvl || '缺失'} 但触达红线已勾选（规则/契约或 schema/结构面）——协作道不受理 STOP 级改动：就高不就低，把「级别」升至 L2/L3 并补同名 spec`;
    if (legacy) warnings.push(`- [WARN 红线判低·存量豁免] ${msg}`);
    else blockers.push(`- [红线判低] ${msg}`);
  }
}

export function run() {
// --- 1. 红线判低 + L3 状态（hard）＋ 同名配对/L3 确认三件（advisory，2026-10-21 第 1 批降档）---
// L1 收成一份 plan（2026-10-10）：级别恰好为 L1 的 plan 自己就是入口，不要求同名 intent/incident。
// 级别缺失或 L2/L3 仍要求入口。已写的 intent 不论级别都仍要求同名 plan。历史台账不迁移。
for (const intent of docFiles('intents')) {
  const base = path.basename(intent);
  const st = fmGet(intent, '状态');
  const lvl = fmGet(intent, '级别');
  const legacy = check1Legacy(intent, base);
  if (!stOkDoc(st)) {
    const msg = `${base}（frontmatter 状态键当前值:『${st || '缺失'}』）`;
    if (lvl === 'L3' && !legacy) blockers.push(`- [状态未确认] L3 intent 必须为 approved/done/superseded/cancelled:${msg}`);
    else warnings.push(`- [WARN 状态未确认] intent 必须为 approved/done/superseded/cancelled:${msg}`);
  }
  if (lvl === 'L2' || lvl === 'L3') {
    if (!fs.existsSync(path.join(ROOT, WF, 'specs', base))) {
      warnings.push(`- [WARN 配对断裂] intent 缺 spec:${base}（应在 ${WF}/specs/ 下同名）`);
    }
  }
  // 已有 intent 仍须同名 plan（含存量 L1）。L2/L3 另须 spec。
  if (!fs.existsSync(path.join(ROOT, WF, 'plans', base))) {
    warnings.push(`- [WARN 配对断裂] intent 缺 plan:${base}（应在 ${WF}/plans/ 下同名）`);
  }
  pushRedline(intent, base, lvl, legacy);
}

for (const spec of docFiles('specs')) {
  const base = path.basename(spec);
  const st = fmGet(spec, '状态');
  const lvl = fmGet(spec, '级别');
  const hasEntry = fs.existsSync(path.join(ROOT, WF, 'intents', base)) || fs.existsSync(path.join(ROOT, WF, 'incidents', base));
  if (!hasEntry) warnings.push(`- [WARN 配对断裂] spec 缺 intent/incident:${base}（应在 ${WF}/intents/ 或 ${WF}/incidents/ 下同名）`);
  if (!stOkDoc(st)) {
    const msg = `${base}（frontmatter 状态键当前值:『${st || '缺失'}』）`;
    if (lvl === 'L3' && !check1Legacy(spec, base)) blockers.push(`- [状态未确认] L3 spec 必须为 approved/done/superseded/cancelled:${msg}`);
    else warnings.push(`- [WARN 状态未确认] spec 必须为 approved/done/superseded/cancelled:${msg}`);
  }
  // L3 确认三件：确认结果/确认时间读 frontmatter；独立复核按正文行锚定（放弃件豁免 = 枚举单源 abandoned 集）
  if (lvl === 'L3' && !inSet(st, ENUMS['doc.status.abandoned'])) {
    if (fmGet(spec, '确认结果') !== 'approved') warnings.push(`- [WARN L3 确认缺失] ${base} 确认结果必须为 approved`);
    if (!fmGet(spec, '确认时间')) warnings.push(`- [WARN L3 确认缺失] ${base} 必须记录确认时间`);
    if (!(linesOf(spec) || []).some((l) => /^- 独立复核：[ \t]*[^<\s]/.test(l))) {
      warnings.push(`- [WARN L3 复核缺失] ${base} 必须记录新会话独立复核结论`);
    }
  }
  // 独立复核上下文标识（2026-10-11 C2，policy v12 reviewerSince advisory）：独立性声明须带可证伪基底——
  // 复核行落「复核上下文：<会话/子代理 id>」，使「主智能体自查冒充」从遗漏升级为积极伪造。只扫有独立
  // 复核行的 spec；锚前存量豁免不回填；缺键（v1–v11）→ 检查整体跳过。
  if (kitPolicy.reviewerSince) {
    const rvDate = fmGet(spec, '日期') || (/^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '');
    if (rvDate >= kitPolicy.reviewerSince) {
      const rvLine = (linesOf(spec) || []).find((l) => /^- 独立复核：/.test(l));
      if (rvLine && !/复核上下文：/.test(rvLine)) {
        warnings.push(`- [WARN 复核上下文缺失] ${base} 独立复核行缺「复核上下文：<会话/子代理 id>」——独立性声明无可证伪基底（C2，reviewerSince ${kitPolicy.reviewerSince}）`);
      }
    }
  }
}

for (const plan of docFiles('plans')) {
  const base = path.basename(plan);
  const st = fmGet(plan, '状态');
  const lvl = fmGet(plan, '级别');
  const legacy = check1Legacy(plan, base);
  const hasEntry = fs.existsSync(path.join(ROOT, WF, 'intents', base)) || fs.existsSync(path.join(ROOT, WF, 'incidents', base));
  // L1 plan 即入口。级别缺失仍要求入口（fail-closed）。
  if (lvl !== 'L1' && !hasEntry) warnings.push(`- [WARN 配对断裂] plan 缺 intent/incident:${base}（应在 ${WF}/intents/ 或 ${WF}/incidents/ 下同名）`);
  pushRedline(plan, base, lvl, legacy);
  if (!stOkDoc(st)) {
    const msg = `${base}（frontmatter 状态键当前值:『${st || '缺失'}』）`;
    if (lvl === 'L3' && !legacy) blockers.push(`- [状态未确认] L3 plan 必须为 approved/done/superseded/cancelled:${msg}`);
    else warnings.push(`- [WARN 状态未确认] plan 必须为 approved/done/superseded/cancelled:${msg}`);
  }
  // 链内状态一致性（2026-10-11 链内倒挂 WARN，评审 C1 收口——B1 arrival 链暴露的盲点：配对存在≠终态同批）：
  // README 规则 5 / test.md §5.4 要求关单时入口与同名 plan 同批翻转。intent 链双向入检；incident 链只检
  // 「closed 而 plan 在途」孤儿向——「plan done 而 incident 停 fixed」为 2026-10 前存量固定形态
  // （INDEX incidents fixed 计数 ≈50 件），不追溯，避免不可消除噪声（同 delegationSince 存量豁免纪律）。
  const intentUp = path.join(ROOT, WF, 'intents', base);
  if (fs.existsSync(intentUp)) {
    const stu = fmGet(intentUp, '状态');
    if (st === 'done' && ['draft', 'approved'].includes(stu)) {
      warnings.push(`- [WARN 链内倒挂] ${base} plan 已 done 而入口 intent 仍 ${stu || '缺失'}——README 规则 5：勾验 intent 验收后 intent 与同名 plan 一并 done`);
    }
    if (stu === 'done' && ['draft', 'approved'].includes(st)) {
      warnings.push(`- [WARN 链内倒挂] ${base} 入口 intent 已 done 而 plan 仍 ${st}——test.md §5.4 不留 approved 孤儿：同名 plan 一并 done`);
    }
  }
  const incidentUp = path.join(ROOT, WF, 'incidents', base);
  if (fs.existsSync(incidentUp) && fmGet(incidentUp, '状态') === 'closed' && ['draft', 'approved'].includes(st)) {
    warnings.push(`- [WARN 链内倒挂] ${base} incident 已 closed 而 plan 仍 ${st}——修复类关单同名 plan 一并 done（test.md §5.4）`);
  }
}
}
