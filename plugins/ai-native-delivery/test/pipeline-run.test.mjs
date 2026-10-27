#!/usr/bin/env node
// pipeline-run.test.mjs — pipeline-run 状态机测试（2026-10-02 pipeline-run）
// 方法：临时夹具树 + 假门脚本（fill-*/confirm-doc/verify/kb-search/gen-workflow-index/check-loop）
//       + 假 git（PIPELINE_RUN_GIT_BIN="node <fixture>/fake-git.mjs"，行为经 FIXTURE_GIT_STATUS 控制），
//       驱动真实 pipeline-run.mjs 走全路径；断言 stdout 的 PIPELINE-STOP 标记、run 文件事件流、假 git/台账日志。
// 运行：node test/pipeline-run.test.mjs（不触真实仓库/真实 git）
// 注意：夹具路径不含空格（os.tmpdir）；假 git 经 env 前缀注入（跨平台不依赖 shell）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：被测脚本在 ../scripts/（原与测试同目录的源仓形态）
const MAIN = path.join(HERE, '..', 'scripts', 'pipeline-run.mjs');

// ── 夹具构建 ────────────────────────────────────────────────────────────
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prun-'));
  const bin = path.join(root, '.agents', 'scripts');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  for (const d of ['intents', 'specs', 'plans', 'incidents']) fs.mkdirSync(path.join(root, 'workflow', d), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'workflow-modules.txt'), '# 词表\npipeline\nwiki\n');

  const fake = (name, src) => fs.writeFileSync(path.join(bin, name), src);

  fake('kb-search.mjs', `#!/usr/bin/env node
console.log('── workflow（1 个文件命中）──');
console.log('📄 workflow/intents/1900-01-01-demo.md — done · L2 · pipeline · 1 处命中');
`);

  const FILL_HEAD = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
const t = args[args.indexOf('--topic') + 1] || 'task';
const lv = args[args.indexOf('--level') + 1] || 'L2';
fs.mkdirSync(path.dirname(out), { recursive: true });
`;
  fake('fill-intent.mjs', FILL_HEAD + `const body = '---\\n状态: draft\\n级别: ' + lv + '\\nrisk_level: ' + lv + '\\n日期: 2026-10-02\\n模块: pipeline\\n---\\n# INTENT — ' + t + '\\n\\n## 背景与问题\\n<为什么做>\\n\\n## 历史教训/防复发\\n- 无\\n\\n## 目标\\n- 目标一\\n\\n## 非目标\\n- 不做\\n\\n## 约束\\n- 复用\\n\\n## 验收标准\\n\\n- [ ] 项一（证据：）\\n- [ ] 项二（证据：）\\n\\n## 确认与复核\\n- 待\\n';
fs.writeFileSync(out, body);
console.log('✅ intent 草稿：' + out);
`);
  fake('fill-spec.mjs', FILL_HEAD + `const body = '---\\n状态: draft\\n级别: ' + lv + '\\n日期: 2026-10-02\\n模块: pipeline\\n---\\n# SPEC — ' + t + '\\n\\n## 功能行为\\n行为。\\n\\n## 数据流\\n流。\\n\\n## 系统改动\\n\\n- 改动一\\n\\n## 约束遵守映射\\n- 回应。\\n\\n## 风险评估\\n- 低。\\n\\n## 确认与复核\\n- 复核：待\\n';
fs.writeFileSync(out, body);
console.log('✅ spec 草稿：' + out);
`);
  fake('fill-plan.mjs', FILL_HEAD + `const body = '---\\n状态: draft\\n级别: ' + lv + '\\n模块: pipeline\\n---\\n# PLAN — ' + t + '\\n\\n## 入口\\n\\n- 来源：对话\\n- 目标：完成功能\\n\\n## 改动方案\\n\\n- src/app.mjs：实现功能\\n\\n## 约束与风险\\n\\n- 风险低\\n\\n## 任务拆解\\n\\n1. 实现\\n\\n## 执行顺序\\n\\n1\\n\\n## 验证计划\\n\\n- 静态门：npm test\\n\\n## 验收标准（可测试）\\n\\n- [ ] 项一（证据：）\\n- [ ] 项二（证据：）\\n\\n## 确认与复核\\n- 待\\n';
