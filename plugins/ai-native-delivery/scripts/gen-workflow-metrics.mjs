#!/usr/bin/env node
// workflow 规模与规则面月度快照（2026-09-21，intent 2026-09-21-workflow-metrics-snapshot）
// 用法：node <插件根>/scripts/gen-workflow-metrics.mjs [--month YYYY-MM] [--dry-run] [--help]
// 目的：把「语料膨胀 + 常驻面体积」变成可观测趋势——每月（或按需）跑一次，往 workflow/metrics.md 追加/更新一行。
// 口径：文档 = 磁盘（对照 gen-workflow-index / 看板，排除 _TEMPLATE.md）；常驻面 = `.agents/config/rule-budgets.txt`
//   各条实测（单源，含预算上限），括号内给「预算占用峰值项」。
//   字节口径声明（p2-batch2）：本脚本用工作区 statSync 字节（CRLF 检出态会偏高），rule-budget.mjs 用
//   索引 LF 归一字节——趋势观测可对比，但与门禁判定数值存在系统性差异，勿互相替用。
// 快照是历史记录——任何文档改动都会让「当前值」漂移，逐字比对会常红；故 **不做逐字漂移校验**。
//   改做**时效校验**（--check，2026-10-27 修）：GENERATED 区写入「快照生成时刻」，本门判「自述有多旧」，
//   上限 31 天（METRICS_MAX_AGE_DAYS 可调）——治「引擎量化自述停在某个时刻而无人发现」（实测 2026-10
//   的成本画像头名已换人而 published 表未更新）。规则面的机器约束由 pre-commit 的 rule-budget.mjs 负责，
//   本脚本只负责「看见趋势」+「不许长期不更新」。
// 测试：node <插件根>/test/gen-workflow-metrics.test.mjs（fixture 回归，须全绿）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnums } from './workflow-enums.mjs';
import { loadAllConfirmations } from './ledger-loader.mjs';
import { readLedger } from './ledger-shards.mjs';
import { loadFirstAdded, funnelFromLedger, fmtMedianDays, scanReviews, FUNNEL_LEGACY_RATIO_LIMIT } from './metrics-core.mjs';
import { analyze, buildDocList, loadLastTouch, loadLedgerTs, parseStatus, ACTIVE } from './archive-sweep.mjs';
// 路径收口（2026-10-27 插件化迁移改道 paths.mjs）：枚举种子回退位经插件 config-templates 定位。
import { PLUGIN_CONFIG_TEMPLATES_DIR, projectRoot } from './paths.mjs';

const USAGE = `用法：node <插件根>/scripts/gen-workflow-metrics.mjs [--month YYYY-MM] [--dry-run] [--check] [--restamp] [--help]

事实源：workflow/{intents,specs,plans,incidents}/*.md（排除 _TEMPLATE.md）+ workflow/INDEX.md + .agents/config/rule-budgets.txt + workflow/reviews.d/*.md（独立复核效果台账，2026-10-16 建账）+ workflow/specs/*.md 与 workflow/archive/*/specs/*.md（spec 体积观察，2026-10-16 起采集）+ workflow/deploy-observations.d/（发布观察台账，2026-10-25 建账）
产物：workflow/metrics.md —— 每月一行（同月重跑即更新该行，不重复追加）；明细打印在 stdout，不落表。
选项：
  --month YYYY-MM   指定月份键（默认取当前月 UTC；用于补记历史）
  --dry-run         只打印将写入的行与明细，不写盘
  --check           时效校验：判 workflow/metrics.md 的「快照生成时刻」是否在上限内（默认 31 天，
                   METRICS_MAX_AGE_DAYS 可调）——不自比逐字值（快照是历史记录，逐字比会常红）
  --restamp         允许用今天的磁盘覆盖非当月已有的体量行（默认冻结该行，只更新漏斗与归因）
  --help            打印本说明`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const RESTAMP = args.includes('--restamp');
let month = '';
for (let i = 0; i < args.length; i++) if (args[i] === '--month') month = args[++i] ?? '';
const unknown = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run' || a === '--restamp' || a === '--check' || a === '--help' || a === '-h') continue;
  if (a === '--month') { i++; continue; }
  unknown.push(a);
}
if (unknown.length) { console.error(`❌ 未知参数：${unknown.join(' ')}\n\n${USAGE}`); process.exit(1); }
const CURRENT_MONTH = new Date().toISOString().slice(0, 7);
if (!month) month = CURRENT_MONTH;
if (!/^\d{4}-\d{2}$/.test(month)) { console.error(`--month 须为 YYYY-MM（现 ${month || '空'}）\n\n${USAGE}`); process.exit(1); }

