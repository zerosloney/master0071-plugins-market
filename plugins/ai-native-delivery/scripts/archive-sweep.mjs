#!/usr/bin/env node
// archive-sweep — workflow 终态件滚动归档（2026-10-09）
// **归档单位 = 同名家族**（intent/spec/plan/incident 同名文件同进同退）：check-loop 检查 1 的结构配对
//   是「家族双向在场」审计——intent 缺 spec/plan、spec/plan 缺 intent、incident 缺 plan/spec 均为
//   hard-block（首批执行 89 篇按单篇准入产生 57 处配对断裂的返工实证）。家族任一成员不满足条件
//   （非终态/未满窗/被活跃引用/无日期），整族留守。
// 终态时间三级锚（2026-10-13 修锚）：confirmations 终态行 ts（精确）→ **内容 last-touch**（回退）→ 文件名日期
// 回退级原用 git last-touch，被批量提交系统性污染：2026-09-13 frontmatter 迁移（223 文件）、
// 2026-09-28 两步式留痕补录（193+193 文件）把 ~386 篇老文档的 last-touch 刷成当日 → 21 天窗口
// 恒不满足，实测候选仅 5 篇（真实终态且零引用者 733 篇）。修法：回退级改「最后一次**正文**变更」
// ——frontmatter-only 提交（状态/确认指纹/备注行增删改）不计入，因其不改变文档的实质内容与
// 归档安全性（归档只依赖终态 + 无活跃引用，二者均由当前 frontmatter 与引用扫描独立判定）。
// 判定：逐提交比对 blob，剥 frontmatter 区后正文逐字节相同 → 视为 frontmatter-only，跳过。
// 归档形态：git mv → workflow/archive/<家族最晚终态月>/{类型}/（kit-engine 先例同款；check-loop docFiles
// 与配对门只扫四目录直下；kb-search 已扩 archive/<批次>/<type> 覆盖——同日返工中补齐）
// 用法：
// node <插件根>/scripts/archive-sweep.mjs # dry-run（缺省），--window 21
// node <插件根>/scripts/archive-sweep.mjs --window 21 --execute # git mv 执行
// 验证：node <插件根>/test/archive-sweep.test.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadAllConfirmations } from './ledger-loader.mjs';
import { projectRoot } from './paths.mjs';

const DIRS = ['intents', 'specs', 'plans', 'incidents'];
export const TERMINAL = new Set(['done', 'superseded', 'cancelled', 'closed']);
export const ACTIVE = new Set(['draft', 'approved', 'open', 'fixed']);

