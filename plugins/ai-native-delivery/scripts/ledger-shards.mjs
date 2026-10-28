#!/usr/bin/env node
// ledger-shards.mjs — 四个 append-only 台账的分片读写单源（2026-10-13 ledger-shard-ledgers；2026-10-25 优化5 收编 deploy-observations）
//
// 背景：workflow/{regression-checklist,delegations,papercuts}.md 是 append-only 活文档，每次追加
// 全量重写整文件——实测历史 blob 合计 29.6 MiB（占 workflow 的 53%、全仓 pack 的 7.7%），
// regression-checklist 单文件 14.0 MiB（171 版 × 均 80KB）、delegations 11.5 MiB（153 版）。
// 且 30 天内 delegations 被改 131 次、regression-checklist 144 次——多 worktree 并行时每次合并
// 都可能冲突（papercuts 2026-10-08 行即 confirmations.jsonl 同病实证）。
//
// 分片形态（沿 confirmations.d 先例，2026-10-12 ledger-shard-default）：
//   workflow/<ledger>.d/<YYYY-MM>.md —— 按月切分，每月一个文件
// 读侧 = 主台账 ∪ 全部分片（按文件名排序，月序即时间序）；写侧 = 追加进当月分片。
// 主台账保留「头部说明 + 维护规则 + 表头」等人类阅读面，数据行迁入分片。
//
// 为什么按月而非按条目：三个台账的数据行天然带日期列（首列 YYYY-MM-DD），月边界即天然分片键；
// 同月并发追加落同一文件（冲突面从「全历史」缩到「当月」），跨月并发零冲突。
//
// 合并驱动：.gitattributes 的 merge=jsonl-union 只覆盖 .agents/*.jsonl；本模块的 .md 分片走
// 追加式表格行，冲突面已由月切分压到最小，不另配驱动（如需可后续加 merge=union）。
//
// 用法（库）：
//   import { readLedger, shardPathFor, appendRows } from './ledger-shards.mjs';
//   const { main, shards, all } = readLedger(root, 'delegations');
// 用法（CLI，迁移/巡检）：
//   node <插件根>/scripts/ledger-shards.mjs --check          # 巡检：主台账残留数据行 / 分片可读性
//   node <插件根>/scripts/ledger-shards.mjs --split <ledger> # 把主台账数据行按月迁入分片（幂等）
// 测试：node <插件根>/test/ledger-shards.test.mjs
import fs from 'node:fs';
import path from 'node:path';

// 受管台账清单（单源）：键 = 台账基名，值 = 数据行判定
// - 表格式台账（delegations/papercuts）：整文件数据行按月迁出
// - 分节台账（regression-checklist）：只有「防复发验证」节是 append-only 追加区（172KB/178KB），
//   其余模块节是稳定参考内容（4KB）——故用 section 限定，只迁该节的数据行
export const LEDGERS = {
  'regression-checklist': {
    section: '防复发验证', // 只迁此节内的数据行（节标题前缀匹配）
    row: /^\s*\|\s*\d{4}-\d{2}-\d{2}/, // 表格式：首列日期
  },
  delegations: {
    row: /^\s*\|\s*\d{4}-\d{2}-\d{2}/,
  },
  papercuts: {
    row: /^\s*\|\s*\d{4}-\d{2}-\d{2}/,
  },
  // 发布观察台账（2026-10-25 优化5）：deploy.md §5 的 24h 观察结论，一行 = 一次 release——
  // 生而分片（主表只留说明+表头，数据行从首日起就进 .d/<YYYY-MM>.md，无存量迁移）。
  'deploy-observations': {
    row: /^\s*\|\s*\d{4}-\d{2}-\d{2}/,
  },
};

