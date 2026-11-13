#!/usr/bin/env node
// loop-runner.mjs — 无人闭环 runner（设计稿 ai-native-closed-loop-and-memory 步骤 B/D，工单 D，2026-11-13）
// 用法：node <插件根>/scripts/loop-runner.mjs [--root <项目根>] [--runner <cmd>] [--timeout-ms <n>] [--help]
// 定位：check-bands 的**消费方**（只 import 其 runBandCheck/loadBandConfig，不动其判据）——定时面
//       （CI schedule / 本地 cron）跑 check-bands 只出建议指令；本项目在 owner 显式授权后可跑本
//       runner，把「越带 → 只读诊断 → intent 草案」自动走完半程。
// 授权模型（缺省 = 无授权）：bands.json 的 tier 定义增**可选块** autoRunner，如
//       tiers.diagnose.autoRunner = {"enabled": true, "maxPerDay": 3}。种子 bands.json 刻意不含该
//       块——授权属项目自治显式配置；未授权时本脚本行为与 check-bands 完全一致（只出建议指令）。
// 安全模型（不可偏离）：**agent 只读、runner 落笔**——自治环里 agent 只拿 Read/Grep/Glob 白名单
//       做只读诊断并返回 JSON；intent 草案由本 runner（node 进程）自己写，agent 无写工具。
// 红线（设计稿 §3 同源）：**只到 intent 草案，不自动改代码、不自动开 PR / 不自动开分支**——草案
//       frontmatter 状态恒 draft + 来源: loop-runner 自动诊断，正文带「须经人工评审」声明，推进
//       （approved → plan → 实现）恒走有人流程。propose 档 v1 同样只到草案（route 面不自动触达）。
// 流程（对每条越带 band）：①查当日调用台账未超 tiers.<tier>.autoRunner.maxPerDay（超则跳过并在
//       输出注明，不落账不调模型）；②经 model-call 单源拉 agent 诊断（prompt 含 band 名/当前值/
//       带宽/tier/check-bands 建议指令行原文 + 「只读诊断，用 Read/Grep/Glob 收集证据」，要求返回
//       严格 JSON {summary, evidence[], suspectedCause, proposedIntent:{title, problem,
//       proposedOutcome, affected[], openQuestions[]}}，字段对齐插件 intent 文档结构）；③runner 自己
//       写 workflow/intents/<YYYY-MM-DD>-auto-<band>.md（幂等：同名已存在不覆盖，顺延 -2..-9 后缀，
//       命名位满则跳过注明）；④落调用台账 .agents/runs/loop-runner.jsonl（append-only：
//       ts/band/tier/durationMs/agentOk/intentWritten/intent/error；坏行跳过同插件口径）。
// 失败语义：agent 输出坏 JSON / 超时 / spawn 失败 / is_error → 台账记 agentOk:false、**不写 intent、
//       不重试**（每 band 每次运行至多一次调用，防无人值守面自我放大消耗）。
// 退出码：0 = 未配置 / 带内 / 未判带（同 check-bands）或越带且有授权且全部落草案；
//         1 = 存在「越带信号未落草案」（band 无授权——建议指令照出并提示可配置 autoRunner /
//             当日配额耗尽 / agent 失败）；2 = bands.json 配置损坏（check-bands fail-loud 同判透传）。
// maxPerDay 判日口径：UTC 日（ts 前 10 位）——与意图文件名的日期同源，跨时区自洽（fill-intent 先例）。
// 测试：node <插件根>/test/loop-runner.test.mjs（全 mock runner，不真调模型）
// 零依赖，Node ≥ 18 直接运行。模型 spawn 只发生在 model-call.mjs 单源内（本文件不直接 spawn）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBandCheck, loadBandConfig } from './check-bands.mjs';
import { callModel } from './model-call.mjs';
import { projectRoot } from './paths.mjs';