// isRealDate(s)：日历有效日期 YYYY-MM-DD（2026-02-30 / 2026-13-01 一律判无效）。
// 2026-10-27 路径逃逸修复：终态时间会派生归档目录名（workflow/archive/<月>/），
// 台账 ts 是外部可写数据——不校验时 `ts=../../../../evil` 会把归档目录甩出 workflow/ 树
// （实测 month 派生成 `../../.` → 归档落 C:\proj\specs）。
export function isRealDate(s) {
  const t = String(s ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === t;
}

// MONTH_RE：归档月目录名格式（由合法日期派生，故月份 01-12 恒成立）。
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseStatus(text) {
 const lines = text.split(/\r?\n/);
 const end = lines.indexOf('---', 1);
 for (let i = 1; i < (end === -1 ? Math.min(lines.length, 15) : end); i++) {
 const s = /^状态:\s*(\S+)/.exec(lines[i]);
 if (s) return s[1];
 }
 return '';
}

// bodyOf(text)：剥 frontmatter 区（首 --- 至闭合 ---）后的正文，CRLF 归一。
// 用途：判定一次提交是否只动了 frontmatter（状态/确认指纹/备注）——此类提交不改变文档实质内容，
// 不应刷新「内容 last-touch」（2026-10-13 修锚，见文件头注释）。无 frontmatter → 全文即正文。
export function bodyOf(text) {
 const norm = String(text).replace(/\r\n/g, '\n');
 const lines = norm.split('\n');
 if (!/^---\s*$/.test(lines[0] || '')) return norm;
 for (let i = 1; i < lines.length; i++) {
 if (/^---\s*$/.test(lines[i])) return lines.slice(i + 1).join('\n');
 }
 return norm; // 未闭合 → 保守视全文为正文（宁可刷新，不误判为 frontmatter-only）
}

// 纯函数：候选分析（fixture 测试直接驱动；docs 项 = { rel, file, dir, text }）
// 归档单位 = 同名家族：家族候选 ⇔ 全成员终态 + 全成员有终态时间且超窗 + 无成员被活跃引用
export function analyze({ docs, ledgerTs = {}, lastTouch = {}, activeTexts = [], windowDays = 21, today = Date.now() }) {
  const referenced = new Set();
  const fams = new Map();
  for (const d of docs) {
    if (d.file.startsWith('_TEMPLATE')) continue;
    if (!fams.has(d.file)) fams.set(d.file, []);
    fams.get(d.file).push(d);
  }
  for (const text of activeTexts) for (const file of fams.keys()) if (text.includes(file)) referenced.add(file);

  const active = [];
  const terminal = [];
  const candidates = [];
  const tooRecent = [];
  const noDate = [];
  for (const [, members] of fams) {
    const enriched = members.map((d) => {
      const st = parseStatus(d.text);
      // 终态时间三级锚（ts → 内容 last-touch → 文件名日期）**逐级取第一个日历有效值**：
      // 台账 ts 是外部可写数据，坏值（如 `../../../../evil`）不校验会直接派生归档目录名
      // （实测 month 派生成 `../../.` → 归档落 C:\proj\specs，甩出 workflow/ 树）。
      // 坏值视同该锚不可用 → 落到下一锚；三锚皆无有效值 → 无日期（该家族不进入归档候选，
      // 不可判定 ≠ 可归档）。
      const cand = [
        [ledgerTs[d.rel], 'ledger'],
        [lastTouch[d.rel], 'git'],
        [/^(\d{4}-\d{2}-\d{2})/.exec(d.file)?.[1], 'name'],
      ];
      let tTime = '';
      let src = 'invalid';
      for (const [v, s] of cand) {
        if (isRealDate(v)) { tTime = v; src = s; break; }
      }
      return { ...d, st, tTime, src };
    });
    const allTerminal = enriched.every((x) => TERMINAL.has(x.st));
    const refd = enriched.some((x) => referenced.has(x.file));
    const undated = enriched.filter((x) => !x.tTime);
    const recent = enriched.filter((x) => x.tTime && Math.floor((today - new Date(x.tTime).getTime()) / 864e5) <= windowDays);
    const archivable = allTerminal && !refd && !undated.length && !recent.length;
    for (const x of enriched) {
      if (TERMINAL.has(x.st)) terminal.push(x);
      if (ACTIVE.has(x.st)) active.push(x);
    }
    if (!archivable) {
      if (undated.length) noDate.push(...undated);
      if (recent.length) tooRecent.push(...recent);
      continue;
    }
    const month = enriched.map((x) => x.tTime).sort().pop().slice(0, 7); // 家族最晚终态月，整族同批
    for (const x of enriched) candidates.push({ ...x, month });
  }
  return { active, terminal, candidates, referenced, tooRecent, noDate };
}

export function buildDocList(root, dirs = DIRS) {
 const docs = [];
 for (const d of dirs) {
 const dir = path.join(root, 'workflow', d);
 if (!fs.existsSync(dir)) continue; // 目录缺失（fixture / 部分类型未建）→ 跳过，不抛
 for (const f of fs.readdirSync(dir)) {
 if (!f.endsWith('.md')) continue;
 const rel = `workflow/${d}/${f}`;
 docs.push({ rel, file: f, dir: d, text: fs.readFileSync(path.join(dir, f), 'utf8') });
 }
 }
 return docs;
}

// loadLedgerTs(root)：每篇文档的终态台账行最新日期（YYYY-MM-DD）。主台账+分片统一视图；
// 2026-10-15 起导出（gen-workflow-metrics 归档积压提醒复用——此前 confirm-doc 内联同型逻辑，
// 导出后新消费方零复制）。
export function loadLedgerTs(root) {
  const out = {};
  // 台账统一视图（主台账+分片透明合并，坏行跳过、同 doc|stage|fingerprint 键去重取末次）
  for (const e of loadAllConfirmations(root)) {
    if (TERMINAL.has(e.stage) && e.doc) {
      const d = (e.ts || '').slice(0, 10);
      // ts 是外部可写数据：只收日历有效日期（坏值不落库——派生归档目录名的唯一入口在这里）
      if (!isRealDate(d)) continue;
      if (!out[e.doc] || d > out[e.doc]) out[e.doc] = d;
    }
  }
  return out;
}

// loadLastTouch(root)：每篇 workflow 文档的「最后一次正文变更」日期（YYYY-MM-DD）。
// 逐提交（新→旧）取该文件的 blob 与上一版比对：正文（bodyOf）逐字节相同 → frontmatter-only 提交，
// 跳过不记；正文有变 → 记该提交日期并停止追踪该文件（新→旧遍历，首遇即最近一次正文变更）。
// 批量迁移/补录提交（只改状态与确认指纹）因此不再刷新锚——2026-10-13 修锚的核心。
// 实现：单次 `git log --raw` 拿「提交 × 文件 × 前后 blob sha」，再按需 `git cat-file --batch` 取内容
// （同 blob 内容天然去重，批量提交里 193 个文件多为同一份 frontmatter 改写，实际读取量远小于文件数）。
export function loadLastTouch(root) {
 const out = {};
 const raw = execFileSync('git', ['log', '--raw', '--no-renames', '--format=%x01%cI', '--', 'workflow'], {
 cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
 });
 // 收集待比对项：按 path 分组，保留**全部**历史条目（新→旧），逐条比对直到找到正文变更
 const byPath = new Map();
 for (const entry of raw.split('\u0001')) {
 const lines = entry.split('\n');
 const date = (lines[0] || '').slice(0, 10);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
 for (const line of lines.slice(1)) {
 // `:<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>`
 const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*\t(.+)$/.exec(line);
 if (!m) continue;
 const [, oldSha, newSha, p] = m;
 if (!byPath.has(p)) byPath.set(p, []);
 byPath.get(p).push({ date, oldSha, newSha });
 }
 }
 // 批量取 blob 内容（--batch 一次喂全部 sha，输出 `<full-sha> blob <size>\n<content>\n`）
 // 注意：--batch 回显**完整** sha，而输入是 core.abbrev 缩写——按输入顺序回填，键用请求时的缩写，
 // 否则 blobs.get(缩写) 恒 miss → 全部走保守回退（2026-10-13 实测踩中）。
 const shas = [...new Set([...byPath.values()].flat().flatMap((x) => [x.oldSha, x.newSha]).filter((s) => s && !/^0+$/.test(s)))];
 const blobs = new Map();
 if (shas.length) {
 const outBuf = execFileSync('git', ['cat-file', '--batch'], {
 cwd: root, input: shas.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024,
 });
 // 按 header 行切分（内容可能含任意字节，故按 size 精确切片）；第 i 个响应 ↔ shas[i]
 let pos = 0;
 let idx = 0;
 while (pos < outBuf.length && idx < shas.length) {
 const nl = outBuf.indexOf(0x0a, pos);
 if (nl === -1) break;
 const header = outBuf.toString('utf8', pos, nl);
 const hm = /^([0-9a-f]+) blob (\d+)$/.exec(header);
 if (!hm) { pos = nl + 1; continue; }
 const size = Number(hm[2]);
 const start = nl + 1;
 blobs.set(shas[idx], outBuf.toString('utf8', start, start + size));
 pos = start + size + 1; // 跳过内容后的换行
 idx++;
 }
 }
 // 逐 path 新→旧扫描：首个「正文有变」的提交日期即内容 last-touch；全为 frontmatter-only → 不记
 // （调用方回退到文件名日期）。新增文件（oldSha 全 0）→ 该次提交即首次入库，记为正文变更。
 for (const [p, entries] of byPath) {
 for (const { date, oldSha, newSha } of entries) {
 // 全 0 sha（新增文件，git 按 core.abbrev 输出 7 位 `0000000`）→ 首次入库即正文变更
 if (/^0+$/.test(oldSha)) { out[p] = date; break; }
 const before = blobs.get(oldSha);
 const after = blobs.get(newSha);
 // 取不到内容（异常态）→ 保守记为正文变更（宁可刷新，不误跳过）
 if (before === undefined || after === undefined) { out[p] = date; break; }
 if (bodyOf(before) !== bodyOf(after)) { out[p] = date; break; }
 }
 }
 return out;
}

function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const wArg = argv.find((a) => a.startsWith('--window='));
  const windowDays = wArg ? Number(wArg.split('=')[1]) : 21;
  if (!Number.isFinite(windowDays) || windowDays < 0) {
    console.error('archive-sweep: --window 须为非负数字');
    process.exit(2);
  }
  // 根锚定 git root（paths.mjs 单源）：子目录调用时归档面仍是仓库根的 workflow/ 树。
  const root = projectRoot();
  const docs = buildDocList(root);
  const r = analyze({
    docs,
    ledgerTs: loadLedgerTs(root),
    lastTouch: loadLastTouch(root),
    activeTexts: docs.filter((d) => ACTIVE.has(parseStatus(d.text))).map((d) => d.text),
    windowDays,
  });
  const byDir = {};
  for (const d of DIRS) byDir[d] = r.candidates.filter((x) => x.dir === d).length;
  const fams = new Set(r.candidates.map((x) => x.file));
  console.log(`窗口 ${windowDays} 天｜候选 ${r.candidates.length} 篇 / ${fams.size} 族（${JSON.stringify(byDir)}）｜活跃 ${r.active.length}｜未满窗 ${r.tooRecent.length}｜被活跃引用排除 ${r.referenced.size}｜无日期 ${r.noDate.length}`);
  if (!execute) {
    for (const x of r.candidates) console.log(`  [dry] ${x.rel} → workflow/archive/${x.month}/${x.dir}/${x.file}`);
    console.log('dry-run 结束（加 --execute 执行 git mv）');
    return;
  }
  let moved = 0;
  const archiveRoot = path.join(root, 'workflow', 'archive');
  for (const x of r.candidates) {
    // 归档目标双保险（2026-10-27 路径逃逸修复）：月名由台账 ts 派生 → ①格式校验 ②解析后须落在
    // workflow/archive/ 内（`..` 逃逸一律拒并出声，不静默跳过）。
    if (!MONTH_RE.test(x.month)) {
      console.error(`[拒] ${x.rel}：归档月非法「${x.month}」——跳过（不写入 workflow/archive/）`);
      continue;
    }
    const destDir = path.join(archiveRoot, x.month, x.dir);
    const rel = path.relative(archiveRoot, destDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(`[拒] ${x.rel}：归档目标逃出 workflow/archive/（${destDir}）——跳过`);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    // git 路径用正斜杠（跨平台一致；path.join 在 Windows 产反斜杠，git 参数不认）
    const destRel = ['workflow', 'archive', x.month, x.dir, x.file].join('/');
    execFileSync('git', ['mv', x.rel, destRel], { cwd: root });
    moved++;
  }
  console.log(`execute 完成：git mv ${moved} 篇 → workflow/archive/<家族最晚终态月>/`);
}

if (process.argv[1] && process.argv[1].endsWith('archive-sweep.mjs')) main();
