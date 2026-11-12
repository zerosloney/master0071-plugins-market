#!/usr/bin/env node
// check-bands.mjs — 确定性带监测（设计稿 ai-native-closed-loop-and-memory 步骤 A，2026-11-12）
// 用法：node <插件根>/scripts/check-bands.mjs [--root <项目根>] [--help]
// 职责：读项目侧 .agents/config/bands.json（metric/baseline/rules/tiers 四段，种子见插件
//       config-templates/bands.json），从内置指标源取数，按类 Western Electric 简化判据
//       （μ±kσ 带宽，σ=0 时偏离均值即越带）判带，越带按 tier 输出**建议指令行**。
// 红线（设计稿 §3「明确不做」）：纯确定性（零模型、零网络）、建议指令**只打印绝不自动执行**——
//       自治执行属 owner 另行授权的 runner 面。退出码三态：
//   0 = 未配置（明确提示，不误报）/ 带内 / 未判带（样本或源数据不足）
//   1 = 有 band 越带（信号；是否阻断由接线方决定——观测面不自带执法）
//   2 = 配置损坏（JSON 不可解析 / 结构非法）或 CLI 参数错（fail-loud，不带着坏配置装绿）
// 内置指标源（首版两源，外部源留 --metric-source 扩展位——设计稿步骤 A 风险条目，本版不实现）：
//   verify-green    .agents/verifications.jsonl 验证行（all-gates 绿行 ∪ exitCode≠0 失败行），
//                   按滚动窗口派生 recent-fail-rate（红行占比）/ green-count（窗口内绿行数）
//   workflow-metrics workflow/metrics.md「闭环漏斗」表「返工件」列（gen-workflow-metrics.mjs
//                   月度快照；列序 = 该生成器 FUNNEL_HEAD：月份|收口|完整链|协议前|一次通过|返工件|中位|台账行数）
// 判带口径：判点 = 序列末 streak 个点；基线 = 判点之前的 window 个历史点（μ 与总体 σ）。
//   基线取「判点之前」是有意的：当前点参与基线会把信号摊薄进中心线（WE 控制图惯例同此）。
// 测试：node <插件根>/test/check-bands.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot, scriptPath } from './paths.mjs';

const CONFIG_REL = path.join('.agents', 'config', 'bands.json');
const TIER_ENUM = ['log', 'diagnose', 'propose'];

// ---- 内置指标源取数（只读；源缺 = 合法形态，返回 null + 原因，不判带不报错） ----
// verify-green：验证行序列（时序 = 文件追加序）。绿行 = all-gates 且 exit 0；失败行 = exitCode≠0
// （suite 为门 id）。两者之外（防御：exit 0 的非 all-gates 形态）跳过。坏 JSON 行跳过（同
// gen-workflow-metrics.scanGateCosts「坏行跳过」口径）。滚动窗口 W 内派生序列逐点值。
function verifyGreenSeries(root, metricCfg) {
  const file = path.join(root, '.agents', 'verifications.jsonl');
  if (!fs.existsSync(file)) return { data: null, why: '源数据缺失（.agents/verifications.jsonl 不存在）' };
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.exitCode !== 'number') continue;
    const isGreen = r.exitCode === 0 && r.suite === 'all-gates';
    const isFail = r.exitCode !== 0;
    if (isGreen || isFail) rows.push({ isGreen, isFail, ts: String(r.ts || '') });
  }
  if (!rows.length) return { data: null, why: '源数据缺失（verifications.jsonl 无验证行）' };
  const W = Number(metricCfg.window) || 20;
  const data = rows.map((_, i) => {
    const seg = rows.slice(Math.max(0, i - W + 1), i + 1);
    const greens = seg.filter((r) => r.isGreen).length;
    const fails = seg.length - greens;
    const v = metricCfg.value === 'green-count' ? greens : fails / seg.length;
    return { v, label: rows[i].ts || `#${i + 1}`, greens, fails, n: seg.length };
  });
  return { data, windowNote: `近 ${W} 行验证：绿 ${data[data.length - 1].greens} / 红 ${data[data.length - 1].fails}` };
}