fs.writeFileSync(out, body);
console.log('✅ plan 草稿：' + out);
`);

  fake('confirm-doc.mjs', `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const doc = args.find((x) => !x.startsWith('--'));
const to = args.includes('--to') ? args[args.indexOf('--to') + 1] : undefined;
const q = args.includes('--delegated') ? args[args.indexOf('--delegated') + 1] : undefined;
if (process.env.FIXTURE_CONFIRM_REJECT === '1') { console.error('前置门拒绝（夹具强制）'); process.exit(2); }
const text = fs.readFileSync(doc, 'utf8');
const cur = (text.match(/^状态: (.*)$/m) || [])[1];
const target = to || ({ draft: 'approved', approved: 'done', open: 'fixed', fixed: 'closed' })[cur] || cur;
fs.writeFileSync(doc, text.replace(/^状态: .*$/m, '状态: ' + target));
fs.appendFileSync(process.env.PRTEST_LEDGER, JSON.stringify({ doc, to: target, quote: q }) + '\\n');
console.log('✓ ' + doc + ' ' + cur + ' → ' + target + '（source=chat-delegated）');
`);

  fake('verify.mjs', `#!/usr/bin/env node
import fs from 'node:fs';
if (fs.existsSync(process.env.PRTEST_VERIFY_FAIL || '/nonexist')) { console.error('verify 失败（夹具）：1/2 npm test 未通过'); process.exit(1); }
console.log('[verify] ✅ 全绿');
`);

  fake('gen-workflow-index.mjs', '#!/usr/bin/env node\nconsole.log("index ok");\n');
  fake('check-loop.mjs', '#!/usr/bin/env node\nconsole.log("check-loop ok");\n');

  fake('fake-git.mjs', `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PRTEST_GITLOG, args.join(' ') + '\\n');
