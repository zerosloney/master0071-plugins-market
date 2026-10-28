#!/usr/bin/env node
// 跨语料检索入口（2026-09-21，intent 2026-09-21-workflow-doc-retrieval）
// 用法：node <插件根>/scripts/kb-search.mjs [选项] <词1> [词2 ...]（多词 AND，全部命中才算）
//
// 语料与口径
//   workflow（流程留痕）：只搜 frontmatter + H1 + 指定节（背景 / 目标 / 根因 / 复盘三件套 / 验收标准 / 影响面），
//     默认全状态可命中、活跃（draft/approved/open）排序 ×1.3 优先；输出带「节名 + 行号」便于节级读取。
//   wiki（领域知识）：沿用 2026-09-21 降噪口径——默认跳过 .json/.csv、*.visual-check.* 与 >180KB bulk 文件。
//   两侧排序均为 命中数/√文件KB（防大文件靠体量霸榜）；`-n` 为每语料展示上限。
// 结构缓存（2026-09-23 intent kb-search-structure-cache）：可检索子集预提取进 .agents/cache/kb-index.json，
//   按 [mtimeMs,size] 逐文件失效，口径指纹变化整份作废；匹配/排序/输出路径不变（三路输出与冷扫逐字节一致）；
//   缓存任何读写异常静默回退全扫。`--include-generated` 走纯扫（bulk 文件不入缓存）。
// 测试：node <插件根>/test/kb-search.test.mjs（fixture 回归，须全绿）
// 模块词表：.agents/config/workflow-modules.txt（--module 取值校验，单源）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ENUMS } from './workflow-enums.mjs';
// 路径收口（2026-10-27 插件化迁移）：脚本落插件内随市场分发；模块词表走 configDir（项目侧
// .agents/config 优先，回退插件内 config-templates 种子）、结构缓存落项目侧 .agents/cache
//（运行时数据不进插件目录）；语料检索仍按 cwd 相对路径（workflow/、wiki/）。
import { configDir, engineDir, findProjectRoot } from './paths.mjs';

const KB_PROJECT_ROOT = findProjectRoot() || process.cwd();
const MODULES_FILE = path.join(configDir(KB_PROJECT_ROOT), 'workflow-modules.txt');

const USAGE = `用法: node <插件根>/scripts/kb-search.mjs [选项] <词1> [词2 ...]（多词 AND）

  --scope <workflow|wiki|all>   检索语料，默认 all（指定 -t 时默认转 wiki）
  --files <路径,...>            文件关联检索：逗号分隔路径，各取「文件名去扩展名」
                                为词元，任一词元命中即算（OR）；与位置词（AND）叠加——起草 intent 历史教训节时
                                按改动文件找同类 incident/spec 用
  --type <intents,specs,plans,incidents>   workflow：限定文档类型（逗号分隔）
  --module <词表token>           workflow：按 frontmatter 模块过滤（词表见 .agents/config/workflow-modules.txt）
  --status <all|active|terminal> workflow：状态过滤，默认 all（active = draft/approved/open）
  -t <主题>                      wiki：限定主题目录（如 数据维护）
  -n <N>                         每语料展示文件数上限，默认 10；0 = 不限
  --include-generated            wiki：纳入默认跳过的 json/csv、*.visual-check.* 与 >180KB bulk 文件（走纯扫，不吃缓存）
  --no-cache                     禁用结构缓存，全量扫（与缓存热路径输出逐字节一致）
  --cache <文件>                 结构缓存文件路径覆盖（默认 .agents/cache/kb-index.json；测试注入用）
  --rebuild 忽略现有缓存重建后回写
  --stats 阶段耗时与缓存命中打到 stderr（stdout 不变；也可设 KB_SEARCH_STATS=1）
  --help                         打印本说明

退出码：0 正常（含无命中）；1 参数错误（无词 / 词内空白 / 未知选项 / 非法枚举值）`;

