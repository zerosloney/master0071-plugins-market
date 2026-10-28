#!/usr/bin/env node
/* agg-delegations: 量化证据聚合
 * 读 workflow/delegations.md 两张结果表（按表头签名识别：委派表含「被委派方」列、自做表=日期+任务一句话；不依赖 ## 节标题）+ 扫 workflow/incidents/ 与 workflow/archive 下各批次 incidents 目录、按文件名月份计数（归档不出账），
 * 输出各月指标（一次通过率 / 平均返工次数 / 主兜底占比）、并发扩容门判定、可粘贴的月度快照行。
 * 结果取值：一次通过 | 返工×N | 主兜底 | 返工待修（未闭环，不计入率）。
 * 用法：node <插件根>/scripts/agg-delegations.mjs [--month=YYYY-MM] [--write]（默认输出全部月份 + 全量累计；
 *       --write = 机器落表：目标月（argMonth 或当月）快照行写入 workflow/delegations.md §月度聚合快照 GENERATED 区，
 *       同月重写、他月行不触碰；不带 --write 仍只打印（snapshot-machine-write，手工粘贴退役）。
 * 门槛定义见 workflow/delegations.md §并发扩容门槛（doc 为权威，脚本向文档对齐——board-kb-p1）。
 * agents-hygiene：.cjs → .mjs 归一 ESM（require → import，isMain 守卫改 import.meta 判定；纯函数导出与行为不变）。
 * 2026-10-10 读失败出账：readLedger(root) 参数化（默认 ROOT）、读失败 fail-loud（throw→main fail() exit 1）、漂移/截断文案带分片提示。
 * snapshot-machine-write：扩容门「连续两月」改全月链判定（--month 显示过滤不再误判「上月无数据」）；
 *       快照备注加落表时点（调研待查·10-08/10-10 落表勘误的根因=人工粘贴无时点，本笔关闭）。
 * unrecorded-anchor-split：未记数分列「锚前存量 / 锚后待记」（外源调研建议：判据被存量污染时
 *       扩容裁定盲目）。总口径、直方图与门 2/3/4 判据均不变——实测门 3 由 blockingRework（77/50）钉死，
 *       与未记数无关，故本笔是展示面纠偏，不改变任何月度裁定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { findProjectRoot, projectRoot } from './paths.mjs';
import { readLedger as readLedgerShards } from './ledger-shards.mjs';

// ROOT 解析（2026-10-28 收口）：项目 git 根（findProjectRoot）→ cwd（projectRoot 的回退）。
// 此前回退是旧锚 <script>/../..：插件形态下它解析到市场仓的 plugins/，台账读错目录却不报错；
// projectRoot() 的回退是 cwd，源仓夹具（复制进 <tmp>/.agents/scripts/ 且 cwd=<tmp>）行为不变。
const ROOT = findProjectRoot() || projectRoot();

const argMonth = (process.argv.find((a) => a.startsWith('--month=')) || '').split('=')[1] || null;
const WRITE = process.argv.includes('--write');

function fail(msg) {
  console.error(`agg-delegations: ${msg}`);
  process.exit(1);
}

function parseTableRows(sectionText) {
  return sectionText
    .split(/\r?\n/)
    .filter((l) => /^\|/.test(l.trim()))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((cols) => !/^\s*$/.test(cols[0]) && /^\d{4}-\d{2}-\d{2}$/.test(cols[0])); // 只留数据行（首列是日期；表头/分隔行随之滤除）
}

function parseResult(raw) {
  const r = (raw || '').trim();
  if (/^一次通过$/.test(r)) return { kind: 'pass', rework: 0 };
  const m = r.match(/^返工×(\d+)$/);
  if (m) return { kind: 'rework', rework: parseInt(m[1], 10) };
  if (/^主兜底$/.test(r)) return { kind: 'fallback', rework: 1 };
  if (/^返工待修$/.test(r)) return { kind: 'pending', rework: 0 };
  return { kind: 'unknown', rework: 0 };
}

// splitTables：按表头签名识别两张结果表——节标题只服务人类阅读，表头才是数据边界
// （2026-09-24 修复：曾按 `## 委派结果` 节标题定位，节结构漂移时已有记录被静默读成「台账为空」）
function splitTables(text) {
  const tables = { delegated: [], self: [] };
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) {
      // 表内空行不结束当前表（2026-10-10：空行曾把其后数据行静默丢掉）。
      // 非空且非 | 行（节标题、说明文字）才出表。
      if (line.trim() === '' && cur) continue;
      cur = null;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.some((c) => c.startsWith('被委派方'))) { cur = 'delegated'; continue; } // 委派表表头
    if (cells[0] === '日期' && cells.some((c) => c.startsWith('任务一句话'))) { cur = 'self'; continue; } // 自做表表头（委派表已被上一行截走）
    if (cur) tables[cur].push(line); // 表体行（含分隔行——parseTableRows 会滤掉）
  }
  return tables;
}

// readLedger(root)：读主台账 + delegations.d/ 分片并解析入账（2026-10-10 参数化 root 供测试进程内调用）。
// 读失败一律 fail-loud（throw，main 统一 fail()）——单分片读失败曾静默吞掉，指标缺数会喂错扩容门。
// 分片遍历单源 = ledger-shards.readLedger（ledger-shard-ledgers：原实现自写一份，
// 与 check-loop-kit / wf-journal 三处并存 = 口径漂移面）；本函数保留 fail-loud 包装。
function readLedger(root = ROOT) {
  const ledgerPath = path.join(root, 'workflow', 'delegations.md');
  if (!fs.existsSync(ledgerPath)) throw new Error(`找不到 ${ledgerPath}`);
  let mainText;
  let shardTexts;
  try {
    const r = readLedgerShards(root, 'delegations');
    mainText = r.main;
    shardTexts = r.shards.map((s) => s.text);
  } catch (err) {
    throw new Error(`台账读取失败: ${ledgerPath} (${err.message})`);
  }
  const allTexts = [mainText, ...shardTexts];
  const shardCount = shardTexts.length;

  const allDelegated = [];
  const allSelfDone = [];

  for (const t of allTexts) {
    const tables = splitTables(t);
    // 返工原因（2026-10-11 C3）：末列追加、存量行无该列 → 空 = 未记（不回填）。委派表第 6 格 / 自做表第 5 格。
    allDelegated.push(...parseTableRows(tables.delegated.join('\n')).map((c) => ({
      scope: '委派',
      date: c[0],
      actor: c[1],
      task: c[2] || '',
      result: c[3] || '',
      cause: c[5] || '',
    })));
    allSelfDone.push(...parseTableRows(tables.self.join('\n')).map((c) => ({
      scope: '自做',
      date: c[0],
      actor: '主智能体',
      task: c[1] || '',
      result: c[2] || '',
      cause: c[4] || '',
    })));
  }

  const rows = allDelegated.concat(allSelfDone);
  const text = allTexts.join('\n');
  // 日期数据行必须全部入账。零行且文件里仍有日期行 = 表头不可识别（结构漂移）。
  // 入账行少于日期行 = 部分截断（2026-10-10：此前只在零行时 fail-loud，空行截掉后半张表不报）。
  const dated = text.split(/\r?\n/).filter((l) => /^\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l)).length;
  if (dated > rows.length) {
    // 数据源含分片时点名分片——漂移可能位于分片内，只报主台账路径会误导排障
    const shardHint = shardCount > 0 ? `（数据源含 delegations.d/ 分片 ${shardCount} 个，漂移可能位于分片内）` : '';
    if (!rows.length) {
      throw new Error(`台账结构漂移：${ledgerPath} 存在日期开头的数据行但未识别到结果表（委派表表头须含「被委派方」列，自做表表头须为「日期 | 任务一句话 | 结果 | 备注」）${shardHint}`);
    }
    throw new Error(`台账被截断：${ledgerPath} 有 ${dated} 行日期数据，解析入账 ${rows.length} 行。表内空行不再结束表；仍少算说明有日期行落在已结束的表之外${shardHint}`);
  }
  return applyReworkLegacy(rows, root);
}

// 任务键：原因列为空时用来对齐 workflow/archive/rework-cause-legacy.md。哈希的是任务单元格原文（trim 后），
// 不含备注——改备注不换键，改任务句子才会脱钩。不回写 delegations.md。
function taskKey(task) {
  return createHash('sha256').update(String(task || ''), 'utf8').digest('hex').slice(0, 12);
}

function loadReworkLegacy(root) {
  const file = path.join(root, 'workflow', 'archive', 'rework-cause-legacy.md');
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const [date, scope, result, key, judgment] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (judgment !== '复核采纳' && judgment !== '实现失败') {
      console.error(`⚠️ rework-cause-legacy 判定非法，跳过：${date} ${key} ${judgment}`);
      continue;
    }
    const id = `${date}|${scope}|${result}|${key}`;
    if (map.has(id)) {
      console.error(`⚠️ rework-cause-legacy 重复行，保留首行：${id}`);
      continue;
    }
    map.set(id, judgment);
  }
  return map;
}

// 显式原因优先。只补结果为 返工×N 且原因列为空的行。主兜底不读这张表（门 4 不豁免）。
function applyReworkLegacy(rows, root) {
  const map = loadReworkLegacy(root);
  if (!map.size) return rows;
  return rows.map((r) => {
    if ((r.cause || '').trim()) return r;
    if (parseResult(r.result).kind !== 'rework') return r;
    const hit = map.get(`${r.date}|${r.scope}|${r.result}|${taskKey(r.task)}`);
    if (hit === '复核采纳') return { ...r, cause: ADOPT_CAUSE };
    if (hit === '实现失败') return { ...r, judgedFailure: true };
    return r;
  });
}

function countIncidents(root = ROOT) {
  const byMonth = {};
  const bump = (f) => {
    const m = f.match(/^(\d{4}-\d{2})-\d{2}.*\.md$/);
    if (m) byMonth[m[1]] = (byMonth[m[1]] || 0) + 1;
  };
  // 活跃目录直下 + 归档件（2026-10-13 关单即归档：incident 终态后 git mv 进 workflow/archive/<终态月>/incidents/，
  // 文件名仍带发生日期）——归档不出账则月度 incident 计数随归档静默缩水，故按文件名月份合并计数
  const liveDir = path.join(root, 'workflow', 'incidents');
  if (fs.existsSync(liveDir)) for (const f of fs.readdirSync(liveDir)) bump(f);
  const archiveRoot = path.join(root, 'workflow', 'archive');
  if (fs.existsSync(archiveRoot)) {
    for (const batch of fs.readdirSync(archiveRoot)) {
      const dir = path.join(archiveRoot, batch, 'incidents');
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) bump(f);
    }
  }
  return byMonth;
}

// 门槛（board-kb-p1 对齐 workflow/delegations.md §并发扩容门槛声明——doc 为权威）：
//   月度口径项：一次完成率 ≥90% ｜ 实现失败返工次数 = 0 ｜ 主兜底次数 = 0
//   （2026-10-12）门 3 不再把「复核采纳」算进必须为 0 的次数：结果仍是 返工×N，原因列 =
//   复核采纳（仅 P2 及以下且已采纳）的次数留在平均返工这个测量列里，不挡扩容。
//   原因空缺或非该枚举的 返工×N 仍算实现失败（存量不回填，未记继续挡门）。
//   门 4 的主兜底恒为实现失败：原因写成复核采纳也不豁免，且它的 +1 不再顺带撞开门 3。
//   （2026-10-14 度量分层）门 2 改挂「实现面一次通过率」=（一次通过 + 复核采纳行）÷ 有效任务——复核采纳行
//   实现面本身未失败，计入分子；混合一次通过率降为测量列。评审 P2 密度单列门 7 观察项（不挡门）：
//   L2/L3 强制评审的设计目的就是挑刺，混算反向激励「少评审凑指标」。
//   旧「平均返工≤0.3 / 兜底≤10%」与「全部返工次数 = 0」两条已退役。
//   样本护栏项（脚本侧统计可信度门槛，非口径分叉）：月样本量 ≥20 ｜ 委派样本 ≥5
//   连续性：扩容需「本月 + 上一自然月」连续两月月度口径全达标（delegations.md「连续两个月」）
const GATE = { minSample: 20, minPassRate: 0.9, minDelegated: 5 };
const ADOPT_CAUSE = '复核采纳';

// 返工原因枚举（2026-10-11 C3，权威 = workflow/delegations.md 记法节）：口径 = 委派侧可控改进面的分类，
// 用于把「一次通过率低」从可观测升级为可归因（扩容门的致动侧数据）。枚举外取值一律计「未记」。
// 复核采纳（2026-10-12）不是失败类：只从门 3 的实现失败次数里剔除，仍进入原因直方图与平均返工。
const CAUSES = ['角色契约', '任务边界', '需求歧义', '环境', '其他', ADOPT_CAUSE];

// 复核采纳只修饰 返工×N。主兜底即使写了这个原因也仍是实现失败（门 4 不豁免）。
function isReviewAdoption(row) {
  return parseResult(row.result).kind === 'rework' && (row.cause || '').trim() === ADOPT_CAUSE;
}

// 返工原因列生效锚（权威 = workflow/delegations.md 记法节「2026-10-11 C3 起」）：
// 锚前行留空是本仓政策（存量不回填），锚后留空才是真欠记。两者混报会让快照的「未记」
// 读起来像欠账（2026-10-17 口径分列；总口径与门 3 判据均不变——门 3 读 blockingRework，不看原因）。
const CAUSE_ANCHOR = '2026-10-11';

// causeSummary(rows)：返工/主兜底行的原因直方图 + 未记数（含存量行——空与非枚举值都算未记）
// unrecorded = 总数（兼容口径）；unrecordedPre = 锚前存量；unrecordedSince = 锚后待记（含无日期行）。
function causeSummary(rows) {
  const hist = {};
  let unrecorded = 0;
  let unrecordedPre = 0;
  let unrecordedSince = 0;
  for (const r of rows) {
    const p = parseResult(r.result);
    if (p.kind !== 'rework' && p.kind !== 'fallback') continue;
    // 判读表只定性「不是复核采纳」。不把它塞进「其他」，避免冒充已分子类。
    if (r.judgedFailure && !(r.cause || '').trim()) {
      hist['实现失败'] = (hist['实现失败'] || 0) + 1;
      continue;
    }
    if (CAUSES.includes((r.cause || '').trim())) {
      const k = (r.cause || '').trim();
      hist[k] = (hist[k] || 0) + 1;
    } else {
      unrecorded += 1;
      if (r.date && r.date < CAUSE_ANCHOR) unrecordedPre += 1;
      else unrecordedSince += 1; // 无日期行（fixture/历史残缺）按待记对待，不静默归入存量
    }
  }
  const text = [...CAUSES.filter((c) => hist[c]).map((c) => `${c}${hist[c]}`), ...[...new Set(Object.keys(hist).filter((k) => !CAUSES.includes(k)))].map((k) => `${k}${hist[k]}`)].join('·');
  return {
    hist,
    unrecorded,
    unrecordedPre,
    unrecordedSince,
    text: text ? `${text}${unrecorded ? `·未记${unrecorded}` : ''}` : (unrecorded ? `未记${unrecorded}` : ''),
  };
}

function metrics(rows) {
  // 未知结果（结果列拼错/漏填）单列计数，不混进「待修」——待修=未闭环，未知=记录本身有问题（2026-09-24 口径分离）
  const kinds = rows.map((r) => parseResult(r.result).kind);
  const valid = rows.filter((_, i) => kinds[i] !== 'pending' && kinds[i] !== 'unknown');
  const pending = kinds.filter((k) => k === 'pending').length;
  const unknown = kinds.filter((k) => k === 'unknown').length;
  let pass = 0, reworkSum = 0, blockingRework = 0, adoptedRework = 0, fallback = 0, adoptedRows = 0;
  for (const r of valid) {
    const p = parseResult(r.result);
    if (p.kind === 'pass') pass += 1;
    if (p.kind === 'fallback') fallback += 1;
    if (p.kind === 'rework') {
      if (isReviewAdoption(r)) { adoptedRework += p.rework; adoptedRows += 1; }
      else blockingRework += p.rework;
    }
    reworkSum += p.rework; // 测量列：含复核采纳与主兜底的 +1。门 3 只用 blockingRework
  }
  const delegatedValid = valid.filter((r) => r.scope === '委派');
  return {
    total: valid.length,
    pending,
    unknown,
    pass,
    passRate: valid.length ? pass / valid.length : null,
    // 实现面一次通过率（2026-10-14 度量分层）：复核采纳行 = 实现面本身未失败，计入分子（与门 3 豁免同源）。
    // 混合一次通过率（passRate）保留为测量列，不再是扩容门 2 判据。
    implPass: pass + adoptedRows,
    implPassRate: valid.length ? (pass + adoptedRows) / valid.length : null,
    adoptedRows,
    reworkSum,
    blockingRework,
    adoptedRework,
    avgRework: valid.length ? reworkSum / valid.length : null,
    delegatedValid: delegatedValid.length,
    fallback,
    fallbackRate: delegatedValid.length ? fallback / delegatedValid.length : null,
  };
}

function fmtRate(x, digits = 0) {
  return x == null ? '—' : `${(x * 100).toFixed(digits)}%`;
}
function fmtNum(x) {
  return x == null ? '—' : x.toFixed(2);
}

// gateMonth：单月门槛判定（pure，供测试）——口径项 + 样本护栏项分开列
function gateMonth(m) {
  const items = [];
  items.push({ no: 1, ok: m.total >= GATE.minSample, desc: `样本量 ${m.total}/${GATE.minSample}`, kind: '样本护栏' });
  items.push({ no: 2, ok: m.implPassRate != null && m.implPassRate >= GATE.minPassRate, desc: `实现面一次通过率 ${fmtRate(m.implPassRate)}≥90%（混合 ${fmtRate(m.passRate)} 仅测量）`, kind: '口径' });
  items.push({ no: 3, ok: m.blockingRework === 0, desc: `实现失败返工 ${m.blockingRework}=0（复核采纳 ${m.adoptedRework} 不计）`, kind: '口径' });
  items.push({ no: 4, ok: m.fallback === 0, desc: `主兜底 ${m.fallback}=0（恒为实现失败，复核采纳不豁免）`, kind: '口径' });
  items.push({ no: 5, ok: m.delegatedValid >= GATE.minDelegated, desc: `委派样本 ${m.delegatedValid}≥5`, kind: '样本护栏' });
  items.push({ no: 6, ok: null, desc: '门禁不失守（人工对照当月 incident 定性）', kind: '人工' });
  items.push({ no: 7, ok: null, desc: `评审 P2 密度（观察项，不挡门）：复核采纳 ${m.adoptedRows} 行`, kind: '观察' });
  return { items, monthOk: items.filter((i) => i.ok !== null).every((i) => i.ok) };
}

// expansionVerdict：连续两个月扩容判定（pure，供测试）——本月与上一自然月 monthOk 均真才「可扩容」；
// prevMissing = 无上月数据（首月/断档）；items 供未达标项列出
function expansionVerdict(monthOk, prevOk, prevMissing, items) {
  if (monthOk && prevOk) return '✅ 连续两月达标（可扩容，待人工确认门6）';
  if (monthOk && prevMissing) return '⚠️ 本月达标（连续性 1/2——上月无数据）';
  if (monthOk) return '⚠️ 本月达标（连续性 1/2——上月未达标）';
  const bad = (items || []).filter((i) => i.ok === false).map((i) => i.no).join('+');
  return `❌ 未达标（连续性中断）：${bad || '月度口径项未全过'}`;
}

// ---- 机器落表（snapshot-machine-write；同 metrics.md「生成物 + GENERATED 标记托管」模式）----
// 表头在区内、说明行在区外；--write 只重写目标月数据行，历史行冻结——需显式 --month=YYYY-MM 才再生某
// 历史月，且重算基于当前台账与当前 incidents 目录，与「当时落表值」可能不同（显式操作的语义，不静默发生）。
const GEN_BEGIN = '<!-- GENERATED:BEGIN — agg-delegations.mjs --write 托管（同月重写、他月不触碰、按月升序；手工行写在本标记之外） -->';
const GEN_END = '<!-- GENERATED:END -->';
const SNAP_HEAD = '| 月份 | 有效任务 | 一次通过率 | 实现面一次通过率 | 平均返工次数 | 返工原因分布 | 主兜底占比 | 月度 incident | 扩容门 | 备注 |\n|------|----------|------------|------------------|--------------|--------------|------------|---------------|--------|------|';

// upsertSnapshotRow(text, ym, row)：纯函数（供测试）——GENERATED 区内同月重写 / 新月按升序插入；
// 缺标记抛错（标记区须先安装，不在手工内容区静默写表）；返回新全文（生成器只写 LF，与 gen-workflow-metrics 同约定）。
function upsertSnapshotRow(text, ym, row) {
  const beginAt = text.indexOf(GEN_BEGIN);
  const endAt = text.indexOf(GEN_END);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    throw new Error('delegations.md 缺 GENERATED 标记区——先安装 §月度聚合快照标记（--write 不在手工内容区静默写表）');
  }
  const before = text.slice(0, beginAt + GEN_BEGIN.length);
  const after = text.slice(endAt);
  const rows = text.slice(beginAt + GEN_BEGIN.length, endAt)
    .split(/\r?\n/)
    .filter((l) => /^\|\s*\d{4}-\d{2}\s*\|/.test(l) && !l.startsWith(`| ${ym} `));
  rows.push(row);
  rows.sort((a, b) => a.slice(2, 9).localeCompare(b.slice(2, 9)));
  return `${before}\n${[SNAP_HEAD, ...rows].join('\n')}\n\n${after}`;
}

function main() {
  let rows;
  try {
    rows = readLedger();
  } catch (err) {
    fail(err.message);
  }
  const incidents = countIncidents();

  const byMonth = {};
  for (const r of rows) {
    const ym = r.date.slice(0, 7);
    (byMonth[ym] = byMonth[ym] || []).push(r);
  }
  const allMonths = Object.keys(byMonth).sort();
  const months = allMonths.filter((m) => !argMonth || m === argMonth);
  // 全月链先算 monthOk：「连续两月」判定不受 --month 显示过滤影响（曾把历史月在过滤后误判「上月无数据」）；
  // --write 落表行的 verdict 同链取值（snapshot-machine-write）。
  const monthOkByYm = new Map(allMonths.map((ym) => [ym, gateMonth(metrics(byMonth[ym])).monthOk]));

  console.log(`# 量化证据聚合（${argMonth || '全部月份'}） 生成于 ${new Date().toISOString().slice(0, 10)}\n`);

  const snapshotRows = [];
  for (const ym of months) {
    const m = metrics(byMonth[ym]);
    const { items, monthOk } = gateMonth(m);
    const prevYm = (() => { const [y, mo] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
    const verdict = expansionVerdict(monthOk, monthOkByYm.get(prevYm), !allMonths.includes(prevYm), items);
    const causes = causeSummary(byMonth[ym]);
    console.log(`## ${ym}`);
    console.log(`  有效任务 ${m.total}（待修 ${m.pending}${m.unknown ? `、未知结果 ${m.unknown}` : ''}）｜一次通过 ${m.pass}（${fmtRate(m.passRate)}）｜实现面一次通过率 ${fmtRate(m.implPassRate)}｜返工总次数 ${m.reworkSum}（实现失败 ${m.blockingRework}、复核采纳 ${m.adoptedRework}、平均 ${fmtNum(m.avgRework)}）｜主兜底 ${m.fallback}/${m.delegatedValid}（${fmtRate(m.fallbackRate)}）｜incident ${incidents[ym] || 0} 起`);
    if (causes.text) console.log(`  返工原因 ${causes.text}（其中锚前存量${causes.unrecordedPre}·锚后待记${causes.unrecordedSince}；${CAUSE_ANCHOR} 起新行必填，存量不回填）`);
    for (const i of items) console.log(`  门${i.no}[${i.kind}] ${i.ok === null ? '[人工]' : i.ok ? '✅' : '❌'} ${i.desc}`);
    console.log(`  扩容门判定：${verdict}\n`);
    const unrecNote = causes.unrecordedSince
      ? `、返工原因锚后待记${causes.unrecordedSince}${causes.unrecordedPre ? `（另有存量${causes.unrecordedPre}按政策不回填）` : ''}`
      : (causes.unrecordedPre ? `、返工原因未记${causes.unrecordedPre}全为锚前存量（政策不回填，非欠账）` : '');
    snapshotRows.push(`| ${ym} | ${m.total} | ${fmtRate(m.passRate)} | ${fmtRate(m.implPassRate)} | ${fmtNum(m.avgRework)} | ${causes.text || '—'} | ${fmtRate(m.fallbackRate)} | ${incidents[ym] || 0} | ${verdict} | 样本含待修${m.pending}${m.unknown ? `、未知${m.unknown}` : ''}${unrecNote}${m.adoptedRework ? `、复核采纳${m.adoptedRework}不计门3` : ''}；落表 ${new Date().toISOString().slice(0, 10)} |`);
  }

  if (!argMonth && rows.length) {
    const m = metrics(rows);
    console.log(`## 全量累计`);
    console.log(`  有效任务 ${m.total}（待修 ${m.pending}${m.unknown ? `、未知结果 ${m.unknown}` : ''}）｜一次通过 ${fmtRate(m.passRate)}｜平均返工 ${fmtNum(m.avgRework)}｜主兜底 ${fmtRate(m.fallbackRate)}｜incident 合计 ${Object.values(incidents).reduce((a, b) => a + b, 0)} 起\n`);
  }

  console.log(`## ${WRITE ? '快照行（--write 落表口径）' : '可粘贴快照行（粘到 workflow/delegations.md §月度聚合快照）'}`);
  for (const r of snapshotRows) console.log(r);

  if (!rows.length) {
    console.log('\n（台账为空：尚无记录，扩容门自然未通过）');
  }

  if (WRITE) {
    const target = argMonth || new Date().toISOString().slice(0, 7);
    const row = snapshotRows.find((r) => r.startsWith(`| ${target} `));
    if (!row) fail(`--write：${target} 无台账数据，未写入（落表须有当月数据）`);
    const docPath = path.join(ROOT, 'workflow', 'delegations.md');
    let text;
    try {
      text = fs.readFileSync(docPath, 'utf8');
    } catch (err) {
      fail(`--write 读台账失败：${err.message}`);
    }
    let next;
    try {
      next = upsertSnapshotRow(text, target, row);
    } catch (err) {
      fail(err.message);
    }
    if (next === text) {
      console.log(`✅ ${target} 行与 GENERATED 区一致，未改动`);
    } else {
      fs.writeFileSync(docPath, next, 'utf8');
      console.log(`✅ 已写入 workflow/delegations.md §月度聚合快照（${target} 行 GENERATED 区；他月行未触碰）`);
    }
  }
}

// isMain 守卫 + 纯函数导出（board-kb-p1：gateMonth / expansionVerdict 供测试 import，import 不执行 main）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
export { parseResult, metrics, gateMonth, expansionVerdict, GATE, readLedger, upsertSnapshotRow, causeSummary, isReviewAdoption, taskKey, countIncidents, CAUSES, ADOPT_CAUSE, CAUSE_ANCHOR, GEN_BEGIN, GEN_END };