if (args[0] === 'status' && args[1] === '--porcelain') { process.stdout.write(process.env.FIXTURE_GIT_STATUS || ''); process.exit(0); }
if (args[0] === 'rev-parse') { console.log('abc1234'); process.exit(0); }
process.exit(0);
`);

  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '_TEMPLATE.md'),
    '---\n状态: open\n日期: 2026-10-02\n模块: pipeline\n---\n# INCIDENT — 模板\n\n## 时间线\n\n<时间线>\n\n## 根因\n\n<根因>\n\n## 复盘三件套\n\n<三件套>\n');

  const gitLog = path.join(root, 'git.log');
  const ledger = path.join(root, 'confirm-ledger.jsonl');
  fs.writeFileSync(gitLog, '');
  fs.writeFileSync(ledger, '');
  return { root, bin, gitLog, ledger, verifyFailMarker: path.join(root, 'verify-fail-marker') };
}

// ── 驱动 ───────────────────────────────────────────────────────────────
function prun(fixture, args, extraEnv = {}) {
  const env = {
    ...process.env,
    PIPELINE_RUN_ROOT: fixture.root,
    PIPELINE_RUN_BIN: fixture.bin,
    PIPELINE_RUN_GIT_BIN: `node ${path.join(fixture.bin, 'fake-git.mjs')}`,
    PRTEST_GITLOG: fixture.gitLog,
    PRTEST_LEDGER: fixture.ledger,
    PRTEST_VERIFY_FAIL: fixture.verifyFailMarker,
    PIPELINE_RUN_TODAY: '2026-10-02', // 固定日期锚：消除测试对系统时钟的依赖（断言路径全部硬编码本日）
    ...extraEnv,
  };
  return spawnSync(process.execPath, [MAIN, ...args], { env, encoding: 'utf8', windowsHide: true });
}
const out = (p) => p.stdout || '';
const runsDir = (f) => path.join(f.root, '.agents', 'cache', 'pipeline-runs');
const runFile = (f, id) => JSON.parse(fs.readFileSync(path.join(runsDir(f), `${id}.json`), 'utf8'));
const latestId = (f) => fs.readdirSync(runsDir(f)).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5)).sort().pop();
const docP = (f, rel) => path.join(f.root, rel);
function editDoc(f, rel, fn) { const p = docP(f, rel); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); }
const fillValid = (t) => t.replace(/<为什么做>|<时间线>|<根因>|<三件套>/g, '已填实的正文内容。');

let PASS = 0, FAIL = 0; // FAIL 计数（2026-10-18 口径统一：末行报「合计: PASS/FAIL」入 run-tests 聚合）
// 注册表化（2026-10-10 shard-check-loop-test 二期）：test() 只注册，执行统一交文件末三态驱动器
//（shard 子进程 / parent 自分片 / 顺序）——注册期零执行，语义与原「注册即执行」在顺序态逐点等价。
const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }
const runOne = (t) => {
  try { t.fn(); console.log(`✅ ${t.name}`); PASS++; }
  catch (e) { console.error(`❌ ${t.name}\n${(e && e.stack) || e}`); FAIL++; process.exitCode = 1; }
};

// 通用推进器：L1/L2 到 implement 工单停机（返回 fixture）
function driveToImplement(f, level, topic) {
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', `kind=require level=${level} module=wiki topic=${topic}`]);
  if (level === 'L1') {
    editDoc(f, `workflow/plans/2026-10-02-${topic}.md`, fillValid);
    prun(f, ['next']);
    prun(f, ['next', '--delegated', 'plan ok']);
    prun(f, ['next', '--delegated', '改动清单 ok']);
    return;
  }
  editDoc(f, `workflow/intents/2026-10-02-${topic}.md`, fillValid);
  prun(f, ['next']);
  prun(f, ['next', '--delegated', 'intent ok']);
  if (level === 'L2') {
    editDoc(f, `workflow/specs/2026-10-02-${topic}.md`, fillValid);
    prun(f, ['next']);
    prun(f, ['next', '--delegated', 'spec ok']);
  }
  editDoc(f, `workflow/plans/2026-10-02-${topic}.md`, fillValid);
  prun(f, ['next']);
  prun(f, ['next', '--delegated', 'plan ok']);
  prun(f, ['next', '--delegated', '改动清单 ok']);
}

// ── 用例 ───────────────────────────────────────────────────────────────
test('start → triage 工单 + run 文件落盘', () => {
  const f = buildFixture();
  const p = prun(f, ['start', '给 wiki 看板加 dark theme']);
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /PIPELINE-STOP work-order/);
  const run = runFile(f, latestId(f));
  assert.equal(run.stage, 'triage');
  assert.equal(run.events[0].type, 'run-created');
});

test('start 缺需求 → exit 1', () => {
  const f = buildFixture();
  assert.equal(prun(f, ['start']).status, 1);
});

test('triage 回填 → kb+fill 门 → 起草工单（L2）', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  const p = prun(f, ['next', '--triage', 'kind=require level=L2 module=wiki topic=demo']);
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /PIPELINE-STOP work-order/);
  const run = runFile(f, latestId(f));
  assert.equal(run.docs.entry, 'workflow/intents/2026-10-02-demo.md');
  assert.ok(fs.existsSync(docP(f, run.docs.entry)), 'fill-intent 应已生成草稿');
  const gates = run.events.filter((e) => e.type === 'gate');
  assert.ok(gates.length >= 2, 'kb-search + fill-intent 两道门');
  assert.ok(gates.every((e) => e.exit === 0));
  assert.ok(run.workOrder.context.kbHits.length > 0, '查重命中附进工单');
});

test('占位符残留 → gate-fail exit 2；填实 → 等确认', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L2 module=wiki topic=demo']);
  const p1 = prun(f, ['next']);
  assert.equal(p1.status, 2);
  assert.match(out(p1), /占位符/);
  assert.match(out(p1), /PIPELINE-STOP gate-fail/);
  editDoc(f, 'workflow/intents/2026-10-02-demo.md', (t) => fillValid(t) + '\n用法备注：回跑 `next --delegated "<原话>"`（命令语法占位在 code span 内，不属模板占位符——复核 P1-3 回归）\n\n```\nnext --delegated <原话>\nnext --files <清单>\n```\n（上行围栏块内裸尖括号命令示例——复核 P2-B 回归，整块剔除不误拦）\n');
  const p2 = prun(f, ['next']);
  assert.equal(p2.status, 0, out(p2));
  assert.match(out(p2), /PIPELINE-STOP await-confirm [\w-]+ workflow\/intents\/2026-10-02-demo\.md/);
});

test('确认门：无原话重停；有原话过 confirm-doc；幂等不重跑 fill', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L2 module=wiki topic=demo']);
  editDoc(f, 'workflow/intents/2026-10-02-demo.md', fillValid);
  prun(f, ['next']);
  const p = prun(f, ['next']); // 无 --delegated：重停
  assert.equal(p.status, 0);
  assert.match(out(p), /PIPELINE-STOP await-confirm/);
  const p2 = prun(f, ['next', '--delegated', '可以，按这个来']);
  assert.equal(p2.status, 0, out(p2));
  const run = runFile(f, latestId(f));
  assert.equal(run.stage, 'spec-draft');
  assert.equal(run.events.filter((e) => e.type === 'gate' && e.cmd.includes('fill-intent')).length, 1, 'next 重入不重复 fill');
  const conf = run.events.filter((e) => e.type === 'confirm');
  assert.equal(conf.length, 1);
  assert.equal(conf[0].source, 'chat-delegated');
  assert.equal(conf[0].quote, '可以，按这个来');
});

test('L1 普通需求 plan 确认提交标题为单份 plan', () => {
  const f = buildFixture();
  driveToImplement(f, 'L1', 'solo');
  const log = fs.readFileSync(f.gitLog, 'utf8');
  assert.match(log, /commit -m docs\(workflow\): solo plan approved/);
  assert.doesNotMatch(log, /两件套/);
});

test('L2 全程到 done：spec→plan→改动清单→实现→复核→勾验→关单×3→双批提交', () => {
  const f = buildFixture();
  driveToImplement(f, 'L2', 'demo');
  const specRel = 'workflow/specs/2026-10-02-demo.md';
  const intentRel = 'workflow/intents/2026-10-02-demo.md';
  // 批次一提交已在假 git 日志（plan 确认时）
  assert.match(fs.readFileSync(f.gitLog, 'utf8'), /commit -m docs\(workflow\): demo 三件套 approved/);
  // 实现（git 状态=授权文件）→ L2 → 复核工单
  const pImp = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.equal(pImp.status, 0, out(pImp));
  assert.match(out(pImp), /PIPELINE-STOP work-order/);
  editDoc(f, specRel, (t) => t.replace('- 复核：待', '- 复核：无 P0/P1 问题'));
  const pRev = prun(f, ['next'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.match(out(pRev), /PIPELINE-STOP work-order/); // closeout 工单
  editDoc(f, intentRel, (t) => t.replace('- [ ] 项一（证据：）', '- [x] 项一（证据：abc1234）').replace('- [ ] 项二（证据：）', '- [x] 项二（证据：t1）'));
  prun(f, ['next'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' }); // done-confirm 停机
  prun(f, ['next', '--delegated', '关单 intent'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  prun(f, ['next', '--delegated', '关单 spec'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  const pDone = prun(f, ['next', '--delegated', '关单 plan'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.equal(pDone.status, 0, out(pDone));
  assert.match(out(pDone), /PIPELINE-STOP done/);
  const run = runFile(f, latestId(f));
  assert.equal(run.stopType, 'done');
  assert.equal(run.events.filter((e) => e.type === 'commit').length, 3, '批次一 + 代码提交 + 批次二');
  assert.match(fs.readFileSync(f.gitLog, 'utf8'), /commit -m feat\(wiki\): /, 'verify 绿后落代码提交（沙箱演练实证缺口）');
  assert.equal(fs.readFileSync(docP(f, run.docs.entry), 'utf8').match(/^状态: (.*)$/m)[1], 'done');
  assert.equal(fs.readFileSync(docP(f, run.docs.spec), 'utf8').match(/^状态: (.*)$/m)[1], 'done');
  const ledger = fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 6, '3×approved + 3×done');
  assert.ok(ledger.every((l) => typeof l.quote === 'string' && l.quote), '逐份原话');
});

test('改动越权 → gate-fail 偏离即停', () => {
  const f = buildFixture();
  driveToImplement(f, 'L1', 'ov1');
  const p = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs\n?? sneaky.mjs' });
  assert.equal(p.status, 2);
  assert.match(out(p), /超出回填清单/);
});

test('运行态副产物不误拦（confirmations/INDEX/cache 排除）——沙箱演练回归', () => {
  const f = buildFixture();
  driveToImplement(f, 'L1', 'rt1');
  const p = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M .agents/confirmations.jsonl\n M workflow/INDEX.md\n?? .agents/cache/pipeline-runs/x.json\n?? src/app.mjs' });
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /PIPELINE-STOP work-order/); // 不被运行态误拦，推进至下一停机点
});

test('implement 无 --files 重入 → 重发工单不误报', () => {
  const f = buildFixture();
  driveToImplement(f, 'L1', 'rf1');
  const p = prun(f, ['next']);
  assert.equal(p.status, 0);
  assert.match(out(p), /PIPELINE-STOP work-order/);
});

test('verify 失败 → 修复环 1/3（stderr 附工单）→ 修复后通过', () => {
  const f = buildFixture();
  fs.writeFileSync(f.verifyFailMarker, 'fail');
  driveToImplement(f, 'L1', 'f1');
  const p1 = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.equal(p1.status, 0);
  assert.match(out(p1), /修复环 1\/3/);
  assert.match(out(p1), /verify 失败（夹具）/);
  fs.rmSync(f.verifyFailMarker);
  const p2 = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.equal(p2.status, 0, out(p2));
  assert.match(out(p2), /PIPELINE-STOP work-order/); // L1 → closeout 工单
  assert.equal(runFile(f, latestId(f)).fixLoop.count, 0, '验证绿后 count 复位（1/3 已在上方标题断言）');
});

test('修复环 cap 3 → 超限 gate-fail exit 2', () => {
  const f = buildFixture();
  fs.writeFileSync(f.verifyFailMarker, 'fail');
  driveToImplement(f, 'L1', 'f2');
  prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  const p = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.equal(p.status, 2);
  assert.match(out(p), /修复环超限/);
});

test('verify-only 短路径直达 done', () => {
  const f = buildFixture();
  prun(f, ['start', '跑下 verify']);
  const p = prun(f, ['next', '--triage', 'kind=verify level=L1 module=pipeline topic=v1']);
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /PIPELINE-STOP done/);
  assert.ok(runFile(f, latestId(f)).events.some((e) => e.type === 'gate' && e.cmd.includes('verify.mjs') && e.exit === 0));
});

test('review-only：工单 → --done 收尾可达（复核 P1-1 回归）', () => {
  const f = buildFixture();
  prun(f, ['start', '评审一下']);
  const pw = prun(f, ['next', '--triage', 'kind=review level=L1 module=pipeline topic=rv1']);
  assert.match(out(pw), /PIPELINE-STOP work-order/);
  const pd = prun(f, ['next', '--done']);
  assert.equal(pd.status, 0, out(pd));
  assert.match(out(pd), /PIPELINE-STOP done/);
});

// deploy 夹具：预置终态/非终态三件套
function seedDeployDocs(f, { intentState, planState, specState, topic = 'dep1' }) {
  const w = (rel, fm) => fs.writeFileSync(path.join(f.root, rel), `---\n${fm}\n---\n# DOC — ${topic}\n\n## 正文\n\n内容。\n`);
  w(`workflow/intents/2026-10-02-${topic}.md`, `状态: ${intentState}\n级别: L1\n日期: 2026-10-02\n模块: pipeline`);
  w(`workflow/plans/2026-10-02-${topic}.md`, `状态: ${planState}\n级别: L1\n模块: pipeline`);
  if (specState) w(`workflow/specs/2026-10-02-${topic}.md`, `状态: ${specState}\n级别: L2\n日期: 2026-10-02\n模块: pipeline`);
}

