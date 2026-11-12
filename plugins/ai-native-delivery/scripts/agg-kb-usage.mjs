#!/usr/bin/env node
// agg-kb-usage — 知识层置信度衰减聚合（2026-11-11，对照 Anthropic《The components of agent memory》Dreaming「记忆负债」）
// 定位：把 kb-search 的命中遥测（<项目>/.agents/cache/kb-usage.jsonl，gitignore 运行态）聚合成「冷数据候选」——
//   对 workflow/wiki 文档做「访问/命中 + 内容更新」双维度置信度衰减筛查。只做机械筛查与候选输出
//   （advisory，纯只读），裁决由主智能体/用户执行：归档走 archive-sweep --execute / 更新走知识维护 /
//   删除须用户单独指令。本脚本不移动、不改写、不删除任何文档。
// 用法：
//   node <插件根>/scripts/agg-kb-usage.mjs                      # 默认：3 个数据月起步、90 天未命中且未更新
//   node <插件根>/scripts/agg-kb-usage.mjs --months 6           # 数据月下限（有遥测行的自然月数）
//   node <插件根>/scripts/agg-kb-usage.mjs --stale-days 180     # 冷数据阈值（天）
// 口径：
//   - 「有数据月」= 遥测文件出现过的自然月；有数据月 < --months → 数据不充分，不产候选
//     （年轻遥测不得制造假候选，与 agg-judgments --retire-candidates 同口径）
//   - 候选 = lastHitDays > stale-days 且 lastTouchDays > stale-days（阈值天数内既未被 kb-search 命中、内容也未更新）
//   - lastTouch 用 git log -1 --format=%cI（cwd=仓库根），无提交记录回退文件 mtime
//   - 扫描范围：workflow 四目录活跃态文档（排除 _TEMPLATE.md，状态单源 workflow-enums.mjs）+ wiki 递归
//     （排除 drafts-archive/、INDEX.md、知识沉淀总览.html、*.visual-check.*、>180KB bulk 文件——
//     与 kb-search 的 wiki 降噪口径一致）
//   - 遥测文件在 .agents/cache/（安装时进 gitignore 标记块），本脚本只读不写；退出码 0 正常（含数据不充分）
// 结构：纯函数（collectColdCandidates / renderCold）导出供 dream-run 与测试进程内复用，CLI 段 isMain
//   前置（对齐 doctor.mjs 先例）——本模块被 import 时绝不读父进程 argv、绝不退出父进程。
// 测试：node <插件根>/test/agg-kb-usage.test.mjs（命中/未命中夹具回归，须全绿）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ENUMS } from './workflow-enums.mjs';
import { findProjectRoot, projectRoot } from './paths.mjs';

// ROOT 解析（agg-judgments 同口径，2026-10-28 收口）：CHECK_LOOP_ROOT 夹具注入 > 项目 git 根 > cwd。
// 遥测与语料都是项目侧数据——解析不出 git 根时回退 cwd（就地审计），绝不落/读插件安装目录。
const ROOT = process.env.CHECK_LOOP_ROOT || findProjectRoot() || projectRoot();
const TELEMETRY_FILE = path.join(ROOT, '.agents', 'cache', 'kb-usage.jsonl');

const ACTIVE_STATUS = new Set([...ENUMS['doc.status.active'], ...ENUMS['incident.status.active']]);
const DAY_MS = 86400000;
const WORKFLOW_TYPES = ['plans', 'specs', 'intents', 'incidents'];
const WIKI_EXTS = /\.(md|sql|html|txt)$/i;
const WIKI_MAX_KB = 180;

// ---------- 读遥测（坏行跳过；文件缺席 = 零行） ----------
export function readTelemetry(file = TELEMETRY_FILE) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.ts === 'string' && Array.isArray(r.docs)) rows.push(r);
    } catch { /* 坏行跳过 */ }
  }
  return rows;
}

// ---------- 每文档命中聚合：doc -> { lastHit: ms, months: Set<YYYY-MM> } ----------
export function hitsByDoc(rows) {
  const byDoc = new Map();
  for (const r of rows) {
    const ym = String(r.ts).slice(0, 7);
    const hitMs = new Date(r.ts).getTime();
    if (Number.isNaN(hitMs)) continue;
    for (const d of r.docs) {
      if (typeof d !== 'string' || !d) continue;
      const norm = d.replace(/\\/g, '/');
      if (!byDoc.has(norm)) byDoc.set(norm, { lastHit: hitMs, months: new Set() });
      const cell = byDoc.get(norm);
      if (hitMs > cell.lastHit) cell.lastHit = hitMs;
      cell.months.add(ym);
    }
  }
  return byDoc;
}

// ---------- 工具 ----------
function lastTouch(root, relPath) {
  const r = spawnSync('git', ['log', '-1', '--format=%cI', '--', relPath], { encoding: 'utf8', cwd: root, windowsHide: true });
  const iso = r.status === 0 ? (r.stdout || '').trim() : '';
  if (iso) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  // 回退：文件 mtime（未提交文件 git log 无输出）
  try {
    return fs.statSync(path.join(root, relPath)).mtimeMs;
  } catch {
    return null;
  }
}

// frontmatter 状态（受限子集：闭合 --- 内 `状态: 值`）。插件语料键名为中文「状态」——与 kb-search
//（parseDoc 的 meta['状态']）和 archive-sweep（parseStatus）同键口径；无 frontmatter 返回 ''。
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

