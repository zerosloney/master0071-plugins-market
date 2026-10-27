// check-loop-sections/s15-fingerprint.mjs — 15. 确认指纹对账 [hard-block]（confirm-gate-machine；2026
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
  commitmentFingerprint,
} from '../check-loop-kit.mjs';

import { loadAllConfirmations } from '../ledger-loader.mjs';

export function run() {
// --- 15. 确认指纹对账 [hard-block]（confirm-gate-machine；confirm-gate-delegated 两形态；
//     生效日锚 2026-09-28 改台账 ts——此前锚取自文档自报「日期/发现」，新档只要把日期写早即整段跳过判定，
//     incident 2026-09-28-confirm-gate-effective-date-anchor 实证）---
// 确认两形态（confirm-doc.mjs）：TTY 亲手键入「可以」/ --delegated 对话委托代录（用户对话内明确放行后
// AI 代录，台账行如实记 source=chat-delegated + quote 原话，永不伪装 TTY）。intents/specs/plans 凡
// approved/done 须有 confirm-doc 产生的 frontmatter 确认指纹 + 台账（.agents/confirmations.jsonl）
// 配对行——配对判据 doc/stage/fingerprint 三键，与 source 无关。
// **生效日锚 = 台账 ts（2026-09-28 起）**：受管准入 = 该 doc 在台账中有合法跳转行（stage ∈ approved/done/
// fixed/closed/superseded/cancelled，append-only 取末次）；无台账行 = 存量豁免（不追溯）。自报日期
// （日期/发现/文件名）不再参与门禁判定——它可被作者手填，把「门是否生效」的决定权交给被约束对象本身
// 是自举漏洞；台账行是「确认确实发生过」的唯一机器事实。docs 与 incidents 共用同一锚（原 incidents
// 独立生效日 2026-09-28 常量退役：台账起算日 = docs 生效日，两档等价）。
// 台账坏行容忍跳过（审计件，jsonl 追加式）；frontmatter 存 16 位、台账存 64 位，按前 16 位配对。
{
  const EFFECTIVE = kitPolicy.confirmDocsEffective;
  const ledger = loadAllConfirmations(ROOT);
  // incidents 侧覆盖（gate-coverage）：fixed/closed 为已确认态（open = 起草态不加门——
  // maintain.md 创建即对话确认的既有口径）
  // 放弃态覆盖（closing-coverage）：superseded/cancelled 入配对集——confirm-doc --to 是唯一
  // 合法产生通道（cancelled 自 draft/approved/open/fixed；superseded 自 approved/done/fixed/closed），
  // 此前手改 frontmatter 即出账的口子收死
  const CONFIRMED_BY_SUB = {
    intents: ['approved', 'done', 'superseded', 'cancelled'],
    specs: ['approved', 'done', 'superseded', 'cancelled'],
    plans: ['approved', 'done', 'superseded', 'cancelled'],
    incidents: ['fixed', 'closed', 'superseded', 'cancelled'],
  };
  // 合法跳转 stage 集（台账行「确认确实发生过」的判据；revert-draft / revert-open 类回退注记行不算）
  const VALID_STAGES = new Set(['approved', 'done', 'fixed', 'closed', 'superseded', 'cancelled']);
  for (const [sub, confirmedSet] of Object.entries(CONFIRMED_BY_SUB)) {
    for (const doc of docFiles(sub)) {
      const st = fmGet(doc, '状态');
      if (!confirmedSet.includes(st)) continue;
      const base = path.basename(doc);
      const rel = path.relative(ROOT, doc).split(path.sep).join('/');
      // 受管准入 = 两条件取或（2026-09-28 改锚）：
      //   ① 台账中有该 doc 的合法跳转行——「确认确实发生过」的机器事实；它独立于自报日期成立，
      //      故堵死「确认过却把日期写早以逃掉对账」这条攻破路径（本 incident 的核心缺陷）；
      //   ② 自报日期 ≥ 生效日——覆盖「新档完全没跑 confirm-doc」的漏网面（此类无台账行，
      //      仅靠 ① 会被误判为存量豁免而静默放行）。
      // 两条件皆不满足 = 存量豁免（生效日前既有、从未走确认门，不追溯）。
      const docEntries = ledger.filter((e) => e && e.doc === rel && VALID_STAGES.has(e.stage));
      const eff = sub === 'incidents' ? kitPolicy.confirmIncidentsEffective : EFFECTIVE;
      let d = fmGet(doc, '日期') || fmGet(doc, '发现');
      if (!d) d = /^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '';
      const dateManaged = /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= eff;
      if (!docEntries.length && !dateManaged) continue; // 存量豁免
      const fp = fmGet(doc, '确认指纹');
      const ok = !!fp && docEntries.some((e) => e.stage === st
        && typeof e.fingerprint === 'string' && e.fingerprint.startsWith(fp));
      if (!ok) {
        blockers.push(`- [确认未对账] ${base} 状态 ${st} 无用户确认记录——AI 不得代确认，用户在终端跑 node .agents/scripts/confirm-doc.mjs ${rel} 后重试`);
      }
      // 内容绑定（audit-gate-hardening；生效锚 gate-hardening-p2-batch 自文档自报日期
      // 改为台账 done 行 ts）：done 文档当前内容须与台账 done 行确认时的内容一致——按 prev 复原跳转前文本
      // 重算比对，防「确认后篡改」（改验收标准/正文均触发）。复原口径 = confirm-doc computeFingerprint 的
      // 逆推：CRLF 归一 → frontmatter 首个「状态:」行保分隔符换值为台账 prev（双空格等非规范分隔符不误伤，
      // 与前向按原行字面计算对称）→ 剔「确认指纹:」行。两条降级路径：台账行缺 prev（schema 演进前存量，
      // 无以复原）→ warning 不拦；entry.ts 早于 2026-09-28（UTC 字符串比较——该次确认在旧关单顺序时代完成）→
      // 豁免绑定（配对判定已过，3 份失配存量即此列）。关单编辑顺序新约定不变：confirm-doc 是最后一次写入，
      // 此后修订走 superseded 或新 intent。
      if (ok && ['done', 'closed', 'superseded', 'cancelled'].includes(st)) {
        const doneEntries = ledger.filter((e) => e && e.doc === rel && e.stage === st && typeof e.fingerprint === 'string');
        const entry = doneEntries[doneEntries.length - 1]; // append-only 台账，末次生效（重确认场景）
        if (!entry || !entry.prev) {
          warnings.push(`- [WARN 绑定降级] ${base} 台账 stage=${st} 行缺 prev 字段（schema 演进前行），内容绑定跳过——仅配对判定`);
        } else if (!(typeof entry.ts === 'string' && entry.ts >= kitPolicy.bindingTs)) {
          // 该 done 确认发生在生效锚前（旧关单顺序时代）——豁免内容绑定，配对判定照常
        } else if (bindingSha256(linesOf(doc) || [], entry.prev) !== entry.fingerprint) {
          blockers.push(`- [确认内容漂移] ${base} ${st} 后内容与确认台账不符——已关单文档不得直接改（关单编辑先于关单确认）；确需修订走 superseded 或新 intent 引用`);
        }
      }
      // 承诺面绑定（approved-content-binding 2026-10-27）：approved 档的承诺绑定。整篇逐字比对会误伤
      // 关单期合法动作（勾验收 + 证据回填、确认结果/确认时间回填、复核行改锚），故 approved 档改绑
      // 「承诺面」（判据文本 / 红线 / 目标 / 改动方案 / 约束与风险）：承诺在用户点头后被改写而未重新
      // 点头 → hard-block（用户点头的不是现在这一份）。判据单源 = stage-gates.commitmentFingerprint，
      // 与 confirm-doc 的「承诺面绑定门」（关单时刻）同口径。存量 approved 行无 commit 字段（本次
      // 上线前确认）→ 静默跳过、不回溯（沿本段「batch 字段缺失静默跳过」同款处置）。
      if (ok && st === 'approved') {
        const apprWithCommit = ledger.filter((e) => e && e.doc === rel && e.stage === 'approved'
          && typeof e.commit === 'string' && typeof e.fingerprint === 'string');
        const byFp = fp ? apprWithCommit.filter((e) => e.fingerprint.startsWith(fp)) : [];
        const pool = byFp.length ? byFp : apprWithCommit;
        const lastAppr = pool[pool.length - 1];
        if (lastAppr) {
          const nowCommit = commitmentFingerprint(linesOf(doc) || []);
          if (nowCommit !== lastAppr.commit) {
            blockers.push(`- [承诺面漂移] ${base} approved 后承诺面被改写（${lastAppr.commit} → ${nowCommit}）——用户点头的不是现在这一份；请用户重新点头后跑 node .agents/scripts/confirm-doc.mjs ${rel} --reconfirm --delegated "<原话>" 重录承诺面指纹（仅勾验收/补证据/复核行改动不应触发本门——若触发请登记 papercut）`);
          }
        }
      }
    }
  }
  // 并录批次审计（batch-ledger-audit 改判据；原 confirm-gate-one-per-call 引入）：
  // **读调用事实，不猜时间戳模式**。判据 = 台账行按 `batch` 分组，组内 `of > 1` → warning「确认并录」。
  // batch/seq/of 由 confirm-doc 在**写入时**记录（那才是「本次调用落了几份」确定已知的时刻）；
  // 旧判据「同 quote + 相邻 ts 差 < 2s」是拿两个间接信号反推该事实，已实证四类失效并**整段退役**：
  //   ① 假阳性：合规逐件调用复用同句（用户两次都说「可以」）→ 必然误报；
  //   ② 假阴性：并录时给每份换不同 quote → 零告警（判据的实际效果是引导伪装者改 quote）；
  //   ③ 噪声不可消退：不按日期门豁免，退役前本仓 22 条 advisory 中 14 条为该告警，且文案自认「不可区分」；
  //   ④ 字段职责冲突：`quote` 同时当「对质凭据」与「并录指纹」——现归还单一职责，只记用户原话。
  // 无 `batch` 字段的历史行（schema 演进前，本仓全部 67 行均无该字段）→ **静默跳过**，不降级出账、不回溯：
  // 按 audit-gate-hardening P3 教训（「扫了只产生不可消除的 advisory 噪声，真漏点被淹没」），无判定依据
  // 的行不该产出告警。VALID_STAGES 复用外层声明（复核 P2-3 更正：此前本块内另有一份同名声明遮蔽外层）。
  {
    const byBatch = new Map(); // batch → 该批的台账行（仅计合法跳转 stage）
    for (const e of ledger) {
      if (!e || !VALID_STAGES.has(e.stage)) continue;
      if (typeof e.batch !== 'string' || !e.batch) continue; // 历史行无 batch → 无判定依据，跳过
      if (!byBatch.has(e.batch)) byBatch.set(e.batch, []);
      byBatch.get(e.batch).push(e);
    }
    for (const [b, rows] of byBatch) {
      // 判据取组内**任一行** of>1（复核 P2-3 更正：原取 rows[0].of 使结论依赖行序——同批首行 of=1、
      // 次行 of=2 会漏报。confirm-doc 对同批所有行写同一个 of=docs.length，故正常批次组内一致；
      // 改用 some 消除该顺序脆弱性，并对 craft 出来的不一致批次按「最大值」报，方向偏严不偏松）
      if (!rows.some((r) => typeof r.of === 'number' && r.of > 1)) continue;
      // of > 1 = 一次调用落多份态。delegated 形态下这正是「并录」（入口已拒多份，此处抓历史/绕行）；
      // TTY 形态天然逐份过目（用户亲手键入），of>1 不构成违规——故只对 delegated 行报。
      if (!rows.some((r) => r.source === 'chat-delegated')) continue;
      // 协作道批量豁免（hybrid-governance-risk-lanes）：confirm-doc --batch 仅受理 L1
      // （逐份读级别，L2/L3 逐份拒绝），台账行带 brief:true——全行带标记的批次是 sanctioned 泳道行为
      // （异步审计兜底），不出「确认并录」；缺标记（旧版脚本/手造台账）照旧告警，判据偏严不偏松。
      if (rows.every((r) => r.brief === true)) continue;
      const of = Math.max(...rows.map((r) => (typeof r.of === 'number' ? r.of : 0)));
      const docs = rows.map((r) => String(r.doc).replace(/^workflow\//, '')).join('、');
      warnings.push(`- [WARN 确认并录] 单次调用落账 ${rows.length} 份（batch ${b}，of=${of}）：${docs}——同一次 --delegated 调用放行多份，塌掉「逐件确认」门（build.md）；口径见 workflow/papercuts.md 2026-09-28 与 incidents/2026-09-28-batch-ledger-audit.md`);
    }
  }
}
}