// workflow-metrics：「闭环漏斗」表数据行 → 按月份升序的返工件序列。列序单源 =
// gen-workflow-metrics.mjs FUNNEL_HEAD（返工件 = cells[5]）；列序漂移时非数字行跳过（不误判）。
function funnelSeries(root) {
  const file = path.join(root, 'workflow', 'metrics.md');
  if (!fs.existsSync(file)) return { data: null, why: '源数据缺失（workflow/metrics.md 不存在）' };
  const text = fs.readFileSync(file, 'utf8');
  const head = text.indexOf('## 闭环漏斗');
  if (head < 0) return { data: null, why: '源数据缺失（workflow/metrics.md 无「闭环漏斗」表）' };
  const seg = text.slice(head);
  const next = seg.indexOf('\n## ', 1);
  const rows = [];
  for (const l of (next >= 0 ? seg.slice(0, next) : seg).split(/\r?\n/)) {
    if (!/^\s*\|\s*\d{4}-\d{2}\s*\|/.test(l)) continue;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    const rework = Number(cells[5]);
    if (!Number.isFinite(rework)) continue;
    rows.push({ v: rework, label: cells[0] });
  }
  if (!rows.length) return { data: null, why: '源数据缺失（闭环漏斗表无数据行）' };
  rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { data: rows, windowNote: `最近月份 ${rows[rows.length - 1].label}` };
}

const SOURCES = {
  'verify-green': { collect: verifyGreenSeries, values: ['recent-fail-rate', 'green-count'], file: '.agents/verifications.jsonl' },
  'workflow-metrics': { collect: funnelSeries, values: ['funnel-rework'], file: 'workflow/metrics.md' },
};

// ---- 配置装载与结构校验（损坏 = fail-loud exit 2；未配置 = exit 0 不误报）----
// 刻意只读**项目侧** bands.json、不走 configDir 种子回退链：带监测是项目自调口径（示范种子
// 落地后由项目改写），且插件回退会让未初始化的项目也被示范带扫——「缺文件不误报」契约优先。
export function loadBandConfig(root) {
  const file = path.join(root, CONFIG_REL);
  if (!fs.existsSync(file)) return { configured: false, file };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { configured: true, error: `${CONFIG_REL} 不可解析（${e.message}）`, file };
  }
  const err = validate(cfg);
  if (err) return { configured: true, error: `${CONFIG_REL} 结构非法：${err}`, file };
  return { configured: true, cfg, file };
}

function validate(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return '须为 JSON 对象';
  if (!cfg.metric || typeof cfg.metric !== 'object' || Array.isArray(cfg.metric)) return '缺 metric 段（指标源定义）';
  for (const [id, m] of Object.entries(cfg.metric)) {
    const src = SOURCES[m && m.source];
    if (!src) return `metric.${id}.source "${m && m.source}" 不在内置源（${Object.keys(SOURCES).join(' / ')}）`;
    if (!m.value || !src.values.includes(m.value)) return `metric.${id}.value "${m && m.value}" 不被源 ${m.source} 支持（${src.values.join(' / ')}）`;
    if (m.window !== undefined && (!Number.isInteger(m.window) || m.window < 1)) return `metric.${id}.window 须为正整数`;
  }
  if (cfg.baseline !== undefined && (typeof cfg.baseline !== 'object' || Array.isArray(cfg.baseline))) return 'baseline 段须为对象';
  for (const [id, b] of Object.entries(cfg.baseline || {})) {
    if (!cfg.metric[id]) return `baseline.${id} 未在 metric 段定义`;
    for (const key of ['window', 'minPoints']) {
      if (b[key] !== undefined && (!Number.isInteger(b[key]) || b[key] < 1)) return `baseline.${id}.${key} 须为正整数`;
    }
  }
  if (!cfg.rules || typeof cfg.rules !== 'object' || Array.isArray(cfg.rules) || !Object.keys(cfg.rules).length) return '缺 rules 段（至少一条判带规则）';
  if (!cfg.tiers || typeof cfg.tiers !== 'object' || Array.isArray(cfg.tiers)) return '缺 tiers 段（响应档定义）';
  for (const t of Object.keys(cfg.tiers)) {
    if (!TIER_ENUM.includes(t)) return `tiers.${t} 不在动作枚举（${TIER_ENUM.join(' / ')}）`;
    if (t === 'diagnose' && !(Array.isArray(cfg.tiers[t].readonlyTools) && cfg.tiers[t].readonlyTools.length)) return 'tiers.diagnose 须带非空 readonlyTools（只读工具白名单）';
    if (t === 'propose' && !(Array.isArray(cfg.tiers[t].route) && cfg.tiers[t].route.length)) return 'tiers.propose 须带非空 route（路由面，如 ["pull_request"]）';
  }
  for (const [name, r] of Object.entries(cfg.rules)) {
    if (!r || typeof r !== 'object') return `rules.${name} 须为对象`;
    if (!cfg.metric[r.metric]) return `rules.${name}.metric "${r.metric}" 未在 metric 段定义`;
    if (r.k !== undefined && (!Number.isFinite(r.k) || r.k <= 0)) return `rules.${name}.k 须为正数（σ 倍数）`;
    if (r.side !== undefined && r.side !== 'upper' && r.side !== 'both') return `rules.${name}.side 须为 upper 或 both`;
    if (r.streak !== undefined && (!Number.isInteger(r.streak) || r.streak < 1)) return `rules.${name}.streak 须为正整数（连续越带点数）`;
    if (!cfg.tiers[r.tier]) return `rules.${name}.tier "${r.tier}" 未在 tiers 段定义`;
  }
  return null;
}

