#!/usr/bin/env node
// check-ledger-invariant.test.mjs — 台账提交不变量 fixture 套件（2026-10-02 ledger-ci-invariant）
// 真 git 仓注入：合法追加放行 / 六类篡改与行级违例检出 / --staged 双态 / 首次入库与空台账静默。
// 分片（2026-10-16 shard-ledger-invariant-test）：48 个场景自分片并行（`--shard=i/K` 子进程，
//   K=clamp(1..6, floor(cpus/2))，CHECK_LEDGER_TEST_SHARDS 钉死）——本机 54s → 17s。场景间零共享态
//   （各自 mkrepo 独立临时仓），K=1 即原顺序行为。汇总行口径同 check-loop.test（`合计: PASS n / FAIL n`）。
// 用法：node test/check-ledger-invariant.test.mjs [--shard=i/K]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const SCRIPT = path.join(SCRIPT_DIR, '..', 'scripts', 'check-ledger-invariant.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const HEX = 'a'.repeat(64);
const row = (o = {}) => JSON.stringify({
  ts: '2026-10-02T00:00:00.000Z', doc: 'workflow/intents/demo.md', stage: 'approved',
  fingerprint: HEX, prev: 'draft', source: 'chat-delegated', quote: '确认', ...o,
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const G = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
const commitAll = (root, msg) => { G(root, ['add', '-A']); G(root, ['commit', '-qm', msg]); };
const run = (root, args = [], env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// mkrepo：临时真仓（workflow/intents/demo.md 在树 + 台账首行已提交）
// 2026-10-23 全量套件优化：模板仓复制（git init + base commit 只做一次）；自定义首行再补一笔提交。
let LEDGER_TEMPLATE = null;
const mkrepo = (firstRow = row()) => {
  // 自定义首行：不能复制模板再覆盖（会形成「删减历史行」的提交，S12 前缀不变量会红）——走原路径。
  if (firstRow !== row()) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inv-test-'));
    fs.mkdirSync(path.join(d, 'workflow', 'intents'), { recursive: true });
    fs.mkdirSync(path.join(d, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'workflow', 'intents', 'demo.md'), '---\n状态: approved\n级别: L1\n日期: 2026-10-02\n模块: pipeline\n---\n# I\n');
    fs.writeFileSync(path.join(d, '.agents', 'confirmations.jsonl'), firstRow + '\n');
    G(d, ['init', '-q']);
    commitAll(d, 'base ledger');
    return d;
  }
  if (!LEDGER_TEMPLATE) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inv-tpl-'));
    fs.mkdirSync(path.join(t, 'workflow', 'intents'), { recursive: true });
    fs.mkdirSync(path.join(t, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(t, 'workflow', 'intents', 'demo.md'), '---\n状态: approved\n级别: L1\n日期: 2026-10-02\n模块: pipeline\n---\n# I\n');
    fs.writeFileSync(path.join(t, '.agents', 'confirmations.jsonl'), row() + '\n');
    G(t, ['init', '-q']);
    commitAll(t, 'base ledger');
    LEDGER_TEMPLATE = t;
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inv-test-'));
  fs.cpSync(LEDGER_TEMPLATE, d, { recursive: true });
  return d;
};
const ledPath = (d) => path.join(d, '.agents', 'confirmations.jsonl');
const append = (d, line) => fs.appendFileSync(ledPath(d), line + '\n');

// 场景注册表（2026-10-16 shard-ledger-invariant-test）：45 个顶层场景块包装为注册回调，顺序驱动
// 执行——语义与包装前逐块顺序执行逐点等价（包装仅为给分片器提供可枚举单元）。
const SCENARIOS = [];
const SCEN = (fn) => { SCENARIOS.push(fn); };

// S1：合法追加 ×2 → 历史全扫过
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append 2nd');
  const r = run(d);
  check('S1 合法追加两次 → 历史全扫 exit 0', r.code === 0, r.out);
});
// S2：删历史行 → 前缀破坏拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append');
  fs.writeFileSync(ledPath(d), row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }) + '\n'); // 删首行
  commitAll(d, 'drop first row');
  const r = run(d);
  check('S2 删历史行 → 前缀破坏 exit 1', r.code === 1 && r.out.includes('前缀破坏') && r.out.includes('删减'), r.out);
});
// S3：改历史行内容 → 拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append');
  const lines = fs.readFileSync(ledPath(d), 'utf8').split('\n').filter(Boolean);
  lines[0] = lines[0].replace('确认', '改成别的'); // 改首行 quote
  fs.writeFileSync(ledPath(d), lines.join('\n') + '\n');
  commitAll(d, 'rewrite first line');
  const r = run(d);
  check('S3 改历史行 → 前缀破坏 exit 1（首异偏移）', r.code === 1 && r.out.includes('改写') && r.out.includes('首异偏移'), r.out);
});
// S4：非前缀改写（截断+异内容）→ 拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append');
  fs.writeFileSync(ledPath(d), row({ ts: '2027-01-01T00:00:00.000Z', quote: '另起炉灶' }) + '\n');
  commitAll(d, 'replace all');
  const r = run(d);
  check('S4 非前缀整体改写 → exit 1', r.code === 1 && r.out.includes('前缀破坏'), r.out);
});
// S5：ts 乱序追加 → 行级拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-01T00:00:00.000Z', stage: 'done' })); // 早于首行
  commitAll(d, 'append out-of-order');
  const r = run(d);
  check('S5 ts 非单调 → 行级 exit 1', r.code === 1 && r.out.includes('非单调'), r.out);
});
// S6：伪指纹（非 64-hex）→ 行级拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', fingerprint: 'zzz' }));
  commitAll(d, 'append bad fp');
  const r = run(d);
  check('S6 fingerprint 非 64-hex → 行级 exit 1', r.code === 1 && r.out.includes('64 位 hex'), r.out);
});
// S7：chat-delegated 空 quote → 行级拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', quote: '' }));
  commitAll(d, 'append empty quote');
  const r = run(d);
  check('S7 chat-delegated 空 quote → 行级 exit 1', r.code === 1 && r.out.includes('quote'), r.out);
});
// S8：doc 路径在树中不存在 → 行级拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/ghost.md' }));
  commitAll(d, 'append ghost doc');
  const r = run(d);
  check('S8 doc 当前树不存在 → 行级 exit 1', r.code === 1 && r.out.includes('不存在'), r.out);
});
// S9：--staged 合法追加 → 过
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('S9 --staged 合法追加 → exit 0', r.code === 0, r.out);
});
// S10：--staged 删历史行 → 拦
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append');
  fs.writeFileSync(ledPath(d), row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }) + '\n');
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('S10 --staged 删历史行 → exit 1', r.code === 1 && r.out.includes('台账重写'), r.out);
});
// S11：首次入库（无 HEAD 基线）与空台账 → 静默过
SCEN(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inv-fresh-'));
  fs.mkdirSync(path.join(d, '.agents'), { recursive: true });
  G(d, ['init', '-q']);
  fs.writeFileSync(ledPath(d), row() + '\n');
  G(d, ['add', '-A']);
  const rs = run(d, ['--staged']);
  const rh = run(d);
  check('S11 首次入库（staged 无 HEAD 基线 / 历史零提交）均静默过', rs.code === 0 && rh.code === 0, `staged=${rs.out} hist=${rh.out}`);
  fs.rmSync(d, { recursive: true, force: true });
});
// S12：回退注记行（revert-draft / fingerprint n/a）合法放行
SCEN(async () => {
  const d = mkrepo(row({ ts: '2026-10-02T00:00:00.000Z', stage: 'revert-draft', fingerprint: 'n/a', prev: 'approved' }));
  const r = run(d);
  check('S12 回退注记行（n/a 指纹）→ 历史全扫过', r.code === 0, r.out);
});
// S13 三态 kind 判别（2026-10-27 confirm-task-row）：MCP confirm 的任务级确认行——
//   kind:"task" 行五字段齐 → 过 / 缺 fingerprint → 行级拦 / 未知 kind 值 → 行级拦（防拼错形态溜账）。
//   task 行不写 doc/stage——无 kind 分支时会被行级④⑤误拦（本组用例同时钉住「不再误拦」）。
const taskRow = (o = {}) => JSON.stringify({
  ts: '2026-10-02T01:00:00.000Z', kind: 'task', task: 'workflow/plans/2026-10-27-demo.md',
  decision: 'draft→approved', evidence: '用户对话原话：可以', fingerprint: HEX, ...o,
});
SCEN(async () => {
  const d = mkrepo();
  append(d, taskRow());
  commitAll(d, 'append task row');
  const r = run(d);
  check('S13a kind:"task" 五字段齐 → 历史全扫 exit 0（不误拦缺 doc/stage）', r.code === 0, r.out);
});
SCEN(async () => {
  const d = mkrepo();
  append(d, taskRow({ fingerprint: 'zzz' }));
  commitAll(d, 'append task row bad fp');
  const r = run(d);
  check('S13b kind:"task" 缺合法 fingerprint → 行级 exit 1', r.code === 1 && r.out.includes('64 位 hex'), r.out);
});
SCEN(async () => {
  const d = mkrepo();
  append(d, taskRow({ kind: 'taks' }));
  commitAll(d, 'append typo kind');
  const r = run(d);
  check('S13c 未知 kind 值 → 行级 exit 1（防拼错）', r.code === 1 && r.out.includes('未知 kind'), r.out);
});

