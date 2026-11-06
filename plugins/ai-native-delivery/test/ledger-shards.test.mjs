#!/usr/bin/env node
// ledger-shards.test.mjs — 分片读写单源 fixture（2026-10-13 ledger-shard-ledgers）
// 覆盖：数据行判定（含节限定）/ 月提取 / 主台账∪分片读 / 迁移幂等 / 追加 / 表头自带 / fail-loud
// 　　/ 多进程并发追加不丢行（S23，2026-11-01）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LEDGERS, isDataRow, inScope, monthOf, readLedger, readLedgerText,
  splitMain, appendRows, shardPathFor, renderShard, withLedgerLock,
} from '../scripts/ledger-shards.mjs';

// 2026-11-05 CLI 写侧 fail-closed（非 git 目录拒写台账，paths.mjs testAnyRootAllowed）的
// **仅测试**逃生门：本套件夹具是非 git 临时目录（历史「就地操作」契约）。双条件须同时
// NODE_ENV=test（生产路径不设，沿 CONFIRM_DOC_TEST_TTY 信任边界口径）。spawnSync 未显式传
// env 时子进程默认继承本进程环境，套件内既有 CLI 场景（S24 --split 等）零改动。
process.env.NODE_ENV = 'test';
process.env.LEDGER_CLI_TEST_ANYROOT = '1';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${desc}`); }
  else { fail++; console.log(`FAIL ${desc}${detail ? '\n  ' + detail : ''}`); }
};
const mkroot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-shards-'));
  fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
  return root;
};
const wf = (root, ...p) => path.join(root, 'workflow', ...p);

// ---- S1 数据行判定：表格式（delegations/papercuts）----
{
  check('S1a delegations 数据行命中', isDataRow('delegations', '| 2026-10-01 | ui-verifier | 任务 | 一次通过 | 备注 |'));
  check('S1b delegations 表头排除', !isDataRow('delegations', '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |'));
  check('S1c delegations 分隔行排除', !isDataRow('delegations', '|------|----------------|------------|------|------|----------|'));
  check('S1d papercuts 数据行命中', isDataRow('papercuts', '| 2026-10-11 | `.agents/x.mjs` | 症状 | 拟修 |'));
  check('S1e papercuts 表头排除', !isDataRow('papercuts', '| 日期 | 位置 | 症状 | 拟修 |'));
  check('S1f 说明行不命中', !isDataRow('papercuts', '> 说明文字，非数据行'));
}

// ---- S2 节限定：regression-checklist 只迁「防复发验证」节 ----
{
  check('S2a 防复发验证节在范围内', inScope('regression-checklist', '防复发验证（incident 追加区）'));
  check('S2b 模块节不在范围内', !inScope('regression-checklist', '物资编码管理（material-codes）'));
  check('S2c 无 section 限定的台账恒在范围', inScope('delegations', '任意节') && inScope('papercuts', ''));
  check('S2d 防复发数据行命中', isDataRow('regression-checklist', '| 2026-09-11 仓库结构树搜索卡顿难用 | 条目 | 落点 |'));
  check('S2e 防复发表头排除', !isDataRow('regression-checklist', '| 来源 incident | 回归条目 | 落点 |'));
  check('S2e2 防复发表头(执法者列)排除', !isDataRow('regression-checklist', '| 来源 incident | 回归条目 | 落点 | 执法者 |'));
}

// ---- S3 月提取 ----
{
  check('S3a 表格式取首列日期月', monthOf('delegations', '| 2026-10-01 | x |') === '2026-10');
  check('S3b 无日期返回空', monthOf('delegations', '| 无日期 | x |') === '');
}

// ---- S4 读：主台账 ∪ 分片 ----
{
  const root = mkroot();
  fs.mkdirSync(wf(root, 'papercuts.d'), { recursive: true });
  fs.writeFileSync(wf(root, 'papercuts.md'), '# 台账\n\n| 日期 | 位置 | 症状 | 拟修 |\n|------|------|------|------|\n| 2026-10-01 | 主表行 | s | f |\n', 'utf8');
  fs.writeFileSync(wf(root, 'papercuts.d', '2026-09.md'), renderShard('papercuts', []) + '| 2026-09-01 | 分片行 | s | f |\n', 'utf8');
  const r = readLedger(root, 'papercuts');
  check('S4a 主台账 + 分片都读到', r.main.includes('主表行') && r.shards.length === 1 && r.all.includes('分片行'));
  check('S4b all 含两侧', r.all.includes('主表行') && r.all.includes('分片行'));
  check('S4c readLedgerText 等价 all', readLedgerText(root, 'papercuts') === r.all);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S5 读：分片按文件名排序（月序 = 时间序）----
{
  const root = mkroot();
  fs.mkdirSync(wf(root, 'papercuts.d'), { recursive: true });
  fs.writeFileSync(wf(root, 'papercuts.md'), '# 台账\n', 'utf8');
  fs.writeFileSync(wf(root, 'papercuts.d', '2026-10.md'), '| 2026-10-01 | 十月 | s | f |\n', 'utf8');
  fs.writeFileSync(wf(root, 'papercuts.d', '2026-09.md'), '| 2026-09-01 | 九月 | s | f |\n', 'utf8');
  const r = readLedger(root, 'papercuts');
  check('S5 分片按文件名排序（09 在 10 前）', r.shards[0].file === '2026-09.md' && r.shards[1].file === '2026-10.md');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S6 读：无分片目录 → 等价原读法（向后兼容）----
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'papercuts.md'), '# 台账\n| 2026-10-01 | 行 | s | f |\n', 'utf8');
  const r = readLedger(root, 'papercuts');
  check('S6 无分片目录 → shards 空、all = main', r.shards.length === 0 && r.all === r.main);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S7 迁移：主台账数据行按月迁出，非数据行保留 ----
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'papercuts.md'), [
    '# 台账', '', '> 说明', '',
    '| 日期 | 位置 | 症状 | 拟修 |', '|------|------|------|------|',
    '| 2026-09-01 | 九月行 | s | f |',
    '| 2026-10-01 | 十月行 | s | f |',
    '| 2026-10-02 | 十月行2 | s | f |', '',
  ].join('\n'), 'utf8');
  const r = splitMain(root, 'papercuts');
  check('S7a 迁移计数正确', r.moved['2026-09'] === 1 && r.moved['2026-10'] === 2, JSON.stringify(r.moved));
  const main = fs.readFileSync(wf(root, 'papercuts.md'), 'utf8');
  check('S7b 主台账保留说明与表头、无数据行', main.includes('# 台账') && main.includes('| 日期 |') && !main.includes('九月行') && !main.includes('十月行'));
  check('S7c 分片自带表头', fs.readFileSync(wf(root, 'papercuts.d', '2026-09.md'), 'utf8').includes('| 日期 | 位置 | 症状 | 拟修 |'));
  check('S7d 分片含数据行', fs.readFileSync(wf(root, 'papercuts.d', '2026-10.md'), 'utf8').includes('十月行2'));
  // 迁移后读回：数据不丢
  const back = readLedgerText(root, 'papercuts');
  check('S7e 迁移后读回数据完整', back.includes('九月行') && back.includes('十月行') && back.includes('十月行2'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S8 迁移幂等：二次 split 无数据行可迁 ----
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'papercuts.md'), '| 日期 | 位置 | 症状 | 拟修 |\n|------|------|------|------|\n| 2026-10-01 | 行 | s | f |\n', 'utf8');
  splitMain(root, 'papercuts');
  const r2 = splitMain(root, 'papercuts');
  check('S8 二次迁移 0 行（幂等）', Object.keys(r2.moved).length === 0, JSON.stringify(r2.moved));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S9 节限定迁移：regression-checklist 只迁防复发节 ----
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'regression-checklist.md'), [
    '# 回归清单', '',
    '## 物资编码管理（material-codes）', '',
    '- [ ] 模块条目（不迁）', '',
    '## 防复发验证（incident 追加区）', '',
    '| 来源 incident | 回归条目 | 落点 |', '|---------------|----------|------|',
    '| 2026-09-11 某事故 | 条目 | 落点 |', '',
  ].join('\n'), 'utf8');
  const r = splitMain(root, 'regression-checklist');
  check('S9a 只迁防复发节 1 行', r.moved['2026-09'] === 1, JSON.stringify(r.moved));
  const main = fs.readFileSync(wf(root, 'regression-checklist.md'), 'utf8');
  check('S9b 模块节条目留守', main.includes('- [ ] 模块条目（不迁）'));
  check('S9c 防复发数据行已迁出', !main.includes('2026-09-11 某事故'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S10 appendRows：追加进指定月分片，缺表头则补 ----
{
  const root = mkroot();
  appendRows(root, 'papercuts', ['| 2026-10-13 | 新行 | s | f |']);
  const p = shardPathFor(root, 'papercuts', '2026-10');
  check('S10a 分片文件已建', fs.existsSync(p));
  const txt = fs.readFileSync(p, 'utf8');
  check('S10b 自带表头 + 数据行', txt.includes('| 日期 | 位置 | 症状 | 拟修 |') && txt.includes('新行'));
  appendRows(root, 'papercuts', ['| 2026-10-14 | 第二行 | s | f |']);
  const txt2 = fs.readFileSync(p, 'utf8');
  check('S10c 二次追加不重复表头', (txt2.match(/\| 日期 \| 位置/g) || []).length === 1 && txt2.includes('第二行'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S11 appendRows：显式 month 覆盖（无日期行）----
{
  const root = mkroot();
  appendRows(root, 'papercuts', ['| 无日期行 | s | f |'], { month: '2026-10' });
  check('S11 显式 month 生效', fs.existsSync(shardPathFor(root, 'papercuts', '2026-10')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S12 fail-loud：无法确定月 → 抛（不静默吞）----
{
  const root = mkroot();
  let thrown = null;
  try { appendRows(root, 'papercuts', ['| 无日期行 | s | f |']); } catch (e) { thrown = e; }
  check('S12 无日期且未传 month → 抛错', thrown !== null && /无法确定分片月/.test(thrown.message));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S13 fail-loud：分片目录读取异常 → 抛 ----
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'papercuts.md'), '# 台账\n', 'utf8');
  fs.mkdirSync(wf(root, 'papercuts.d'), { recursive: true });
  fs.mkdirSync(wf(root, 'papercuts.d', 'bad.md')); // 目录冒充分片 → readFileSync EISDIR
  let thrown = null;
  try { readLedger(root, 'papercuts'); } catch (e) { thrown = e; }
  check('S13 分片读失败 → 抛（不静默吞）', thrown !== null && /分片读取失败/.test(thrown.message));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S14 台账清单单源：四个台账都在册（2026-10-25 优化5 收编 deploy-observations） ----
{
  check('S14 四台账在册', Object.keys(LEDGERS).sort().join(',') === 'delegations,deploy-observations,papercuts,regression-checklist');
}

// ---- S15 delegations 双表分组：分片须两张表头都带且行归入正确表 ----
// （2026-10-13 迁移实测踩中：只带一张表头 → splitTables 把另一张的行按错表解析，240 任务塌成 100）
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'delegations.md'), [
    '# 台账', '',
    '## 委派结果', '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|----------------|------------|------|------|----------|',
    '| 2026-09-01 | ui-verifier | 委派任务 | 一次通过 | 备注 | |',
    '',
    '## 自做任务结果', '',
    '| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|------------|------|------|----------|',
    '| 2026-09-02 | 自做任务 | 一次通过 | 备注 | |',
    '',
  ].join('\n'), 'utf8');
  splitMain(root, 'delegations');
  const shard = fs.readFileSync(wf(root, 'delegations.d', '2026-09.md'), 'utf8');
  check('S15a 分片含委派表头', shard.includes('| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |'));
  check('S15b 分片含自做表头', shard.includes('| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |'));
  // 委派行须在委派表头之后、自做表头之前
  const iDeleg = shard.indexOf('被委派方(模型)');
  const iSelf = shard.indexOf('| 日期 | 任务一句话');
  const iRow = shard.indexOf('委派任务');
  check('S15c 委派行归入委派表（表头之后、自做表头之前）', iDeleg < iRow && iRow < iSelf, `deleg=${iDeleg} row=${iRow} self=${iSelf}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S16 renderShard 分组：有行时不出空表头 ----
{
  const onlyDeleg = renderShard('delegations', [{ line: '| 2026-09-01 | a | b | c | d | e |', section: '委派结果' }]);
  check('S16a 只有委派行 → 不出自做表头', onlyDeleg.includes('被委派方(模型)') && !onlyDeleg.includes('| 日期 | 任务一句话'));
  const onlySelf = renderShard('delegations', [{ line: '| 2026-09-01 | b | c | d | e |', section: '自做任务结果' }]);
  check('S16b 只有自做行 → 不出委派表头', !onlySelf.includes('被委派方(模型)') && onlySelf.includes('| 日期 | 任务一句话'));
  const empty = renderShard('delegations', []);
  check('S16c 无行 → 出全部表头（空分片骨架）', empty.includes('被委派方(模型)') && empty.includes('| 日期 | 任务一句话'));
}