test('deploy 路径：三件 done → prep 工单 → 机器校验 → 授权 → done（复核 P1-2 补实现）', () => {
  const f = buildFixture();
  seedDeployDocs(f, { intentState: 'done', planState: 'done' });
  prun(f, ['start', '可以上了']);
  const pw = prun(f, ['next', '--triage', 'kind=deploy level=L1 module=pipeline topic=dep1']);
  assert.equal(pw.status, 0, out(pw));
  assert.match(out(pw), /deploy-prep/);
  assert.match(out(pw), /PIPELINE-STOP work-order/);
  const pv = prun(f, ['next']);
  assert.equal(pv.status, 0, out(pv));
  assert.match(out(pv), /await-confirm/); // 三件校验过 → 停授权点
  const pd = prun(f, ['next', '--delegated', '上']);
  assert.equal(pd.status, 0, out(pd));
  assert.match(out(pd), /PIPELINE-STOP done/);
  const run = runFile(f, latestId(f));
  assert.equal(run.deployTarget.plan, 'workflow/plans/2026-10-02-dep1.md');
});

test('deploy 三件缺口 → gate-fail 列缺口 exit 2（P1-2）', () => {
  const f = buildFixture();
  seedDeployDocs(f, { intentState: 'done', planState: 'approved' }); // plan 未关单
  prun(f, ['start', '可以上了']);
  prun(f, ['next', '--triage', 'kind=deploy level=L1 module=pipeline topic=dep1']);
  const p = prun(f, ['next']);
  assert.equal(p.status, 2);
  assert.match(out(p), /须 done/);
  assert.match(out(p), /2026-10-02-dep1\.md（approved/);
});