// 根锚定（2026-10-29 修复）：下面三项旧实现都是 **CWD 相对**（`'workflow'`、`'.agents/config'`
// 与 `process.cwd()`），从 `<repo>/sub` 调用会读子目录、写 `sub/workflow/metrics.md`——仓库根
// 那份一动不动，而输出只说「已更新 workflow/metrics.md」。与 gen-workflow-index.mjs 及其余所有
// 写者统一走 paths.mjs 的 projectRoot()（git 根优先，非 git 目录回退 startDir）。
const ROOT = projectRoot();
const WORKFLOW = path.join(ROOT, 'workflow');
const METRICS_P = path.join(WORKFLOW, 'metrics.md');
const BUDGETS = path.join(ROOT, '.agents', 'config', 'rule-budgets.txt');
const DOC_TYPES = ['intents', 'specs', 'plans', 'incidents'];
// 活跃口径单源（board-kb-p1：枚举字面量硬编码退役——workflow-enums.txt 是唯一源）；
// 枚举路径锚定脚本位置（fixture 测试 cwd 在临时目录，按 cwd 解析会 ENOENT）。
// **不能用固定上溯级数**（2026-09-28 修正）：本脚本在两处运行、深度不同——
//   包源 `templates/_agents/scripts/` → 上溯 3 级到仓库根
//   装户 `.agents/scripts/`          → 上溯 2 级到安装根
// 首版硬编码 3 级，故**在每个装户安装里都解析不到枚举文件**（报错路径 `<install>/..​/.agents/…`）。
// 实测暴露路径：CI 新增「shipped 套件」步骤后，`.agents/scripts/gen-workflow-metrics.test.mjs`
// 场景 1 即 exit 1（workflow-enums 单源文件不可读），而包源侧同字节跑出全绿。
// 改为**逐级上溯探测**：找到含 `.agents/config/workflow-enums.txt` 的那一级即用（源仓形态/项目侧副本），
// 找不到回退**插件内 config-templates 种子**（2026-10-27 插件化迁移改道 paths.mjs configDir 回退链）——
// 仍缺才让 loadEnums fail-loud（保持「缺失即响亮」的既有纪律，不静默吞掉）。
const resolveEnumsPath = () => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, '.agents', 'config', 'workflow-enums.txt');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到根
    dir = parent;
  }
  return path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'workflow-enums.txt');
};
const ENUMS = loadEnums(resolveEnumsPath());
const ACTIVE_STATUS = [...ENUMS['doc.status.active'], ...ENUMS['incident.status.active']];
const BEGIN = '<!-- GENERATED:BEGIN — gen-workflow-metrics.mjs 整段重写，手工说明写在本行之前 -->';
const END = '<!-- GENERATED:END -->';

const kb = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

// ---- 语料统计：按类型聚合文件数/字节 + 活跃终态 + 模块已填 ----
function scanDocs() {
  const perType = {};
  let files = 0;
  let bytes = 0;
  let active = 0;
  let invalid = 0;
  let withModule = 0;
  for (const type of DOC_TYPES) {
    let n = 0;
    let b = 0;
    const dir = path.join(WORKFLOW, type);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const p = path.join(dir, f);
      const text = fs.readFileSync(p, 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let status = '';
      let mod = '';
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const kv = line.match(/^(\S+):\s*(.*)$/);
          if (!kv) continue;
          if (kv[1] === '状态') status = kv[2].trim();
          if (kv[1] === '模块') mod = kv[2].trim();
        }
      }
      if (ACTIVE_STATUS.includes(status)) active++;
      else if (!status || ![...ENUMS['doc.status.all'], ...ENUMS['incident.status.all']].includes(status)) invalid++; // 状态缺失/非法单列（board-kb-p1：不再吞进终态桶）
      if (mod) withModule++;
      n++;
      b += fs.statSync(p).size;
    }
    perType[type] = { n, b };
    files += n;
    bytes += b;
  }
  return { perType, files, bytes, active, terminal: files - active - invalid, invalid, withModule };
}

// ---- 归因维度：incident「来源」/「影响环境」枚举计数（incident-attribution）----
// 口径：先读 frontmatter 两个枚举键，按「发现」月（缺则文件名前缀）归桶。
// 某一键为空时，用 workflow/archive/attribution-legacy.md 对质表里同一文件名的已判读格子补上
// （2026-10-12：该表从此是生成器的只读输入）。不回写 incident 文件（回写会打断检查 15 指纹）。
// 生成器不重新判读正文。legacy 的「不明」不在来源枚举内，来源仍算未判读，环境格子照计。
// frontmatter 已有非空值时不让 legacy 覆盖（写错的枚举保持可见，不拿快照涂掉）。
// 值最终不在枚举内 / 仍缺失：来源计入「未判读」。
function loadLegacyAttribution() {
  const file = path.join(WORKFLOW, 'archive', 'attribution-legacy.md');
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const id = cells[0];
    if (!/^\d{4}-\d{2}-\d{2}-/.test(id)) continue;
    if (map.has(id)) {
      console.error(`⚠️ attribution-legacy 重复行，保留首行：${id}`);
      continue;
    }
    map.set(id, { src: cells[1], env: cells[2] });
  }
  return map;
}

function scanAttribution() {
  const SOURCE = new Set(ENUMS['incident.source.all'] || []);
  const ENV = new Set(ENUMS['incident.env.all'] || []);
  const legacy = loadLegacyAttribution();
  const byMonth = {};
  const incDir = path.join(WORKFLOW, 'incidents');
  if (!fs.existsSync(incDir)) return byMonth;
  for (const f of fs.readdirSync(incDir)) {
    if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
    const text = fs.readFileSync(path.join(incDir, f), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let src = '';
    let env = '';
    let found = '';
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const kv = line.match(/^(\S+):\s*(.*)$/);
        if (!kv) continue;
        if (kv[1] === '来源') src = kv[2].trim();
        if (kv[1] === '影响环境') env = kv[2].trim();
        if (kv[1] === '发现') found = kv[2].trim();
      }
    }
    const leg = legacy.get(f.replace(/\.md$/, ''));
    if (!src && leg && SOURCE.has(leg.src)) src = leg.src;
    if (!env && leg && ENV.has(leg.env)) env = leg.env;
    const ym = /^\d{4}-\d{2}/.test(found) ? found.slice(0, 7) : (/^\d{4}-\d{2}/.test(f) ? f.slice(0, 7) : '?');
    const b = (byMonth[ym] ||= { total: 0, source: {}, env: {}, unjudged: 0, escaped: 0 });
    b.total++;
    const srcOk = SOURCE.has(src);
    if (srcOk) b.source[src] = (b.source[src] || 0) + 1; else b.unjudged++;
    const envOk = ENV.has(env);
    if (envOk) b.env[env] = (b.env[env] || 0) + 1;
    // 逃逸率分子（2026-10-14 决定 3）：user/test/monitor（= 来源枚举非 self）发现且触达 prod 的 incident。
    // 逐件配对计数——来源/环境两个边缘计数推不出交叉格子。
    if (srcOk && src !== 'self' && envOk && env === 'prod') b.escaped += 1;
  }
  return byMonth;
}