const LEDGER_REL = path.join('.agents', 'runs', 'loop-runner.jsonl');
const ALLOWED_TOOLS = 'Read,Grep,Glob';
const DEFAULT_MAX_TURNS = 8; // 只读取证需多轮 Read/Grep；封顶防跑飞
const NAME_SLOTS = 9;        // 幂等命名位：-auto-<band>.md 起，顺延 -2..-9
const utcDay = () => new Date().toISOString().slice(0, 10);
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));
const oneLine = (s) => String(s || '').replace(/\r?\n/g, ' ');

// ---- 诊断 JSON 解析（坏输出三态的第一态在这里收口；不 throw，调用方落账 failed）----
// 容错仅一种：整体被 markdown 代码栅栏包裹时剥栅栏，内部仍须是严格 JSON——散文包裹/截断一律拒。
export function parseDiagnosis(raw) {
  let t = String(raw || '').trim();
  const fence = t.match(/^```[a-zA-Z0-9]*\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  let obj;
  try { obj = JSON.parse(t); } catch (e) { return { ok: false, error: `诊断输出不是严格 JSON（${String(e && e.message).slice(0, 80)}）` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '诊断输出不是 JSON 对象' };
  const needStr = (o, k) => typeof o[k] === 'string' && o[k].trim() !== '';
  const miss = [];
  if (!needStr(obj, 'summary')) miss.push('summary');
  if (!Array.isArray(obj.evidence)) miss.push('evidence[]');
  if (!needStr(obj, 'suspectedCause')) miss.push('suspectedCause');
  const pi = obj.proposedIntent;
  if (!pi || typeof pi !== 'object' || Array.isArray(pi)) {
    return { ok: false, error: `诊断 JSON 缺 proposedIntent 对象${miss.length ? `；另缺 ${miss.join(' / ')}` : ''}` };
  }
  for (const k of ['title', 'problem', 'proposedOutcome']) if (!needStr(pi, k)) miss.push(`proposedIntent.${k}`);
  if (miss.length) return { ok: false, error: `诊断 JSON 字段不齐：缺 ${miss.join(' / ')}` };
  const arr = (v) => (Array.isArray(v) ? v.map((x) => oneLine(x)).filter(Boolean) : []);
  return {
    ok: true,
    diag: {
      summary: obj.summary.trim(),
      evidence: arr(obj.evidence),
      suspectedCause: obj.suspectedCause.trim(),
      proposedIntent: {
        title: pi.title.trim(),
        problem: pi.problem.trim(),
        proposedOutcome: pi.proposedOutcome.trim(),
        affected: arr(pi.affected),
        openQuestions: arr(pi.openQuestions),
      },
    },
  };
}

// ---- prompt 组装（band 事实 + check-bands 建议指令行原文 + 只读纪律 + 严格 JSON 契约）----
export function buildPrompt(band, detailLines, root) {
  const facts = detailLines.length ? detailLines : [
    `[band] ${band.name} | 源=${band.source}(${band.value}) | 当前=${fmtNum(band.cur[band.cur.length - 1].v)} | 基线 μ=${fmtNum(band.mean)} σ=${fmtNum(band.sigma)} 带宽=[${fmtNum(band.lo)}, ${fmtNum(band.hi)}]（k=${band.k} ${band.side === 'both' ? '双侧' : '上带'}） | tier=${band.tier} | 越带`,
  ];
  return [
    '你是无人闭环（loop-runner）触发的只读诊断员。某交付治理指标 band 越带，请先用只读工具收集证据，再给结构化诊断。',
    '',
    '越带事实（check-bands 输出原文）：',
    ...facts,
    '',
    `项目根：${root}`,
    '纪律：只读诊断——只可使用 Read / Grep / Glob 工具收集证据；禁止写任何文件、禁止修改代码、禁止创建分支或 PR。',
    '输出契约：只回一个严格 JSON 对象（无 markdown 栅栏、无解释文字、无尾随逗号），结构：',
    '{"summary":"一句话诊断摘要","evidence":["证据条目（文件:行 或 数据出处）"],"suspectedCause":"最可能根因","proposedIntent":{"title":"intent 标题","problem":"背景与问题","proposedOutcome":"可验证的预期结果","affected":["影响面"],"openQuestions":["待人工澄清的问题"]}}',
  ].join('\n');
}

// ---- runner 自己落笔：intent 草案（frontmatter draft + 自动生成声明；agent JSON → 正文组织）----
export function buildIntentDraft(diag, ctx) {
  const b = diag.proposedIntent;
  const bullets = (arr, fallback) => (arr.length ? arr.map((x) => `- ${x}`).join('\n') : `- ${fallback}`);
  const li = (s) => oneLine(s);
  return `---
状态: draft
日期: ${ctx.date}
来源: loop-runner 自动诊断
---

# INTENT — ${li(b.title)}（auto: ${ctx.band}）

> ⚠️ 本草案由无人闭环（loop-runner）自动生成，须经人工评审确认后方可推进。红线：loop-runner 只到
> intent 草案——不自动改代码、不自动开 PR / 分支；推进（approved → plan → 实现）走有人流程。

## 背景与问题

- band：\`${ctx.band}\`（tier=${ctx.tier}，指标=${ctx.metric}/${ctx.value}）
- 越带事实：当前 ${fmtNum(ctx.cur)}，基线 μ=${fmtNum(ctx.mean)} σ=${fmtNum(ctx.sigma)}，带宽 [${fmtNum(ctx.lo)}, ${fmtNum(ctx.hi)}]（k=${ctx.k}，${ctx.side === 'both' ? '双侧' : '上带'}）
- 摘要：${li(diag.summary)}
- 疑似根因：${li(diag.suspectedCause)}
- 问题：${b.problem}

## 证据（agent 只读取证，未经验证，评审时逐条核对）

${bullets(diag.evidence, '（agent 未给出可复核证据——评审前须自行取证）')}

## 目标（proposedOutcome）

${b.proposedOutcome}

## 影响面（affected）

${bullets(b.affected, '（agent 未指认影响面）')}

## 待澄清问题（openQuestions，人工评审入口）

${bullets(b.openQuestions, '（agent 未提出）')}

## 建议指令（check-bands 原文照录，本次未自动执行）

${ctx.suggestions.length ? ctx.suggestions.map((s) => `- ${s}`).join('\n') : '- （无）'}
`;
}

// 幂等落笔：同名草案已存在不覆盖，顺延 -2..-9；命名位满 → 不写并如实回报。
function writeIntentDraft(root, bandName, date, content) {
  const dir = path.join(root, 'workflow', 'intents');
  const safe = bandName.replace(/[^A-Za-z0-9._-]+/g, '-');
  const names = [`${date}-auto-${safe}.md`, ...Array.from({ length: NAME_SLOTS - 1 }, (_, i) => `${date}-auto-${safe}-${i + 2}.md`)];
  const free = names.find((n) => !fs.existsSync(path.join(dir, n)));
  if (!free) return { ok: false, error: '草案命名位已满（-2..-9 均存在）——当日该 band 草案已达上限' };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, free), content, 'utf8');
  return { ok: true, file: `workflow/intents/${free}` };
}