// 表格式台账的表头签名（分片须自带表头——读侧按表头识别数据边界，见 agg-delegations.splitTables）
// delegations 有两张表（委派表 / 自做表），分片须两张都带且行归入正确表下。
// **归属判据 = 原节标题**（`## 委派结果` / `## 自做任务结果`），不用列数——委派表表头声明 6 列
// 而存量行只有 5 列（返工原因列后加、存量不回填），列数无法区分两表（2026-10-13 实测踩中）。
// **分片须同时带节标题**：两个读侧口径不同——`agg-delegations.splitTables` 按表头签名识别，
// 而 `check-loop-kit.delegationResultRows`（检查 18）要求行落在 `## 委派结果`/`## 自做任务结果`
// 节内（`inSec` 门）。只带表头会让检查 18 读到 0 行（2026-10-13 实测：37 条假告警）。
const TABLE_HEADERS = {
  delegations: [
    { section: '委派结果', header: ['## 委派结果', '', '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |', '|------|----------------|------------|------|------|----------|'] },
    { section: '自做任务结果', header: ['## 自做任务结果', '', '| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |', '|------|------------|------|------|----------|'] },
  ],
  papercuts: [
    { section: null, header: ['| 日期 | 位置 | 症状 | 拟修 |', '|------|------|------|------|'] },
  ],
  'regression-checklist': [
    // 第 4 列「执法者」（规则-执法者配对）；存量行 3 列不回填（同 delegations 返工原因列口径）
    { section: null, header: ['| 来源 incident | 回归条目 | 落点 | 执法者 |', '|---------------|----------|------|--------|'] },
  ],
  'deploy-observations': [
    { section: null, header: ['| 日期 | release | 结果 | 关联 incident | 备注 |', '|------|---------|------|---------------|------|'] },
  ],
};

// rowCols(line)：表格式数据行的列数（切分后去首尾空串）。仅用于诊断，不用于表归属。
function rowCols(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
}

// tableIndexOf(name, line, section)：该行属于哪张表。
// 多表台账（delegations）按**原节标题**归属（列数不可靠，见 TABLE_HEADERS 注释）；
// 单表台账恒 0。section 为行所在节的标题（调用方按 `## ` 滚动维护）。
function tableIndexOf(name, line, section = '') {
  const specs = TABLE_HEADERS[name];
  if (!specs || specs.length === 1) return 0;
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].section && String(section).startsWith(specs[i].section)) return i;
  }
  return 0; // 无节信息（旧分片/裸行）→ 归首表（委派表），沿原主台账行序语义
}

export function ledgerPath(root, name) {
  return path.join(root, 'workflow', `${name}.md`);
}

export function shardDir(root, name) {
  return path.join(root, 'workflow', `${name}.d`);
}

// 月键格式单源（2026-10-27 路径逃逸修复）：分片文件名 = <月键>.md，月键直接进 path.join——
// 不校验时 `--month ../../../../evil` 会把写入甩出 workflow/ 树（实测可写到仓外 C:\evil.md）。
// 判据取严格 YYYY-MM 且月份在 01-12 内（`2026-13` 形态虽不逃逸，但会造出无意义目录）。
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function assertMonth(month) {
  const m = String(month ?? '');
  if (!MONTH_RE.test(m)) {
    throw new Error(`分片月键非法：「${m}」——须为 YYYY-MM（月份 01-12）。拒绝写入：月键直接进路径拼接，不校验可写出 workflow/ 树外。`);
  }
  return m;
}

export function shardPathFor(root, name, month) {
  return path.join(shardDir(root, name), `${assertMonth(month)}.md`);
}

// monthOf(line)：从数据行提取分片月（YYYY-MM）。表格式取首列日期；清单式无日期 → 返回 ''（调用方兜底）。
export function monthOf(name, line) {
  const m = /(\d{4})-(\d{2})-\d{2}/.exec(line);
  return m ? `${m[1]}-${m[2]}` : '';
}

// isDataRow(name, line)：该行是否属于「应迁入分片」的数据行（不含节上下文）。
export function isDataRow(name, line) {
  const spec = LEDGERS[name];
  if (!spec) return false;
  if (!spec.row.test(line)) return false;
  // 表头/分隔行排除
  if (/^\s*\|/.test(line)) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!cells.length || cells.every((c) => /^[-: ]*$/.test(c))) return false;
    if (cells[0] === '日期' || cells[0] === '来源 incident') return false;
  }
  return true;
}

// inScope(name, section)：当前节是否属于该台账的迁移范围（无 section 限定 → 恒 true）。
export function inScope(name, section) {
  const spec = LEDGERS[name];
  if (!spec || !spec.section) return true;
  return String(section).startsWith(spec.section);
}