test('deploy 边界：incident closed 但 plan 缺失 → gate-fail（复核 P2-C 回归）', () => {
  const f = buildFixture();
  fs.writeFileSync(path.join(f.root, 'workflow', 'incidents', '2026-10-02-incd.md'),
    '---\n状态: closed\n发现: 2026-10-02\n模块: pipeline\n---\n# INCIDENT — incd\n\n## 时间线\n\n- x\n\n## 根因\n\nx\n\n## 复盘三件套\n\nx\n');
  prun(f, ['start', '可以上了']);
  prun(f, ['next', '--triage', 'kind=deploy level=L1 module=pipeline topic=incd']);
  const p = prun(f, ['next']);
  assert.equal(p.status, 2);
  assert.match(out(p), /plans\/2026-10-02-incd\.md（缺失——须 done）/);
});

test('deploy 边界：topic 子串不再误匹配（复核 P2-C 收紧回归）', () => {
  const f = buildFixture();
  seedDeployDocs(f, { intentState: 'done', planState: 'done', topic: 'dep1' });
  prun(f, ['start', '可以上了']);
  const p = prun(f, ['next', '--triage', 'kind=deploy level=L1 module=pipeline topic=dep']); // 旧版 includes 会误命中 dep1
  assert.equal(p.status, 2);
  assert.match(out(p), /找不到可上线的对象/);
});

