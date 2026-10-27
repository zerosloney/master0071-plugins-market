// stage-gates.mjs — 逐阶段前置判定的单源（fill-spec / fill-plan / confirm-doc 共享；stage-gate-machine）
// 口径（与 check-loop 检查 19 内联实现互引——改一处须跟另一处）：
//   入口「已确认」= 文件存在且 frontmatter 状态 ∈ {approved, done}，且【机器事实源】满足其一：
//     ① confirmations.jsonl 台账存在该 doc 的 stage ∈ {approved, done} 行（经 confirm-doc 才产生，防手改状态冒充）；
//     ② 存量口径：文档日期早于 policy.confirmDocsEffective，或行首含「流程: legacy」。
//   incident 入口 = 文件存在 + 「时间线」小节内、行首列表条目含「用户确认」（原 maintain.md §3 约定；
//     2026-09-30 复核 P2-1 收窄为小节内行首条目；第三轮复核 P1-1 起接受日期前缀形态，与模板样例一致）；
//     状态 ∈ {open, fixed, closed}（spec/plan 须先于 fixed 起草，故 open 即为有效态）。
//   入口「级别」须 ∈ L1-L3；缺失即拒（fail-closed）——**但库存量形态短路**（`流程: legacy` 或 日期早于
//     确认门生效日）：跳过级别校验与 spec 档（2026-09-30 增量复核 N1——存量最可能缺级别，硬拒会锁死
//     spec 起草与确认）。
//   注意：**库存量信号本身即等于「入口已确认」**（judgeDoc：`台账行 || 存量口径`，与检查 15 / 检查 1 /
//     配对门的既有口径一致——早于确认门生效日的自报日期即存量豁免，不要求另有台账行）；此处「短路」
//     只额外豁免**级别前置与 spec 档**，不是对台账要求的二次豁免（P2-1：原注释把二者写反，已订正）。
//   plan 门追加：入口级别（取入口 frontmatter 级别，不取工具 --level）为 L2/L3 时，同名 spec 须已确认（同口径）。
//   探索泳道豁免（hybrid-governance-explore-hardening）：同名 intent 仍为 draft 且风险泳道为
//     L1 →「先起草后确认」是协作道
//     语义（check-loop 检查 19 同款豁免口径），放行 spec/plan 起草与确认；L2/L3 防御道维持入口确认前置。
//     incident 入口不豁免（过目留痕本就轻量）。（原「收口由加固门兜底」随 2026-10-10 收敛系列 2 退役。）
//   L1 plan 即入口（2026-10-10）：kind=plan 且无同名 intent/incident 时，级别为 L1（已有文件读 frontmatter，
//     尚未落盘则读 opts.level）即放行。L2/L3 与 spec 仍要求先有入口。
// 信任边界声明（沿 audit-gate-hardening 口径）：本地可写台账 / 手改状态仍可伪造——本模块只把
//   「顺手绕过」抬到「主动伪造」，不宣称通道关闭；事后对质靠 git 历史与台账。
// 设计先例：fill-* 已 import 同目录 workflow-enums.mjs；check-loop 检查 19 内联同口径（门禁脚本自包含、防兄弟依赖）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadKitPolicy } from './policy.mjs';

export const ENTRY_STATUSES = ['approved', 'done'];
export const INCIDENT_STATUSES = ['open', 'fixed', 'closed'];

// commitmentFingerprint：承诺面指纹（approved 档内容绑定的单源；2026-10-27 approved-content-binding）
// 语义：用户在 approved 那一刻点头的是「承诺面」——判据文本、红线、目标、改动方案、约束与风险；
// 关单期的合法动作（勾验收 + 证据回填、确认结果/确认时间回填、复核行改锚）不改承诺面，故归一掉。
// 归一规则（逐条对应真实关单动作，边界如实声明）：
//   ① 剔「确认指纹:」行（指纹自指，与 computeFingerprint 同口径）
//   ①' 剔 frontmatter「状态:」行（状态机自有字段——draft→approved→done 是合法推进，不是承诺变更；
//      不剔会把每次状态推进误判为承诺改写）
//   ② 剔 frontmatter「确认结果:」「确认时间:」（L3 spec 关单前置回填）
//   ③ 剔复核行（行首「- 复核:」「- 独立复核:」或含「复核上下文：」）——复核锚改写属关单前置动作
//   ③b 剔确认记录行（行首「- 确认结果:」「- 确认时间:」）——确认记录非承诺（frontmatter 同名键见②）
//   ④ 勾选态归一：`- [x]`/`- [X]` → `- [ ]`（勾验收是关单动作，不是承诺变更）
//   ⑤ 剔证据尾注：`（证据：…）`/`(证据:…)` 整段，及行内首个「证据：」至行尾
// 诚实边界：承诺若被藏进证据括号或复核行，机器看不见——不宣称通道关闭（同本模块信任边界声明口径）。
export function commitmentFingerprint(text) {
  const lines = Array.isArray(text) ? text : String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFm = false;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (i === 0) {
      if (/^---\s*$/.test(l)) { inFm = true; out.push(l); continue; }
    }
    if (inFm) {
      if (/^---\s*$/.test(l)) { inFm = false; out.push(l); continue; }
      if (/^确认指纹:/.test(l)) continue;
      if (/^状态:/.test(l)) continue;
      if (/^(确认结果|确认时间):/.test(l)) continue;
    }
    if (/^\s*[-*]\s*(独立复核|复核)\s*[：:]/.test(l) || l.includes('复核上下文：')) continue;
    if (/^\s*[-*]\s*(确认结果|确认时间)\s*[：:]/.test(l)) continue;
    l = l.replace(/[（(][^（）()]*证据[：:][^（）()]*[）)]/g, '');
    const ev = l.search(/证据[：:]/);
    if (ev >= 0) l = l.slice(0, ev);
    l = l.replace(/^(\s*[-*]\s*)\[[xX]\]/, '$1[ ]');
    l = l.replace(/\s+$/, '');
    if (!l.trim()) continue;
    out.push(l);
  }
  return createHash('sha256').update(out.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

// readFm：frontmatter 区（首 --- 至闭合 ---）取单字段值；无 frontmatter / 无该键 → ''
export function readFm(abs, key) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return ''; }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (!/^---\s*$/.test(lines[0] || '')) return '';
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) break;
    const m = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (m) return m[1].trim();
  }
  return '';
}

