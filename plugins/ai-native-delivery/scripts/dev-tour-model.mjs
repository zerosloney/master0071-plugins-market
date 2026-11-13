#!/usr/bin/env node
// dev-tour-model.mjs — 开发全景图数据模型（spec/plan/todo → 步骤 × 文件 × 时序）
// 单源：workflow 文档正文（步骤 / 任务拆解 / 改动方案 / 系统改动）+ git 工作树（--base 对比）。
// 零依赖；供 gen-dev-tour.mjs（静态快照）消费。实时视图（workflow-board-server / auto-tour）
// 暂未随插件分发——本模型保持采集与组装面单源，实时版分发时直接复用，不改口径。
//
// 设计口径：
//   1. 文档是「计划面」：步骤顺序、每步做什么、预计改哪些文件，全部从正文解析，不另造一份台账。
//   2. git 是「实际面」：--base 之后的新增/修改/删除行数、真实文件清单，用于发现「文档外改动」。
//   3. 两者按文件路径（含相对路径后缀 / basename 兜底）合并；解析不到步骤的文件进「未分步」，
//      解析不到文档的实际改动进「文档外改动」，不静默丢弃。
//   4. 时序图不猜业务消息：按每步涉及文件的架构层（前端→API→应用→领域→基础设施→DB）连箭头；
//      步骤正文若显式写「A → B」仍以文件层为准，保证图与改动面一致。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectRoot } from './paths.mjs';

// DEFAULT_ROOT（插件化适配）：使用项目的 git 仓库根（paths.mjs projectRoot 单源锚定，非 git 目录
// 回退 cwd）。源仓默认 `SCRIPT_DIR/../..` 在插件形态下指向插件安装目录——插件是资产、使用项目
// 才是数据面，台账与 cache 一律落使用项目仓库根，语义不能变。
export const DEFAULT_ROOT = projectRoot() || process.cwd();

const CODE_ROOTS = ['backend/', 'frontend/', 'tests/', 'db/', 'database/', 'sql/', 'scripts/', 'tools/', 'integration/'];
const DOC_ROOTS = ['workflow/', 'wiki/', '.agents/'];
const IGNORE_DIRS = ['node_modules/', 'bin/', 'obj/', '.git/', '.vs/', 'dist/', 'coverage/', '.agents/cache/', '.agents/tmp/'];
const CODE_EXT = /\.(cs|ts|tsx|js|jsx|mjs|cjs|vue|sql|json|html|css|scss|csproj|sln|yml|yaml|xml|config|props|targets)$/i;

const LAYERS = [
  { id: 'frontend', label: '前端', rank: 0, test: '前端' },
  { id: 'api', label: 'API', rank: 1, test: 'API/控制器' },
  { id: 'app', label: '应用层', rank: 2, test: '应用层' },
  { id: 'domain', label: '领域层', rank: 3, test: '领域层' },
  { id: 'infra', label: '基础设施', rank: 4, test: '基础设施' },
  { id: 'db', label: '数据库', rank: 5, test: '数据库' },
  { id: 'test', label: '测试', rank: 6, test: '测试' },
  { id: 'doc', label: '文档', rank: 7, test: '文档' },
  { id: 'other', label: '其他', rank: 8, test: '其他' },
];
const LAYER_BY_ID = new Map(LAYERS.map((l) => [l.id, l]));

const STATUS_LABEL = { new: '新增', modified: '修改', deleted: '删除', renamed: '重命名', planned: '计划', unchanged: '未变' };
const TYPE_LABEL = { intents: 'INTENT', specs: 'SPEC', plans: 'PLAN', incidents: 'INCIDENT' };