// （2026-10-08 decouple-flow-kit）原 P2-4 A′ 三条用例（提交命中 managed 面：降级 WARN / 包源自动 sync /
// 未命中不告警）随 managedFaceCheck 整段退役删除——判据依赖 kit.json `managed` 字段与 bin/flow-kit.mjs，
// 二者均不在仓内（前者随解耦从 kit.json 移除，后者为包源仓专有）。

test('rename 行 old+new 双收录防逃逸（复核 P2-2 回归）', () => {
  const f = buildFixture();
  driveToImplement(f, 'L1', 'rn1');
  const p = prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: 'R  old.mjs -> src/app.mjs' });
  assert.equal(p.status, 2);
  assert.match(out(p), /old\.mjs/); // 旧路径删除计入改动面 → 越权拦截
});

test('布尔旗标不吞参：status --json --run <id>（复核 P2-5 回归）', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L2 module=wiki topic=demo']); // 建第二个可辨 run 前，确保 latest 唯一
  const id = latestId(f);
  const p = prun(f, ['status', '--json', '--run', id]);
  assert.equal(p.status, 0);
  assert.match(out(p), new RegExp('"runId": "' + id + '"')); // --run 生效（未被 --json 吞掉）
});

test('空「证据：」不过勾验（复核 P2-6 回归）', () => {
  const f = buildFixture();
  driveToImplement(f, 'L1', 'ev1');
  prun(f, ['next', '--files', 'src/app.mjs'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' }); // verify 绿 → closeout WO
  editDoc(f, 'workflow/plans/2026-10-02-ev1.md', (t) => t.replace(/- \[ \] 项一（证据：）/, '- [x] 项一（证据：）').replace(/- \[ \] 项二（证据：）/, '- [x] 项二（证据：t1）'));
  const p = prun(f, ['next'], { FIXTURE_GIT_STATUS: ' M src/app.mjs' });
  assert.equal(p.status, 0);
  assert.match(out(p), /PIPELINE-STOP work-order/); // 空证据 → 重发 closeout 工单，不进关单
  assert.match(out(p), /（closeout）勾验收补证据/);
});

test('incident 路径：模板复制→两跳 fixed/closed→plan 不可免', () => {
  const f = buildFixture();
  prun(f, ['start', '线上出事了']);
  prun(f, ['next', '--triage', 'kind=fix level=L1 module=pipeline topic=inc9']);
  assert.ok(fs.existsSync(docP(f, 'workflow/incidents/2026-10-02-inc9.md')), '模板已复制');
  editDoc(f, 'workflow/incidents/2026-10-02-inc9.md', fillValid);
  prun(f, ['next']); // 事故草稿确认（对话级）
  prun(f, ['next', '--delegated', '事故草稿通过']);
  assert.ok(fs.existsSync(docP(f, 'workflow/plans/2026-10-02-inc9.md')), 'plan 不可免');
  editDoc(f, 'workflow/plans/2026-10-02-inc9.md', fillValid);
  prun(f, ['next']);
  prun(f, ['next', '--delegated', 'plan ok']);
  prun(f, ['next', '--delegated', '改动清单 ok']);
  prun(f, ['next', '--files', 'src/hotfix.mjs'], { FIXTURE_GIT_STATUS: ' M src/hotfix.mjs' }); // verify 绿 → fixed 确认停机
  prun(f, ['next', '--delegated', 'fixed 确认'], { FIXTURE_GIT_STATUS: ' M src/hotfix.mjs' }); // open→fixed
  prun(f, ['next', '--delegated', 'closed 确认'], { FIXTURE_GIT_STATUS: ' M src/hotfix.mjs' }); // fixed→closed
  const p = prun(f, ['next', '--delegated', 'plan 关单'], { FIXTURE_GIT_STATUS: ' M src/hotfix.mjs' }); // plan done → 终态
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /PIPELINE-STOP done/);
  assert.equal(fs.readFileSync(docP(f, 'workflow/incidents/2026-10-02-inc9.md'), 'utf8').match(/^状态: (.*)$/m)[1], 'closed');
});

test('confirm-doc exit 2 → gate-fail 透传不绕（真实退出码入事件流）', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L1 module=wiki topic=rj']);
  editDoc(f, 'workflow/plans/2026-10-02-rj.md', fillValid);
  prun(f, ['next']);
  const p = prun(f, ['next', '--delegated', 'ok'], { FIXTURE_CONFIRM_REJECT: '1' });
  assert.equal(p.status, 2);
  assert.match(out(p), /exit 2/);
  const last = runFile(f, latestId(f)).events.filter((e) => e.type === 'gate').pop();
  assert.equal(last.exit, 2);
});