function readBody(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; }
}

import { loadAllConfirmations } from './ledger-loader.mjs';

// readLedger：透明支持主台账与 .agents/confirmations.d/*.jsonl 分片台账
export function readLedger(root) {
  return loadAllConfirmations(root);
}

// judgeDoc：状态枚举 + 机器事实源判定（供入口 / spec 复用）
// legacy：库存量信号（`流程: legacy` 标记 或 日期 < confirmDocsEffective）——所有调用方与门禁其余部分
// 同口径（配对门 / 检查 1 / 检查 15 / 检查 19）；2026-09-30 复核 N1：存量入口须先短路，不得被
// 「缺级别」fail-closed 硬拒（存量最可能缺级别，硬拒会锁死 spec 起草/确认，违反「存量零新增」契约）。
function judgeDoc(root, abs, rel, statuses) {
  const st = readFm(abs, '状态');
  if (!statuses.includes(st)) {
    return { ok: false, status: st, legacy: false, reason: `状态「${st || '缺失'}」不在 ${statuses.join(' / ')}` };
  }
  const policy = loadKitPolicy(root);
  const body = readBody(abs);
  const legacyByMarker = body.split(/\r?\n/).some((l) => /^流程: legacy/.test(l));
  const d = readFm(abs, '日期') || readFm(abs, '发现');
  const legacyByDate = /^\d{4}-\d{2}-\d{2}$/.test(d) && d < policy.confirmDocsEffective;
  const legacy = legacyByMarker || legacyByDate;
  const hasRow = readLedger(root).some((e) => e && e.doc === rel && (e.stage === 'approved' || e.stage === 'done'));
  if (hasRow || legacy) return { ok: true, status: st, legacy };
  return { ok: false, status: st, legacy: false, reason: `无确认台账行（门禁后的入口须经 confirm-doc，且台账无 ${rel} 的 approved / done 行）` };
}

// entryStorageLegacy：入口是否属「库存量」形态（`流程: legacy` 标记 或 日期早于确认门生效日）——
// 与 judgeDoc 的存量信号同口径，供门在**级别校验**处短路（2026-09-30 增量复核 N1）。注意：本短路
// **只豁免 level 前置**（存量多为门禁前建档、无级别字段），**不豁免台账要求**——`judgeDoc` 的
// hasRow||legacy 仍照常判定（门禁后无台账行即拒，不因日期早于生效日而放行）。
export function entryStorageLegacy(root, abs) {
  const body = readBody(abs);
  if (body.split(/\r?\n/).some((l) => /^流程: legacy/.test(l))) return true;
  const d = readFm(abs, '日期') || readFm(abs, '发现');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < loadKitPolicy(root).confirmDocsEffective;
}

// incidentMarked：「## 时间线」小节内、行首列表条目形态的「用户确认」（维持口径；正文叙述句不算——
// 2026-09-30 复核 P2-1 实证：全仓唯一历史命中为叙述句，非过目留痕）。
// 行首可选日期前缀（`- 2026-09-30 用户确认：…`）与可选加粗（`- **用户确认**：…`）均接受——
// 与 _TEMPLATE.md 时间线样例形态保持一致（2026-09-30 第三轮复核 P1-1：样例若不可解析即误导）。
export function incidentMarked(body) {
  let inTimeline = false;
  for (const l of String(body).replace(/\r\n/g, '\n').split('\n')) {
    if (/^##\s/.test(l)) { inTimeline = /^##\s*时间线/.test(l); continue; }
    if (inTimeline && MARK_RE.test(l)) return true;
  }
  return false;
}

// MARK_RE：行首列表条目 + 可选日期前缀（YYYY-MM-DD 或 <日期> 占位）+ 可选加粗围栏（词前 / 词后均可）
// + 「用户确认」+ **须紧跟冒号或行尾**（词边界）。
// 形态矩阵（2026-09-30 四/五轮复核收敛，8 正例 / 5 负例由 fill-spec.test S19/S20 钉死）：
//   命中：`- 用户确认：…` / `- **用户确认**：…` / `- 2026-09-30 用户确认：…` / `- <日期> **用户确认**：…` / 行尾无冒号
//   拒绝：`- 2026-09-30 用户确认了方案` / `- 用户确认书已归档` / `- 用户确认。` / `- 待用户确认：…`
//   注：词前的 `\**` 与词后的 `\**` 必须都允许——只开一侧即产生结构性假阴性（第五轮复核 P1 实证：
//   加粗围栏形态被拒，与 _TEMPLATE.md 自述契约冲突）。
export const MARK_RE = /^\s*[-*]\s*(?:\d{4}-\d{2}-\d{2}|<日期>)?\s*\**用户确认\**(?=\s*[：:]|\s*$)/;

// entryConfirmed：同主题入口判定（intent 优先；否则 incidents）——返回 {ok, kind, rel, level, status, reason?}
export function entryConfirmed(root, base) {
  const intentRel = `workflow/intents/${base}.md`;
  const intentAbs = path.join(root, intentRel);
  if (fs.existsSync(intentAbs)) {
    const r = judgeDoc(root, intentAbs, intentRel, ENTRY_STATUSES);
    return { ...r, kind: 'intent', rel: intentRel, level: readFm(intentAbs, '级别'), date: readFm(intentAbs, '日期'), storageLegacy: entryStorageLegacy(root, intentAbs) };
  }
  const incRel = `workflow/incidents/${base}.md`;
  const incAbs = path.join(root, incRel);
  if (fs.existsSync(incAbs)) {
    const st = readFm(incAbs, '状态');
    const level = readFm(incAbs, '级别');
    if (INCIDENT_STATUSES.includes(st) && incidentMarked(readBody(incAbs))) {
      return { ok: true, kind: 'incident', rel: incRel, level, status: st, legacy: false };
    }
    const why = !INCIDENT_STATUSES.includes(st) ? `状态「${st || '缺失'}」非法` : '「时间线」小节缺「用户确认」条目（maintain.md §3）';
    return { ok: false, kind: 'incident', rel: incRel, level, status: st, legacy: false, reason: `同名 incident 未过目确认——${why}` };
  }
  return { ok: false, kind: null, rel: null, level: '', status: '', reason: `未找到同名入口（workflow/intents 与 workflow/incidents 均无 ${base}.md）` };
}

// specConfirmed：plan 门的 L2/L3 追加要求
export function specConfirmed(root, base) {
  const rel = `workflow/specs/${base}.md`;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ok: false, reason: `缺同名 spec（${rel}）` };
  return judgeDoc(root, abs, rel, ENTRY_STATUSES);
}