const args = process.argv.slice(2);
let scope = '';
let scopeExplicit = false;
let typeFilter = null;
let moduleFilter = '';
let statusFilter = 'all';
let topicFilter = '';
let limit = 10;
let limitRaw = '10';
let includeGenerated = false;
let noCache = false;
let cacheFileOverride = ''; // --cache <文件>（board-kb-p1）：测试注入式缓存路径，不再直跑清真实开发缓存
let rebuild = false;
let stats = process.env.KB_SEARCH_STATS === '1'; // --stats：阶段耗时与缓存命中打到 stderr，stdout 不变
let filesRaw = ''; // --files <路径,...>：文件关联 OR 词元
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--scope') { scope = args[++i] || ''; scopeExplicit = true; }
  else if (a === '--type') typeFilter = (args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--module') moduleFilter = args[++i] || '';
  else if (a === '--status') statusFilter = args[++i] || '';
  else if (a === '-t') topicFilter = args[++i] || '';
  else if (a === '-n') { limitRaw = args[++i] ?? ''; limit = Number(limitRaw); }
  else if (a === '--include-generated') includeGenerated = true;
  else if (a === '--no-cache') noCache = true;
  else if (a === '--cache') cacheFileOverride = args[++i] ?? '';
  else if (a === '--rebuild') rebuild = true;
  else if (a === '--stats') stats = true;
  else if (a === '--files') filesRaw = args[++i] || '';
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else words.push(a);
}
// --files 词元派生：各路径取文件名去扩展名（语料行文引用文件名的常态形态）；泛化名（denylist：
// index/AGENTS/README 等全语料常见名）丢弃防全量噪声。给了 --files 却派生为空 = 参数错误。
const GENERIC_TOKEN_RE = /^(index|agents|readme|template|package|types|utils|main)$/i;
const anyWords = filesRaw.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
  .map((p) => path.basename(p, path.extname(p)))
  .filter((t) => t && t.length > 2 && /[A-Za-z0-9\u4e00-\u9fa5]/.test(t) && !GENERIC_TOKEN_RE.test(t));
if (filesRaw && !anyWords.length) { console.error(`--files 未派生出有效词元（泛化名或空路径）\n\n${USAGE}`); process.exit(1); }