test('工单/事件流 schema 键集（契约防漂移）', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L2 module=wiki topic=sm']);
  const run = runFile(f, latestId(f));
  for (const k of ['id', 'kind', 'title', 'goal', 'instructions', 'context', 'constraints', 'acceptance']) {
    assert.ok(k in run.workOrder, `workOrder 缺键 ${k}`);
  }
  for (const k of ['kbHits', 'stderrTail', 'relatedDocs', 'docPath']) assert.ok(k in run.workOrder.context);
  const gate = run.events.find((e) => e.type === 'gate');
  for (const k of ['t', 'type', 'cmd', 'exit', 'ms']) assert.ok(k in gate, `gate 事件缺键 ${k}`);
});

test('abort：approved 文档走 --to 显式放弃并提交', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L1 module=wiki topic=ab1']);
  editDoc(f, 'workflow/plans/2026-10-02-ab1.md', fillValid);
  prun(f, ['next']);
  prun(f, ['next', '--delegated', 'approved 了']);
  const p = prun(f, ['abort', '--run', latestId(f), '--to', 'cancelled', '--delegated', '不做这个了']);
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /PIPELINE-STOP aborted/);
  assert.equal(fs.readFileSync(docP(f, 'workflow/plans/2026-10-02-ab1.md'), 'utf8').match(/^状态: (.*)$/m)[1], 'cancelled');
  assert.match(fs.readFileSync(f.gitLog, 'utf8'), /docs\(workflow\): ab1 放弃/);
});