// ---- 分片台账不变量（2026-10-12 ledger-shard-default）：追加合法 / 改写硬拦 / 归并后删片合法 / 未归并存片硬拦 ----
// 夹具注意：分片行的 doc 必须在树上有对应文件，否则行级校验「doc 不存在」会盖过被测判据。
const shardDirOf = (d) => path.join(d, '.agents', 'confirmations.d');
const mkDoc = (d, name) => fs.writeFileSync(path.join(d, 'workflow', 'intents', `${name}.md`), `---\n状态: approved\n级别: L1\n日期: 2026-10-02\n模块: pipeline\n---\n# ${name}\n`);
const shardWrite = (d, name, rows) => {
  fs.mkdirSync(shardDirOf(d), { recursive: true });
  fs.writeFileSync(path.join(shardDirOf(d), `${name}.jsonl`), rows.join('\n') + '\n');
};
// H1：分片合法追加 ×2 → 历史全扫过（跨端确认不同 doc 写不同分片，互不干扰）
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'a');
  shardWrite(d, 'doc-a', [row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/a.md' })]);
  commitAll(d, 'shard doc-a v1');
  fs.appendFileSync(path.join(shardDirOf(d), 'doc-a.jsonl'), row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', doc: 'workflow/intents/a.md' }) + '\n');
  commitAll(d, 'shard doc-a v2');
  const r = run(d);
  check('H1 分片合法追加两次 → 历史全扫 exit 0', r.code === 0, r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// H2：分片删历史行 → 前缀破坏硬拦（--staged 与历史全扫双态）
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'b');
  shardWrite(d, 'doc-b', [
    row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/b.md' }),
    row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', doc: 'workflow/intents/b.md' }),
  ]);
  commitAll(d, 'shard doc-b v1');
  shardWrite(d, 'doc-b', [row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/b.md' })]); // 删第二行
  G(d, ['add', '-A']);
  const rs = run(d, ['--staged']);
  check('H2a 分片删历史行 → --staged 前缀破坏 exit 1', rs.code === 1 && /分片重写|台账重写/.test(rs.out) && /doc-b\.jsonl/.test(rs.out), rs.out);
  commitAll(d, 'shard doc-b tampered');
  const rh = run(d);
  check('H2b 分片删历史行 → 历史全扫 exit 1 且点名分片', rh.code === 1 && /confirmations\.d\/doc-b\.jsonl/.test(rh.out), rh.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// H3：分片归并后删除（compact-ledgers 形态：全部行已逐字进主台账）→ 合法且 loud 记录
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'c');
  const s1 = row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/c.md' });
  const s2 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', doc: 'workflow/intents/c.md' });
  shardWrite(d, 'doc-c', [s1, s2]);
  commitAll(d, 'shard doc-c');
  // 归并：分片两行原样追加进主台账，再删分片（compact-ledgers.mjs 的真实动作序列）
  append(d, s1); append(d, s2);
  fs.rmSync(path.join(shardDirOf(d), 'doc-c.jsonl'));
  commitAll(d, 'compact doc-c into main');
  const r = run(d);
  check('H3 分片归并后删除 → exit 0 且 loud 记录「归并后删除」', r.code === 0 && /归并后删除/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// H4：分片删除但行未进主台账（抹账）→ 硬拦
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'e');
  const s1 = row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/e.md' });
  shardWrite(d, 'doc-e', [s1]);
  commitAll(d, 'shard doc-e');
  fs.rmSync(path.join(shardDirOf(d), 'doc-e.jsonl')); // 直接删，不归并
  commitAll(d, 'delete shard without merge');
  const r = run(d);
  check('H4 分片删除而行未归并主台账 → hard 拦「分片删除」', r.code === 1 && /分片删除/.test(r.out) && /不在同提交主台账内/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// H5：主台账删除仍恒拦（分片的合法删除形态不外溢到主台账）
SCEN(async () => {
  const d = mkrepo();
  fs.rmSync(ledPath(d));
  commitAll(d, 'delete main ledger');
  const r = run(d);
  check('H5 主台账删除 → 恒 hard 拦「台账删除」', r.code === 1 && /台账删除/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// H6：分片行级违例（ts 乱序）在分片自身被检出，不因主台账无恙而漏
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'f');
  shardWrite(d, 'doc-f', [
    row({ ts: '2026-10-02T05:00:00.000Z', doc: 'workflow/intents/f.md' }),
    row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/f.md' }), // 早于前行
  ]);
  commitAll(d, 'shard doc-f out-of-order');
  const r = run(d);
  check('H6 分片内 ts 非单调 → 行级拦且点名分片', r.code === 1 && /非单调/.test(r.out) && /doc-f\.jsonl/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 特许修剪（2026-10-09 user-directed-prune）：manifest 逐行对账 ----
const sha256Of = (s) => spawnSync(process.execPath, ['-e', `console.log(require('crypto').createHash('sha256').update(process.argv[1],'utf8').digest('hex'))`, s], { encoding: 'utf8' }).stdout.trim();
const manifestPath = (d) => path.join(d, '.agents', 'config', 'ledger-prune-manifest.json');
const writeManifest = (d, obj) => { fs.mkdirSync(path.dirname(manifestPath(d)), { recursive: true }); fs.writeFileSync(manifestPath(d), JSON.stringify(obj, null, 2) + '\n'); };
// P1：--staged 特许修剪——删中段行 + manifest 恰对账 → 放行
SCEN(async () => {
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/gone.md' });
  const r3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done' });
  const d = mkrepo();
  append(d, r2); append(d, r3); commitAll(d, '3 rows');
  fs.writeFileSync(ledPath(d), [row(), r3].join('\n') + '\n'); // 删 r2
  writeManifest(d, { ts: '2026-10-09T00:00:00.000Z', authority: 'test', reason: 'test prune', removes: [sha256Of(r2)], docs: ['gone'] });
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('P1 --staged 特许修剪 manifest 对账 → exit 0 且 loud 记录', r.code === 0 && /特许修剪通过/.test(r.out) && /1 行/.test(r.out), r.out);
  commitAll(d, 'sanctioned prune');
  const rh = run(d);
  check('P1b 历史全扫认领同一修剪 → exit 0', rh.code === 0, rh.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// P2：--staged 删行但 manifest 哈希不对（对账失败）→ 拦
SCEN(async () => {
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/gone.md' });
  const d = mkrepo();
  append(d, r2); commitAll(d, '2 rows');
  fs.writeFileSync(ledPath(d), row() + '\n');
  writeManifest(d, { ts: '2026-10-09T00:00:00.000Z', authority: 'test', reason: 'x', removes: ['f'.repeat(64)], docs: ['gone'] });
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('P2 manifest 哈希不命中 → exit 1 且报对账失败', r.code === 1 && r.out.includes('特许修剪对账失败'), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// P3：--staged 删行且无 manifest → 仍拦（append-only 红线对未授权场景不变）
SCEN(async () => {
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/gone.md' });
  const d = mkrepo();
  append(d, r2); commitAll(d, '2 rows');
  fs.writeFileSync(ledPath(d), row() + '\n');
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('P3 无 manifest 删行 → exit 1（S10 语义回归）', r.code === 1 && r.out.includes('台账重写'), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// P4：manifest 在场但删了 manifest 之外的行（夹带私删）→ 拦
SCEN(async () => {
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/gone.md' });
  const r3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', doc: 'workflow/intents/sneak.md' });
  const d = mkrepo();
  append(d, r2); append(d, r3); commitAll(d, '3 rows');
  fs.writeFileSync(ledPath(d), [row(), r3].join('\n') + '\n'); // 删 r2；r3 保留
  writeManifest(d, { ts: '2026-10-09T00:00:00.000Z', authority: 't', reason: 'x', removes: [sha256Of(r2), sha256Of(r3)], docs: ['gone', 'sneak'] }); // 多报一行
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('P4 manifest 多报（哈希命中 1 ≠ 声明 2）→ exit 1', r.code === 1 && r.out.includes('特许修剪对账失败'), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- ④ 归档感知（2026-10-13 archive-aware-doc）：关单即归档移动文件后行仍指向真实文档 ----
// A1：行指向归档批次中的文档 → 放行；A2：行指向真消失文档（四目录与归档批次均无）→ 拦且报新口径
SCEN(async () => {
  const d = mkrepo();
  fs.mkdirSync(path.join(d, 'workflow', 'archive', '2026-10', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workflow', 'archive', '2026-10', 'plans', 'archived.md'), '---\n状态: done\n---\n# A\n');
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/plans/archived.md' }));
  commitAll(d, 'append archived-doc row');
  const r = run(d);
  check('A1 doc 已归档（archive/2026-10/plans）→ 行级放行 exit 0', r.code === 0, r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/plans/vanished.md' }));
  commitAll(d, 'append vanished-doc row');
  const r = run(d);
  check('A2 doc 真消失（无归档批次命中）→ 拦且报「归档批次均未命中」', r.code === 1 && r.out.includes('归档批次均未命中'), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 合并并集语义（2026-10-13 merge-union-aware）：多父提交按「并集无丢失」判 ----
// M1：两侧各追加一行，合并结果 = 三行之并 → union 认可、全扫过
// M2：合并结果丢掉一侧的行 → 拦且报「合并丢失」
const mkMergeRepo = () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' });
  const r3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'fixed' });
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2); commitAll(d, 'br append r2');
  G(d, ['checkout', '-q', BR]);
  append(d, r3); commitAll(d, 'main append r3');
  G(d, ['merge', '--no-commit', 'br']); // 冲突（双改同文件）——预期非零，手工写并集
  return { d, r2, r3 };
};
SCEN(async () => {
  const { d, r2, r3 } = mkMergeRepo();
  fs.writeFileSync(ledPath(d), [row(), r2, r3].join('\n') + '\n'); // union 结果
  commitAll(d, 'merge union');
  const r = run(d);
  check('M1 合并=父母行集之并 → union 认可 exit 0', r.code === 0 && /union 合并语义认可/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
SCEN(async () => {
  const { d, r2 } = mkMergeRepo();
  fs.writeFileSync(ledPath(d), [row(), r2].join('\n') + '\n'); // 丢了 main 侧 r3
  commitAll(d, 'merge losing main-side line');
  const r = run(d);
  check('M2 合并丢行 → exit 1 且报「合并丢失」', r.code === 1 && r.out.includes('合并丢失'), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 合并审计加固（2026-10-13 复核②实修回归）：ours 丢行 / 合并携带修剪 / 凭空造行 ----
// M3：-X ours 合并静默丢 br 侧行（合并树与第一父同 blob，前缀通过）→ union 无条件对账必须拦
SCEN(async () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' });
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2); commitAll(d, 'br append r2');
  G(d, ['checkout', '-q', BR]);
  const rM3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'fixed' });
  append(d, rM3); commitAll(d, 'main append r3');
  G(d, ['merge', '-X', 'ours', '-q', 'br', '-m', 'ours merge drops br line']); // 树=第一父，r2 静默消失
  const r = run(d);
  check('M3 ours 合并静默丢行 → exit 1 且报「合并丢失」', r.code === 1 && r.out.includes('合并丢失'), r.out.slice(-300));
  fs.rmSync(d, { recursive: true, force: true });
});
// M4：合并丢弃父母并集中的行 + manifest——(a) 诚实全量申报（对父母并集）→ 放行；(b) 只报第一父相对差集（p2 独有行无凭据消失）→ 拦
SCEN(async () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' });
  const r3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'fixed' });
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2); commitAll(d, 'br r2');
  G(d, ['checkout', '-q', BR]);
  append(d, r3); commitAll(d, 'main r3');
  G(d, ['merge', '--no-commit', 'br']);
  fs.writeFileSync(ledPath(d), row() + '\n'); // r2、r3 全丢
  writeManifest(d, { ts: '2026-10-13T00:00:00.000Z', authority: 't', reason: 'honest full prune', removes: [sha256Of(r2), sha256Of(r3)], docs: ['demo', 'demo'] });
  commitAll(d, 'merge with honest full manifest');
  const r = run(d);
  check('M4a 合并丢双侧行+诚实全量 manifest → 集合对账放行 exit 0', r.code === 0 && /合并携带特许修剪/.test(r.out), r.out.slice(-300));
  fs.rmSync(d, { recursive: true, force: true });
});
SCEN(async () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' });
  const r3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'fixed' });
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2); commitAll(d, 'br r2');
  G(d, ['checkout', '-q', BR]);
  append(d, r3); commitAll(d, 'main r3');
  G(d, ['merge', '--no-commit', 'br']);
  fs.writeFileSync(ledPath(d), row() + '\n'); // r2、r3 全丢
  writeManifest(d, { ts: '2026-10-13T00:00:00.000Z', authority: 't', reason: 'p1-relative partial', removes: [sha256Of(r3)], docs: ['demo'] }); // 只报 main 侧，br 的 r2 无凭据消失
  commitAll(d, 'merge with partial manifest');
  const r = run(d);
  check('M4b 合并丢行+部分 manifest（p2 行无凭据）→ exit 1', r.code === 1 && /修剪集合对账/.test(r.out), r.out.slice(-300));
  fs.rmSync(d, { recursive: true, force: true });
});
// M5：合并凭空多出父母都没有的行 → 拦
SCEN(async () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' });
  const r3 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'fixed' });
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2); commitAll(d, 'br r2');
  G(d, ['checkout', '-q', BR]);
  append(d, r3); commitAll(d, 'main r3'); // 双侧分叉，保证是真合并而非 fast-forward
  G(d, ['merge', '--no-commit', 'br']);
  append(d, row({ ts: '2026-10-02T09:00:00.000Z', quote: '凭空造行' }));
  commitAll(d, 'merge with fabricated line');
  const r = run(d);
  check('M5 合并凭空多出行 → exit 1 且报「凭空多出」', r.code === 1 && r.out.includes('凭空多出'), r.out.slice(-300));
  fs.rmSync(d, { recursive: true, force: true });
});
// M6：合并收口删片（首父侧早已归并删片、分片仅第二父仍持有）→ 各父并集对账认可（实证 56c45b07：
//   单读 `${sha}^` 只看首父会把合法收口误判成「增删同提交」）
// 形态对齐真实仓：A 首父侧建分片 → B 首父侧归并删片 → br（第二父，模拟他端未同步修剪）仍持分片并
//   独立追加主台账 → 真合并，分片按首父态在结果中缺席、主台账取父母并集。
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'm');
  const s1 = row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/m.md' });
  const r2 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done' });
  const r9 = row({ ts: '2026-10-02T03:00:00.000Z', stage: 'fixed' });
  shardWrite(d, 'doc-m', [s1]);
  commitAll(d, 'A main create shard doc-m');
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  G(d, ['checkout', '-qb', 'br']); // br 自 A 分叉：仍持有分片（他端未做归并）
  append(d, r2);
  commitAll(d, 'C br append r2 (shard still present)');
  G(d, ['checkout', '-q', BR]);
  append(d, s1); // B 首父侧归并：行进主台账后删片（compact-ledgers 动作序列）
  fs.rmSync(path.join(shardDirOf(d), 'doc-m.jsonl'));
  commitAll(d, 'B main compact doc-m (append row then drop shard)');
  append(d, r9);
  commitAll(d, 'D main unrelated append');
  G(d, ['merge', '--no-commit', 'br']); // 主台账双侧追加 → 冲突，手工写并集；分片呈删除态（delete/modify 自动取删除）
  fs.writeFileSync(ledPath(d), [row(), s1, r2, r9].join('\n') + '\n');
  commitAll(d, 'merge: ledger union + shard stays dropped');
  const r = run(d);
  check('M6 合并收口删片（分片仅第二父有）→ 各父并集对账认可 exit 0', r.code === 0 && /归并后删除/.test(r.out), r.out.slice(-400));
  fs.rmSync(d, { recursive: true, force: true });
});
// M7：合并收口删片而行未归并主台账（借合并收口抹账）→ 硬拦
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'n');
  const s1 = row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/n.md' });
  const r2 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done' });
  const r9 = row({ ts: '2026-10-02T03:00:00.000Z', stage: 'fixed' });
  shardWrite(d, 'doc-n', [s1]);
  commitAll(d, 'A main create shard doc-n');
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2);
  commitAll(d, 'C br append r2 (shard still present, rows never in main ledger)');
  G(d, ['checkout', '-q', BR]);
  append(d, r9); // 首父侧【不归并】直接独立推进
  commitAll(d, 'D main unrelated append (no compaction)');
  G(d, ['merge', '--no-commit', 'br']);
  fs.writeFileSync(ledPath(d), [row(), r2, r9].join('\n') + '\n'); // 并集无 s1——分片行从未进主台账
  fs.rmSync(path.join(shardDirOf(d), 'doc-n.jsonl')); // 合并解析把分片一并丢弃 → 借收口抹账
  commitAll(d, 'merge: drop shard without compaction');
  const r = run(d);
  check('M7 合并收口删片未归并 → exit 1 且报「分片删除」', r.code === 1 && /分片删除/.test(r.out) && /不在同提交主台账内/.test(r.out), r.out.slice(-400));
  fs.rmSync(d, { recursive: true, force: true });
});


// M8：合并删片缺行但终树已补登（merge-shard-restore-aware）→ 丢失追认 exit 0 且 loud
// 形态：br 侧分片多出 s2 未归并主台账，合并解析删片（s2 丢失）→ 后续提交把 s2 原样回append进主台账
SCEN(async () => {
  const d = mkrepo();
  mkDoc(d, 'p');
  mkDoc(d, 'p2');
  const s1 = row({ ts: '2026-10-02T01:00:00.000Z', doc: 'workflow/intents/p.md' });
  const s2 = row({ ts: '2026-10-02T04:00:00.000Z', doc: 'workflow/intents/p2.md' });
  const r2 = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done' });
  const r9 = row({ ts: '2026-10-02T03:00:00.000Z', stage: 'fixed' });
  shardWrite(d, 'doc-p', [s1]);
  commitAll(d, 'A main create shard doc-p');
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  G(d, ['checkout', '-qb', 'br']);
  append(d, r2);
  fs.appendFileSync(path.join(shardDirOf(d), 'doc-p.jsonl'), s2 + '\n'); // br 侧分片多出 s2（未归并）
  commitAll(d, 'C br append r2 + shard gains s2 (not compacted)');
  G(d, ['checkout', '-q', BR]);
  append(d, s1); // 首父侧归并 s1 后删片
  fs.rmSync(path.join(shardDirOf(d), 'doc-p.jsonl'));
  commitAll(d, 'B main compact s1 + drop shard');
  append(d, r9);
  commitAll(d, 'D main unrelated append');
  G(d, ['merge', '--no-commit', 'br']);
  fs.writeFileSync(ledPath(d), [row(), s1, r2, r9].join('\n') + '\n'); // 并集（无 s2——s2 在合并中丢失）
  fs.rmSync(path.join(shardDirOf(d), 'doc-p.jsonl')); // 合并解析按首父态删片
  commitAll(d, 'merge: s2 lost by shard drop');
  const s2c = JSON.stringify({ ...JSON.parse(s2), ts: '2026-10-02T05:00:00.000Z', note: '补偿行：原行 ts 2026-10-02T04:00:00.000Z 合并丢失后补登' });
  append(d, s2c); // 终树补登：s2 以**补偿形态**回append（ts 改现时序 + note 字段，doc/stage/fingerprint 沿原行）
  commitAll(d, 'E restore lost s2 into main ledger (compensation form)');
  const r = run(d);
  check('M8 合并删片缺行终树已补登（补偿形态，语义身份比对）→ 丢失追认 exit 0', r.code === 0 && /补登/.test(r.out) && /丢失追认/.test(r.out), r.out.slice(-400));
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 合并态 --staged（2026-10-14 staged-merge-prune）：pre-commit 在合并进行中按父母并集对账 ----
// 共用造仓：main 已含 r2 → br 修剪 r2 并等义补 comp 行（manifest 随 br）→ main 另加无关改动后
//   merge --no-commit（真合并、MERGE_HEAD 在场，暂存 = br 版）。r2 必须先在首父——否则暂存相对 HEAD
//   仍是纯追加、前缀通过而不触达修剪对账（夹具自证点）。
const mkMergePruneRepo = () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const r2 = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', doc: 'workflow/intents/gone.md' });
  const comp = row({ ts: '2026-10-13T00:00:00.000Z', stage: 'done', note: '补偿行：doc 仍在' });
  append(d, r2); commitAll(d, 'main r2');
  G(d, ['checkout', '-qb', 'br']);
  fs.writeFileSync(ledPath(d), [row(), comp].join('\n') + '\n');
  writeManifest(d, { ts: '2026-10-13T00:00:00.000Z', authority: 't', reason: 'branch prune', removes: [sha256Of(r2)], docs: ['gone'] });
  commitAll(d, 'br prune + compensation');
  G(d, ['checkout', '-q', BR]);
  fs.writeFileSync(path.join(d, 'other.txt'), 'x');
  commitAll(d, 'main unrelated change');
  G(d, ['merge', '--no-commit', 'br']);
  return { d, r2, comp };
};
// M9：合并态 --staged 携带修剪（暂存 = 父母并集 − removes）→ 放行且 loud
SCEN(async () => {
  const { d } = mkMergePruneRepo();
  const r = run(d, ['--staged']);
  check('M9 合并态 --staged 携带修剪（暂存=父母并集 − removes）→ exit 0 且 loud', r.code === 0 && /合并携带特许修剪通过/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// M10：合并态 --staged 凭空造行（不在父母并集内）→ 仍拦（新路径不放水）
SCEN(async () => {
  const { d } = mkMergePruneRepo();
  append(d, row({ ts: '2026-10-13T09:00:00.000Z', quote: '凭空造行' }));
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('M10 合并态 --staged 凭空多行 → exit 1', r.code === 1 && /台账重写/.test(r.out) && /合并并集集合对账亦失败/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// M11：合并态 --staged 改写历史行（行数不变、无 manifest）→ 仍拦（append-only 红线不外溢）
SCEN(async () => {
  const { d, r2 } = mkMergePruneRepo();
  const tampered = JSON.stringify({ ...JSON.parse(r2), stage: 'closed' });
  fs.writeFileSync(ledPath(d), [row(), tampered].join('\n') + '\n');
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('M11 合并态 --staged 无凭据改写历史行 → exit 1', r.code === 1 && /台账重写/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// M12：合并态 --staged 删掉两父母共有行（不在 manifest removes 里）→ 仍拦
SCEN(async () => {
  const { d, comp } = mkMergePruneRepo();
  fs.writeFileSync(ledPath(d), comp + '\n');
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('M14 合并态 --staged 删双父共有行 → exit 1',
    r.code === 1 && /合并仍丢失 manifest 外/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 合并态 --staged 纯并集（2026-10-15 staged-merge-union）：无 manifest、行集恰为父母之并 ----
// 共用造仓：base=[r0] → br 追加 rc、main 追加 rb（双侧改台账，merge --no-commit 必为真合并态）。
// 复刻 2026-10-15 实战形态：合并解析产出的暂存把对侧行按 ts 时序中插/重排——非 HEAD 逐字节前缀，
// 但行集恰为父母之并（无丢失、无凭空行），--staged 须按 union 语义放行（此前仅 manifest 修剪一条路，
// 对纯并集形态假阳性 BLOCK）。
const mkMergeUnionRepo = () => {
  const d = mkrepo();
  const BR = G(d, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const rc = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', quote: '对侧早行' });
  const rb = row({ ts: '2026-10-02T03:00:00.000Z', stage: 'done', quote: '首父晚行' });
  G(d, ['checkout', '-qb', 'br']);
  append(d, rc); commitAll(d, 'br append rc');
  G(d, ['checkout', '-q', BR]);
  append(d, rb); commitAll(d, 'main append rb');
  G(d, ['merge', '--no-commit', 'br']); // 双侧追加 → 冲突，MERGE_HEAD 在场（状态忽略，下面手动定暂存）
  return { d, rc, rb };
};
// M12：暂存 = [rc, r0, rb]（rc 中插重排、非 HEAD 前缀，行集恰为父母之并）→ 放行且 loud
SCEN(async () => {
  const { d, rc, rb } = mkMergeUnionRepo();
  fs.writeFileSync(ledPath(d), [rc, row(), rb].join('\n') + '\n');
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('M12 合并态 --staged 纯并集（中插重排、无 manifest）→ exit 0 且 loud', r.code === 0 && /合并并集无丢失认可/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// M13：暂存丢首父行 rb（其余同 M12）→ 新路径不放水，仍拦且报「合并丢失」
SCEN(async () => {
  const { d, rc } = mkMergeUnionRepo();
  fs.writeFileSync(ledPath(d), [rc, row()].join('\n') + '\n');
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('M13 合并态 --staged 纯并集丢首父行 → exit 1 且报丢失', r.code === 1 && /台账重写/.test(r.out) && /合并纯并集对账失败：合并丢失/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 特许重建（2026-10-15 ledger-rebuild-manifest）：去重+重排的一次性 owner 授权通道 ----
// 共用造仓：带病态入库——尾部 ts 降序块（rb 排在 ra 前）+ ra 整行重复。
const rebuildManifestPath = (d) => path.join(d, '.agents', 'config', 'ledger-rebuild-manifest.json');
const writeRebuild = (d, obj) => { fs.mkdirSync(path.dirname(rebuildManifestPath(d)), { recursive: true }); fs.writeFileSync(rebuildManifestPath(d), JSON.stringify(obj, null, 2) + '\n'); };
const mkRebuildRepo = () => {
  const d = mkrepo();
  const ra = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', quote: '早行' });
  const rb = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', quote: '晚行' });
  fs.writeFileSync(ledPath(d), [row(), rb, ra, ra].join('\n') + '\n');
  commitAll(d, 'damaged: inversion + dup');
  return { d, ra, rb };
};
// R1：诚实重建（去 ra 重复副本 + 排序，finalRows 与终态逐行一致）→ --staged 放行且 loud
SCEN(async () => {
  const { d, ra, rb } = mkRebuildRepo();
  fs.writeFileSync(ledPath(d), [row(), ra, rb].join('\n') + '\n');
  writeRebuild(d, { ts: '2026-10-15T00:00:00.000Z', authority: 't', reason: 'test rebuild', removes: [{ hash: sha256Of(ra), copies: 1 }], finalRows: [sha256Of(row()), sha256Of(ra), sha256Of(rb)] });
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('R1 --staged 特许重建（去重+排序）→ exit 0 且 loud', r.code === 0 && /特许重建通过/.test(r.out) && /finalRows/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// R2：终态夹带凭空行（finalRows 如实申报也拒）→ rebuild 禁造行
SCEN(async () => {
  const { d, ra, rb } = mkRebuildRepo();
  const rc = row({ ts: '2026-10-02T03:00:00.000Z', stage: 'done', quote: '凭空行' });
  fs.writeFileSync(ledPath(d), [row(), ra, rb, rc].join('\n') + '\n');
  writeRebuild(d, { ts: '2026-10-15T00:00:00.000Z', authority: 't', reason: 'x', removes: [{ hash: sha256Of(ra), copies: 1 }], finalRows: [sha256Of(row()), sha256Of(ra), sha256Of(rb), sha256Of(rc)] });
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('R2 --staged 重建夹带凭空行 → exit 1（禁造行）', r.code === 1 && /台账重写/.test(r.out) && /rebuild 禁造行/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// R3：借重建改写既有行内容（r0 → 篡改版）→ 差集对账外多出删除，拒
SCEN(async () => {
  const { d, ra, rb } = mkRebuildRepo();
  const r0x = JSON.stringify({ ...JSON.parse(row()), stage: 'closed' });
  fs.writeFileSync(ledPath(d), [r0x, ra, rb].join('\n') + '\n');
  writeRebuild(d, { ts: '2026-10-15T00:00:00.000Z', authority: 't', reason: 'x', removes: [{ hash: sha256Of(ra), copies: 1 }], finalRows: [sha256Of(r0x), sha256Of(ra), sha256Of(rb)] });
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('R3 --staged 借重建改写行内容 → exit 1（差集对账拦）', r.code === 1 && /台账重写/.test(r.out) && (/差集对账失败/.test(r.out) || /rebuild 禁造行/.test(r.out)), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});
// R4：历史全扫认领同一重建（带病入库后一笔重建提交携带 manifest）→ 扫描绿且 loud
SCEN(async () => {
  const { d, ra, rb } = mkRebuildRepo();
  fs.writeFileSync(ledPath(d), [row(), ra, rb].join('\n') + '\n');
  writeRebuild(d, { ts: '2026-10-15T00:00:00.000Z', authority: 't', reason: 'test rebuild', removes: [{ hash: sha256Of(ra), copies: 1 }], finalRows: [sha256Of(row()), sha256Of(ra), sha256Of(rb)] });
  commitAll(d, 'rebuild with manifest');
  const r = run(d);
  check('R4 历史全扫认领特许重建 → exit 0 且 loud', r.code === 0 && /特许重建 \d+ 副本/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// R5：纯重排（removes 为空，多重集恒等）——2026-10-16 纯重排放宽：行内容零改动、零新增时由 finalRows
// 指纹清单逐行钉死，故 rebuild 通道放行并 loud 打印「纯重排（零删除、零新增）」（旧口径要求非空 removes，已废）
SCEN(async () => {
  const d = mkrepo();
  const ra = row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done', quote: '早行' });
  const rb = row({ ts: '2026-10-02T02:00:00.000Z', stage: 'done', quote: '晚行' });
  fs.writeFileSync(ledPath(d), [row(), rb, ra].join('\n') + '\n'); // 尾部 ts 降序（无重复副本）
  commitAll(d, 'inversion only');
  fs.writeFileSync(ledPath(d), [row(), ra, rb].join('\n') + '\n'); // 纯重排（零删除、零新增）
  writeRebuild(d, { ts: '2026-10-16T00:00:00.000Z', authority: 't', reason: 'pure reorder', removes: [], finalRows: [sha256Of(row()), sha256Of(ra), sha256Of(rb)] });
  G(d, ['add', '-A']);
  const r = run(d, ['--staged']);
  check('R5 --staged 纯重排（removes 空）→ exit 0 且 loud（2026-10-16 纯重排放宽）', r.code === 0 && /纯重排（零删除、零新增）/.test(r.out), r.out);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 历史基线（2026-10-13 ledger-history-baseline）：owner 声明豁免前基线时代 ----
// B1：前基线改写无凭据——无基线全史扫描拦；LEDGER_HISTORY_BASELINE 指到 HEAD 后豁免过
SCEN(async () => {
  const d = mkrepo();
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append');
  fs.writeFileSync(ledPath(d), row({ ts: '2026-10-02T02:00:00.000Z', quote: '改写' }) + '\n'); // 非 append 改写，无 manifest
  commitAll(d, 'rewrite pre-baseline');
  const head = G(d, ['rev-parse', 'HEAD']).stdout.trim();
  const rNoBase = run(d); // 默认基线为真仓 sha，fixture 无此提交 → 基线不生效 → 全史扫描
  const rBase = run(d, [], { LEDGER_HISTORY_BASELINE: head });
  check('B1 历史基线：无基线改写拦 / 基线=HEAD 豁免过且 loud', rNoBase.code === 1 && rBase.code === 0 && /豁免/.test(rBase.out), `noBase=${rNoBase.out.slice(-200)} base=${rBase.out.slice(-200)}`);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 历史索引改造（2026-10-27 ledger-history-index）：批量读须与逐个读同裁决 ----
// 背景：293 条路径 × 每路径一次 `git log` = 159s，2397 次 `git show` = 123s；改为一次
// `git log -m --full-history --name-only` 建倒排 + `cat-file --batch` 批量读（全门 479s → 4s）。
// 本组钉住两条不可省的语义：① 合并提交必须入列（`-m` 必需，否则 280/293 路径漏合并）；
// ② 前缀破坏仍须被检出（批量读不得把「读不到」洗成「通过」）。
SCEN(async () => {
  const d = mkrepo();
  // 合并历史：side 分支追加一行，main 侧改文档，合并后行集须为并集
  append(d, row({ ts: '2026-10-02T01:00:00.000Z', stage: 'done' }));
  commitAll(d, 'append on base');
  G(d, ['checkout', '-qb', 'side']);
  append(d, row({ ts: '2026-10-02T02:00:00.000Z', quote: 'side' }));
  commitAll(d, 'side row');
  G(d, ['checkout', '-q', '-']);
  fs.writeFileSync(path.join(d, 'workflow', 'intents', 'demo.md'), '---\n状态: approved\n级别: L1\n日期: 2026-10-02\n模块: pipeline\n---\n# I2\n');
  commitAll(d, 'main doc');
  G(d, ['merge', '--no-ff', '-m', 'merge side', 'side']);
  const rMerge = run(d);
  check('I1 合并提交入列（-m）→ 并集扫描通过',
    rMerge.code === 0, rMerge.out.slice(-400));

  // 同仓再删一行（无 manifest）→ 必须仍被前缀判据拦住
  const lines = fs.readFileSync(ledPath(d), 'utf8').split(/\r?\n/).filter(Boolean);
  fs.writeFileSync(ledPath(d), `${lines[0]}\n`, 'utf8');
  commitAll(d, 'drop rows');
  const rDrop = run(d);
  check('I2 批量读后删历史行 → 仍报前缀破坏', rDrop.code === 1 && /前缀破坏/.test(rDrop.out), rDrop.out.slice(-400));
  fs.rmSync(d, { recursive: true, force: true });
});

// 场景间零共享态（各自 mkrepo 独立临时仓 + git init，评估期逐块确认辅助函数全在模块级）→ 按
// idx % K round-robin 分片可安全并行。K = clamp(1..4, floor(cpus/3))：12 核本机 4；小核 CI 自适应到 1
// = 顺序等价（行为与分片化前一致）；CHECK_LEDGER_TEST_SHARDS 钉死（调试/复现单线程顺序）。
// --shard=i/K = 子进程态，只跑本片场景后落文件末既有「合计」汇总；parent 态聚合各子进程计数行、
// 任一红即 exit 1，并在文件末汇总前显式退出（parent 未跑场景，模块级计数器恒 0，不走该汇总）。
// 注册完整性守卫（2026-10-16 shard-ledger-invariant-test）：场景必须以 SCEN(...) 注册——事后新增一个
// 裸顶层 `{ ... }` 块**不会**进注册表，「漏跑」与「跑过」在输出上不可区分（静默失效）。直接读本文件
// 源码判形：列 0 的单独 `{` 行只可能是场景块（本文件其余顶层结构均为 const / 函数 / if 形态）。
// 注意：守卫自身不得写成顶层裸块，否则自命中（首版即踩）。
const BARE_BLOCKS = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => l === '{');
if (BARE_BLOCKS.length) {
  console.error(`check-ledger-invariant.test: 第 ${BARE_BLOCKS.map(([n]) => n).join('、')} 行是裸顶层块——场景须用 SCEN(...) 注册，否则静默漏跑`);
  process.exit(1);
}

const SHARD_ARG = process.argv.find((a) => a.startsWith('--shard='));
if (SHARD_ARG) {
  const m = SHARD_ARG.match(/^--shard=(\d+)\/(\d+)$/);
  const si = m && Number(m[1]), sk = m && Number(m[2]);
  if (!m || !Number.isInteger(si) || !Number.isInteger(sk) || sk < 1 || si >= sk) {
    console.error(`check-ledger-invariant.test: --shard 形态须为 i/K 且 i<K（现 ${SHARD_ARG}）`);
    process.exit(1);
  }
  // 逐场景异常捕获（与 check-loop.test 同口径）：环境/夹具异常原样击穿 shard 进程 → 套件红而零
  // 诊断信息。转为 FAIL + 消息头，shard 其余场景照常执行。
  for (const [idx, s] of SCENARIOS.entries()) {
    if (idx % sk !== si) continue;
    try {
      await s();
    } catch (e) {
      const head = String((e && e.message) || e).split('\n').slice(0, 10).join('\n');
      fail++;
      console.log(`FAIL  场景异常（非断言失败——夹具/环境错误，SCEN 总序第 ${idx + 1} 个）：\n      ${head}`);
    }
  }
} else {
  const K = (() => {
    const env = Number(process.env.CHECK_LEDGER_TEST_SHARDS);
    if (Number.isInteger(env) && env >= 1) return Math.min(env, SCENARIOS.length);
    return Math.min(6, Math.max(1, Math.floor(os.cpus().length / 2)));
  })();
  if (K <= 1) {
    for (const s of SCENARIOS) await s(); // 顺序等价（小核 CI / 环境钉死 1）
  } else {
    const kids = [];
    for (let i = 0; i < K; i++) {
      kids.push(new Promise((resolve) => {
        const c = spawn(process.execPath, [fileURLToPath(import.meta.url), `--shard=${i}/${K}`]);
        let out = '', err = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        c.on('close', (code) => resolve({ i, out, err, code }));
        c.on('error', (e) => resolve({ i, out, err, code: null, err_obj: e }));
      }));
    }
    let tp = 0, tf = 0, red = 0;
    for (const r of await Promise.all(kids)) {
      const m = [...String(r.out).matchAll(/合计: PASS (\d+) \/ FAIL (\d+)/g)].pop();
      const p = m ? Number(m[1]) : 0;
      const f = m ? Number(m[2]) : 0;
      tp += p; tf += f;
      const ok = r.code === 0 && f === 0 && !!m;
      if (!ok) red++;
      process.stdout.write(`\n[check-ledger-invariant.test ▶ shard ${r.i + 1}/${K}]\n${r.out}`);
      if (!ok) {
        console.log(`[check-ledger-invariant.test] RED shard ${r.i + 1}${r.code != null ? `（exit ${r.code}）` : r.err_obj ? `（spawn ${r.err_obj.code || r.err_obj.message}）` : ''}${m ? '' : '（无合计行——子进程崩溃）'}`);
        if (r.err) {
          const L = String(r.err).split('\n');
          process.stderr.write([...L.slice(0, 12), ...(L.length > 20 ? ['……（中略）'] : []), ...L.slice(-5)].join('\n') + '\n');
        }
      }
    }
    console.log(`\n合计: PASS ${tp} / FAIL ${tf}`);
    process.exit(red || tf ? 1 : 0); // parent 未跑场景：在此退出，跳过文件末模块级汇总
  }
}

// 汇总行口径与 check-loop.test / pipeline-run.test 一致（`合计: PASS n / FAIL n`）——分片 parent 与
// run-tests 均按该行聚合计数（原 `✅ all passed（N passed）` 形态两者都解析不到，本套件在 run-tests
// 聚合里恒记 0/0）。
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);