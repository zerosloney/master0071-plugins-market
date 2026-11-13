#!/usr/bin/env node
// dream-verify.test.mjs — 引用完整性对拍（dream-verify）黑盒 + 库面测试
// 夹具：临时目录造 principles / regression-checklist（主档+分片）+ specs|plans 终态存档件 + confirmations
//       台账 + workflow/archive 归档批，断行成分按用例开关。断言：①引用已删证据文件 → 点名（文档+行号+
//       失效引用）且报告落 .agents/tmp/dream-verify-<date>.md、exit 0（advisory 恒绿）；②引用在场的正常
//       文档零误报；③指纹引用对不上 confirmations → 点名；④URL 与绝对路径跳过；⑤空/缺台账 → 指纹面
//       跳过零误报；⑥终态件已归档（基名在 workflow/archive/**）不判硬漂移；⑦扫描闭集口径：specs/plans
//       仅扫终态存档件（在途稿不扫）；⑧库面 runDreamVerify 返回结构 + 报告写出 + 行号准确；⑨未知选项 exit 2；
//       ⑩--model 语义复评三态（mock runner，E 段在场且计数对、存疑注记面不变）；⑪runner 全败 → E 段
//       「不可用」且 exit 0 不变；⑫runner 缺席同 ⑪；⑬送评 20 条上限截断（库面）；⑭单条失败不阻塞其余；
//       ⑮不传 --model → 报告与旧版逐字节一致（golden 锚定）。全 mock runner，不真调模型。
// 用法：node test/dream-verify.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runDreamVerify, renderVerifyReport, runSemanticReview } from '../scripts/dream-verify.mjs';

const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dream-verify.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const put = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body, 'utf8');
};