// ---- 关单完成度门（closeout-completeness 2026-10-24）----
// 背景（复核 P1）：两个承诺此前只有 closeout skill §0 的流程内自核——L2/L3 intent →done 既不要求
// 同名 plan 已确认（s01 仅 WARN），也不要求独立复核行（s01 只对 L3 spec WARN）。agent 跳过自核即可
// 合规关单。本组把判据前移到 confirm-doc 的 →done 动作时刻（与 L2/L3 spec 关单门同一执法位置），
// 判据与 closeout skill §0 同口径，不新增第二套语义。
function archiveCandidates(root, kind, base) {
  const out = [];
  const ar = path.join(root, 'workflow', 'archive');
  if (!fs.existsSync(ar)) return out;
  for (const month of fs.readdirSync(ar)) {
    const p = path.join(ar, month, kind, `${base}.md`);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// planConfirmedFor：L2/L3 intent 关单门——同名 plan 须存在且已确认（approved/done）。
// 归档感知（关单即归档是既有语义）；台账匹配仍用原路径（归档不改台账 doc 字段）。
// 边界（2026-10-24 复核 m2）：plan 被合法置 superseded/cancelled 时本门恒拒——该 intent 的 →done
// 通道随之关闭（superseded 不可逆）。正确处置是**intent 同步 superseded**，不是放宽本门；勿在
// 此处加 superseded 放行（否则「plan 已废弃但 intent 照样关单」成为逃逸路径）。
export function planConfirmedFor(root, base) {
  const rel = `workflow/plans/${base}.md`;
  const abs = path.join(root, rel);
  const target = fs.existsSync(abs) ? abs : archiveCandidates(root, 'plans', base)[0];
  if (!target) return { ok: false, reason: `缺同名 plan（${rel}，活跃与归档均未命中）` };
  return judgeDoc(root, target, rel, ENTRY_STATUSES);
}

// reviewLineFor：L2/L3 关单门——intent 或同名 spec 正文须有独立复核落盘行，且含可证伪基底。
// 判据与 check-loop s01（`^- 独立复核：`）及 closeout §0.3（行内含「复核上下文：」）单源。
const REVIEW_LINE_RE = /^- 独立复核：/;
export function reviewLineFor(root, base) {
  const found = [];
  for (const [kind, rel] of [['intents', `workflow/intents/${base}.md`], ['specs', `workflow/specs/${base}.md`]]) {
    const abs = path.join(root, rel);
    const paths = fs.existsSync(abs) ? [abs] : archiveCandidates(root, kind, base);
    for (const p of paths) {
      // 逐行全取（2026-10-24 复核 m1）：原 find() 只取每个文件**首个**「- 独立复核：」行——
      // 首行无「复核上下文：」而后续行有时会误拒（实证 specs/2026-10-18-po-concurrent-overorder-lost-update.md:202/:204）
      const lines = readBody(p).replace(/\r\n/g, '\n').split('\n').filter((l) => REVIEW_LINE_RE.test(l));
      for (const l of lines) found.push(l.trim());
    }
  }
  if (!found.length) return { ok: false, reason: 'intent 与 spec 均无「- 独立复核：」落盘行' };
  if (!found.some((l) => /复核上下文：/.test(l))) {
    return { ok: false, reason: '独立复核行缺「复核上下文：<会话/子代理 id>」（独立性声明无可证伪基底）' };
  }
  return { ok: true, line: found.find((l) => /复核上下文：/.test(l)) };
}

// laneOfDoc：泳道单源取法（2026-10-10 收敛系列 2 起**级别单字段协议**——原 risk_level 双字段协议
//   随 5% 使用率退役，见 .agents/config/mechanism-registry.md；存量 risk_level 字段宽容不校验）：
//   级别非法/缺失 → suspect（fail-closed 就严）；L1 → low，L2/L3 → high。
// suspect 消费规则：红线类检查按 low 执行（拦红线）；豁免类门（起草豁免/--batch/--auto/逐阶段深度）
// 按 high 执行（不豁免）。
export function laneOfDoc(level) {
  if (!/^L[1-3]$/.test(level || '')) return 'suspect';
  return level === 'L1' ? 'low' : 'high';
}

// ---- 歧义清单门（clarify-ledger 2026-10-22）----
// 设计取向：**入口靠闭集扫描，出口靠机器判据**。2026-10-16 的「模糊点纪律」只有出口（approved 前
// [NEEDS CLARIFICATION] 清零）——判据为空、无入口方法，等于把「发现自己的模糊」交给模型自我觉察，
// 而这是模型最不擅长的能力。此处补三件事：
//   ① 入口：固定 6 维（CLARIFY_DIMS）强制扫描，缺任一维即「未扫描」，杜绝选择性失明；
//   ② 判据：状态闭集（已定/待澄清）+ 待澄清归零 + 依据非空，全部机器可判，不依赖 agent 自述；
//   ③ 反逃避：可实验项必须在起草期用实验关闭（design.md §2 工序承载），只允许「任何实验都定不了」的
//      遗留为待澄清——本门只验形态，分型纪律由工序约束（不可机器判的部分不装成机器判）。
// 信任边界（同全模块口径）：把「漏想」抬到「显式写已定 + 编依据」的主动伪造，事后靠 git 历史对质。
export const CLARIFY_DIMS = ['状态与边界', '数据口径', '失败路径', '契约对称', '存量数据', '验收可测性'];
export const CLARIFY_STATUSES = ['已定', '待澄清'];

// parseClarifyTable：从 spec 正文解析「## 歧义清单」表（行首管道表；跳过表头与分隔行）
export function parseClarifyTable(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*歧义清单\s*$/.test(lines[i].trim())) { start = i; break; }
  }
  if (start < 0) return { found: false, rows: [] };
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^:?-{2,}:?$/.test(cells[0]) || cells[0] === '维度') continue; // 分隔行 / 表头
    rows.push({ dim: cells[0], concl: cells[1] || '', basis: cells[2] || '', status: cells[3] || '', line: i + 1 });
  }
  return { found: true, rows };
}