// ---- 判带（纯函数）：判点 = 末 streak 个点；基线 = 判点前 window 个点（μ + 总体 σ）----
// σ=0（历史全平）的越带语义：upper → 判点 > μ；both → 判点 ≠ μ。全平历史带宽塌缩到中心线，
// 任何偏离都是信号（「全绿史后出现一次失败」正是要抓的形态）；判点等于均值则恒带内（健康仓零误报）。
function judgeBand(data, rule, baseline) {
  const k = Number.isFinite(rule.k) && rule.k > 0 ? rule.k : 2;
  const side = rule.side === 'both' ? 'both' : 'upper';
  const streak = Number.isInteger(rule.streak) && rule.streak >= 1 ? rule.streak : 1;
  if (!data) return { status: 'no-data', k, side, streak };
  if (data.length <= streak) {
    return { status: 'insufficient', why: `样本不足（判点 ${streak} + 基线 0 < minPoints ${baseline.minPoints}）`, k, side, streak };
  }
  const cur = data.slice(-streak);
  const hist = data.slice(0, -streak).slice(-baseline.window);
  if (hist.length < baseline.minPoints) {
    return { status: 'insufficient', why: `基线样本不足（${hist.length} < minPoints ${baseline.minPoints}）`, k, side, streak };
  }
  const mean = hist.reduce((a, p) => a + p.v, 0) / hist.length;
  const sigma = Math.sqrt(hist.reduce((a, p) => a + (p.v - mean) ** 2, 0) / hist.length);
  const beyond = (v) => (sigma === 0
    ? (side === 'both' ? v !== mean : v > mean)
    : (side === 'both' ? Math.abs(v - mean) > k * sigma : v - mean > k * sigma));
  const breached = cur.every((p) => beyond(p.v));
  return {
    status: breached ? 'breach' : 'in',
    mean, sigma, k, side, streak,
    lo: mean - k * sigma,
    hi: mean + k * sigma,
    cur,
    baselineN: hist.length,
  };
}

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));

// ---- 建议指令（只打印不执行——设计稿 §3 红线）：按 tier 组装 ----
function suggestionLines(rule, metricCfg, tiers, root) {
  const tierCfg = tiers[rule.tier] || {};
  if (rule.tier === 'diagnose') {
    const tools = (tierCfg.readonlyTools || []).join(' / ');
    const cmd = String(metricCfg.diagnoseCmd || '')
      // 分隔符归一为 / ：建议指令是打印面（跨 shell 可读），Windows 反斜杠不进输出
      .replace('{scriptDir}', path.dirname(scriptPath(root, 'gen-workflow-metrics.mjs')).split(path.sep).join('/'))
      .replace('{root}', String(root).split(path.sep).join('/'));
    return [`建议指令（diagnose，只读工具白名单：${tools || '（未配置）'}；本检查只打印不执行）：${cmd || `按白名单只读复核源数据 ${SOURCES[metricCfg.source].file}`}`];
  }
  if (rule.tier === 'propose') {
    const route = (tierCfg.route || []).join('、');
    return [`建议指令（propose，路由：${route || '（未配置）'}；本检查只打印不执行）：将本 band 越带的处置（带宽校准 / 指标口径调整 / 执法面增补）经 ${route} 提交评审后再落地`];
  }
  return [`建议指令（log；本检查只打印不执行）：记录本次越带（workflow/papercuts.md 或机制台账月度对账登记）`];
}

