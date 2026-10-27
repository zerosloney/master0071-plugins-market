// check-loop-sections/s19-stage-audit.mjs — 19. 逐阶段审计 [warning]（stage-gate-machine；口径与 stage-
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

import { loadAllConfirmations } from '../ledger-loader.mjs';

export function run() {
// --- 19. 逐阶段审计 [warning]（stage-gate-machine；口径与 stage-gates.mjs / fill-* / confirm-doc 前置门互引） ---
// 判据 A（在途扫描）：同名 spec/plan 为 draft 且其日期 ≥ stageGateSince 时——入口未确认（intent：状态非
//   approved/done、或缺台账行且非存量；incident：「时间线」小节缺行首「用户确认」条目）→ warning；
//   入口缺合法「级别」→ warning（与起草门 fail-closed 同口径，2026-09-30 复核 P2-7）；
//   plan 另判（入口级别 L2/L3 且 spec 未确认或缺失）→ warning。
// 判据 B（台账顺序）：同主题 {intents,specs,plans} 的 approved 行（每 doc 取最早）时间须非降序；仅对
//   组内最早 ts 日期 ≥ stageGateSince 的主题判定；含更早 ts 的主题整组跳过（历史豁免）。
// 协作道异步审计豁免已随 risk 双协议退役（2026-10-10 收敛系列 2；使用率 5%，见机制台账）——
//   draft 起草先于入口确认、审批顺序倒置一律照常出账（留痕是对账的机器事实）。
// stageGateSince 缺键（policy v1）→ 本检查整体跳过；全部 warning、不 hard-block。
{
  const since = kitPolicy.stageGateSince;
  if (typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    // 台账统一视图（主台账+分片透明合并；坏行容忍、同 doc|stage|fingerprint 键去重取末次——同检查 15 口径单源）
    const ledgerRows = loadAllConfirmations(ROOT);
    const hasRow = (rel) => ledgerRows.some((e) => e && e.doc === rel && (e.stage === 'approved' || e.stage === 'done'));
    const docConfirmed = (rel, abs) => {
      const st = fmGet(abs, '状态');
      if (st !== 'approved' && st !== 'done') return { ok: false, legacy: false, why: `状态「${st || '缺失'}」` };
      if (hasRow(rel)) return { ok: true, level: fmGet(abs, '级别'), legacy: false };
      const d = fmGet(abs, '日期') || fmGet(abs, '发现');
      const legacy = (linesOf(abs) || []).some((l) => /^流程: legacy/.test(l))
        || (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < kitPolicy.confirmDocsEffective);
      if (legacy) return { ok: true, level: fmGet(abs, '级别'), legacy: true };
      return { ok: false, legacy: false, why: '无确认台账行' };
    };
    // incident 留痕判定：**直接复用 stage-gates.mjs 的 MARK_RE**（第七轮复核 N3：此前此处内联复制
    // 一份同口径字面量，两处靠注释人工同步、无测试钉住——改为单源复用，从结构上消除漂移可能）。
    // 判据同源：「## 时间线」小节内、行首列表条目含「用户确认」（词边界见 MARK_RE）。
    const incidentMarked19 = (lines) => {
      let inTimeline = false;
      for (const l of lines || []) {
        if (/^##\s/.test(l)) { inTimeline = /^##\s*时间线/.test(l); continue; }
        if (inTimeline && MARK_RE.test(l)) return true;
      }
      return false;
    };
    const entryConfirmed19 = (base) => {
      const irel = `${WF}/intents/${base}.md`;
      const iabs = path.join(ROOT, irel);
      if (fs.existsSync(iabs)) {
        const st19 = fmGet(iabs, '状态');
        const lvl19 = fmGet(iabs, '级别');
        const r = docConfirmed(irel, iabs);
        const body = (linesOf(iabs) || []).join('\n');
        const d19 = fmGet(iabs, '日期') || fmGet(iabs, '发现');
        const storLegacy = /^流程: legacy/m.test(body) || (/^\d{4}-\d{2}-\d{2}$/.test(d19) && d19 < kitPolicy.confirmDocsEffective);
        return { ...r, level: lvl19, risk: fmGet(iabs, 'risk_level'), date: d19, entryDraft: st19 === 'draft', storageLegacy: storLegacy };
      }
      const crel = `${WF}/incidents/${base}.md`;
      const cabs = path.join(ROOT, crel);
      if (fs.existsSync(cabs)) {
        const st = fmGet(cabs, '状态');
        if ((st === 'open' || st === 'fixed' || st === 'closed') && incidentMarked19(linesOf(cabs))) {
          return { ok: true, level: fmGet(cabs, '级别'), legacy: false, storageLegacy: false };
        }
        return { ok: false, legacy: false, storageLegacy: false, why: 'incident 未见过目留痕（时间线条目缺失）' };
      }
      return { ok: false, legacy: false, storageLegacy: false, why: '无同名入口' };
    };
    for (const sub of ['specs', 'plans']) {
      for (const abs of docFiles(sub)) {
        if (fmGet(abs, '状态') !== 'draft') continue;
        const base = path.basename(abs).replace(/\.md$/, '');
        // 日期：frontmatter 优先，缺则回落文件名前缀（plan 无「日期」字段；沿检查 15 口径）
        let d = fmGet(abs, '日期');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = /^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '';
        if (!(/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= since)) continue;
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        const ent = entryConfirmed19(base);
        if (!ent.ok) {
          // L1 plan 即入口：draft 阶段本来就没有更早的 intent/incident，不出「起草先于入口确认」。
          // L2/L3、以及已有入口但未确认的，仍出账。
          const selfEntry = sub === 'plans' && fmGet(abs, '级别') === 'L1'
            && !fs.existsSync(path.join(ROOT, WF, 'intents', `${base}.md`))
            && !fs.existsSync(path.join(ROOT, WF, 'incidents', `${base}.md`));
          if (selfEntry) continue;
          // 协作道异步审计豁免已退役（2026-10-10 收敛系列 2）：draft 起草先于入口确认一律出账；
          // approved/done 无台账行仍照报（防手改状态冒充确认）；incident 入口照报（过目留痕轻量）。
          warnings.push(`- [WARN 逐阶段] ${rel} 起草先于入口确认（${ent.why}）`); continue;
        }
        // 库存量形态（标记 / 日期早于生效日）短路 level 校验与 spec 档（与起草门同口径，N1）
        const storLegacy = ent.storageLegacy === true;
        if (!storLegacy && !/^L[1-3]$/.test(ent.level)) { warnings.push(`- [WARN 逐阶段] ${rel} 入口缺合法「级别」字段（无法判定前置深度；与起草门 fail-closed 同口径，库存量形态除外）`); continue; }
        if (sub === 'plans' && !storLegacy && (ent.level === 'L2' || ent.level === 'L3')) {
          const srel = `${WF}/specs/${base}.md`;
          const sabs = path.join(ROOT, srel);
          const sp = fs.existsSync(sabs) ? docConfirmed(srel, sabs) : { ok: false, why: '缺同名 spec' };
          if (!sp.ok) warnings.push(`- [WARN 逐阶段] ${rel} 起草先于 spec 确认（${sp.why}）`);
        }
      }
    }
    const firstApproved = new Map(); // base -> { intents?, specs?, plans? } 最早 approved ts
    for (const e of ledgerRows) {
      if (!e || e.stage !== 'approved' || typeof e.doc !== 'string') continue;
      const m = /^workflow\/(intents|specs|plans)\/(.+)\.md$/.exec(e.doc);
      if (!m) continue;
      const rec = firstApproved.get(m[2]) || {};
      if (!rec[m[1]] && typeof e.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(e.ts)) rec[m[1]] = e.ts;
      firstApproved.set(m[2], rec);
    }
    for (const [base, rec] of firstApproved) {
      const seq = ['intents', 'specs', 'plans'].filter((k) => rec[k]);
      if (seq.length < 2) continue;
      // 协作道顺序豁免已退役（2026-10-10 收敛系列 2）：审批顺序倒置（如 plan 先于 intent approved）
      // 一律出账——台账顺序是对账机器事实。
      const earliest = seq.map((k) => rec[k]).sort()[0];
      if (!(earliest.slice(0, 10) >= since)) continue;
      let ordered = true;
      for (let i = 1; i < seq.length; i++) if (rec[seq[i]] < rec[seq[i - 1]]) ordered = false;
      if (!ordered) warnings.push(`- [WARN 逐阶段] 台账审批顺序倒置：${base}（${seq.map((k) => `${k}=${rec[k].slice(0, 19)}`).join(' / ')}）`);
    }
  }
}
}