// ---- 引擎面提交占比：git 单行命令（口径 = AGENTS.md §4 引擎面路径集 ∩ .agents/ .githooks/ CI）----
// 只读、失败退化 null（非 git/命令失败 → 该列写 —，不 fail-loud；本表是观测不挂门禁）。
function engineCommitRatio() {
  const enginePaths = ['.agents/', '.githooks/', 'azure-pipelines.yml'];
  const run1 = (args) => {
    try {
      return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const total = run1(['log', '--no-merges', '--format=%H']);
  if (!total || total.status !== 0) return null;
  const totalN = String(total.stdout).split('\n').filter(Boolean).length;
  if (!totalN) return null;
  const eng = run1(['log', '--no-merges', '--format=%H', '--', ...enginePaths]);
  if (!eng || eng.status !== 0) return null;
  const engN = String(eng.stdout).split('\n').filter(Boolean).length;
  return { engN, totalN, pct: (engN / totalN) * 100 };
}

// ---- 常驻面：按预算表逐条实测（<glob|dir/> <上限>）----
// 峰值口径：逐文件条取「该文件」，glob 条取「单篇最大」，目录条取「合计」——三者不混（曾把目录合计除以单篇上限得出 548%）
function scanSurface() {
  if (!fs.existsSync(BUDGETS)) return { entries: [], total: 0, peak: null };
  const entries = [];
  for (const raw of fs.readFileSync(BUDGETS, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pat, limRaw] = line.split(/\s+/);
    const lim = Number(limRaw);
    if (!pat || !Number.isFinite(lim)) continue;
    let sum = 0;
    let max = 0;
    let label = pat;
    if (pat.endsWith('/')) {
      const dir = pat.slice(0, -1);
      if (!fs.existsSync(dir)) { console.error(`⚠️ 预算目录不存在，跳过该条：${pat}`); continue; }
      for (const f of fs.readdirSync(dir)) sum += fs.statSync(path.join(dir, f)).size;
      max = sum;
      label = `${pat}（合计）`;
    } else if (pat.includes('*')) {
      // 词表约定 glob = 基名内单个 `*`（<前缀>*<后缀>），目录段不支持通配——与 rule-budget.mjs 的 shell glob 同口径。
      // 多 `*` / 目录段含 `*` 出词表：警告跳过，不做「只按后缀 endsWith」的放宽式匹配（2026-09-24 收口：
      // 曾按首个 * 取后缀，`pl*.md` 会误吃目录内全部 .md、`a*b` 会误吃一切 b 结尾文件）
      const stars = pat.split('*').length - 1;
      const starIdx = pat.indexOf('*');
      const lastSlash = pat.lastIndexOf('/');
      if (stars !== 1 || starIdx < lastSlash) {
        console.error(`⚠️ 预算表 glob 仅支持基名内单个 *（<前缀>*<后缀>），跳过该条：${pat}`);
        continue;
      }
      const dir = lastSlash >= 0 ? pat.slice(0, lastSlash + 1) : '.';
      const basePrefix = pat.slice(lastSlash + 1, starIdx);
      const baseSuffix = pat.slice(starIdx + 1);
      if (!fs.existsSync(dir)) { console.error(`⚠️ 预算目录不存在，跳过该条：${pat}`); continue; }
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(basePrefix) || !f.endsWith(baseSuffix)) continue;
        const s = fs.statSync(path.join(dir, f)).size;
        sum += s;
        if (s > max) max = s;
      }
      label = `${pat}（单篇最大）`;
    } else {
      if (!fs.existsSync(pat)) { console.error(`⚠️ 预算文件不存在，跳过该条：${pat}`); continue; }
      sum = max = fs.statSync(pat).size;
    }
    entries.push({ pat, label, sum, max, lim, pct: (max / lim) * 100, isDir: pat.endsWith('/') });
  }
  const total = entries.filter((e) => !e.isDir).reduce((n, e) => n + e.sum, 0);
  const peak = entries.slice().sort((a, b) => b.pct - a.pct)[0] || null;
  return { entries, total, peak };
}