// clarifyGate：spec 确认门前置（confirmGateFor 调用）。
// applied=false 的三种情形一律放行且零噪声：政策无 clarifySince（v1–v12）/ 文档缺「日期」不可判定 / 锚前存量。
export function clarifyGate(root, docRel) {
  let pol = null;
  try { pol = loadKitPolicy(root); } catch { return { applied: false }; }
  const since = pol && pol.clarifySince;
  if (!since) return { applied: false };
  const abs = path.join(root, ...docRel.split('/'));
  const date = readFm(abs, '日期');
  if (!date) return { applied: false };
  if (date < since) return { applied: false };
  const { found, rows } = parseClarifyTable(readBody(abs));
  const hint = `补「## 歧义清单」表：6 维（${CLARIFY_DIMS.join(' / ')}）逐维一行，列序 维度 | 结论 | 依据 或 问题 | 状态；`
    + '可实验的先用实验关闭并写依据，只有「任何实验都定不了」的才留「待澄清」并当场问用户';
  if (!found) {
    return { applied: true, ok: false, reason: 'spec 缺「## 歧义清单」节（口径见 workflow/specs/_TEMPLATE.md）', hint };
  }
  const dims = new Set(rows.map((r) => r.dim));
  const missing = CLARIFY_DIMS.filter((d) => !dims.has(d));
  if (missing.length) {
    return { applied: true, ok: false, reason: `歧义清单缺维度：${missing.join('、')}（缺维 = 未扫描，不是「无歧义」）`, hint };
  }
  // 规模上界（2026-10-22，参照 spec-kit 对 [NEEDS CLARIFICATION] 的条数封顶）：清单是**收敛工具，不是工作台**。
  // 同一维超过 2 行 = 该维根本没想清（或把探索过程直接倒进表里），继续确认只会把不确定转嫁给读者。
  // 上界同时约束「向用户提问的量」——单轮问询的 5 问上限在 design.md §2.7 的工序里承载（机器看不到问询轮次）。
  const perDim = new Map();
  for (const r of rows) perDim.set(r.dim, (perDim.get(r.dim) || 0) + 1);
  const overDim = [...perDim.entries()].filter(([, n]) => n > 2);
  if (overDim.length) {
    return {
      applied: true, ok: false,
      reason: `歧义清单某维超过 2 行（${overDim.map(([d, n]) => `${d}×${n}`).join('、')}）——该维没想清，先做实验关闭或把需求拆小`,
      hint,
    };
  }
  const MAX_ROWS = CLARIFY_DIMS.length * 2;
  if (rows.length > MAX_ROWS) {
    return { applied: true, ok: false, reason: `歧义清单共 ${rows.length} 行，超上限 ${MAX_ROWS}（6 维 × 2）——清单已变工作台`, hint };
  }
  const badStatus = rows.filter((r) => !CLARIFY_STATUSES.includes(r.status));
  if (badStatus.length) {
    return { applied: true, ok: false, reason: `歧义清单状态列非法：第 ${badStatus.map((r) => r.line).join('、')} 行（仅允许 ${CLARIFY_STATUSES.join(' / ')}）`, hint };
  }
  const noBasis = rows.filter((r) => !r.basis || r.basis.length < 4);
  if (noBasis.length) {
    return { applied: true, ok: false, reason: `歧义清单缺依据：第 ${noBasis.map((r) => r.line).join('、')} 行（「已定」必须写凭什么定，否则等于没想过）`, hint };
  }
  const pending = rows.filter((r) => r.status === '待澄清');
  if (pending.length) {
    return {
      applied: true, ok: false,
      reason: `尚有 ${pending.length} 条待澄清未关闭：${pending.map((r) => r.dim).join('、')}`,
      hint: '先在对话里问用户拿判定，拿到后把该行状态改「已定」并写依据，再走确认门',
    };
  }
  return { applied: true, ok: true };
}