// ---- 计时与计数（--stats：只写 stderr；stdout 契约不变）----
const T0 = performance.now();
const marks = {};
const counts = { wf: 0, wiki: 0, hit: 0, miss: 0 };
let cacheDirty = false;
let cacheWrote = false;
if (!words.length && !anyWords.length) { console.error(USAGE); process.exit(1); }
// 空 query 校验（board-kb-p1）：空字符串词 includes('') 恒真 → 全量命中噪声（实测 109 文件命中）——参数错误
const qWords = words.map((w) => w.trim()).filter(Boolean);
if (!qWords.length && !anyWords.length) { console.error(`检索词不能为空（纯空白/空串）\n\n${USAGE}`); process.exit(1); }
// 词内空白拦截（2026-10-09 P3-1）：`kb-search "订单 导入"`（带引号单参数）此前静默 0 命中——
// 会被当「无同类历史」采信进 incident 回路（假阴性）。词内含空白 = 参数错误 fail-loud；
// 空格短语检索本就不受支持（拆词 AND 命中面是短语的超集），无损失面。
const spaced = qWords.filter((w) => /\s/.test(w));
if (spaced.length) {
  console.error(`词内含空白：${spaced.map((w) => `「${w}」`).join(' ')}——多词请拆独立参数（AND 语义）：node <插件根>/scripts/kb-search.mjs 订单 导入\n\n${USAGE}`);
  process.exit(1);
}
words.length = 0; words.push(...qWords); // 原位替换，下游 searchWorkflow/searchWiki 传参不变
if (!Number.isFinite(limit) || limit < 0) { console.error(`-n 须为非负整数（现 ${limitRaw}）\n\n${USAGE}`); process.exit(1); }
if (!scope) scope = topicFilter ? 'wiki' : 'all';
if (!['workflow', 'wiki', 'all'].includes(scope)) { console.error(`--scope 须为 workflow|wiki|all（现 ${scope}）\n\n${USAGE}`); process.exit(1); }
if (!['all', 'active', 'terminal'].includes(statusFilter)) { console.error(`--status 须为 all|active|terminal（现 ${statusFilter}）\n\n${USAGE}`); process.exit(1); }
const DOC_TYPES = ['intents', 'specs', 'plans', 'incidents'];
if (typeFilter && typeFilter.some((t) => !DOC_TYPES.includes(t))) {
  console.error(`--type 取值须为 ${DOC_TYPES.join('|')}（现 ${typeFilter.join(',')}）\n\n${USAGE}`);
  process.exit(1);
}
const MODULES = fs.readFileSync(MODULES_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
if (moduleFilter && !MODULES.includes(moduleFilter)) {
  console.error(`--module 未知模块：${moduleFilter}（词表见 .agents/config/workflow-modules.txt：${MODULES.join(' / ')}）\n\n${USAGE}`);
  process.exit(1);
}

// 活跃口径 = 单源 doc.status.active ∪ incident.status.active（与 workflow/INDEX.md 活跃层一致，fixed 归档案默认也可命中）
const ACTIVE_STATUS = [...ENUMS['doc.status.active'], ...ENUMS['incident.status.active']];
// 可检索节白名单（2026-10-13 扩面）：原 6 项只覆盖 intent/incident 的叙事节，spec 与 plan 的
// 主体节（功能行为/数据流/系统改动/约束遵守映射/验收判据/风险评估、改动方案/任务拆解/执行顺序/
// 验证计划/改动面/约束与风险/入口/遗留项）全部落在白名单外——实测 specs 1% / plans 1% 正文可检索
// （16084+15669 行仅 342 行入索引），「查同类实现」在 spec/plan 上恒空。扩面后 ~90%。
// 节名按 `## ` 标题前缀匹配（startsWith），故「改动面（L1 极简形态）」「约束遵守映射（对照 AGENTS.md
// 触达红线）」「验收标准（可测试）」等带后缀变体自动覆盖；「1. 功能行为」等编号变体由下方归一化处理。
const WF_SECTIONS = [
  // intent / incident 叙事节（原口径，逐字保留）
  '背景', '目标', '根因', '复盘三件套', '验收标准', '影响面',
  // spec 主体节
  '功能行为', '数据流', '系统改动', '约束遵守映射', '验收判据', '风险评估',
  // plan 主体节
  '入口', '改动方案', '改动面', '任务拆解', '执行顺序', '验证计划', '验证方式', '约束与风险', '遗留项',
];
const WIKI_EXCLUDE = new Set(['INDEX.md', '知识沉淀总览.html']);
const WIKI_MAX_KB = 180;

// ---- frontmatter（受限子集：每行 `键: 值`）+ H1 标题（去「INTENT — 」前缀）----
function parseDoc(text) {
  const meta = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\S+):\s*(.*)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
  }
  const h1 = text.match(/^# (.+)$/m);
  let title = h1 ? h1[1] : '';
  // 前缀分隔只认 em/en dash（任意间距）或带空格的 ASCII 连字符——裸连字符是 kebab-case 的一部分，不截断（2026-09-24）
  const dash = title.match(/\S+\s*(?:[—–]+|\s-\s)\s*(.+)$/);
  if (dash) title = dash[1];
  return { meta, title };
}

// ---- workflow 侧可检索行：frontmatter + H1 + 指定节（节名随 `## ` 标题滚动）；词过滤在调用方，缓存存词无关子集 ----
function workflowLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  if (/^---\s*$/.test(lines[0] || '')) {
    out.push({ ln: 1, section: '(frontmatter)', line: lines[0] });
    for (i = 1; i < lines.length; i++) {
      out.push({ ln: i + 1, section: '(frontmatter)', line: lines[i] });
      if (/^---\s*$/.test(lines[i])) { i++; break; }
    }
  }
 let section = '';
 for (; i < lines.length; i++) {
 const line = lines[i];
 const h2 = line.match(/^## (.+?)\s*$/);
 // 节名归一化：剥「1. 」「2、」等编号前缀（22 份 spec 用 `## 1. 功能行为` 形态，不剥则整节漏检）
 if (h2) section = h2[1].replace(/^\d+\s*[.、)]\s*/, '');
 if (/^# /.test(line) && !/^## /.test(line)) { out.push({ ln: i + 1, section: '(标题)', line }); section = ''; continue; }
 if (WF_SECTIONS.some((s) => section.startsWith(s))) out.push({ ln: i + 1, section, line });
 }
  return out;
}

