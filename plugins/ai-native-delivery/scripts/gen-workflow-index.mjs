#!/usr/bin/env node
// workflow 活跃层索引生成器（2026-09-21，intent 2026-09-21-workflow-doc-retrieval）
// 用法：node .agents/scripts/gen-workflow-index.mjs [--dry-run] [--check] [--help]
//   --dry-run  只打印差异预览，不写盘
//   --check    不写盘；与磁盘不一致时 exit 1 并打印差异（供 check-loop 漂移告警）
// 测试：node .agents/scripts/gen-workflow-index.test.mjs（fixture 回归，须全绿）
// 口径：扫磁盘（对照 gen-wiki-board.mjs 与看板）；排除 _TEMPLATE.md。活跃 = draft / approved / open
//   逐行列出（在跑的工作）；其余状态折叠进「档案计数」——fixed 未 closed 的 incident 与 approved
//   孤儿 plan 属「待收口」，看板会告警；查档案用 kb-search（默认含全部状态）。
// 生成区：INDEX.md 的 GENERATED:BEGIN/END 锚点注释之间整段重写，锚点外内容原样保留。
import fs from 'node:fs';
import path from 'node:path';
import { ENUMS } from './workflow-enums.mjs';

const USAGE = `用法：node .agents/scripts/gen-workflow-index.mjs [--dry-run] [--check] [--help]

事实源：workflow/{intents,specs,plans,incidents}/*.md 的 frontmatter（状态/级别/日期/发现/模块）
        + H1 标题 + 「## 验收标准」勾验统计；排除 _TEMPLATE.md。
生成物：workflow/INDEX.md —— 活跃层逐行（类型|级别|状态|日期|模块|标题|验收）+ 档案计数（类型×模块）。
选项：
  --dry-run   只打印将生成内容的摘要与差异，不写盘
  --check     不写盘；INDEX 与磁盘不一致时 exit 1（供 check-loop 漂移告警）
  --help      打印本说明`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const unknown = args.filter((a) => !['--dry-run', '--check'].includes(a));
if (unknown.length) { console.error(`❌ 未知参数：${unknown.join(' ')}\n\n${USAGE}`); process.exit(1); }
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');

const WORKFLOW = 'workflow';
const INDEX_P = path.join(WORKFLOW, 'INDEX.md');
const DOC_TYPES = ['intents', 'specs', 'plans', 'incidents'];
const TYPE_LABEL = { intents: 'INTENT', specs: 'SPEC', plans: 'PLAN', incidents: 'INCIDENT' };
// 活跃口径 = 单源 doc.status.active ∪ incident.status.active；其余状态折叠进档案计数
const ACTIVE_STATUS = [...ENUMS['doc.status.active'], ...ENUMS['incident.status.active']];

const BEGIN = '<!-- GENERATED:BEGIN — gen-workflow-index.mjs 整段重写，手工说明写在本行之前 -->';
const END = '<!-- GENERATED:END -->';
const HEADER = `# workflow 索引 — 活跃层与档案（生成物，勿手改）

> 生成器 \`node .agents/scripts/gen-workflow-index.mjs\`（状态变更 / 新建文档后重跑；\`--check\` 校验漂移，check-loop 会告警）。
> 活跃 = ${ACTIVE_STATUS.join(' / ')}（在跑）；其余状态折叠进档案计数，检索用 \`node .agents/scripts/kb-search.mjs "<词>"\`（默认含全部状态、活跃优先排序）。
> 模块词表见 \`.agents/config/workflow-modules.txt\`。
`;

// ---- frontmatter（受限子集：每行 `键: 值`）+ H1 标题（去「INTENT — 」前缀），对照 workflow/README.md 文档协议 ----
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

// ---- 验收勾验统计：仅「## 验收标准」节内（至下一个 ## 标题），无该节返回 null（对照看板口径）----
function parseAcceptance(text) {
  const h = text.match(/^## 验收标准.*$/m);
  if (!h) return null;
  const rest = text.slice(h.index + h[0].length);
  const next = rest.match(/^## /m);
  const section = next ? rest.slice(0, next.index) : rest;
  const total = (section.match(/^\s*[-*] \[[ xX]\]/gm) || []).length;
  if (!total) return null;
  const done = (section.match(/^\s*[-*] \[[xX]\]/gm) || []).length;
  return { done, total };
}

const esc = (s) => String(s).replace(/\|/g, '\\|'); // 表格单元格内管道转义

function scan() {
  const docs = [];
  for (const type of DOC_TYPES) {
    const dir = path.join(WORKFLOW, type);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const name = f.slice(0, -3);
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const { meta, title } = parseDoc(text);
      docs.push({
        type,
        file: `${type}/${f}`,
        status: meta['状态'] || '（未填）',
        level: meta['级别'] || '—',
        date: meta['日期'] || meta['发现'] || name.slice(0, 10),
        module: meta['模块'] || '—',
        title: title || name,
        accept: parseAcceptance(text),
      });
    }
  }
  return docs;
}

function render(docs) {
  const active = docs.filter((d) => ACTIVE_STATUS.includes(d.status));
  active.sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type) || a.file.localeCompare(b.file));
  const arch = docs.filter((d) => !ACTIVE_STATUS.includes(d.status));

  const rows = active.map((d) =>
    `| ${TYPE_LABEL[d.type]} | ${esc(d.level)} | ${esc(d.status)} | ${esc(d.date)} | ${esc(d.module)} | ${esc(d.title)} | ${d.accept ? `☑${d.accept.done}/${d.accept.total}` : '—'} |`);

  const counts = new Map(); // `${type}|${module}` → 数量
  for (const d of arch) {
    const k = `${d.type}|${d.module}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const archRows = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => {
    const [type, module] = k.split('|');
    return `| ${TYPE_LABEL[type]} | ${esc(module)} | ${n} |`;
  });
  const byStatus = new Map();
  for (const d of arch) byStatus.set(d.status, (byStatus.get(d.status) || 0) + 1);
  const statusLine = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(' · ');

  return [
    `## 活跃（${active.length}）`,
    '',
    '| 类型 | 级别 | 状态 | 日期 | 模块 | 标题 | 验收 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `## 档案计数（${arch.length}，不进表）`,
    '',
    '| 类型 | 模块 | 数量 |',
    '|---|---|---|',
    ...archRows,
    '',
    `终态构成：${statusLine}；查档案用 \`node .agents/scripts/kb-search.mjs "<词>" --status all\`。`,
  ].join('\n');
}

