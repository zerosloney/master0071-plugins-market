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
  // 引文接地同口径（2026-10-29）：旧实现硬编码 quoteGrounding:'verbatim'，纯放行语也记成
  // 逐字命中，与 confirm-doc.mjs 两套口径。现在走 groundQuote：正文里找得到落点才 verbatim。
  // 「修复以上问题」与该夹具正文无词面落点 → ungrounded（正是要抓的假 verbatim）。
  assert.equal(r.row.quoteGrounding, 'ungrounded', `实得 ${r.row.quoteGrounding}`);
  assert.equal(r.row.residual, '复以上', '未接地行带 residual 供对质');
  const verbatim = buildCompensation(linesDone, 'done', lastRow, '改后内容', '2026-10-25T00:00:00.000Z');
  assert.equal(verbatim.row.quoteGrounding, 'verbatim', 'quote 与正文逐字一致时必须记 verbatim');
  assert.equal(verbatim.row.residual, undefined, '接地成立行不带 residual');
  console.log('PASS 场景 1：补偿行形态与 bindingSha256(lines, prev) 口径（判别于直接哈希）');
  console.log('PASS 场景 1b：quoteGrounding 与 confirm-doc 同判据（非硬编码 verbatim）');
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

// 场景 6：非 git 目录里 import check-loop-kit 不得静默 exit 0（2026-10-28 市场审查 P0-3 根因）
// 本套件的存在理由就是这条历史坑：append-compensation.mjs 曾因 `import { bindingSha256 } from
// './check-loop-kit.mjs'` 继承 kit 顶层的「不在 git 仓库内 → 跳过扫描 → exit 0」，于是在临时目录
// 连 `--help` 都返回成功而主逻辑从未跑过——典型的假绿。它已改走零副作用的 binding.mjs，但**根因
// 在 kit 本块**：任何后来者再 import kit 都会重新中招。这里钉死两条相反的语义，防止「一视同仁改成
// 抛错」把物理闸门（pre-commit / pre-push 在非 git 目录本就该 no-op）也一起弄红。
{
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const kit = new URL('../scripts/check-loop-kit.mjs', import.meta.url).href; // import() 只认 file:// URL
  const checkLoop = fileURLToPath(new URL('../scripts/check-loop.mjs', import.meta.url));
  const bareEnv = { ...process.env };
  delete bareEnv.CHECK_LOOP_ROOT; // 让 kit 走真实的 resolveProjectRoot 分支，不走 fixture 注入
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-nogit-'));

  // ① 非主入口 import（node -e 时 argv[1] 不是 check-loop.mjs）→ 必须非零退出 + 指名原因
  const imp = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(kit)});`],
    { cwd: noGit, encoding: 'utf8', env: bareEnv });
  assert.notEqual(imp.status, 0, `import kit 竟 exit 0（假绿复发）：stdout=${imp.stdout} stderr=${imp.stderr}`);
  assert.match(imp.stderr + imp.stdout, /拒绝沿用/, `import kit 失败原因未指名：${imp.stderr}`);

  // ② check-loop 主入口在非 git 目录仍是「跳过扫描 + exit 0」——物理闸门契约不得被我等收紧弄坏
  const main = spawnSync(process.execPath, [checkLoop], { cwd: noGit, encoding: 'utf8', env: bareEnv });
  assert.equal(main.status, 0, `check-loop 主入口在非 git 目录应 no-op 退出 0，实得 ${main.status}：${main.stderr}`);
  assert.match(main.stderr, /不在 git 仓库内,跳过扫描/, `主入口语义变了：${main.stderr}`);
  console.log('PASS 场景 6：kit 非主入口 import 抛错 / check-loop 主入口仍 exit 0（语义分叉成立）');
}
