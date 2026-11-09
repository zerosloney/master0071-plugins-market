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
import { randomBytes } from 'node:crypto';
import { projectRoot, resolveProjectRoot, ledgerRefusal, testAnyRootAllowed } from './paths.mjs';

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

// writeFileAtomic(p, text)：同目录 tmp + rename 原子整写（2026-11-08 M4/M5）。
// 直接 writeFileSync 是「先截断后写」——分片是已迁行唯一副本、主台账存着说明/表头等非数据行，
// 进程中途崩溃（或磁盘满）留下的就是半截文件。改走 tmp+rename：任一步失败时原文件逐字节原样、
// 可安全重跑。写法沿用仓内既有惯例（compact-ledgers 的 tmpMain / core.mjs writeAtomic）；
// 调用方都在 withLedgerLock 临界区内（同月分片/主台账各一把锁串行化），固定 .tmp 名不互撞。
function writeFileAtomic(p, text) {
  const tmp = `${p}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, p);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tmp); } catch { /* tmp 可能尚未写成或已被清理 */ }
    }
  }
}

// splitMain(root, name, { dryRun })：把主台账里的数据行按月迁入分片（幂等：已迁走的行不再出现）。
// 返回 { moved: {month: count}, kept: 主台账保留行数 }。主台账保留非数据行（说明/规则/表头/生成区）。
// 写分片全程持 `<分片>.lock`（2026-11-05，与 appendRows/MCP 同一把锁）——锁等待超时抛错（fail-loud），
// 不用陈旧快照整写（那会抹掉并发追加的行）。
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
  // 2026-11-05 并发修复：每个分片的「重读现状→追加→整写」全程持 `<分片>.lock`（withLedgerLock，
  // 与 appendRows/MCP 同一把锁）。此前无锁整写：--split 与 --append/MCP 并发同月分片时，split 拿
  // 陈旧分片快照整写，把并发追加的行整个抹掉。逐分片持锁（而非全持）：追加者只写自己那一个月的
  // 分片，跨月互不相干。
  // 2026-11-08 注释修正：旧注说「追加者从不写主台账，主台账重写无锁也无风险」——已不成立：
  // MCP update_ledger 的 append 可直写 workflow/ 下的主台账文件（与分片同把锁来源）。所以主台账
  // 重写同样持 `<主台账>.lock`（见下方写点），与主台账追加者互斥；两把锁各管各的面。
  for (const [month, rows] of byMonth) {
    const p = shardPathFor(root, name, month);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    withLedgerLock(p, () => {
      const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      const existingRows = new Set(existing.split(/\r?\n/).filter((l) => l.trim()));
      const fresh = rows.filter((r) => !existingRows.has(r.line));
      if (!fresh.length) return; // 全部已在分片 → 不写（幂等）
      const next = existing
        ? `${existing.replace(/\s*$/, '')}${eol}${fresh.map((r) => r.line).join(eol)}${eol}`
        : renderShard(name, fresh, eol);
      writeFileAtomic(p, next); // 分片是已迁行唯一副本，整写必须原子（截断即丢数据）
    });
  }
  // 主台账：保留行 + 尾部空行规整。持锁整写（2026-11-08 M4）：分片迁移完成后这里会**整写**主台账，
  // 与主台账追加者（MCP update_ledger append / loader 主分支）持同一把锁互斥——否则并发追加落在
  // 本函数 read 与整写之间会被抹掉。整写走 tmp+rename（先截断后写，中途崩溃丢说明/表头）。
  const out = kept.join(eol).replace(/(\r?\n)+$/, '') + eol;
  withLedgerLock(mainP, () => {
    writeFileAtomic(mainP, out);
  });
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

// 台账写锁（2026-11-01 加）：`workflow/` 台账有两个写者——本文件的 --append（分节插入必须
// 读-改-写整文件）与 MCP update_ledger 的 append 模式。前者拿陈旧快照整写会抹掉后者刚 append
// 的行，后者不持锁就挡不住前者，所以锁是**两个写者共用**的单源（core.mjs 从本文件 import）。
// 写法沿用本仓既有约定（worktree-ops/mcp/core.mjs:acquireConfigLock、systemone 的
// decision-cache/precheck-quota 同族）：`openSync(lock,'wx')` 独占创建 + 锁内写 pid +
// 陈旧锁接管 + Atomics.wait 退避 + 释放前比对 owner（迟到的 release 不能误删接管者的锁）。
const SHARD_LOCK_STALE_MS = 15_000;
const SHARD_LOCK_WAIT_MS = 3_000;
// 锁竞争的错误码：EEXIST 是 POSIX 的"已存在"；Windows 在创建/删除同一文件的瞬间
// 会给出 EPERM/EBUSY/EACCES（本仓 decision-cache / precheck-quota 处理 rename 时同族）。
const LOCK_CONTENDED = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 锁内容首段是持有者 pid（2026-11-05 锁加固，移植 agent-pipelines/scripts/state.mjs 0.1.26 的
// withLock/takeOverStale 已验证模式）：等待超时且持有者进程已死（kill(pid,0) ESRCH）→ 残留锁
// 实锤，可提前原子接管，不必等满陈旧阈值。
function lockOwnerPid(content) {
  const pid = Number.parseInt(String(content), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 进程存在但无权发信号 → 仍视为存活
  }
}

/**
 * 对 target 的写临界区加锁执行。拿不到锁**抛错**（fail-loud），不静默降级成无锁写——
 * 无锁写正是本次要修的丢行根因。
 * 对外契约不变：等待 SHARD_LOCK_WAIT_MS、超时抛「台账写锁等待超时」（2026-11-05 锁加固
 * 只改接管的原子性与提前接管条件，不改等待/超时语义）。
 * @param {string} target 待写文件绝对路径
 * @param {() => T} fn 临界区
 * @returns {T}
 */
export function withLedgerLock(target, fn) {
  const lockPath = `${target}.lock`;
  // owner 带随机后缀而不只是 pid：同一 pid 的两次重入（或 pid 复用）不该互相认成同一把锁
  const owner = `${process.pid}:${randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + SHARD_LOCK_WAIT_MS;
  // 陈旧锁接管：不用 unlink+重建——stat 判陈旧到删掉之间锁可能已被他人接管重建，无条件删
  // 会误删新持锁者的锁、还留下「无锁窗口」让第三方插空。改为把自身 owner 写临时文件后
  // rename 原子替换锁文件：要么整体换掉要么不动，不存在「误删他人新锁」的中间态。并发接管时
  // 最后替换者的 owner 留在锁里，release 前的内容比对保证输家不误删赢家的锁。返回是否接管成功。
  const takeOverStale = () => {
    try {
      const mtimeMs = fs.statSync(lockPath).mtimeMs;
      let stale = false;
      if (Date.now() - mtimeMs > SHARD_LOCK_STALE_MS) {
        // 锁龄超限只把锁列为「可疑」（2026-11-08 M7 收紧）：此前陈旧即无条件接管——活持有者
        // 临界区超 15s（MB 级归并 / 慢盘）就被夺锁，两个写者同时进场互踩。接管还须另证：
        // 持有 pid 已死（kill(pid,0) ESRCH，残留锁实锤）或锁内容读不出 pid（旧格式锁，无从判活）；
        // 活 pid 一律不接管，等 deadline 超时响亮报错（fail-loud 语义不变）。
        const pid = lockOwnerPid(fs.readFileSync(lockPath, 'utf8'));
        stale = pid === null || !pidAlive(pid);
      } else if (Date.now() > deadline) {
        // 崩溃残留锁早接管（移植 state.mjs）：锁龄未满 15s 但等待已超 deadline 且持有者 pid
        // 已死 → 残留锁实锤，立即进入接管；pid 存活（正当持锁者只是慢——慢盘大分片临界区）
        // 绝不提前接管，不会造出双写者，超时报错语义照旧。读不出 pid（旧格式锁）不满足
        // 「死亡实锤」，不提前接管。
        const pid = lockOwnerPid(fs.readFileSync(lockPath, 'utf8'));
        stale = pid !== null && !pidAlive(pid);
      }
      if (!stale) return false;
      const tmp = `${lockPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
      let replaced = false;
      try {
        fs.writeFileSync(tmp, owner, 'utf8');
        fs.renameSync(tmp, lockPath);
        replaced = true;
      } finally {
        if (!replaced) {
          try { fs.unlinkSync(tmp); } catch { /* 临时文件可能已被 rename 或根本没写成 */ }
        }
      }
      return replaced;
    } catch {
      /* 锁刚好被释放/替换（Windows 上 rename 目标被占用等）→ 按普通竞争退避重试 */
      return false;
    }
  };
  for (;;) {
    let acquired = false;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      // writeSync 失败也要关 fd：锁文件句柄一旦泄漏，Windows 上该文件一直被本进程占用，
      // 后续 unlink/接管都会被拖累。
      try {
        fs.writeSync(fd, owner);
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      // 竞争的表现不只有 EEXIST：Windows 上同一文件正被别的进程创建/删除时，
      // `openSync(...,'wx')` 会报 EPERM/EBUSY/EACCES（实测 24 路并发撞过一次 EPERM，
      // 那一路直接抛错丢行）。它们与 EEXIST 一样是「有人正在动这把锁」，
      // 按同一套退避 + 陈旧接管处理；其余错误码才是真故障。
      if (!err || !LOCK_CONTENDED.has(err.code)) throw err;
    }
    if (!acquired && !takeOverStale()) {
      if (Date.now() > deadline) {
        throw new Error(`台账写锁等待超时（${lockPath}）——另一个进程正在整写同一台账。`
          + `拒绝在无锁状态下读-改-写（那会把别人刚追加的行抹掉还回成功），请稍后重跑本次写入`);
      }
      sleepSync(25);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        // 只释放仍属于自己的锁（2026-11-09 审查收口：TOCTOU 收口）：旧「读内容→unlink」在比对与
        // 删除之间被接管者 rename 替换时会误删新持锁者的锁。改为 claim 式——先把锁 rename 到自身
        // 临时名（原子占位），读回确认 owner 才删；不是自己的放回原位（仅当位空），绝不盲删。
        const trash = `${lockPath}.rel.${process.pid}.${Math.random().toString(36).slice(2)}`;
        try {
          fs.renameSync(lockPath, trash);
          let mine = false;
          try { mine = fs.readFileSync(trash, 'utf8') === owner; } catch { /* 读不到按非己锁 */ }
          if (mine) fs.unlinkSync(trash);
          else { try { fs.renameSync(trash, lockPath); } catch { /* 已有更新持锁者：不覆盖 */ } }
        } catch {
          /* 锁已被清理 */
        }
      } catch {
        /* 已被清理或已被接管 */
      }
    }
  }
}

// 文件指纹（size + mtime 毫秒）：读-改-写路径用它判断「我读到的现状是否仍然成立」。
// 不追求密码学强度——同一毫秒内被写入且尺寸恰好分毫不差的两次追加，在按行追加的台账上
// 不存在（两条不同的数据行不可能同长）。
function fingerprintOf(p) {
  try {
    const st = fs.statSync(p);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

// 文末追加：与原实现同样保证「文件以且仅以一个换行收尾」，但不整写全文。
// appendFileSync 改不了已有末尾空白，所以只在末字节不是 \n 时补一个换行，
// 免得把新行粘在一条残缺的末行上。
function appendTailLines(p, lines) {
  if (!lines.length) return;
  let prefix = '';
  try {
    const st = fs.statSync(p);
    if (st.size > 0) {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, st.size - 1);
        if (buf[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // 读不到末字节就按「已有换行」处理：最坏是空一行，读者一律 filter(l=>l.trim())
  }
  fs.appendFileSync(p, `${prefix}${lines.join('\n')}\n`, 'utf8');
}

// appendRows(root, name, rows, { month, section })：把数据行追加进指定月分片（缺省取行内日期月）。
// rows 可为字符串数组或 { line, section } 数组（多表台账须带 section 才能归对表）。
// 分片已存在时：带 section 的行插入该节（不落到文末自做表）；不带 section 的行仍追加到文末。
// 返回 { written: 涉及的分片路径列表, appended: 新落盘行数, skipped: 幂等跳过行数 }。
// 写失败 fail-loud（不静默吞）。
//
// 并发口径（2026-11-01 修复）：此前这里是「readFileSync 全文 → 内存里拼 → writeFileSync 整写」，
// 多进程同时追加时后写者拿的是自己的陈旧快照，会把别人刚写的行整个抹掉，而 CLI 照样回
// 「✓ 追加 1 行」（实测 24 并发全 0 退出、全打成功，落盘只有 18 行、缺 6）。同一个缺陷在
// mcp/core.mjs:242-247 已确认并修过（改走 appendFileSync），但那道修复只覆盖了 MCP
// update_ledger 一条口，而 --append 才是 commands/deploy.md:57 与 confirm-doc.mjs:464
// 明确引导用户与 agent 去走的正式写入口。现在三条路径分别是：
//   · 分片不存在 → 'wx' 独占创建，撞 EEXIST 的一方退回追加路径（不再互相盖掉整个文件）；
//   · 纯文末追加 → appendFileSync（O_APPEND），与 MCP 侧同招，从根上没有陈旧快照；
//   · 需要插进特定 `## ` 节 → 读-改-写不可避免，改为写前比对指纹、陈旧则重读重算，
//     连续八次仍被抢写就抛错（fail-loud），而不是丢行回成功；
//   · 以上三条都在 `<分片>.lock` 的临界区内执行（withLedgerLock），MCP update_ledger 的
//     append 也持同一把锁——否则「append 持锁 + 裸读-改-写」仍然互踩，锁只锁住自己等于没锁。
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

  // 单个分片的写临界区（持锁调用）。返回实际新落盘的行数（0 = 全部幂等跳过）。
  const writeShard = (p, rs) => {
    const dedupe = (text, cand) => {
      const seen = new Set(text.split(/\r?\n/).filter((l) => l.trim()));
      return cand.filter((r) => !seen.has(r.line));
    };
    let existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    let fresh = dedupe(existing, rs);
    if (!fresh.length) return 0; // 已在分片 → 幂等跳过

    if (!existing) {
      try {
        // flag:'wx' 必须进 options 对象（2026-11-08 修复）：旧写法把 { flag: 'wx' } 放在第 4 参——
        // writeFileSync(file, data, options) 只收 3 参，第 4 参被静默忽略，实际 flag='w'。后果：
        // existsSync 判「分片不存在」到写入之间他人抢先建好分片时，本方会把对方刚写的内容整个
        // 截断重写，EEXIST 回退分支永不可达。修正后 'wx' 生效 → 撞 EEXIST → 走下方按现状追加。
        fs.writeFileSync(p, renderShard(name, fresh, '\n'), { encoding: 'utf8', flag: 'wx' });
        return fresh.length;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // 别的进程抢先建好了：按现状重来（去重后走下面的追加/插入路径）
        existing = fs.readFileSync(p, 'utf8');
        fresh = dedupe(existing, fresh);
        if (!fresh.length) return 0;
      }
    }

    const tail = fresh.filter((r) => !r.section);
    const placed = fresh.filter((r) => r.section);
    if (!placed.length) {
      appendTailLines(p, tail.map((r) => r.line));
      return fresh.length;
    }

    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const before = fingerprintOf(p);
      let text = existing;
      const bySec = new Map();
      for (const r of placed) {
        if (!bySec.has(r.section)) bySec.set(r.section, []);
        bySec.get(r.section).push(r.line);
      }
      for (const [sec, lines] of bySec) text = insertIntoSection(text, sec, lines);
      if (tail.length) text = `${text.replace(/\s*$/, '')}\n${tail.map((r) => r.line).join('\n')}\n`;
      const next = text.endsWith('\n') ? text : `${text}\n`;
      if (fingerprintOf(p) === before) {
        // 分片整写原子化（2026-11-08 M5）：分片是已迁行唯一副本，直接 writeFileSync 先截断后写，
        // 进程中途崩溃即丢整片。tmp+rename 任一步失败原分片逐字节原样，可安全重跑（fail-loud）。
        writeFileAtomic(p, next);
        done = true;
        break;
      }
      // 现状在拼串期间被改过：重读，摘掉已被别人写进去的行，再来一轮
      existing = fs.readFileSync(p, 'utf8');
      fresh = dedupe(existing, fresh);
      if (!fresh.length) { done = true; break; }
    }
    if (!done) {
      throw new Error(`appendRows: ${p} 连续 8 次在写入前被并发修改——拒绝用陈旧快照整写`
        + `（那会抹掉别人刚追加的台账行），请重跑本次追加`);
    }
    return tail.length + placed.length;
  };

  let appended = 0;
  let candRows = 0;
  for (const [m, rs] of byMonth) {
    const p = shardPathFor(root, name, m);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 返回的路径列表是「本次涉及的分片」，与旧实现同口径（幂等跳过也算涉及，CLI 据此打印回执）
    appended += withLedgerLock(p, () => writeShard(p, rs));
    candRows += rs.length;
    written.push(p);
  }
  // 回执诚实（2026-11-05）：区分「新落盘」与「幂等跳过」——重复行静默跳过曾让 CLI 照打
  // 「✓ 追加 1 行」，写侧回执与磁盘事实不符（审计对不上账）。
  return { written, appended, skipped: candRows - appended };
}

// ---- CLI：巡检 / 迁移 ----
function main() {
  const argv = process.argv.slice(2);
  // 写侧 fail-closed（2026-11-05）：--append 与真迁移 --split 必须解析到 git 仓库根，否则拒绝
  // 操作（对齐 MCP requireRoot 口径）。旧口径 projectRoot() 回退 cwd——非 git 目录（含 bare 仓，
  // 曾被误诊为 git-unavailable）跑写命令会把台账「就地」落进调用目录（可以是用户家目录），
  // 违反「台账与三本审计账只落使用项目仓库根」不变量。只读命令（--check / --split --dry-run）
  // 维持 projectRoot() 回退现状，巡检不受限。
  const splitIdx0 = argv.indexOf('--split');
  const writeOp = argv.includes('--append') || (splitIdx0 >= 0 && !argv.includes('--dry-run'));
  const pr = resolveProjectRoot();
  if (writeOp && !pr.root && !testAnyRootAllowed()) {
    console.error(`[ledger-shards] ❌ ${ledgerRefusal(pr.status, pr.detail)}`);
    console.error('hint: 在使用项目的 git 仓库内运行（或先 git init）。只读巡检 --check 与 --split --dry-run 不受限；库调用方可显式传 root。');
    process.exit(1);
  }
  // 根锚定 git root（paths.mjs 单源）：子目录调用时台账仍落仓库根，不落进子目录。
  const root = projectRoot();
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
    let r;
    try {
      r = splitMain(root, name, { dryRun: dry });
    } catch (err) {
      // 迁移失败的统一出口（含分片写锁等待超时）：响亮退出，主台账未重写、未处理分片原样，重跑安全
      console.error(`迁移失败：${err.message}`);
      process.exit(1);
    }
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
    let r;
    try {
      r = appendRows(root, name, [row], { month, section });
    } catch (err) {
      console.error(`追加失败：${err.message}`);
      process.exit(1);
    }
    // 落点打绝对路径：相对路径在子目录调用时看不出台账到底落在仓库根还是子目录（曾把
    // 追加行落进 <repo>/sub/workflow/ 而仓库根 workflow/ 根本不存在，用户无从察觉）。
    // 回执如实（2026-11-05）：新落盘与幂等跳过分账——重复行曾照打「✓ 追加 1 行」。
    const ps = r.written.map((p) => path.resolve(p)).join(', ');
    if (r.appended > 0 && r.skipped > 0) {
      console.log(`✓ 新落盘 ${r.appended} 行、幂等跳过 ${r.skipped} 行（分片已有相同行）→ ${ps}`);
    } else if (r.appended > 0) {
      console.log(`✓ 追加 ${r.appended} 行 → ${ps}`);
    } else {
      console.log(`＝ 幂等跳过 ${r.skipped} 行（分片已有相同行，未重复落盘）→ ${ps}`);
    }
    return;
  }
  console.error('用法：node <插件根>/scripts/ledger-shards.mjs --check | --split <ledger> [--dry-run] | --append <ledger> --row "<行>" [--month YYYY-MM] [--section <节标题>]');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('ledger-shards.mjs')) main();