// ---- 组装：锚点内整段重写，锚点外（含首次创建时的 HEADER）原样保留 ----
const docs = scan();
const existing = fs.existsSync(INDEX_P) ? fs.readFileSync(INDEX_P, 'utf8') : '';
const inner = `${BEGIN}\n\n${render(docs)}\n\n${END}`;
let out;
if (existing.includes(BEGIN) && existing.includes(END) && existing.indexOf(BEGIN) < existing.indexOf(END)) {
  out = existing.slice(0, existing.indexOf(BEGIN)) + inner + existing.slice(existing.indexOf(END) + END.length);
} else if (existing.includes(BEGIN) || existing.includes(END)) {
  // 锚点残缺（END 被手工截断 / 顺序颠倒）：fail-loud 不写盘——曾走 append 分支产生双 GENERATED 区，旧区永不清理（2026-09-24）
  console.error('❌ workflow/INDEX.md 生成锚点不完整（GENERATED:BEGIN/END 须成对且 BEGIN 在前）——手工修复锚点后重跑，未写盘');
  process.exit(1);
} else {
  out = (existing ? existing.replace(/\s*$/, '') + '\n\n' : HEADER) + inner + '\n';
}

const nActive = docs.filter((d) => ACTIVE_STATUS.includes(d.status)).length;
const nArch = docs.length - nActive;
const summary = `活跃 ${nActive} 行 / 档案 ${nArch} 篇 / ${Buffer.byteLength(out, 'utf8')} B`;

// 差异预览：首尾对齐后取中段变更块（逐行），各方向最多 10 行
function previewDiff(before, after) {
  if (before === after) return;
  const b = before.split(/\r?\n/);
  const a = after.split(/\r?\n/);
  let head = 0;
  while (head < b.length && head < a.length && b[head] === a[head]) head++;
  let tailN = 0;
  while (tailN < b.length - head && tailN < a.length - head && b[b.length - 1 - tailN] === a[a.length - 1 - tailN]) tailN++;
  const removed = b.slice(head, b.length - tailN);
  const added = a.slice(head, a.length - tailN);
  console.log(`  第 ${head + 1} 行起变更：删 ${removed.length} 行 / 增 ${added.length} 行`);
  for (const l of removed.slice(0, 10)) console.log(`    - ${l.slice(0, 140)}`);
  if (removed.length > 10) console.log(`    - …（其余 ${removed.length - 10} 行略）`);
  for (const l of added.slice(0, 10)) console.log(`    + ${l.slice(0, 140)}`);
  if (added.length > 10) console.log(`    + …（其余 ${added.length - 10} 行略）`);
}

// 行尾归一比较（2026-09-30：fresh clone 检出 CRLF、生成段恒 LF——直接字符串相等会在克隆环境假阳性
// 「漂移」（doctor §6 与 check-loop 检查 11 均经 --check 判定）；仅内容差异才算漂移）
const normEol = (s) => String(s).replace(/\r\n/g, '\n');

if (CHECK) {
  if (normEol(out) === normEol(existing)) {
    console.log(`✅ workflow/INDEX.md 与磁盘一致（${summary}）`);
    process.exit(0);
  }
  console.error(`❌ workflow/INDEX.md 与磁盘不一致（${summary}）——跑 node .agents/scripts/gen-workflow-index.mjs 重新生成`);
  previewDiff(existing, out);
  process.exit(1);
}

if (DRY) {
  console.log(`🔎 --dry-run：未写盘（${summary}）`);
  if (normEol(out) === normEol(existing)) console.log('• workflow/INDEX.md：无变化');
  else previewDiff(existing, out);
} else {
  fs.writeFileSync(INDEX_P, out, 'utf8');
  console.log(`✅ 已生成 workflow/INDEX.md：${summary}`);
}