// ---- 验收覆盖门（coverage-map 2026-10-22）----
// 背景（实测）：L2/L3 的 intent↔spec 共 37 对，两侧各有一条证据链——intent 验收清单走 §8 勾验、
// spec 判据表走 §23 判据级对账——但**没有任何编号把两条链连起来**。后果：intent 新增一条验收而 spec
// 没同步时，§8 照样能勾、§23 照样能过，覆盖率只能靠条数粗比（现 300:228 = 0.76），无法判定是「一条判据
// 覆盖多条」还是「漏了」。本门补的就是这条单向映射：intent 验收条目编号 A1..An，spec 判据表「对应验收」
// 列引用之，每条 An 至少被引用一次。
// 刻意只做**单向**：反向（每条判据须有验收来源）会把并发压测这类技术判据逼着编一条假验收，制造仪式化数据。
// 挂在 spec 确认门而非 done：覆盖关系在「批准」时就该成立，等 done 时返工成本已最高。
export function parseIntentAcceptance(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let inSec = false;
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) { inSec = /^##\s*验收标准/.test(l); continue; }
    if (!inSec) continue;
    const m = /^\s*-\s*\[[ xX]\]\s*(.*)$/.exec(l);
    if (!m) continue;
    const idm = /^A(\d+)\b/.exec(m[1]);
    items.push({ id: idm ? `A${idm[1]}` : '', text: m[1].trim(), line: i + 1 });
  }
  return { items, unnumbered: items.filter((x) => !x.id).length };
}

// parseAcceptanceTable：spec「## 验收判据」表 → [{crit, ev, stat, refs:[]}]
export function parseAcceptanceTable(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let inSec = false;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) { inSec = /^##\s*.*验收判据/.test(l); continue; }
    if (!inSec || !/^\s*\|/.test(l)) continue;
    const cells = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^:?-{2,}:?$/.test(cells[0]) || cells[0].startsWith('判据（')) continue;
    if (/^<.*>$/.test(cells[0])) continue; // 模板占位行
    const refCell = cells[3] || '';
    const refs = (refCell.match(/A\d+/g) || []);
    rows.push({ crit: cells[0], ev: cells[1] || '', stat: cells[2] || '', refs, hasRefCol: cells.length >= 4 });
  }
  return rows;
}

// coverageGate：spec 确认门前置。applied=false：政策缺键 / 缺日期 / 锚前 / 无同名 intent（修复类）/ 无判据表。
export function coverageGate(root, docRel) {
  let pol = null;
  try { pol = loadKitPolicy(root); } catch { return { applied: false }; }
  const since = pol && pol.coverageSince;
  if (!since) return { applied: false };
  const abs = path.join(root, ...docRel.split('/'));
  const date = readFm(abs, '日期');
  if (!date || date < since) return { applied: false };
  const base = path.basename(docRel).replace(/\.md$/, '');
  const intentAbs = path.join(root, 'workflow', 'intents', `${base}.md`);
  if (!fs.existsSync(intentAbs)) return { applied: false };
  const acc = parseIntentAcceptance(readBody(intentAbs));
  if (!acc.items.length) return { applied: false };
  const rows = parseAcceptanceTable(readBody(abs));
  if (!rows.length) return { applied: false }; // 判据表缺失归 §23 管，不在此重复执法
  const hint = '给 intent「验收标准」每条加稳定编号 A1..An，再在 spec「验收判据」表第 4 列写对应编号（可一对多）';
  if (acc.unnumbered) {
    return { applied: true, ok: false, reason: `${base} 入口 intent 有 ${acc.unnumbered} 条验收未编号（锚后须 A1..An）`, hint };
  }
  const ids = acc.items.map((x) => x.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dup.length) return { applied: true, ok: false, reason: `入口 intent 验收编号重复：${[...new Set(dup)].join('、')}`, hint: '编号须唯一——增删用新号，不复用旧号（引用会指错）' };
  if (!rows.some((r) => r.hasRefCol)) {
    return { applied: true, ok: false, reason: 'spec「验收判据」表缺「对应验收」列（第 4 列）', hint };
  }
  const refs = new Set(rows.flatMap((r) => r.refs));
  const missing = ids.filter((id) => !refs.has(id));
  if (missing.length) {
    return {
      applied: true, ok: false,
      reason: `spec 未覆盖 ${missing.length}/${ids.length} 条 intent 验收：${missing.join('、')}`,
      hint: '给这些验收补判据行并填「对应验收」，或确认该验收已被现有判据覆盖后把编号补进对应行',
    };
  }
  return { applied: true, ok: true };
}