// readLedger(root, name)：主台账 ∪ 全部分片。返回 { main, shards: [{file, text}], all }。
// 分片按文件名排序（月序 = 时间序）；读失败 fail-loud（指标缺数会喂错门禁，沿 agg-delegations 口径）。
export function readLedger(root, name) {
  const mainP = ledgerPath(root, name);
  let main = '';
  if (fs.existsSync(mainP)) {
    try { main = fs.readFileSync(mainP, 'utf8'); }
    catch (err) { throw new Error(`台账读取失败: ${mainP} (${err.message})`); }
  }
  const dir = shardDir(root, name);
  const shards = [];
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); }
    catch (err) { throw new Error(`分片目录遍历失败: ${dir} (${err.message})`); }
    for (const f of files) {
      const p = path.join(dir, f);
      try { shards.push({ file: f, text: fs.readFileSync(p, 'utf8') }); }
      catch (err) { throw new Error(`分片读取失败: ${f} (${err.message})`); }
    }
  }
  const all = [main, ...shards.map((s) => s.text)].join('\n');
  return { main, shards, all };
}

// readLedgerText(root, name)：便捷形态——只要合并文本（读侧最小改动接入点）。
export function readLedgerText(root, name) {
  return readLedger(root, name).all;
}

// readDelegationsText(root, file)：delegations 合并文本（主台账 ∪ delegations.d/*.md）。
// 供三个读侧消费者共用（单源，禁各自拼路径）：
//   - agg-delegations.splitTables（表头签名识别）
//   - check-loop-kit.delegationResultRows（`## 委派结果`/`## 自做任务结果` 节）
//   - wf-journal.delegationSectionRows（`## 委派结果` 节）
// file 语义：**仅当它不是本仓默认主台账路径时**才作显式覆盖（测试注入临时文件用）；
// 传默认路径（消费者按 `path.join(ROOT,'workflow','delegations.md')` 拼出来的）→ 走分片合并，
// 否则分片被静默跳过（2026-10-13 实测踩中：检查 18 读到 0 行）。
export function readDelegationsText(root, file = null) {
  const def = ledgerPath(root, 'delegations');
  if (file && path.resolve(file) !== path.resolve(def)) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }
  try { return readLedgerText(root, 'delegations'); } catch { return ''; }
}

// splitMain(root, name, { dryRun })：把主台账里的数据行按月迁入分片（幂等：已迁走的行不再出现）。
// 返回 { moved: {month: count}, kept: 主台账保留行数 }。主台账保留非数据行（说明/规则/表头/生成区）。
export function splitMain(root, name, { dryRun = false } = {}) {
  const mainP = ledgerPath(root, name);
  if (!fs.existsSync(mainP)) throw new Error(`台账不存在: ${mainP}`);
  const raw = fs.readFileSync(mainP, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const kept = [];
  const byMonth = new Map();
  let section = '';
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) section = h[1];
    if (!inScope(name, section) || !isDataRow(name, line)) { kept.push(line); continue; }
    const month = monthOf(name, line);
    if (!month) { kept.push(line); continue; } // 无日期行不迁
    // 月键非法（如 2026-13）→ 不迁，留在主台账等人工修（--check 会把残留行报出来）。
    // 不静默丢弃，也不因一行坏日期中止整批迁移。
    if (!MONTH_RE.test(month)) { kept.push(line); continue; }
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push({ line, section }); // 带节信息（多表台账按节归属表）
  }
  const moved = {};
  for (const [month, rows] of byMonth) moved[month] = rows.length;
  if (dryRun) return { moved, kept: kept.length, byMonth };
  // 写分片：已存在的分片保留原内容，新行追加——**按行去重**（幂等：重跑不重复追加）。
  // 2026-10-13 实测踩中：无去重时二次 split 把 58 行重复写入（120 行 vs 62 行）。
  for (const [month, rows] of byMonth) {
    const p = shardPathFor(root, name, month);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const existingRows = new Set(existing.split(/\r?\n/).filter((l) => l.trim()));
    const fresh = rows.filter((r) => !existingRows.has(r.line));
    if (!fresh.length) continue; // 全部已在分片 → 不写（幂等）
    const next = existing
      ? `${existing.replace(/\s*$/, '')}${eol}${fresh.map((r) => r.line).join(eol)}${eol}`
      : renderShard(name, fresh, eol);
    fs.writeFileSync(p, next, 'utf8');
  }
  // 主台账：保留行 + 尾部空行规整
  const out = kept.join(eol).replace(/(\r?\n)+$/, '') + eol;
  fs.writeFileSync(mainP, out, 'utf8');
  return { moved, kept: kept.length };
}