// mkfix({ ledger, brokenPath, brokenFp })：一张原则档——ledger: 'row'|'empty'|'absent'（确认台账形态）；
// brokenPath/brokenFp：是否注入「已删证据路径行 / 台账对不上的指纹行」。URL 与绝对路径行恒在（跳过锚）。
const mkfix = ({ ledger = 'row', brokenPath = true, brokenFp = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-verify-test-'));
  const ledgerFp = sha('ledger-confirmed-content');
  const orphanFp = sha('orphan-unconfirmed-content');
  put(root, 'workflow/verify-evidence.md', '# 验证绿凭证\n');
  const lines = [
    '# 原则',
    '',
    `回归证据必须落 workflow/verify-evidence.md（在场件，零误报锚）。`,
    `已被删除的证据行：workflow/evidence/gone.md 是唯一权威凭证。`,           // 硬漂移①：路径不存在
    `指纹锚定行：${orphanFp} 为关单凭证。`,                                   // 硬漂移②：台账对不上
    `指纹在册行：${ledgerFp} 已过 confirm-doc。`,                             // 在场：零误报锚
    `外部参考见 https://example.com/workflow/also-gone.md，不判。`,           // URL 跳过
    `绝对路径样例 E:/Demo/other/workflow/also-gone.md 与 /var/data/workflow/also-gone.md，不判。`, // 绝对路径跳过
  ];
  const kept = lines.filter((l, i) => (i === 3 ? brokenPath : i === 4 ? brokenFp : true));
  put(root, 'workflow/principles.md', kept.join('\n') + '\n');
  if (ledger === 'row') {
    put(root, '.agents/confirmations.jsonl',
      JSON.stringify({ ts: '2026-11-12T00:00:00.000Z', doc: 'workflow/verify-evidence.md', stage: 'done', fingerprint: ledgerFp }) + '\n');
  } else if (ledger === 'empty') {
    put(root, '.agents/confirmations.jsonl', '');
  } // 'absent'：不造台账
  return { root, ledgerFp, orphanFp };
};

const run = (root, args) => spawnSync(process.execPath, [VERIFY, ...args], { cwd: root, encoding: 'utf8' });
const today = () => new Date().toISOString().slice(0, 10);
const readReport = (root) => fs.readFileSync(path.join(root, '.agents', 'tmp', `dream-verify-${today()}.md`), 'utf8');
const findingsOf = (root) => runDreamVerify(root).findings;

// ---- ①③ 引用已删证据 / 指纹对不上 → 点名（文档+行号+失效引用），报告落盘，exit 0 ----
{
  const { root, orphanFp } = mkfix();
  const r = run(root, ['--root', root]);
  check('① CLI exit 0（advisory 恒绿，含有存疑夹具）且报告已写入提示', r.status === 0 && /报告已写入 .*dream-verify-\d{4}-\d{2}-\d{2}\.md/.test(r.stdout), `exit=${r.status} ${r.stdout} ${r.stderr}`);
  const report = readReport(root);
  check('① 报告头带 advisory 声明与口径（不改源文档；只标硬漂移）',
    report.startsWith('# 引用完整性对拍报告 ') && report.includes('不改任何源文档') && report.includes('只标硬漂移'), report.slice(0, 300));
  check('① 点名文档+行号+失效引用（principles.md:4 引用失效 workflow/evidence/gone.md）',
    report.includes('workflow/principles.md:4') && report.includes('引用失效') && report.includes('workflow/evidence/gone.md'), report);
  check('③ 指纹对不上 → 点名（principles.md:5 指纹未对上）',
    report.includes('workflow/principles.md:5') && report.includes('指纹未对上') && report.includes(orphanFp), report);
  check('① 删除类动作仅建议（建议行含 删除须用户单独指令）', report.includes('删除须用户单独指令'), report);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ②④ 引用在场的正常文档零误报（含 URL / 绝对路径跳过） ----
{
  const { root } = mkfix({ ledger: 'row', brokenPath: false, brokenFp: false });
  const f = findingsOf(root);
  check('②④ 在场引用 + 在册指纹 + URL + 绝对路径 → 零误报', f.length === 0, JSON.stringify(f, null, 2));
  check('② 报告渲染零存疑基线文案', renderVerifyReport(runDreamVerify(root)).includes('无存疑注记'), '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ 指纹面对拍：空台账 / 缺台账 → 指纹面跳过零误报 ----
{
  for (const mode of ['empty', 'absent']) {
    const { root } = mkfix({ ledger: mode, brokenPath: false, brokenFp: true });
    const f = findingsOf(root);
    check(`⑤ ${mode === 'empty' ? '空' : '缺'}台账 → 指纹面整面跳过（零误报）`, f.length === 0, JSON.stringify(f, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- ⑥ 终态件已归档（基名在场）不判硬漂移 ----
{
  const { root } = mkfix({ brokenPath: false, brokenFp: false });
  put(root, 'workflow/archive/2026-10/specs/archived-thing.md', '---\n状态: done\n---\n# 归档件\n');
  put(root, 'workflow/principles.d/extra.md', `归档引用：workflow/specs/archived-thing.md（主档已搬家）。\n真失效：workflow/specs/really-gone.md。\n`);
  const f = findingsOf(root);
  check('⑥ 归档基名在场 → 不判硬漂移；归档无同名 → 照常点名（分片也在扫）',
    f.length === 1 && f[0].doc === 'workflow/principles.d/extra.md' && f[0].ref === 'workflow/specs/really-gone.md', JSON.stringify(f, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ 扫描闭集口径：specs/plans 仅扫终态存档件；非扫描闭集不扫 ----
{
  const { root } = mkfix({ brokenPath: false, brokenFp: false });
  put(root, 'workflow/specs/2026-01-01-done-spec.md', '---\n状态: done\n---\n终态件引用失效：workflow/evidence/spec-gone.md。\n');
  put(root, 'workflow/plans/2026-01-02-draft-plan.md', '---\n状态: approved\n---\n在途稿引用失效：workflow/evidence/plan-gone.md。\n');
  put(root, 'workflow/intents/2026-01-03-open-intent.md', '---\n状态: open\n---\n不在闭集：workflow/evidence/intent-gone.md。\n');
  const f = findingsOf(root);
  const docs = f.map((x) => x.doc);
  check('⑦ 终态 spec 存档件在扫（点名 workflow/evidence/spec-gone.md）',
    docs.includes('workflow/specs/2026-01-01-done-spec.md'), JSON.stringify(f, null, 2));
  check('⑦ 在途稿（approved）与非闭集目录（intents）不扫',
    !docs.some((d) => d.includes('draft-plan')) && !docs.some((d) => d.includes('intent')), JSON.stringify(docs));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑧ 库面 runDreamVerify：返回结构 + 报告写出 + 行号准确 ----
{
  const { root, orphanFp } = mkfix();
  const r = runDreamVerify(root);
  const byRef = Object.fromEntries(r.findings.map((x) => [x.ref, x]));
  check('⑧ 库面返回 findings 两处硬漂移，行号与夹具逐行对齐',
    byRef['workflow/evidence/gone.md'] && byRef['workflow/evidence/gone.md'].doc === 'workflow/principles.md'
      && byRef['workflow/evidence/gone.md'].line === 4
      && byRef[orphanFp] && byRef[orphanFp].kind === 'fingerprint' && byRef[orphanFp].line === 5,
    JSON.stringify(r.findings, null, 2));
  check('⑧ 报告落 <root>/.agents/tmp/dream-verify-<date>.md 且扫描面有交代',
    r.reportPath === path.join(root, '.agents', 'tmp', `dream-verify-${today()}.md`)
      && fs.existsSync(r.reportPath) && /扫描闭集 \d+ 文档/.test(readReport(root)), r.reportPath);
  check('⑧ 台账在场交代（1 个指纹值）', r.ledger.present === true && r.ledger.fingerprints === 1, JSON.stringify(r.ledger));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑨ 未知选项 exit 2（参数错误例外面） ----
{
  const { root } = mkfix();
  const bad = run(root, ['--unknown']);
  check('⑨ 未知选项 exit 2', bad.status === 2, `exit=${bad.status}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── --model 语义复评测试面：mock runner（win32 .cmd 垫片 / POSIX sh → 同一 node 替身） ──
// 替身裁决规则（按 prompt 内容分支，验证打包面）：/gone\.md/ → 失效；/不在确认台账/ → 存疑；其余 → 仍成立。
// MOCK_MODE='plain' → 纯文本（runner 全败态）；'fail-gone' → 仅 gone.md 条回纯文本（单条失败态）。
const MOCK_BODY = `const fs = require('fs');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* stdin 已关闭 */ }
if (!String(input).trim()) {
  const i = process.argv.indexOf('-p');
  if (i >= 0) input = process.argv[i + 1] || '';
}
const mode = process.env.MOCK_MODE || '';
const plain = mode === 'plain' || (mode === 'fail-gone' && String(input).includes('gone.md'));
if (plain) { process.stdout.write('纯文本，不是 JSON'); return; }
const p = String(input);
const verdict = /gone\\.md/.test(p) ? '失效' : /不在确认台账/.test(p) ? '存疑' : '仍成立';
const gtRow = p.includes('对应确认行原文') ? '+gt-row' : '';
const body = JSON.stringify({ verdict, reason: 'mock：' + verdict + gtRow });
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: body }));
`;
const mkRunner = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-verify-mock-'));
  fs.writeFileSync(path.join(dir, 'mock-model.cjs'), MOCK_BODY, 'utf8');
  let mockPath;
  if (process.platform === 'win32') {
    mockPath = path.join(dir, 'mock.cmd');
    fs.writeFileSync(mockPath, `@node "%~dp0mock-model.cjs" %*\r\n`, 'utf8');
  } else {
    mockPath = path.join(dir, 'mock.sh');
    fs.writeFileSync(mockPath, `#!/bin/sh\nexec node "$(dirname "$0")/mock-model.cjs" "$@"\n`, 'utf8');
    fs.chmodSync(mockPath, 0o755);
  }
  return { dir, mockPath };
};
const withMode = (mode, fn) => {
  const prev = process.env.MOCK_MODE;
  process.env.MOCK_MODE = mode;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = prev;
  }
};

// ---- ⑩ --model 三态：mock 回 仍成立/存疑/失效 → E 段在场、计数对、存疑注记面（A-D 语义）不变 ----
// ground truth 打包面由替身回显验证：orphan 指纹行命「不在确认台账」→ 存疑；在册指纹行命
// 「对应确认行原文」→ reason 带 +gt-row（证明确认行原文进了 prompt）。
{
  const { root, orphanFp, ledgerFp } = mkfix();
  const { dir, mockPath } = mkRunner();
  const r = run(root, ['--root', root, '--model', '--runner', mockPath]);
  check('⑩ CLI exit 0（--model 不改 advisory 退出码）且报告提示在场', r.status === 0 && /报告已写入/.test(r.stdout), `exit=${r.status} ${r.stdout}${r.stderr}`);
  check('⑩ CLI 汇总行报三态计数', /语义复评：候选 4 条，送评 4 条——仍成立 2 \/ 存疑 1 \/ 失效 1 \/ 调用失败 0/.test(r.stdout), r.stdout);
  const report = readReport(root);
  check('⑩ E 段标题与三态定义在场', report.includes('## E. 语义复评（--model）') && report.includes('仍成立=引用虽断但结论仍有据 / 存疑=需人工核 / 失效=结论已无支撑'), report.slice(-1200));
  check('⑩ 逐条 verdict+reason（硬漂移行 失效/存疑 带硬漂移标记）',
    report.includes('workflow/principles.md:4  路径引用  workflow/evidence/gone.md（硬漂移）') && /→ 失效——mock：失效/.test(report)
      && report.includes('workflow/principles.md:5  指纹引用') && /→ 存疑——mock：存疑/.test(report), report.slice(-1200));
  check('⑩ 在场引用行送评为仍成立（无硬漂移标记）；在册指纹行 prompt 取到对应确认行原文（替身回显 +gt-row）',
    report.includes('workflow/principles.md:3  路径引用  workflow/verify-evidence.md\n    → 仍成立——mock：仍成立')
      && report.includes(`workflow/principles.md:6  指纹引用  ${ledgerFp}\n    → 仍成立——mock：仍成立+gt-row`), report.slice(-1200));
  check('⑩ 汇总行计数（仍成立 2 / 存疑 1 / 失效 1 / 调用失败 0，无截断注记）',
    report.includes('汇总：仍成立 2 / 存疑 1 / 失效 1 / 调用失败 0（送评 4 条，候选 4 条）') && !report.includes('已截断'), report.slice(-600));
  check('⑩ A-D 段语义不变：存疑注记清单仍点名两处硬漂移 + 口径附注声明 opt-in',
    report.includes('workflow/principles.md:4') && report.includes('指纹未对上') && report.includes(orphanFp)
      && report.includes('本次带 --model 语义复评（opt-in') && report.includes('model-call.mjs'), report.slice(0, 600));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---- ⑪ --model runner 全败 → E 段单行「不可用」且 exit 0 不变 ----
{
  const { root } = mkfix();
  const { dir, mockPath } = mkRunner();
  withMode('plain', () => {
    const r = run(root, ['--root', root, '--model', '--runner', mockPath]);
    const report = readReport(root);
    check('⑪ exit 0（全败不升红）且 E 段单行不可用', r.status === 0 && report.includes('语义复评不可用：送评 4 条全部调用失败（末次错误：non-json'), `exit=${r.status}\n${report.slice(-500)}`);
    check('⑪ 全败时无逐条清单与汇总（E 段单行口径）', !report.includes('汇总：仍成立') && (report.match(/→ /g) || []).length === 2, report.slice(-500));
    check('⑪ CLI 汇总行报不可用', /语义复评不可用：/.test(r.stdout), r.stdout);
  });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---- ⑫ --model runner 缺席（显式不存在路径）→ 同「不可用」单行 + exit 0 ----
{
  const { root } = mkfix();
  const { dir } = mkRunner();
  const absent = path.join(dir, 'absent-runner.exe');
  const r = run(root, ['--root', root, '--model', '--runner', absent]);
  const report = readReport(root);
  check('⑫ exit 0 且 E 段单行不可用（spawn 缺席形态）', r.status === 0 && report.includes('语义复评不可用：送评 4 条全部调用失败（末次错误：spawn:'), `exit=${r.status}\n${report.slice(-500)}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---- ⑬ 送评上限：22 条候选一次 --model 只送 20 条（库面直调 runSemanticReview） ----
{
  const { dir, mockPath } = mkRunner();
  const items = Array.from({ length: 22 }, (_, i) => ({
    doc: 'workflow/principles.md', line: i + 1, kind: 'path',
    ref: `workflow/evidence/item-${i}.md`, status: 'missing', drift: true, lineText: `断言行 ${i}`,
  }));
  const ledger = { present: false, fingerprints: new Set(), rows: [] };
  const s = runSemanticReview({ root: os.tmpdir(), items, ledger, runner: mockPath });
  check('⑬ requested=22 / sent=20（超出截断）', s.requested === 22 && s.sent === 20, JSON.stringify({ requested: s.requested, sent: s.sent }));
  check('⑬ 计数全 仍成立 20、无不可用', s.counts.still === 20 && s.counts.failed === 0 && s.unavailable === '', JSON.stringify(s.counts));
  const rendered = renderVerifyReport({
    date: '2026-01-01', root: '.', scanned: { docs: 1, lines: 30, archiveDocs: 0 },
    ledger: { present: false, fingerprints: 0 }, findings: [], semantic: s,
  });
  check('⑬ E 段注明截断（超出 20 条上限已截断）', rendered.includes('超出 20 条上限已截断') && rendered.includes('送评 20 条，候选 22 条'), rendered.slice(-500));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---- ⑭ 单条失败不阻塞其余：fail-gone 只废 gone.md 条，其余照常裁决 ----
{
  const { root } = mkfix();
  const { dir, mockPath } = mkRunner();
  withMode('fail-gone', () => {
    const r = run(root, ['--root', root, '--model', '--runner', mockPath]);
    const report = readReport(root);
    check('⑭ exit 0；失败条出「调用失败」、其余条照常三态裁决（不整段不可用）',
      r.status === 0 && /→ 调用失败：non-json/.test(report) && /→ 仍成立——mock：仍成立/.test(report) && /→ 存疑——mock：存疑/.test(report)
        && !report.includes('语义复评不可用'), `exit=${r.status}\n${report.slice(-900)}`);
    check('⑭ 汇总计数含调用失败 1', report.includes('汇总：仍成立 2 / 存疑 1 / 失效 0 / 调用失败 1'), report.slice(-400));
  });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---- ⑮ 不传 --model → 报告与旧版逐字节一致（golden 锚定；库面无 semantic 字段） ----
{
  const { root, orphanFp } = mkfix();
  const r = runDreamVerify(root);
  const golden = [
    `# 引用完整性对拍报告 ${today()}`,
    '> 生成: node <插件根>/scripts/dream-verify.mjs（advisory 只读校错——不改任何源文档，不自动 commit / push；删除类动作仅建议，删除须用户单独指令）',
    '> 口径：校错止于引用完整性，只标硬漂移（引用了不存在的东西）；语义真伪不判（离线无模型，宁漏报不误报）。',
    '',
    '扫描闭集 1 文档 / 9 行（principles、regression-checklist 主档+分片、specs|plans 终态存档件）；归档基名 0；指纹台账 在场（1 个指纹值）。',
    '',
    '## 存疑注记清单',
    '',
    '  - workflow/principles.md:4  引用失效  workflow/evidence/gone.md',
    '    → 路径不存在且归档无同名件——复评该行：更新为现路径或删行（删除须用户单独指令）',
    `  - workflow/principles.md:5  指纹未对上  ${orphanFp}`,
    '    → 指纹在确认台账（confirmations.jsonl ∪ 分片）对不上——复评来源：重录确认（confirm-doc）或删行（删除须用户单独指令）',
    '',
  ].join('\n');
  const report = fs.readFileSync(r.reportPath, 'utf8');
  check('⑮ 不传 --model → 报告与旧版逐字节一致（golden）且无 semantic 字段/无 E 段',
    report === golden && !('semantic' in r) && !report.includes('E. 语义复评'),
    `diff 头: ${JSON.stringify(report.slice(0, 120))}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