// draftGateFor：起草门总判（kind = 'spec' | 'plan'，fill 工具与 confirm-doc 逐阶段门共用）
export function draftGateFor(kind, root, base, opts = {}) {
  const entry = entryConfirmed(root, base);
  if (!entry.ok) {
    // 探索泳道豁免（hybrid-governance-explore-hardening）：L1 draft intent 放行起草
    // ——「先动手后确认」；泳道单源 laneOfDoc（2026-10-10 起级别单字段；suspect 不豁免——级别缺失/
    // 非法按防御道走入口确认）。
    const lane = laneOfDoc(entry.level);
    if (entry.kind === 'intent' && entry.status === 'draft' && lane === 'low') {
      return { ok: true, entry, laneBypass: true };
    }
    // L1 plan 即入口：没有 intent/incident 时，这份 plan 自己就是入口。
    // 文件已在则级别以文件为准（禁止用 --level L1 把已有 L2 plan 放行）；尚未落盘才认 opts.level。
    if (kind === 'plan' && entry.kind === null) {
      const planAbs = path.join(root, 'workflow', 'plans', `${base}.md`);
      const declared = fs.existsSync(planAbs) ? readFm(planAbs, '级别') : (opts.level || '');
      if (declared === 'L1') {
        return {
          ok: true,
          entry: {
            ok: true, kind: 'plan', rel: `workflow/plans/${base}.md`, level: 'L1',
            status: fs.existsSync(planAbs) ? (readFm(planAbs, '状态') || 'draft') : 'draft',
            selfEntry: true, legacy: false,
          },
          laneBypass: true,
        };
      }
    }
    return {
      ok: false,
      reason: `同主题入口未确认——${entry.reason}`,
      hint: '先走 plan.md 完成入口确认（修复类走 maintain.md，incident 草稿过目后在时间线留「用户确认」条目）',
    };
  }
  // 库存量形态短路（2026-09-30 增量复核 N1）：**只额外豁免「级别前置」与「spec 档」**——
  // 库存量入口（`流程: legacy` / 日期早于确认门生效日）多为门禁前建档、常缺「级别」字段，硬拒会锁死
  // spec 起草与确认。注意：库存量信号**本身即等于入口已确认**（judgeDoc 的 `台账行 || 存量口径`，
  // 与检查 1 / 15 / 配对门同口径）——台账豁免发生在 judgeDoc，不在本处；本处不做二次豁免
  // （第三轮复核 P2-1：原句「台账要求不豁免」把两件事写反，已订正）。
  if (!entry.storageLegacy && !/^L[1-3]$/.test(entry.level)) {
    return {
      ok: false,
      reason: `入口缺合法「级别」字段（现「${entry.level || '缺失'}」，无法判定前置深度）`,
      hint: '先给入口补「级别: L1-L3」字段，再继续',
    };
  }
  if (kind === 'plan' && !entry.storageLegacy && (entry.level === 'L2' || entry.level === 'L3')) {
    const sp = specConfirmed(root, base);
    if (!sp.ok) {
      return { ok: false, reason: `入口级别 ${entry.level}，前置 spec 未确认——${sp.reason}`, hint: '先走 design.md 完成 spec 确认' };
    }
  }
  return { ok: true, entry };
}

// confirmGateFor：确认门总判（confirm-doc 用；docRel = workflow/specs/... 或 workflow/plans/...）
export function confirmGateFor(root, docRel) {
  const base = path.basename(docRel).replace(/\.md$/, '');
  const kind = docRel.startsWith('workflow/specs/') ? 'spec' : 'plan';
  const g = draftGateFor(kind, root, base);
  if (!g.ok) return g;
  // 歧义清单门（clarify-ledger）：只在 spec 的 draft→approved 前置上叠加；plan 与存量（锚前/缺日期）不涉。
  // 放在进入门之后——先证明「这份 spec 有资格被确认」，再判「它想清楚了没有」，两错并存时先修前置。
  if (kind === 'spec') {
    const cg = clarifyGate(root, docRel);
    if (cg.applied && !cg.ok) return { ok: false, reason: `歧义未清——${cg.reason}`, hint: cg.hint };
    const vg = coverageGate(root, docRel);
    if (vg.applied && !vg.ok) return { ok: false, reason: `验收覆盖不足——${vg.reason}`, hint: vg.hint };
  }
  return g;
}

// ---- done 前置门族（confirm-gate-approved-history）----
// 背景：stage-gate-machine 关单后检查 14 报「确认态缺失」×2——approved→done 期间从未提交、首次提交即
// done 态（先 done 后提交），git 历史无 approved 中间态；检查 14 是事后审计（发现即定局），本族把
// 校验收口到 confirm-doc 的「→done」跳转——「approved 态还在工作区」的最后一刻，即唯一可拦截窗口。
import { gitOut as coreGitOut, spawnGit as coreSpawnGit } from './git-core.mjs';

// 命中判据单源：approvedTraceHit（逐文档，本模块 doneGateFor 与 confirm-doc 用）与
// approvedTraceIndex（批量索引，check-loop 检查 14 循环用）共用 APPROVED_TRACE_ARGS 常量
//（2026-09-30 复核 N3 教训：双份字面量靠注释同步必漂移；2026-10-10 批量化起由常量结构性承担）。
// 注（2026-09-30 复核 P2-2 登记）：gitRun 的 GIT 解析 / maxBuffer / 失败语义与 check-loop.mjs 的
// gitOut、gitReady 与检查 14 段级两条 rev-parse 为**同口径的两份实现**（未合并——检查 14 段结构不动
// 属本单非目标）——任一侧调整（如加 --no-pager）须同步另一侧，防段级门与文档级判据分叉。
// gitRun：git-core 单源薄封装（2026-10-10 收敛系列 5——原「同口径两份实现」债偿清；升级点：
// 记忆化 + 瞬时错误重试 + 基础设施异常响亮出账，语义并集见 git-core 头注）
function gitRun(root, args) {
  const r = coreSpawnGit(args, root);
  if (r.error || r.status !== 0) return null;
  return r.stdout || '';
}

// gitReady：git 环境可用（在仓库内且已有 HEAD）——与检查 14 段级两条 rev-parse 同口径
export function gitReady(root) {
  return gitRun(root, ['rev-parse', '--git-dir']) !== null
    && gitRun(root, ['rev-parse', '-q', '--verify', 'HEAD']) !== null;
}