// ---------------- 通用小工具 ----------------
export function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}
function stripLineNo(p) {
  return p.replace(/:\d+(?:-\d+)?$/, '').replace(/[，。；、,;]+$/, '');
}
function uniq(a) { return [...new Set(a)]; }
function clamp(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function rel(root, abs) { return normPath(path.relative(root, abs)); }
function firstLine(s) { return String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || ''; }

function isIgnored(p) {
  const s = '/' + normPath(p);
  return IGNORE_DIRS.some((d) => s.includes('/' + d)) || /(^|\/)\.tour\.html$/.test(p);
}
function inCodeScope(p) {
  return CODE_ROOTS.some((r) => p.startsWith(r)) && !isIgnored(p);
}
function isDocPath(p) {
  return DOC_ROOTS.some((r) => p.startsWith(r)) || /\.md$/i.test(p);
}
function looksLikePath(s) {
  if (!s) return false;
  s = stripLineNo(normPath(s));
  if (!s || /\s/.test(s)) return false;
  if (/^[a-z]+:\/\//i.test(s)) return false;
  if (/^(node:|System\.|Microsoft\.)/i.test(s)) return false;
  if (s.includes('*') || s.includes('<') || s.includes('>') || s.startsWith('/')) return false;
  if (s.includes('=') || s.startsWith('-')) return false;
  if (/^[A-Za-z]:\//.test(s)) return false;
  if (isIgnored(s)) return false;
  if (!s.includes('/') && !CODE_EXT.test(s) && !/\.(md|cs|ts|vue|sql)$/i.test(s)) return false;
  if (s.includes('/') && !CODE_EXT.test(s) && !CODE_ROOTS.some((r) => s.startsWith(r)) && !DOC_ROOTS.some((r) => s.startsWith(r))) {
    // 允许 Application/Services/Foo.cs 这类相对路径
    if (!/\/[^/]+\.[A-Za-z0-9]+$/.test(s)) return false;
  }
  return true;
}

// ---------------- 文档解析 ----------------
export function parseFrontmatter(text) {
  const out = {};
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!src.startsWith('---')) return out;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return out;
  const head = src.slice(3, end).split(/\r?\n/);
  for (const line of head) {
    const m = line.replace(/\r$/, '').match(/^([^:#]+):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

export function parseSections(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  // 跳过 frontmatter 后再按标题切；正文标题只认 ^## / ^###
  const sections = [];
  let cur = null;
  let fence = false;
  // body 做 trim 的同时记录被剥掉的前导空行数：行号 = start + lead + j + 2（j 为 trim 后 body 行下标）
  const sliceBody = (from, to) => {
    const raw = lines.slice(from, to);
    const lead = raw.findIndex((x) => x.trim() !== '');
    return { body: raw.join('\n').trim(), lead: lead < 0 ? raw.length : lead };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (m) {
      if (cur) { cur.end = i; Object.assign(cur, sliceBody(cur.start + 1, i)); sections.push(cur); }
      cur = { level: m[1].length, title: m[2].trim(), start: i, end: lines.length, body: '', lead: 0 };
    }
  }
  if (cur) { cur.end = lines.length; Object.assign(cur, sliceBody(cur.start + 1, lines.length)); sections.push(cur); }
  // frontmatter 内的 `---` 不是标题；上面只匹配 # 开头，安全。
  return sections;
}

export function extractTitle(text) {
  const m = String(text || '').match(/^#\s+(.+?)\s*$/m);
  if (!m) return '';
  return m[1].replace(/^(PLAN|SPEC|INTENT|INCIDENT)\s*[—\-–]\s*/i, '').trim();
}

function sectionByTitle(sections, names) {
  const wanted = names.map((n) => n.replace(/[（(].*$/, '').trim());
  return sections.find((s) => {
    const t = s.title.replace(/[（(].*$/, '').trim();
    return wanted.includes(t) || wanted.some((w) => s.title.startsWith(w));
  });
}
function childSections(sections, parent) {
  const out = [];
  for (const sec of sections) {
    if (sec.start <= parent.start) continue;
    if (sec.level <= parent.level) break;
    if (sec.level === parent.level + 1) out.push(sec);
  }
  return out;
}

export function extractPaths(text, repo = null) {
  const out = new Set();
  const add = (raw) => {
    let s = stripLineNo(String(raw || '').trim());
    s = s.replace(/^[`'"“”‘’(（\s]+|[`'"“”‘’(）)\s]+$/g, '');
    s = normPath(s);
    if (looksLikePath(s)) out.add(s);
  };
  const src = String(text || '');
  // 1) 反引号：文档里最主要的路径书写方式
  for (const m of src.matchAll(/`([^`\n]{2,240})`/g)) {
    add(m[1]);
  }
  // 2) 已知根目录的裸路径（含中文标点边界）
  for (const m of src.matchAll(/(?:^|[\s(（:：,，;；])((?:backend|frontend|tests|db|database|sql|scripts|tools|integration|wiki|workflow|\.agents)\/[^\s`'"“”‘’，。；、)）]+)/g)) {
    add(m[1]);
  }
  // 3) 未反引号的中段路径（如步骤标题里的 pml/index.vue）：含 / + 已知代码扩展名 + 能消解到仓库真实文件，
  //    三条件同时满足才收——否则静默丢弃（防 if/else 类杂型 token 噪音，上轮实测 719 个）。
  //    消解复用 resolvePath 但不给上下文（确定性后缀/目录反推/basename 唯一，不打分不猜测）。
  if (repo) {
    for (const m of src.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g)) {
      const cand = normPath(m[0].replace(/\.+$/, ''));
      if (out.has(cand) || !cand.includes('/') || /\/\//.test(cand) || !CODE_EXT.test(cand)) continue;
      if (!repo.set.has(resolvePath(cand, new Set(), repo, []))) continue;
      out.add(cand);
    }
  }
  return [...out];
}

function labelOf(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(?:批次\s*)?([A-Za-z]{1,4}[-_]?\d+[A-Za-z]?|[0-9]+[A-Za-z]?(?:\.[0-9]+)?|批次\s*[0-9A-Za-z]+)\s*[：:、.\-—·•]?\s*(.*)$/);
  if (!m) return { id: '', title: s };
  return { id: m[1].replace(/\s+/g, ''), title: m[2].trim() || m[1] };
}
function sameLabel(a, b) {
  const x = String(a || '').replace(/\s+/g, '').toLowerCase();
  const y = String(b || '').replace(/\s+/g, '').toLowerCase();
  return x && y && (x === y || x === 't' + y || y === 't' + x);
}

// 步骤可带并集标签成员集（任务行 `1. S1+S2：…` → ids=['S1','S2']）；块↔步骤按成员交集命中
function stepLabels(st) {
  return st.ids && st.ids.length ? st.ids : [st.id];
}
function blockMatchesStep(b, st) {
  const bids = b.ids && b.ids.length ? b.ids : (b.id ? [b.id] : []);
  return (bids.length && stepLabels(st).some((sid) => bids.some((bid) => sameLabel(bid, sid)))) ||
    (b.title && (b.title.includes(st.title) || st.title.includes(b.title)));
}

function newStep(o) {
  return {
    id: '', index: 0, title: '', summary: '', detail: [], detailPos: [],
    files: [], status: 'todo', source: 'doc', raw: '',
    line: 0,
    ...o,
  };
}

// 从 `## 步骤` 的编号列表提取
function stepsFromNumberedSection(sec) {
  const steps = [];
  let cur = null;
  for (const [j, line] of sec.body.split(/\r?\n/).entries()) {
    const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (m) {
      if (cur) steps.push(cur);
      let body = m[2].trim();
      let title = body;
      let summary = '';
      const bold = body.match(/^\*\*(.+?)\*\*\s*[：:]?\s*(.*)$/);
      if (bold) { title = bold[1].trim(); summary = bold[2].trim(); }
      else {
        const c = body.indexOf('：');
        if (c >= 0) { title = body.slice(0, c).trim(); summary = body.slice(c + 1).trim(); }
      }
      const lb = labelOf(title);
      cur = newStep({
        id: lb.id || `S${m[1]}`,
        title: lb.title || title,
        summary,
        raw: line,
        source: 'steps',
        line: sec.start + sec.lead + j + 2,
      });
      if (lb.id && title.startsWith(lb.id)) cur.title = lb.title;
    } else if (cur) {
      const t = line.trim();
      if (t) { cur.detail.push(t); cur.detailPos.push(sec.start + sec.lead + j + 2); }
    }
  }
  if (cur) steps.push(cur);
  return steps;
}

// 从 `## 任务拆解` 的 checkbox 列表提取
function stepsFromTaskSection(sec) {
  const steps = [];
  let cur = null;
  for (const [j, line] of sec.body.split(/\r?\n/).entries()) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(?:(\d+)[.、]\s*)?(.*)$/);
    if (m) {
      if (cur) steps.push(cur);
      const done = m[1].toLowerCase() === 'x';
      const raw = m[3].trim();
      // 任务行标签：并集式（`S1+S2：标题` / `S8+S9 收口`）拆成员集；单个（`T1 标题` / `S7：标题`）走 labelOf
      // ——仅认显式编号标签（并集/单个），粗体无编号锚与词面模糊匹配不做：宁可不绑，留失约可见
      const um = raw.match(/^([A-Za-z]{1,4}[-_]?\d+[A-Za-z]?(?:\s*\+\s*[A-Za-z]{1,4}[-_]?\d+[A-Za-z]?)+)(?:\s|[：:]\s*)(.*)$/);
      const lb = /^[A-Za-z]{1,4}[-_]?\d+[A-Za-z]?(?:\s|[：:])/.test(raw) ? labelOf(raw) : { id: '', title: raw };
      const ids = um ? um[1].replace(/\s+/g, '').split('+') : null;
      cur = newStep({
        id: um ? ids[0] : (lb.id || (m[2] ? 'T' + m[2] : `S${steps.length + 1}`)),
        ids,
        title: um ? um[2].trim() : (lb.title || raw),
        summary: '',
        status: done ? 'done' : 'todo',
        raw: line,
        source: 'tasks',
        line: sec.start + sec.lead + j + 2,
      });
    } else if (cur) {
      const t = line.trim();
      if (t) {
        if (/^-\s*判据[：:]/.test(t)) cur.summary = t.replace(/^-\s*判据[：:]\s*/, '');
        else { cur.detail.push(t); cur.detailPos.push(sec.start + sec.lead + j + 2); }
      }
    }
  }
  if (cur) steps.push(cur);
  return steps;
}

// 把 `## 改动方案` / `## 改动面` / `## 系统改动清单` 拆成块
function blocksFromChangeSection(sec, splitFiles = false) {
  const blocks = [];
  let cur = null;
  let last = null; // 最近落盘的块
  let openParent = null; // 连续缩进锚共享的无锚父文件行
  const flush = () => { if (cur) { blocks.push(cur); last = cur; cur = null; } };
  for (const [j, line] of sec.body.split(/\r?\n/).entries()) {
    const h = line.match(/^###\s+(.+)$/);
    const b = line.match(/^\s*-\s+\*\*(.+?)\*\*\s*[：:]?\s*(.*)$/);
    const plain = line.match(/^\s*-\s+(.+)$/);
    if (h || b) {
      flush();
      const raw = (h ? h[1] : b[1] + (b[2] ? '：' + b[2] : '')).trim();
      const lb = labelOf(raw);
      const indented = /^\s/.test(line);
      cur = { id: lb.id, title: lb.title || raw, raw, lines: [], line: sec.start + sec.lead + j + 2 };
      // 缩进锚（`  - **S1**`）继承无锚父文件行：子锚描述的就是对父文件的改动，全部连续子锚都继承；
      // 父块自身无标签，单独成块只会被重复归集进「改动面（未分步）」
      if (indented && (openParent || (last && !last.id && last.isParentFile))) {
        const parent = openParent || last;
        cur.lines.unshift(...parent.lines);
        parent.dead = true;
        openParent = parent;
      } else {
        openParent = null;
      }
    } else if (plain) {
      const txt = plain[1].trim();
      const paths = extractPaths(txt);
      const topLevel = !/^\s+/.test(line);
      const startsWithPath = /^`[^`]+`/.test(txt);
      // 顶层括注编号标签（`- \`path\`（**S7**）：…`）也是块锚；须带路径才提升，纯散文括注不认
      const pm = topLevel && paths.length ? txt.match(/[（(]\*\*([A-Za-z]{1,4}[-_]?\d+[A-Za-z]?(?:\s*\+\s*[A-Za-z]{1,4}[-_]?\d+[A-Za-z]?)*)\*\*[）)]/) : null;
      if (pm || (splitFiles && topLevel && startsWithPath && cur && cur.lines.length)) flush();
      if (topLevel) openParent = null;
      if (pm) {
        const first = paths[0] || '';
        const ids = pm[1].replace(/\s+/g, '').split('+');
        cur = { id: ids[0], ids: ids.length > 1 ? ids : undefined, title: first ? first.split('/').pop() : '', raw: txt, lines: [txt], line: sec.start + sec.lead + j + 2 };
        continue;
      }
      if (!cur) {
        const first = paths[0] || '';
        cur = { id: '', title: first ? first.split('/').pop() : '', raw: txt, lines: [], line: sec.start + sec.lead + j + 2, isParentFile: topLevel && startsWithPath };
      }
      cur.lines.push(txt);
    } else if (/^\s*\|/.test(line) && line.trim()) {
      // 表格行（`| \`path\` | 说明 |`）：路径归入当前块上下文；无块上下文时自成无锚块 → 未分步可见
      const txt = line.trim();
      const paths = extractPaths(txt);
      if (!cur) {
        const first = paths[0] || '';
        cur = { id: '', title: first ? first.split('/').pop() : '', raw: txt, lines: [], line: sec.start + sec.lead + j + 2 };
      }
      cur.lines.push(txt);
    } else if (cur && line.trim()) {
      cur.lines.push(line.trim());
    }
  }
  flush();
  // 只保留有文件或标题的块；dead = 已被子锚继承的无锚父块
  return blocks.filter((b) => !b.dead && (b.lines.length || b.title));
}

function inferLayer(p) {
  const s = normPath(p);
  if (s.startsWith('tests/') || /\.(test|spec)\.[tj]sx?$/i.test(s)) return 'test';
  if (s.startsWith('frontend/') || /\.(vue|css|scss)$/i.test(s)) return 'frontend';
  if (/\/Controllers?\//i.test(s) || s.startsWith('backend/') && /\.API\//i.test(s)) return 'api';
  if (/\/Domain\//i.test(s) || /\/Entities?\//i.test(s)) return 'domain';
  if (/\/Infrastructure\//i.test(s) || /DbContext/i.test(s) || /\/Repositories?\//i.test(s)) return 'infra';
  if (s.startsWith('db/') || s.startsWith('database/') || s.startsWith('sql/') || /\.sql$/i.test(s)) return 'db';
  if (s.startsWith('backend/') || /\/Application\//i.test(s) || /\/Services?\//i.test(s) || /\/Dtos?\//i.test(s)) return 'app';
  if (isDocPath(s) || s.startsWith('.agents/')) return 'doc';
  return 'other';
}

function inferLayersFromText(text) {
  const s = String(text || '');
  const out = [];
  if (/前端|页面|按钮|表单|弹窗|抽屉|vue|store|路由/i.test(s)) out.push('frontend');
  if (/API|控制器|Controller|端点|接口\s*\/|路由参数/i.test(s)) out.push('api');
  if (/应用层|服务|Service|映射|编排|DTO|用例/i.test(s)) out.push('app');
  if (/领域|Domain|实体|Entity|值对象/i.test(s)) out.push('domain');
  if (/仓储|Repository|EF|DbContext|基础设施|Infrastructure/i.test(s)) out.push('infra');
  if (/数据库|SQL|表结构|schema|迁移|字段/i.test(s)) out.push('db');
  if (/测试|用例|单测|集成测试|Test/i.test(s)) out.push('test');
  return [...new Set(out)];
}

function fileRecord(p, o = {}) {
  return {
    path: normPath(p), status: 'planned', badge: STATUS_LABEL.planned,
    additions: 0, deletions: 0, binary: false, test: false, layer: inferLayer(p),
    planned: false, actual: false, steps: [], diff: '', oldPath: '',
    pathGuess: false,
    ...o,
  };
}

const REPO_CACHE = new Map();
function trackedIndex(root) {
  const hit = REPO_CACHE.get(root);
  if (hit && Date.now() - hit.at < 30000) return hit.index;
  const out = git(['ls-files'], root);
  const files = out ? out.split(/\r?\n/).map((x) => normPath(x.trim())).filter(Boolean) : [];
  const set = new Set(files);
  const byBase = new Map();
  const dirs = new Set();
  for (const p of files) {
    const base = p.split('/').pop();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(p);
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const index = { files, set, byBase, dirs: [...dirs] };
  REPO_CACHE.set(root, { at: Date.now(), index });
  return index;
}

function contextTokens(doc, step) {
  const raw = [
    doc.title, doc.module, step?.title, step?.summary,
    ...(step?.detail || []),
  ].join(' ');
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  // 同一批文件里已解析出的目录名也是强上下文（如 api/itemCatalog.ts → itemcatalog）
  for (const p of step?.files || []) {
    for (const seg of p.split('/')) {
      const t = seg.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase();
      if (t.length >= 4) tokens.push(t);
    }
  }
  return [...new Set(tokens)];
}

export function resolvePath(p, universe, repo, context = [], guesses = null) {
  const s = normPath(p);
  if (!s) return s;
  // 1) 真实仓库文件优先：相对路径先按后缀命中，避免被「文档里的原样路径」抢先
  if (repo?.set.has(s)) return s;
  const rsuffix = s.includes('/') ? [...(repo?.set || [])].find((x) => x.endsWith('/' + s)) : null;
  if (rsuffix) return rsuffix;
  // 2) 绝对根路径才直接信文档原样；相对路径继续找真实前缀
  const rooted = CODE_ROOTS.some((r) => s.startsWith(r)) || DOC_ROOTS.some((r) => s.startsWith(r));
  if (rooted && universe.has(s)) return s;
  if (rooted && s.includes('/')) {
    const us = [...universe].find((x) => x.endsWith('/' + s));
    if (us) return us;
  }

  const base = s.split('/').pop();
  const dir = s.includes('/') ? s.split('/').slice(0, -1).join('/') : '';
  if (dir && repo) {
    // 3a) 目录本身是已存在目录（候选必须是真实跟踪文件才可返回——反推不验证存在 = 制造假路径，宁可原样未解析）
    const cands = repo.dirs.filter((d) => d === dir || d.endsWith('/' + dir));
    if (cands.length === 1 && repo.set.has(cands[0] + '/' + base)) return cands[0] + '/' + base;
    // 3b) 目录不是完整目录（如 Dtos 下只有子目录）：用任意已跟踪文件的路径前缀反推（同样须验证候选真实存在）
    const marker = dir + '/';
    const hits = repo.files.filter((f) => { const i = f.indexOf(marker); return i >= 0 && (i === 0 || f[i - 1] === '/' || f[i - 1] === '.'); });
    if (hits.length) {
      const prefixes = uniq(hits.map((f) => f.slice(0, f.indexOf(marker))));
      if (prefixes.length === 1 && repo.set.has(prefixes[0] + dir + '/' + base)) return prefixes[0] + dir + '/' + base;
      if (prefixes.length > 1 && context.length) {
        const ranked = prefixes.map((p) => ({ p, sc: context.reduce((n, t) => n + (p.toLowerCase().includes(t) ? 1 : 0), 0) }))
          .sort((a, b) => b.sc - a.sc);
        const cand = ranked[0].p + dir + '/' + base;
        if (ranked[0].sc > 0 && ranked[0].sc > (ranked[1]?.sc || 0) && repo.set.has(cand)) {
          // 多候选上下文打分 = 路径猜测（basename 唯一命中不算）——guesses 供 parseHealth.pathGuesses 计量
          if (guesses) guesses.push({ path: s, candidates: prefixes.length });
          return cand;
        }
      }
    }
    // 3c) 从最长后缀逐段回退（同样须验证候选真实存在，否则继续回退直至原样）
    const segs = dir.split('/');
    for (let i = 1; i < segs.length; i++) {
      const tail = segs.slice(i).join('/');
      const c = repo.dirs.filter((d) => d === tail || d.endsWith('/' + tail));
      if (c.length === 1 && repo.set.has(c[0] + '/' + base)) return c[0] + '/' + base;
    }
  }
  // 4) 已合并集合（实际改动 / 文档路径）；裸文件名继续走 basename 解析
  const isBare = !s.includes('/');
  if (!isBare && universe.has(s)) return s;
  const usuffix2 = [...universe].find((x) => x.endsWith('/' + s));
  if (usuffix2) return usuffix2;
  // 5) basename 唯一 → 直接命中
  if (!isBare) {
    const uBase = [...universe].filter((x) => x.split('/').pop() === base);
    if (uBase.length === 1) return uBase[0];
  }
  const rBase = repo?.byBase.get(base) || [];
  if (rBase.length === 1) {
    // basename 唯一命中（裸文件名的 P1 机制）；带目录的 raw 仅当其目录在仓库里确实存在才兜底，
    // 否则该目录是笔误/未落库路径（如 tmp/perf/），原样返回保持可见，不跨目录冒名顶替
    if (isBare || repo.dirs.some((d) => d === dir || d.endsWith('/' + dir))) return rBase[0];
  }
  // 6) basename 多候选 → 用文档/步骤上下文打分（itemCatalog 页面下的 detail.vue 等）
  if (rBase.length > 1 && context.length) {
    let best = null; let bestScore = 0; let tie = false;
    for (const c of rBase) {
      const lc = c.toLowerCase();
      let sc = 0;
      for (const t of context) if (lc.includes(t)) sc += t.length >= 8 ? 2 : 1;
      if (sc > bestScore) { best = c; bestScore = sc; tie = false; }
      else if (sc === bestScore && sc > 0) tie = true;
    }
    if (best && !tie) {
      // basename 多候选打分 = 路径猜测；guesses 由 buildTour 聚合进 parseHealth.pathGuesses
      if (guesses) guesses.push({ path: s, candidates: rBase.length });
      return best;
    }
  }
  return s;
}

// ---------------- git 实际面 ----------------
function git(args, root) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export function collectGit({ root = DEFAULT_ROOT, base = 'HEAD', includeAll = false, includeDocs = false, withDiff = true, maxDiffLines = 160 } = {}) {
  const info = { available: false, base, files: new Map(), basePaths: new Set(), note: '' };
  const top = git(['rev-parse', '--show-toplevel'], root);
  if (!top || normPath(top.trim()) !== normPath(root)) {
    info.note = '不在 git 仓库根或 git 不可用';
    return info;
  }
  const resolved = git(['rev-parse', '--verify', `${base}^{commit}`], root);
  if (!resolved) { info.note = `base 不存在：${base}`; return info; }
  info.available = true;
  info.baseSha = resolved.trim().slice(0, 12);

  // 合并进行中（MERGE_HEAD 存在）：工作树 vs HEAD 的差异 = 被合入分支的整批变更，不是「文档外实际改动」。
  // 2026-11-10 实证：merge 期间 pre-commit 的 dev-tour「默认路径回归」恒多出一层 git 步，合并提交被阻断
  //（多文件合并无法自证——测试读的是活工作树，不是夹具）。合并完成后的下一次采集照常。
  if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root)) {
    info.note = '合并进行中（MERGE_HEAD）：跳过实际改动面采集';
    return info;
  }

  const tree = git(['ls-tree', '-r', '--name-only', base], root);
  if (tree) for (const l of tree.split(/\r?\n/)) if (l.trim()) info.basePaths.add(normPath(l.trim()));

  const nameStatus = git(['diff', '--name-status', '-M', base, '--'], root);
  if (nameStatus) {
    for (const l of nameStatus.split(/\r?\n/)) {
      if (!l.trim()) continue;
      const parts = l.split('\t');
      const code = parts[0][0];
      const oldP = normPath(parts[1] || '');
      const newP = normPath(parts[2] || parts[1] || '');
      const p = newP;
      if (!p || isIgnored(p)) continue;
      const status = code === 'A' ? 'new' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
      const rec = fileRecord(p, { status, badge: STATUS_LABEL[status], actual: true, oldPath: code === 'R' ? oldP : '' });
      info.files.set(p, rec);
    }
  }

  const numstat = git(['diff', '--numstat', '-M', base, '--'], root);
  if (numstat) {
    for (const l of numstat.split(/\r?\n/)) {
      if (!l.trim()) continue;
      const parts = l.split('\t');
      if (parts.length < 3) continue;
      const add = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
      const del = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
      let p = parts.slice(2).join('\t');
      if (p.includes('=>')) p = p.split('=>').pop().trim();
      p = normPath(p);
      const rec = info.files.get(p);
      if (rec) { rec.additions = add; rec.deletions = del; rec.binary = parts[0] === '-' && parts[1] === '-'; }
      else if (!isIgnored(p)) info.files.set(p, fileRecord(p, { status: 'modified', badge: STATUS_LABEL.modified, actual: true, additions: add, deletions: del }));
    }
  }

  // untracked：git diff 看不到，单独枚举
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root);
  if (untracked) {
    for (const l of untracked.split(/\r?\n/)) {
      const p = normPath(l.trim());
      if (!p || isIgnored(p)) continue;
      if (!info.files.has(p)) {
        let lines = 0;
        try { lines = fs.readFileSync(path.join(root, p), 'utf8').split(/\r?\n/).length; } catch { /* 读不到按 0 */ }
        info.files.set(p, fileRecord(p, { status: 'new', badge: STATUS_LABEL.new, actual: true, additions: lines }));
      }
    }
  }

  // 代码面过滤：默认只留产品路径 + 文档显式登记的文件；--all 放开
  for (const [p, rec] of [...info.files]) {
    if (includeAll) continue;
    if (!inCodeScope(p) && !includeDocs) info.files.delete(p);
  }

  if (withDiff && info.files.size) {
    let budget = 220 * 1024;
    for (const [p, rec] of info.files) {
      if (rec.status === 'deleted' || budget <= 0) continue;
      let d = git(['diff', '--no-color', '--unified=2', base, '--', p], root) || '';
      if (!d && rec.status === 'new') {
        try {
          const body = fs.readFileSync(path.join(root, p), 'utf8');
          const lines = body.split(/\r?\n/).slice(0, maxDiffLines);
          d = [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((x) => '+' + x)].join('\n');
        } catch { d = ''; }
      }
      if (!d) continue;
      const arr = d.split(/\r?\n/);
      const clipped = arr.length > maxDiffLines;
      d = arr.slice(0, maxDiffLines).join('\n') + (clipped ? `\n… 已截断（原 ${arr.length} 行，用 git diff ${base} -- ${p} 查看完整）` : '');
      rec.diff = d;
      budget -= d.length;
    }
  }
  return info;
}

// ---------------- 数据流 ----------------
// 从 diff 新增行 + 步骤正文静态派生「数据对象 × 文件 × 架构层 × 步骤」：
// 定义模式识别对象（entity/dto/table）→ 「diff 新增行出现」关联文件、「正文出现 / 文件归属」关联步骤。
const DF_DEF_PATTERNS = [
  { re: /\b(?:class|record|interface|type)\s+([A-Z]\w{3,})/g, table: false }, // C#/TS 类型定义
  { re: /\bDbSet<([A-Z]\w{3,})>/g, table: false },
  { re: /\bToTable\(\s*["'`]?(\w{3,})/g, table: true },
  { re: /\bCREATE\s+TABLE\s+(?:\[?\w+\]?\s*\.\s*)?\[?(\w{3,})\]?/gi, table: true },
];
const DF_DTO_RE = /(Dto|Request|Response|Payload|ViewModel|Input|Result|Query)$/;
const DF_NOISE_RE = /(Controller|Service|Handler|Validator|Mapper|Profile|Extension|Configuration|Options|Settings|Exception|Middleware|Test|Tests|Fixture|Helper|Utility|Extensions|Constants|Enum|Client|Repository|Factory|Provider|Fetcher|Composer)$/;
const DF_NOISE_NAMES = new Set(['Program', 'App', 'Startup']);
const DF_MAX_OBJECTS = 12;

function dfKind(name, table) {
  if (DF_DTO_RE.test(name)) return 'dto';
  return table ? 'table' : 'entity';
}
// diff 里「+」开头的新增行（+++ 文件头不算）；删除行不参与出现判定
function dfAddedText(diff) {
  return String(diff || '').split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
}
function dfDefNames(text) {
  const out = new Set();
  for (const p of DF_DEF_PATTERNS) {
    for (const m of text.matchAll(p.re)) out.add(m[1]);
  }
  return out;
}

function deriveDataflow(files, steps) {
  const addedByPath = new Map(files.map((f) => [f.path, dfAddedText(f.diff)]));
  const defNamesByPath = new Map(files.map((f) => [f.path, dfDefNames(addedByPath.get(f.path))]));
  const stepBody = new Map(steps.map((s) => [s.id, [s.title, s.summary, ...s.detail].join('\n')]));

  // 1) 识别：定义模式扫 diff 新增行与步骤正文；噪音名丢弃（kind 后缀判定优先于来源）
  const kindByName = new Map();
  const scanDef = (text) => {
    for (const p of DF_DEF_PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        const name = m[1];
        if (DF_NOISE_RE.test(name) || DF_NOISE_NAMES.has(name)) continue;
        if (!kindByName.has(name)) kindByName.set(name, dfKind(name, p.table));
      }
    }
  };
  for (const f of files) scanDef(addedByPath.get(f.path));
  for (const s of steps) scanDef(stepBody.get(s.id));

  // 2) 关联：diff 新增行命中 → 文件（≥2 个才保留）；文件归属 / 正文命中 → 步骤（保步骤顺序）
  const candidates = [];
  for (const [name, kind] of kindByName) {
    const nameRe = new RegExp('\\b' + name + '\\b');
    const hitFiles = files.filter((f) => nameRe.test(addedByPath.get(f.path)));
    if (hitFiles.length < 2) continue;
    hitFiles.sort((a, b) => a.path.localeCompare(b.path));
    const layers = uniq(hitFiles.map((f) => f.layer).filter((l) => LAYER_BY_ID.has(l)))
      .sort((a, b) => LAYER_BY_ID.get(a).rank - LAYER_BY_ID.get(b).rank);
    const stepIds = [];
    for (const s of steps) {
      const viaFile = hitFiles.some((f) => f.steps.includes(s.id));
      if (viaFile || nameRe.test(stepBody.get(s.id))) stepIds.push(s.id);
    }
    // defStep：优先「diff 新增行命中定义模式」的第一个文件所属的首个步骤；都没有则取首个涉及步骤
    const defFile = hitFiles.find((f) => defNamesByPath.get(f.path).has(name));
    const defStep = defFile ? (defFile.steps[0] || '') : (stepIds[0] || '');
    candidates.push({ name, kind, files: hitFiles.map((f) => f.path), layers, steps: stepIds, defStep });
  }

  // 3) 截取：跨文件数降序、跨层数降序，最多 12 个
  candidates.sort((a, b) => b.files.length - a.files.length || b.layers.length - a.layers.length);
  const objects = candidates.slice(0, DF_MAX_OBJECTS);

  // 4) 传递边：defStep → 其余涉及步骤
  const flows = [];
  for (const o of objects) {
    if (!o.defStep) continue;
    for (const s of o.steps) {
      if (s === o.defStep) continue;
      flows.push({ object: o.name, from: o.defStep, to: s });
    }
  }
  return { objects, flows };
}

// ---------------- 依赖解析（`## 执行顺序` 子句 + 任务行内「依赖：」） ----------------
// 只收「声明的依赖边」：执行顺序箭头链本身由看板主链表达，不进 edges；
// 子句边在自身集合内做传递归约（A→B、B→C 都在时去掉 A→C），弧更少且不失真。
function deriveDeps(sections, steps) {
  const empty = { edges: [], source: '', unresolved: 0, unresolvedItems: [] };
  const docSteps = steps.filter((s) => s.source !== 'git' && s.source !== 'fallback');
  if (docSteps.length < 2) return empty;

  // 引用归一：裸数字（按 index）/ Tn / Sn / 标签 id → step.id
  const ref = new Map();
  const reg = (k, id) => { if (k && !ref.has(k)) ref.set(k, id); };
  for (const s of docSteps) {
    reg(String(s.index), s.id);
    reg(String(s.id).toLowerCase(), s.id);
    reg(String(s.id).replace(/^[A-Za-z]+/, ''), s.id);
  }
  const resolveRef = (tok) => {
    const t = String(tok || '').trim().replace(/^[（(\s]+|[)）\s，。；、,;.：:]+$/g, '');
    if (!t) return '';
    return ref.get(t) || ref.get(t.toLowerCase()) || ref.get(t.replace(/^[A-Za-z]+/, '')) || '';
  };
  // token 展开：4/5/6、4~7、T2、全部（= allIds）
  const expand = (expr, allIds) => {
    const e = String(expr || '').replace(/（[^）]*）|\([^)]*\)/g, '');
    const out = [];
    for (const raw of e.split(/[\/、,，\s]+|与|和/g)) {
      const p = raw.trim();
      if (!p || /^(?:依赖|独立|先于|必须|见|UI|ui)$/.test(p)) continue;
      if (/^全部|^所有/.test(p)) { out.push(...allIds); continue; }
      const rm = p.match(/^([A-Za-z]{0,4})(\d+)[~\-—–][A-Za-z]{0,4}(\d+)$/);
      if (rm) {
        for (let i = +rm[2]; i <= +rm[3]; i++) { const id = resolveRef(rm[1] + i); if (id) out.push(id); }
        continue;
      }
      const id = resolveRef(p);
      if (id) out.push(id);
    }
    return [...new Set(out)];
  };

  const edges = new Map();
  const addEdge = (from, to) => { if (from && to && from !== to) edges.set(from + '>' + to, { from, to }); };
  let unresolved = 0;
  const unresolvedItems = []; // 2026-11-10：unresolved 计数保留，另留 {line,title} 定位（parseHealth.issues 消费）
  let source = '';
  const noteUnresolved = (line, title) => {
    unresolved++;
    unresolvedItems.push({ line: line || 0, title: String(title || '').trim() });
  };

  const parseClauses = (text, lhsFixed, lineNo) => {
    for (const clause of String(text || '').split(/[；;]/)) {
      const c = clause.trim();
      if (!c) continue;
      const m = c.match(/^(.+?)\s*依赖\s*(.+)$/);
      if (!m) {
        // 「T5 先于 T7/T8」= T5 是被依赖方（ prose 先于不可解析时静默跳过，不计 unresolved）
        const m2 = c.match(/^(.+?)\s*(?:必须|须)?先于\s*(.+)$/);
        if (!m2) continue; // 「9 独立」等无边子句
        const lhs = expand(m2[1], []);
        const rhs = expand(m2[2], []);
        for (const b of rhs) for (const a of lhs) addEdge(a, b);
        continue;
      }
      const lhs = lhsFixed ? [lhsFixed] : expand(m[1], []);
      // 「依赖全部」= 依赖 LHS 之前的全部步骤（按 index，排除自身与后至步骤）
      const lhsMin = Math.min(...lhs.map((id) => (docSteps.find((s) => s.id === id) || {}).index || Infinity));
      const rhs = expand(m[2], docSteps.filter((s) => !lhs.includes(s.id) && s.index < lhsMin).map((s) => s.id));
      if (!lhs.length || !rhs.length) { noteUnresolved(lineNo, c); continue; }
      for (const b of rhs) for (const a of lhs) addEdge(b, a);
    }
  };

  // a) `## 执行顺序` 节里的「依赖：」行 / 含依赖子句的括注行（箭头链不产边）
  const orderSec = sectionByTitle(sections, ['执行顺序', '实施顺序']);
  if (orderSec) {
    for (const [j, rawLine] of orderSec.body.split(/\r?\n/).entries()) {
      const line = rawLine.trim().replace(/^[-*>\s]+/, '');
      // 箭头链行（含批注里的「依赖」字样）不产子句边——链本身由看板主链表达
      if (!line || line.includes('→') || line.includes('->') || !line.includes('依赖')) continue;
      if (!source) source = 'exec-order';
      parseClauses(line.replace(/^(?:执行)?依赖\s*[：:]\s*/, ''), false, orderSec.start + orderSec.lead + j + 2);
    }
  }
  // b) 任务行内 `- 依赖：T1、T2`（= 本步骤依赖列出的前序）
  for (const s of docSteps) {
    (s.detail || []).forEach((d, i) => {
      const m = String(d).match(/^-?\s*依赖\s*[：:]\s*(.+)$/);
      if (!m) return;
      if (!source) source = 'task-rows';
      const rhs = expand(m[1], []);
      if (!rhs.length) { noteUnresolved((s.detailPos || [])[i] || s.line, d); return; }
      for (const b of rhs) addEdge(b, s.id);
    });
  }
  if (!edges.size) return { edges: [], source, unresolved, unresolvedItems };

  // 传递归约（仅在声明边集合内）：去掉可被其他声明路径推出的边
  const adj = new Map();
  for (const e of edges.values()) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const reduced = [];
  for (const e of edges.values()) {
    const seen = new Set([e.from]);
    const stack = [e.from];
    let reachable = false;
    while (stack.length && !reachable) {
      const cur = stack.pop();
      for (const nxt of adj.get(cur) || []) {
        if (cur === e.from && nxt === e.to) continue; // 跳过被检边本身
        if (nxt === e.to) { reachable = true; break; }
        if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
      }
    }
    if (!reachable) reduced.push(e);
  }
  return { edges: reduced, source, unresolved, unresolvedItems };
}

// 验证证据（2026-11-10）：本机台账 .agents/verifications.jsonl 优先，
// 仓库凭证 workflow/verify-evidence.md 兜底合并（ts+head 去重）。
// 时间窗 = 文档日期起——关联语义是「任务时间窗内的验证凭证」，非逐条绑定。
function collectEvidence(root, windowStart) {
  const rows = [];
  const seen = new Set();
  const push = (r) => {
    const key = r.ts + '|' + (r.headShort || '');
    if (!r.ts || seen.has(key)) return;
    seen.add(key);
    rows.push(r);
  };
  try {
    const p = path.join(root, '.agents', 'verifications.jsonl');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          push({
            ts: j.ts, suite: j.suite || '', gates: j.gates ?? null, exitCode: j.exitCode ?? null,
            headShort: j.headShort || '', skipped: (j.scope && j.scope.skipped) || [],
            envSkips: j.envSkips || [], source: 'ledger',
          });
        } catch { /* 坏行跳过 */ }
      }
    }
  } catch { /* 台账读不动不影响主模型 */ }
  try {
    const p = path.join(root, 'workflow', 'verify-evidence.md');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\|\s*`([0-9a-f]+)`\s*\|\s*([\dT:.Z+-]+)\s*\|\s*(\d+)\s*\|/);
        if (m) push({ ts: m[2], suite: 'all-gates', gates: +m[3], exitCode: 0, headShort: m[1], skipped: [], envSkips: [], source: 'evidence' });
      }
    }
  } catch { /* 凭证读不动不影响主模型 */ }
  const w0 = windowStart ? Date.parse(windowStart) : NaN;
  const inWindow = isNaN(w0) ? rows : rows.filter((r) => Date.parse(r.ts) >= w0);
  inWindow.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return { windowStart: windowStart || '', rows: inWindow.slice(0, 10), totalInWindow: inWindow.length };
}

// ---------------- 组装模型 ----------------
// 测试缝合（2026-11-10）：把注入 payload 归一成 collectGit 返回形状（files 条目缺省走 fileRecord）。
// 仅供 .agents/tests/dev-tour-model.test.mjs 注入确定性 git 面；buildTour 不传 opts.git 时
// 仍走原 collectGit 路径，行为不变。
function injectGitInfo(g = {}) {
  const files = new Map();
  const src = g.files instanceof Map ? g.files : Object.entries(g.files || {});
  for (const [p, v] of src) files.set(normPath(p), fileRecord(p, v || {}));
  return {
    available: g.available !== false, base: g.base || 'HEAD',
    files, basePaths: new Set(g.basePaths || []),
    note: g.note || '', baseSha: g.baseSha || '',
  };
}

export function buildTour(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const docAbs = path.isAbsolute(opts.docPath) ? opts.docPath : path.join(root, opts.docPath);
  const docPath = rel(root, docAbs);
  if (!fs.existsSync(docAbs)) throw new Error(`文档不存在：${docPath}`);
  const text = fs.readFileSync(docAbs, 'utf8');
  const fm = parseFrontmatter(text);
  const sections = parseSections(text);
  const title = (extractTitle(text) || path.basename(docPath, '.md'))
    .replace(/^\d{4}-\d{2}-\d{2}[-—–\s]+/, '')
    .trim() || path.basename(docPath, '.md');
  const typeKey = docPath.split('/')[1] || '';
  const type = TYPE_LABEL[typeKey] || 'DOC';

  // 仓库跟踪索引提前建好（30s 缓存）：步骤标题/正文/表格行的未反引号中段路径需按真实文件消解采集
  const repo = trackedIndex(root);

  // 1) 步骤：步骤 → 任务拆解 → h3 子标题 → 改动块 → 文件分组
  let steps = [];
  const secTasks = sectionByTitle(sections, ['任务拆解', '任务清单', 'TODO', '待办', '步骤', '实施步骤', '执行步骤']);
  if (secTasks) steps = /-\s*\[[ xX]\]/.test(secTasks.body) ? stepsFromTaskSection(secTasks) : stepsFromNumberedSection(secTasks);

  const changeSec = sectionByTitle(sections, ['改动方案', '改动面', '系统改动清单', '系统改动', '改动清单', '涉及文件', '改动文件', '文件清单']);
  const changeChildren = changeSec ? childSections(sections, changeSec) : [];
  let blocks = changeSec ? blocksFromChangeSection(changeSec, changeChildren.length === 0) : [];
  // h3 批次子节的表格行：块解析只扫 `##` 节自身正文，够不到 `###` 子节——表格路径归入批次块，
  // 与任务号/批次标签交集命中；无表格行的子节不产块（避免与标题步骤重复归集）
  for (const csec of changeChildren) {
    const rows = csec.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\|/.test(l) && !/^\|[\s:|-]+\|?$/.test(l));
    if (!rows.length) continue;
    const lb = labelOf(csec.title);
    blocks.push({ id: lb.id, title: lb.title || csec.title, raw: csec.title, lines: rows, line: csec.start + 1 });
  }
  // h3 子标题当步骤（若尚未拿到）：改动方案的 `### 批次` / 任务拆解的 `### T1 · 标题`
  // （parseSections 把 h3 切成独立节、父节 body 为空，故从 childSections 取）
  if (!steps.length) {
    const h3Parent = secTasks && childSections(sections, secTasks).length ? secTasks : changeSec;
    const h3 = h3Parent ? childSections(sections, h3Parent) : [];
    if (h3.length) {
      steps = h3.map((s, i) => {
        const lb = labelOf(s.title);
        return newStep({
          id: lb.id || `S${i + 1}`, title: lb.title || s.title,
          summary: firstLine(s.body.replace(/[`*_#>]/g, '')).slice(0, 160),
          detail: s.body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 8),
          source: 'headings',
        });
      });
    }
  }

  // 步骤还没有文件：从改动方案块按标签合并
  for (const st of steps) {
    const matches = blocks.filter((b) => blockMatchesStep(b, st));
    for (const b of matches) {
      for (const line of b.lines) {
        st.detail.push(line);
        for (const p of extractPaths(line, repo)) if (!st.files.includes(p)) st.files.push(p);
      }
    }
  }

  // 未被步骤认领的块 → 新步骤；完全无步骤 → 按块/文件生成
  const usedBlocks = new Set();
  for (const st of steps) {
    for (const b of blocks) {
      if (blockMatchesStep(b, st)) usedBlocks.add(b);
    }
  }
  const orphan = [];
  const hadSteps = steps.length > 0;
  for (const b of blocks) {
    if (usedBlocks.has(b)) continue;
    const files = uniq(b.lines.flatMap((l) => extractPaths(l, repo)));
    if (!b.id && !files.length) continue;
    if (hadSteps) { orphan.push(b); continue; }
    const st = newStep({
      id: b.id || `S${steps.length + 1}`,
      title: b.title || (files.length === 1 ? files[0].split('/').pop() : `改动块 ${steps.length + 1}`),
      summary: firstLine(b.lines.join('\n')).slice(0, 160),
      detail: b.lines.slice(0, 12),
      files,
      source: 'blocks',
      line: b.line || 0,
    });
    steps.push(st);
  }
  if (steps.length && orphan.length) {
    const files = uniq(orphan.flatMap((b) => b.lines.flatMap((l) => extractPaths(l, repo))));
    steps.push(newStep({
      id: 'A', title: '改动面（未分步）',
      summary: '任务拆解未覆盖的文件清单，按文档原样归集',
      detail: orphan.flatMap((b) => b.lines).slice(0, 20),
      files, source: 'blocks',
    }));
  }

  if (!steps.length) {
    // 最后兜底：按文件所属架构层分组，避免 100 个文件 100 个站
    const all = extractPaths(text).filter((p) => !isDocPath(p) || p.startsWith(docPath.split('/')[0] + '/'));
    const groups = new Map();
    for (const p of all) {
      const layer = inferLayer(p);
      if (!groups.has(layer)) groups.set(layer, []);
      groups.get(layer).push(p);
    }
    for (const [layer, files] of groups) {
      steps.push(newStep({
        id: `S${steps.length + 1}`,
        title: LAYER_BY_ID.get(layer)?.label || '改动',
        summary: `${files.length} 个文件`,
        files,
        source: 'layers',
      }));
    }
  }

  // 步骤无文件：从正文路径补；仍无则保留（时序图按文字推断层）
  for (const st of steps) {
    if (!st.files.length) {
      const body = [st.title, st.summary, ...st.detail].join('\n');
      st.files = extractPaths(body, repo);
    }
  }

  // 2) 文档引用路径（计划面）
  const allDocPaths = extractPaths(text);
  const changePaths = changeSec ? blocks.flatMap((b) => b.lines.flatMap((l) => extractPaths(l))) : [];
  const docPaths = uniq(allDocPaths.filter((p) => {
    if (p === docPath) return false;
    if (!CODE_EXT.test(p)) return false; // 目录/项目名只做步骤锚点，不进文件树
    if (inCodeScope(p)) return true;
    if (changePaths.includes(p)) return true;
    // 文档/台账只在显式出现在改动方案里时纳入，避免把检索命令、模板路径当改动
    return false;
  }));

  // 3) git 实际面（测试缝合：opts.git 提供时跳过 collectGit，直接用注入的 collectGit 同形状 payload）
  const gitInfo = opts.git ? injectGitInfo(opts.git) : collectGit({
    root, base: opts.base || 'HEAD', includeAll: !!opts.includeAll,
    includeDocs: !!opts.includeDocs, withDiff: opts.withDiff !== false,
    maxDiffLines: opts.maxDiffLines || 160,
  });
  const docMeta = { title, module: fm['模块'] || '' };

  // 验证计划里的测试文件补到「测试/验证」步骤：步骤正文常只写判据，测试路径在验证计划里
  const verifySecEarly = sectionByTitle(sections, ['验证计划', '测试计划']);
  if (verifySecEarly) {
    const testPaths = extractPaths(verifySecEarly.body).filter((p) => /(^|\/)tests?\//.test(p) || /\.(test|spec)\.[tj]sx?$/i.test(p));
    const testStep = steps.find((s) => /测试|验证|Test/i.test(s.title));
    if (testStep) {
      for (const p of testPaths) if (!testStep.files.includes(p)) testStep.files.push(p);
      if (testPaths.length && !testStep.summary) testStep.summary = `${testPaths.length} 个测试文件 / 验证命令`;
    }
  }

  const universe = new Set([...docPaths, ...gitInfo.files.keys()]);
  const files = new Map();
  const docContext = contextTokens(docMeta);
  for (const p of docPaths) {
    const rp = resolvePath(p, universe, repo, docContext);
    if (!files.has(rp)) files.set(rp, fileRecord(rp, { planned: true, layer: inferLayer(rp) }));
  }
  for (const [p, rec] of gitInfo.files) {
    const rp = resolvePath(p, universe, repo, docContext);
    const prev = files.get(rp);
    if (prev) Object.assign(prev, rec, { planned: prev.planned, path: rp });
    else files.set(rp, fileRecord(rp, { ...rec, path: rp }));
  }

  // 计划面文件若在 git 实际面里存在但状态 planned，补状态
  for (const rec of files.values()) {
    rec.test = rec.layer === 'test' || /(^|\/)tests?\//.test(rec.path) || /\.(test|spec)\.[tj]sx?$/i.test(rec.path);
    if (rec.actual) rec.badge = STATUS_LABEL[rec.status] || '修改';
    else if (rec.planned) rec.badge = '计划';
  }

  // 4) 步骤 ↔ 文件双向绑定
  const stepFiles = new Map(steps.map((s) => [s.id, new Set()]));
  const resolvedAway = new Set();
  const guessed = []; // 路径猜测（多候选打分）→ parseHealth.pathGuesses；basename 唯一命中不算
  for (const st of steps) {
    const ctx = contextTokens(docMeta, st);
    const anchors = extractPaths([st.summary, ...st.detail].join('\n'))
      .filter((a) => !CODE_EXT.test(a));
    for (const raw of st.files) {
      const rawGuesses = [];
      let rp = resolvePath(raw, universe, repo, ctx, rawGuesses);
      // 裸文件名（ItemCatalogPushService.cs）若仓库里只有一个同名文件，优先落到本步骤其他文件的共同目录
      if (!raw.includes('/') && (repo.byBase.get(raw) || []).length === 1) {
        const dirs = st.files.filter((x) => x !== raw).map((x) => x.split('/').slice(0, -1).join('/')).filter(Boolean);
        const freq = new Map();
        for (const d of dirs) freq.set(d, (freq.get(d) || 0) + 1);
        const dom = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (dom && !repo.set.has(dom + '/' + raw) && !files.has(dom + '/' + raw)) {
          rp = resolvePath(dom + '/' + raw, universe, repo, ctx);
          if (rp === dom + '/' + raw && CODE_EXT.test(raw)) rp = dom + '/' + raw;
        }
      }
      // 相对新文件（如 ItemCatalog/ItemOptions.cs）落在步骤正文声明的项目目录下：
      // 仅当拼接结果确实是仓库真实文件才生效；raw 本身已 tracked（rp===raw 即真实命中）不二次拼接，
      // 否则产生 wiki/.../wiki/.../00-preflight.sql 型翻倍伪路径与跨目录冒名拼接
      if (rp === raw && !repo.set.has(raw) && !raw.startsWith('.') && !CODE_ROOTS.some((r) => raw.startsWith(r))) {
        for (const a of anchors) {
          const cand = a.replace(/\/$/, '') + '/' + raw;
          if (repo.set.has(cand)) { rp = cand; break; }
        }
      }
      const rec = files.get(rp) || (gitInfo.files.has(rp) ? files.get(rp) : null);
      if (rec) {
        rec.steps.push(st.id);
        stepFiles.get(st.id).add(rp);
        // 同一文件先以相对路径进了计划面，这里解析到真实路径：删掉无主的相对重复项
        if (rp !== raw) {
          resolvedAway.add(raw);
          const old = files.get(raw);
          if (old && old.planned && !old.actual && !old.steps.length) files.delete(raw);
        }
        if (rawGuesses.length) {
          rec.pathGuess = true;
          guessed.push({ path: rp, step: st.id, candidates: rawGuesses[rawGuesses.length - 1].candidates });
        }
      } else if (CODE_EXT.test(rp) || repo.set.has(rp)) {
        const r = fileRecord(rp, { planned: true, layer: inferLayer(rp) });
        r.steps.push(st.id);
        files.set(rp, r);
        stepFiles.get(st.id).add(rp);
        if (rawGuesses.length) {
          r.pathGuess = true;
          guessed.push({ path: rp, step: st.id, candidates: rawGuesses[rawGuesses.length - 1].candidates });
        }
      }
    }
    st.files = [...stepFiles.get(st.id)];
  }
  // 相对路径已解析到真实文件：清理无主的原样重复项（否则会出现在「未分步文件」里）
  for (const raw of resolvedAway) {
    const old = files.get(raw);
    if (old && old.planned && !old.actual) {
      for (const set of stepFiles.values()) set.delete(raw);
      files.delete(raw);
    }
  }
  // 全局清理：文档里以相对路径出现、但步骤已解析到真实文件的重复项
  const resolvedSet = new Set([...stepFiles.values()].flatMap((set) => [...set]));
  for (const [p, rec] of [...files]) {
    if (rec.actual || rec.steps.length || resolvedSet.has(p) || !rec.planned) continue;
    const base = p.split('/').pop();
    const twin = [...resolvedSet].find((x) => x.endsWith('/' + p)) ||
      ([...resolvedSet].filter((x) => x.endsWith('/' + base)).length === 1 ? [...resolvedSet].find((x) => x.endsWith('/' + base)) : null);
    if (twin) files.delete(p);
  }
  // 测试文件优先归到「测试/验证」步骤（验证计划里的路径常只到测试项目目录）
  const testStep = steps.find((x) => /测试|验证|Test/i.test(x.title));
  if (testStep) {
    for (const rec of files.values()) {
      if (rec.test && !rec.steps.length) {
        rec.steps.push(testStep.id);
        stepFiles.get(testStep.id).add(rec.path);
        if (!testStep.files.includes(rec.path)) testStep.files.push(rec.path);
      }
    }
  }
  // 未绑定步骤的文件：按 basename / 层词 尝试匹配步骤正文。两臂都是启发式 → 打 pathGuess 标（猜测可见）。
  // basename 臂：正文提到文件名即绑第一个命中（既有语义不动）。
  // 层词臂：仅当恰一个步骤正文含该层 label 才绑；0 个或 ≥2 个都不绑，留「未分步」可见——
  //   静默挂到第一个命中步骤（旧行为）比不绑更难发现，故收紧为恰一。
  for (const rec of files.values()) {
    if (rec.steps.length) continue;
    const base = rec.path.split('/').pop();
    const byBase = steps.find((s) => [s.title, s.summary, ...s.detail].join(' ').includes(base));
    let hit = byBase;
    if (!hit && rec.layer !== 'other') {
      const label = LAYER_BY_ID.get(rec.layer)?.label || '';
      const hits = label ? steps.filter((s) => [s.title, s.summary, ...s.detail].join(' ').includes(label)) : [];
      if (hits.length === 1) hit = hits[0];
    }
    if (hit) {
      rec.steps.push(hit.id);
      stepFiles.get(hit.id).add(rec.path);
      rec.pathGuess = true;
      guessed.push({ path: rec.path, step: hit.id, candidates: 1 });
    }
  }
  // 仍未绑定：进入「未分步」步骤；有实际改动但文档没提：进入「文档外改动」
  const unassigned = [...files.values()].filter((f) => !f.steps.length);
  const undocumented = unassigned.filter((f) => f.actual);
  const rest = unassigned.filter((f) => !f.actual);
  if (undocumented.length) {
    const st = newStep({
      id: 'X', title: '文档外实际改动', summary: 'git 工作树里有、plan 改动面未登记——优先核对 scope',
      detail: ['这些文件不在文档改动清单内，可能是范围漂移，也可能是文档该回填。'],
      files: undocumented.map((f) => f.path), source: 'git', status: 'warn',
    });
    steps.push(st);
    for (const f of undocumented) { f.steps.push(st.id); stepFiles.set(st.id, (stepFiles.get(st.id) || new Set()).add(f.path)); }
  }
  if (rest.length) {
    const st = newStep({
      id: 'U', title: '未分步文件', summary: '文档提到了，但无法归入具体步骤',
      files: rest.map((f) => f.path), source: 'fallback',
    });
    steps.push(st);
    for (const f of rest) { f.steps.push(st.id); stepFiles.set(st.id, (stepFiles.get(st.id) || new Set()).add(f.path)); }
  }

  for (const st of steps) st.files = uniq([...(stepFiles.get(st.id) || [])]);
  steps = steps.map((s, i) => ({ ...s, index: i + 1, files: uniq(s.files) }));

  // 解析健康度（2026-11-09）：直认（steps/tasks/headings = 标题约定命中）vs 兜底
  // （blocks/layers/fallback 归集）——文档标题跑偏时静默降级的可观测面；
  // gen-dev-tour --strict 与模板警告条消费本字段。git 步（文档外实际改动）是实际面
  // 对账产物，不计入文档解析分母。
  const DIRECT_SOURCES = new Set(['steps', 'tasks', 'headings']);
  const parseSrc = steps.filter((s) => s.source !== 'git');
  const bySource = {};
  for (const s of parseSrc) bySource[s.source] = (bySource[s.source] || 0) + 1;
  const guessSeen = new Set();
  const guessItems = [];
  for (const g of guessed) {
    const k = g.path + '>' + g.step;
    if (guessSeen.has(k)) continue;
    guessSeen.add(k);
    guessItems.push(g);
  }
  const parseHealth = {
    total: parseSrc.length,
    direct: parseSrc.filter((s) => DIRECT_SOURCES.has(s.source)).length,
    bySource,
    zeroFileSteps: parseSrc.filter((s) => !s.files.length).length,
    layersFallback: !parseSrc.some((s) => DIRECT_SOURCES.has(s.source)) && parseSrc.some((s) => s.source === 'layers'),
    hitRate: 0,
    pathGuesses: { total: guessItems.length, items: guessItems },
  };
  parseHealth.hitRate = parseHealth.total ? parseHealth.direct / parseHealth.total : 0;

  // 5) 统计（产品面为主，文档/工具另计）
  const fileArr = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const isProduct = (f) => inCodeScope(f.path) || f.layer === 'test' || (!isDocPath(f.path) && ['frontend', 'api', 'app', 'domain', 'infra', 'db', 'test'].includes(f.layer));
  const product = fileArr.filter(isProduct);
  const stat = (arr, k) => arr.filter((f) => f.status === k).length;
  const stats = {
    files: product.length,
    new: stat(product, 'new'),
    modified: stat(product, 'modified'),
    deleted: stat(product, 'deleted'),
    renamed: stat(product, 'renamed'),
    planned: product.filter((f) => f.planned && !f.actual).length,
    tests: product.filter((f) => f.test).length,
    additions: product.reduce((n, f) => n + (f.additions || 0), 0),
    deletions: product.reduce((n, f) => n + (f.deletions || 0), 0),
    docs: fileArr.length - product.length,
    steps: steps.length,
  };

  // 6) 时序图：每步文件层 → 箭头
  const participants = LAYERS.filter((l) => fileArr.some((f) => f.layer === l.id) || steps.some((s) => inferLayersFromText(s.title + ' ' + s.summary).includes(l.id)))
    .filter((l) => l.id !== 'doc' && l.id !== 'other' || fileArr.some((f) => f.layer === l.id));
  const messages = [];
  for (const st of steps) {
    let layers = uniq(st.files.map((p) => files.get(p)?.layer || inferLayer(p)));
    if (!layers.length) layers = inferLayersFromText(st.title + ' ' + st.summary + ' ' + st.detail.join(' '));
    layers = layers.filter((l) => LAYER_BY_ID.has(l) && l !== 'doc' && l !== 'other').sort((a, b) => LAYER_BY_ID.get(a).rank - LAYER_BY_ID.get(b).rank);
    if (!layers.length) layers = ['app'];
    if (layers.length === 1) {
      messages.push({ stepId: st.id, from: layers[0], to: layers[0], label: clamp(st.title, 26), self: true });
    } else {
      for (let i = 0; i < layers.length - 1; i++) {
        messages.push({ stepId: st.id, from: layers[i], to: layers[i + 1], label: clamp(st.title, 26) });
      }
    }
    if (layers.includes('test') && layers.length > 1 && layers[0] !== 'test') {
      messages.push({ stepId: st.id, from: 'test', to: layers[0], label: '验证 ' + clamp(st.title, 20), dashed: true });
    }
  }

  // 6b) 数据流：数据对象 × 文件 × 架构层 × 步骤（从 diff 新增行 + 步骤正文静态派生）
  const dataflow = deriveDataflow(fileArr, steps);

  // 7) 验证计划（流程图末端门）
  const verifySec = sectionByTitle(sections, ['验证计划', '测试计划']);
  const gates = verifySec ? verifySec.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^-\s+/.test(l)).slice(0, 6).map((l) => l.replace(/^-\s+/, '')) : [];

  // 7b) 声明依赖边（执行顺序「依赖：」子句 / 任务行内依赖；流程图旁路弧数据源）
  const deps = deriveDeps(sections, steps);

  // 解析失约定位（2026-11-10）：issues 从总数下钻到行——advisory，不参与 --strict 拒产判定。
  const issues = [];
  for (const st of parseSrc) {
    if (!st.files.length) issues.push({ line: st.line || 0, title: st.title, kind: 'step-no-files' });
  }
  for (const b of orphan) {
    issues.push({ line: b.line || 0, title: b.raw || b.title, kind: 'block-unmatched' });
  }
  for (const u of deps.unresolvedItems || []) {
    issues.push({ line: u.line, title: u.title, kind: 'dep-unresolved' });
  }
  if (parseHealth.layersFallback) {
    issues.push({ line: 1, title: '未发现结构化步骤标题（## 步骤 / ## 任务拆解 / ### 批次 N）', kind: 'layers-fallback' });
  }
  issues.sort((a, b) => a.line - b.line);
  parseHealth.issues = issues;

  // 8) 关联文档
  const links = [];
  // 2026-11-11：`对应入口/spec` 允许中间空格；`../intents|specs/*.md` 是相对链接，
  // 不在 extractPaths 的仓库根白名单内，需单独兜底，否则「需求」tab 永远不出现。
  for (const m of text.matchAll(/对应\s*(?:入口|spec|规范|事故)[：:]\s*(.+)/gi)) {
    const line = m[1].trim();
    for (const p of extractPaths(line)) {
      if (!links.some((l) => l.path === p)) links.push({ label: p.split('/').pop(), path: p });
    }
    const raw = normPath(line.replace(/^[`'"“”‘’(（\s]+|[`'"“”‘’(）)\s]+$/g, '').split(/[\s，。；,;]+/)[0]);
    if (/\.md$/i.test(raw) && !links.some((l) => l.path === raw)) {
      links.push({ label: raw.split('/').pop(), path: raw });
    }
  }

  const purpose = (() => {
    const entry = sectionByTitle(sections, ['入口']);
    const m = entry && entry.body.match(/目标[：:]\s*(.+)/);
    if (m) return m[1].trim();
    const behavior = sectionByTitle(sections, ['功能行为']);
    if (behavior) return firstLine(behavior.body.replace(/^[#>*\-\s]+/, ''));
    return '';
  })();

  // 9) 需求链路（2026-11-09）：跟随「对应入口/spec」链接读上游文档（一层，不递归），
  //    提取目标与行为/验收要点——看板「需求」视图数据源，补齐 why / what 叙事。
  const UP_SEC = { INTENT: ['目标', '背景', '需求'], SPEC: ['功能行为', '验收标准', '验收'], INCIDENT: ['现象', '影响', '根因'] };
  const upstreamType = (p) => (/\/intents?\//.test(p) ? 'INTENT' : /\/specs?\//.test(p) ? 'SPEC' : /\/incidents?\//.test(p) ? 'INCIDENT' : type);
  const upstream = [];
  for (const lk of links.slice(0, 3)) {
    if (!/\.md$/i.test(lk.path)) continue;
    let abs = path.resolve(path.dirname(docAbs), lk.path);
    if (!fs.existsSync(abs)) abs = path.resolve(root, lk.path);
    if (!fs.existsSync(abs)) continue;
    try {
      const upText = fs.readFileSync(abs, 'utf8');
      const upSecs = parseSections(upText);
      const ut = upstreamType(lk.path);
      const upPurpose = (() => {
        const entry = sectionByTitle(upSecs, ['入口']);
        const m = entry && entry.body.match(/目标[：:]\s*(.+)/);
        if (m) return m[1].trim();
        // SPEC 的「功能行为」正文常为空，真正的行为在 ### 子节里；用首个子节标题当一句话目标，
        // 避免 firstLine 落到「验收判据」表格头（| 判据 | 证据 | 状态 |）。
        if (ut === 'SPEC') {
          const behavior = sectionByTitle(upSecs, ['功能行为']);
          const kids = behavior ? childSections(upSecs, behavior) : [];
          if (kids.length) return clamp(kids[0].title, 120);
        }
        for (const name of UP_SEC[ut] || []) {
          const sec = sectionByTitle(upSecs, [name]);
          if (sec) {
            const line = firstLine(sec.body.replace(/^[#>*\-\s]+/, ''));
            if (line) return clamp(line, 120);
          }
        }
        return clamp(extractTitle(upText) || lk.label, 120);
      })();
      const points = [];
      if (ut === 'SPEC') {
        // 功能行为子节标题（S1/S2/…）比父节空正文更能说明“要做什么”
        const behavior = sectionByTitle(upSecs, ['功能行为']);
        const kids = behavior ? childSections(upSecs, behavior) : [];
        for (const k of kids) { if (points.length >= 5) break; points.push(k.title); }
        if (!points.length) {
          const acc = sectionByTitle(upSecs, ['验收判据', '验收标准', '验收']);
          for (const raw of String(acc && acc.body || '').split(/\r?\n/)) {
            const mm = raw.match(/^\|\s*([^|]+?)\s*\|/);
            const t = mm && mm[1].trim();
            if (t && !/^-+$/.test(t) && !/^(判据|证据|状态|锚)$/.test(t)) points.push(t);
            if (points.length >= 5) break;
          }
        }
      }
      if (!points.length) {
        for (const name of UP_SEC[ut] || ['功能行为', '目标']) {
          const sec = sectionByTitle(upSecs, [name]);
          if (!sec) continue;
          for (const raw of sec.body.split(/\r?\n/)) {
            const t = raw.trim();
            if (/^[-*\d]/.test(t) && t.length > 2) points.push(t.replace(/^[-*]\s*|^\d+[.、]\s*/, ''));
            if (points.length >= 5) break;
          }
          if (points.length) break;
        }
      }
      upstream.push({ path: rel(root, abs), type: ut, title: extractTitle(upText) || lk.label, purpose: upPurpose, points: points.filter((p) => !p.trim().startsWith(upPurpose.replace(/…$/, '').trim())).slice(0, 5) });
    } catch { /* 上游读不动不影响主模型 */ }
  }

  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    rootLabel: path.basename(root),
    doc: {
      path: docPath, type, title, status: fm['状态'] || '', level: fm['级别'] || '',
      module: fm['模块'] || '', date: fm['日期'] || '', purpose,
      links,
      upstream,
    },
    evidence: collectEvidence(root, fm['日期'] || ''),
    base: { ref: opts.base || 'HEAD', sha: gitInfo.baseSha || '', available: gitInfo.available, note: gitInfo.note || '' },
    stats,
    parseHealth,
    steps: steps.map((s) => ({
      id: s.id, index: s.index, title: s.title, summary: s.summary,
      detail: s.detail.slice(0, 30), files: s.files,
      status: s.status || 'todo', source: s.source,
    })),
    files: fileArr,
    sequence: { participants: participants.map((p) => ({ id: p.id, label: p.label })), messages },
    dataflow,
    deps,
    gates,
    note: gitInfo.available ? '' : (gitInfo.note || 'git 数据不可用，仅展示文档计划面'),
  };
}

export function renderModelJson(model) {
  return JSON.stringify(model, null, 2);
}