/**
 * runBandCheck(root)：判定全部 band，返回结构化结果与可打印行（CLI 与测试共用，无副作用打印）。
 * @returns {{configured:boolean, error:(string|null), file:string, breachCount:number,
 *            counts:{breach:number,in:number,unjudged:number}, bands:Array, lines:string[]}}
 */
export function runBandCheck(root) {
  const loaded = loadBandConfig(root);
  const lines = [];
  if (!loaded.configured) {
    lines.push(`[check-bands] 未配置带监测（${path.join(root, CONFIG_REL)} 不存在）——本检查按「未配置不误报」退出 0`);
    return { configured: false, error: null, file: loaded.file, breachCount: 0, counts: { breach: 0, in: 0, unjudged: 0 }, bands: [], lines };
  }
  if (loaded.error) {
    return { configured: true, error: loaded.error, file: loaded.file, breachCount: 0, counts: { breach: 0, in: 0, unjudged: 0 }, bands: [], lines: [`[check-bands] ❌ ${loaded.error}`] };
  }
  const { cfg, file } = loaded;
  lines.push(`[check-bands] 配置 ${file}（band ${Object.keys(cfg.rules).length} 条）`);
  const bands = [];
  for (const [name, rule] of Object.entries(cfg.rules)) {
    const metricCfg = cfg.metric[rule.metric];
    const baseline = { window: 10, minPoints: 5, ...(cfg.baseline && cfg.baseline[rule.metric]) };
    const { data, why, windowNote } = SOURCES[metricCfg.source].collect(root, metricCfg);
    const j = judgeBand(data, rule, baseline);
    const band = { name, metric: rule.metric, source: metricCfg.source, value: metricCfg.value, tier: rule.tier, ...j };
    bands.push(band);
    if (j.status === 'no-data' || j.status === 'insufficient') {
      const whyText = j.status === 'no-data' ? why : j.why;
      lines.push(`[band] ${name} | 源=${metricCfg.source}(${metricCfg.value}) | 未判带：${whyText} | tier=${rule.tier}`);
      continue;
    }
    lines.push(`[band] ${name} | 源=${metricCfg.source}(${metricCfg.value}) | 当前=${fmtNum(j.cur[j.cur.length - 1].v)}（${windowNote}） | 基线 μ=${fmtNum(j.mean)} σ=${fmtNum(j.sigma)} 带宽=[${fmtNum(j.lo)}, ${fmtNum(j.hi)}]（k=${j.k} ${j.side === 'both' ? '双侧' : '上带'}，基线 n=${j.baselineN}） | tier=${rule.tier} | ${j.status === 'breach' ? '越带' : '带内'}`);
    if (j.status === 'breach') lines.push(...suggestionLines(rule, metricCfg, cfg.tiers, root).map((s) => `  ${s}`));
  }
  const counts = {
    breach: bands.filter((b) => b.status === 'breach').length,
    in: bands.filter((b) => b.status === 'in').length,
    unjudged: bands.filter((b) => b.status === 'no-data' || b.status === 'insufficient').length,
  };
  lines.push(`[check-bands] 结果：越带 ${counts.breach} / 带内 ${counts.in} / 未判带 ${counts.unjudged}——建议指令仅供人/agent 判读，本检查不执行任何命令（设计稿 §3「明确不做」红线）`);
  return { configured: true, error: null, file, breachCount: counts.breach, counts, bands, lines };
}

// ---- CLI（isMain 门：被测试 import 纯函数时本段不执行，gen-host-manifests 同款手法）----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node <插件根>/scripts/check-bands.mjs [--root <项目根>]\n'
      + '确定性带监测：读 .agents/config/bands.json 判带，越带输出 tier 与建议指令（只打印不执行）。\n'
      + '退出码：0=未配置/带内/未判带；1=越带；2=配置损坏或参数错。详见脚本头注。');
    process.exit(0);
  }
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') { root = argv[++i] ?? ''; if (!root) { console.error('[check-bands] --root 需要一个路径'); process.exit(2); } continue; }
    console.error(`[check-bands] 未知参数 ${argv[i]}——用法：node scripts/check-bands.mjs [--root <项目根>]`);
    process.exit(2);
  }
  const res = runBandCheck(root ? path.resolve(root) : projectRoot());
  for (const l of res.lines) console.log(l);
  if (res.error) { console.error(`[check-bands] ❌ ${res.error}`); process.exit(2); }
  process.exit(res.breachCount > 0 ? 1 : 0);
}