// approvedTraceHit：命中判定单源——git 历史是否出现过行首「状态: approved」（经提交进入历史才算，
// 当前工作区未提交的 approved 不算——这正是「留痕」语义）。rel = 仓库根相对路径。
// 返回：'' = 从未出现；<sha> = 命中；null = git 调用失败（调用方按各自容错口径处理——检查 14 不报、
// done 门跳过，均沿 fail-open 边界；诚实边界声明见 spec）。
// pickaxe 参数常量（perf-pickaxe-batch）：approvedTraceHit（逐文档）与 approvedTraceIndex
//（批量）共用——命令行字面量单源由常量承担，替代「双份字面量靠注释同步」的旧约定。
// 2026-10-11 合并盲视修复（评审 B1 关单实证：2026-09-23-arrival intent 的 approved 痕迹经 evil merge
// 入库，git log -G 默认不生成合并提交 diff → 痕迹不可见 → done 前置门误拦）。加
// --diff-merges=first-parent：合并提交按第一父生成 diff，痕迹在合并面即可见（git ≥2.31；更老 git
// 该旗标报错 → gitRun null → 沿既有 fail-open 边界：检查 14 不报、done 门跳过）。
// 2026-10-12 工作树分支合并盲视修复（pml-three-ui-tweaks 关单实证：2026-10-10 两个 plan 的
// approved 痕在 JihWs6 工作树分支提交 37126b5f/83a4b7d4c，merge-base --is-ancestor 验证非当前
// 分支第一父链可达 → --diff-merges=first-parent 的 diff 不含分支侧痕 → s14 误报"确认态缺失"）。
// 加 --all：让所有分支可达，分支提交（非合并提交）的 approved 痕也能被 -G 命中。性能影响可接受
//（approvedTraceIndex 批量一次扫描，approvedTraceHit 逐文档 -1 取最近命中，均限 workflow 路径）。
const APPROVED_TRACE_ARGS = ['--all', '--diff-merges=first-parent', '-G', '^状态:[[:space:]]*approved'];
export function approvedTraceHit(root, rel) {
  const r = gitRun(root, ['log', '-1', '--format=%H', ...APPROVED_TRACE_ARGS, '--', rel]);
  return r === null ? null : r.trim();
}

// approvedTraceIndex：批量版——一次 pickaxe 扫描构建 rel → 最近命中 sha 索引，供 check-loop
// 检查 14 这类逐文档循环调用方替代逐文档 spawn（2026-10-10 实测：逐文档 61 次 ≈4.3s → 1 次）。
// scope 路径限制默认 'workflow'（命中面实证全在 workflow/{intents,specs,plans,incidents}；不限路径
// 会扫 backend/frontend 全历史——2026-10-10 实测全仓 5.7s vs 限 workflow 1.6s，文件集严格一致）。
// 与逐文档查询语义等价的实证依据（2026-10-10 临时仓实验）：
//   - pickaxe 与 --name-only 组合只列出 diff 命中该正则的文件——同提交混入的未命中文件不列出（不虚报）；
//   - git log 新序输出 + 首见即取 = `log -1 ... -- <rel>` 的最近命中，逐点一致。
// 返回：null = git 调用失败（与 approvedTraceHit 同 fail-open 口径交调用方）；Map = 索引，
// 未命中文件不在 Map 中（调用方映射 '' = 从未出现）。
export function approvedTraceIndex(root, scope = 'workflow') {
  const r = gitRun(root, ['log', '--format=%H', '--name-only', ...APPROVED_TRACE_ARGS, '--', scope]);
  if (r === null) return null;
  const idx = new Map();
  let sha = '';
  for (const line of r.split(/\r?\n/)) {
    if (/^[0-9a-f]{40}$/.test(line)) { sha = line; continue; }
    // 非空非 sha 行 = 该命中提交的文件（pickaxe 限制下仅命中文件）；文件名含 .md 后缀不可能误判为 sha 行
    if (line && sha && !idx.has(line)) idx.set(line, sha);
  }
  return idx;
}

// doneGateFor：confirm-doc「→done」前置门（三件套 intent/spec/plan 均适用；incidents 的 fixed/closed 不在本门）。
// 豁免与顺序：① 行首 `流程: legacy` ② 行含「存量确认态豁免（」声明（与检查 14 同标记，显式逃生口）
// ③ 非 git 环境 ④ git 调用失败 → 均跳过（不误拦）。未豁免且未命中 → 拒绝（调用方负责非零退出 +
// 零落账 + 零写盘 + 回退指引）。
export function doneGateFor(root, abs, rel) {
  const body = readBody(abs);
  if (body.split(/\r?\n/).some((l) => /^流程: legacy/.test(l))) return { ok: true, skipped: 'legacy' };
  if (body.split(/\r?\n/).some((l) => l.includes('存量确认态豁免（'))) return { ok: true, skipped: 'declared' };
  if (!gitReady(root)) return { ok: true, skipped: 'no-git' };
  const hit = approvedTraceHit(root, rel);
  if (hit === null) return { ok: true, skipped: 'git-error' };
  if (hit === '') {
    return {
      ok: false,
      reason: 'git 历史中从未出现行首「状态: approved」——确认态未留痕（先 done 后提交 / 两跳同批提交）',
      hint: '先把该文档的 approved 态提交（git add 该文件并 commit）后再重试关单',
    };
  }
  return { ok: true, hit };
}

