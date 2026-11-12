#!/usr/bin/env node
// dream-run — 离线梦境审计（2026-11-11，对照 Anthropic《The components of agent memory》Dreaming）
// 定位：可手动 / post-commit advisory / 技能触发的**只读**审计编排器。读 kb-search 命中遥测的聚合结果
//   （agg-kb-usage 记忆负债）+ workflow 文档终态与引用情况，产出归档建议报告——纯 advisory：
//   不自动移动、不改写、不删除任何文件，也不自动 commit / push；一切裁决由主智能体/用户执行。
// 用法：
//   node <插件根>/scripts/dream-run.mjs                      # 报告落 <root>/.agents/tmp/dream-report-<date>.md
//   node <插件根>/scripts/dream-run.mjs --report <path>      # 自定义报告路径
//   node <插件根>/scripts/dream-run.mjs --stale-days 180     # 冷数据阈值（透传 agg-kb-usage 口径）
//   node <插件根>/scripts/dream-run.mjs --months 6           # 遥测数据月下限（透传）
// 安全边界：
//   - 唯一写盘动作 = 报告本身，落项目侧 .agents/tmp/（安装时进 gitignore 标记块的运行时目录），
//     绝不落插件目录；聚合与建议是机械筛查，裁决走主智能体/用户。
//   - 退出码恒 0（advisory 面不拦任何流程；参数错误除外 exit 2）。
// 结构：analyzeDream / renderReport 纯函数导出（测试进程内断言），CLI 段 isMain 前置（doctor.mjs 先例）。
// 测试：node <插件根>/test/dream-run.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collectColdCandidates, renderCold, readTelemetry } from './agg-kb-usage.mjs';
import { findProjectRoot, projectRoot } from './paths.mjs';

// ROOT 解析：CHECK_LOOP_ROOT 夹具注入 > 项目 git 根 > cwd（agg-kb-usage 同口径，注释互指）。
const ROOT = process.env.CHECK_LOOP_ROOT || findProjectRoot() || projectRoot();

const DAY_MS = 86400000;
const WORKFLOW_TYPES = ['plans', 'specs', 'intents', 'incidents'];
// 非终态即活跃（archive-sweep 同口径）：终态 = done/superseded/cancelled/closed
const TERMINAL = new Set(['done', 'superseded', 'cancelled', 'closed']);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function lastTouch(root, relPath) {
  const r = spawnSync('git', ['log', '-1', '--format=%cI', '--', relPath], { encoding: 'utf8', cwd: root, windowsHide: true });
  const iso = r.status === 0 ? (r.stdout || '').trim() : '';
  if (iso) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  try {
    return fs.statSync(path.join(root, relPath)).mtimeMs;
  } catch {
    return null;
  }
}

function parseStatus(root, relPath) {
  try {
    const head = fs.readFileSync(path.join(root, relPath), 'utf8').slice(0, 2000);
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return '';
    const sm = m[1].match(/^状态:\s*(.+)$/m);
    return sm ? sm[1].trim() : '';
  } catch {
    return '';
  }
}

// 引用情况：候选文档基名在其他 workflow 文档（四目录直下）与 wiki（agg-kb-usage 同降噪口径）正文中的
// 出现文件数（不含自身）。机械计数，供「归档会不会断引用」的人工裁决参考。
function collectTexts(root) {
  const texts = [];
  for (const type of WORKFLOW_TYPES) {
    const dir = path.join(root, 'workflow', type);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      try {
        texts.push({ rel: `workflow/${type}/${f}`, body: fs.readFileSync(path.join(dir, f), 'utf8') });
      } catch { /* 竞态删除：按无引用跳过 */ }
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, 'wiki'), { withFileTypes: true }); } catch { return texts; }
  const walk = (dir, rel) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name === 'drafts-archive') continue;
      const abs = path.join(dir, e.name);
      const rel2 = `${rel}/${e.name}`;
      if (e.isDirectory()) { walk(abs, rel2); continue; }
      if (!/\.(md|sql|html|txt)$/i.test(e.name) || e.name === 'INDEX.md' || e.name === '知识沉淀总览.html') continue;
      if (/\.visual-check\./.test(e.name)) continue;
      try {
        if (fs.statSync(abs).size / 1024 > 180) continue;
        texts.push({ rel: rel2, body: fs.readFileSync(abs, 'utf8') });
      } catch { /* 竞态删除 / 超限竞态：跳过 */ }
    }
  };
  for (const e of entries) {
    if (e.isDirectory()) walk(path.join(root, 'wiki', e.name), e.name);
  }
  return texts;
}