// ---------- 扫描候选（纯函数核心：root/遥测行/阈值均可注入，dream-run 与测试复用） ----------
export function collectColdCandidates({ root = ROOT, rows = readTelemetry(), minMonths = 3, staleDays: stale = 90, now = Date.now() } = {}) {
  const dataMonths = new Set(rows.map((r) => String(r.ts).slice(0, 7)));
  if (dataMonths.size < minMonths) {
    return { sufficient: false, dataMonths: dataMonths.size, minMonths, scanned: 0, candidates: [] };
  }
  const byDoc = hitsByDoc(rows);
  const candidates = [];
  let scanned = 0;

  const consider = (relPath) => {
    scanned += 1;
    const hit = byDoc.get(relPath);
    const lastHitMs = hit ? hit.lastHit : null;
    const lastHitDays = lastHitMs == null ? Infinity : (now - lastHitMs) / DAY_MS;
    const touchMs = lastTouch(root, relPath);
    const lastTouchDays = touchMs == null ? Infinity : (now - touchMs) / DAY_MS;
    if (lastHitDays > stale && lastTouchDays > stale) {
      candidates.push({
        doc: relPath,
        lastHit: lastHitMs == null ? '—' : new Date(lastHitMs).toISOString().slice(0, 10),
        lastTouch: touchMs == null ? '—' : new Date(touchMs).toISOString().slice(0, 10),
        hitMonths: hit ? hit.months.size : 0,
      });
    }
  };

  // workflow 四目录：直下 .md，排除 _TEMPLATE.md，frontmatter 状态须在活跃枚举内（终态件归档走
  // archive-sweep 的家族口径，不在此混筛）
  for (const type of WORKFLOW_TYPES) {
    const dir = path.join(root, 'workflow', type);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch { continue; }
    for (const f of entries.sort()) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const rel = `workflow/${type}/${f}`;
      if (!ACTIVE_STATUS.has(parseStatus(root, rel))) continue;
      consider(rel);
    }
  }

  // wiki 递归：排除 drafts-archive/、INDEX.md、知识沉淀总览.html、*.visual-check.*、>180KB（kb-search 同口径）
  const walkWiki = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'drafts-archive') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (e.isDirectory()) { walkWiki(abs); continue; }
      if (!WIKI_EXTS.test(e.name)) continue;
      if (e.name === 'INDEX.md' || e.name === '知识沉淀总览.html') continue;
      if (/\.visual-check\./.test(e.name)) continue;
      try {
        if (fs.statSync(abs).size / 1024 > WIKI_MAX_KB) continue;
      } catch { continue; }
      consider(rel);
    }
  };
  walkWiki(path.join(root, 'wiki'));

  candidates.sort((a, b) => a.doc.localeCompare(b.doc));
  return { sufficient: true, dataMonths: dataMonths.size, minMonths, scanned, candidates };
}

// ---------- 渲染（CLI 与 dream-run 单源：候选行格式即记忆负债的燃料口径，与 agg-judgments
// --retire-candidates 的候选清单同款「逐行 候选 <名> + 事实列」形态，供月度对账并排阅读） ----------
export function renderCold(cold, stale = 90) {
  const lines = [];
  if (!cold.sufficient) {
    lines.push(`agg-kb-usage: 遥测数据月仅 ${cold.dataMonths} 个（下限 ${cold.minMonths}）——数据不充分，不产冷数据候选。继续积累运行记录。`);
    return lines.join('\n');
  }
  lines.push(`冷数据候选（${stale} 天未命中且未更新，遥测数据月 ${cold.dataMonths} 个）——仅机械筛查，裁决走主智能体/用户（归档走 archive-sweep --execute / 更新走知识维护 / 删除须用户单独指令）：`);
  if (cold.candidates.length === 0) {
    lines.push('  无');
  } else {
    for (const c of cold.candidates) {
      lines.push(`  候选  ${c.doc}  末次命中 ${c.lastHit}  末次更新 ${c.lastTouch}  命中月数 ${c.hitMonths}`);
    }
  }
  lines.push(`（扫描 ${cold.scanned} 份 workflow/wiki 文档，候选 ${cold.candidates.length} 份）`);
  return lines.join('\n');
}

// ---------- CLI（isMain 前置：被 dream-run/测试 import 纯函数时本段不执行，对齐 doctor.mjs 先例） ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  let minMonths = 3;
  let staleDays = 90;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--months') minMonths = Number.parseInt(args[++i] ?? '', 10);
    else if (a === '--stale-days') staleDays = Number.parseInt(args[++i] ?? '', 10);
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node <插件根>/scripts/agg-kb-usage.mjs [--months N] [--stale-days N]
  --months N        有数据月下限（默认 3）——遥测月数不足不产候选
  --stale-days N    冷数据阈值（默认 90）：最近 N 天既未被命中、内容也未更新 → 候选`);
      process.exit(0);
    } else {
      console.error(`未知选项: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(minMonths) || minMonths < 1) {
    console.error('--months 须为正整数');
    process.exit(2);
  }
  if (!Number.isInteger(staleDays) || staleDays < 1) {
    console.error('--stale-days 须为正整数');
    process.exit(2);
  }
  console.log(renderCold(collectColdCandidates({ minMonths, staleDays }), staleDays));
}
