#!/usr/bin/env node
// ledger-shards.test.mjs — 分片读写单源 fixture（2026-10-13 ledger-shard-ledgers）
// 覆盖：数据行判定（含节限定）/ 月提取 / 主台账∪分片读 / 迁移幂等 / 追加 / 表头自带 / fail-loud
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEDGERS, isDataRow, inScope, monthOf, readLedger, readLedgerText,
  splitMain, appendRows, shardPathFor, renderShard,
} from '../scripts/ledger-shards.mjs';

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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