// acceptanceEvidenceGate：→done 关单格式门（done-evidence-gate）——关单是最后一次写入，
// 验收面的机器可读格式必须在落账前就位，否则 s08（验收缺证据）/s23（收敛无判据）在关单后 hard，
// 只能走「重确认」返工（wiki-backfill-workflow-slim 关单后补标注实证）。两判据与 check-loop 同源：
//   ① intent / 独立 L1 plan（无同名 intent/incident，s08 口径）：验收节 [x] 项逐条须「证据：」标注
//      （同行或块内续行，evRe=/证据[：:]/ 同 s08）；存在 [ ] 未勾项即拒（s08「验收未对账」同源）。
//      isNew 判据（git 首加 author date ≥ 2026-09-12，s08 accCutoff 同源）才执法；存量与不可判定放行。
//   ② L2/L3 spec：「## 验收判据」节须存在且表有数据行（s23 SEC_RE 同源；无数据行=收敛对账无机器输入）。
//   豁免沿 doneGateFor 同款三逃生口：流程: legacy / 存量确认态豁免（ / 非 git。
export function acceptanceEvidenceGate(root, abs, rel) {
  const body = readBody(abs);
  const bodyLines = body.split(/\r?\n/);
  if (bodyLines.some((l) => /^流程: legacy/.test(l))) return { ok: true, skipped: 'legacy' };
  if (bodyLines.some((l) => l.includes('存量确认态豁免（'))) return { ok: true, skipped: 'declared' };
  if (!gitReady(root)) return { ok: true, skipped: 'no-git' };
  const type = (/(?:^|[\\/])workflow[\\/](intents|specs|plans|incidents)[\\/]/.exec(rel) || [])[1] || '';
  if (!['intents', 'specs', 'plans'].includes(type)) return { ok: true, skipped: 'type' };
  if (type === 'specs') {
    const level = readFm(abs, '级别');
    if (!['L2', 'L3'].includes(level)) return { ok: true };
    const idx = bodyLines.findIndex((l) => /^##\s+.*验收判据/.test(l));
    if (idx === -1) {
      return { ok: false, reason: 'L2/L3 spec 缺「## 验收判据」节（检查 23 收敛对账的机器输入，关单时必须就位）', hint: '补验收判据表（判据 | 证据引用逐行）后重试关单；存量件可正文声明「存量确认态豁免（…）」' };
    }
    const pipeLines = [];
    for (let i = idx + 1; i < bodyLines.length; i++) {
      if (/^##\s/.test(bodyLines[i])) break;
      if (/^\s*\|/.test(bodyLines[i])) pipeLines.push(bodyLines[i]);
    }
    const dataRows = pipeLines.filter((l) => !/^\|[\s:|-]+\|?\s*$/.test(l)).slice(1); // 去分隔行后首行为表头
    if (!dataRows.length) {
      return { ok: false, reason: '「验收判据」表无数据行（空表 = 收敛对账无机器输入，检查 23）', hint: '逐判据登记证据引用（路径 / 全量门命令）后重试关单' };
    }
    return { ok: true };
  }
  // intent / 独立 L1 plan：isNew 执法
  let added = '';
  try {
    added = spawnSync('git', ['log', '--diff-filter=A', '--format=%aI', '-1', '--', rel], { cwd: root, encoding: 'utf8' }).stdout.trim();
  } catch { added = ''; }
  if (!/^\d{4}-/.test(added)) return { ok: true, skipped: 'no-date' };
  if (added < '2026-09-12') return { ok: true, skipped: 'legacy-era' };
  let isTarget = type === 'intents';
  if (type === 'plans') {
    const base = path.basename(rel);
    const hasIntent = fs.existsSync(path.join(root, 'workflow', 'intents', base));
    const hasIncident = fs.existsSync(path.join(root, 'workflow', 'incidents', base));
    isTarget = readFm(abs, '级别') === 'L1' && !hasIntent && !hasIncident;
  }
  if (!isTarget) return { ok: true };
  const secIdx = bodyLines.findIndex((l) => /^##\s*[^#]*验收标准/.test(l));
  if (secIdx === -1) {
    return { ok: false, reason: 'done 前缺「## 验收标准」节（勾验无从核对，s08）', hint: '补验收标准节并逐条勾验补证据后重试关单' };
  }
  let unchecked = 0;
  let missing = 0;
  let firstMissing = '';
  let itemLines = null;
  const flush = () => {
    if (!itemLines) return;
    if (!itemLines.some((l) => /证据[：:]/.test(l))) {
      missing++;
      if (!firstMissing) firstMissing = itemLines[0].trim().replace(/^-\s*\[x\]\s*/i, '').slice(0, 60);
    }
    itemLines = null;
  };
  for (let i = secIdx + 1; i < bodyLines.length; i++) {
    const l = bodyLines[i];
    if (/^##\s/.test(l)) break;
    if (/^\s*-\s\[[ xX]\]/.test(l)) {
      flush();
      if (/^\s*-\s\[\s\]/.test(l)) { unchecked++; continue; }
      itemLines = [l];
      continue;
    }
    if (itemLines && l.trim()) itemLines.push(l);
  }
  flush();
  if (unchecked) {
    return { ok: false, reason: `验收节有 ${unchecked} 个未勾验项——done 须逐条勾验（s08 验收未对账同源）`, hint: '勾验或移除未达成项（未达成工作另立档）后重试关单' };
  }
  if (missing) {
    return { ok: false, reason: `验收节 ${missing} 个勾选项缺「证据：」标注（首例：${firstMissing}…）`, hint: '每条 [x] 附证据（commit / 用例 / 冒烟输出，同行或紧随续行写「证据：…」）后重试关单' };
  }
  return { ok: true };
}

// resolveWorkspace：从输出路径推导工作区根与主题名；output 路径不含 workflow 段 → null（仓外草稿，不校验）
export function resolveWorkspace(outputPath, rootOverride) {
  const abs = path.resolve(outputPath);
  const base = path.basename(abs).replace(/\.md$/, '');
  if (rootOverride) return { root: path.resolve(rootOverride), base };
  const parts = abs.split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i].toLowerCase() === 'workflow') return { root: parts.slice(0, i).join(path.sep) || path.sep, base };
  }
  return null;
}

export default { entryConfirmed, specConfirmed, draftGateFor, confirmGateFor, doneGateFor, acceptanceEvidenceGate, gitReady, approvedTraceHit, resolveWorkspace, readFm, readLedger };