const idxText = fs.existsSync(path.join(WORKFLOW, 'INDEX.md')) ? fs.readFileSync(path.join(WORKFLOW, 'INDEX.md'), 'utf8') : '';
const idxBytes = Buffer.byteLength(idxText, 'utf8');
const idxActive = Number((idxText.match(/^## 活跃（(\d+)）/m) || [])[1] ?? NaN);

// ---- 闭环漏斗（确认链。中位周期 = 该文件首次 git add 到终态确认，2026-10-12）----
// 只读台账一手字段（doc/stage/ts）；经 ledger-loader 统一台账视图（主台账+分片透明合并，坏行跳过、
// 同 doc|stage|fingerprint 键去重取末次——与检查 15/19 同口径）；观测面不挂门禁、不新增文档断言（检查 16 零接触）。
// 「确认链一次通过」不是委派台账的「静态门一次通过」。无 git 首次加入时间、或终态早于加入时间：该件不进中位，写 —，不写 0.0。
function readLedgerRows() {
  return loadAllConfirmations();
}

// cycleDays / loadFirstAdded / funnelFromLedger / fmtMedianDays / scanReviews 已抽至 metrics-core.mjs
// （2026-10-23 board-engine-views A2：看板引擎视图同口径复用，单源纪律——本文件不再留本地副本）。

const ledgerRows = readLedgerRows();
const firstAdded = loadFirstAdded();
const funnel = funnelFromLedger(ledgerRows, month, firstAdded);
const sortedDays = [...funnel.days].sort((a, b) => a - b);
const medianDays = sortedDays.length
  ? (sortedDays.length % 2 ? sortedDays[(sortedDays.length - 1) / 2] : (sortedDays[sortedDays.length / 2 - 1] + sortedDays[sortedDays.length / 2]) / 2)
  : null;
// 协议前占比（legacy/closed）——动作阈值面（funnel-action-threshold）：占比 >30% 在单元格标 ⚠️，
// 连续两月超标由 check-loop §26 出 WARN 并强制一轮归因。阈值单源 = metrics-core.FUNNEL_LEGACY_RATIO_LIMIT
// （§26 与本生成器共用，2026-10-23 P2）。closed=0 时无占比（避免 0/0），只写件数。
const LEGACY_RATIO_LIMIT = FUNNEL_LEGACY_RATIO_LIMIT;
const legacyRatio = funnel.closed > 0 ? funnel.legacy / funnel.closed : null;
const legacyCell = legacyRatio === null
  ? String(funnel.legacy)
  : `${funnel.legacy}（${(legacyRatio * 100).toFixed(0)}%）${legacyRatio > LEGACY_RATIO_LIMIT ? ' ⚠️' : ''}`;
const funnelRow = `| ${month} | ${funnel.closed} | ${funnel.full} | ${legacyCell} | ${funnel.once} | ${funnel.rework} | ${fmtMedianDays(medianDays)} | ${funnel.ledgerRows} |`;

const docs = scanDocs();
const surf = scanSurface();
const attr = scanAttribution();
const engRatio = engineCommitRatio();
const row = `| ${month} | ${docs.files}（活跃 ${docs.active} / 终态 ${docs.terminal}） | ${kb(docs.bytes)} | ${docs.withModule}/${docs.files} | ${kb(surf.total)}（峰值 ${surf.peak ? `${surf.peak.pct.toFixed(1)}% ${surf.peak.label}` : '—'}） | ${kb(idxBytes)}（${Number.isNaN(idxActive) ? '—' : idxActive} 行） |`;

// ---- 归因行：来源枚举计数（self/user/test/monitor）+ 环境（dev/staging/prod/none）+ 未判读 ----
const attrCell = (b, keys) => keys.map((k) => `${k} ${(b.source && b.source[k]) || 0}`).join(' / ');
const envCell = (b, keys) => keys.map((k) => `${k} ${(b.env && b.env[k]) || 0}`).join(' / ');
const SRC_KEYS = ENUMS['incident.source.all'] || [];
const ENV_KEYS = ENUMS['incident.env.all'] || [];
const a = attr[month] || { total: 0, source: {}, env: {}, unjudged: 0, escaped: 0 };
const engCell = engRatio ? `${engRatio.pct.toFixed(1)}%（${engRatio.engN}/${engRatio.totalN}）` : '—';
// 逃逸率格（2026-10-14 决定 3）：分子 = scanAttribution 的逐件交叉计数（非 self 来源 ∩ prod），分母 = 当月 incident 总数
const escapeCell = a.total ? `${(((a.escaped || 0) / a.total) * 100).toFixed(0)}%（${a.escaped || 0}/${a.total}）` : '—';
const attrRow = `| ${month} | ${a.total} | ${attrCell(a, SRC_KEYS) || '—'} | ${envCell(a, ENV_KEYS) || '—'} | ${escapeCell} | ${a.unjudged} | ${engCell} |`;

// ---- 门禁成本/迭代（G8）：all-gates 绿行逐门耗时按月聚合 ----
function scanGateCosts() {
  const file = path.join('.agents', 'verifications.jsonl');
  const byMonth = {};
  if (!fs.existsSync(file)) return byMonth;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.suite !== 'all-gates' || !row.durations || typeof row.totalMs !== 'number') continue;
    const ym = String(row.ts || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    (byMonth[ym] ||= []).push(row);
  }
  return byMonth;
}
const cost = scanGateCosts();
const costList = cost[month] || [];
let costRow;
if (!costList.length) {
  costRow = `| ${month} | 0 | — | — |`;
} else {
  // 墙钟优先（verify-parallel）：并行编排后 totalMs（各门之和）不再等于一次迭代的等待成本，
  // 故绿行新增 wallMs；旧行无该键则回退 totalMs（历史口径续接，不伪造）。
  const costOf = (r) => (typeof r.wallMs === 'number' ? r.wallMs : r.totalMs);
  const avgTotal = costList.reduce((acc, r) => acc + costOf(r), 0) / costList.length / 1000;
  const perGate = {};
  for (const r of costList) for (const [id, ms] of Object.entries(r.durations)) (perGate[id] ||= []).push(ms);
  const top3 = Object.entries(perGate)
    .map(([id, arr]) => [id, arr.reduce((x, y) => x + y, 0) / arr.length / 1000])
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([id, s]) => `${id} ${s.toFixed(1)}s`).join(' · ');
  costRow = `| ${month} | ${costList.length} | ${avgTotal.toFixed(1)} | ${top3} |`;
}

// ---- 复核效果（2026-10-16 复核效果台账）：workflow/reviews.d/ 意见级处置分片按月聚合 ----
// 口径：一行 = 一次独立复核事件；自洽不变式 = 采纳+拒绝+误报 = 意见数。台账是「门禁制造返工 vs 拦下问题」
//   的意见级信号源，脏行比缺行更有害——字段非法 / 自洽破坏一律 throw（文案点名分片与行），不做静默跳过
//   （同本脚本 fail-loud 纪律）。目录不存在 = 合法零数据（机制先于数据建账，出占位行）。
// （scanReviews 本体已抽至 metrics-core.mjs，2026-10-23 board-engine-views A2 单源抽取）
const reviews = scanReviews(WORKFLOW);
// 复核效果表头（第五表；2026-10-16 复核效果台账）。源 = workflow/reviews.d/ 意见级处置分片（一行 = 一次
// 独立复核事件，采纳+拒绝+误报 = 意见数），整表确定性再生、历史行不落盘保留；区分「门禁制造返工 vs 拦下问题」。
// 声明须在 DRY 出口之前（--dry-run 也打印该表）。
const REVIEW_HEAD = [
  '## 复核效果（源：workflow/reviews.d/ 意见级处置台账，2026-10-16 建账；存量未建账期无数据）',
  '',
  '| 月份 | 复核事件 | 意见数 | 采纳 | 拒绝 | 误报 | 采纳率 | 误报率 |',
  '|---|---|---|---|---|---|---|---|',
];
// 整表由分片确定性再生（历史行不落盘保留，分片即真源）；率列 = 采纳（误报）÷ 意见数，意见数为 0 写 —。
const reviewRows = Object.keys(reviews).sort().map((ym) => {
  const b = reviews[ym];
  const rate = (n) => (b.total ? `${((n / b.total) * 100).toFixed(0)}%` : '—');
  return `| ${ym} | ${b.events} | ${b.total} | ${b.adopted} | ${b.rejected} | ${b.misreport} | ${rate(b.adopted)} | ${rate(b.misreport)} |`;
});
if (!reviewRows.length) reviewRows.push('| （无记录） | 0 | 0 | 0 | 0 | — | — |'); // 零数据占位——表始终输出，机制可见

// ---- spec 体积观察（2026-10-16 spec 生命周期）：活跃 specs + 归档 specs 分开统计，先观察后设限 ----
// advisory 上限显式延后（「暂缓加门」的对冲面 = 先让体积可见）：本表只出数、不判限。
// 口径：份数 = .md 数（排除 _TEMPLATE.md，与 scanDocs 一致）；行数 = 换行数（尾换行不生幻影行，对齐 wc -l）；
//   验收条数 = `- [ ]`/`- [x]` checkbox 行总数（不区分勾选）；中位 = 升序取中，偶数取中间两数均值（可为 x.5）；
//   归档 = workflow/archive/<月>/specs/ 各月合并。目录不存在 = 合法（该行出全 0，不报错）。
const medianOf = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function collectSpecMetrics(dir) {
  if (!fs.existsSync(dir)) return null;
  const lines = [];
  const checks = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const ls = text.split(/\r?\n/);
    if (ls[ls.length - 1] === '') ls.pop();
    lines.push(ls.length);
    checks.push((text.match(/^\s*- \[( |x)\]/gm) || []).length);
  }
  return { lines, checks };
}
const specStats = (m) => (m ? {
  n: m.lines.length,
  medLines: medianOf(m.lines),
  maxLines: m.lines.length ? Math.max(...m.lines) : 0,
  medChecks: medianOf(m.checks),
  maxChecks: m.checks.length ? Math.max(...m.checks) : 0,
} : null);
const specActiveStats = specStats(collectSpecMetrics(path.join(WORKFLOW, 'specs')));
const specArchiveMetrics = { lines: [], checks: [] };
const archiveRoot = path.join(WORKFLOW, 'archive');
if (fs.existsSync(archiveRoot)) {
  for (const ent of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const sub = collectSpecMetrics(path.join(archiveRoot, ent.name, 'specs'));
    if (sub) {
      specArchiveMetrics.lines.push(...sub.lines);
      specArchiveMetrics.checks.push(...sub.checks);
    }
  }
}
const specArchiveStats = specStats(specArchiveMetrics);
const fmtSpecNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const specRow = (label, st) => st
  ? `| ${label} | ${st.n} | ${fmtSpecNum(st.medLines)} | ${st.maxLines} | ${fmtSpecNum(st.medChecks)} | ${st.maxChecks} |`
  : `| ${label} | 0 | 0 | 0 | 0 | 0 |`;