// ---- 调用台账（append-only；坏行跳过——崩溃半行/手工残行不致丢计数合法性）----
function appendLedger(root, row) {
  const file = path.join(root, LEDGER_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}
function countTodayForBand(root, band, day) {
  const file = path.join(root, LEDGER_REL);
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && r.band === band && String(r.ts || '').slice(0, 10) === day) n++;
  }
  return n;
}

// 从 check-bands 输出行提取各越带 band 的明细行 + 建议指令行（原文照录进 prompt——纯消费不重构）。
function suggestionGroups(lines) {
  const groups = {};
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\[band\] (\S+) \|/);
    if (m) { cur = m[1]; groups[cur] = [l]; continue; }
    if (cur && /^\s{2}\S/.test(l)) groups[cur].push(l);
    else if (/^\[/.test(l)) cur = null;
  }
  return groups;
}

/**
 * runLoopRunner(root, {runner, timeoutMs, maxTurns})：无人闭环主入口（CLI 与测试共用，无副作用打印）。
 * 消费 runBandCheck 判带输出；只对「越带 && tier 配了 autoRunner.enabled && 当日配额未满」的 band
 * 调 agent 只读诊断并由 runner 落 intent 草案。返回 {...runBandCheck 结果, auto, code}。
 * @returns {{configured:boolean, error:(string|null), breachCount:number, bands:Array, lines:string[],
 *            auto:{done:Array, skipped:Array, failed:Array, unauthorized:Array}, code:number}}
 */