// renderShard(name, rows, eol)：完整分片内容 = 表头 + 行（行归入各自表头之下）。
// 多表台账（delegations）必须逐表「表头 + 该表行」交错输出——否则读侧 splitTables 会把
// 后一张表的行按前一张表解析（2026-10-13 实测：240 任务塌成 100）。
// rows 项 = { line, section }（section 为原节标题，用于表归属）；rows 为空 → 出全部表头（空分片骨架）。
export function renderShard(name, rows, eol = '\n') {
  const specs = TABLE_HEADERS[name];
  if (!specs) return rows.length ? `${rows.map((r) => r.line ?? r).join(eol)}${eol}` : '';
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const mine = rows.filter((r) => tableIndexOf(name, r.line ?? r, r.section) === i);
    if (rows.length && !mine.length) continue; // 有行但本表无行 → 不出空表头
    out.push(...specs[i].header, ...mine.map((r) => r.line ?? r));
  }
  return out.length ? `${out.join(eol)}${eol}` : '';
}

// insertIntoSection(text, section, lines)：把行插进已有分片的对应 ## 节（下一节标题之前）。
// 节不存在则整节追加到文末。无 section 的行不走这里（保持追加到文末 = 末表）。
function insertIntoSection(text, section, lines) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  const start = parts.findIndex((l) => l.startsWith('## ') && l.includes(section));
  if (start < 0) {
    return `${parts.join(eol)}${eol}${eol}## ${section}${eol}${eol}${lines.join(eol)}${eol}`;
  }
  let end = parts.length;
  for (let i = start + 1; i < parts.length; i++) {
    if (parts[i].startsWith('## ')) { end = i; break; }
  }
  let at = end;
  while (at > start && parts[at - 1].trim() === '') at--;
  parts.splice(at, 0, ...lines);
  return `${parts.join(eol)}${eol}`;
}

// appendRows(root, name, rows, { month, section })：把数据行追加进指定月分片（缺省取行内日期月）。
// rows 可为字符串数组或 { line, section } 数组（多表台账须带 section 才能归对表）。
// 分片已存在时：带 section 的行插入该节（不落到文末自做表）；不带 section 的行仍追加到文末。
// 返回实际写入的分片路径列表。写失败 fail-loud（不静默吞）。
export function appendRows(root, name, rows, { month, section = '' } = {}) {
  const written = [];
  const byMonth = new Map();
  // 显式 month 先校验（调用方可传任意串 → 路径逃逸面）；未传则由行内日期推导（月键天然合规）
  const forced = month === undefined || month === null || month === '' ? null : assertMonth(month);
  for (const row of rows) {
    const line = typeof row === 'string' ? row : row.line;
    const sec = typeof row === 'string' ? section : (row.section ?? section);
    const m = forced || monthOf(name, line);
    if (!m) throw new Error(`appendRows: 无法确定分片月（行无日期且未传 month）: ${String(line).slice(0, 80)}`);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push({ line, section: sec });
  }
  for (const [m, rs] of byMonth) {
    const p = shardPathFor(root, name, m);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const existingRows = new Set(existing.split(/\r?\n/).filter((l) => l.trim()));
    const fresh = rs.filter((r) => !existingRows.has(r.line));
    if (!fresh.length) { written.push(p); continue; } // 已在分片 → 幂等跳过
    let next;
    if (!existing) next = renderShard(name, fresh, '\n');
    else {
      const placed = fresh.filter((r) => r.section);
      const tail = fresh.filter((r) => !r.section);
      let text = existing;
      const bySec = new Map();
      for (const r of placed) {
        if (!bySec.has(r.section)) bySec.set(r.section, []);
        bySec.get(r.section).push(r.line);
      }
      for (const [sec, lines] of bySec) text = insertIntoSection(text, sec, lines);
      if (tail.length) text = `${text.replace(/\s*$/, '')}\n${tail.map((r) => r.line).join('\n')}\n`;
      next = text.endsWith('\n') ? text : `${text}\n`;
    }
    fs.writeFileSync(p, next, 'utf8');
    written.push(p);
  }
  return written;
}

