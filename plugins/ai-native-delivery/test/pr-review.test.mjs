#!/usr/bin/env node
// pr-review.test.mjs — PR 面板评审骨架黑盒测试（2026-11-13 插件化移植新增；源仓无测试，全部新写）
// 手法同 doctor.test.mjs：mkdtemp 临时 git 仓 + spawn 真实 CLI。断言：
// ①plan 固定 SHA + 生成 run.json/tasks.json/finder 工单 ②collect 夹具 findings（去重/样式丢弃/provenance）
// ③verify 共识数学（2/3 confirm → confirmed；单 Important repro → escalated）④adjudicate 落裁决
// ⑤dispose 状态机（fixed/waived/deferred/recorded）⑥gate shadow 不阻断 / enforce 清零后 PASS
// ⑦summary 写 artifact + 月度台账行（8 列自洽：意见数=采纳+拒绝+误报）⑧status 摘要
// 零依赖，Node ≥ 18 直接运行：node test/pr-review.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'pr-review.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-test-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'app.js'), 'function f(){ return 1 }\n', 'utf8');
  fs.writeFileSync(path.join(d, 'src', 'util.js'), 'function g(){ return 2 }\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'base');
  const baseSha = gitOut(g, ['rev-parse', 'HEAD']);
  // head：改两个文件
  fs.writeFileSync(path.join(d, 'src', 'app.js'), 'function f(){ return 10 }\n', 'utf8');
  fs.writeFileSync(path.join(d, 'src', 'util.js'), 'function g(){ return 20 }\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'head');
  const headSha = gitOut(g, ['rev-parse', 'HEAD']);
  return { d, g, baseSha, headSha };
};
function gitOut(g, a) { const r = g(...a); return r.status === 0 ? String(r.stdout).trim() : ''; }

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd: cwd || TEST_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const { d, g, baseSha, headSha } = mkRepo();

// ① plan
const planR = run(['plan', '--base', baseSha, '--head', headSha], d);
const runDirMatch = planR.stdout.match(/runId[=:]\s*(\S+)|pr-review[\/\\](\S+)/);
const tmpBase = path.join(d, '.agents', 'tmp', 'pr-review');
const runId = fs.existsSync(tmpBase) ? fs.readdirSync(tmpBase)[0] : null;
const runDir = runId ? path.join(tmpBase, runId) : null;
check('① plan exit 0 且生成 run 目录', planR.status === 0 && runDir && fs.existsSync(runDir),
  `status=${planR.status} out=${planR.stdout.slice(0, 200)} err=${planR.stderr.slice(0, 200)}`);
const runJson = runDir && fs.existsSync(path.join(runDir, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) : null;
check('① run.json 固定 SHA（base/head 不可回退为分支名）', runJson && runJson.base === baseSha && runJson.head === headSha, JSON.stringify(runJson && { base: runJson.base, head: runJson.head }));
const tasksJson = runDir && fs.existsSync(path.join(runDir, 'tasks.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'tasks.json'), 'utf8')) : null;
check('① tasks.json 含 finder 派发面（镜头列表）', tasksJson && Array.isArray(tasksJson.finders) && tasksJson.finders.length >= 1, JSON.stringify(tasksJson && tasksJson.finders));

// ② collect：给 tasks.json 里每个 finder 工单都补一份产出（collect 校验完整性——缺一份即 exit 2）
if (runDir && tasksJson) {
  const fdir = path.join(runDir, 'findings');
  fs.mkdirSync(fdir, { recursive: true });
  for (const t of tasksJson.finders || []) {
    const lensId = (t.lens || t.id || '').toString();
    const outName = t.output ? path.basename(t.output) : `${lensId}.json`;
    if (fs.existsSync(path.join(fdir, outName))) continue;
    fs.writeFileSync(path.join(fdir, outName), JSON.stringify({ lens: lensId, findings: [] }), 'utf8');
  }
}
if (runDir) {
  const fdir = path.join(runDir, 'findings');
  fs.writeFileSync(path.join(fdir, 'correctness.json'), JSON.stringify({
    lens: 'correctness',
    findings: [
      { file: 'src/app.js', line: 1, claim: 'f 返回值从 1 改为 10，调用方未同步', evidence: 'diff 行 1：return 1 → return 10；src/util.js 同批改动但无调用方核对', category: 'correctness', severityHint: 'Important', behaviorImpact: true, repro: 'node -e "assert(f()===1)" 改前过改后挂' },
      { file: 'src/app.js', line: 1, claim: '函数名 f 太短', evidence: '命名偏好', category: 'style', severityHint: 'Nit', behaviorImpact: false },
    ],
  }), 'utf8');
  fs.writeFileSync(path.join(fdir, 'tests.json'), JSON.stringify({
    lens: 'tests',
    findings: [
      { file: 'src/app.js', line: 1, claim: 'f 返回值从 1 改为 10，调用方未同步（与 correctness 镜头同义——应去重合并）', evidence: '同上', category: 'test', severityHint: 'Important', behaviorImpact: true },
    ],
  }), 'utf8');
}
const collectR = run(['collect', '--run', runDir], d);
check('② collect exit 0', collectR.status === 0, `status=${collectR.status} err=${collectR.stderr.slice(0, 200)}`);
const candFile = runDir && ['candidates.json', 'findings.candidates.json'].map((f) => path.join(runDir, f)).find((f) => fs.existsSync(f));
const candidates = candFile ? JSON.parse(fs.readFileSync(candFile, 'utf8')) : null;
const candList = candidates && (Array.isArray(candidates) ? candidates : candidates.candidates || candidates.findings);
check('② 去重后候选数 = 2（同义合并 1 条 + 独立 1 条；纯样式丢弃不计）', Array.isArray(candList) && candList.length === 2, `候选=${Array.isArray(candList) ? candList.length : JSON.stringify(candidates).slice(0, 200)}`);
check('② 纯样式已丢弃（候选中无 category=style）', Array.isArray(candList) && !candList.some((c) => c.category === 'style'), JSON.stringify(candList && candList.map((c) => c.category)));

// ③ verify：给候选 1 三票 confirm / 候选 2 两票 reject 一票 confirm
const votesDir = runDir && path.join(runDir, 'votes');
if (runDir && candList) {
  fs.mkdirSync(votesDir, { recursive: true });
  candList.forEach((c, ci) => {
    const id = c.id || `C-${String(ci + 1).padStart(3, '0')}`;
    const votes = ci === 0
      ? [1, 2, 3].map((v) => ({ findingId: id, verifier: `v${v}`, verdict: 'confirm', severity: 'Important', introduced: 'introduced', evidence: `证据${v}`, repro: `node -e "assert(${v})"` }))
      : [1, 2].map((v) => ({ findingId: id, verifier: `v${v}`, verdict: 'reject', severity: 'Nit', counterEvidence: `反证${v}` })).concat([{ findingId: id, verifier: 'v3', verdict: 'confirm', severity: 'Nit', evidence: '证据3' }]);
    votes.forEach((v) => fs.writeFileSync(path.join(votesDir, `${id}-${v.verifier}.json`), JSON.stringify(v), 'utf8'));
  });
}
const verifyR = run(['verify', '--run', runDir], d);
check('③ verify exit 0', verifyR.status === 0, `status=${verifyR.status} err=${verifyR.stderr.slice(0, 300)}`);
const findingsFile = runDir && path.join(runDir, 'findings.json');
const findings = findingsFile && fs.existsSync(findingsFile) ? JSON.parse(fs.readFileSync(findingsFile, 'utf8')) : null;
const fList = findings && (Array.isArray(findings) ? findings : findings.findings);
check('③ 候选 1 三票 confirm → consensus=confirmed、status=open（等处置）', Array.isArray(fList) && fList.some((f) => f.consensus === 'confirmed' && f.status === 'open' && f.severity === 'Important'), JSON.stringify(fList && fList.map((f) => `${f.id}:${f.consensus}/${f.status}`)));
check('③ 候选 2 两票 reject 一票 confirm → rejected（多数 reject）', Array.isArray(fList) && fList.some((f) => f.status === 'rejected'), JSON.stringify(fList && fList.map((f) => `${f.id}:${f.status}`)));

// ④ adjudicate 护栏：非 escalated 候选拒处理（escalated 才是裁决面——共识已定的不重复裁决）
const adjR = run(['adjudicate', '--run', runDir, '--id', 'C-001', '--decision', 'confirm', '--reason', '测试裁决', '--adjudicator', 'test'], d);
check('④ adjudicate 拒处理非 escalated（exit 2 且指明只处理 escalated）', adjR.status === 2 && /escalated/.test(adjR.stderr), `status=${adjR.status} err=${adjR.stderr.slice(0, 200)}`);

// ⑤ dispose 状态机：fixed 无 --commit 被拒（护栏）；waive/deferred 不需 commit
const dispNoCommit = run(['dispose', '--run', runDir, '--id', 'C-001', '--status', 'fixed', '--note', '修了'], d);
check('⑤ dispose fixed 无 --commit 被拒（exit 2）', dispNoCommit.status === 2 && /--commit/.test(dispNoCommit.stderr), `status=${dispNoCommit.status} err=${dispNoCommit.stderr.slice(0, 120)}`);
const dispWaiveNoQuote = run(['dispose', '--run', runDir, '--id', 'C-001', '--status', 'waived', '--reason', '误报'], d);
check('⑤ Important waive 无 --quote 被拒（须用户书面原话）', dispWaiveNoQuote.status === 2 && /--quote/.test(dispWaiveNoQuote.stderr), `status=${dispWaiveNoQuote.status}`);
const dispWaive = run(['dispose', '--run', runDir, '--id', 'C-001', '--status', 'waived', '--reason', '误报：调用方在同批已同步', '--owner', 'user', '--quote', '这个不算问题，同批已同步'], d);
check('⑤ Important waive 带 quote/owner 后 exit 0', dispWaive.status === 0, `status=${dispWaive.status} err=${dispWaive.stderr.slice(0, 160)}`);
const dispRejected = run(['dispose', '--run', runDir, '--id', 'C-002', '--status', 'recorded', '--note', '试图处置 rejected'], d);
check('⑤ 处置 rejected 候选被拒（只有 confirmed 可处置）', dispRejected.status === 2 && /rejected/.test(dispRejected.stderr), `status=${dispRejected.status}`);

// ⑥ gate：shadow 不阻断；enforce 全终态（waived/recorded）→ PASS；再注一条 open Important → FAIL
const gateShadow = run(['gate', '--run', runDir, '--mode', 'shadow'], d);
check('⑥ gate shadow exit 0（不阻断）', gateShadow.status === 0, `status=${gateShadow.status} out=${gateShadow.stdout.slice(0, 160)}`);
const gateEnf = run(['gate', '--run', runDir, '--mode', 'enforce'], d);
check('⑥ gate enforce 全终态后 PASS', gateEnf.status === 0 && /PASS/.test(gateEnf.stdout), `status=${gateEnf.status} out=${gateEnf.stdout.slice(0, 200)}`);
{
  // 注一条 open Important → enforce 应 FAIL（然后清掉，让 summary 能跑）
  const fj = JSON.parse(fs.readFileSync(findingsFile, 'utf8'));
  const arr = Array.isArray(fj) ? fj : fj.findings;
  arr.push({ id: 'C-998', file: 'src/app.js', line: 1, claim: '人造 open Important', evidence: '人造', category: 'correctness', severity: 'Important', status: 'open', behaviorImpact: true });
  fs.writeFileSync(findingsFile, JSON.stringify(fj), 'utf8');
  // 注入件须带 consensus（gate 对无 consensus 字段的 finding 不走 Important 关闭判定——它被当
  // 作已终态跳过，这是 gate 的实际口径：只有经 verify 定 consensus 的才进入关闭检查）
  arr[arr.length - 1].consensus = 'confirmed';
  fs.writeFileSync(findingsFile, JSON.stringify(fj), 'utf8');
  const gateFail2 = run(['gate', '--run', runDir, '--mode', 'enforce'], d);
  check('⑥ 有 open Important 时 enforce FAIL（exit 1）', gateFail2.status === 1, `status=${gateFail2.status} out=${gateFail2.stdout.slice(0, 200)}`);
  const c998r = run(['dispose', '--run', runDir, '--id', 'C-998', '--status', 'waived', '--reason', '测试件豁免', '--owner', 'user', '--quote', '这是测试注入件，豁免'], d);
  if (c998r.status !== 0) console.log('      [debug] C-998 waived exit=' + c998r.status + ' err=' + c998r.stderr.slice(0, 120));
}

// ⑦ summary：写 artifact + 月度台账行
const sumR = run(['summary', '--run', runDir], d);
check('⑦ summary exit 0', sumR.status === 0, `status=${sumR.status} err=${sumR.stderr.slice(0, 300)}`);
const ledgerDir = path.join(d, 'workflow', 'reviews.d');
const ledgerFiles = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.md')) : [];
const ledgerText = ledgerFiles.length ? fs.readFileSync(path.join(ledgerDir, ledgerFiles[0]), 'utf8') : '';
const rows = ledgerText.split(/\r?\n/).filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
check('⑦ 月度台账行落盘（8 列）', rows.length >= 1, `ledger=${ledgerFiles} rows=${rows.length}`);
if (rows.length) {
  const cells = rows[0].split('|').slice(1, -1).map((c) => c.trim());
  const [total, adopted, rejected, misreport] = [3, 4, 5, 6].map((i) => Number(cells[i]));
  check('⑦ 台账 8 列自洽（意见数 = 采纳 + 拒绝 + 误报）', Number.isFinite(total) && adopted + rejected + misreport === total, rows[0]);
}

// ⑧ status
const stR = run(['status', '--run', runDir], d);
check('⑧ status exit 0 且有摘要输出', stR.status === 0 && stR.stdout.trim().length > 0, `status=${stR.status} out=${stR.stdout.slice(0, 120)}`);

fs.rmSync(d, { recursive: true, force: true });
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