function matchWords(lines, words, anyWords = []) {
  const byWord = words.map((w) => lines.filter((x) => x.line.includes(w)));
  if (byWord.some((h) => h.length === 0)) return null; // AND：任一词未命中即跳过
  if (anyWords.length && !lines.some((x) => anyWords.some((w) => x.line.includes(w)))) return null; // --files：任一文件词元命中即可（OR）
  const total = byWord.reduce((n, h) => n + h.length, 0);
  const shown = [...new Map(lines.map((x) => [x.ln, x])).values()].sort((a, b) => a.ln - b.ln).slice(0, 3);
  return { total, shown };
}

// ---- 结构缓存：可检索子集预提取，[mtimeMs,size] 两元组逐文件失效，指纹变即整份作废 ----
// 键 = <检索根 cwd>::<相对路径>（多语料根共存一文件，fixture 临时目录天然隔离）；读写任何异常静默回退全扫。
const CACHE_DIR = path.join(engineDir(KB_PROJECT_ROOT), 'cache');
const CACHE_FILE = cacheFileOverride || path.join(CACHE_DIR, 'kb-index.json');
const ROOT_NS = `${path.resolve('.')}::`;
// WIKI_EXTS：wiki 语料扩展面（含 --include-generated 分支）——上移至 CFG_FP 之前（board-kb-p1 起纳入指纹派生）
const WIKI_EXTS = includeGenerated ? /\.(md|sql|html|csv|json|txt)$/i : /\.(md|sql|html|txt)$/i;

// 行序列化/复活（缓存 schema 的定义者——board-kb-p1 起纳入 CFG_FP 指纹：schema 演进即整份缓存作废）
const serializeLines = (lines, kind) => lines.map((x) => (kind === 'wf' ? [x.ln, x.section, x.line] : [x.ln, x.line]));
const reviveLines = (lines, kind) => lines.map((a) => (kind === 'wf' ? { ln: a[0], section: a[1], line: a[2] } : { ln: a[0], line: a[1] }));

// linesShapeOk：缓存条目 lines 形状校验（board-kb-p1）——JSON 合法但 schema 坏（lines 非数组 / 元素非数组）
// 一律视同 miss 走 build 重建（头注释「任何读写异常静默回退」契约恢复；此前直接 .map 抛 TypeError exit 1）
const linesShapeOk = (lines) => Array.isArray(lines) && (lines.length === 0 || lines.every(Array.isArray));

const CFG_FP = createHash('sha256').update(JSON.stringify({
  v: 1, WF_SECTIONS, ACTIVE_STATUS, WIKI_MAX_KB, excl: [...WIKI_EXCLUDE],
  exts: WIKI_EXTS.source, // schema 派生（board-kb-p1：手抄摘要曾致扩展面演进不触发指纹失效；RegExp.source 跨 includeGenerated 分支稳定）
  fns: [parseDoc.toString(), workflowLines.toString(), matchWords.toString(), serializeLines.toString(), reviveLines.toString()],
})).digest('hex').slice(0, 16);
const cacheUsable = !noCache && !includeGenerated;
let cache = null;
const touched = new Set();
const tCache0 = performance.now();
if (cacheUsable) {
 try {
 const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
 cache = j && j.fp === CFG_FP && j.files && typeof j.files === 'object' ? j.files : {};
 } catch { cache = {}; }
 if (rebuild) { cache = {}; cacheDirty = true; }
}
marks.cache = performance.now() - tCache0;

// 取一个源文件的缓存条目；miss 时 build()（读全文提取可检索子集）并登记回写。返回 {st, meta?, title?, lines}
function cachedEntry(relPath, kind, build) {
  const abs = path.resolve(relPath);
 if (!cache) {
 const e = build();
 const st = fs.statSync(abs);
 e.st = [st.mtimeMs, st.size];
 counts.miss += 1;
 return e;
 }
 const key = ROOT_NS + relPath.split(path.sep).join('/');
 const st = fs.statSync(abs);
 const sig = [st.mtimeMs, st.size];
 const e = cache[key];
 if (e && e.kind === kind && Array.isArray(e.st) && e.st[0] === sig[0] && e.st[1] === sig[1] && linesShapeOk(e.lines)) {
 touched.add(key);
 counts.hit += 1;
 return { st: e.st, meta: e.meta, title: e.title, lines: reviveLines(e.lines, kind) };
 }
 const built = build();
 counts.miss += 1;
 cacheDirty = true;
  cache[key] = {
    st: sig, kind,
    ...(kind === 'wf' ? { meta: built.meta, title: built.title } : {}),
    lines: serializeLines(built.lines, kind),
  };
  touched.add(key);
  return { st: sig, meta: built.meta, title: built.title, lines: built.lines };
}