// ---- CLI：巡检 / 迁移 ----
function main() {
  const argv = process.argv.slice(2);
  const root = process.cwd();
  if (argv.includes('--check')) {
    let bad = 0;
    for (const name of Object.keys(LEDGERS)) {
      const mainP = ledgerPath(root, name);
      if (!fs.existsSync(mainP)) { console.log(`[skip] ${name}: 主台账不存在`); continue; }
      const lines = fs.readFileSync(mainP, 'utf8').split(/\r?\n/);
      const residual = lines.filter((l) => isDataRow(name, l)).length;
      let shardRows = 0;
      try {
        const { shards } = readLedger(root, name);
        for (const s of shards) shardRows += s.text.split(/\r?\n/).filter((l) => isDataRow(name, l)).length;
      } catch (err) { console.error(`[FAIL] ${name}: ${err.message}`); bad++; continue; }
      console.log(`[${residual ? 'WARN' : 'OK'}] ${name}: 主台账残留数据行 ${residual}｜分片数据行 ${shardRows}`);
      if (residual) bad++;
    }
    process.exit(bad ? 1 : 0);
  }
  const splitIdx = argv.indexOf('--split');
  if (splitIdx >= 0) {
    const name = argv[splitIdx + 1];
    if (!LEDGERS[name]) { console.error(`--split 须指定台账名（${Object.keys(LEDGERS).join('|')}）`); process.exit(2); }
    const dry = argv.includes('--dry-run');
    const r = splitMain(root, name, { dryRun: dry });
    console.log(`${dry ? '[dry] ' : ''}${name}: 迁出 ${Object.values(r.moved).reduce((a, b) => a + b, 0)} 行 → ${JSON.stringify(r.moved)}｜主台账保留 ${r.kept} 行`);
    return;
  }
  // --append <ledger> --row "<行>" [--month YYYY-MM]：追加一行进当月分片（写侧唯一入口）
  const appIdx = argv.indexOf('--append');
  if (appIdx >= 0) {
    const name = argv[appIdx + 1];
    if (!LEDGERS[name]) { console.error(`--append 须指定台账名（${Object.keys(LEDGERS).join('|')}）`); process.exit(2); }
    const rowIdx = argv.indexOf('--row');
    const row = rowIdx >= 0 ? argv[rowIdx + 1] : '';
    if (!row) { console.error('--append 须带 --row "<数据行>"'); process.exit(2); }
    const mIdx = argv.indexOf('--month');
    const month = mIdx >= 0 ? argv[mIdx + 1] : undefined;
    // --month 先校验再落盘（2026-10-27 路径逃逸修复）：月键直接进分片路径拼接，
    // 不校验时 `--month ../../../../evil` 会把台账写到 workflow/ 树外（仓外 C:\evil.md）。
    if (month !== undefined) {
      if (!MONTH_RE.test(month)) {
        console.error(`--month 须为 YYYY-MM（月份 01-12），现「${month}」——拒绝写入（防路径逃逸）`);
        process.exit(2);
      }
    }
    const sIdx = argv.indexOf('--section');
    const section = sIdx >= 0 ? argv[sIdx + 1] : '';
    if (sIdx >= 0 && !section) { console.error('--section 须带节标题（如 委派结果）'); process.exit(2); }
    let written;
    try {
      written = appendRows(root, name, [row], { month, section });
    } catch (err) {
      console.error(`追加失败：${err.message}`);
      process.exit(1);
    }
    console.log(`✓ 追加 1 行 → ${written.map((p) => path.relative(root, p).split(path.sep).join('/')).join(', ')}`);
    return;
  }
  console.error('用法：node <插件根>/scripts/ledger-shards.mjs --check | --split <ledger> [--dry-run] | --append <ledger> --row "<行>" [--month YYYY-MM] [--section <节标题>]');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('ledger-shards.mjs')) main();