export function runLoopRunner(root, { runner, timeoutMs, maxTurns = DEFAULT_MAX_TURNS } = {}) {
  const res = runBandCheck(root);
  const lines = [...res.lines];
  const auto = { done: [], skipped: [], failed: [], unauthorized: [] };
  const finish = (code) => ({ ...res, lines, auto, code });

  if (!res.configured || res.error) return finish(res.error ? 2 : 0); // 未配置不误报 / 坏配置 fail-loud 透传
  const breaches = res.bands.filter((b) => b.status === 'breach');
  if (!breaches.length) return finish(0);

  const loaded = loadBandConfig(root); // 同一配置已被 runBandCheck 判合法——直接取 tiers 授权面
  const tiers = (loaded.cfg && loaded.cfg.tiers) || {};
  const groups = suggestionGroups(res.lines);
  const day = utcDay();
  let hintShown = false;

  for (const band of breaches) {
    const cfg = tiers[band.tier] || {};
    const a = cfg.autoRunner;
    const authorized = Boolean(a && a.enabled === true && Number.isInteger(a.maxPerDay) && a.maxPerDay >= 1);
    if (!authorized) {
      auto.unauthorized.push(band.name);
      lines.push(`[loop-runner] band ${band.name}（tier=${band.tier}）未启用 autoRunner——本次只出建议指令${a && a.enabled ? '（autoRunner 形态非法：enabled 须 true 且 maxPerDay 须为正整数，按无授权处理）' : ''}`);
      if (!hintShown) {
        lines.push('[loop-runner] 授权面（项目自治显式配置，种子不含）：tiers.<tier>.autoRunner = {"enabled": true, "maxPerDay": N}');
        hintShown = true;
      }
      continue;
    }
    const used = countTodayForBand(root, band.name, day);
    if (used >= a.maxPerDay) {
      auto.skipped.push(band.name);
      lines.push(`[loop-runner] band ${band.name} 当日 runner 调用已达 maxPerDay=${a.maxPerDay}（已用 ${used}）——跳过，不落账不调模型（明日窗口恢复）`);
      continue;
    }
    const startedAt = Date.now();
    const failRow = (label, error) => {
      appendLedger(root, { ts: new Date().toISOString(), band: band.name, tier: band.tier, durationMs: Date.now() - startedAt, agentOk: false, intentWritten: false, intent: null, error: String(error).slice(0, 300) });
      auto.failed.push(band.name);
      lines.push(`[loop-runner] band ${band.name} ${label}失败——台账已记 failed，不写 intent、不重试：${String(error).slice(0, 160)}`);
    };
    const r = callModel({
      prompt: buildPrompt(band, groups[band.name] || [], root),
      allowedTools: ALLOWED_TOOLS,
      maxTurns,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(runner ? { runner } : {}),
      cwd: root,
    });
    if (!r.ok) { failRow('agent 调用', `${r.error.kind}/${r.error.code}: ${r.error.message}`); continue; }
    if (r.json && r.json.is_error) {
      failRow('agent', `runner is_error: ${oneLine(typeof r.json.result === 'string' ? r.json.result : JSON.stringify(r.json.result)).slice(0, 200)}`);
      continue;
    }
    const parsed = parseDiagnosis(r.json && r.json.result);
    if (!parsed.ok) { failRow('诊断输出', parsed.error); continue; }
    const ctx = {
      band: band.name, tier: band.tier, metric: band.metric, value: band.value,
      cur: band.cur[band.cur.length - 1].v, mean: band.mean, sigma: band.sigma,
      lo: band.lo, hi: band.hi, k: band.k, side: band.side,
      date: day, suggestions: (groups[band.name] || []).filter((l) => l.includes('建议指令')).map((l) => l.trim()),
    };
    const draft = writeIntentDraft(root, band.name, day, buildIntentDraft(parsed.diag, ctx));
    if (!draft.ok) { failRow('草案落盘', draft.error); continue; }
    appendLedger(root, { ts: new Date().toISOString(), band: band.name, tier: band.tier, durationMs: r.durationMs, agentOk: true, intentWritten: true, intent: draft.file, error: null });
    auto.done.push(band.name);
    lines.push(`[loop-runner] band ${band.name} → 诊断草案 ${draft.file}（durationMs=${r.durationMs}，状态 draft 待人工评审）`);
  }

  const unhandled = auto.unauthorized.length + auto.skipped.length + auto.failed.length;
  lines.push(`[loop-runner] 结果：越带 ${breaches.length}——落草案 ${auto.done.length} / 跳过 ${auto.skipped.length}（配额） / 未授权 ${auto.unauthorized.length} / 失败 ${auto.failed.length}；台账 ${LEDGER_REL.split(path.sep).join('/')}；红线：只到 intent 草案，不自动改代码、不自动开 PR`);
  return finish(unhandled > 0 ? 1 : 0);
}

