// append-compensation.test.mjs — 补偿行生成器回归（2026-10-24）
// 钉死四件事：①指纹用 bindingSha256(lines, prev) 口径（状态行回填 prev），禁「直接哈希当前内容」
//   （2026-10-24 整改批实证手搓口径被 s15 拦）②prev/quote 沿用与透传 ③拒绝面 fail-loud
//   （非终态 / 无台账行 / 缺 prev 存量 / 内容未变）④末次行选取与 s15 同口径。
// 插件化落位（2026-10-27 迁移）：check-loop-kit 被 import 即执行根解析 + 枚举加载（fixture 契约：
// 缺 <root>/.agents/config/workflow-enums.txt fail-loud exit 1），本套件纯逻辑、无现成项目根——
// 先落最小 fixture 根（四目录 + 枚举内联，同 check-loop.test.mjs ENUMS_FIXTURE 口径）注入
// CHECK_LOOP_ROOT，再动态 import 被测件；断言集合原样未改。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'append-comp-fix-'));
for (const s of ['intents', 'specs', 'plans', 'incidents']) fs.mkdirSync(path.join(fixture, 'workflow', s), { recursive: true });
fs.mkdirSync(path.join(fixture, '.agents', 'config'), { recursive: true });
fs.writeFileSync(path.join(fixture, '.agents', 'config', 'workflow-enums.txt'), [
  'doc.status.all=draft approved done superseded cancelled',
  'doc.status.confirmed=approved done superseded cancelled',
  'doc.status.active=draft approved',
  'doc.status.terminal=done superseded cancelled',
  'doc.status.abandoned=superseded cancelled',
  'incident.status.all=open fixed closed',
  'incident.status.active=open',
  'level.all=L1 L2 L3',
  '',
].join('\n'), 'utf8');
process.env.CHECK_LOOP_ROOT = fixture;

const { bindingSha256 } = await import('../scripts/check-loop-kit.mjs');
const { TERMINAL_STAGES, pickLastRow, buildCompensation } = await import('../scripts/append-compensation.mjs');

const DOC = 'workflow/specs/demo.md';
// done 态正文（frontmatter 状态=done），与 approved 态仅「状态:」行不同——复原口径的正统形态
const linesDone = ['---', '状态: done', '级别: L3', '---', '', '## 正文', '改后内容'].join('\n').split('\n');
const prev = 'approved';
const lastRow = { doc: DOC, stage: 'done', prev, fingerprint: '0'.repeat(64) }; // 占位旧指纹 ≠ 任何新算值

// 场景 1：终态 + 内容已改 → 行形态正确；指纹判别——等于 prev 口径、不等于当前态口径（手搓口径即死于此）
{
  const r = buildCompensation(linesDone, 'done', lastRow, '修复以上问题', '2026-10-25T00:00:00.000Z');
  assert.equal(r.ok, true);
  assert.equal(r.row.stage, 'done');
  assert.equal(r.row.prev, 'approved');
  assert.equal(r.row.quote, '修复以上问题');
  assert.equal(r.row.source, 'chat-delegated');
  assert.equal(r.row.ts, '2026-10-25T00:00:00.000Z');
  assert.equal(r.row.fingerprint, bindingSha256(linesDone, prev));
  assert.notEqual(r.row.fingerprint, bindingSha256(linesDone, 'done'));
  console.log('PASS 场景 1：补偿行形态与 bindingSha256(lines, prev) 口径（判别于直接哈希）');
}

// 场景 2：内容未变（末次行指纹 === 重算值）→ 拒绝，无漂移不落行
{
  const same = { ...lastRow, fingerprint: bindingSha256(linesDone, prev) };
  const r = buildCompensation(linesDone, 'done', same, 'q', 't');
  assert.equal(r.ok, false);
  assert.match(r.reason, /无可补偿的漂移/);
  console.log('PASS 场景 2：内容未变拒绝');
}

// 场景 3：末次行缺 prev（schema 演进前存量）→ 拒绝——s15 本就绑定降级，追加反而制造失配
{
  const r = buildCompensation(linesDone, 'done', { doc: DOC, stage: 'done', fingerprint: 'f' }, 'q', 't');
  assert.equal(r.ok, false);
  assert.match(r.reason, /缺 prev/);
  console.log('PASS 场景 3：缺 prev 存量拒绝');
}

// 场景 4：非终态（approved）与无台账行 → 拒绝；closed 终态（prev=fixed）放行
{
  assert.equal(buildCompensation(linesDone, 'approved', lastRow, 'q', 't').ok, false);
  assert.equal(buildCompensation(linesDone, 'done', null, 'q', 't').ok, false);
  const closedRow = { doc: DOC, stage: 'closed', prev: 'fixed', fingerprint: '1'.repeat(64) };
  const rc = buildCompensation(linesDone, 'closed', closedRow, 'q', 't');
  assert.equal(rc.ok, true);
  assert.equal(rc.row.prev, 'fixed');
  assert.deepEqual(TERMINAL_STAGES, ['done', 'closed', 'superseded', 'cancelled']);
  console.log('PASS 场景 4：非终态/无基底拒绝，closed(fixed) 放行');
}

// 场景 5：pickLastRow 取末次同 stage 行（append-only 末次生效，与 s15 同口径）
{
  const rows = [
    { doc: DOC, stage: 'approved', fingerprint: 'a' },
    { doc: DOC, stage: 'done', prev: 'approved', fingerprint: 'b' },
    { doc: 'workflow/plans/other.md', stage: 'done', fingerprint: 'x' },
    { doc: DOC, stage: 'done', prev: 'approved', fingerprint: 'c' }, // 末次生效
  ];
  assert.equal(pickLastRow(rows, DOC, 'done').fingerprint, 'c');
  assert.equal(pickLastRow(rows, DOC, 'approved').fingerprint, 'a');
  assert.equal(pickLastRow(rows, DOC, 'superseded'), null);
  console.log('PASS 场景 5：末次行选取');
}
