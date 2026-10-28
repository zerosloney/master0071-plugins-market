// check-loop-sections/s08-acceptance.mjs — 8. intent 验收标准对账（done 须逐条勾验并补证据；新建 hard，存量聚合 warning）---
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, readVerifyLedgerText, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 8. intent 验收标准对账（done 须逐条勾验并补证据；新建 hard，存量聚合 warning）---
// 生效日锚 2026-09-28 改「git 首次加入日期」（此前取文件名前 10 字符——命名规范强制的字段、
// 写早零成本，见 incidents/2026-09-28-check8-git-anchor）。非 git → 不可判定 → 走存量口径（不误报 hard）。
{
  const accCutoff = '2026-09-12';
  let legacyUnaccounted = 0;
  // 测试绿凭证状态（verify-evidence）：台账读一次循环外缓存；policy 缺 verifySince
  //（v1-v4）→ ctxBase null → 对账整体跳过（向后兼容）
  const verifySinceOf = kitPolicy.verifySince;
  // 读口在 kit：--rev 且树上没有凭证文件时回退主工作区，其余路径只读 ROOT。
  const verifyFresh = (() => {
    try {
      const text = readVerifyLedgerText();
      return text != null ? hasFreshVerifyLine(text.split(/\r?\n/)) : false;
    } catch { return false; }
  })();
  const acceptanceDocs = docFiles('intents').filter((intent) => fmGet(intent, '状态') === 'done');
  // L1 plan 即入口：没有同名 intent 的 done L1 plan 自己对账验收。有 intent 的仍只查 intent。
  for (const plan of docFiles('plans')) {
    if (fmGet(plan, '状态') !== 'done' || fmGet(plan, '级别') !== 'L1') continue;
    const baseName = path.basename(plan);
    if (fs.existsSync(path.join(ROOT, WF, 'intents', baseName))) continue;
    if (fs.existsSync(path.join(ROOT, WF, 'incidents', baseName))) continue;
    acceptanceDocs.push(plan);
  }
  for (const intent of acceptanceDocs) {
    const base = path.basename(intent);
    const lines = linesOf(intent) || [];
    // 节扫描：hs=有验收节；insec 至下一个二级标题；uc=未勾项；ne=勾选缺证据；ex=存量豁免声明
    //   证据可写在 [x] 行的续行（仓库通写法「（证据：…）」另起一行）——pendX 记「待证据项」，
    //   遇证据行（全角「：」/半角「:」皆认）清零；遇下一条目 / 下一小节 / 节末仍无证据 → ne
    let hs = false, uc = false, ne = false;
    let insec = false, ex = false;
    let pendX = false; // 上一 [x] 项尚无证据，证据可能在紧随的续行
    let currentEvidence = ''; // 当前条目的证据内容，用于语义校验
    const evidenceItems = []; // 逐条证据（2026-10-06-v114-backflow-batch：两遍裁决——先文档级判实现证据在场，再逐条落判）
    const evRe = /证据[：:]/;
    const closeItem = () => { 
      if (pendX) { 
        ne = true; 
        pendX = false; 
      } 
      if (currentEvidence && !ex) {
        evidenceItems.push(currentEvidence);
      }
      currentEvidence = '';
    };
    for (const line of lines) {
      if (/存量对账豁免（/.test(line)) ex = true;
      if (/^\s*##\s+[^#]*验收标准/.test(line)) { hs = true; insec = true; closeItem(); continue; }
      if (insec && /^\s*##\s/.test(line)) { insec = false; closeItem(); continue; }
      if (!insec) continue;
      if (/^\s*- \[ \]/.test(line)) { closeItem(); uc = true; continue; }
      if (/^\s*- \[x\]/.test(line)) { 
        closeItem(); 
        pendX = !evRe.test(line); 
        if (evRe.test(line)) currentEvidence = line.split(/证据[：:]/)[1].trim();
        continue; 
      }
      if (pendX && evRe.test(line)) { 
        pendX = false; 
        currentEvidence = line.split(/证据[：:]/)[1].trim();
      } else if (currentEvidence && line.trim() && !/^\s*- /.test(line)) {
        // 简单累加续行证据
        currentEvidence += ' ' + line.trim();
      }
    }
    closeItem(); // 节末（或全文末）仍无证据 → 计缺证据
    // 两遍裁决（2026-10-06-v114-backflow-batch 记录型提交豁免）：文档级先判「存在可过检实现证据」
    // （sha / process 型任一），记录型提交（subject=docs 系）证据仅在实现证据在场时降级豁免告警——
    // 冒烟报告 / approved 留痕 / 关单提交不改 plan 声明面属预期；仅引记录型而无实现证据 → 维持 hard-block
    //（豁免通道不得独立成立，防「只引 docs 提交洗白代码改动」）。
    if (evidenceItems.length) {
      const planBase = base.replace(/.md$/, '');
      // verify 对账 ctx：intent 首次加入 git ≥ verifySince（v5 锚）才参与；不可判定 → null 走 text 豁免
      const iadd = addedDateOf(intent);
      const vctx = typeof verifySinceOf === 'string' && iadd !== '' && iadd >= verifySinceOf
        ? { verifyRelevant: true, hasFresh: verifyFresh } : null;
      const results = evidenceItems.map((ev) => ({ t: verifyEvidenceTruth(ev, planBase, ROOT, vctx) }));
      const hasImplEvidence = results.some((r) => r.t.ok && (r.t.type === 'sha' || r.t.type === 'process'));
      for (const r of results) {
        if (r.t.ok && r.t.type === 'verify-missing') {
          warnings.push(`- [WARN 测试绿缺凭证] ${base} 验收证据声明「测试绿」但 24h 内无 verify 凭证（verifications.jsonl）——跑 node <插件根>/scripts/verify.mjs 后重跑（advisory，灰度第一档）`);
          continue;
        }
        if (r.t.ok) continue;
        if (r.t.type === 'irrelevant' && r.t.recordCommit && hasImplEvidence) {
          warnEvidenceExempt('record', planBase);
          continue;
        }
        blockers.push(`- [证据${r.t.type === 'forged' ? '伪造' : '无关'}] ${base} 验收证据校验失败: ${r.t.msg}`);
      }
    }
    // 生效日锚 = git 首次加入日期（2026-09-28 改；此前取文件名前 10 字符）。**准确收益**：关掉
    // 「改文件名日期（日常必写、零成本）即整段跳过 hard 门」这条通道；锚取 author date(%aI)，
    // 刻意伪造（`git commit --date=`）仍可绕过——与伪造台账同属本地信任边界内，不宣称"通道已关闭"。
    // 非 git / 查不到 → '' → isNew=false → 走存量口径（与既有语义一致：不可判定时不误报 hard）。
    const adddate = addedDateOf(intent);
    const isNew = adddate !== '' && adddate >= accCutoff;
    const docWord = path.basename(path.dirname(intent)) === 'plans' ? 'plan' : 'intent';
    if (!hs) {
      if (isNew) blockers.push(`- [验收未对账] done ${docWord} 缺「## 验收标准」节(勾验无从核对):${base}`);
      else if (!ex) legacyUnaccounted++;
      continue;
    }
    if (!uc && !ne) continue;
      if (isNew) {
        if (uc) blockers.push(`- [验收未对账] done ${docWord} 验收标准有未勾验项:${base}（逐条勾验并补证据：commit/用例/冒烟输出）`);
        if (ne) blockers.push(`- [验收缺证据] ${base} 验收标准勾选项缺「证据：」标注——证据是闭环准确性的唯一机器事实`);
      } else if (!ex) {
        legacyUnaccounted++;
      }
  }
  if (legacyUnaccounted > 0) {
    warnings.push(`- [WARN 验收对账存量] ${legacyUnaccounted} 个存量 done intent 验收标准未对账（生效日锚之前加入仓库，豁免 hard，不回填）`);
  }
}
}