// ---------- 分析（纯函数核心：root/阈值/now 可注入，测试复用） ----------
// 返回 { cold, terminalDocs:[{doc,status,lastTouch}], suggestions:[{doc,status,hitMonths,refs,advice}] }
export function analyzeDream({ root = ROOT, rows = readTelemetry(), minMonths = 3, staleDays: stale = 90, now = Date.now() } = {}) {
  const cold = collectColdCandidates({ root, rows, minMonths, staleDays: stale, now });
  const texts = collectTexts(root);
  const refsOf = (rel) => {
    const base = path.basename(rel);
    return texts.filter((t) => t.rel !== rel && t.body.includes(base)).length;
  };
  // B. 终态件归档建议：活跃目录里的终态件（archive-sweep 家族准入前的机械粗筛——家族/窗口/引用
  // 终判归 archive-sweep，这里点名事实 + 按引用情况给只读路由提示）
  const terminalDocs = [];
  for (const type of WORKFLOW_TYPES) {
    const dir = path.join(root, 'workflow', type);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries.sort()) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const rel = `workflow/${type}/${f}`;
      const st = parseStatus(root, rel);
      if (!TERMINAL.has(st)) continue;
      const touchMs = lastTouch(root, rel);
      const refs = refsOf(rel);
      terminalDocs.push({
        doc: rel, status: st,
        lastTouch: touchMs == null ? '—' : new Date(touchMs).toISOString().slice(0, 10),
        refs,
        advice: refs > 0
          ? '终态件但仍被引用——先核对引用方再定归档（archive-sweep 会按家族与引用终判）'
          : '终态件归档候选——可跑 archive-sweep.mjs --execute（本审计不移动任何文件）',
      });
    }
  }
  // C. 冷数据候选处置建议：逐候选补 状态 + 引用数，机械分级（advice 只是路由提示，不是裁决）。
  // 冷数据候选按 agg-kb-usage 口径只含活跃态文档——终态件的处置在 B 段，两段正交不重叠。
  const suggestions = cold.candidates.map((c) => {
    const refs = refsOf(c.doc);
    const st = parseStatus(root, c.doc);
    const refNote = refs > 0 ? `（仍被 ${refs} 处引用——处置前先核对引用方）` : '';
    const advice = c.hitMonths === 0
      ? `记忆负债——立档后从未被 kb-search 命中：复评内容，更新或提名退役（删除须用户单独指令）${refNote}`
      : `曾被命中但已转冷——复评时效性：更新知识或降级归档${refNote}`;
    return { doc: c.doc, status: st || '—', hitMonths: c.hitMonths, lastHit: c.lastHit, lastTouch: c.lastTouch, refs, advice };
  });
  return { cold, terminalDocs, suggestions };
}

// ---------- 报告渲染（CLI 与测试单源） ----------
export function renderReport(analysis, { staleDays: stale = 90, date = today(), generatedBy = 'dream-run.mjs' } = {}) {
  const lines = [];
  lines.push(`# 离线梦境审计报告 ${date}`);
  lines.push(`> 生成: node <插件根>/scripts/${generatedBy}（advisory 只读审计——不移动、不改写、不删除任何文档，不自动 commit / push）`);
  lines.push('');
  lines.push(`## A. 记忆负债聚合（agg-kb-usage，${stale} 天阈值）`);
  lines.push('');
  lines.push(renderCold(analysis.cold, stale));
  lines.push('');
  lines.push('## B. 终态件归档建议（活跃目录里的终态件机械粗筛；执行走 archive-sweep --execute，本审计不移动任何文件）');
  lines.push('');
  if (analysis.terminalDocs.length === 0) lines.push('  无');
  else for (const t of analysis.terminalDocs) {
    lines.push(`  候选  ${t.doc}  状态 ${t.status}  末次更新 ${t.lastTouch}  引用 ${t.refs}`);
    lines.push(`    → ${t.advice}`);
  }
  lines.push('');
  lines.push('## C. 冷数据候选处置建议（裁决走主智能体/用户；删除须用户单独指令）');
  lines.push('');
  if (analysis.suggestions.length === 0) lines.push('  无');
  else for (const s of analysis.suggestions) {
    lines.push(`  ${s.doc}  状态 ${s.status}  末次命中 ${s.lastHit}  命中月数 ${s.hitMonths}  引用 ${s.refs}`);
    lines.push(`    → ${s.advice}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------- CLI（isMain 前置：被测试 import 纯函数时本段不执行） ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  let reportPath = '';
  let minMonths = 3;
  let staleDays = 90;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--report') reportPath = args[++i] ?? '';
    else if (a === '--months') minMonths = Number.parseInt(args[++i] ?? '', 10);
    else if (a === '--stale-days') staleDays = Number.parseInt(args[++i] ?? '', 10);
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node <插件根>/scripts/dream-run.mjs [--report <path>] [--months N] [--stale-days N]
  --report <path>   报告路径（默认 <root>/.agents/tmp/dream-report-<date>.md，gitignore 运行态）
  --months N        遥测数据月下限（默认 3，透传 agg-kb-usage）
  --stale-days N    冷数据阈值（默认 90，透传 agg-kb-usage）`);
      process.exit(0);
    } else {
      console.error(`未知选项: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(minMonths) || minMonths < 1) { console.error('--months 须为正整数'); process.exit(2); }
  if (!Number.isInteger(staleDays) || staleDays < 1) { console.error('--stale-days 须为正整数'); process.exit(2); }

  const analysis = analyzeDream({ minMonths, staleDays });
  const target = reportPath ? path.resolve(ROOT, reportPath) : path.join(ROOT, '.agents', 'tmp', `dream-report-${today()}.md`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderReport(analysis, { staleDays }), 'utf8');
  console.log(`报告已写入 ${path.relative(ROOT, target) || target}`);
  console.log(`（advisory 只读审计：冷数据候选 ${analysis.cold.sufficient ? analysis.cold.candidates.length : '数据不足'}、终态件候选 ${analysis.terminalDocs.length}、处置建议 ${analysis.suggestions.length}——裁决走主智能体/用户）`);
}