// ---- S17 幂等：分片已存在时重跑 split 不重复追加 ----
// （2026-10-13 实测踩中：无去重时二次 split 把 58 行重复写入，120 行 vs 62 行）
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'papercuts.md'), [
    '| 日期 | 位置 | 症状 | 拟修 |', '|------|------|------|------|',
    '| 2026-09-01 | 行A | s | f |',
    '| 2026-09-02 | 行B | s | f |', '',
  ].join('\n'), 'utf8');
  splitMain(root, 'papercuts');
  const after1 = fs.readFileSync(wf(root, 'papercuts.d', '2026-09.md'), 'utf8');
  // 模拟「主台账被还原后重跑」（分片仍在）
  fs.writeFileSync(wf(root, 'papercuts.md'), [
    '| 日期 | 位置 | 症状 | 拟修 |', '|------|------|------|------|',
    '| 2026-09-01 | 行A | s | f |',
    '| 2026-09-02 | 行B | s | f |', '',
  ].join('\n'), 'utf8');
  splitMain(root, 'papercuts');
  const after2 = fs.readFileSync(wf(root, 'papercuts.d', '2026-09.md'), 'utf8');
  check('S17 重跑 split 不重复追加（幂等）', after1 === after2, `len1=${after1.length} len2=${after2.length}`);
  const rows = after2.split(/\r?\n/).filter((l) => /^\| 20/.test(l));
  check('S17b 行数仍为 2', rows.length === 2, `rows=${rows.length}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S18 appendRows 幂等：同行走两次只落一次 ----
{
  const root = mkroot();
  appendRows(root, 'papercuts', ['| 2026-10-13 | 同行 | s | f |']);
  appendRows(root, 'papercuts', ['| 2026-10-13 | 同行 | s | f |']);
  const txt = fs.readFileSync(shardPathFor(root, 'papercuts', '2026-10'), 'utf8');
  const rows = txt.split(/\r?\n/).filter((l) => /^\| 20/.test(l));
  check('S18 同行走两次只落一次', rows.length === 1, `rows=${rows.length}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S20 appendRows --section：已有双表时委派行插入委派节，不带 section 仍落文末 ----
{
  const root = mkroot();
  appendRows(root, 'delegations', ['| 2026-10-15 | model | 委派甲 | 一次通过 | 备注 | |'], { section: '委派结果' });
  appendRows(root, 'delegations', ['| 2026-10-15 | 自做甲 | 一次通过 | 备注 | |'], { section: '自做任务结果' });
  appendRows(root, 'delegations', ['| 2026-10-15 | model | 委派乙 | 一次通过 | 备注 | |'], { section: '委派结果' });
  appendRows(root, 'delegations', ['| 2026-10-15 | 自做乙 | 一次通过 | 备注 | |']);
  const shard = fs.readFileSync(shardPathFor(root, 'delegations', '2026-10'), 'utf8');
  const iSelf = shard.indexOf('## 自做任务结果');
  const iDelegRow = shard.indexOf('委派乙');
  const iSelfRow = shard.indexOf('自做乙');
  check('S22 后追加的委派行仍在自做节之前', iDelegRow >= 0 && iDelegRow < iSelf, shard);
  check('S22b 不带 section 的行落在文末', iSelf >= 0 && iSelf < iSelfRow, shard);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S19 嵌入 `|` 的行不丢（2026-10-13 实测踩中：4 行因列数虚高被 renderShard 丢弃）----
{
  const root = mkroot();
  const weird = '| 2026-09-17 | `.agents/x.mjs` | 正则 `[:=]\\s*["\']?` 含字面竖线 | 拟修 |';
  fs.writeFileSync(wf(root, 'papercuts.md'), [
    '| 日期 | 位置 | 症状 | 拟修 |', '|------|------|------|------|',
    '| 2026-09-01 | 正常行 | s | f |',
    weird, '',
  ].join('\n'), 'utf8');
  splitMain(root, 'papercuts');
  const shard = fs.readFileSync(wf(root, 'papercuts.d', '2026-09.md'), 'utf8');
  check('S19a 嵌入竖线的行不丢', shard.includes('含字面竖线'), shard.slice(0, 200));
  check('S19b 正常行也在', shard.includes('正常行'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S20 多表按节归属：委派行（含嵌入竖线）仍归委派表 ----
{
  const root = mkroot();
  const weirdDeleg = '| 2026-09-01 | ui-verifier | 任务含 `a|b` 竖线 | 一次通过 | 备注 | |';
  fs.writeFileSync(wf(root, 'delegations.md'), [
    '## 委派结果', '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|----------------|------------|------|------|----------|',
    weirdDeleg, '',
    '## 自做任务结果', '',
    '| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|------------|------|------|----------|',
    '| 2026-09-02 | 自做任务 | 一次通过 | 备注 | |', '',
  ].join('\n'), 'utf8');
  splitMain(root, 'delegations');
  const shard = fs.readFileSync(wf(root, 'delegations.d', '2026-09.md'), 'utf8');
  const iDeleg = shard.indexOf('被委派方(模型)');
  const iSelf = shard.indexOf('| 日期 | 任务一句话');
  const iWeird = shard.indexOf('任务含');
  check('S20 嵌入竖线的委派行仍归委派表', iDeleg < iWeird && iWeird < iSelf, `deleg=${iDeleg} weird=${iWeird} self=${iSelf}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S21 分片须带节标题（检查 18 的 inSec 门）----
// （2026-10-13 实测踩中：只带表头 → check-loop-kit.delegationResultRows 读到 0 行 → 37 条假告警）
{
  const root = mkroot();
  fs.writeFileSync(wf(root, 'delegations.md'), [
    '## 委派结果', '',
    '| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |',
    '|------|----------------|------------|------|------|----------|',
    '| 2026-09-01 | ui-verifier | 委派任务 | 一次通过 | 备注 | |', '',
  ].join('\n'), 'utf8');
  splitMain(root, 'delegations');
  const shard = fs.readFileSync(wf(root, 'delegations.d', '2026-09.md'), 'utf8');
  check('S21a 分片带 `## 委派结果` 节标题', /^##\s+委派结果\s*$/m.test(shard), shard.slice(0, 120));
  // 复刻 check-loop-kit.delegationResultRows 的 inSec 判据
  const targetSec = (l) => /^##\s+(委派结果|自做任务结果)\s*$/.test(l);
  let inSec = false;
  let rows = 0;
  for (const line of shard.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) { inSec = targetSec(line); continue; }
    if (!inSec || !/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!cells.length || cells.every((c) => /^[-: ]*$/.test(c))) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) continue;
    rows++;
  }
  check('S21b 检查 18 口径能读到分片行', rows === 1, `rows=${rows}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S22 分片月键校验（2026-10-27 路径逃逸修复）----
// 月键直接进 path.join → 不校验时 `--month ../../../../evil` 把台账写出 workflow/ 树（仓外 C:\evil.md）
{
  const root = mkroot();
  let thrown = null;
  try { shardPathFor(root, 'papercuts', '../../../../evil'); } catch (e) { thrown = e; }
  check('S22a 非法月键 → shardPathFor 抛错', thrown !== null && /月键非法/.test(thrown.message), thrown ? thrown.message : 'no throw');
  let thrown2 = null;
  try { appendRows(root, 'papercuts', ['| 2026-10-13 | x | s | f |'], { month: '../../../../evil' }); } catch (e) { thrown2 = e; }
  check('S22b appendRows 显式非法 month → 抛错（不落盘）', thrown2 !== null && /月键非法/.test(thrown2.message), thrown2 ? thrown2.message : 'no throw');
  check('S22c 仓外未落盘', !fs.existsSync(path.resolve(root, '../../../evil.md')));
  let thrown3 = null;
  try { shardPathFor(root, 'papercuts', '2026-13'); } catch (e) { thrown3 = e; }
  check('S22d 月份 13 判非法（不造无意义目录）', thrown3 !== null, thrown3 ? thrown3.message : 'no throw');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S23 并发追加不丢行（2026-11-01 修复回归）----
// 旧实现是 readFileSync 全文 → 内存拼 → writeFileSync 整写：后写者拿的是自己的陈旧快照，
// 把别人刚写的行整个抹掉，而 CLI 照样打印「✓ 追加 1 行」（市场审查实测 24 并发全 0 退出、
// 全打成功，落盘只有 18 行、缺 6）。同一缺陷 mcp/core.mjs:242-247 早已确认并改走
// appendFileSync，但那条修复没覆盖 --append 这条口——而 commands/deploy.md:57 与
// confirm-doc.mjs:464 明确引导用户与 agent 走它。
// 两点让这条断言在 CI 上是确定性的而非碰运气：
//   · 分片先撑到 ~1.6 MB：read→拼→write 的窗口拉长到毫秒级，重叠才可能发生（小分片下
//     旧实现也能"侥幸"全落，那种测试不守任何东西——本断言初版就是这么漏的，已修正）；
//   · 绝对时刻栅栏：所有子进程空转到同一个时间点才进入 appendRows，消除进程启动耗时带来的
//     错开，24 路真正同时进场。
// 正确实现（O_APPEND）在任何调度下都不会丢行，所以本断言只会漏报、不会误红。
{
  const root = mkroot();
  const modUrl = new URL('../scripts/ledger-shards.mjs', import.meta.url).href;
  const goEpoch = Date.now() + 2500; // 统一进场时刻
  // 子进程实参：argv[1]=root argv[2]=行 argv[3]=opts（'-'=空对象）argv[4]=台账名 argv[5]=栅栏时刻
  const spawnAppend = (name, line, opts) => spawn(process.execPath,
    ['-e', `import(${JSON.stringify(modUrl)}).then(m=>{const g=+process.argv[5];while(Date.now()<g){}return m.appendRows(process.argv[1],process.argv[4],[process.argv[2]],process.argv[3]==='-'?{}:JSON.parse(process.argv[3]));}).catch(e=>{console.error(String(e&&e.message||e));process.exit(1);})`,
     root, line, opts, name, String(goEpoch)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exitCode = (c) => new Promise((res) => { let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => res({ code, err })); });

  // 把分片撑大（直接落盘，不走被测函数）：1 行表头 + 40000 行数据 ≈ 1.6 MB
  const bigRows = Array.from({ length: 40000 }, (_, i) => `| 2026-11-01 | seed${i} | 撑窗口 | x |`);
  const shard = shardPathFor(root, 'papercuts', '2026-11');
  fs.mkdirSync(path.dirname(shard), { recursive: true });
  fs.writeFileSync(shard, `${bigRows.join('\n')}\n`, 'utf8');
  const SEED = bigRows.length;
  check('S23 前置：分片已撑到可复现规模', fs.statSync(shard).size > 1_000_000, `size=${fs.statSync(shard).size}`);

  // ① 文末追加路径（papercuts 无 section）：24 路并发各追一行
  const N = 24;
  const tailKids = [];
  for (let i = 0; i < N; i++) tailKids.push(spawnAppend('papercuts', `| 2026-11-02 | race-tail-${i} | s | f |`, '-'));
  const tailCodes = await Promise.all(tailKids.map(exitCode));
  const tailText = fs.readFileSync(shard, 'utf8');
  const tailRows = tailText.split(/\r?\n/).filter((l) => isDataRow('papercuts', l));
  check('S23a 并发追加无进程失败', tailCodes.every((r) => r.code === 0),
    JSON.stringify(tailCodes.map((r) => r.code)) + ' ' + (tailCodes.find((r) => r.code !== 0)?.err || ''));
  check(`S23b ${N} 路并发追加一行都不丢（旧实现拿陈旧快照整写，实测 24 路只落 18 行）`,
    tailRows.length === SEED + N, `期望 ${SEED + N}，实得 ${tailRows.length}`);
  check('S23c 每一路各自的行确实落盘',
    Array.from({ length: N }, (_, i) => i).every((i) => tailText.includes(`race-tail-${i}`)),
    '有行被陈旧快照整写抹掉');

  // ② 特定节插入路径（delegations 带 section，读-改-写不可避免 → 写前指纹校验 + 重读重试）。
  // 这一路径的契约不是「一定成功」而是「绝不谎报成功」：极端抢写下允许抛错（fail-loud），
  // 不允许丢行还回 exit 0。所以断言按"成功的那几路必须真的落盘"来判，不误红也不放过假绿。
  const secShard = shardPathFor(root, 'delegations', '2026-11');
  fs.mkdirSync(path.dirname(secShard), { recursive: true });
  const secHead = '## 委派结果\n\n| 日期 | 被委派方(模型) | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|----------------|------------|------|------|----------|\n';
  const secRows = Array.from({ length: 40000 }, (_, i) => `| 2026-11-01 | m-seed${i} | 撑窗口 | 一次通过 |  | |`);
  fs.writeFileSync(secShard, `${secHead}${secRows.join('\n')}\n`, 'utf8');
  const secKids = [];
  for (let i = 0; i < N; i++) {
    secKids.push(spawnAppend('delegations', `| 2026-11-02 | m${i} | 委派${i} | 一次通过 |  | |`, JSON.stringify({ section: '委派结果' })));
  }
  const secRes = await Promise.all(secKids.map(exitCode));
  const secText = fs.readFileSync(secShard, 'utf8');
  const lied = secRes.map((r, i) => ({ r, i })).filter(({ r, i }) => r.code === 0 && !secText.includes(`| m${i} |`));
  check('S23d 分节插入路径不谎报成功（回 exit 0 的行必须真在盘上）',
    lied.length === 0, lied.map(({ i }) => `race-${i}`).join(','));
  const loud = secRes.filter((r) => r.code !== 0);
  check('S23e 若抢写失败必须是响亮抛错（拒绝陈旧快照整写），不是静默丢行',
    loud.every((r) => /并发修改|陈旧快照/.test(String(r.err))), loud.map((r) => r.err).join(' | ').slice(0, 200));
  const secRowCount = secText.split(/\r?\n/).filter((l) => isDataRow('delegations', l)).length;
  const okCount = secRes.filter((r) => r.code === 0).length;
  check('S23f 分节路径落盘行数 = 种子 + 成功路数（不多不少，无整写覆盖）',
    secRowCount === secRows.length + okCount, `实得 ${secRowCount}，种子 ${secRows.length}，成功 ${okCount}/${N}`);

  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S24 splitMain 持锁读-改-写（2026-11-05 并发修复回归）----
// 旧实现「读主→写分片→重写主」全程无锁：--split 与 --append/MCP append 并发同月分片时，
// split 拿陈旧分片快照整写，把并发追加的行整个抹掉。修复后写分片全程持 `<分片>.lock`
//（与 appendRows/MCP 同一把锁）。确定性复现：先让子进程持住分片锁（空转 > withLedgerLock
// 等待上限 3s、< 陈旧接管线 15s），再跑 --split——修复前照样整写成功（exit 0、分片被改写），
// 修复后响亮失败（exit 非 0、分片逐字节原样），锁释放后重跑迁移成功。
{
  const root = mkroot();
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const modUrl = new URL('../scripts/ledger-shards.mjs', import.meta.url).href; // 子进程 import() 用 URL
  const cli = fileURLToPath(new URL('../scripts/ledger-shards.mjs', import.meta.url)); // spawnSync argv 用路径
  fs.writeFileSync(wf(root, 'papercuts.md'), [
    '| 日期 | 位置 | 症状 | 拟修 |', '|------|------|------|------|',
    '| 2026-11-01 | 待迁行 | s | f |', '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(wf(root, 'papercuts.d'), { recursive: true });
  const shard = wf(root, 'papercuts.d', '2026-11.md');
  const seedShard = '| 2026-11-01 | 种子行 | s | f |\n';
  fs.writeFileSync(shard, seedShard, 'utf8');

  const child = spawn(process.execPath, [
    '-e',
    `import(${JSON.stringify(modUrl)}).then(m => m.withLedgerLock(process.argv[1], () => { console.log('LOCKED'); const g = Date.now() + 6000; while (Date.now() < g) {} })).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })`,
    shard,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let locked = false; // 同步轮询等锁就位（等不到就红，不假绿）
  for (let i = 0; i < 800 && !locked; i++) { locked = fs.existsSync(shard + '.lock'); if (!locked) sleepSync(25); }
  check('S24 前置：子进程已持住分片锁', locked);
  if (locked) {
    const p = spawnSync(process.execPath, [cli, '--split', 'papercuts'], { cwd: root, encoding: 'utf8' });
    check('S24a 持锁期间 --split → 响亮失败（exit 非 0）', p.status !== 0, `status=${p.status} out=${p.stdout} err=${p.stderr}`);
    check('S24b 失败报「写锁等待超时」', /写锁等待超时/.test(p.stderr || ''), p.stderr);
    check('S24c 分片逐字节原样（未被陈旧快照整写）', fs.readFileSync(shard, 'utf8') === seedShard, fs.readFileSync(shard, 'utf8'));
    check('S24d 主台账未被动（迁移未发生）', fs.readFileSync(wf(root, 'papercuts.md'), 'utf8').includes('待迁行'));
  }
  // 等锁释放（最长 20s）后重跑 → 迁移成功
  for (let i = 0; i < 800 && fs.existsSync(shard + '.lock'); i++) sleepSync(25);
  child.kill();
  const p2 = spawnSync(process.execPath, [cli, '--split', 'papercuts'], { cwd: root, encoding: 'utf8' });
  check('S24e 锁释放后重跑 --split → 迁移成功', p2.status === 0, p2.stderr);
  check('S24f 待迁行已迁入分片', fs.readFileSync(shard, 'utf8').includes('待迁行'), fs.readFileSync(shard, 'utf8'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S25 CLI 回执诚实：新落盘 / 幂等跳过分账（2026-11-05 台账族 Minor#2）----
// 旧实现重复行静默跳过但 CLI 无条件打「✓ 追加 1 行」——回执与磁盘事实不符（RED：重复追加
// 照称「追加」）。
{
  const root = mkroot();
  const cli = fileURLToPath(new URL('../scripts/ledger-shards.mjs', import.meta.url));
  const row = '| 2026-11-05 | 回执 | s | f |';
  const p1 = spawnSync(process.execPath, [cli, '--append', 'papercuts', '--row', row], { cwd: root, encoding: 'utf8' });
  check('S25a 首次追加回执「✓ 追加 1 行」', p1.status === 0 && /✓ 追加 1 行/.test(p1.stdout), `out=${p1.stdout} err=${p1.stderr}`);
  const p2 = spawnSync(process.execPath, [cli, '--append', 'papercuts', '--row', row], { cwd: root, encoding: 'utf8' });
  check('S25b 重复追加回执含「幂等跳过」且不再假称追加',
    p2.status === 0 && /幂等跳过/.test(p2.stdout) && !/✓ 追加/.test(p2.stdout), `out=${p2.stdout} err=${p2.stderr}`);
  const rows = fs.readFileSync(shardPathFor(root, 'papercuts', '2026-11'), 'utf8').split(/\r?\n/).filter((l) => isDataRow('papercuts', l));
  check('S25c 重复追加未重复落盘（仍 1 行）', rows.length === 1, `rows=${rows.length}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S26 CLI 写侧 fail-closed：bare 仓 / 非 git 目录拒写（2026-11-05 台账族 Minor#4）----
// 旧口径 projectRoot() 回退 cwd（RED：台账「就地」落 cwd）；bare 仓曾被误诊为 git-unavailable。
// 只读巡检 --check 不受限（裁决：status 类命令维持现状）。用例显式关掉本文件顶部的测试逃生门。
{
  const cli = fileURLToPath(new URL('../scripts/ledger-shards.mjs', import.meta.url));
  const GITBIN = process.platform === 'win32' ? 'git.exe' : 'git';
  const noEscape = { ...process.env, NODE_ENV: '', LEDGER_CLI_TEST_ANYROOT: '' };
  const row = '| 2026-11-05 | bare | s | f |';

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-shards-bare-'));
  spawnSync(GITBIN, ['init', '-q', '--bare'], { cwd: bare });
  const pBare = spawnSync(process.execPath, [cli, '--append', 'papercuts', '--row', row], { cwd: bare, encoding: 'utf8', env: noEscape });
  check('S26a bare 仓 --append → 非零拒写（bare 不再误诊 git-unavailable）',
    pBare.status !== 0 && /拒绝写台账/.test(pBare.stderr), `status=${pBare.status} err=${pBare.stderr}`);
  check('S26b bare 仓内未落盘', !fs.existsSync(path.join(bare, 'workflow')));

  const nongit = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-shards-nongit-'));
  const pNg = spawnSync(process.execPath, [cli, '--append', 'papercuts', '--row', row], { cwd: nongit, encoding: 'utf8', env: noEscape });
  check('S26c 非 git 目录 --append → 非零拒写', pNg.status !== 0 && /拒绝写台账/.test(pNg.stderr), `status=${pNg.status} err=${pNg.stderr}`);
  check('S26d 非 git 目录未落盘（不「就地」落 cwd）', !fs.existsSync(path.join(nongit, 'workflow')));

  const pChk = spawnSync(process.execPath, [cli, '--check'], { cwd: nongit, encoding: 'utf8', env: noEscape });
  check('S26e 只读 --check 不受限（exit 0）', pChk.status === 0, `status=${pChk.status} err=${pChk.stderr}`);

  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(nongit, { recursive: true, force: true });
}

// ---- S27 锁加固：陈旧接管原子化 + pid 死亡提前接管 + 释放非己不删（2026-11-05 台账族 Minor#11，
// 移植 agent-pipelines/scripts/state.mjs 0.1.26 的 withLock/takeOverStale 模式）----
{
  const root = mkroot();
  const target = wf(root, 'papercuts.md');
  fs.writeFileSync(target, '# 台账\n', 'utf8');
  const lockPath = `${target}.lock`;

  // ① 陈旧锁（utimesSync 回拨 > 15s）→ 接管；接管后锁内容 = 新持有者（本进程 owner）
  fs.writeFileSync(lockPath, '999999:stale-owner-xyz', 'utf8');
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lockPath, old, old);
  let innerOwner = '';
  await withLedgerLock(target, () => { innerOwner = fs.readFileSync(lockPath, 'utf8'); });
  check('S27a 陈旧锁可接管（临界区内锁内容 = 新持有者 pid）', innerOwner.startsWith(`${process.pid}:`), innerOwner);
  check('S27b 释放后锁已清理', !fs.existsSync(lockPath));

  // ② 锁龄新鲜但持有者 pid 已死 + 等待超 deadline → 提前原子接管（旧实现：无 pid 判定，
  //    白等满 3s 后超时抛错——RED：抛「写锁等待超时」）。确定性：持锁 pid 用一个已退出的
  //    真实子进程（kill(pid,0) 稳定 ESRCH），锁 mtime 保持现在时（不走 15s 陈旧路径）。
  const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((res) => deadChild.on('exit', res));
  fs.writeFileSync(lockPath, `${deadChild.pid}:deadbeef`, 'utf8');
  fs.utimesSync(lockPath, new Date(), new Date());
  let earlyErr = null;
  let earlyOk = false;
  const t0 = Date.now();
  try { await withLedgerLock(target, () => { earlyOk = true; }); } catch (e) { earlyErr = e; }
  check('S27c pid 已死残留锁 → 提前接管成功（旧实现超时抛错）', earlyOk, earlyErr && earlyErr.message);
  check('S27d 提前接管在等待超时线附近完成（未拖到 15s 陈旧阈值）', Date.now() - t0 < 15_000, `dur=${Date.now() - t0}`);

  // ③ 释放时非己不删：临界区期间锁被第三方接管（内容非己）→ 迟到的释放不误删
  fs.writeFileSync(lockPath, '777777:to-be-taken', 'utf8');
  fs.utimesSync(lockPath, old, old); // 陈旧 → 本进程进场时接管（内容 = 本进程 owner）
  let sawUsurp = false;
  await withLedgerLock(target, () => {
    fs.writeFileSync(lockPath, '888888:usurper', 'utf8'); // 第三方在临界区期间接管
    sawUsurp = fs.readFileSync(lockPath, 'utf8') === '888888:usurper';
  });
  check('S27e 释放时非己不删（接管者的锁不被迟到释放误删）',
    sawUsurp && fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8') === '888888:usurper',
    fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : 'lock gone');
  fs.unlinkSync(lockPath);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