test('status --adopt：run 文件丢失后按文档重建', () => {
  const f = buildFixture();
  prun(f, ['start', '给 wiki 加主题']);
  prun(f, ['next', '--triage', 'kind=require level=L1 module=wiki topic=wiki']);
  const id = latestId(f);
  fs.rmSync(path.join(runsDir(f), `${id}.json`));
  const p = prun(f, ['status', '--run', id, '--adopt']); // --adopt 须置于参数尾（parseArgs 盲取下一参为值）
  assert.equal(p.status, 0, out(p));
  assert.match(out(p), /已重建/);
  assert.equal(runFile(f, id).stage, 'adopted');
});

// ---- 执行驱动（2026-10-10 shard-check-loop-test 二期：shard / parent / 顺序 三态）----
// 26 组测试各自 buildFixture() 独立夹具（模块级零共享态，假 git 经 env 注入互不干扰）→
// idx % K round-robin 可并行。K = clamp(1..6, floor(cpus/2))（12 核本机 6，小核 CI=1 顺序等价）；
// CHECK_LOOP_TEST_SHARDS 钉死。--shard=i/K 子进程态只跑本片后落文件末既有汇总；parent 聚合
// 各子进程 ✅/❌ 计数（❌ 走 stderr），任一红 exit 1 并在文件末汇总前显式退出。
const SHARD_ARG = process.argv.find((a) => a.startsWith('--shard='));
if (SHARD_ARG) {
  const m = SHARD_ARG.match(/^--shard=(\d+)\/(\d+)$/);
  const si = m && Number(m[1]), sk = m && Number(m[2]);
  if (!m || !Number.isInteger(si) || !Number.isInteger(sk) || sk < 1 || si >= sk) {
    console.error(`pipeline-run.test: --shard 形态须为 i/K 且 i<K（现 ${SHARD_ARG}）`);
    process.exit(1);
  }
  for (const [idx, t] of TESTS.entries()) if (idx % sk === si) runOne(t);
} else {
  const K = (() => {
    const env = Number(process.env.CHECK_LOOP_TEST_SHARDS);
    if (Number.isInteger(env) && env >= 1) return Math.min(env, TESTS.length);
    return Math.min(6, Math.max(1, Math.floor(os.cpus().length / 2)));
  })();
  if (K <= 1) {
    for (const t of TESTS) runOne(t); // 顺序等价（小核 CI / 环境钉死 1）
  } else {
    const kids = [];
    for (let i = 0; i < K; i++) {
      kids.push(new Promise((resolve) => {
        const c = spawn(process.execPath, [fileURLToPath(import.meta.url), `--shard=${i}/${K}`]);
        let out = '', err = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        c.on('close', (code) => resolve({ i, out, err, code }));
        c.on('error', (e) => resolve({ i, out, err, code: null, e }));
      }));
    }
    let okCnt = 0, badCnt = 0, red = 0;
    for (const r of await Promise.all(kids)) {
      const okN = (String(r.out).match(/✅ /g) || []).length;
      const badN = (String(r.err || '').match(/❌ /g) || []).length;
      okCnt += okN; badCnt += badN;
      if (r.code !== 0 || badN > 0) red++;
      process.stdout.write(`\n[pipeline-run.test ▶ shard ${r.i + 1}/${K}]\n${r.out}`);
      if (r.code !== 0 || badN > 0) process.stderr.write(String(r.err));
      if (r.code == null && r.e) console.error(`[pipeline-run.test] RED shard ${r.i + 1}（spawn ${r.e.code || r.e.message}）`);
    }
    console.log(`\n合计: PASS ${okCnt} / FAIL ${badCnt}${red ? `——红分片 ${red} 见上` : ''}（${K} 分片）`);
    process.exit(red ? 1 : 0); // parent 未跑测试：在此退出，跳过文件末模块级汇总
  }
}

console.log(`\n合计: PASS ${PASS} / FAIL ${FAIL}`);
process.exit(process.exitCode || 0);