// ---- CLI（isMain 门：被测试 import 纯函数时本段不执行，check-bands 同款手法）----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node <插件根>/scripts/loop-runner.mjs [--root <项目根>] [--runner <cmd>] [--timeout-ms <n>]\n'
      + '无人闭环 runner：消费 check-bands 判带，对配置了 autoRunner 的越带 band 拉 agent 只读诊断、\n'
      + '由 runner 落 intent 草案（状态 draft 待人工评审）。安全模型：agent 只读、runner 落笔；\n'
      + '红线：只到 intent 草案，不自动改代码、不自动开 PR。\n'
      + '退出码：0=未配置/带内/全落草案；1=存在未落草案的越带（无授权/配额耗尽/agent 失败）；2=配置损坏。\n'
      + '授权配置（项目自治显式，种子不含）：bands.json 的 tiers.<tier>.autoRunner = {"enabled": true, "maxPerDay": N}。详见脚本头注。');
    process.exit(0);
  }
  let root = null;
  let runnerArg = null;
  let timeoutMs = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { root = argv[++i] ?? ''; if (!root) { console.error('[loop-runner] --root 需要一个路径'); process.exit(2); } continue; }
    if (a === '--runner') { runnerArg = argv[++i] ?? ''; if (!runnerArg) { console.error('[loop-runner] --runner 需要可执行名或路径'); process.exit(2); } continue; }
    if (a === '--timeout-ms') { timeoutMs = Number(argv[++i]); if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { console.error('[loop-runner] --timeout-ms 需要正数（毫秒）'); process.exit(2); } continue; }
    console.error(`[loop-runner] 未知参数 ${a}——用法：node scripts/loop-runner.mjs [--root <项目根>] [--runner <cmd>] [--timeout-ms <n>]`);
    process.exit(2);
  }
  const res = runLoopRunner(root ? path.resolve(root) : projectRoot(), {
    ...(runnerArg ? { runner: runnerArg } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  for (const l of res.lines) console.log(l);
  if (res.error) { console.error(`[loop-runner] ❌ ${res.error}`); process.exit(2); }
  process.exit(res.code);
}