// spec 体积表头（第六表；2026-10-16 spec 生命周期。先观察后设限：advisory 上限延后、不设门——口径单源 =
// workflow/README.md「spec 生命周期」小节）。整表每次确定性再生。
const SPEC_HEAD = [
  '## spec 体积观察（源：specs 活跃+归档全量扫描；2026-10-16 起采集。advisory 上限延后——口径见 workflow/README.md「spec 生命周期」）',
  '',
  '| 范围 | 份数 | 行数中位 | 行数最大 | 验收条数中位 | 验收条数最大 |',
  '|---|---|---|---|---|---|',
];
const specRows = [specRow('活跃', specActiveStats), specRow('归档', specArchiveStats)];

// ---- 发布观察（2026-10-25 优化5，第七表）：deploy-observations 台账（主表 ∪ .d/ 分片）按月聚合 ----
// 口径：一行 = 一次 release 的 24h 观察结论（deploy.md §5 落账）；结果枚举 通过|异常，枚举外脏行
// throw（同复核效果表 fail-loud 纪律：脏行比缺行更有害）。台账全缺 = 合法零数据（机制先于数据
// 建账，出占位行）。读侧分片合并单源 = ledger-shards.readLedger。
const scanDeploys = () => {
  const { all } = readLedger(ROOT, 'deploy-observations');
  const byMonth = {};
  for (const line of all.split(/\r?\n/)) {
    if (!/^\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const result = cells[2] ?? '';
    if (result !== '通过' && result !== '异常') {
      throw new Error(`发布观察台账脏行（结果列须为 通过|异常）：${line.slice(0, 120)}`);
    }
    const b = (byMonth[cells[0].slice(0, 7)] ||= { releases: 0, passed: 0, abnormal: 0 });
    b.releases++;
    if (result === '通过') b.passed++; else b.abnormal++;
  }
  return byMonth;
};
const deploys = scanDeploys();
// 发布观察表头（第七表；2026-10-25 优化5）。闭环漏斗延伸到部署后：上线 → 24h 观察 → 结论落账
// （deploy.md §5）；「上线了却长期无行」即观察结论未落账的挂债形态，表恒输出机制可见。
const DEPLOY_HEAD = [
  '## 发布观察（源：workflow/deploy-observations.d/ 24h 观察结论台账，2026-10-25 建账；deploy.md §5 落账，一行 = 一次 release 结论）',
  '',
  '| 月份 | release 数 | 通过 | 异常 |',
  '|---|---|---|---|',
];
const deployRows = Object.keys(deploys).sort().map((ym) => `| ${ym} | ${deploys[ym].releases} | ${deploys[ym].passed} | ${deploys[ym].abnormal} |`);
if (!deployRows.length) deployRows.push('| （无记录） | 0 | 0 | 0 |'); // 零数据占位——表始终输出，机制可见


// ---- 明细（stdout，不落表）：类型分布 + 逐条预算占用 ----
console.log(`📅 ${month} 快照`);
console.log(`  文档：${docs.files} 篇 / ${kb(docs.bytes)}（活跃 ${docs.active} / 终态 ${docs.terminal}${docs.invalid ? ` / 状态缺失或非法 ${docs.invalid}` : ''}）；模块已填 ${docs.withModule}/${docs.files}`);
for (const [t, v] of Object.entries(docs.perType)) console.log(`    ${t.padEnd(10)} ${String(v.n).padStart(3)} 篇 / ${kb(v.b)}`);
console.log(`  索引：workflow/INDEX.md ${kb(idxBytes)}（活跃 ${Number.isNaN(idxActive) ? '—' : idxActive} 行）`);
for (const e of surf.entries) console.log(`    ${e.label.padEnd(44)} ${String(e.max).padStart(6)} / ${String(e.lim).padStart(6)} B（${e.pct.toFixed(1)}%）`);
console.log(`  常驻面合计：${kb(surf.total)}`);
console.log(`  闭环漏斗：收口 ${funnel.closed}（完整链 ${funnel.full} = 确认链一次通过 ${funnel.once} + 返工 ${funnel.rework}；协议前 ${funnel.legacy}${legacyRatio === null ? '' : `，占比 ${(legacyRatio * 100).toFixed(0)}%`}${legacyRatio !== null && legacyRatio > LEGACY_RATIO_LIMIT ? ' ⚠️超30%阈值' : ''}）｜中位周期 ${fmtMedianDays(medianDays)} 天（git 首次加入 → 终态；无时间的件不进中位）｜台账行 ${funnel.ledgerRows}`);
for (const it of funnel.items) console.log(`    ${String(it.doc).padEnd(58)} ${it.kind.padEnd(7)} ${it.days} 天`);
if (funnel.items.length) console.log('  ℹ️ 机器口径可与 workflow/delegations.md 自做表的人工自报交叉对照（差异即信号，不对账）');
console.log(`  归因维度：incident ${a.total} 起｜来源 ${attrCell(a, SRC_KEYS) || '—'}｜环境 ${envCell(a, ENV_KEYS) || '—'}｜逃逸率 ${escapeCell}｜未判读 ${a.unjudged}｜引擎面提交占比 ${engCell}`);
console.log(`  门禁成本/迭代：全量绿行 ${costList.length} 行${costList.length ? `｜平均总耗时 ${costRow.split('|')[3].trim()}s｜最慢三门 ${costRow.split('|')[4].trim()}` : '（无埋点数据——2026-10-14 起采集）'}`);
{
  const dNow = deploys[month];
  console.log(`  发布观察：本月 ${dNow ? `release ${dNow.releases}（通过 ${dNow.passed} / 异常 ${dNow.abnormal}）` : '无记录（deploy.md §5 出结论即落行；长期无行 = 观察结论未落账挂债）'}`);
}
// 归档积压提醒（2026-10-15 减重手段⑥，回路别等人喊）：滚动归档已随确认门自动跑（confirm-doc
// archive-on-close），历史积压走 archive-sweep 手工批次——月度 stdout 报候选数使积压可见。
// 判定单源 = archive-sweep.analyze（21 天窗，禁第二套口径）；analyze/loadLastTouch 抛错（如
// 浅克隆无 git 历史）fail-open 静默——观测提醒不挡快照。
try {
  const allDocs = buildDocList(ROOT);
  const arch = analyze({
    docs: allDocs,
    ledgerTs: loadLedgerTs(ROOT),
    lastTouch: loadLastTouch(ROOT),
    activeTexts: allDocs.filter((d) => ACTIVE.has(parseStatus(d.text))).map((d) => d.text),
    windowDays: 21,
  });
  const fams = new Set(arch.candidates.map((x) => x.file));
  console.log(`  归档积压：候选 ${arch.candidates.length} 篇 / ${fams.size} 族（21 天窗）${arch.candidates.length ? '——node <插件根>/scripts/archive-sweep.mjs 查看，--execute 执行' : ''}`);
} catch { /* fail-open */ }
console.log(`  ${DRY ? '（--dry-run，未写盘）' : ''}`);

if (DRY) {
  console.log(`\n将写入行：\n${row}\n${funnelRow}\n${attrRow}\n${costRow}`);
  console.log(`\n复核效果表（整表再生）：\n${[...REVIEW_HEAD, ...reviewRows].join('\n')}`);
  console.log(`\nspec 体积观察表（整表再生）：\n${[...SPEC_HEAD, ...specRows].join('\n')}`);
  console.log(`\n发布观察表（整表再生）：\n${[...DEPLOY_HEAD, ...deployRows].join('\n')}`);
  process.exit(0);
}

// ---- 组装：GENERATED 区内的月表按月份键 upsert（同月重跑覆盖，行序按月升序）----
const HEADER = `# workflow 规模与规则面月度快照

> 生成器 \`node <插件根>/scripts/gen-workflow-metrics.mjs\`（每月或有需要时跑；同月重跑即更新该行）。明细（类型分布 / 逐条预算占用）看脚本 stdout，不落表。
> 口径：文档 = 磁盘（排除 \`_TEMPLATE.md\`）；常驻面 = \`.agents/config/rule-budgets.txt\` 逐条实测，括号内为「预算占用峰值项」。
> 归因表 = incident frontmatter 枚举；空键用 archive/attribution-legacy.md 对质表补齐（不回写文件；不明与仍缺的来源计入未判读）+ 引擎面提交占比（git）。
`;
const TABLE_HEAD = [
  '| 月份 | 文档（活跃/终态） | 文档字节 | 模块已填/总 | 常驻面字节（预算峰值） | INDEX（活跃行） |',
  '|---|---|---|---|---|---|',
];
// 漏斗表头（第二表；口径定义式单源 = workflow/specs/2026-10-02-ledger-funnel-metrics.md）
const FUNNEL_HEAD = [
  '## 闭环漏斗（机器口径，源：.agents/confirmations.jsonl 的阶段链。中位周期 = 该文件首次进入 git 到终态确认；取不到写 —，不写 0.0；四舍五入会得 0.0 的真实极小值写 <0.1——本仓建件与确认常在同会话内完成，该列常态即亚小时级，勿读作「口径失效」。「确认链一次通过」不是委派台账的静态门一次通过）',
  '',
  '| 月份 | 收口 | 完整链 | 协议前 | 确认链一次通过 | 返工件 | 中位周期(天) | 台账行数 |',
  '|---|---|---|---|---|---|---|---|',
];
// 归因表头（第三表；incident-attribution；2026-10-12 起空键用 attribution-legacy 补齐）。
// 「未判读」= 来源最终仍不在枚举（含 legacy 的「不明」）。引擎面提交占比 = .agents/ + .githooks/ + CI 的提交数/全量。
const ATTR_HEAD = [
  '## 产品与质量维度（源：incident frontmatter 枚举，空键用 attribution-legacy.md 补齐、不回写文件；未判读 = 来源仍不在枚举。引擎面 = git。逃逸率 = 非 self 来源（user/test/monitor）发现且触达 prod ÷ 当月 incident 总数，2026-10-14 起采集）',
  '',
  '| 月份 | incident | 来源（谁发现） | 影响环境 | 逃逸率 | 归因未判读 | 引擎面提交占比 |',
  '|---|---|---|---|---|---|---|',
];
// 门禁成本表头（第四表；2026-10-14 G8 门禁计时）。源 = .agents/verifications.jsonl all-gates 绿行的
// durations/totalMs（verify.mjs 逐门 performance.now 埋点，2026-10-14 起才有——无埋点旧行跳过）。
// 只读观测面不挂门禁；G10（影响面裁剪）的判据数据源（机制台账「门禁耗时埋点」行）。
// 「平均总耗时」= 墙钟优先：wallMs（2026-10-16 并行编排起落）＞ totalMs（各门之和，旧口径回退）。
const COST_HEAD = [
  '## 门禁成本/迭代（源：.agents/verifications.jsonl all-gates 绿行逐门耗时，2026-10-14 起采集，秒）',
  '',
  '| 月份 | 全量绿行 | 平均总耗时(秒) | 最慢三门（均值） |',
  '|---|---|---|---|',
];
const COST_HEAD_NOTE = '> 平均总耗时口径：墙钟（`wallMs`）；2026-10-16 并行编排前的绿行无该键，回退各门之和（`totalMs`）。';
const existing = fs.existsSync(METRICS_P) ? fs.readFileSync(METRICS_P, 'utf8') : '';
// --check 时效门（2026-10-27）：判「引擎量化自述有多旧」，不判逐字一致（快照是历史记录，逐字比必常红）。
// 治的正是实测缺口：published 表停在 2026-10-25（92 全量绿行 / 165.7s / 最慢门首位 backend-test），
// 而台账已到 137 绿行 / 193.3s / 首位 ledger-invariant——差 18 次验证且成本画像头名换人，无人发现。
if (CHECK) {
  const maxAgeDays = Number(process.env.METRICS_MAX_AGE_DAYS || 31);
  const snapM = existing.match(/<!-- 快照生成：([0-9T:.+-]+Z?)/);
  if (!snapM) {
    console.error('❌ workflow/metrics.md 无「快照生成」时刻标记——本门判的是自述时效（快照按设计是历史记录，逐字比会常红）');
    console.error('   修：node <插件根>/scripts/gen-workflow-metrics.mjs（重生成快照并写入生成时刻），须随同提交');
    process.exit(1);
  }
  const ts = Date.parse(snapM[1]);
  const ageDays = (Date.now() - ts) / 86400000;
  if (!Number.isFinite(ts) || ageDays > maxAgeDays) {
    console.error(`❌ workflow/metrics.md 快照陈旧 ${Number.isFinite(ts) ? ageDays.toFixed(1) : '?'} 天（上限 ${maxAgeDays} 天，METRICS_MAX_AGE_DAYS 可调）——引擎量化自述停在 ${snapM[1]}`);
    console.error('   修：node <插件根>/scripts/gen-workflow-metrics.mjs（重生成快照；须随同提交）');
    process.exit(1);
  }
  console.log(`✅ workflow/metrics.md 快照新鲜（生成于 ${snapM[1]}，${ageDays.toFixed(1)} 天前；上限 ${maxAgeDays} 天）`);
  process.exit(0);
}
let rows = [];
let funnelRows = [];
let attrRows = [];
let costRows = [];
if (existing.includes(BEGIN) && existing.includes(END)) {
  const section = existing.slice(existing.indexOf(BEGIN), existing.indexOf(END));
  // 表头句子会改（列名、时钟说明）。分段锚用稳定标题前缀，避免改表头时把漏斗行吸进体量表。
  const funnelMarker = '## 闭环漏斗';
  const attrMarker = '## 产品与质量维度';
  const costMarker = '## 门禁成本';
  const reviewMarker = '## 复核效果'; // 第五表整表再生、不回吸旧行；分段只为防旧复核行被误吸进成本行
  const bodyPart = section.includes(funnelMarker) ? section.slice(0, section.indexOf(funnelMarker)) : section;
  const restPart = section.includes(funnelMarker) ? section.slice(section.indexOf(funnelMarker)) : '';
  const funnelPart = restPart.includes(attrMarker) ? restPart.slice(0, restPart.indexOf(attrMarker)) : restPart;
  const attrRest = restPart.includes(attrMarker) ? restPart.slice(restPart.indexOf(attrMarker)) : '';
  const attrPart = attrRest.includes(costMarker) ? attrRest.slice(0, attrRest.indexOf(costMarker)) : attrRest;
  const costAll = attrRest.includes(costMarker) ? attrRest.slice(attrRest.indexOf(costMarker)) : '';
  const costPart = costAll.includes(reviewMarker) ? costAll.slice(0, costAll.indexOf(reviewMarker)) : costAll;
  rows = bodyPart.split(/\r?\n/).filter((l) => /^\|\s*\d{4}-\d{2}\s*\|/.test(l));
  funnelRows = funnelPart.split(/\r?\n/).filter((l) => /^\|\s*\d{4}-\d{2}\s*\|/.test(l));
  attrRows = attrPart.split(/\r?\n/).filter((l) => /^\|\s*\d{4}-\d{2}\s*\|/.test(l));
  costRows = costPart.split(/\r?\n/).filter((l) => /^\|\s*\d{4}-\d{2}\s*\|/.test(l));
}
// 非当月且已有体量行：冻结（该行是生成当天的磁盘快照，重跑会用今天的仓库盖掉）。漏斗与归因仍按月份键更新。
const priorVolume = rows.find((l) => l.startsWith(`| ${month} `));
const freezeVolume = month !== CURRENT_MONTH && !RESTAMP && !!priorVolume;
if (freezeVolume) {
  console.log(`体量行冻结：${month} 不是当月（${CURRENT_MONTH}），保留原体量行。漏斗与归因仍更新。覆盖体量请加 --restamp`);
} else {
  rows = rows.filter((l) => !l.startsWith(`| ${month} `));
  rows.push(row);
  rows.sort((a, b) => a.slice(2, 9).localeCompare(b.slice(2, 9)));
}
funnelRows = funnelRows.filter((l) => !l.startsWith(`| ${month} `));
funnelRows.push(funnelRow);
funnelRows.sort((a, b) => a.slice(2, 9).localeCompare(b.slice(2, 9)));
attrRows = attrRows.filter((l) => !l.startsWith(`| ${month} `));
attrRows.push(attrRow);
attrRows.sort((a, b) => a.slice(2, 9).localeCompare(b.slice(2, 9)));
costRows = costRows.filter((l) => !l.startsWith(`| ${month} `));
costRows.push(costRow);
costRows.sort((a, b) => a.slice(2, 9).localeCompare(b.slice(2, 9)));

// ---- 动作阈值播报（funnel-action-threshold）：相邻两月协议前占比均 >30% → 响亮动作要求 ----
// 判据只看日历相邻（nextMonth(前一月) === 当前月）的两行——单月波动（批量迁移 / 集中补录）不触发。
// 与 check-loop §26 同阈值同判据；这里是生成器侧的「当场响」，§26 是门禁侧的「每次跑都响」。
const parseLegacyCell = (row) => {
  const cells = row.split('|').map((c) => c.trim());
  const closed = Number(cells[2]);
  const legacy = Number(String(cells[4] || '').match(/^\d+/)?.[0] ?? NaN);
  if (!Number.isFinite(closed) || !Number.isFinite(legacy) || closed <= 0) return null;
  return { closed, legacy, ratio: legacy / closed };
};
const nextMonthKey = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const breachPairs = [];
for (let i = 1; i < funnelRows.length; i++) {
  const prevKey = funnelRows[i - 1].slice(2, 9);
  const curKey = funnelRows[i].slice(2, 9);
  if (nextMonthKey(prevKey) !== curKey) continue;
  const a = parseLegacyCell(funnelRows[i - 1]);
  const b = parseLegacyCell(funnelRows[i]);
  if (a && b && a.ratio > LEGACY_RATIO_LIMIT && b.ratio > LEGACY_RATIO_LIMIT) {
    breachPairs.push(`${prevKey} ${(a.ratio * 100).toFixed(0)}% → ${curKey} ${(b.ratio * 100).toFixed(0)}%`);
  }
}
if (breachPairs.length) {
  console.error(`⚠️ 闭环漏斗动作阈值触发：协议前占比连续两月 >${(LEGACY_RATIO_LIMIT * 100).toFixed(0)}%（${breachPairs.join('；')}）——闭环在被系统性绕开`);
  console.error('   按约定跑一轮归因：哪一环在逼人绕路（确认门太重 / 级别判错 / 批量豁免滥用？）——结论记 workflow/papercuts.md 或立 incident，并在 mechanism-registry 月度对账登记处置');
}
const SNAP_LINE = `<!-- 快照生成：${new Date().toISOString()}（${month} 行；判据 = 本生成器现场取数；时效门 = --check，METRICS_MAX_AGE_DAYS） -->`;
const inner = `${BEGIN}\n${SNAP_LINE}\n\n${[...TABLE_HEAD, ...rows].join('\n')}\n\n${[...FUNNEL_HEAD, ...funnelRows].join('\n')}\n\n${[...ATTR_HEAD, ...attrRows].join('\n')}\n\n${[...COST_HEAD, ...costRows, '', COST_HEAD_NOTE].join('\n')}\n\n${[...REVIEW_HEAD, ...reviewRows].join('\n')}\n\n${[...SPEC_HEAD, ...specRows].join('\n')}\n\n${[...DEPLOY_HEAD, ...deployRows].join('\n')}\n\n${END}`;
let out;
if (existing.includes(BEGIN) && existing.includes(END)) {
  out = existing.slice(0, existing.indexOf(BEGIN)) + inner + existing.slice(existing.indexOf(END) + END.length);
} else {
  out = (existing ? existing.replace(/\s*$/, '') + '\n\n' : HEADER) + inner + '\n';
}
fs.writeFileSync(METRICS_P, out, 'utf8');
console.log(`✅ 已更新 workflow/metrics.md（${month} 行；共 ${rows.length} 个月）`);