function saveCache() {
 if (!cache) return;
 if (!cacheDirty) return; // warm 无变化：零写盘（此前每次搜索重写整份缓存，大缓存 + 杀软下是主要耗时）
 const tSave0 = performance.now();
 try {
    for (const k of Object.keys(cache)) {
      if (!k.startsWith(ROOT_NS) || touched.has(k)) continue;
      const rel = k.slice(ROOT_NS.length).replace(/\//g, path.sep);
      try {
        const st = fs.statSync(rel);
        const e = cache[k];
        if (e.st[0] !== st.mtimeMs || e.st[1] !== st.size) delete cache[k];
      } catch { delete cache[k]; }
    }
 fs.mkdirSync(CACHE_DIR, { recursive: true });
 fs.writeFileSync(CACHE_FILE, JSON.stringify({ fp: CFG_FP, files: cache }));
 cacheWrote = true;
 } catch { /* 只读目录 / 并发写等异常：放弃回写，下次重建 */ }
 marks.save = performance.now() - tSave0;
}

// ---- workflow 检索 ----
function searchWorkflow(words) {
  const results = [];
  for (const type of (typeFilter || DOC_TYPES)) {
    // 活跃目录 + 归档批次（workflow/archive/<批次>/<type>/，2026-10-09）——
    // 归档件仍可检索（防复发不丢历史），标签用相对 workflow/ 的路径，活跃目录标签与旧口径逐字一致
    const dirs = [path.join('workflow', type)];
    const arcRoot = path.join('workflow', 'archive');
    if (fs.existsSync(arcRoot)) {
      for (const batch of fs.readdirSync(arcRoot)) {
        const d = path.join(arcRoot, batch, type);
        if (fs.existsSync(d)) dirs.push(d);
      }
    }
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const rel = path.relative('workflow', dir).split(path.sep).join('/');
      for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const p = path.join(dir, f);
      counts.wf += 1;
      const e = cachedEntry(p, 'wf', () => {
        const text = fs.readFileSync(p, 'utf8');
        const { meta, title } = parseDoc(text);
        return { meta, title, lines: workflowLines(text) };
      });
      const meta = e.meta || {};
      const status = meta['状态'] || '';
      const module = meta['模块'] || '—';
      if (moduleFilter && module !== moduleFilter) continue;
      if (statusFilter === 'active' && !ACTIVE_STATUS.includes(status)) continue;
      if (statusFilter === 'terminal' && ACTIVE_STATUS.includes(status)) continue;
      const hits = matchWords(e.lines.filter((x) => words.some((w) => x.line.includes(w)) || anyWords.some((w) => x.line.includes(w))), words, anyWords);
      if (!hits) continue;
      const kb = e.st[1] / 1024;
      const active = ACTIVE_STATUS.includes(status);
      results.push({
        file: `${rel}/${f}`, title: e.title || '', status, level: meta['级别'] || '—', module,
        total: hits.total, shown: hits.shown, kb,
        score: (hits.total / Math.sqrt(Math.max(kb, 0.1))) * (active ? 1.3 : 1),
      });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

// ---- wiki 检索（口径同 2026-09-21 降噪版 wiki-search）----
const walkWiki = (dir, rel) => {
  const out = [];
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) { out.push(...walkWiki(p, `${rel}/${e}`)); continue; }
    if (!WIKI_EXTS.test(e) || WIKI_EXCLUDE.has(e)) continue;
    out.push({ fsPath: p, key: `${rel}/${e}` });
  }
  return out;
};

function searchWiki(words) {
  const results = [];
  let skipped = 0;
  if (!fs.existsSync('wiki')) return { results, skipped };
  for (const d of fs.readdirSync('wiki')) {
    const dir = path.join('wiki', d);
    if (!fs.statSync(dir).isDirectory() || d === 'drafts-archive') continue;
    if (topicFilter && d !== topicFilter) continue;
 for (const { fsPath: p, key } of walkWiki(dir, d)) {
 counts.wiki += 1;
 const size = fs.statSync(p).size;
      if (!includeGenerated && (/\.visual-check\./i.test(path.basename(p)) || size > WIKI_MAX_KB * 1024)) { skipped++; continue; }
      const e = cachedEntry(p, 'wiki', () => {
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { return { lines: [] }; }
        return { lines: text.split('\n').map((line, i) => ({ ln: i + 1, line })) };
      });
      if (!e.lines.length) continue;
      const hits = matchWords(e.lines.filter((x) => words.some((w) => x.line.includes(w)) || anyWords.some((w) => x.line.includes(w))), words, anyWords);
      if (!hits) continue;
      const kb = size / 1024;
      results.push({ file: key, total: hits.total, shown: hits.shown, kb, score: hits.total / Math.sqrt(Math.max(kb, 0.1)) });
    }
  }
  return { results: results.sort((a, b) => b.score - a.score), skipped };
}

// ---- 输出 ----
const top = (arr) => (limit ? arr.slice(0, limit) : arr);
let anyHits = 0;

if (scope === 'workflow' || scope === 'all') {
 const tWf = performance.now();
 const res = searchWorkflow(words);
 marks.workflow = performance.now() - tWf;
  anyHits += res.length;
  const shown = top(res);
  console.log(`── workflow（${res.length} 个文件命中${res.length > shown.length ? `，展示前 ${shown.length}` : ''}）──`);
  for (const r of shown) {
    console.log(`📄 workflow/${r.file} — ${r.status || '未填状态'} · ${r.level} · ${r.module} · ${r.total} 处命中 / ${r.kb < 10 ? r.kb.toFixed(1) : Math.round(r.kb)}KB`);
    for (const h of r.shown) console.log(`   [${h.section}] L${h.ln}: ${h.line.trim().slice(0, 130)}`);
  }
  if (!res.length) console.log('（无命中）');
}

if (scope === 'wiki' || scope === 'all') {
 const tWiki = performance.now();
 const { results: res, skipped } = searchWiki(words);
 marks.wiki = performance.now() - tWiki;
  anyHits += res.length;
  const shown = top(res);
  console.log(`── wiki（${res.length} 个文件命中${res.length > shown.length ? `，展示前 ${shown.length}` : ''}）──`);
  for (const r of shown) {
    console.log(`📄 wiki/${r.file} — ${r.total} 处命中 / ${r.kb < 10 ? r.kb.toFixed(1) : Math.round(r.kb)}KB`);
    for (const h of r.shown) console.log(`   L${h.ln}: ${h.line.trim().slice(0, 130)}`);
  }
  if (!res.length) console.log('（无命中）');
  if (skipped) console.log(`（wiki 跳过 ${skipped} 个产物/大文件——--include-generated 纳入）`);
}

console.log(`\n${anyHits ? `合计 ${anyHits} 个文件命中（${words.join(' AND ')}）` : `无命中（${words.join(' AND ')}）`}` +
  `；排序：命中数/√文件KB${scope === 'workflow' ? '' : '（workflow 侧活跃 ×1.3）'}` +
  (scope === 'all' ? '；`--scope` 限定语料、`--status all` 显式全量' : ''));

saveCache();

if (stats) {
 const total = performance.now() - T0;
 let size = '—';
 try { size = (fs.statSync(CACHE_FILE).size / 1048576).toFixed(1); } catch { /* 无缓存 */ }
 console.error(`[kb] wf=${counts.wf} wiki=${counts.wiki} | cache hit=${counts.hit} miss=${counts.miss} wrote=${cacheWrote} ${size}MB | cache=${(marks.cache || 0).toFixed(0)}ms workflow=${(marks.workflow || 0).toFixed(0)}ms wiki=${(marks.wiki || 0).toFixed(0)}ms save=${(marks.save || 0).toFixed(0)}ms total=${total.toFixed(0)}ms`);
}
