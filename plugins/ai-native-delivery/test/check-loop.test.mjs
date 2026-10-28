#!/usr/bin/env node
// check-loop.test.mjs — 闭环门禁 fixture 套件（2026-09-26 check-loop-node：自 check-loop.test.sh 全量移植）
// 方法：现场构造临时 workflow 根（含枚举单源内联件），spawn node check-loop.mjs（CHECK_LOOP_ROOT 注入，
//       git 模式场景改 cwd 注入），断言 exit code 与输出关键词——场景集与关键词断言沿 sh 版逐条移植。
// git 场景用 git init 现场建仓；rule-budget --staged 两场景直调 node（2026-10-08 rule-budget.mjs
//       移植 node——恒可跑，原 sh 环境探测与 SKIP 分支已删）。
// 用法：node test/check-loop.test.mjs [--shard=i/K]（默认自适应自分片跑全量；
//       CHECK_LOOP_TEST_SHARDS=<N> 钉死并发度，=1 即顺序等价——2026-10-10 shard-check-loop-test）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 插件化落位（2026-10-27 迁移）：测试在 test/，引擎脚本在 ../scripts/（被测件与夹具脚本副本同一来源）
import { computeFingerprint } from '../scripts/confirm-doc.mjs';
import { POLICIES, loadKitPolicy } from '../scripts/policy.mjs';
import { entryConfirmed, MARK_RE, laneOfDoc, commitmentFingerprint } from '../scripts/stage-gates.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.join(TEST_DIR, '..', 'scripts'); // 引擎脚本目录（夹具脚本副本从这里拷出）
const CONFIG_DIR = path.join(TEST_DIR, '..', 'config-templates'); // 治理配置模板（夹具词表/预算表拷自这里）
const CHECK_LOOP = path.join(SCRIPT_DIR, 'check-loop.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'; // Windows spawn 不补 .exe 扩展名（gitInit/gitCommitAll/场景 43/44/47 共用）
// 注意：check-loop.mjs 无 isMain 主守卫，被 import 即全量执行门禁并 process.exit——本套件只能端到端 spawn，
// 不可从其 import 函数直测（2026-10-04 review-fix-batch 实证；可 import 化记 papercuts 待 L2 重构）

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

// mkfix：空 fixture 根（四目录 + 枚举单源内联 10 键——fixture 自包含，测消费逻辑而非当前词表值）
const ENUMS_FIXTURE = [
  'doc.status.all=draft approved done superseded cancelled',
  'doc.status.confirmed=approved done superseded cancelled',
  'doc.status.active=draft approved',
  'doc.status.terminal=done superseded cancelled',
  'doc.status.abandoned=superseded cancelled',
 'incident.status.all=open fixed closed',
 'incident.status.active=open',
 'incident.source.all=self user test monitor',
 'incident.env.all=dev staging prod none',
 'level.all=L1 L2 L3',
].join('\n') + '\n';

let FIXTURE_TEMPLATE = null;
const mkfix = () => {
  // 模板仓复制（2026-10-23 全量套件优化）：git init + base commit 只做一次，场景用 fs.cpSync 复制
  // （实测 20 次：init+commit 4240ms vs 模板复制 597ms）。场景自己的 gitCommitAll 仍照跑。
  if (!FIXTURE_TEMPLATE) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'check-loop-tpl-'));
    for (const s of ['intents', 'specs', 'plans', 'incidents']) {
      fs.mkdirSync(path.join(t, 'workflow', s), { recursive: true });
    }
    fs.mkdirSync(path.join(t, '.agents', 'config'), { recursive: true });
    fs.writeFileSync(path.join(t, '.agents', 'config', 'workflow-enums.txt'), ENUMS_FIXTURE);
    gitRetry(['init', '-q'], t);
    gitRetry(['add', '-A'], t);
    gitRetry(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'template'], t);
    FIXTURE_TEMPLATE = t;
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-loop-test-'));
  fs.cpSync(FIXTURE_TEMPLATE, d, { recursive: true });
  return d;
};
const w = (root, rel, content) => fs.writeFileSync(path.join(root, rel), content);

// 引擎脚本副本落夹具（插件化 2026-10-27）：被测脚本 import 同目录引擎模块（rule-budget.mjs → paths.mjs
// → git-core.mjs），只拷单个脚本会 ERR_MODULE_NOT_FOUND → 门内执行失败 → 断言误判为超限。
// 依赖链须一并复制（同 agg-delegations 夹具惯例）。
const copyEngineScripts = (root, ...names) => {
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  for (const n of names) {
    fs.copyFileSync(path.join(SCRIPT_DIR, n), path.join(root, '.agents', 'scripts', n));
  }
};

const INTENT = (name, fm, body = '') => `---\n${fm}\n---\n# INTENT — ${name}\n${body}`;
const PLAN = (name, fm, body = '') => `---\n${fm}\n---\n# PLAN — ${name}\n${body}`;
const SPEC = (name, fm, body = '') => `---\n${fm}\n---\n# SPEC — ${name}\n${body}`;
const 三件套 = (refs) => `## 复盘三件套（缺一不可）

1. 结构性修复
 - 修复 commit:abc1234
 - 影响环境:dev
 - 是否需要新 intent:
${refs ? '     - 是 → ../intents/2026-09-12-ghost.md\n' : ' - 否 → 理由:实现 bug 单点修复\n'}
2. 防复发验证
 - 回归清单条目在案

3. 规范条目
 - AGENTS.md 某节
`;

// run：默认 CHECK_LOOP_ROOT 注入（fixture 模式）；{git:true} 时 cwd 注入（真 git 模式，测 tracked 过滤）；
// opts.args 替换默认 `--all`（套件覆盖卫生段）。硬门默认入口用 { args: [] }。未知参数仍走用法退出。
// opts.env 增量覆盖子进程 env（CHECK_LOOP_GIT 替身注入用，2026-10-05-gitout-fail-open）
// 夹具跑法：告警保持**逐条**形态。插件形态下引擎脚本在插件内（scriptPath 回退），折叠开关随之生效
// （2026-10-28 修复：判据写死 ROOT/.agents/scripts 时插件形态恒 false → 折叠对插件用户永不触发）。
// 折叠会把同类告警并成「×N 条同类」单行、细节移进 tmp/check-loop-warn.log——本套件的断言按告警原文匹配，
// 故显式用引擎自带的逐条出口 CHECK_LOOP_VERBOSE=1（同一开关也供排障用）。折叠规则本身由
// warn-format.test.mjs（S1-S7）单测锁住，端到端折叠形态另由 test/warn-fold-plugin.test.mjs 锁住。
const FIXTURE_ENV = { CHECK_LOOP_VERBOSE: '1' };
const run = (root, opts = {}) => spawnSync(process.execPath, [CHECK_LOOP, ...(opts.args ?? ['--all'])], {
  ...(opts.git
    ? { cwd: root, env: { ...process.env, ...FIXTURE_ENV, ...(opts.env || {}) } }
    : { cwd: ROOT_CWD, env: { ...process.env, ...FIXTURE_ENV, ...(opts.env || {}), CHECK_LOOP_ROOT: root } }),
  encoding: 'utf8',
});
const ROOT_CWD = process.cwd();
const outOf = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const expectHard = (desc, root, kw) => {
  const r = run(root);
  check(desc, r.status === 1 && outOf(r).includes(kw), `exit=${r.status}\n${outOf(r)}`);
};
// 第 1 批降档（2026-10-21）：原 hard 检查降 WARN——exit 0 但告警在场（照跑照报不阻断）
const expectWarnKw = (desc, root, kw) => {
  const r = run(root);
  check(desc, r.status === 0 && outOf(r).includes(kw), `exit=${r.status}\n${outOf(r)}`);
};
const expectOk = (desc, root) => {
  const r = run(root);
  check(desc, r.status === 0, `exit=${r.status}\n${outOf(r)}`);
};
// 反向断言：运行且**不**出现某关键词（用于「旧实现误报、新实现应消失」的回归）
const expectNoKw = (desc, root, kw) => {
  const r = run(root);
  check(desc, !outOf(r).includes(kw), `exit=${r.status}\n${outOf(r)}`);
};
// 夹具 git 调用防瞬时失败（2026-10-05-gitout-fail-open 夹具侧加固）：宿主/CI 资源压力下 spawnSync 可能
// 瞬时 `r.error`，git 侧也可能瞬时 status≠0（如 index.lock 争用）——对夹具 setup 调用（init/add/commit/
// rev-parse）两者都永不合法：重试一次，持续失败抛错响亮失败。绝不静默产出空 sha / 缺提交的假夹具
// （那会让证据场景拿到「无裁决」的错误结果——CI run 37252874044 flake 的实际根因侧，诊断详见同名 incident）
function gitRetry(args, root) {
  const opts = { cwd: root, encoding: 'utf8' };
  let r = spawnSync(GIT, args, opts);
  if (r.error || r.status !== 0) {
    r = spawnSync(GIT, args, opts);
    if (r.error || r.status !== 0) {
      throw new Error(`fixture git 瞬时失败（重试后仍 ${r.error ? (r.error.code || r.error.message) : `exit ${r.status}`}）: git ${args.join(' ')}\n${(r.stderr || '').slice(0, 300)}`);
    }
  }
  return r;
}
const shortSha = (root, args = ['rev-parse', '--short', 'HEAD']) => {
  const out = gitRetry(args, root).stdout.trim();
  if (!out) throw new Error(`fixture git 空输出（假夹具防线）: git ${args.join(' ')}`);
  return out;
};
const gitInit = (root) => {
  // 模板仓已带 .git（mkfix 复制）——不再 init；非模板夹具仍 init。
  if (!fs.existsSync(path.join(root, '.git'))) gitRetry(['init', '-q'], root);
};
const gitCommitAll = (root, msg) => {
  gitRetry(['add', '-A'], root);
  gitRetry(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], root);
};
const rmfix = (root) => fs.rmSync(root, { recursive: true, force: true });
// writeLedger：fixture 台账辅助（检查 15 配对用；行 schema 同 confirm-doc.mjs appendLedger）
const writeLedger = (root, entries) => {
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
};
// mkConfirmedDoc：落一份「带真实指纹 + 台账配对」的文档（复刻 confirm-doc 落态形态）
const mkConfirmedDoc = (root, rel, fmBody) => {
  const noFp = `---\n${fmBody}\n---\n# DOC\n`;
  const fp = computeFingerprint(noFp);
  fs.writeFileSync(path.join(root, rel), `---\n${fmBody}\n确认指纹: ${fp.slice(0, 16)}\n---\n# DOC\n`);
  return { rel: rel.replace(/\\/g, '/'), fp };
};

// ---- 场景 1:全合法闭环（intent+plan,L1,done 全勾验带证据）→ exit 0 ----
// 场景注册表（2026-10-10 shard-check-loop-test 步骤一）：135 个顶层场景块包装为注册回调，
// 顺序驱动执行——语义与包装前逐块顺序执行逐点等价（包装仅为给分片器提供可枚举单元）；
// async 回调因场景内有 await import（原 :1954 系）——同步回调会 SyntaxError。
const SCENARIOS = [];
const SCEN = (fn) => { SCENARIOS.push(fn); };

SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-ok.md', INTENT('ok', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:dotnet test 全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-ok.md', PLAN('ok', '状态: done\n级别: L1'));
  expectOk('全合法闭环(L1 done 勾验带证据) → exit 0', T);
  rmfix(T);
});

// ---- 场景 2:intent 缺 plan → hard ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-a.md', INTENT('a', '状态: approved\n级别: L1\n日期: 2026-09-12'));
  expectWarnKw('intent 缺 plan → WARN 配对断裂（第 1 批降档）', T, '[WARN 配对断裂]');
  rmfix(T);
});

// ---- 场景 3:L2 intent 缺 spec → hard ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-b.md', INTENT('b', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-b.md', PLAN('b', '状态: approved\n级别: L2'));
  expectWarnKw('L2 intent 缺 spec → WARN 配对断裂（第 1 批降档）', T, 'intent 缺 spec');
  rmfix(T);
});

// ---- 场景 3b:链内状态倒挂 → WARN 不阻断（2026-10-11 C1；intent 双向 + incident closed 孤儿向）----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-inv1.md', INTENT('inv1', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/specs/2026-09-12-inv1.md', SPEC('inv1', '状态: approved\n级别: L2'));
  w(T, 'workflow/plans/2026-09-12-inv1.md', PLAN('inv1', '状态: done\n级别: L2'));
  const r = run(T);
  check('链内倒挂:plan done 而 intent approved → WARN 且 exit 0', r.status === 0 && outOf(r).includes('链内倒挂'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-inv2.md', INTENT('inv2', '状态: done\n级别: L2\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/specs/2026-09-12-inv2.md', SPEC('inv2', '状态: approved\n级别: L2'));
  w(T, 'workflow/plans/2026-09-12-inv2.md', PLAN('inv2', '状态: approved\n级别: L2'));
  const r = run(T);
  check('链内倒挂:intent done 而 plan approved → WARN 且 exit 0', r.status === 0 && outOf(r).includes('链内倒挂'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-09-12-inv3.md', `---\n状态: closed\n级别: L1\n发现: 2026-09-12\n---\n# INCIDENT — inv3\n\n${三件套(false)}`);
  w(T, 'workflow/plans/2026-09-12-inv3.md', PLAN('inv3', '状态: approved\n级别: L1'));
  const r = run(T);
  check('链内倒挂:incident closed 而 plan approved → WARN 且 exit 0', r.status === 0 && outOf(r).includes('链内倒挂'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-09-12-inv4.md', `---\n状态: fixed\n级别: L1\n发现: 2026-09-12\n---\n# INCIDENT — inv4\n\n${三件套(false)}`);
  w(T, 'workflow/plans/2026-09-12-inv4.md', PLAN('inv4', '状态: done\n级别: L1'));
  const r = run(T);
  check('链内倒挂:incident fixed + plan done（存量固定形态）→ 不入检零告警', r.status === 0 && !outOf(r).includes('链内倒挂'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 3c:独立复核上下文标识（2026-10-11 C2，policy v12 reviewerSince advisory；draft 链避开检查 15 配对面）----
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', JSON.stringify({ policyVersion: 12 }) + '\n');
  w(T, 'workflow/intents/2026-10-12-rv1.md', INTENT('rv1', '状态: draft\n级别: L2\n日期: 2026-10-12'));
  w(T, 'workflow/specs/2026-10-12-rv1.md', SPEC('rv1', '状态: draft\n级别: L2\n日期: 2026-10-12', '\n## 确认与复核\n- 独立复核：新会话复核通过（0 P0/P1）\n'));
  w(T, 'workflow/plans/2026-10-12-rv1.md', PLAN('rv1', '状态: draft\n级别: L2'));
  const r = run(T);
  check('复核上下文：锚后（≥reviewerSince）复核行缺标识 → WARN 且 exit 0', r.status === 0 && outOf(r).includes('复核上下文缺失'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', JSON.stringify({ policyVersion: 12 }) + '\n');
  w(T, 'workflow/intents/2026-10-12-rv2.md', INTENT('rv2', '状态: draft\n级别: L2\n日期: 2026-10-12'));
  w(T, 'workflow/specs/2026-10-12-rv2.md', SPEC('rv2', '状态: draft\n级别: L2\n日期: 2026-10-12', '\n## 确认与复核\n- 独立复核：新会话复核通过（复核上下文：agent_9f8e7d6c；0 P0/P1）\n'));
  w(T, 'workflow/plans/2026-10-12-rv2.md', PLAN('rv2', '状态: draft\n级别: L2'));
  const r = run(T);
  check('复核上下文：复核行含「复核上下文：<id>」→ 无告警', r.status === 0 && !outOf(r).includes('复核上下文缺失'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', JSON.stringify({ policyVersion: 12 }) + '\n');
  w(T, 'workflow/intents/2026-10-11-rv3.md', INTENT('rv3', '状态: draft\n级别: L2\n日期: 2026-10-11'));
  w(T, 'workflow/specs/2026-10-11-rv3.md', SPEC('rv3', '状态: draft\n级别: L2\n日期: 2026-10-11', '\n## 确认与复核\n- 独立复核：新会话复核通过（0 P0/P1）\n'));
  w(T, 'workflow/plans/2026-10-11-rv3.md', PLAN('rv3', '状态: draft\n级别: L2'));
  const r = run(T);
  check('复核上下文：锚前存量（<reviewerSince）豁免 → 无告警', r.status === 0 && !outOf(r).includes('复核上下文缺失'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-10-12-rv4.md', INTENT('rv4', '状态: draft\n级别: L2\n日期: 2026-10-12'));
  w(T, 'workflow/specs/2026-10-12-rv4.md', SPEC('rv4', '状态: draft\n级别: L2\n日期: 2026-10-12', '\n## 确认与复核\n- 独立复核：新会话复核通过（0 P0/P1）\n'));
  w(T, 'workflow/plans/2026-10-12-rv4.md', PLAN('rv4', '状态: draft\n级别: L2'));
  const r = run(T);
  check('复核上下文：fixture 无 engine.json（回落 v1 缺键）→ 检查整体跳过', r.status === 0 && !outOf(r).includes('复核上下文缺失'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 4:L3 spec 缺确认三件 → hard ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-c.md', INTENT('c', '状态: approved\n级别: L3\n日期: 2026-09-12'));
  w(T, 'workflow/specs/2026-09-12-c.md', SPEC('c', '状态: approved\n级别: L3', '\n## 确认与复核\n'));
  w(T, 'workflow/plans/2026-09-12-c.md', PLAN('c', '状态: approved\n级别: L3'));
  expectWarnKw('L3 spec 缺确认三件 → WARN（第 1 批降档）', T, 'WARN L3 确认缺失');
  rmfix(T);
});

// ---- 场景 5:L3 spec 确认三件齐全 → exit 0 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-d.md', INTENT('d', '状态: approved\n级别: L3\n日期: 2026-09-12'));
  w(T, 'workflow/specs/2026-09-12-d.md', SPEC('d', '状态: approved\n级别: L3\n确认结果: approved\n确认时间: 2026-09-12', '\n## 确认与复核\n- 独立复核：已由 independent-reviewer 新会话完成,结论 approved\n'));
  w(T, 'workflow/plans/2026-09-12-d.md', PLAN('d', '状态: approved\n级别: L3'));
  expectOk('L3 确认三件齐全(frontmatter 2 件+正文独立复核) → exit 0', T);
  rmfix(T);
});

// ---- 场景 6:新建 done intent 验收未勾验 → hard;带附注不影响判定（papercut #4 回归）----
// 换锚（2026-09-28 check8-git-anchor）后「新建」由 **git 首次加入日期**判定（文件名字段不再作锚），
// 故本场景须为真 git 仓——否则不可判定、走存量口径而不再 hard。**意图与断言强度均不变**。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-13-e.md', INTENT('e', '状态: done\n级别: L1\n日期: 2026-09-13\n备注: 回溯补档,原工作 2026-09-12 完成', '\n## 验收标准（可测试）\n- [ ] 用例通过\n'));
  w(T, 'workflow/plans/2026-09-13-e.md', PLAN('e', '状态: done\n级别: L1'));
  gitCommitAll(T, 'add');
  expectHard('新建 done 未勾验(附注在备注键) → hard 验收未对账', T, '验收未对账');
  rmfix(T);
});

// ---- 场景 7:存量(<2026-09-12) done 未勾验 → warning,exit 0 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-01-f.md', INTENT('f', '状态: done\n级别: L1\n日期: 2026-09-01', '\n## 验收标准（可测试）\n- [ ] 用例通过\n'));
  w(T, 'workflow/plans/2026-09-01-f.md', PLAN('f', '状态: done\n级别: L1'));
  expectOk('存量 done 未勾验 → warning 不阻断', T);
  rmfix(T);
});

// ---- 场景 8:incident 选「是」但 intent 不存在 → hard 回路断档 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-09-12-g.md', `---\n状态: fixed\n级别: L2\n发现: 2026-09-12\n---\n# INCIDENT — g\n\n${三件套(true)}`);
  w(T, 'workflow/plans/2026-09-12-g.md', PLAN('g', '状态: done\n级别: L2'));
  w(T, 'workflow/specs/2026-09-12-g.md', SPEC('g', '状态: approved\n级别: L2'));
  expectWarnKw('incident 回路引用不存在 intent → WARN 回路断档（第 1 批降档）', T, '[WARN 回路断档]');
  rmfix(T);
});

// ---- 场景 9:incident 流程 legacy → 豁免级别/配对检查,exit 0 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-08-27-h.md', `---\n状态: closed\n流程: legacy\n发现: 2026-08-27\n---\n# INCIDENT — h（legacy 回填,无级别无配对）\n\n${三件套(false)}`);
  expectOk('incident legacy 豁免配对 → exit 0', T);
  rmfix(T);
});

// ---- 场景 10:无 frontmatter → 状态键缺失 warning,exit 0（非 L3） ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-i.md', '# INTENT — i（未迁移旧格式）\n\n状态：draft\n');
  w(T, 'workflow/plans/2026-09-12-i.md', PLAN('i', '状态: approved\n级别: L1'));
  const r = run(T);
  check('无 frontmatter → warning 提示状态键缺失', r.status === 0 && /WARN 状态未确认.*i\.md/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 11:frontmatter 状态值域外（自造值）→ warning 带当前值,exit 0 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-j.md', INTENT('j', '状态: 进行中\n级别: L1\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-j.md', PLAN('j', '状态: approved\n级别: L1'));
  const r = run(T);
  check('状态值域外 → warning 且带当前值提示', r.status === 0 && /WARN 状态未确认.*j\.md.*进行中/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 12:无 frontmatter 的旧格式 L3 声明 → warning 引导补 frontmatter（不回退读正文,双源防回归）----
SCEN(async () => {
  const T = mkfix();
  for (const s of ['intents', 'plans', 'specs']) {
    w(T, `workflow/${s}/2026-09-12-k.md`, `# ${s.toUpperCase().slice(0, -1)} — k\n\n级别：L3\n状态：approved\n`);
  }
  const r = run(T);
  check('无 frontmatter 旧格式 → warning 引导补 frontmatter(不回退读正文)',
    r.status === 0 && /WARN 状态未确认.*k\.md（frontmatter 状态键当前值:『缺失』）/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 13:git fixture——L1 intent 与迁移 SQL 同 commit → warning 疑似判低（检查 10）----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-12-m.md', INTENT('m', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 场景构造项（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-m.md', PLAN('m', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, 'docs', 'scripts'), { recursive: true });
  w(T, 'docs/scripts/01-add-table.sql', 'CREATE TABLE t(id INT);\n');
  gitCommitAll(T, 'test');
  const r = run(T);
  check('L1 入口文档提交触及迁移 SQL → warning 疑似判低', r.status === 0 && /WARN 级别疑似判低.*m\.md/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 14:git fixture——L3 intent 与迁移 SQL 同 commit → 级别一致不告警 ----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-12-n.md', INTENT('n', '状态: done\n级别: L3\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 场景构造项（证据:fixture）\n'));
  w(T, 'workflow/specs/2026-09-12-n.md', SPEC('n', '状态: done\n级别: L3\n确认结果: approved\n确认时间: 2026-09-12', '\n## 确认与复核\n- 独立复核：已由 independent-reviewer 新会话完成,结论 approved\n'));
  w(T, 'workflow/plans/2026-09-12-n.md', PLAN('n', '状态: done\n级别: L3'));
  fs.mkdirSync(path.join(T, 'docs', 'scripts'), { recursive: true });
  w(T, 'docs/scripts/01-add-table.sql', 'CREATE TABLE t(id INT);\n');
  gitCommitAll(T, 'test');
  const r = run(T);
  check('L3 入口文档提交触及迁移 SQL → 级别一致不告警', r.status === 0 && !outOf(r).includes('级别疑似判低'), outOf(r));
  rmfix(T);
});

// ---- 场景 15:ZCode Adapter 缺失不告警(宿主未装),存在且断线仍告警 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o.md', INTENT('o', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o.md', PLAN('o', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.zcode', 'agents'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  w(T, '.zcode/agents/implementer.md', '---\nname: implementer\n---\n断线内容,无角色引用\n');
  const r = run(T);
  check('ZCode 缺失跳过/存在断线仍告警',
    r.status === 0 && outOf(r).includes('ZCode implementer 未引用公共角色') && !outOf(r).includes('ZCode 缺'), outOf(r));
  rmfix(T);
});

// ---- 场景 15b:CodeBuddy Adapter 缺失不告警(宿主未装),存在且断线仍告警 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o2.md', INTENT('o2', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o2.md', PLAN('o2', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.codebuddy', 'agents'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  w(T, '.codebuddy/agents/implementer.md', '---\nname: implementer\n---\n断线内容,无角色引用\n');
  const r = run(T);
  check('CodeBuddy 缺失跳过/存在断线仍告警',
    r.status === 0 && outOf(r).includes('CodeBuddy implementer 未引用公共角色') && !outOf(r).includes('CodeBuddy 缺'), outOf(r));
  rmfix(T);
});

// ---- 场景 15b2:OMP Adapter 缺失不告警(宿主未装),存在且断线仍告警 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o2b.md', INTENT('o2b', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o2b.md', PLAN('o2b', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.omp', 'agents'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  w(T, '.omp/agents/implementer.md', '---\nname: implementer\n---\n断线内容,无角色引用\n');
  const r = run(T);
  check('OMP 缺失跳过/存在断线仍告警',
    r.status === 0 && outOf(r).includes('OMP implementer 未引用公共角色') && !outOf(r).includes('OMP 缺'), outOf(r));
  rmfix(T);
});

// ---- 场景 15e:宿主注记环境事实单源(2026-10-25 优化7)——壳内联端口/绝对路径告警,指针形态不告警 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o4.md', INTENT('o4', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o4.md', PLAN('o4', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.trae', 'skills', 'verify-ui'), { recursive: true });
  fs.mkdirSync(path.join(T, '.zcode', 'agents'), { recursive: true });
  // 违规形态：内联端口槽字面量 + 盘符绝对路径；合规形态：只留指针（无数字端口/无绝对路径）
  w(T, '.trae/skills/verify-ui/SKILL.md', '# 壳\n- API 8932 与前端 5203 一律独立进程起。\n- bash 在 `C:\\Program Files\\Git\\bin\\bash.exe`。\n');
  w(T, '.zcode/agents/implementer.md', '---\nname: implementer\n---\n端口与路径见 .agents/notes/runtime-env.md §6（指针形态，无内联事实）\n');
  const r = run(T);
  const o = outOf(r);
  check('宿主壳内联环境事实 → WARN 宿主注记环境事实（点名违规文件行）',
    r.status === 0 && o.includes('宿主注记环境事实') && o.includes('.trae/skills/verify-ui/SKILL.md'), o);
  check('指针形态（无内联事实）不告警', !o.includes('.zcode/agents/implementer.md'), o);
  rmfix(T);
});

// ---- 场景 15c:宿主命令适配悬空(wf-X.md 无权威 .agents/commands/X.md) → 告警 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o3.md', INTENT('o3', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o3.md', PLAN('o3', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.agents', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(T, '.codebuddy', 'commands'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  w(T, '.agents/commands/build.md', '# build\n');
  w(T, '.codebuddy/commands/wf-build.md', '# wf-build\n');
  w(T, '.codebuddy/commands/wf-ghost.md', '# wf-ghost\n');
  w(T, '.codebuddy/commands/local-note.md', '# 宿主自有命令，不是 wf- 壳\n');
  const r = run(T);
  const o = outOf(r);
  check('宿主命令适配悬空 → WARN 命令适配悬空',
    r.status === 0 && o.includes('命令适配悬空') && o.includes('wf-ghost'), o);
  check('非 wf- 自定义命令不报悬空', !o.includes('local-note.md'), o);
  rmfix(T);
});

// ---- 场景 15d:命令指针壳须指向权威源且保持短；复制正文 → 过厚 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o4.md', INTENT('o4', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o4.md', PLAN('o4', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.agents', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(T, '.opencode', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(T, '.codebuddy', 'commands'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  w(T, '.agents/commands/ok.md', '---\ndescription: d\n---\n\n# Ok\n');
  w(T, '.opencode/commands/wf-ok.md', '---\ndescription: d\n---\n\n权威命令：`.agents/commands/ok.md`\n\n本文件是指针壳。\n');
  w(T, '.agents/commands/build.md', '---\ndescription: d\n---\n\n# Build\n');
  w(T, '.opencode/commands/wf-build.md', '---\ndescription: d\n---\n\n# Build\n\n只写了标题，没有权威路径。\n');
  w(T, '.agents/commands/design.md', '---\ndescription: d\n---\n\n# Design\n');
  const thick = ['---', 'description: d', '---', '', '权威命令：`.agents/commands/design.md`', ''];
  for (let i = 0; i < 20; i++) thick.push(`line ${i}`);
  w(T, '.codebuddy/commands/wf-design.md', thick.join('\n') + '\n');
  const r = run(T);
  const o = outOf(r);
  check('指针壳指向权威源 → 不报 wf-ok', r.status === 0 && !o.includes('wf-ok.md'), o);
  check('指针壳未写权威路径 → WARN 指针壳断线(wf-build)',
    o.includes('指针壳断线') && o.includes('wf-build.md'), o);
  check('复制成长正文 → WARN 指针壳过厚(wf-design)',
    o.includes('指针壳过厚') && o.includes('wf-design.md'), o);
  rmfix(T);
});

// ---- 场景 15d2:zcode dwf 编排面——元数据头齐全不告警;缺头/缺字段告警;非 dwf 后缀跳过 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o4b.md', INTENT('o4b', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o4b.md', PLAN('o4b', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.zcode', 'workflows'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  w(T, '.zcode/workflows/ok.dwf.ts', '/* zcode-workflow\ndescription: d\nwhenToUse: w\n*/\nreturn 1;\n');
  w(T, '.zcode/workflows/nohead.dwf.ts', 'const x = 1;\n');
  w(T, '.zcode/workflows/nofield.dwf.ts', '/* zcode-workflow\ndescription: d\n*/\nreturn 2;\n');
  w(T, '.zcode/workflows/helper.ts', 'export const y = 2;\n');
  const r = run(T);
  const o = outOf(r);
  check('dwf 元数据头齐全 → 不报 ok.dwf.ts', r.status === 0 && !o.includes('ok.dwf.ts'), o);
  check('缺元数据头 → WARN dwf 元数据缺失(nohead)', o.includes('nohead.dwf.ts 缺 zcode-workflow 元数据头'), o);
  check('缺 whenToUse → WARN dwf 元数据缺失(nofield)', o.includes('nofield.dwf.ts 元数据头缺 whenToUse 字段'), o);
  check('非 .dwf.ts 后缀不进检查(helper.ts)', !o.includes('helper.ts'), o);
  rmfix(T);
});

// ---- 场景 15e:opencode agent bash 权限镜像 settings.json 下限（缺报/全有不报/标量 deny 跳过）----
SCEN(async () => {
  const mkagent = (name, bashBlock) =>
    `---\ndescription: d\nmode: subagent\npermission:\n  edit: allow\n${bashBlock}  task: deny\n---\n# ${name}\n`;
  const SETTINGS = JSON.stringify({ permissions: { deny: ['git push --force'], ask: ['rm -rf'] } });
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-o5.md', INTENT('o5', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-o5.md', PLAN('o5', '状态: done\n级别: L1'));
  w(T, '.agents/settings.json', SETTINGS);
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.opencode', 'agents'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer', 'ui-verifier']) w(T, `.agents/roles/${r}.md`, `# role ${r}\n`);
  // full: 完整镜像 → 不报；gapped: 缺 ask 规则 → 报；scalar: 标量 deny → 跳过
  w(T, '.opencode/agents/full.md', mkagent('full', '  bash:\n    "*": allow\n    "git push --force*": deny\n    "rm -rf*": ask\n'));
  w(T, '.opencode/agents/gapped.md', mkagent('gapped', '  bash:\n    "*": allow\n    "git push --force*": deny\n'));
  w(T, '.opencode/agents/scalar.md', mkagent('scalar', '  bash: deny\n'));
  const r = run(T);
  const o = outOf(r);
  check('opencode 权限镜像:完整镜像/标量 deny 不误报', !o.includes('full.md') && !o.includes('scalar.md'), o);
  check('opencode 权限镜像:缺 settings ask 规则 → WARN 权限镜像漂移(gapped)',
    o.includes('权限镜像漂移') && o.includes('gapped.md') && o.includes('rm -rf'), o);
  rmfix(T);
});

// ---- 场景 16:skills 引用仓库内与用户级均不存在 → 仍报引用断档 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/README.md', '# WF README\n\n技能见 .agents/skills/fake-skill（仓库内与用户级均不存在）\n');
  w(T, 'workflow/intents/2026-09-12-p.md', INTENT('p', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T, 'workflow/plans/2026-09-12-p.md', PLAN('p', '状态: done\n级别: L1'));
  const r = run(T);
  check('skills 引用仓库内与用户级均无 → 仍报引用断档', r.status === 0 && /引用断档.*fake-skill/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 17:存量 done 含「存量对账豁免」声明 → 出账,无验收对账 warning ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-01-q.md', INTENT('q', '状态: done\n级别: L1\n日期: 2026-09-01', '\n## 验收标准（可测试）\n> **存量对账豁免（2026-09-12，用户拍板不追溯）**：下方未勾项均为第二轮 UI/浏览器实测项。\n- [ ] 用例通过\n'));
  w(T, 'workflow/plans/2026-09-01-q.md', PLAN('q', '状态: done\n级别: L1'));
  const r = run(T);
  check('存量含豁免声明 → 出账不计未对账', r.status === 0 && !outOf(r).includes('验收对账存量'), outOf(r));
  rmfix(T);
});

// ---- 场景 18:新建 done intent 缺「## 验收标准」节 → hard（2026-09-16 补口回归）----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-13-r.md', INTENT('r', '状态: done\n级别: L1\n日期: 2026-09-13', '\n## 目标\n关单前未写验收标准节。\n'));
  w(T, 'workflow/plans/2026-09-13-r.md', PLAN('r', '状态: done\n级别: L1'));
  gitCommitAll(T, 'add');
  expectHard('新建 done 缺验收标准节 → hard 验收未对账', T, '缺「## 验收标准」节');
  rmfix(T);
});

// ---- 场景 19:新建 done 勾选项缩进写法 → hard（口径放宽后仍拦）----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-13-s.md', INTENT('s', '状态: done\n级别: L1\n日期: 2026-09-13', '\n## 验收标准（可测试）\n  - [ ] 缩进未勾项（此前后静默通过）\n'));
  w(T, 'workflow/plans/2026-09-13-s.md', PLAN('s', '状态: done\n级别: L1'));
  gitCommitAll(T, 'add');
  expectHard('新建 done 勾选项缩进 → hard 验收未对账', T, '验收未对账');
  rmfix(T);
});

// ---- 场景 20:incident 状态值域外 → warning 带当前值 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-09-13-t.md', `---\n状态: 已修复\n级别: L1\n发现: 2026-09-13\n---\n# INCIDENT — t\n\n${三件套(false)}`);
  w(T, 'workflow/plans/2026-09-13-t.md', PLAN('t', '状态: done\n级别: L1'));
  const r = run(T);
  check('incident 状态值域外 → warning 且带当前值', r.status === 0 && /WARN 状态非法.*t\.md.*已修复/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 21:incident 缺级别 → warning 明示配对检查已跳过 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-09-13-u.md', `---\n状态: open\n发现: 2026-09-13\n---\n# INCIDENT — u\n\n${三件套(false)}`);
  const r = run(T);
  check('incident 缺级别 → warning 明示配对已跳过', r.status === 0 && /WARN 级别缺失.*u\.md.*配对检查已跳过/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 场景 22:存量 done 缺验收标准节 → 聚合 warning 不 hard ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-01-v.md', INTENT('v', '状态: done\n级别: L1\n日期: 2026-09-01', '\n## 目标\n存量旧格式,缺验收标准节。\n'));
  w(T, 'workflow/plans/2026-09-01-v.md', PLAN('v', '状态: done\n级别: L1'));
  const r = run(T);
  check('存量 done 缺节 → 聚合 warning 不 hard', r.status === 0 && outOf(r).includes('验收对账存量'), outOf(r));
  rmfix(T);
});

// ---- 场景 23/24:git 仓库模式——未跟踪并行半成品不拦 push;提交进 HEAD 后仍 hard ----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-12-ok2.md', INTENT('ok2', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 场景构造项（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-ok2.md', PLAN('ok2', '状态: done\n级别: L1'));
  gitCommitAll(T, 'base');
  w(T, 'workflow/intents/2026-09-18-parallel-wip.md', INTENT('并行会话半成品', '状态: draft\n级别: L1\n日期: 2026-09-18'));
  let r = run(T, { git: true });
  check('仓库模式:未跟踪 draft intent(无 plan)不进扫描,不拦 push', r.status === 0 && !outOf(r).includes('parallel-wip'), `exit=${r.status}\n${outOf(r)}`);
  gitCommitAll(T, 'wip');
  r = run(T, { git: true });
  check('仓库模式:已提交的入口缺 plan 仍进扫描（第 1 批降档：WARN 不阻断）',
    r.status === 0 && /缺 plan.*parallel-wip/.test(outOf(r)), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 25:检索层——模块合法 + INDEX 一致 → exit 0 无新告警（拷真实生成器+读取器+词表测接线）----
SCEN(async () => {
  const T = mkfix();
  fs.mkdirSync(path.join(T, '.agents', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(SCRIPT_DIR, 'gen-workflow-index.mjs'), path.join(T, '.agents', 'scripts', 'gen-workflow-index.mjs'));
  fs.copyFileSync(path.join(SCRIPT_DIR, 'workflow-enums.mjs'), path.join(T, '.agents', 'scripts', 'workflow-enums.mjs'));
  fs.copyFileSync(path.join(CONFIG_DIR, 'workflow-modules.txt'), path.join(T, '.agents', 'config', 'workflow-modules.txt'));
  w(T, 'workflow/intents/2026-09-22-mod-ok.md', INTENT('mod ok', '状态: approved\n级别: L1\n日期: 2026-09-22\n模块: pipeline', '\n## 验收标准（可测试）\n- [ ] 用例通过\n'));
  w(T, 'workflow/plans/2026-09-22-mod-ok.md', PLAN('mod ok', '状态: approved\n级别: L1\n模块: pipeline'));
  spawnSync(process.execPath, ['.agents/scripts/gen-workflow-index.mjs'], { cwd: T });
  const r = run(T);
  check('检索层:模块合法+INDEX 一致 → exit 0 无新告警',
    r.status === 0 && !outOf(r).includes('WARN 模块元数据') && !outOf(r).includes('WARN 索引漂移'), outOf(r));
  rmfix(T);
});

// ---- 场景 26:模块枚举非法 + 2026-09-22 起新建缺字段 → WARN 不阻断 ----
SCEN(async () => {
  const T = mkfix();
  fs.copyFileSync(path.join(CONFIG_DIR, 'workflow-modules.txt'), path.join(T, '.agents', 'config', 'workflow-modules.txt'));
  w(T, 'workflow/intents/2026-09-22-mod-bad.md', INTENT('mod bad', '状态: approved\n级别: L1\n日期: 2026-09-22\n模块: 不存在的模块'));
  w(T, 'workflow/plans/2026-09-22-mod-bad.md', PLAN('mod bad', '状态: approved\n级别: L1'));
  const r = run(T);
  const o = outOf(r);
  check('检索层:模块非法/缺字段 → WARN 且 exit 0',
    r.status === 0 && o.includes('WARN 模块元数据') && o.includes('不在词表') && o.includes('缺「模块:」字段'), o);
  rmfix(T);
});

// ---- 场景 27:INDEX 漂移不由 check-loop 重复告警（s06 退役；增量脚本已不挂 pre-commit）----
SCEN(async () => {
  const T = mkfix();
  fs.mkdirSync(path.join(T, '.agents', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(SCRIPT_DIR, 'gen-workflow-index.mjs'), path.join(T, '.agents', 'scripts', 'gen-workflow-index.mjs'));
  fs.copyFileSync(path.join(SCRIPT_DIR, 'workflow-enums.mjs'), path.join(T, '.agents', 'scripts', 'workflow-enums.mjs'));
  fs.copyFileSync(path.join(CONFIG_DIR, 'workflow-modules.txt'), path.join(T, '.agents', 'config', 'workflow-modules.txt'));
  w(T, 'workflow/intents/2026-09-22-drift.md', INTENT('drift', '状态: approved\n级别: L1\n日期: 2026-09-22\n模块: pipeline'));
  w(T, 'workflow/plans/2026-09-22-drift.md', PLAN('drift', '状态: approved\n级别: L1\n模块: pipeline'));
  spawnSync(process.execPath, ['.agents/scripts/gen-workflow-index.mjs'], { cwd: T });
  w(T, 'workflow/plans/2026-09-22-drift.md', PLAN('drift', '状态: done\n级别: L1\n模块: pipeline')); // 生成后改状态 → 漂移
  const r = run(T);
  check('检索层:INDEX 漂移不由 check-loop 重复告警',
    r.status === 0 && !outOf(r).includes('WARN 索引漂移'), outOf(r));
  rmfix(T);
});

// ---- 场景 28/29:常驻面预算——合规无告警;AGENTS.md 超限 → WARN 含一进一出 ----
SCEN(async () => {
  const T = mkfix();
  fs.mkdirSync(path.join(T, '.agents', 'scripts'), { recursive: true });
  // rule-budget.mjs import paths.mjs（→git-core.mjs）——依赖链一并拷入，否则门内执行失败
  copyEngineScripts(T, 'rule-budget.mjs', 'paths.mjs', 'git-core.mjs');
  fs.copyFileSync(path.join(CONFIG_DIR, 'rule-budgets.txt'), path.join(T, '.agents', 'config', 'rule-budgets.txt'));
  // 超限样本自校准：从拷入的预算表读 AGENTS.md 上限（预算可上调，硬编码样本会随上调失效——2026-10-06-v114-backflow-batch）
  const agLimit = Number(fs.readFileSync(path.join(T, '.agents', 'config', 'rule-budgets.txt'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('AGENTS.md ')).trim().split(' ').pop());
  w(T, 'AGENTS.md', '# AGENTS 小体积 fixture\n');
  fs.mkdirSync(path.join(T, '.agents', 'commands'), { recursive: true });
  w(T, '.agents/commands/plan.md', '# 小命令\n');
  w(T, 'workflow/intents/2026-09-22-budget-ok.md', INTENT('budget ok', '状态: approved\n级别: L1\n日期: 2026-09-22\n模块: pipeline'));
  w(T, 'workflow/plans/2026-09-22-budget-ok.md', PLAN('budget ok', '状态: approved\n级别: L1\n模块: pipeline'));
  let r = run(T);
  check('常驻面预算:合规 → 无超限告警且 exit 0', r.status === 0 && !outOf(r).includes('WARN 常驻面超限'), outOf(r));
  w(T, 'AGENTS.md', 'x'.repeat(agLimit + 512));
  w(T, 'workflow/intents/2026-09-22-budget-bad.md', INTENT('budget bad', '状态: approved\n级别: L1\n日期: 2026-09-22\n模块: pipeline'));
  w(T, 'workflow/plans/2026-09-22-budget-bad.md', PLAN('budget bad', '状态: approved\n级别: L1\n模块: pipeline'));
  r = run(T);
  const o = outOf(r);
  check('常驻面预算:超限 → WARN(含一进一出提示) 且 exit 0', r.status === 0 && o.includes('WARN 常驻面超限') && o.includes('一进一出'), o);
  rmfix(T);
});

// ---- 场景 30:rule-budget --staged 硬拦路径（2026-10-08 rule-budget.mjs 移植 node——恒可跑，无 SKIP 分支）----
SCEN(async () => {
  const T = mkfix();
  fs.mkdirSync(path.join(T, '.agents', 'scripts'), { recursive: true });
  // rule-budget.mjs import paths.mjs（→git-core.mjs）——依赖链一并拷入，否则直调失败
  copyEngineScripts(T, 'rule-budget.mjs', 'paths.mjs', 'git-core.mjs');
  fs.copyFileSync(path.join(CONFIG_DIR, 'rule-budgets.txt'), path.join(T, '.agents', 'config', 'rule-budgets.txt'));
  const agLimit = Number(fs.readFileSync(path.join(T, '.agents', 'config', 'rule-budgets.txt'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('AGENTS.md ')).trim().split(' ').pop());
  gitInit(T);
  w(T, 'AGENTS.md', 'x'.repeat(agLimit + 512));
  gitRetry(['add', 'AGENTS.md'], T);
  let r = spawnSync(process.execPath, ['.agents/scripts/rule-budget.mjs', '--staged'], { cwd: T, encoding: 'utf8' });
  check('rule-budget --staged:暂存超限 → exit 1（硬拦路径）',
    r.status === 1 && `${r.stdout}${r.stderr}`.includes('常驻面超限：AGENTS.md'), `${r.stdout}${r.stderr}`);
  w(T, 'AGENTS.md', '# 小体积\n');
  gitRetry(['add', 'AGENTS.md'], T);
  r = spawnSync(process.execPath, ['.agents/scripts/rule-budget.mjs', '--staged'], { cwd: T, encoding: 'utf8' });
  check('rule-budget --staged:合规 → exit 0（不误拦）', r.status === 0, `${r.stdout}${r.stderr}`);
  rmfix(T);
});

// ---- 场景 31/32/33:确认态留痕（检查 14）——无 approved 历史 WARN;先 approved 后 done 无 WARN;非 git 跳过 ----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  const fpInc = computeFingerprint(`---\n状态: fixed\n级别: L1\n发现: 2026-10-08\n模块: material\n---\n# INCIDENT — confirm gate\n\n${三件套(false)}`);
  const fp14 = computeFingerprint(`---\n状态: approved\n级别: L1\n模块: material\n---\n# PLAN — confirm gate\n`);
  w(T, 'workflow/incidents/2026-10-08-confirm-gate.md', `---\n状态: closed\n级别: L1\n发现: 2026-10-08\n模块: material\n确认指纹: ${fpInc.slice(0, 16)}\n---\n# INCIDENT — confirm gate\n\n${三件套(false)}`);
  writeLedger(T, [
    { ts: '2026-10-08T01:00:00.000Z', doc: 'workflow/incidents/2026-10-08-confirm-gate.md', stage: 'closed', fingerprint: fpInc, prev: 'fixed', source: 'chat-delegated', batch: 't31', seq: 1, of: 2 },
    { ts: '2026-10-08T01:00:00.000Z', doc: 'workflow/plans/2026-10-08-confirm-gate.md', stage: 'done', fingerprint: fp14, prev: 'approved', source: 'chat-delegated', batch: 't31', seq: 2, of: 2 },
  ]);
  w(T, 'workflow/plans/2026-10-08-confirm-gate.md', `---\n状态: done\n级别: L1\n模块: material\n确认指纹: ${fp14.slice(0, 16)}\n---\n# PLAN — confirm gate\n`);
  gitCommitAll(T, 'test');
  let r = run(T);
  check('新 done 无 approved 历史 → WARN 确认态缺失 且 exit 0',
    r.status === 0 && /WARN 确认态缺失.*2026-10-08-confirm-gate\.md/.test(outOf(r)), outOf(r));
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/incidents/2026-09-23-confirm-ok.md', `---\n状态: closed\n级别: L1\n发现: 2026-09-23\n模块: material\n---\n# INCIDENT — confirm ok\n\n${三件套(false)}`);
  w(T, 'workflow/plans/2026-09-23-confirm-ok.md', PLAN('confirm ok', '状态: approved\n级别: L1\n模块: material'));
  gitCommitAll(T, 'approved');
  w(T, 'workflow/plans/2026-09-23-confirm-ok.md', PLAN('confirm ok', '状态: done\n级别: L1\n模块: material'));
  gitCommitAll(T, 'done');
  const r = run(T);
  check('approved → done 留痕 → 无确认态缺失告警', r.status === 0 && !outOf(r).includes('WARN 确认态缺失'), outOf(r));
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  // evil merge 复现（2026-10-11 合并盲视修复的回归钉）：approved 痕迹只存在于合并提交自身
  //（两侧父线均无该文件）——无 --diff-merges=first-parent 时 pickaxe 不可见 → 确认态缺失误报。
  // CI 定因（2026-10-12，logs_28092 三轮确定性红 + 本地 GIT_CONFIG_GLOBAL 指空复现）：代理服务账号
  // 无全局 git 身份 → merge --no-commit 虽不落提交仍需 committer ident → exit 128
  // "Committer identity unknown"（本机有全局身份故绿——环境差异，非代码缺陷）。夹具内设局部身份，
  // 覆盖本场景全部 git 操作；iso 局部覆盖（hooksPath/gpgsign/fsmonitor/gc）仍保留为代理全局配置防御。
  gitRetry(['config', 'user.email', 't@t'], T);
  gitRetry(['config', 'user.name', 't'], T);
  const iso = ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];
  const localGit = (args) => gitRetry([...iso, ...args], T);
  const localCommit = (msg) => localGit(['commit', '-qm', msg]);
  const br = localGit(['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  if (!br) throw new Error(`fixture git symbolic-ref 空输出（假夹具防线）：无法定位默认分支（CI 代理 git 环境？）`);
  w(T, 'workflow/incidents/2026-09-23-confirm-mg.md', `---\n状态: closed\n级别: L1\n发现: 2026-09-23\n模块: material\n---\n# INCIDENT — confirm mg\n\n${三件套(false)}`);
  w(T, 'base.txt', 'base\n');
  localGit(['add', '-A']);
  localCommit('base');
  localGit(['checkout', '-q', '-b', 'side']);
  w(T, 'side.txt', 'side\n');
  localGit(['add', '-A']);
  localCommit('side work');
  localGit(['checkout', '-q', br]);
  w(T, 'main2.txt', 'main2\n');
  localGit(['add', '-A']);
  localCommit('main work');
  localGit(['merge', '--no-ff', '--no-commit', '-q', 'side']);
  w(T, 'workflow/plans/2026-09-23-confirm-mg.md', PLAN('confirm mg', '状态: approved\n级别: L1\n模块: material'));
  localGit(['add', '-A']);
  localCommit('evil merge brings approved');
  w(T, 'workflow/plans/2026-09-23-confirm-mg.md', PLAN('confirm mg', '状态: done\n级别: L1\n模块: material'));
  localGit(['add', '-A']);
  localCommit('done');
  const r = run(T);
  check('approved 痕迹仅存于合并提交（evil merge）→ 仍判留痕在案（--diff-merges=first-parent）', r.status === 0 && !outOf(r).includes('WARN 确认态缺失'), outOf(r));
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/incidents/2026-09-23-confirm-nogit.md', `---\n状态: closed\n级别: L1\n发现: 2026-09-23\n模块: material\n---\n# INCIDENT — confirm nogit\n\n${三件套(false)}`);
  w(T, 'workflow/plans/2026-09-23-confirm-nogit.md', PLAN('confirm nogit', '状态: done\n级别: L1\n模块: material'));
  const r = run(T);
  check('非 git fixture → 检查项 14 跳过,不误报', r.status === 0 && !outOf(r).includes('WARN 确认态缺失'), outOf(r));
  rmfix(T);
});
// ---- 场景 14b:检查 14 pickaxe 批量化分歧钉子（2026-10-10 perf-pickaxe-batch）----
// 同一提交混排「命中文件（approved 行）+ 未命中文件（直跳 done）」：批量索引不得把未命中文件
// 虚报为有 approved 历史（pickaxe+--name-only 只列命中文件——若 git 行为变化致 over-report，
// 本钉子转红）。批量化前同判据逐文档查询亦拦，此为等价性回归钉。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  const cOk = `---\n状态: approved\n级别: L1\n模块: material\n---\n# PLAN — batch ok\n`;
  const cNo = `---\n状态: done\n级别: L1\n模块: material\n---\n# PLAN — batch no\n`;
  w(T, 'workflow/plans/2026-10-08-batch-ok.md', cOk);
  w(T, 'workflow/plans/2026-10-08-batch-no.md', cNo);
  gitCommitAll(T, '同提交混排：approved 命中 + 直跳 done');
  const r = run(T);
  check('pickaxe 批量化:同提交未命中文件不虚报（batch-no 仍拦，batch-ok 不误报）',
    /确认态缺失.*batch-no\.md/.test(outOf(r)) && !/确认态缺失.*batch-ok/.test(outOf(r)),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 34/35/36:枚举单源——缺文件 fail-loud;缺键 fail-loud;CRLF 容忍 ----
SCEN(async () => {
  const T = mkfix();
  fs.rmSync(path.join(T, '.agents', 'config', 'workflow-enums.txt'));
  w(T, 'workflow/intents/2026-09-12-ok.md', INTENT('ok', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  expectHard('枚举单源文件缺失 → exit 1 fail-loud(不静默退化)', T, '枚举单源');
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  const f = path.join(T, '.agents', 'config', 'workflow-enums.txt');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^doc\.status\.confirmed=.*\n/m, ''));
  expectHard('枚举单源缺键 → exit 1 fail-loud', T, '缺键');
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  fs.writeFileSync(path.join(T, '.agents', 'config', 'workflow-enums.txt'), ENUMS_FIXTURE.replace(/\n/g, '\r\n'));
  w(T, 'workflow/intents/2026-09-12-ok.md', INTENT('ok', '状态: approved\n级别: L1\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-ok.md', PLAN('ok', '状态: approved\n级别: L1'));
  const r = run(T);
  check('枚举单源 CRLF 行尾 → approved/done 判定不受 \\r 影响', r.status === 0 && !outOf(r).includes('状态未确认'), outOf(r));
  rmfix(T);
});

// ---- 场景 37/38/39/40:检查 15 确认指纹对账——无指纹拦 / 配对齐过 / 指纹不符拦 / 生效日前豁免 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-27-cg.md', INTENT('cg', '状态: approved\n级别: L1\n日期: 2026-09-27'));
  w(T, 'workflow/plans/2026-09-27-cg.md', PLAN('cg', '状态: draft\n级别: L1'));
  expectHard('检查15:生效日起新档 approved 无指纹无台账 → hard 确认未对账', T, '确认未对账');
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  const i1 = mkConfirmedDoc(T, 'workflow/intents/2026-09-27-ok15.md', '状态: approved\n级别: L1\n日期: 2026-09-27');
  const p1 = mkConfirmedDoc(T, 'workflow/plans/2026-09-27-ok15.md', '状态: approved\n级别: L1');
  writeLedger(T, [
    { ts: 'T', doc: i1.rel, stage: 'approved', fingerprint: i1.fp, prev: 'draft' },
    { ts: 'T', doc: p1.rel, stage: 'approved', fingerprint: p1.fp, prev: 'draft' },
  ]);
  expectOk('检查15:指纹+台账配对齐 → exit 0', T);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  const i1 = mkConfirmedDoc(T, 'workflow/intents/2026-09-27-bad15.md', '状态: approved\n级别: L1\n日期: 2026-09-27');
  w(T, 'workflow/plans/2026-09-27-bad15.md', PLAN('bad15', '状态: draft\n级别: L1'));
  writeLedger(T, [{ ts: 'T', doc: i1.rel, stage: 'approved', fingerprint: 'e'.repeat(64), prev: 'draft' }]); // 指纹不符
  expectHard('检查15:指纹与台账不配对 → hard 确认未对账', T, '确认未对账');
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  // 豁免理由（2026-09-28 锚改台账 ts 后）：**台账无行** ⇒ 存量未受管，与文档自报日期无关。
  // 本场景构造的正是「日期早 + 无台账」——换锚前后结论一致，但理由已从「日期早于生效日」变为「无台账行」。
  w(T, 'workflow/intents/2026-09-26-old15.md', INTENT('old15', '状态: approved\n级别: L1\n日期: 2026-09-26'));
  w(T, 'workflow/plans/2026-09-26-old15.md', PLAN('old15', '状态: draft\n级别: L1'));
  expectOk('检查15:存量 approved 无台账行 → 豁免 exit 0', T);
  rmfix(T);
});

// ---- 场景 40:检查 8——证据写在 [x] 续行（仓库通写法「（证据：…）」另起一行）→ 不报缺证据 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-ev1.md', INTENT('ev1', '状态: done\n级别: L1\n日期: 2026-09-12',
    '\n## 验收标准（可测试）\n- [x] 用例通过\n（证据：commit fixture；套件全绿）\n- [x] 文档补齐\n（证据：AGENTS.md 第 1 行）\n'));
  w(T, 'workflow/plans/2026-09-12-ev1.md', PLAN('ev1', '状态: done\n级别: L1'));
  const r = run(T);
  check('证据在续行（全角冒号）→ 不报验收缺证据',
    r.status === 0 && !outOf(r).includes('验收缺证据'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 41:检查 8——[x] 无证据且续行也无 → 报验收缺证据（hard 拦；回归：不可把豁免放大成漏检）----
// 换锚后须真 git 仓：否则不可判定 → 走存量口径，「验收缺证据」这条 blocker 也不再产出。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/intents/2026-09-12-ev2.md', INTENT('ev2', '状态: done\n级别: L1\n日期: 2026-09-12',
    '\n## 验收标准（可测试）\n- [x] 用例通过\n- [x] 文档补齐\n（说明：无证据行）\n'));
  w(T, 'workflow/plans/2026-09-12-ev2.md', PLAN('ev2', '状态: done\n级别: L1'));
  gitCommitAll(T, 'add');
  const r = run(T);
  check('[x] 续行仍无证据 → 报验收缺证据（hard 拦 exit 1）',
    r.status === 1 && outOf(r).includes('验收缺证据'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// evidenceFixture：场景 43/44/47 共用脚手架——git 仓 + L1 done 三件（plan「改动方案」节声明 declared）+
// intent 证据引用唯一内容提交，返回 { T, sha }。createDeclared=false 时声明【从未存在】的文件（唯一内容
// 提交必然不触及，判定确定——2026-10-04 实测原「二次提交区分触及/不触及」方案在 npm test 环境偶发失败
// （git 时序敏感），负例改 ghost 构造）
const evidenceFixture = (slug, declared, createDeclared) => {
  const T = mkfix();
  gitInit(T);
  if (createDeclared) {
    fs.mkdirSync(path.join(T, path.dirname(declared)), { recursive: true });
    w(T, declared, '// fixture\n');
  }
  w(T, `workflow/plans/2026-10-04-${slug}.md`, PLAN(slug, '状态: done\n级别: L1', `\n## 改动方案\n- ${declared}：声明文件${createDeclared ? '' : '（实际不存在，证据必不触及）'}\n`));
  w(T, `workflow/intents/2026-10-04-${slug}.md`, INTENT(slug, '状态: done\n级别: L1\n日期: 2026-10-04',
    '\n## 验收标准（可测试）\n- [x] 用例通过（证据:commit PLACEHOLDER）\n'));
  gitCommitAll(T, `feat: ${slug} fixture`);
  const sha = shortSha(T, ['rev-parse', 'HEAD']).slice(0, 7);
  w(T, `workflow/intents/2026-10-04-${slug}.md`, INTENT(slug, '状态: done\n级别: L1\n日期: 2026-10-04',
    `\n## 验收标准（可测试）\n- [x] 用例通过（证据:commit ${sha}）\n`));
  gitCommitAll(T, `docs: ${slug} evidence`);
  return { T, sha };
};

// ---- 场景 43:检查 8 证据真相——L1 plan「改动方案」节（fill-plan 输出）+ 证据 SHA 触及声明文件 → 不报「证据无关」（2026-10-04 plan-section-name-evidence 回归）----
SCEN(async () => {
  const { T } = evidenceFixture('ev3', 'src/foo.js', true);
  const r = run(T);
  // fixture 不构造确认记录 → done 必触「确认未对账」hard（exit 1 预期）；核心断言是证据面不出现「证据无关」
  check('L1 plan「改动方案」节 + 证据触及声明文件 → 不报证据无关',
    !outOf(r).includes('证据无关'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 44:检查 8 证据真相——L1 plan「改动方案」节 + 证据 SHA 不触及声明文件 → 仍报「证据无关」（负例，防过度豁免）----
SCEN(async () => {
  const { T } = evidenceFixture('ev4', 'src/ghost.js', false);
  const r = run(T);
  check('L1 plan「改动方案」节 + 证据不触及声明文件 → 仍报证据无关（负例）',
    outOf(r).includes('证据无关'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 47b：多 SHA 证据（evidence-multi-sha 2026-10-27）----
// 形态来源：实仓 2026-10-27-material-code-overview-page 证据行同时引实现提交与上一单关单提交，
// 旧实现只取首个 token → 实现提交排在后面时被判「未触及声明文件」而硬拦（实测误拦 push）。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-ms1.md', PLAN('ms1', '状态: done\n级别: L1\n日期: 2026-09-26\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'src'), { recursive: true });
  w(T, 'src/app.mjs', '// fixture\n');
  gitCommitAll(T, 'feat: ms1 实现');
  const implSha = shortSha(T);
  // 关单提交（docs 型，不触及声明文件）——排在证据行前面，旧实现会只认它
  w(T, 'workflow/README.md', 'note\n');
  gitCommitAll(T, 'docs: 关单留痕');
  const docsSha = shortSha(T);
  w(T, 'workflow/intents/2026-09-26-ms1.md', INTENT('ms1', '状态: done\n级别: L1\n日期: 2026-09-26',
    `\n## 验收标准（可测试）\n- [x] 用例通过（证据:上一单 ${docsSha} 同款记录；本单 ${implSha}）\n`));
  expectNoKw('多 SHA：docs 旁证在前、实现提交在后 → 不报证据无关', T, '证据无关');

  // 负例：行内混入一个不存在的 SHA —— 即使有真实现提交也须拦（防混排洗白）
  w(T, 'workflow/intents/2026-09-26-ms1.md', INTENT('ms1', '状态: done\n级别: L1\n日期: 2026-09-26',
    `\n## 验收标准（可测试）\n- [x] 用例通过（证据:${implSha} 与 deadbeef1）\n`));
  expectHard('多 SHA：混入不存在 SHA → 仍拦「证据伪造」', T, '证据伪造');
  rmfix(T);
});

// ---- 场景 47:检查 8 证据真相——证据 SHA 触及声明文件 → 校验通过 exit 0（2026-10-04 review-fix-batch：
// 补 spec 2026-10-04-plan-section-name-evidence §49「校验通过（type=sha）」断言强度——场景 43 的 fixture
// 触「确认未对账」hard 只能间接断言无「证据无关」；本场景沿场景 5x 造法（锚前自报日期豁免存量面）走满
// type=sha 放行路径：证据为真实 SHA + 声明文件被提交触及 + 提交无执行器标记 → exit 0 只能经 type=sha 达成
// （text 需无 hex 串 / process 需 runId 标记 / forged·irrelevant 均 exit 1，三条岔路均被构造排除）----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-sh1.md', PLAN('sh1', '状态: done\n级别: L1\n日期: 2026-09-26\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'src'), { recursive: true });
  w(T, 'src/app.mjs', '// fixture\n');
  gitCommitAll(T, 'feat: sh1 实现（无执行器标记）');
  const sha = shortSha(T);
  w(T, 'workflow/intents/2026-09-26-sh1.md', INTENT('sh1', '状态: done\n级别: L1\n日期: 2026-09-26', `\n## 验收标准（可测试）\n- [x] 用例通过（证据:${sha}）\n`));
  expectOk('证据 SHA 触及声明文件（无执行器标记）→ type=sha 校验通过 exit 0', T);
  rmfix(T);
});

// ---- 场景 42:检查 4——fill-{intent,spec,plan}.mjs 花括号展开，三路皆存在 → 不报引用断档 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'AGENTS.md', '# AGENTS\n\n起草先跑 `node .agents/scripts/fill-{intent,spec,plan}.mjs` 拿结构化草稿。\n');
  fs.mkdirSync(path.join(T, '.agents', 'scripts'), { recursive: true });
  for (const n of ['fill-intent', 'fill-spec', 'fill-plan']) w(T, `.agents/scripts/${n}.mjs`, '// stub\n');
  w(T, 'workflow/intents/2026-09-12-br1.md', INTENT('br1', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-br1.md', PLAN('br1', '状态: done\n级别: L1'));
  const r = run(T);
  check('花括号展开三路存在 → 不报引用断档',
    r.status === 0 && !outOf(r).includes('引用断档'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 45（原 43，2026-10-04 review-fix-batch 改号避让证据真相场景重号；旧号无文档按号引用）:检查 4——花括号展开三路皆不存在 → 仍报引用断档（带完整展开式文案）----
SCEN(async () => {
  const T = mkfix();
  w(T, 'AGENTS.md', '# AGENTS\n\n起草先跑 `node .agents/scripts/fill-{alpha,beta,gamma}.mjs` 拿结构化草稿。\n');
  w(T, 'workflow/intents/2026-09-12-br2.md', INTENT('br2', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-br2.md', PLAN('br2', '状态: done\n级别: L1'));
  const r = run(T);
  check('花括号展开三路皆无 → 仍报引用断档',
    r.status === 0 && /引用断档.*fill-\{alpha,beta,gamma\}\.mjs/.test(outOf(r)), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 46（原 44，同场景 45 缘由改号）:检查 2——<主题> 与 .md 同行 = 命名约定描述 → 不报模板未填 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-01-nm1.md', INTENT('nm1', '状态: done\n级别: L1\n日期: 2026-09-01',
    '\n编排脚本（`.agents/pipelines/<主题>.md`）：frontmatter + stages 表。\n复制本模板为 YYYY-MM-DD-<主题>.md 后填写。\n'));
  w(T, 'workflow/plans/2026-09-01-nm1.md', PLAN('nm1', '状态: done\n级别: L1'));
  const r = run(T);
  check('<主题>+.md 命名约定行 → 不报模板未填',
    r.status === 0 && !outOf(r).includes('模板未填'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 5x/5y/5z:检查 8 证据核验——过程证据形态（2026-10-03 check-evidence-process）----
// 造法：gitInit（激活证据核验的 rev-parse 路径）+ 锚前自报日期（豁免检查 15 存量面）；
// 证据引用「改动面外文件的提交」：带执行器标记 → process 放行；无标记 → irrelevant 拦；SHA 不存在 → forged 拦。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-pe1.md', PLAN('pe1', '状态: done\n级别: L1\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'notes'), { recursive: true });
  w(T, 'notes/other.md', 'x\n');
  gitCommitAll(T, 'docs(x): 演练穿越（pipeline-run 20260926-0900-pe1-abc1）');
  const sha = shortSha(T);
  w(T, 'workflow/intents/2026-09-26-pe1.md', INTENT('pe1', '状态: done\n级别: L1\n日期: 2026-09-26', `\n## 验收标准（可测试）\n- [x] 演练穿越（证据:${sha}）\n`));
  expectOk('过程证据:提交信息带执行器标记（改动面外）→ 放行 exit 0', T);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-pe2.md', PLAN('pe2', '状态: done\n级别: L1\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'notes'), { recursive: true });
  w(T, 'notes/other.md', 'x\n');
  gitCommitAll(T, 'docs(x): 演练穿越（L1，无标记提交）');
  const sha = shortSha(T);
  w(T, 'workflow/intents/2026-09-26-pe2.md', INTENT('pe2', '状态: done\n级别: L1\n日期: 2026-09-26', `\n## 验收标准（可测试）\n- [x] 演练穿越（证据:${sha}）\n`));
  expectHard('过程证据:无标记无关提交 → 仍拦 证据无关', T, '证据无关');
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-pe3.md', PLAN('pe3', '状态: done\n级别: L1\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  w(T, 'workflow/intents/2026-09-26-pe3.md', INTENT('pe3', '状态: done\n级别: L1\n日期: 2026-09-26', '\n## 验收标准（可测试）\n- [x] 演练穿越（证据:deadbee）\n'));
  expectHard('过程证据:SHA 不存在 → forged 仍拦（防伪线不放松）', T, '证据伪造');
  rmfix(T);
});
// ---- 场景 5v:git 基础设施异常 fail-loud（2026-10-05-gitout-fail-open）----
// CHECK_LOOP_GIT 指向不存在路径 → spawnSync 跨平台稳定 r.error（ENOENT）→ 响亮出账恰一条（进程去重）
// + 证据核验降级（exit 语义不变、无业务裁决误报）；正常 git 零出账（防误报负例）
// 注（L2 复核 P2-2）：出账断言不构成 :581 接入 spawnGit 的独立钉死——探测门与 :581 共用去重 flag，
// 变异（:581 改回裸 spawnSync）三断言仍绿；:581 接线由代码走读 + CI 覆盖，瞬时重试路径静态替身不可测
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-pe4.md', PLAN('pe4', '状态: done\n级别: L1\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'notes'), { recursive: true });
  w(T, 'notes/other.md', 'x\n');
  gitCommitAll(T, 'docs(x): 演练穿越（L1，无标记提交）');
  const sha = shortSha(T);
  w(T, 'workflow/intents/2026-09-26-pe4.md', INTENT('pe4', '状态: done\n级别: L1\n日期: 2026-09-26', `\n## 验收标准（可测试）\n- [x] 演练穿越（证据:${sha}）\n`));
  const r = run(T, { env: { CHECK_LOOP_GIT: 'definitely-not-git-xyz-2026' } });
  const hits = outOf(r).split('git 探测异常').length - 1;
  check('git 基础设施异常:响亮出账恰一条（进程去重）', hits === 1, `hits=${hits}\n${outOf(r)}`);
  check('git 基础设施异常:持续异常仍 fail-closed（伪造拦不放松，防静默降级）', r.status === 1 && outOf(r).includes('证据伪造'), `exit=${r.status}\n${outOf(r)}`);
  check('git 基础设施异常:基础设施异常不冒充业务裁决（无证据无关误报）', !outOf(r).includes('证据无关'), outOf(r));
  rmfix(T);
});
SCEN(async () => {
  // 决定性钉子（2026-10-09 AI-Native 架构审查修复）：上一夹具的证据用真 HEAD 短 SHA，落在 text 豁免
  // 分支与否取决于哈希运气（全数字≈4.4%/夹具）——本夹具锁死数字形态，钉住「git 起不来时实证兜底
  // 无从发生，纯数字证据不得抢先豁免」这条 fail-closed 线（沿场景 5u 构造性钉子「不依赖哈希运气」同口径）
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-pe4b.md', PLAN('pe4b', '状态: done\n级别: L1\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'notes'), { recursive: true });
  w(T, 'notes/other.md', 'x\n');
  gitCommitAll(T, 'docs(x): 演练穿越（L1，无标记提交）');
  w(T, 'workflow/intents/2026-09-26-pe4b.md', INTENT('pe4b', '状态: done\n级别: L1\n日期: 2026-09-26', '\n## 验收标准（可测试）\n- [x] 演练穿越（证据:2620913）\n'));
  const r = run(T, { env: { CHECK_LOOP_GIT: 'definitely-not-git-xyz-2026' } });
  check('git 基础设施异常:纯数字证据无兜底不抢先豁免 → 仍 fail-closed（决定性钉子）',
    r.status === 1 && outOf(r).includes('证据伪造') && !outOf(r).includes('证据豁免 text'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-26-pe5.md', PLAN('pe5', '状态: done\n级别: L1\n模块: material', '\n## 改动方案\n\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'notes'), { recursive: true });
  w(T, 'notes/other.md', 'x\n');
  gitCommitAll(T, 'docs(x): 演练穿越（L1，无标记提交）');
  const sha = shortSha(T);
  w(T, 'workflow/intents/2026-09-26-pe5.md', INTENT('pe5', '状态: done\n级别: L1\n日期: 2026-09-26', `\n## 验收标准（可测试）\n- [x] 演练穿越（证据:${sha}）\n`));
  const r = run(T);
  check('git 基础设施异常:正常 git 零出账（防误报负例）', !outOf(r).includes('git 探测异常'), outOf(r));
  check('git 基础设施异常:正常 git 行为不变（无标记无关提交仍拦证据无关）', r.status === 1 && outOf(r).includes('证据无关'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 5u:检查 8 全数字证据串——rev-parse 实证分流（2026-10-05-check8-digit-sha-misfire）----
// 纯数字证据串曾由 /^\d+$/ 形态守卫抢先 text 豁免（全数字短 SHA≈4.4%/夹具 静默漏检）；改为实证分流：
// 能解析成提交（含同名 ref/tag）→ 走真相核验；解析失败 → 维持 text 豁免。构造性钉子：git tag 数字名，不依赖哈希运气
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-10-04-ev5.md', PLAN('ev5', '状态: done\n级别: L1', '\n## 改动方案\n- src/ghost.js：声明文件（实际不存在，证据必不触及）\n'));
  w(T, 'workflow/intents/2026-10-04-ev5.md', INTENT('ev5', '状态: done\n级别: L1\n日期: 2026-10-04', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:2620913）\n'));
  gitCommitAll(T, 'feat: ev5 fixture');
  gitRetry(['tag', '2620913', 'HEAD'], T);
  const r = run(T);
  check('全数字证据串可解析成提交（同名 ref）→ 按真相核验报证据无关（数字形态不豁免）',
    outOf(r).includes('证据无关'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-10-04-ev6.md', PLAN('ev6', '状态: done\n级别: L1', '\n## 改动方案\n- src/ghost.js：声明文件（实际不存在，证据必不触及）\n'));
  w(T, 'workflow/intents/2026-10-04-ev6.md', INTENT('ev6', '状态: done\n级别: L1\n日期: 2026-10-04', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:20260926）\n'));
  gitCommitAll(T, 'feat: ev6 fixture');
  const r = run(T);
  check('纯数字时间戳证据（无同名 ref）→ 维持文本豁免不误报',
    !outOf(r).includes('证据无关') && !outOf(r).includes('证据伪造'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 8U-1/2/3:检查 8 大写 A-F token 预筛（2026-10-10 perf-evidence-git-memoize）----
// 大写单据号类 token（对象名规范输出恒小写）rev-parse 必失败：带上下文 → external 豁免不 spawn；
// 裸引用 → 小写化实证兜底（git hex 解析大小写不敏感——大写拼写真 SHA 可解析），不存在的对象仍 forged。
// 8U-3 为决定性钉子：构造性重掷保证短 SHA 含字母（全数字短 SHA 大写化后不变、测不到预筛分支，
// 沿 5u「不依赖哈希运气」口径），锁死「真 SHA 被大写粘贴不被误拦」这条安全网。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-10-10-up1.md', PLAN('up1', '状态: done\n级别: L1', '\n## 改动方案\n- src/ghost.js：声明文件（实际不存在）\n'));
  w(T, 'workflow/intents/2026-10-10-up1.md', INTENT('up1', '状态: done\n级别: L1\n日期: 2026-10-10', '\n## 验收标准（可测试）\n- [x] 出库单核验（证据:出库单 BCCAC121100001 已核）\n'));
  gitCommitAll(T, 'feat: up1 fixture');
  const r = run(T);
  check('大写单据号+上下文残余 → external 豁免（不硬拦）',
    outOf(r).includes('证据豁免 external') && !outOf(r).includes('证据伪造'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-10-10-up2.md', PLAN('up2', '状态: done\n级别: L1', '\n## 改动方案\n- src/ghost.js：声明文件（实际不存在）\n'));
  w(T, 'workflow/intents/2026-10-10-up2.md', INTENT('up2', '状态: done\n级别: L1\n日期: 2026-10-10', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:BCCAC121100001）\n'));
  gitCommitAll(T, 'feat: up2 fixture');
  const r = run(T);
  check('裸大写 token 非对象 → 仍 forged 硬拦（防伪线不放松）',
    outOf(r).includes('证据伪造'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-10-10-up3.md', PLAN('up3', '状态: done\n级别: L1', '\n## 改动方案\n- src/app.mjs：实现功能\n'));
  fs.mkdirSync(path.join(T, 'src'), { recursive: true });
  let sha = '', rolls = 0;
  while (!/[a-f]/.test(sha) && rolls++ < 50) {
    w(T, 'src/app.mjs', `// fixture 重掷 ${rolls}\n`);
    gitCommitAll(T, `feat: up3 实现（重掷 ${rolls}）`);
    sha = shortSha(T);
  }
  if (!/[a-f]/.test(sha)) throw new Error('up3 重掷 50 次未得含字母短 SHA（P≈(10/16)^7^50，不应发生）');
  w(T, 'workflow/intents/2026-10-10-up3.md', INTENT('up3', '状态: done\n级别: L1\n日期: 2026-10-10', `\n## 验收标准（可测试）\n- [x] 用例通过（证据:${sha.toUpperCase()}）\n`));
  const r = run(T);
  check('裸大写拼写真 SHA → 小写化兜底解析成功，进真相核验不误拦',
    !outOf(r).includes('证据伪造') && !outOf(r).includes('证据无关') && !outOf(r).includes('证据豁免 external'),
    `sha=${sha}\nexit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 45:检查 2——真未填占位（标题 <主题>，无 .md）→ 仍报模板未填 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-01-nm2.md', INTENT('<主题>', '状态: done\n级别: L1\n日期: 2026-09-01', '\n正文无占位。\n'));
  w(T, 'workflow/plans/2026-09-01-nm2.md', PLAN('nm2', '状态: done\n级别: L1'));
  const r = run(T);
check('标题 <主题>（无 .md）→ 仍报模板未填',
  r.status === 0 && outOf(r).includes('模板未填'), `exit=${r.status}\n${outOf(r)}`);
rmfix(T);
});
// ---- 场景 45b:检查 2——plan 确认节模板样板豁免；真实占位仍报（2026-10-03 plan-confirm-boiler）----
SCEN(async () => {
const T = mkfix();
w(T, 'workflow/intents/2026-09-01-bo1.md', INTENT('bo1', '状态: done\n级别: L1\n日期: 2026-09-01', '\n## 验收标准（可测试）\n- [x] 用例通过\n'));
w(T, 'workflow/plans/2026-09-01-bo1.md', PLAN('bo1', '状态: done\n级别: L1', '\n## 确认与复核\n\n- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）\n'));
const r1 = run(T);
check('检查2 plan 确认节样板句 → 不报模板未填',
  r1.status === 0 && !outOf(r1).includes('模板未填'), `exit=${r1.status}\n${outOf(r1)}`);
rmfix(T);
});
SCEN(async () => {
const T = mkfix();
w(T, 'workflow/intents/2026-09-01-bo2.md', INTENT('bo2', '状态: done\n级别: L1\n日期: 2026-09-01', '\n## 验收标准（可测试）\n- [x] 用例通过\n'));
w(T, 'workflow/plans/2026-09-01-bo2.md', PLAN('bo2', '状态: done\n级别: L1', '\n## 确认与复核\n\n- 日期: YYYY-MM-DD\n'));
const r2 = run(T);
check('检查2 plan 真实未填占位（日期: YYYY-MM-DD）→ 仍报模板未填',
  r2.status === 0 && outOf(r2).includes('模板未填'), `exit=${r2.status}\n${outOf(r2)}`);
rmfix(T);
});
// ---- 场景 45c:检查 2——日期显示格式字面量豁免；纯占位仍报（2026-10-06 check2-datetime-literal-exempt）----
// 日期取 2026-09-26（< 确认门 v1 锚 2026-09-27，豁免检查 15 存量面——沿 5x 块先例），避免 hard 干扰本断言
SCEN(async () => {
const T = mkfix();
w(T, 'workflow/intents/2026-09-26-dt1.md', INTENT('dt1', '状态: done\n级别: L1\n日期: 2026-09-26',
  '\n匹配时间列格式简化为 YYYY-MM-DD HH:mm；同款括号形态（YYYY-MM-DD HH:mm）与秒级 YYYY-MM-DD HH:mm:ss 均为格式描述。\n'));
w(T, 'workflow/plans/2026-09-26-dt1.md', PLAN('dt1', '状态: done\n级别: L1'));
const r1 = run(T);
check('检查2 裸写 YYYY-MM-DD HH:mm(:ss) 显示格式描述 → 不报模板未填',
  r1.status === 0 && !outOf(r1).includes('模板未填'), `exit=${r1.status}\n${outOf(r1)}`);
rmfix(T);
});
SCEN(async () => {
const T = mkfix();
w(T, 'workflow/intents/2026-09-26-dt2.md', INTENT('dt2', '状态: done\n级别: L1\n日期: 2026-09-26',
  '\n匹配时间列格式简化为 YYYY-MM-DD HH:mm（合法格式描述）；另有真占位 日期: YYYY-MM-DD 在同文档。\n'));
w(T, 'workflow/plans/2026-09-26-dt2.md', PLAN('dt2', '状态: done\n级别: L1', '\n- 日期: YYYY-MM-DD\n'));
const r2 = run(T);
check('检查2 同文档混真占位（无时间后缀）→ 格式描述豁免不吞真占位，仍报',
  r2.status === 0 && outOf(r2).includes('模板未填'), `exit=${r2.status}\n${outOf(r2)}`);
rmfix(T);
});
// ---- 场景 46:检查 6——薄适配正文含 .agents/roles/<role>.md 引用 → 不报 Adapter 断线 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-ad1.md', INTENT('ad1', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-ad1.md', PLAN('ad1', '状态: done\n级别: L1'));
  fs.mkdirSync(path.join(T, '.agents', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(T, '.zcode', 'agents'), { recursive: true });
  w(T, '.agents/roles/implementer.md', '# role implementer\n');
  w(T, '.zcode/agents/implementer.md', '---\nname: implementer\n---\n> 契约见 `.agents/roles/implementer.md`。\n');
  const r = run(T);
  check('薄适配含角色引用 → 不报 Adapter 断线',
    r.status === 0 && !outOf(r).includes('Adapter 断线'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 47:检查 4——fill-*.mjs 星号通配，目录内有匹配文件 → 不报引用断档；无匹配 → 仍报 ----
SCEN(async () => {
  const T = mkfix();
  w(T, 'AGENTS.md', '# AGENTS\n\n起草先跑 `node .agents/scripts/fill-*.mjs`；孤儿引用 `.agents/scripts/ghost-*.mjs`。\n');
  fs.mkdirSync(path.join(T, '.agents', 'scripts'), { recursive: true });
  for (const n of ['fill-intent', 'fill-spec', 'fill-plan']) w(T, `.agents/scripts/${n}.mjs`, '// stub\n');
  w(T, 'workflow/intents/2026-09-12-gb1.md', INTENT('gb1', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-gb1.md', PLAN('gb1', '状态: done\n级别: L1'));
  const r = run(T);
  check('星号通配有匹配 → 不报；无匹配 → 仍报引用断档',
    r.status === 0 && !/引用断档.*fill-\*/.test(outOf(r)) && /引用断档.*ghost-\*\.mjs/.test(outOf(r)), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
// ---- 场景 48:检查 15——委托代录台账行（source/quote 额外字段）照常配对放行（两形态口径，2026-09-27 confirm-gate-delegated）----
SCEN(async () => {
  const T = mkfix();
  const i1 = mkConfirmedDoc(T, 'workflow/intents/2026-09-27-del15.md', '状态: approved\n级别: L1\n日期: 2026-09-27');
  const p1 = mkConfirmedDoc(T, 'workflow/plans/2026-09-27-del15.md', '状态: approved\n级别: L1');
  writeLedger(T, [
    { ts: 'T', doc: i1.rel, stage: 'approved', fingerprint: i1.fp, prev: 'draft', source: 'chat-delegated', quote: '2选2' },
    { ts: 'T', doc: p1.rel, stage: 'approved', fingerprint: p1.fp, prev: 'draft', source: 'tty' },
  ]);
  expectOk('检查15:委托代录台账行（source+quote）照常配对 → exit 0', T);
  rmfix(T);
});

// ---- 场景 49-54:检查 15 done 内容绑定（2026-09-27 audit-gate-hardening；同日 p2-batch 改锚台账 ts + 保分隔符复原）----
//     done 形态复刻真实时序：approved 内容（含 approved 指纹）→ done 指纹在其上计算 → 落 done 文档 + 台账 done 行
//     opt.ts：台账 done 行 ts（默认 2026-09-28T02:00Z——生效锚后）；opt.sep：状态行键值分隔符（默认单空格，
//     '  ' 复刻两跳间手工改成双空格的非规范格式）
SCEN(async () => {
  const mkDoneFixture = (T, date, tamper, opt = {}) => {
    const sep = opt.sep || ' ';
    const ts = opt.ts || '2026-09-28T02:00:00.000Z';
    const body = `\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n`;
    const pre = `---\n状态:${sep}approved\n级别: L1\n日期: ${date}\n确认指纹: ${'a'.repeat(16)}\n---\n# INTENT — bind\n${body}`;
    const fpDone = computeFingerprint(pre);
    // tamper 只污染 done 落盘文本（不进指纹底稿）——复刻「done 确认后篡改正文」
    const doneText = `---\n状态:${sep}done\n级别: L1\n日期: ${date}\n确认指纹: ${fpDone.slice(0, 16)}\n---\n# INTENT — bind\n${body}${tamper || ''}`;
    w(T, 'workflow/intents/' + date + '-bind.md', doneText);
    w(T, 'workflow/plans/' + date + '-bind.md', PLAN('bind', '状态: draft\n级别: L1'));
    return { rel: 'workflow/intents/' + date + '-bind.md', fp: fpDone, ts };
  };
  {
    const T = mkfix();
    const d1 = mkDoneFixture(T, '2026-09-28');
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }]);
    expectOk('检查15:done 内容与台账一致（复原重算=台账指纹）→ exit 0', T);
    rmfix(T);
  }
  {
    const T = mkfix();
    const d1 = mkDoneFixture(T, '2026-09-28', '确认后被篡改的正文行\n');
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }]);
    expectHard('检查15:done 后正文被篡改 → hard 确认内容漂移', T, '确认内容漂移');
    rmfix(T);
  }
  {
    const T = mkfix();
    // 生效锚 = 台账 ts：文档日期晚、但确认发生在锚前（旧关单顺序时代）→ 豁免绑定
    const d1 = mkDoneFixture(T, '2026-09-28', '锚前确认的文档即便日后改了也不绑\n', { ts: '2026-09-27T10:00:00.000Z' });
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }]);
    expectOk('检查15:台账 ts 早于生效锚（2026-09-28）→ 豁免内容绑定', T);
    rmfix(T);
  }
  {
    const T = mkfix();
    // 锚后确认 + 文档日期早（旧日期文档晚关单）+ 篡改 → 绑定照拦（p2-batch 改锚的核心收益）
    const d1 = mkDoneFixture(T, '2026-09-27', '确认后被篡改的正文行\n');
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }]);
    expectHard('检查15:文档日期早但台账 ts 锚后 + 篡改 → hard 确认内容漂移', T, '确认内容漂移');
    rmfix(T);
  }
  {
    const T = mkfix();
    const d1 = mkDoneFixture(T, '2026-09-28');
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: d1.fp }]); // 无 prev（schema 演进前行）
    const r = run(T);
    check('检查15:台账 done 行缺 prev → 降级 WARN 绑定跳过（exit 0 不拦）',
      r.status === 0 && outOf(r).includes('绑定降级'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    const T = mkfix();
    // 两跳间状态行被手工改成双空格（非规范分隔符）——保分隔符复原不误伤（p2-batch P2-1）
    const d1 = mkDoneFixture(T, '2026-09-28', '', { sep: '  ' });
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }]);
    expectOk('检查15:状态行双空格（非规范分隔符）绑定仍过——保分隔符复原不误伤', T);
    rmfix(T);
  }
});

// ---- 场景 55-56:检查 4 引用扫描收窄活跃态（2026-09-27 audit-gate-hardening）----
SCEN(async () => {
  const T = mkfix();
  // 日期取生效日前（2026-09-26）：superseded 现入 15 配对集（closing-coverage），无台账行 ⇒ 免配对
  // （2026-09-28 锚改台账 ts 后，豁免理由 = 无台账行），场景焦点保持在「终态退出引用扫描」本身
  w(T, 'workflow/intents/2026-09-26-refterm.md', INTENT('refterm', '状态: superseded\n级别: L1\n日期: 2026-09-26', '\n引用 .agents/scripts/ghost-gone.mjs\n'));
  w(T, 'workflow/plans/2026-09-26-refterm.md', PLAN('refterm', '状态: superseded\n级别: L1'));
  const r = run(T);
  check('检查4:终态文档引用断链不再报（历史叙述退出扫描）',
    r.status === 0 && !outOf(r).includes('引用断档'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-26-reflive.md', INTENT('reflive', '状态: approved\n级别: L1\n日期: 2026-09-26', '\n引用 .agents/scripts/ghost-gone.mjs\n'));
  w(T, 'workflow/plans/2026-09-26-reflive.md', PLAN('reflive', '状态: draft\n级别: L1'));
  const r = run(T);
  check('检查4:活跃文档引用断链仍报（收窄只放终态）',
    r.status === 0 && outOf(r).includes('引用断档') && outOf(r).includes('ghost-gone.mjs'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 场景 57-60:检查 15 incidents 确认门（2026-09-27 gate-coverage，配对自 2026-09-28 起）----
//     fixed/closed 须指纹+台账配对；closed 与 done 同口径内容绑定（ts 锚 + 保分隔符）；open 起草态不加门
SCEN(async () => {
  const mkIncFixture = (T, st, tamper, opt = {}) => {
    const ts = opt.ts || '2026-09-28T02:00:00.000Z';
    const body = 三件套(false);
    const pre = `---\n状态: fixed\n级别: L1\n发现: 2026-09-28\n确认指纹: ${'a'.repeat(16)}\n---\n# INCIDENT — inc\n${body}`;
    const fpClosed = computeFingerprint(pre);
    // tamper 只污染 closed 落盘文本（不进指纹底稿）——复刻「closed 确认后篡改正文」
    const closedText = `---\n状态: ${st}\n级别: L1\n发现: 2026-09-28\n确认指纹: ${fpClosed.slice(0, 16)}\n---\n# INCIDENT — inc\n${body}${tamper || ''}`;
    w(T, 'workflow/incidents/2026-09-28-inc.md', closedText);
    w(T, 'workflow/plans/2026-09-28-inc.md', PLAN('inc', '状态: draft\n级别: L1'));
    return { rel: 'workflow/incidents/2026-09-28-inc.md', fp: fpClosed, ts };
  };
  {
    // incident closed（生效日起）无指纹无台账 → hard 确认未对账
    const T = mkfix();
    w(T, 'workflow/incidents/2026-09-28-inc15.md', `---\n状态: closed\n级别: L1\n发现: 2026-09-28\n---\n# INCIDENT — inc15\n${三件套(false)}`);
    w(T, 'workflow/plans/2026-09-28-inc15.md', PLAN('inc15', '状态: draft\n级别: L1'));
    expectHard('检查15:incident closed（生效日起）无指纹无台账 → hard 确认未对账', T, '确认未对账');
    rmfix(T);
  }
  {
    const T = mkfix();
    const i1 = mkIncFixture(T, 'closed');
    writeLedger(T, [{ ts: i1.ts, doc: i1.rel, stage: 'closed', fingerprint: i1.fp, prev: 'fixed', source: 'tty' }]);
    expectOk('检查15:incident closed 配对+内容绑定一致 → exit 0', T);
    rmfix(T);
  }
  {
    const T = mkfix();
    const i1 = mkIncFixture(T, 'closed', 'closed 确认后被篡改的正文行\n');
    writeLedger(T, [{ ts: i1.ts, doc: i1.rel, stage: 'closed', fingerprint: i1.fp, prev: 'fixed', source: 'tty' }]);
    expectHard('检查15:incident closed 后正文被篡改 → hard 确认内容漂移', T, '确认内容漂移');
    rmfix(T);
  }
  {
    // open 起草态不加门（无指纹无台账 → 不报确认未对账）
    const T = mkfix();
    w(T, 'workflow/incidents/2026-09-28-incopen.md', `---\n状态: open\n级别: L1\n发现: 2026-09-28\n---\n# INCIDENT — incopen\n${三件套(false)}`);
    w(T, 'workflow/plans/2026-09-28-incopen.md', PLAN('incopen', '状态: draft\n级别: L1'));
    const r = run(T);
    check('检查15:incident open（起草态）不进确认门 → 不报确认未对账',
      r.status === 0 && !outOf(r).includes('确认未对账'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
});

// ---- 场景 61-63:检查 15 放弃态覆盖（2026-09-27 closing-coverage：superseded/cancelled 配对 + 四终态绑定）----
SCEN(async () => {
  const mkAbandonFixture = (T, st, tamper) => {
    const ts = '2026-09-28T02:00:00.000Z';
    const body = '\n正文行\n';
    const pre = `---\n状态: approved\n级别: L1\n日期: 2026-09-28\n确认指纹: ${'a'.repeat(16)}\n---\n# INTENT — ab\n${body}`;
    const fp = computeFingerprint(pre);
    const after = `---\n状态: ${st}\n级别: L1\n日期: 2026-09-28\n确认指纹: ${fp.slice(0, 16)}\n---\n# INTENT — ab\n${body}${tamper || ''}`;
    w(T, 'workflow/intents/2026-09-28-ab.md', after);
    w(T, 'workflow/plans/2026-09-28-ab.md', PLAN('ab', '状态: draft\n级别: L1'));
    return { rel: 'workflow/intents/2026-09-28-ab.md', fp, ts };
  };
  {
    // superseded（生效日起）无指纹无台账 → hard 确认未对账（手改出账的口子收死）
    const T = mkfix();
    w(T, 'workflow/intents/2026-09-28-ab1.md', `---\n状态: superseded\n级别: L1\n日期: 2026-09-28\n---\n# INTENT — ab1\n`);
    w(T, 'workflow/plans/2026-09-28-ab1.md', PLAN('ab1', '状态: draft\n级别: L1'));
    expectHard('检查15:superseded（生效日起）无指纹无台账 → hard 确认未对账', T, '确认未对账');
    rmfix(T);
  }
  {
    // superseded + 配对 + 终态绑定：篡改 → hard 确认内容漂移
    const T = mkfix();
    const a1 = mkAbandonFixture(T, 'superseded', 'superseded 确认后被篡改的正文行\n');
    writeLedger(T, [{ ts: a1.ts, doc: a1.rel, stage: 'superseded', fingerprint: a1.fp, prev: 'approved', source: 'tty' }]);
    expectHard('检查15:superseded 后正文被篡改 → hard 确认内容漂移（四终态绑定）', T, '确认内容漂移');
    rmfix(T);
  }
  {
    // cancelled + 配对 + 绑定一致 → 过
    const T = mkfix();
    const a1 = mkAbandonFixture(T, 'cancelled');
    writeLedger(T, [{ ts: a1.ts, doc: a1.rel, stage: 'cancelled', fingerprint: a1.fp, prev: 'approved', source: 'chat-delegated', quote: '不做了' }]);
    expectOk('检查15:cancelled 配对+绑定一致 → exit 0', T);
    rmfix(T);
  }
});

// ---- 场景:检查 15 承诺面绑定（approved 档，2026-10-27 approved-content-binding）----
// 整篇内容绑定只覆盖终态（done/closed/superseded/cancelled）——approved 档（用户已点头、正在施工）
// 的承诺被改写此前完全不可见。现对 approved 档改绑「承诺面」（判据文本/红线/目标/改动方案）：
// 关单期合法动作（勾验收 + 证据回填 / 确认结果 / 复核行）经归一后不改承诺面，故不误伤；
// 承诺判据被改写而未重新点头 → hard 承诺面漂移。
SCEN(async () => {
  const date = '2026-09-28';
  const ts = '2026-09-28T02:00:00.000Z';
  const mkAppr = (T, slug, preBody, afterBody) => {
    const pre = `---\n状态: draft\n级别: L1\n日期: ${date}\n---\n${preBody}`;
    const fp = computeFingerprint(pre);
    const commit = commitmentFingerprint(pre);
    w(T, `workflow/intents/${date}-${slug}.md`,
      `---\n状态: approved\n级别: L1\n日期: ${date}\n确认指纹: ${fp.slice(0, 16)}\n---\n${afterBody}`);
    w(T, `workflow/plans/${date}-${slug}.md`, PLAN(slug, '状态: draft\n级别: L1'));
    return { rel: `workflow/intents/${date}-${slug}.md`, fp, commit };
  };
  {
    const T = mkfix();
    const a = mkAppr(T, 'ap1',
      '# INTENT — ap1\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n',
      '# INTENT — ap1\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n');
    writeLedger(T, [{ ts, doc: a.rel, stage: 'approved', fingerprint: a.fp, prev: 'draft', source: 'chat-delegated', quote: '可以', commit: a.commit }]);
    expectOk('检查15:approved 承诺面与台账一致 → exit 0', T);
    rmfix(T);
  }
  {
    const T = mkfix();
    const a = mkAppr(T, 'ap2',
      '# INTENT — ap2\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n',
      '# INTENT — ap2\n\n## 验收标准\n\n- [x] 1. 判据乙（证据：commit abc）\n');
    writeLedger(T, [{ ts, doc: a.rel, stage: 'approved', fingerprint: a.fp, prev: 'draft', source: 'chat-delegated', quote: '可以', commit: a.commit }]);
    expectHard('检查15:approved 后承诺判据被改写 → hard 承诺面漂移', T, '承诺面漂移');
    rmfix(T);
  }
  {
    // 关单期合法动作：勾验收 + 证据回填（判据文本未变）→ 承诺面未变，不误伤
    const T = mkfix();
    const a = mkAppr(T, 'ap3',
      '# INTENT — ap3\n\n## 验收标准\n\n- [ ] 1. 判据甲\n',
      '# INTENT — ap3\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n');
    writeLedger(T, [{ ts, doc: a.rel, stage: 'approved', fingerprint: a.fp, prev: 'draft', source: 'chat-delegated', quote: '可以', commit: a.commit }]);
    expectOk('检查15:approved 后仅勾验收+证据回填 → 承诺面未变，不误伤', T);
    rmfix(T);
  }
  {
    // 存量（本次上线前确认，台账行无 commit 字段）→ 静默跳过、不回溯
    const T = mkfix();
    const a = mkAppr(T, 'ap4',
      '# INTENT — ap4\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n',
      '# INTENT — ap4\n\n## 验收标准\n\n- [x] 1. 判据乙（证据：commit abc）\n');
    writeLedger(T, [{ ts, doc: a.rel, stage: 'approved', fingerprint: a.fp, prev: 'draft', source: 'chat-delegated', quote: '可以' }]);
    expectOk('检查15:approved 存量行无承诺面指纹 → 静默跳过（不追溯）', T);
    rmfix(T);
  }
});

// ---- 场景 64-66:检查 15 并录批次审计（2026-09-28 batch-ledger-audit 改判据：读 batch/of 事实）----
// 判据演进：原「同 quote + 相邻 ts 差 < 2s」反推调用次数（已被实证假阳性+假阴性，整段退役）；
// 现「台账行按 batch 分组、组内 of>1 且含 delegated 行 → warning」。本块场景随之改判定依据，
// **断言强度不放宽、场景不删**（同一意图换了机制）：
//   · 原「同 quote 双份 2s 内」→ 现「同 batch、of=2、delegated」→ 报（机制换、意图同：一次调用落两份）
//   · 原「异 quote / >2s 不聚组」→ 现「不同 batch（或 of=1）→ 不报」；且**新增反向场景**：同 batch
//     但换 quote、或人为延迟跨 2s，仍须被拦——这正是旧判据的盲区（旧判据下会漏报）
//   · 原「revert-draft 注记行不参与」→ 现由 VALID_STAGES 过滤承接（同意图）
SCEN(async () => {
  const mk2LedgerDocs = (T) => {
    // 两份全配对绑定的 done 文档（复用 mkDoneFixture 的构造口径）
    const mkOne = (slug, date) => {
      const body = `\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n`;
      const pre = `---\n状态: approved\n级别: L1\n日期: ${date}\n确认指纹: ${'a'.repeat(16)}\n---\n# INTENT — ${slug}\n${body}`;
      const fp = computeFingerprint(pre);
      w(T, `workflow/intents/${date}-${slug}.md`, `---\n状态: done\n级别: L1\n日期: ${date}\n确认指纹: ${fp.slice(0, 16)}\n---\n# INTENT — ${slug}\n${body}`);
      w(T, `workflow/plans/${date}-${slug}.md`, PLAN(slug, '状态: draft\n级别: L1'));
      return { rel: `workflow/intents/${date}-${slug}.md`, fp };
    };
    return [mkOne('ab1', '2026-09-28'), mkOne('ab2', '2026-09-28')];
  };
  {
    // 同一批（batch 同、of=2）delegated → warning 可见（exit 0 不阻断）——原「同 quote 双份」的新机制等价物
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '两份一起', batch: 'b1', seq: 1, of: 2 },
      { ts: '2026-09-28T02:00:00.100Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '两份一起', batch: 'b1', seq: 2, of: 2 },
    ]);
    const r = run(T);
    check('检查15:同 batch 且 of=2（delegated）→ WARN 确认并录（exit 0 审计可见性）',
      r.status === 0 && outOf(r).includes('确认并录') && outOf(r).includes('2 份'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【核心回归·旧判据盲区】同一批但**换 quote**（"甲"/"乙"）且 ts 相差 5s：
    //   旧判据（同 quote + 差 < 2s）→ 两个信号都不命中 → **零告警**（漏报真实并录）
    //   新判据读 batch/of（与 quote、ts 无关）→ 仍须报。此场景在旧判据下必然变红。
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '甲', batch: 'b2', seq: 1, of: 2 },
      { ts: '2026-09-28T02:00:05.000Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '乙', batch: 'b2', seq: 2, of: 2 },
    ]);
    const r = run(T);
    check('检查15:同 batch 但换 quote + 隔 5s → 仍报并录（旧判据盲区，本单核心回归）',
      r.status === 0 && outOf(r).includes('确认并录') && outOf(r).includes('2 份'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // of=1（逐件调用）复用**同一句** quote 且 ts 极近 → **不报**。
    // 这是旧判据的假阳性面：用户两次都说「可以」+ 快速连跑，旧判据必然误报；新判据读 of=1 正确放过。
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '可以', batch: 'b3', seq: 1, of: 1 },
      { ts: '2026-09-28T02:00:00.050Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '可以', batch: 'b4', seq: 1, of: 1 },
    ]);
    const r = run(T);
    check('检查15:两次逐件调用（of=1）复用同一句 quote 且 ts 极近 → 不报（修旧判据假阳性）',
      r.status === 0 && !outOf(r).includes('确认并录'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // TTY 形态 of>1：用户亲手逐份过目键入（天然逐件），不构成违规 → 不报
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T03:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty', batch: 't1', seq: 1, of: 2 },
      { ts: '2026-09-28T03:00:01.000Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'tty', batch: 't1', seq: 2, of: 2 },
    ]);
    const r = run(T);
    check('检查15:TTY 形态 of=2（亲手逐份过目）→ 不报并录',
      r.status === 0 && !outOf(r).includes('确认并录'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 无 batch 字段的历史行（schema 演进前）→ 静默跳过，不报、不降级出账
    // （沿 audit-gate-hardening P3：无判定依据的行不产出不可消除噪声）
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '两份一起' },
      { ts: '2026-09-28T02:00:01.500Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '两份一起' },
    ]);
    const r = run(T);
    check('检查15:无 batch 的历史行 → 静默跳过（不报、不降级出账）',
      r.status === 0 && !outOf(r).includes('确认并录'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 不同 batch 各自 of=1；revert-draft 注记行（stage 非法）不参与 → 一条都不报
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: 'x', batch: 'c1', seq: 1, of: 1 },
      { ts: '2026-09-28T02:00:00.400Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: 'x', batch: 'c2', seq: 1, of: 1 },
      { ts: '2026-09-28T02:00:00.900Z', doc: 'workflow/plans/2026-09-28-ghost.md', stage: 'revert-draft', fingerprint: 'n/a', prev: 'approved', source: 'chat-delegated', quote: 'x', batch: 'c3', seq: 1, of: 3 },
    ]);
    const r = run(T);
    check('检查15:异 batch 各自 of=1 + revert-draft 注记行 → 不报并录（注记行由 VALID_STAGES 过滤）',
      r.status === 0 && !outOf(r).includes('确认并录') && !outOf(r).includes('ghost'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P2-3】组内 `of` 不一致（人为构造）时判据不得因**行序**而改变结论：
    // 原实现取 rows[0].of —— 首行 of=1、次行 of=2 会漏报；现取组内 some(of>1)，两个方向都报。
    // 正常批次由 confirm-doc 写同一个 of=docs.length，组内恒一致；本用例专门钉住顺序无关性。
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '甲', batch: 'd1', seq: 1, of: 1 },
      { ts: '2026-09-28T02:00:01.000Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '乙', batch: 'd1', seq: 2, of: 2 },
    ]);
    const r = run(T);
    check('检查15:组内 of 不一致（首行 of=1 / 次行 of=2）→ 仍报（判据顺序无关，复核 P2-3）',
      r.status === 0 && outOf(r).includes('确认并录'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 反向：首行 of=2 / 次行 of=1 —— 与上条同批、仅行序相反，结论必须一致（都报）
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '甲', batch: 'd2', seq: 1, of: 2 },
      { ts: '2026-09-28T02:00:01.000Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '乙', batch: 'd2', seq: 2, of: 1 },
    ]);
    const r2 = run(T);
    check('检查15:组内 of 不一致（首行 of=2 / 次行 of=1）→ 仍报（与上条对称，顺序无关）',
      r2.status === 0 && outOf(r2).includes('确认并录'),
      `exit=${r2.status}\n${outOf(r2)}`);
    rmfix(T);
  }
  {
    // 【复核 P2-3 收口】「可报组与 revert-draft 注记行并存 → 恰报 1 次、注记行不参与」
    // 上一版场景把两行改成异 batch of=1 后，fixture 里已无可报组，只验证了「无可报组时零报」——
    // 本用例恢复旧版被覆盖的组合（旧断言为 `length===1 && includes('2 份')`，此处以新机制等价重建）。
    const T = mkfix();
    const [d1, d2] = mk2LedgerDocs(T);
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'chat-delegated', quote: '两份一起', batch: 'p1', seq: 1, of: 2 },
      { ts: '2026-09-28T02:00:00.400Z', doc: d2.rel, stage: 'done', fingerprint: d2.fp, prev: 'approved', source: 'chat-delegated', quote: '两份一起', batch: 'p1', seq: 2, of: 2 },
      // 注记行：与上批**同 batch id 但 stage 非法**——若 VALID_STAGES 过滤失效，它会被并入该批
      { ts: '2026-09-28T02:00:00.900Z', doc: 'workflow/plans/2026-09-28-ghost.md', stage: 'revert-draft', fingerprint: 'n/a', prev: 'approved', source: 'chat-delegated', quote: '两份一起', batch: 'p1', seq: 3, of: 3 },
    ]);
    const r = run(T);
    check('检查15:可报组与 revert-draft 注记行并存 → 恰报 1 次且注记行不参与（复核 P2-4 补回）',
      r.status === 0 && (outOf(r).match(/确认并录/g) || []).length === 1
        && outOf(r).includes('2 份') && !outOf(r).includes('ghost'),
      `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
});

// ---- 场景 67-71:检查 15 受管准入两条件取或（2026-09-28 incident confirm-gate-effective-date-anchor）----
// 换锚前：受管准入仅「自报日期 ≥ 生效日」——新档把日期写早即整段跳过判定（确认门静默不开）。
// 换锚后：受管 = ①台账有合法跳转行 ∨ ②自报日期 ≥ 生效日；两者皆不满足才豁免（存量）。
// ①独立于自报日期成立 → 堵死「确认过却写早日期逃掉对账」；②保留 → 兜住「新档完全没跑 confirm-doc」。
// 本块自包含构造（不复用他块作用域内的 mkDoneFixture，避免跨块引用）。
SCEN(async () => {
  const mkAnchorFixture = (T, date, tamper, opt = {}) => {
    const ts = opt.ts || '2026-09-28T02:00:00.000Z';
    const body = `\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n`;
    const pre = `---\n状态: approved\n级别: L1\n日期: ${date}\n确认指纹: ${'a'.repeat(16)}\n---\n# INTENT — anchor\n${body}`;
    const fp = computeFingerprint(pre);
    // tamper 只污染 done 落盘文本（不进指纹底稿）——复刻「done 确认后篡改正文」
    w(T, `workflow/intents/${date}-anchor.md`,
      `---\n状态: done\n级别: L1\n日期: ${date}\n确认指纹: ${fp.slice(0, 16)}\n---\n# INTENT — anchor\n${body}${tamper || ''}`);
    w(T, `workflow/plans/${date}-anchor.md`, PLAN('anchor', '状态: draft\n级别: L1'));
    return { rel: `workflow/intents/${date}-anchor.md`, fp, ts };
  };

  {
    // 核心回归（本 incident 的触发条件）：自报日期早于生效日，但台账 ts 在生效日之后 → 仍须 hard 拦。
    // 换锚前此场景被 `d < eff` 跳过判定（静默放行）；换锚后按台账事实纳入受管。
    const T = mkfix();
    const d1 = mkAnchorFixture(T, '2026-09-20'); // 自报日期 2026-09-20（早于任何生效日）
    writeLedger(T, [{ ts: d1.ts, doc: d1.rel, stage: 'done', fingerprint: 'e'.repeat(64), prev: 'approved', source: 'tty' }]); // 指纹不符
    expectHard('检查15:自报日期早但台账 ts 锚后 + 指纹不符 → hard 确认未对账（换锚前被静默跳过）', T, '确认未对账');
    rmfix(T);
  }
  {
    // 存量豁免须**两条件皆不满足**：日期早（2026-09-26 < 生效日）且台账无行 → 免配对。
    // 注意「日期新但无台账」**不**豁免（那是新档漏走确认门，见上一条核心回归的反面）——
    // 两条件取或的语义即：任一条命中即受管，故豁免档必须两条都不命中。
    const T = mkfix();
    w(T, 'workflow/intents/2026-09-26-noledge.md', INTENT('noledge', '状态: approved\n级别: L1\n日期: 2026-09-26'));
    w(T, 'workflow/plans/2026-09-26-noledge.md', PLAN('noledge', '状态: draft\n级别: L1'));
    expectOk('检查15:日期早于生效日且台账无行 → 存量豁免（两条件皆不满足）', T);
    rmfix(T);
  }
  {
    // 条件①的**独立判别力**（复核 P2-2 更正）：日期早（条件②不命中，本会被日期条件豁免）
    // + 台账有行但**指纹不匹配** → 条件①独立成立 ⇒ 受管 ⇒ 配对失败 ⇒ hard 拦。
    // 断言必须用 expectHard 而非 expectOk：旧单条件下该 doc 因日期早被整段跳过（exit 0），
    // 用 expectOk 会「新旧门都通过」而无法证伪条件①被移除（上一版即此缺陷，属无效测试）。
    // 现版本在忠实变异（还原旧单条件）下会变红——与核心回归场景同向锁定条件①的独立成立。
    const T = mkfix();
    const d1 = mkAnchorFixture(T, '2026-09-20');
    writeLedger(T, [{ ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: 'e'.repeat(64), prev: 'approved', source: 'tty' }]); // 指纹不符
    expectHard('检查15:日期早但台账有行（指纹不匹配）→ 受管并 hard 拦（条件①独立于日期成立）', T, '确认未对账');
    rmfix(T);
  }
  {
    // 重确认：同一 doc+stage 台账多行 → 取末次 ts 判锚（append-only 末次生效；不能因首行早于锚而误豁免）
    const T = mkfix();
    const d1 = mkAnchorFixture(T, '2026-09-28', '确认后被篡改的正文行\n');
    writeLedger(T, [
      { ts: '2026-09-27T10:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }, // 早期行（锚前）
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'done', fingerprint: d1.fp, prev: 'approved', source: 'tty' }, // 末次行（锚后）
    ]);
    expectHard('检查15:同 doc+stage 台账多行取末次 ts → 篡改仍 hard 确认内容漂移（重确认场景）', T, '确认内容漂移');
    rmfix(T);
  }
  {
    // 非合法跳转行（revert-open / revert-draft 类回退注记）**不构成本 incident 的核心命题**——
    // 为把该属性与日期条件隔离，此处取日期早于生效日（条件②不命中），使受管准入**只**取决于台账条件：
    //   · 若注记行被判为「合法跳转行」→ 台账条件命中 → 受管 → 无指纹 → hard 拦（期望：不拦，故失败）
    //   · 期望：注记行被 VALID_STAGES 过滤 → 台账条件不命中 → 两条件皆不满足 → 存量豁免
    // 注记行不是「确认确实发生过」的证据，不能被当成台账行把文档拖进受管面
    // （否则回退操作反而制造 hard 拦——本 incident 自己就吃过这个亏，见 incident 备注「落态注记」）。
    const T = mkfix();
    const d1 = mkAnchorFixture(T, '2026-09-26');
    writeLedger(T, [
      { ts: '2026-09-28T02:00:00.000Z', doc: d1.rel, stage: 'revert-open', fingerprint: 'n/a', prev: 'approved', source: 'chat-delegated', quote: '回退注记' },
    ]);
    expectOk('检查15:仅 revert-open 注记行（非合法跳转 stage）→ 不构成台账条件，日期早 → 存量豁免 exit 0', T);
    rmfix(T);
  }
});

// ---- 场景 72-74:检查 8 生效日锚改 git 首次加入日期（2026-09-28 check8-git-anchor）----
// 换锚前锚取**文件名前 10 字符**——项目命名规范本身即 YYYY-MM-DD-<主题>，作者日常手写该前缀，
// 「写早」无需任何额外动作、顺手即发生 → 一条 hard 门可被平凡绕过（有未勾验项却 exit 0）。
// 换锚后锚取 git 首次加入日期（**日常不可顺手改动**的事实）→ 关掉「改文件名」零成本通道；
// **诚实边界（复核 P1 更正）**：该锚取 `%aI` = author date（作者自报时间戳），`git commit --date=<过去>`
// 仍可伪造 → **不宣称「通道关闭」**，仅把伪造成本从「改文件名」抬到「主动伪造时间戳」。
SCEN(async () => {
  {
    // 【核心回归】文件名日期写早（2026-09-01 < accCutoff 2026-09-12），但**实际是新建档**
    // （git 首次加入在生效日之后）→ 仍须 hard 拦。换锚前此场景被 `filedate >= accCutoff` 跳过（静默放行）。
    const T = mkfix();
    gitInit(T);
    w(T, 'workflow/intents/2026-09-01-early.md', INTENT('early', '状态: done\n级别: L1\n日期: 2026-09-01', '\n## 验收标准\n- [ ] 未勾项\n'));
    w(T, 'workflow/plans/2026-09-01-early.md', PLAN('early', '状态: done\n级别: L1'));
    gitCommitAll(T, 'add'); // 加入时间 = 今天（≥ accCutoff）→ git 事实：新建档
    expectHard('检查8:文件名日期写早但 git 首次加入够新 + 未勾验 → hard 拦（换锚前被静默跳过）', T, '验收未对账');
    rmfix(T);
  }
  {
    // 【退化语义】非 git 仓（fixture 常态）→ 不可判定 → 走存量口径，**不误报 hard**。
    // 钉住「换锚不引入新的误拦」：不可判定时宁可放过（advisory 层），不放 hard。
    const T = mkfix();
    w(T, 'workflow/intents/2026-09-15-nogit.md', INTENT('nogit', '状态: done\n级别: L1\n日期: 2026-09-15', '\n## 验收标准\n- [ ] 未勾项\n'));
    w(T, 'workflow/plans/2026-09-15-nogit.md', PLAN('nogit', '状态: done\n级别: L1'));
    const r = run(T);
    check('检查8:非 git 仓 → 不可判定走存量口径（不误报 hard）',
      r.status === 0 && !outOf(r).includes('验收未对账'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【对照】同一内容、仅把**文件名**改为够新（09-15）→ 两锚下都应 hard 拦。
    // 与核心回归并置，说明「拦不拦由 git 事实决定，不由文件名字段决定」。
    const T = mkfix();
    gitInit(T);
    w(T, 'workflow/intents/2026-09-15-newer.md', INTENT('newer', '状态: done\n级别: L1\n日期: 2026-09-15', '\n## 验收标准\n- [ ] 未勾项\n'));
    w(T, 'workflow/plans/2026-09-15-newer.md', PLAN('newer', '状态: done\n级别: L1'));
    gitCommitAll(T, 'add');
    expectHard('检查8:文件名日期够新 + git 加入够新 + 未勾验 → hard 拦（对照）', T, '验收未对账');
    rmfix(T);
  }
});

// ---- 场景 75-79:检查 16 量化断言指标签名对账（2026-09-28 claim-exceeds-fix）----
// 设计要点：本检查**只查显式签名**（`{{小写.点分}}`），不全文扫数字——理由是本仓「N 行/N 条/N 份」
// 类表述多为历史叙述（描述某次提交当时的规模），全文扫描会产生不可消退的假阳性（P3 红线）。
// 故本组用例的核心断言是**假阳性恒 0**：无签名时零告警；装户模板占位符（全大写）不误报。
SCEN(async () => {
  const MC = 'ledger.lines = ledger.lines\ndocs.count.plans = docs.count.plans\n';
  const seedLedger = (T, lines) => w(T, '.agents/confirmations.jsonl', lines.join('\n') + '\n');
  // T2 口径适配（2026-09-28 check16-inline-debt）：scanFiles16 统一走 docFiles（.md ∧ 数字前缀 ∧ tracked），
  // 非数字前缀件不再进检查 16 扫描面——原 p1/p2/… 无前缀文件名曾靠「旧扫描面收非前缀件」成立。改为
  // 数字前缀 + 同名 intent（沿场景 80-90 activePlan 先例：缺 intent 会被「配对断裂」hard-block 干扰断言）。
  const activePlan16 = (T, name, body) => {
    w(T, `workflow/intents/2026-09-01-${name}.md`, INTENT(name, '状态: draft\n级别: L1'));
    w(T, `workflow/plans/2026-09-01-${name}.md`, PLAN(name, '状态: draft\n级别: L1', body));
  };
  {
    // 【核心回归】活跃文档留签名未回填 → warning 且提示实时值
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}', '{"doc":"b","stage":"done"}', '{"doc":"c","stage":"done"}']);
    activePlan16(T, 'p1', '\n台账共 {{ledger.lines}} 行\n');
    const r = run(T);
    const o = outOf(r);
    check('检查16:活跃文档留签名未回填 → WARN 且给出实时值 3（advisory 不阻断）',
      r.status === 0 && o.includes('指标待回填') && o.includes('实时值 = 3'), `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【假阳性恒 0 · 核心】无签名 → 零告警（历史叙述里的裸数字不得被扫）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan16(T, 'p2', '\n台账共 47 行，其中 13 条并录（历史叙述，非签名）\n');
    const r = run(T);
    check('检查16:无签名 → 零告警（裸数字是历史叙述，不得产生假阳性）',
      r.status === 0 && !outOf(r).includes('指标'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【假阳性恒 0 · 关键边界】装户模板占位符（全大写 SCREAMING_CASE）不误报
    // ——不收窄形态会对本仓 plans 内 11 处合法模板占位符全部误报（实测量级）。
    // 注：占位符**运行时拼装**而非字面写入——本仓的占位符残留门禁（doctor §5）会把字面
    // 全大写 `{{X}}` 判为残留并改写包源副本，导致本用例在包源侧退化为测「<填写> 不误报」
    // （仍绿但不再证明 SCREAMING_CASE 被排除）。拼装后两侧语义一致、断言强度不退。
    const SCREAMING = (n) => '{{' + n + '}}';
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan16(T, 'p3',
      '\n构建 = ' + SCREAMING('BUILD_CMD') + '；端口 ' + SCREAMING('BOARD_PORT') + '；项目 ' + SCREAMING('PROJECT_NAME') + '\n');
    const r = run(T);
    check('检查16:装户模板占位符（全大写 SCREAMING_CASE）→ 不误报（形态收窄）',
      r.status === 0 && !outOf(r).includes('指标'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【fail-loud】引用未登记指标 → 明示（未登记＝无从对账，不静默放过）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan16(T, 'p4', '\n引用 {{nope.metric}}\n');
    const r = run(T);
    check('检查16:引用未登记指标 → fail-loud 出账（不静默跳过）',
      outOf(r).includes('指标未登记'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【转义】讲语法 / 举例的行加反斜杠 → 不报（否则「文档教怎么用签名」被误判为「忘了回填」）
    // 该需求由本检查在自己的 spec 上抓到（实现后立刻 5 处误报）。
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan16(T, 'p8', '\n写法示例如 `\\{{ledger.lines}}`（本行是讲语法，非断言）\n');
    const r = run(T);
    check('检查16:转义 \\{{...}} 的行为示意 → 不报（区分「讲语法」与「真断言」）',
      r.status === 0 && !outOf(r).includes('指标'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【守卫】check-loop 自身可加载（防语法错致整条门禁静默失效）
    // 实证教训：本次实现期把 `continue` 误用在 forEach 回调内 → 模块 SyntaxError →
    // check-loop 崩溃退出，而「指标告警 0 条」看起来像通过。**假绿比红更危险**，故钉死。
    const r = run(mkfix());
    check('检查16:check-loop 可正常加载运行（防语法错致门禁静默失效——假绿比红危险）',
      r.status === 0 && !/SyntaxError|Illegal continue/.test(outOf(r)), `exit=${r.status}\n${outOf(r)}`);
  }
  {
    // 【fail-loud】登记了指标但无取数器 → 明示「登记了却没查」（防假阴性：登记表写了却不实现）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC + 'ghost.metric = ghost.metric\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, 'workflow/plans/p5.md', PLAN('p5', '状态: draft\n级别: L1'));
    const r = run(T);
    check('检查16:登记无取数器 → fail-loud（登记了却没实现＝其实没查）',
      outOf(r).includes('无对应取数器'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【退化语义】登记表不存在 → 静默跳过（未启用该检查的装户不应被噪声打扰）
    const T = mkfix();
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, 'workflow/plans/p6.md', PLAN('p6', '状态: draft\n级别: L1', '\n台账共 {{ledger.lines}} 行\n'));
    const r = run(T);
    check('检查16:登记表缺失 → 静默跳过（不误报，未启用装户零噪声）',
      r.status === 0 && !outOf(r).includes('指标'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【活跃态尺度】终态文档不扫（沿检查 4 现有尺度：历史数字是历史叙述）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    // 终态件（plan done + 同名 intent，数字前缀使其确在 docFiles 扫描面内——断言才针对「终态豁免」而非「无前缀豁免」）
    w(T, 'workflow/intents/2026-09-01-p7.md', INTENT('p7', '状态: draft\n级别: L1'));
    w(T, 'workflow/plans/2026-09-01-p7.md', PLAN('p7', '状态: done\n级别: L1', '\n台账共 {{ledger.lines}} 行\n'));
    const r = run(T);
    check('检查16:终态文档不扫（历史叙述豁免，沿检查 4 尺度）',
      r.status === 0 && !outOf(r).includes('指标待回填'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【取数正确性】docs.count.plans 应计活跃+终态全部 plans（排除 _TEMPLATE）
    // 注：取数器与 docFiles() 同口径——须**以数字开头**（命名规范强制 `YYYY-MM-DD-` 前缀），
    // 故 fixture 文件名必须合规（首版用 a.md/b.md 使取数为 0，暴露的是用例不合规而非判据错）。
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'docs.count.plans = docs.count.plans\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, 'workflow/plans/2026-09-01-a.md', PLAN('a', '状态: draft\n级别: L1'));
    w(T, 'workflow/plans/2026-09-02-b.md', PLAN('b', '状态: done\n级别: L1'));
    w(T, 'workflow/plans/_TEMPLATE.md', PLAN('t', '状态: draft\n级别: L1'));
    w(T, 'workflow/plans/2026-09-03-c.md', PLAN('c', '状态: draft\n级别: L1', '\n共 {{docs.count.plans}} 份\n'));
    const r = run(T);
    check('检查16:取数正确——docs.count.plans 计 3 份（排除 _TEMPLATE，含终态）',
      outOf(r).includes('实时值 = 3'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P1 回归】转义按「逐个出现」而非整行——同一行的真签名不得被转义位藏住
    // 复核实证：首版「行内任一 `\{{` 即整行跳过」可被这样绕过：
    //   `… \{{a.b}} 示意… {{ledger.lines}} 未回填` → 整行静默放过（0 告警）。
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan16(T, 'p9', '\n讲语法 \\{{a.b}} 示意，但本行也有真断言 {{ledger.lines}} 未回填\n');
    const r = run(T);
    check('检查16:同行「转义示意 + 真未回填」→ 真签名仍报（转义按逐个出现，不按整行）',
      outOf(r).includes('指标待回填'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P2 回归】形态不符的签名不得静默漏过（首版只认严格小写点分 → 笔误零告警）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan16(T, 'p10', '\n引用 {{Ledger.Lines}} 笔误\n');
    const r = run(T);
    check('检查16:形态不符（大写点分笔误）→ 出账「指标形态」（不静默漏过）',
      outOf(r).includes('指标形态'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P2 回归】形态检查不得误伤装户模板占位符（全大写 SCREAMING_CASE 仍豁免）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    const S = (n) => '{{' + n + '}}';
    w(T, 'workflow/plans/p11.md', PLAN('p11', '状态: draft\n级别: L1',
      '\n模板 ' + S('BUILD_CMD') + ' 与 ' + S('BOARD_PORT') + '\n'));
    const r = run(T);
    check('检查16:形态检查不误伤装户模板占位符（全大写仍豁免）',
      r.status === 0 && !outOf(r).includes('指标'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
});

// ---- 场景 80-90:检查 16 装户侧 derivers 动态载入（2026-09-28 adopter-derivers）----
// 本组核心是**三条假绿防线**：装户模块坏掉时必须响亮出账，绝不静默降级成「只用内置指标」。
// 对照：模块**缺失**是正常态（零告警）——两组行为必须可区分，否则装户无法判断自己错在哪。
SCEN(async () => {
  const MC2 = 'ledger.lines = ledger.lines\nmy.custom = my.custom\n';
  const MCB = 'ledger.lines = ledger.lines\ndocs.count.plans = docs.count.plans\n'; // 仅内置指标
  const seedLedger = (T, lines) => w(T, '.agents/confirmations.jsonl', lines.join('\n') + '\n');
  const activePlan = (T, name, body) => {
    // 同时写同名 intent：否则「配对断裂」hard-block 会干扰本组断言（本组只测取数器分层）
    w(T, `workflow/intents/2026-09-01-${name}.md`, INTENT(name, '状态: draft\n级别: L1'));
    w(T, `workflow/plans/2026-09-01-${name}.md`, PLAN(name, '状态: draft\n级别: L1', body));
  };
  {
    // 【正向】装户模块存在 + 自定义指标 → 取数正确
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC2);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'my.custom': () => 7  } };\n");
    activePlan(T, 'ok', '\n值 {{my.custom}}\n');
    const r = run(T);
    check('检查16装户:模块存在 + 自定义指标 → 实时值 = 7（取数正确）',
      outOf(r).includes('my.custom') && outOf(r).includes('实时值 = 7'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【假绿防线 ①】模块语法错 → 响亮出账 + check-loop 仍正常退出（不崩）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC2);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'my.custom': () => { \n"); // 故意不闭合
    activePlan(T, 'syn', '\n值 {{my.custom}}\n');
    const r = run(T);
    const o = outOf(r);
    // 断言必须用**唯一的 warning 前缀**匹配——「装户取数器载入失败」这串字也出现在
    // 「无对应取数器」那条的提示语里（「见上方「…载入失败」条目」），只用它匹配会**在真实条目
    // 消失时仍然通过**（变异自验实测：静默吞掉 emit 行后该断言不翻红）。故用 `- [WARN 装户取数器载入失败]`。
    check('检查16装户:模块语法错 → 响亮出账「装户取数器载入失败」（独立成条，明示文件）',
      o.includes('- [WARN 装户取数器载入失败]') && o.includes('metric-derivers.cjs') && !o.includes('未登记该指标'),
      `exit=${r.status}\n${o}`);
    check('检查16装户:模块语法错 → 引擎自身不因装户代码崩溃（无裸 SyntaxError 崩栈）',
      r.status === 0 && !/Illegal|at ModuleLoader|at compileSourceTextModule/.test(o),
      `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【假绿防线 ②】取数器抛异常 → 响亮出账（明示错误）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC2);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'my.custom': () => { throw new Error('boom-xyz'); } }  };\n");
    activePlan(T, 'thr', '\n值 {{my.custom}}\n');
    const r = run(T);
    check('检查16装户:取数器抛异常 → 响亮出账且明示错误',
      outOf(r).includes('指标取数失败') && outOf(r).includes('boom-xyz'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【假绿防线 ③】返回非有限数字（字符串 / NaN / Promise）→ 拦下并明示类型
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'my.str = my.str\nmy.nan = my.nan\nmy.prom = my.prom\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', [
      "module.exports = { derivers: {",
      "  'my.str': () => 'not-a-number',",
      "  'my.nan': () => NaN,",
      "  'my.prom': () => Promise.resolve(1),",
      "} };",
      '',
    ].join('\n'));
    activePlan(T, 'types', '\n{{my.str}} {{my.nan}} {{my.prom}}\n');
    const r = run(T);
    const o = outOf(r);
    check('检查16装户:返回字符串 → 取数失败（明示类型 string）',
      o.includes('不是有限数字') && o.includes('string'), `exit=${r.status}\n${o}`);
    check('检查16装户:返回 NaN → 取数失败', o.includes('number（NaN）'), `exit=${r.status}\n${o}`);
    check('检查16装户:返回 Promise（误写 async）→ 取数失败并提示须同步',
      o.includes('Promise') && o.includes('同步'), `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【区分性】模块缺失 → 零告警（与「模块坏」必须行为可区分）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MCB);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    activePlan(T, 'none', '');
    const r = run(T);
    check('检查16装户:模块缺失 → 零告警（正常态，与「模块坏」可区分）',
      r.status === 0 && !outOf(r).includes('指标'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【优先级】装户定义内置同名 → 内置生效 + advisory 明示被忽略
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'ledger.lines = ledger.lines\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}', '{"doc":"b","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'ledger.lines': () => 999  } };\n");
    activePlan(T, 'prio', '\n台账 {{ledger.lines}}\n');
    const r = run(T);
    const o = outOf(r);
    check('检查16装户:内置同名 → 内置值生效（2，非装户的 999）',
      o.includes('实时值 = 2'), `exit=${r.status}\n${o}`);
    check('检查16装户:内置同名 → advisory 明示装户定义被忽略',
      o.includes('被忽略'), `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【未导出】模块存在但无 derivers 导出 → fail-loud
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC2);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = {};\n");
    activePlan(T, 'noexp', '\n{{my.custom}}\n');
    const r = run(T);
    check('检查16装户:模块无 derivers 导出 → 响亮出账「载入失败」（独立成条，不静默）',
      outOf(r).includes('- [WARN 装户取数器载入失败]') && outOf(r).includes('未导出'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【旧路径迁移提示】残留首版 .mjs 文件时，须明示「已改用 .cjs」——
    // 否则装户对着「无取数器」查不出所以然（跨版本实测：require(esm) 在 Node 18/22 不可用，
    // 故首版 .mjs 契约在 CI 目标版本上根本不工作，必须给出可操作的迁移指引）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MC2);
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.mjs', "export const derivers = { 'my.custom': () => 7 };\n"); // 旧路径
    activePlan(T, 'legacy', '\n{{my.custom}}\n');
    const r = run(T);
    const o = outOf(r);
    check('检查16装户:残留旧 .mjs → 明示「已改用 .cjs」并给出 CJS 写法',
      o.includes('装户取数器载入失败') && o.includes('metric-derivers.mjs') && o.includes('.cjs') && o.includes('module.exports'),
      `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【未登记指标仍走原路】装户定义了函数但没在 registry 登记 → 报「未登记」
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'ledger.lines = ledger.lines\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'my.custom': () => 7  } };\n");
    activePlan(T, 'unreg', '\n{{my.custom}}\n');
    const r = run(T);
    check('检查16装户:函数有但 registry 未登记 → 报「未登记」（两处都要）',
      outOf(r).includes('指标未登记'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【ctx 能力】glob / read 取数正确
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'my.sql = my.sql\nmy.read = my.read\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    fs.mkdirSync(path.join(T, 'backend', 'migrations'), { recursive: true }); // w() 不建父目录
    w(T, 'backend/migrations/001.sql', 'x');
    w(T, 'backend/migrations/002.sql', 'x');
    w(T, 'backend/other.txt', 'x');
    w(T, '.agents/metric-derivers.cjs', [
      "module.exports = { derivers: {",
      "  'my.sql': (ctx) => ctx.glob('backend/migrations/*.sql').length,",
      "  'my.read': (ctx) => ctx.read('backend/migrations/001.sql').length,",
      "} };",
      '',
    ].join('\n'));
    activePlan(T, 'ctx', '\n{{my.sql}} {{my.read}}\n');
    const r = run(T);
    const o = outOf(r);
    check('检查16装户:ctx.glob 计数正确（2 个 sql）', o.includes('my.sql') && o.includes('实时值 = 2'), `exit=${r.status}\n${o}`);
    check('检查16装户:ctx.read 读取正确（内容 1 字符）', o.includes('my.read') && o.includes('实时值 = 1'), `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【存量零差异】无装户模块时，内置指标行为与改前一致
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MCB);
    seedLedger(T, ['{"doc":"a","stage":"done"}', '{"doc":"b","stage":"done"}']);
    activePlan(T, 'base', '\n台账 {{ledger.lines}}；plans {{docs.count.plans}}\n');
    const r = run(T);
    check('检查16装户:无模块时内置指标照常取数（零差异）',
      outOf(r).includes('实时值 = 2') && outOf(r).includes('实时值 = 1'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【ctx.glob 语义】自查修正回归：`**/` 须含零层、可跨段；`*` 不跨 `/`
    // （首版实现用「先转义后 replace 星号」，实测 `src/**/*.ts` 匹配不到 `src/a/b/c.ts`）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'g.deep = g.deep\ng.flat = g.flat\ng.skip = g.skip\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    fs.mkdirSync(path.join(T, 'src', 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(T, 'src', 'nested'), { recursive: true });
    w(T, 'src/a/b/c.ts', 'x');
    w(T, 'src/top.ts', 'x');
    w(T, 'src/nested/deep.ts', 'x');
    fs.mkdirSync(path.join(T, 'node_modules', 'pkg'), { recursive: true });
    w(T, 'node_modules/pkg/dep.ts', 'x');
    w(T, '.agents/metric-derivers.cjs', [
      "module.exports = { derivers: {",
      "  'g.deep': (ctx) => ctx.glob('src/**/*.ts').length,",
      "  'g.flat': (ctx) => ctx.glob('src/*.ts').length,",
      "  'g.skip': (ctx) => ctx.glob('**/*.ts').length,",
      "} };",
      '',
    ].join('\n'));
    activePlan(T, 'glob', '\n{{g.deep}} {{g.flat}} {{g.skip}}\n');
    const r = run(T);
    const o = outOf(r);
    check('检查16装户:ctx.glob 的 `**/` 含零层且跨段（src/**/*.ts 计 3）',
      o.includes('g.deep') && o.includes('实时值 = 3'), `exit=${r.status}\n${o}`);
    check('检查16装户:ctx.glob 的 `*` 不跨 /（src/*.ts 计 1）',
      o.includes('g.flat') && o.includes('实时值 = 1'), `exit=${r.status}\n${o}`);
    check('检查16装户:ctx.glob 剪枝 node_modules（**/*.ts 计 3，非 4）',
      o.includes('g.skip') && o.includes('实时值 = 3'), `exit=${r.status}\n${o}`);
    rmfix(T);
  }
  {
    // 【ctx.glob 字面转义】点号须为字面（首版漏转义会误匹配）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'g.lit = g.lit\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, 'a.b.sql', 'x');
    w(T, 'axb.sql', 'x');
    w(T, '.agents/metric-derivers.cjs',
      "module.exports = { derivers: { 'g.lit': (ctx) => ctx.glob('a.b.sql').length  } };\n");
    activePlan(T, 'lit', '\n{{g.lit}}\n');
    const r = run(T);
    check('检查16装户:ctx.glob 点号按字面（a.b.sql 计 1，不含 axb.sql）',
      outOf(r).includes('实时值 = 1'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P2 回归】模块坏但**没有任何装户指标**时，不得平白出账
    // （首版无条件报「载入失败」——半成品模块会给清白的装户增加不可消除的噪声）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', MCB); // 只有内置指标
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'x.y': () => { \n"); // 坏模块
    activePlan(T, 'noise', '');
    const r = run(T);
    check('检查16装户:坏模块 + 无装户指标 → 不出账（无判定依据不产噪声）',
      r.status === 0 && !outOf(r).includes('装户取数器载入失败'), `exit=${r.status}\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P2 回归】内置同名 advisory 按**指标**去重（首版按 registry 行重复出账）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'ledger.lines = ledger.lines\nledger.lines = ledger.lines\nledger.lines = ledger.lines\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    w(T, '.agents/metric-derivers.cjs', "module.exports = { derivers: { 'ledger.lines': () => 999  } };\n");
    activePlan(T, 'dedup', '\n台账 {{ledger.lines}}\n');
    const r = run(T);
    const n = (outOf(r).match(/被忽略/g) || []).length;
    check('检查16装户:内置同名 advisory 按指标去重（3 行登记 → 恰 1 条）', n === 1, `实际 ${n} 条\n${outOf(r)}`);
    rmfix(T);
  }
  {
    // 【复核 P2 回归】软链接成环 → 不得无界递归（复核实测首版 depth 128、同文件重复 64 份）
    const T = mkfix();
    w(T, '.agents/metric-claims.txt', 'g.loop = g.loop\n');
    seedLedger(T, ['{"doc":"a","stage":"done"}']);
    fs.mkdirSync(path.join(T, 'loopdir', 'inner'), { recursive: true });
    w(T, 'loopdir/inner/f.txt', 'x');
    // 用 **dir 型 symlink**（POSIX 语义的目录软链接），而非 junction（Windows 特有、不具代表性）。
    // 用户 2026-09-28 追问「这里用到 sh 了吗」促使追验：防环走 fs.realpathSync（Node 原生跨平台），
    // **与 sh 无关**——故本断言在两种链接语义下都应成立。
    let linked = false;
    try {
      fs.symlinkSync(path.join(T, 'loopdir'), path.join(T, 'loopdir', 'inner', 'back'), 'dir');
      linked = true;
    } catch { /* 无建链接权限（未开开发者模式）→ 跳过该断言 */ }
    w(T, '.agents/metric-derivers.cjs',
      "module.exports = { derivers: { 'g.loop': (ctx) => ctx.glob('loopdir/**/*.txt').length  } };\n");
    activePlan(T, 'loop', '\n{{g.loop}}\n');
    const r = run(T);
    const o16 = outOf(r);
    check(linked
      // 防环生效 ⇒ 计数为 1（只有 inner/f.txt）；无防环会沿环重复到 64
      ? '检查16装户:dir 型 symlink 成环（POSIX 语义）→ 防环生效，计数恰 1'
      : '检查16装户:软链接成环用例跳过（本机无建链接权限）',
      linked ? o16.includes('实时值 = 1') : true, `exit=${r.status}\n${o16}`);
    rmfix(T);
  }
  {
    // 【归属契约】装户取数模块必须归 owned——否则落回 managed，重演本单要修的缺陷本身
    // （sync 永久报「本地已改」+ doctor WARN + check-loop 因供应链防线静默停摆）
    //
    // **本用例不得依赖包源 `src/`**（复核 P1 更正）：首版写 `await import('../../../src/profiles.mjs')`，
    // 该路径在**本仓**解析到 `<repo>/src/`（存在），但在**装户安装**里 `.agents/scripts/` 只往上三层
    // 即 `<install>/../src/`——不存在 → `ERR_MODULE_NOT_FOUND` → **整个套件崩掉**。而本测试文件是
    // managed/shipped，故每个装户拿到的测试套件都是坏的；`npm test` 又只跑 `templates/` 副本
    // （见 src/run-tests.mjs），所以 CI 看不见。修法：优先动态 import，失败则**降级为读源码断言**
    // （isOwned 的判定是纯字面量列表，读源即可判，且包源/装副本都在同一路径下）。
    let isOwned = null;
    try {
      ({ isOwned } = await import('../../../src/profiles.mjs'));
    } catch { /* 装户环境无包源 src/ → 走下面的降级断言 */ }
    if (typeof isOwned === 'function') {
      check('检查16装户:isOwned(.agents/metric-derivers.cjs) 为真（与登记表同归 owned）',
        isOwned('.agents/metric-derivers.cjs') === true);
      check('检查16装户:isOwned(.agents/metric-claims.txt) 仍为真（未被本单破坏）',
        isOwned('.agents/metric-claims.txt') === true);
      check('检查16装户:check-loop.mjs 仍归 managed（引擎不被误划入 owned）',
        isOwned('.agents/scripts/check-loop.mjs') === false);
    } else {
      // **装户环境降级断言**（复核 P1 更正）：装户没有包源 `src/profiles.mjs`，故改验**可观测事实**——
      // 若 `metric-derivers.cjs` 已存在于盘上，它必须**不**记在引擎配置的 managed 侧（在 managed 即为错，
      // 那正是本单要修的缺陷形态）。未安装该模块时跳过（无判定依据的行不产出噪声）。
      // managed/owned 台账随 2026-10-08 decouple-flow-kit 退役，此处恒为空集（兼容保留）。
      // 路径：本文件在 `<root>/.agents/scripts/`，故引擎配置在 `../config/engine.json`（= `<root>/.agents/config/engine.json`）。
      let verdict = null;
      let detail = '';
      try {
        const kit = JSON.parse(fs.readFileSync(new URL('../config/engine.json', import.meta.url), 'utf8'));
        const rel = '.agents/metric-derivers.cjs';
        const inManaged = (kit.managed || []).some((f) => f.rel === rel);
        const inOwned = (kit.owned || []).some((f) => f.rel === rel);
        verdict = !inManaged;
        detail = `managed=${inManaged} owned=${inOwned}`;
      } catch (e) {
        verdict = null; detail = String(e.message).slice(0, 60);
      }
      if (verdict === null) {
        check('检查16装户:装户环境无法判定归属（无 engine.json）→ 跳过（不产噪声）', true);
      } else {
        check('检查16装户:装户环境——metric-derivers.cjs 不在 managed 侧（不在即正确）',
          verdict === true, detail);
      }
    }
  }
});

// ---- 场景 91:检查 16 tracked-only 口径双向（2026-09-28 check16-inline-debt T2）----
// scanFiles16 与取数器统一走 docFiles（.md ∧ 数字前缀 ∧ tracked）：并行会话的未跟踪半成品即便含
// 未回填签名也不进扫描面（别人的草稿不拦我的 push，沿检查 1-15 仓库模式「只扫已提交(HEAD)」口径）；
// 提交进 HEAD 后照常出账。跑法沿场景 23/24 先例（{git:true} + cwd 注入真 git 模式）。
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, '.agents/metric-claims.txt', 'ledger.lines = ledger.lines\n');
  w(T, '.agents/confirmations.jsonl', '{"doc":"a","stage":"done"}\n');
  w(T, 'workflow/intents/2026-09-12-base16.md', INTENT('base16', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-base16.md', PLAN('base16', '状态: done\n级别: L1'));
  gitCommitAll(T, 'base');
  // 未跟踪半成品：留签名未回填 → 不出账（tracked-only：不进扫描面）
  w(T, 'workflow/intents/2026-09-28-wip16.md', INTENT('wip16', '状态: draft\n级别: L1\n日期: 2026-09-28'));
  w(T, 'workflow/plans/2026-09-28-wip16.md', PLAN('wip16', '状态: draft\n级别: L1', '\n台账共 {{ledger.lines}} 行\n'));
  // 根级 workflow/*.md 同口径钉住（2026-09-29 复核 P2-1：根级 tracked 过滤曾无测试承重——变异去除后全绿）
  w(T, 'workflow/root-wip16.md', '---\n状态: draft\n级别: L1\n日期: 2026-09-28\n---\n# ROOT-WIP16\n\n根级草稿台账 {{ledger.lines}} 行\n');
  let r = run(T, { git: true });
  check('检查16 tracked-only:未跟踪档含未回填签名 → 不出账（并行半成品不进扫描面；含根级）',
    r.status === 0 && !outOf(r).includes('指标待回填') && !outOf(r).includes('wip16') && !outOf(r).includes('root-wip16'),
    `exit=${r.status}\n${outOf(r)}`);
  gitCommitAll(T, 'wip');
  r = run(T, { git: true });
  check('检查16 tracked-only:提交进 HEAD 后 → 照常出账（WARN 指标待回填；含根级）',
    r.status === 0 && outOf(r).includes('指标待回填') && outOf(r).includes('wip16') && outOf(r).includes('root-wip16'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- audit 档：false 只留阻断；缺省仍出卫生警告 ----
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"audit":false,"policyVersion":1}\n');
  w(T, 'workflow/intents/2026-09-12-ph.md', INTENT('ph', '状态: draft\n级别: L1\n日期: YYYY-MM-DD'));
  w(T, 'workflow/plans/2026-09-12-ph.md', PLAN('ph', '状态: draft\n级别: L1'));
  const r = run(T);
  check('audit false：占位符不出账且 exit 0', r.status === 0 && !outOf(r).includes('模板未填'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"audit":false,"policyVersion":1}\n');
  w(T, 'workflow/intents/2026-09-12-np.md', INTENT('np', '状态: approved\n级别: L1\n日期: 2026-09-12'));
  // 第 1 批降档（2026-10-21）：缺 plan 由 blocker 降 WARN——audit:false 静默 WARN 后不再阻断
  expectOk('audit false：缺 plan 降 WARN 被 audit 静默 → exit 0（第 1 批降档）', T);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-ph2.md', INTENT('ph2', '状态: draft\n级别: L1\n日期: YYYY-MM-DD'));
  w(T, 'workflow/plans/2026-09-12-ph2.md', PLAN('ph2', '状态: draft\n级别: L1'));
  const r = run(T);
  check('audit 缺省：占位符仍警告', r.status === 0 && outOf(r).includes('模板未填'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// （检查 17 发版未收口场景随段体退役删除——2026-10-21 门禁极小化第 1 批，机制台账有档）

// ---- 检查 18：委派台账对账 [warning]，退出码仍为 0 ----
SCEN(async () => {
  const T = mkfix();
  const gap = '2026-09-12-gap.md';
  w(T, `workflow/intents/${gap}`, INTENT('gap', '状态: done\n级别: L2\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, `workflow/specs/${gap}`, SPEC('gap', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, `workflow/plans/${gap}`, PLAN('gap', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/intents/2026-09-12-low.md', INTENT('low', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-low.md', PLAN('low', '状态: done\n级别: L1\n日期: 2026-09-12'));
  w(T, 'workflow/intents/2026-09-12-stay.md', INTENT('stay', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/specs/2026-09-12-stay.md', SPEC('stay', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-stay.md', PLAN('stay', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  const ledgerOf = (r) => outOf(r).split('\n').filter((l) => l.includes('委派台账'));
  let r = run(T);
  let lines = ledgerOf(r);
  check('检查18 委派表不存在：L2 done 警告且 exit 0；L1 done 与 L2 approved 不警告',
    r.status === 0
      && lines.some((l) => l.includes(`intents/${gap}`) && l.includes('2026-09-12'))
      && lines.every((l) => !l.includes('low.md') && !l.includes('stay.md')),
    `exit=${r.status}\n${outOf(r)}`);

  const head = '## 委派结果\n\n| 日期 | 被委派方 | 任务一句话 | 结果 | 备注 |\n|------|----------|------------|------|------|\n';
  w(T, 'workflow/delegations.md', `${head}| 2026-09-11 | x | y | 一次通过 | ${gap} |\n`);
  r = run(T);
  check('检查18 行日期早于文档日期：警告仍在',
    r.status === 0 && ledgerOf(r).some((l) => l.includes(`intents/${gap}`)),
    `exit=${r.status}\n${outOf(r)}`);

  w(T, 'workflow/delegations.md', `${head}| 2026-09-12 | x | y | 一次通过 | 2026-09-12-gap |\n`);
  r = run(T);
  check('检查18 去掉扩展名的主题名也命中：警告消失',
    r.status === 0 && !ledgerOf(r).some((l) => l.includes(`intents/${gap}`)),
    `exit=${r.status}\n${outOf(r)}`);

  w(T, 'workflow/delegations.md', `${head}\n## 自做任务结果\n\n| 日期 | 任务一句话 | 结果 | 备注 |\n|------|------------|------|------|\n| 2026-09-12 | x | 一次通过 | ${gap} |\n`);
  r = run(T);
  check('检查18 文件名在自做任务结果表：警告消失',
    r.status === 0 && !ledgerOf(r).some((l) => l.includes(`intents/${gap}`)),
    `exit=${r.status}\n${outOf(r)}`);

  // 补缺（2026-09-30 F2）：自做表行**不带 .md**（台账自做表实际通写形态）——此前矩阵只覆盖三格：
  // 委派表带/不带 .md、自做表带 .md 均有例，唯独「自做表 + 不带 .md」从未穿越（夹具 gap 恒带 .md，
  // 走的是 includes(base) 分支）。本用例专走 includes(stripped) 分支，矩阵补成 4/4。
  w(T, 'workflow/delegations.md', `${head}\n## 自做任务结果\n\n| 日期 | 任务一句话 | 结果 | 备注 |\n|------|------------|------|------|\n| 2026-09-12 | x | 一次通过 | 2026-09-12-gap |\n`);
  r = run(T);
  check('检查18 自做表行不带 .md（台账实际通写形态）：警告消失',
    r.status === 0 && !ledgerOf(r).some((l) => l.includes(`intents/${gap}`)),
    `exit=${r.status}\n${outOf(r)}`);

  w(T, 'workflow/delegations.md', `${head}| 2026-09-12 | x | y | 一次通过 | ${gap} |\n`);
  r = run(T);
  lines = ledgerOf(r);
  check('检查18 补上不早于文档日期且含文件名的一行：该警告消失',
    r.status === 0 && !lines.some((l) => l.includes(gap)),
    `exit=${r.status}\n${outOf(r)}`);

  // 文件名仅出现在非台账节（既非委派结果也非自做任务结果）：不命中
  w(T, 'workflow/delegations.md', `${head}| 2026-09-12 | x | y | 一次通过 | 其他任务 |\n\n## 历史记录\n| ${gap} 已关单 |\n`);
  r = run(T);
  check('检查18 文件名仅出现在非台账节：警告仍在',
    r.status === 0 && ledgerOf(r).some((l) => l.includes(`intents/${gap}`)),
    `exit=${r.status}\n${outOf(r)}`);

  // 修复族豁免（2026-10-21 止血批）：incident 面与同名 spec/plan 退出对账——台账记法明文
  // 「修复类不记（自做表）」，自做修复无行=合法；intent 领头族（无论有无同名 incident）照查。
  const fixfam = '2026-09-12-fixfam.md';
  w(T, `workflow/incidents/${fixfam}`, `---\n状态: closed\n级别: L2\n发现: 2026-09-12\n---\n# fixfam\n`);
  w(T, `workflow/specs/${fixfam}`, SPEC('fixfam', '状态: done\n级别: L2\n日期: 2026-09-12'));
  w(T, `workflow/plans/${fixfam}`, PLAN('fixfam', '状态: done\n级别: L2\n日期: 2026-09-12'));
  r = run(T);
  lines = ledgerOf(r);
  check('检查18 修复族豁免：incident 与同名 spec/plan 无台账行不警告',
    r.status === 0 && lines.every((l) => !l.includes('fixfam')),
    `exit=${r.status}\n${outOf(r)}`);
  check('检查18 修复族豁免不影响 intent 领头族：gap 警告仍在',
    r.status === 0 && lines.some((l) => l.includes(`intents/${gap}`)),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  // 检查 18 delegationSince 生效日豁免（policy v4，2026-10-06 loop-audit-remediation）。
  // 「缺键回退原行为」由上方既有场景群天然覆盖（fixture 不写 engine.json → loadKitPolicy 回退 v1 无该键）。
  const T = mkfix();
  const pre = '2026-09-12-pre.md';
  w(T, '.agents/config/engine.json', '{"policyVersion":4}\n');
  w(T, `workflow/intents/${pre}`, INTENT('pre', '状态: done\n级别: L2\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, `workflow/specs/${pre}`, SPEC('pre', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, `workflow/plans/${pre}`, PLAN('pre', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  let r = run(T);
  check('检查18 v4：文档日期早于 delegationSince → 存量豁免不出账（同面在 v1 下照报，见上方首场景）',
    r.status === 0 && !outOf(r).includes('委派台账'),
    `exit=${r.status}\n${outOf(r)}`);

  const post = '2026-10-06-post.md';
  w(T, `workflow/intents/${post}`, INTENT('post', '状态: done\n级别: L2\n日期: 2026-10-06', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, `workflow/specs/${post}`, SPEC('post', '状态: approved\n级别: L2\n日期: 2026-10-06'));
  w(T, `workflow/plans/${post}`, PLAN('post', '状态: approved\n级别: L2\n日期: 2026-10-06'));
  r = run(T);
  // post 日期 ≥ 确认门生效日（v4 confirmDocsEffective=2026-10-06）且无台账行 → 检查 15 hard 同场出账（预期）；
  // 本场景只断言检查 18 对受管日期照报——豁免通道不得吞掉生效日后的真漏点。
  check('检查18 v4：文档日期 ≥ delegationSince 且台账无文件名 → 照报（exit 1 属检查15 同场，非本检查升级）',
    r.status === 1 && outOf(r).includes('确认未对账')
      && outOf(r).split('\n').some((l) => l.includes('委派台账') && l.includes(`intents/${post}`)),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  const body = 三件套(false);
  w(T, 'workflow/incidents/2026-09-12-closed.md', `---\n状态: closed\n级别: L2\n发现: 2026-09-12\n---\n# INCIDENT — closed\n\n${body}`);
  w(T, 'workflow/specs/2026-09-12-closed.md', SPEC('closed', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-closed.md', PLAN('closed', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/incidents/2026-09-12-l1c.md', `---\n状态: closed\n级别: L1\n发现: 2026-09-12\n---\n# INCIDENT — l1c\n\n${body}`);
  w(T, 'workflow/plans/2026-09-12-l1c.md', PLAN('l1c', '状态: approved\n级别: L1\n日期: 2026-09-12'));
  w(T, 'workflow/incidents/2026-09-12-open.md', `---\n状态: open\n级别: L2\n发现: 2026-09-12\n---\n# INCIDENT — open\n\n${body}`);
  w(T, 'workflow/specs/2026-09-12-open.md', SPEC('open', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-open.md', PLAN('open', '状态: approved\n级别: L2\n日期: 2026-09-12'));
  const r = run(T);
  const lines = outOf(r).split('\n').filter((l) => l.includes('委派台账'));
  // 2026-10-21 止血批起 incident 面整体退出对账（修复族豁免，对齐台账记法「修复类不记（自做）」）
  // ——closed incident 不再产委派台账 WARN（同名 spec/plan 伴生件同豁免）；见下方修复族豁免场景。
  check('检查18 incident 面退出对账（修复族豁免）：L2 closed 亦不出委派台账 WARN',
    r.status === 0 && lines.length === 0,
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  // 检查18 日期口径（2026-10-27 修）：缺 frontmatter「日期」→ 回落文件名前缀（沿检查 15 / 19 口径）。
  // 旧判据「缺日期即整段跳过」使本门对绝大多数 L2/L3 plan 静默失效（plan 无日期字段是常态）。
  w(T, 'workflow/intents/2026-09-12-nodate.md', INTENT('nodate', '状态: done\n级别: L2'));
  w(T, 'workflow/specs/2026-09-12-nodate.md', SPEC('nodate', '状态: approved\n级别: L2'));
  w(T, 'workflow/plans/2026-09-12-nodate.md', PLAN('nodate', '状态: approved\n级别: L2'));
  const r = run(T);
  check('检查18 缺日期回落文件名日期：门适用（出委派台账 WARN，不再静默跳过）',
    r.status === 0 && outOf(r).includes('委派台账'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  // 日期不可判定（frontmatter 与文件名皆无日期）→ 跳过，不误报
  w(T, 'workflow/intents/nodate-x.md', INTENT('nodate-x', '状态: done\n级别: L2'));
  const r = run(T);
  check('检查18 日期不可判定（frontmatter 与文件名皆无日期）：跳过不警告',
    r.status === 0 && !outOf(r).includes('委派台账'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"audit":false,"policyVersion":1}\n');
  w(T, 'workflow/intents/2026-09-12-quiet.md', INTENT('quiet', '状态: done\n级别: L2\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/specs/2026-09-12-quiet.md', SPEC('quiet', '状态: done\n级别: L2\n日期: 2026-09-12'));
  w(T, 'workflow/plans/2026-09-12-quiet.md', PLAN('quiet', '状态: done\n级别: L2\n日期: 2026-09-12'));
  const r = run(T);
  check('检查18 audit false：委派台账不输出且 exit 0',
    r.status === 0 && !outOf(r).includes('委派台账'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 19：逐阶段审计 [warning]（2026-09-30 stage-gate-machine）----
SCEN(async () => {
  // 判据 A：spec/plan 为 draft 且日期 ≥ stageGateSince，入口未确认 → 告警（spec 与 plan 各一条）
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  w(T, 'workflow/intents/2026-09-30-pair.md', INTENT('pair', '状态: draft\n级别: L2\n日期: 2026-09-30\n模块: pipeline'));
  w(T, 'workflow/specs/2026-09-30-pair.md', SPEC('pair', '状态: draft\n级别: L2\n日期: 2026-09-30\n模块: pipeline'));
  w(T, 'workflow/plans/2026-09-30-pair.md', PLAN('pair', '状态: draft\n级别: L2\n模块: pipeline'));
  const r = run(T);
  const lines = outOf(r).split('\n').filter((l) => l.includes('逐阶段'));
  check('检查19-A 入口未确认：spec 出「起草先于入口确认」、plan 同步告警，exit 0',
    r.status === 0
      && lines.some((l) => l.includes('specs/2026-09-30-pair.md') && l.includes('起草先于入口确认'))
      && lines.some((l) => l.includes('plans/2026-09-30-pair.md')),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  // 判据 A 日期门：draft 日期早于 stageGateSince → 静默（历史豁免）
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  w(T, 'workflow/intents/2026-09-20-old.md', INTENT('old', '状态: draft\n级别: L1\n日期: 2026-09-20'));
  w(T, 'workflow/plans/2026-09-20-old.md', PLAN('old', '状态: draft\n级别: L1'));
  const r = run(T);
  check('检查19-A 日期门：早于 stageGateSince 的 draft → 零逐阶段告警',
    r.status === 0 && !outOf(r).includes('逐阶段'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  // 判据 A 放行侧：入口已确认（台账行 + 指纹配对）→ plan draft 静默（L1 免 spec 档）
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  const fp = 'a'.repeat(64);
  w(T, 'workflow/intents/2026-09-30-ok.md', INTENT('ok', `状态: approved\n级别: L1\n日期: 2026-09-30\n确认指纹: ${fp.slice(0, 16)}`));
  w(T, 'workflow/plans/2026-09-30-ok.md', PLAN('ok', '状态: draft\n级别: L1'));
  w(T, '.agents/confirmations.jsonl', JSON.stringify({ ts: '2026-09-30T01:00:00.000Z', doc: 'workflow/intents/2026-09-30-ok.md', stage: 'approved', fingerprint: fp, prev: 'draft', source: 'chat-delegated', batch: 't1', seq: 1, of: 1 }) + '\n');
  const r = run(T);
  check('检查19-A 放行侧：入口 approved + 台账行 → plan draft 静默（L1）',
    r.status === 0 && !outOf(r).includes('逐阶段'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  // 判据 B：台账顺序倒置（spec 早于 intent）→ 告警；行无对应文件也可判（读台账事实）
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  const row = (doc, ts) => JSON.stringify({ ts, doc, stage: 'approved', fingerprint: 'b'.repeat(64), prev: 'draft' }) + '\n';
  w(T, '.agents/confirmations.jsonl',
    row('workflow/intents/2026-09-29-ord.md', '2026-09-29T10:00:00.000Z')
    + row('workflow/specs/2026-09-29-ord.md', '2026-09-29T09:00:00.000Z')
    + row('workflow/plans/2026-09-29-ord.md', '2026-09-29T11:00:00.000Z'));
  const r = run(T);
  check('检查19-B 顺序倒置 → 告警且 exit 0',
    r.status === 0 && outOf(r).includes('逐阶段') && outOf(r).includes('倒置') && outOf(r).includes('2026-09-29-ord'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  // 判据 B：顺序合规 → 静默；组内最早 ts 早于 stageGateSince → 整组跳过
  const T1 = mkfix();
  w(T1, '.agents/config/engine.json', '{"policyVersion":2}\n');
  const row1 = (doc, ts) => JSON.stringify({ ts, doc, stage: 'approved', fingerprint: 'c'.repeat(64), prev: 'draft' }) + '\n';
  w(T1, '.agents/confirmations.jsonl',
    row1('workflow/intents/2026-09-29-ok2.md', '2026-09-29T09:00:00.000Z')
    + row1('workflow/specs/2026-09-29-ok2.md', '2026-09-29T10:00:00.000Z')
    + row1('workflow/plans/2026-09-29-ok2.md', '2026-09-29T11:00:00.000Z'));
  const r1 = run(T1);
  check('检查19-B 顺序合规 → 静默',
    r1.status === 0 && !outOf(r1).includes('逐阶段'),
    `exit=${r1.status}\n${outOf(r1)}`);
  rmfix(T1);

  const T2 = mkfix();
  w(T2, '.agents/config/engine.json', '{"policyVersion":2}\n');
  const row2 = (doc, ts) => JSON.stringify({ ts, doc, stage: 'approved', fingerprint: 'd'.repeat(64), prev: 'draft' }) + '\n';
  w(T2, '.agents/confirmations.jsonl',
    row2('workflow/intents/2026-09-01-h.md', '2026-09-01T10:00:00.000Z')
    + row2('workflow/specs/2026-09-01-h.md', '2026-09-01T09:00:00.000Z'));
  const r2 = run(T2);
  check('检查19-B 日期门：组内最早 ts 早于 stageGateSince → 整组静默（历史豁免）',
    r2.status === 0 && !outOf(r2).includes('逐阶段'),
    `exit=${r2.status}\n${outOf(r2)}`);
  rmfix(T2);
});
SCEN(async () => {
  // policy v1（无 stageGateSince 键）→ 检查 19 整体跳过
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":1}\n');
  const fp = 'e'.repeat(64);
  w(T, 'workflow/intents/2026-09-30-v1.md', INTENT('v1', '状态: draft\n级别: L1\n日期: 2026-09-30'));
  w(T, 'workflow/plans/2026-09-30-v1.md', PLAN('v1', '状态: draft\n级别: L1'));
  w(T, '.agents/confirmations.jsonl', JSON.stringify({ ts: '2026-09-29T10:00:00.000Z', doc: 'workflow/specs/2026-09-30-v1.md', stage: 'approved', fingerprint: fp, prev: 'draft' }) + '\n');
  const r = run(T);
  check('检查19 policy v1（无键）→ 整体跳过（零逐阶段告警）',
    r.status === 0 && !outOf(r).includes('逐阶段'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

SCEN(async () => {
  // 判据 A 的 plan→spec 分支（复核 P2-4②）：入口 L2 已确认 + spec 为 draft → plan 出「起草先于 spec 确认」
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  const fp3 = '9'.repeat(64);
  w(T, 'workflow/intents/2026-09-30-ps.md', INTENT('ps', `状态: approved\n级别: L2\n日期: 2026-09-30\n确认指纹: ${fp3.slice(0, 16)}`));
  w(T, 'workflow/specs/2026-09-30-ps.md', SPEC('ps', '状态: draft\n级别: L2\n日期: 2026-09-30'));
  w(T, 'workflow/plans/2026-09-30-ps.md', PLAN('ps', '状态: draft\n级别: L2\n日期: 2026-09-30'));
  w(T, '.agents/confirmations.jsonl', JSON.stringify({ ts: '2026-09-30T03:00:00.000Z', doc: 'workflow/intents/2026-09-30-ps.md', stage: 'approved', fingerprint: fp3, prev: 'draft', source: 'chat-delegated', batch: 'ps', seq: 1, of: 1 }) + '\n');
  const r = run(T);
  check('检查19-A plan→spec 分支：入口确认但 spec 未确认 → 「起草先于 spec 确认」',
    r.status === 0 && outOf(r).includes('起草先于 spec 确认'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});
SCEN(async () => {
  // 交叉一致性（复核 P2-8）：stage-gates.entryConfirmed 与检查 19 内联判据同口径——反例：
  // approved 但无台账行且日期 ≥ 生效日 → 两处皆判「未确认」（check15 亦会 hard-block，断言只取逐阶段警示）
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  w(T, 'workflow/intents/2026-09-30-x1.md', INTENT('x1', '状态: approved\n级别: L1\n日期: 2026-09-30'));
  w(T, 'workflow/plans/2026-09-30-x1.md', PLAN('x1', '状态: draft\n级别: L1\n日期: 2026-09-30'));
  const e1 = entryConfirmed(T, '2026-09-30-x1');
  const r1 = run(T);
  check('交叉一致性①：入口 approved 无台账行 → stage-gates 判未确认 ∧ 检查 19 出「起草先于入口确认」',
    e1.ok === false && outOf(r1).includes('起草先于入口确认'),
    `sg.ok=${e1.ok}\n${outOf(r1)}`);
  rmfix(T);

  // 正例：approved + 台账行 → 两处皆判「已确认」（检查 19 零「逐阶段」）
  const T2 = mkfix();
  w(T2, '.agents/config/engine.json', '{"policyVersion":2}\n');
  const fp2 = 'f'.repeat(64);
  w(T2, 'workflow/intents/2026-09-30-x2.md', INTENT('x2', `状态: approved\n级别: L1\n日期: 2026-09-30\n确认指纹: ${fp2.slice(0, 16)}`));
  w(T2, 'workflow/plans/2026-09-30-x2.md', PLAN('x2', '状态: draft\n级别: L1\n日期: 2026-09-30'));
  w(T2, '.agents/confirmations.jsonl', JSON.stringify({ ts: '2026-09-30T02:30:00.000Z', doc: 'workflow/intents/2026-09-30-x2.md', stage: 'approved', fingerprint: fp2, prev: 'draft', source: 'chat-delegated', batch: 'x2', seq: 1, of: 1 }) + '\n');
  const e2 = entryConfirmed(T2, '2026-09-30-x2');
  const r2 = run(T2);
  check('交叉一致性②：入口 approved + 台账行 → stage-gates 判已确认 ∧ 检查 19 零「逐阶段」',
    e2.ok === true && !outOf(r2).includes('逐阶段'),
    `sg.ok=${e2.ok}\n${outOf(r2)}`);
  rmfix(T2);
});

SCEN(async () => {
  // N1 存量短路（检查 19 同口径）：legacy 入口（无级别）+ plan draft → 零「逐阶段」告警
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  w(T, 'workflow/intents/2026-09-30-leg19.md', INTENT('leg19', '状态: approved\n日期: 2026-01-01\n流程: legacy'));
  w(T, 'workflow/plans/2026-09-30-leg19.md', PLAN('leg19', '状态: draft\n流程: legacy'));
  const r = run(T);
  check('检查19 存量短路：legacy 入口无级别 → plan draft 零「逐阶段」告警',
    r.status === 0 && !outOf(r).includes('逐阶段'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

SCEN(async () => {
  // 检查 19 判据 A 的 **incident 入口**分支（第五轮复核 P2：该分支此前零形态覆盖——
  // 注入验证证明：把 MARK_RE19 改为恒 false，套件仍全绿 → 正则改动不会被拦下）
  {
    const T = mkfix();
    w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
    // 正例：incident（open + 时间线「用户确认」条目）+ spec draft → 零「逐阶段」告警
    // 注：incident 亦受配对门约束（须有同名 plan），故夹具须补 plan，否则 exit 1 遮住本判据
    w(T, 'workflow/incidents/2026-09-30-ic.md', '---\n状态: open\n级别: L2\n发现: 2026-09-30\n---\n# INCIDENT\n\n## 时间线\n- 用户确认：草稿过目通过（2026-09-30）\n');
    w(T, 'workflow/specs/2026-09-30-ic.md', SPEC('ic', '状态: draft\n级别: L2\n日期: 2026-09-30'));
    w(T, 'workflow/plans/2026-09-30-ic.md', PLAN('ic', '状态: draft\n级别: L2\n日期: 2026-09-30'));
    const r1 = run(T);
    check('检查19-A incident 入口（时间线留痕）→ 不告警「起草先于入口确认」',
      r1.status === 0 && !outOf(r1).includes('起草先于入口确认'),
      `exit=${r1.status}\n${outOf(r1)}`);
    rmfix(T);

    // 负例：叙述句不算留痕 → 出「起草先于入口确认」
    const T2 = mkfix();
    w(T2, '.agents/config/engine.json', '{"policyVersion":2}\n');
    w(T2, 'workflow/incidents/2026-09-30-ic2.md', '---\n状态: open\n级别: L2\n发现: 2026-09-30\n---\n# INCIDENT\n\n## 时间线\n- 2026-09-30 用户确认了方案（叙述）\n');
    w(T2, 'workflow/specs/2026-09-30-ic2.md', SPEC('ic2', '状态: draft\n级别: L2\n日期: 2026-09-30'));
    w(T2, 'workflow/plans/2026-09-30-ic2.md', PLAN('ic2', '状态: draft\n级别: L2\n日期: 2026-09-30'));
    const r2 = run(T2);
    check('检查19-A incident 入口（叙述句不算）→ 出「起草先于入口确认」',
      r2.status === 0 && outOf(r2).includes('起草先于入口确认'),
      `exit=${r2.status}\n${outOf(r2)}`);
    rmfix(T2);
  }
});

// ---- L1 plan 即入口（2026-10-10）----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/plans/2026-10-10-solo.md', PLAN('solo', '状态: draft\n级别: L1'));
  expectOk('L1 plan 无 intent/incident → exit 0', T);
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/plans/2026-10-10-hi.md', PLAN('hi', '状态: draft\n级别: L2'));
  expectWarnKw('L2 plan 无入口 → WARN 配对断裂（第 1 批降档）', T, '[WARN 配对断裂]');
  rmfix(T);
});
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/plans/2026-10-10-rl.md', PLAN('rl', '状态: draft\n级别: L1',
    '\n## 入口\n- [x] 规则 / 契约变更 → 级别至少 L2\n'));
  const r = run(T);
  check('L1 plan 勾红线 → hard 红线判低', r.status === 1 && outOf(r).includes('红线判低'), outOf(r));
  rmfix(T);
});

// ---- 风险泳道（2026-09-30 hybrid-governance-risk-lanes）：红线判低 ----
// （2026-10-10 L0 退役：原「L0 配对豁免」场景随级别退役删除。存量 intent 仍须 plan；L1 plan 可独立成入口。）
SCEN(async () => {
  // L1 intent 仍须 plan（协作道不豁免 L1——防倒退回归）
  const T1 = mkfix();
  w(T1, 'workflow/intents/2026-09-12-l1.md', INTENT('l1', '状态: approved\n级别: L1\nrisk_level: L1\n日期: 2026-09-12'));
  expectWarnKw('风险泳道：L1 intent 缺 plan → WARN 配对断裂（第 1 批降档）', T1, '[WARN 配对断裂]');
  rmfix(T1);

  // L1 勾触达红线 → hard「红线判低」（级别与 risk_level 任一判定皆拦）
  const T2 = mkfix();
  w(T2, 'workflow/intents/2026-09-12-rl.md', INTENT('rl', '状态: approved\n级别: L1\nrisk_level: L1\n日期: 2026-09-12',
    '\n## 触达红线（对照 AGENTS.md）\n- [x] 规则 / 契约变更（接口签名）→ 级别至少 L2\n'));
  const r2 = run(T2);
  check('风险泳道：L1 勾触达红线 → hard 红线判低',
    r2.status === 1 && outOf(r2).includes('红线判低'),
    `exit=${r2.status}\n${outOf(r2)}`);
  rmfix(T2);

  const T3 = mkfix();
  w(T3, 'workflow/intents/2026-09-12-rl2.md', INTENT('rl2', '状态: approved\n级别: L2\nrisk_level: L2\n日期: 2026-09-12',
    '\n## 触达红线（对照 AGENTS.md）\n- [x] 规则 / 契约变更（接口签名）→ 级别至少 L2\n'));
  w(T3, 'workflow/specs/2026-09-12-rl2.md', SPEC('rl2', '状态: approved\n级别: L2'));
  w(T3, 'workflow/plans/2026-09-12-rl2.md', PLAN('rl2', '状态: approved\n级别: L2'));
  const r3 = run(T3);
  check('风险泳道：L2 勾红线不判低（防御道受理）',
    r3.status === 0 && !outOf(r3).includes('红线判低'),
    `exit=${r3.status}\n${outOf(r3)}`);
  rmfix(T3);
});

// ---- 检查 15 并录豁免：--batch sanctioned 批次（delegated of>1 + 全行 brief:true）→ 零「确认并录」----
SCEN(async () => {
  const T = mkfix();
  const fpI = 'a'.repeat(64);
  const fpP = 'b'.repeat(64);
  w(T, 'workflow/intents/2026-09-12-b1.md', INTENT('b1', `状态: approved\n级别: L1\n日期: 2026-09-12\n确认指纹: ${fpI.slice(0, 16)}`));
  w(T, 'workflow/plans/2026-09-12-b1.md', PLAN('b1', `状态: approved\n级别: L1\n日期: 2026-09-12\n确认指纹: ${fpP.slice(0, 16)}`));
  const row = (doc, fp, seq) => JSON.stringify({ ts: '2026-09-29T02:00:00.000Z', doc, stage: 'approved', fingerprint: fp, prev: 'draft', source: 'chat-delegated', quote: '批量放行', batch: 'bt1', seq, of: 2, brief: true }) + '\n';
  w(T, '.agents/confirmations.jsonl',
    row('workflow/intents/2026-09-12-b1.md', fpI, 1)
    + row('workflow/plans/2026-09-12-b1.md', fpP, 2));
  const r = run(T);
  check('检查15 --batch sanctioned：全 brief 批次 → 零「确认并录」告警',
    r.status === 0 && !outOf(r).includes('确认并录'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 19：协作道豁免已退役（2026-10-10 收敛系列 2）——draft 起草先于确认照报（行为回归钉）----
SCEN(async () => {
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  w(T, 'workflow/intents/2026-09-30-lane.md', INTENT('lane', '状态: draft\n级别: L1\n日期: 2026-09-30'));
  w(T, 'workflow/plans/2026-09-30-lane.md', PLAN('lane', '状态: draft\n级别: L1'));
  const r = run(T);
  check('检查19 L1 intent draft + plan draft → 仍出「起草先于入口确认」（豁免退役回归钉）',
    outOf(r).includes('起草先于入口确认'),
    outOf(r));
  rmfix(T);
});
SCEN(async () => {
  // L1 intent approved 却无台账行 → 仍告警（防手改状态冒充确认）
  const T = mkfix();
  w(T, '.agents/config/engine.json', '{"policyVersion":2}\n');
  w(T, 'workflow/intents/2026-09-30-lane2.md', INTENT('lane2', '状态: approved\n级别: L1\n日期: 2026-09-30'));
  w(T, 'workflow/plans/2026-09-30-lane2.md', PLAN('lane2', '状态: draft\n级别: L1'));
  const r = run(T);
  check('检查19 L1 approved 无台账行 → 仍出「起草先于入口确认」',
    outOf(r).includes('起草先于入口确认'),
    outOf(r));
  rmfix(T);
});

SCEN(async () => {
  // （加固门 H1-H5/H7 场景随 2026-10-10 收敛系列 2 退役——机制+测试同提交删除。）
  // H6：未知参数 → 用法提示 exit 1（arg 解析收紧后的防倒退）
  const T = mkfix();
  const r = run(T, { args: ['--bogus'] });
  check('加固门 H6：未知 CLI 参数 → exit 1 用法提示', r.status === 1 && /用法/.test(outOf(r)), outOf(r));
  rmfix(T);
});

// ---- 默认入口 vs 卫生入口（2026-10-10）----
SCEN(async () => {
  const T = mkfix();
  w(T, 'workflow/plans/2026-10-10-ph.md', PLAN('ph', '状态: draft\n级别: L1', '\n## 确认与复核\n\n- 日期: YYYY-MM-DD\n'));
  const hard = run(T, { args: [] });
  check('默认入口不跑卫生段：占位符不出「模板未填」且 exit 0',
    hard.status === 0 && !outOf(hard).includes('模板未填'), outOf(hard));
  const hy = run(T, { args: ['--hygiene'] });
  check('卫生入口：同一占位符出「模板未填」且不报配对断裂',
    hy.status === 0 && outOf(hy).includes('模板未填') && !outOf(hy).includes('配对断裂'), outOf(hy));
  rmfix(T);
  const T2 = mkfix();
  // draft 态（approved 会另触发检查 15 确认未对账 hard——第 1 批降档后本场景只测配对 WARN 可见性）
  w(T2, 'workflow/intents/2026-10-10-gap.md', INTENT('gap', '状态: draft\n级别: L1\n日期: 2026-10-10'));
  const gap = run(T2, { args: [] });
  check('默认入口仍报配对断裂（第 1 批降档：WARN 不阻断）',
    gap.status === 0 && outOf(gap).includes('[WARN 配对断裂]'), outOf(gap));
  rmfix(T2);
});

// （检查 20 引擎脚本测试覆盖场景随段体退役删除——2026-10-22 门禁收敛批 4，挂载条件为包源环境
//   templates/_agents/，本仓为消费端装副本恒不触发；机制台账有档）

// --- 单字段泳道协议（2026-10-10 收敛系列 2；原 laneOfEntry 双字段三态随协议退役） ---
SCEN(async () => {
  check('laneOfDoc 单字段三态', laneOfDoc('L1') === 'low' && laneOfDoc('L3') === 'high' && laneOfDoc('') === 'suspect');
  check('laneOfDoc 非法级别 → suspect', laneOfDoc('L9') === 'suspect');
});
SCEN(async () => {
  // 检查 1：级别缺失件（suspect）勾红线 → 按 low 拦红线（hard）
  const T = mkfix();
  fs.writeFileSync(path.join(T, 'workflow', 'intents', '2026-10-02-x.md'),
    INTENT('x', '状态: approved\n日期: 2026-10-02\n模块: pipeline',
      '\n## 触达红线\n- [x] 规则 / 契约变更（→ 级别至少 L2）\n'));
  fs.writeFileSync(path.join(T, 'workflow', 'plans', '2026-10-02-x.md'), '# PLAN\n');
  const r = run(T);
  check('检查1 级别缺失件勾红线 → hard-block（suspect 拦红线）', r.status === 1 && outOf(r).includes('[红线判低]'), outOf(r));
  rmfix(T);
});
SCEN(async () => {
  // 检查 1 对照：协议前存量（级别 L2 无 risk_level）勾红线 → 不拦（单字段 high）
  const T = mkfix();
  fs.writeFileSync(path.join(T, 'workflow', 'intents', '2026-09-28-y.md'),
    INTENT('y', '状态: approved\n级别: L2\n日期: 2026-09-28\n模块: pipeline',
      '\n## 触达红线\n- [x] 规则 / 契约变更（→ 级别至少 L2）\n'));
  fs.writeFileSync(path.join(T, 'workflow', 'plans', '2026-09-28-y.md'), '# PLAN\n');
  const r = run(T);
  check('检查1 协议前 L2 单字段勾红线 → 不拦（存量零新增损害）', !outOf(r).includes('[红线判低]'), outOf(r));
  rmfix(T);
});
SCEN(async () => {
  // 检查 2：样例豁免三态——反引号/围栏块内不报，正文裸占位符照报
  const T = mkfix();
  fs.writeFileSync(path.join(T, 'workflow', 'intents', '2026-10-02-z.md'),
    INTENT('z', '状态: approved\n级别: L2\nrisk_level: L2\n日期: 2026-10-02\n模块: pipeline',
      '\n行内样例 `YYYY-MM-DD` 与 `<主题>` 不报。\n\n```\n日期: YYYY-MM-DD\n```\n\n裸占位：日期: YYYY-MM-DD\n'));
  fs.writeFileSync(path.join(T, 'workflow', 'plans', '2026-10-02-z.md'), '# PLAN\n');
  const r = run(T);
  const o = outOf(r);
  const zWarn = (o.match(/2026-10-02-z\.md 含模板占位符:[\s\S]*?(?=\n- |\n\n|$)/) || [''])[0];
  check('检查2 反引号/围栏样例不报、裸占位符照报',
    zWarn.includes('裸占位') && !zWarn.includes('行内样例') && !zWarn.includes('```'), o);
  rmfix(T);
});


// ---- 场景:检查 8 记录型提交豁免——docs 系证据 + 实现证据在场 → 豁免;仅 docs 证据 → hard（2026-10-06-v114-backflow-batch）----
SCEN(async () => {
  const T = mkfix();
  gitInit(T);
  w(T, 'workflow/plans/2026-09-12-rec.md', PLAN('rec', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 改动面\n- src/impl.txt: 实现改动\n'));
  fs.mkdirSync(path.join(T, 'src'), { recursive: true });
  w(T, 'src/impl.txt', 'impl\n');
  gitCommitAll(T, 'feat: impl change');
  const implSha = shortSha(T);
  w(T, 'record-note.md', 'record\n');
  gitCommitAll(T, 'docs: 记录留痕');
  const docsSha = shortSha(T);
  w(T, 'workflow/intents/2026-09-12-rec.md', INTENT('rec', '状态: done\n级别: L1\n日期: 2026-09-12', `\n## 验收标准（可测试）\n- [x] 实现（证据:commit ${implSha}）\n- [x] 记录（证据:commit ${docsSha}）\n`));
  let r = run(T);
  check('检查 8 记录型豁免:docs 证据 + 实现证据在场 → 豁免且 exit 0', r.status === 0 && outOf(r).includes('证据豁免 record'), outOf(r));
  w(T, 'workflow/intents/2026-09-12-rec.md', INTENT('rec', '状态: done\n级别: L1\n日期: 2026-09-12', `\n## 验收标准（可测试）\n- [x] 记录（证据:commit ${docsSha}）\n`));
  r = run(T);
  check('检查 8 记录型豁免:仅 docs 证据无实现证据 → 仍 hard 证据无关', r.status === 1 && outOf(r).includes('证据无关'), outOf(r));
  rmfix(T);
});

// ---- 场景:检查 19 判据 B——台账 approved 行在、入口 intent 缺件（incident 闭环主题）→ 无 ENOENT 出账，顺序判定不放松（2026-10-06-check19-entry-enoent）----
SCEN(async () => {
  const ledgerRows = (specTs, planTs) => [
    { doc: 'workflow/specs/2026-10-06-noent.md', stage: 'approved', ts: specTs },
    { doc: 'workflow/plans/2026-10-06-noent.md', stage: 'approved', ts: planTs },
  ];
  // ① 顺序合规（specs 先于 plans）：exit 0，且裸 fixture 全程无「文档读取异常（ENOENT）」出账——
  //    修复前「读空判级」惯用法在 fail-loud fs 读下对缺件主题每次响亮出账（实仓 12 条/推送）；
  //    同类读空点（AGENTS.md / new-task.md，检查 6）一并被裸 fixture 钉住
  const T = mkfix();
  w(T, '.agents/config/engine.json', JSON.stringify({ policyVersion: 2 }));
  writeLedger(T, ledgerRows('2026-10-06T10:00:00Z', '2026-10-06T11:00:00Z'));
  let r = run(T);
  check('检查 19 判据 B:入口 intent 缺件 → 无 ENOENT 噪声且 exit 0',
    r.status === 0 && !outOf(r).includes('文档读取异常'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 顺序倒置（plans 先于 specs）：入口缺件不豁免，照报「审批顺序倒置」——守卫不放松判定
  const T2 = mkfix();
  w(T2, '.agents/config/engine.json', JSON.stringify({ policyVersion: 2 }));
  writeLedger(T2, ledgerRows('2026-10-06T11:00:00Z', '2026-10-06T10:00:00Z'));
  r = run(T2);
  check('检查 19 判据 B:入口 intent 缺件 → 顺序倒置照报（守卫不放松判定）',
    r.status === 0 && outOf(r).includes('审批顺序倒置'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T2);
});

// ---- 场景:检查 8 测试绿声明对账（2026-10-07 verify-evidence）——v5 锚后无 SHA「测试绿」声明须有凭证 ----
SCEN(async () => {
  // 配对构造（检查 15 须过）：approved 态全文算指纹 → done 态落盘 + 台账 done 行（prev=approved，
  // ts=今天 ≥ bindingTs）——与 bindingSha256 复原口径对称
  const mkVe = (withLedger) => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', JSON.stringify({ policyVersion: 5 }));
    if (withLedger) {
      w(T, '.agents/verifications.jsonl', `${JSON.stringify({ ts: new Date().toISOString(), exitCode: 0, suite: 'npm test' })}\n`);
    }
    const iBody = '# INTENT — ve\n\n## 验收标准（可测试）\n- [x] 用例通过（证据:测试全绿）\n';
    const pBody = '# PLAN — ve\n';
    const fpI = computeFingerprint(`---\n状态: approved\n级别: L1\n日期: 2026-10-07\n---\n${iBody}`);
    const fpP = computeFingerprint(`---\n状态: approved\n级别: L1\n---\n${pBody}`);
    w(T, 'workflow/intents/2026-10-07-ve.md', `---\n状态: done\n级别: L1\n日期: 2026-10-07\n确认指纹: ${fpI.slice(0, 16)}\n---\n${iBody}`);
    w(T, 'workflow/plans/2026-10-07-ve.md', `---\n状态: done\n级别: L1\n确认指纹: ${fpP.slice(0, 16)}\n---\n${pBody}`);
    const now = new Date().toISOString();
    writeLedger(T, [
      { ts: now, doc: 'workflow/intents/2026-10-07-ve.md', stage: 'done', fingerprint: fpI, prev: 'approved' },
      { ts: now, doc: 'workflow/plans/2026-10-07-ve.md', stage: 'done', fingerprint: fpP, prev: 'approved' },
    ]);
    gitCommitAll(T, 'feat: ve fixture');
    return T;
  };
  // ① 无凭证 → warning（advisory，不拦 exit）
  const T1 = mkVe(false);
  let r = run(T1);
  check('检查 8 凭证对账:锚后「测试绿」声明无凭证 → warning 且不 hard',
    r.status === 0 && outOf(r).includes('测试绿缺凭证') && !outOf(r).includes('证据伪造') && !outOf(r).includes('证据无关'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T1);
  // ② 有近期绿行 → verify 型豁免出账、零 warning
  const T2 = mkVe(true);
  r = run(T2);
  check('检查 8 凭证对账:24h 内有绿行 → verify 豁免出账且无 warning',
    r.status === 0 && outOf(r).includes('证据豁免 verify') && !outOf(r).includes('测试绿缺凭证'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T2);
});

// ---- 检查 3 扩展：incident 防复发验证证据门（2026-10-09；锚 incidentRegrSince）----
SCEN(async () => {
  const incBody = (name, st, verBody) => {
    const fm = `状态: ${st}\n级别: L1\n日期: 2026-10-09\n流程: standard`;
    const body = `# INCIDENT — ${name}\n\n## 复盘三件套（缺一不可）\n\n1. 结构性修复\n - 修复 commit:abc1234\n - 影响环境:dev\n - 是否需要新 intent:\n - 否 → 理由:单点修复\n\n2. 防复发验证\n${verBody}\n\n3. 规范条目\n - AGENTS.md 某节\n`;
    const noFp = `---\n${fm}\n---\n${body}`;
    const fp = computeFingerprint(noFp);
    return {
      text: `---\n${fm}\n确认指纹: ${fp.slice(0, 16)}\n---\n${body}`,
      ledger: { ts: '2026-10-09T01:00:00.000Z', doc: `workflow/incidents/${name}.md`, stage: st, fingerprint: fp, prev: 'open', source: 'chat-delegated', batch: 't-r', seq: 1, of: 1 },
    };
  };
  const mkInc = (engBody, pv = 6, name = '2026-10-09-regr') => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', `{"policyVersion":${pv}}\n`);
    const { text, ledger } = incBody(name, 'fixed', engBody);
    w(T, `workflow/incidents/${name}.md`, text);
    w(T, `workflow/plans/${name}.md`, PLAN(name, '状态: draft\n级别: L1'));
    writeLedger(T, [ledger]);
    gitCommitAll(T, 'incident fixture');
    return T;
  };
  // ① 无回归引用 → hard
  let T = mkInc(' - 已人工验证，无自动化\n');
  let r = run(T, { git: true });
  check('检查3扩展 锚后 fixed 无回归引用 → hard「回归证据缺失」',
    r.status === 1 && outOf(r).includes('回归证据缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 有引擎测试引用 → 不拦
  T = mkInc(' - 回归用例 .agents/scripts/check-scope.test.mjs 已覆盖\n');
  r = run(T, { git: true });
  check('检查3扩展 fixed 有 .test.mjs 引用 → 不拦',
    r.status === 0 && !outOf(r).includes('回归证据缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ③ policyVersion 5（缺 incidentRegrSince 键）→ 检查整体跳过
  T = mkInc(' - 已人工验证，无自动化\n', 5, '2026-10-09-regr5');
  r = run(T, { git: true });
  check('检查3扩展 缺键（v5）→ 整体跳过不拦',
    r.status === 0 && !outOf(r).includes('回归证据缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 21：spec 验证落地核查（2026-10-09；锚 specVerifSince）----
SCEN(async () => {
  const mkSpec = (lvl, verBody, pv = 6) => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', `{"policyVersion":${pv}}\n`);
    w(T, 'workflow/intents/2026-10-09-sp.md', INTENT('sp', '状态: draft\n级别: L1\n日期: 2026-10-09'));
    w(T, 'workflow/plans/2026-10-09-sp.md', PLAN('sp', '状态: draft\n级别: L1'));
    const fm = `状态: done\n级别: ${lvl}\n日期: 2026-10-09`;
    const body = `# SPEC — sp\n\n## 测试用例\n${verBody}\n`;
    // 指纹按 prev 态（approved）内容计算——检查 15 bindingSha256 以台账 prev 字段复原重算（confirm-doc 两跳语义）
    const fp = computeFingerprint(`---\n状态: approved\n级别: ${lvl}\n日期: 2026-10-09\n---\n${body}`);
    w(T, 'workflow/specs/2026-10-09-sp.md', `---\n${fm}\n确认指纹: ${fp.slice(0, 16)}\n---\n${body}`);
    writeLedger(T, [{ ts: '2026-10-09T01:00:00.000Z', doc: 'workflow/specs/2026-10-09-sp.md', stage: 'done', fingerprint: fp, prev: 'approved', source: 'chat-delegated', batch: 't-s', seq: 1, of: 1 }]);
    gitCommitAll(T, 'spec fixture');
    return T;
  };
  // ① 验证节无引用 → WARN
  let T = mkSpec('L2', ' - 人工走查确认\n');
  let r = run(T, { git: true });
  check('检查21 锚后 L2 done spec 验证节无引用 → WARN「spec 验证落地」',
    r.status === 0 && outOf(r).includes('spec 验证落地'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 验证节有 run-tests 命令引用 → 无 WARN
  T = mkSpec('L2', ' - `node .agents/scripts/run-tests.mjs` 全绿\n');
  r = run(T, { git: true });
  check('检查21 验证节有 run-tests 引用 → 无 WARN',
    r.status === 0 && !outOf(r).includes('spec 验证落地'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ③ L1 spec 不核查
  T = mkSpec('L1', ' - 人工走查确认\n');
  r = run(T, { git: true });
  check('检查21 L1 spec 不核查',
    r.status === 0 && !outOf(r).includes('spec 验证落地'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 14：确认态缺失豁免锚 confirmDocsEffective（2026-10-09）----
SCEN(async () => {
  const mk14 = (date) => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', '{"policyVersion":6}\n');
    w(T, 'workflow/intents/2026-10-09-c14.md', INTENT('c14', '状态: draft\n级别: L1\n日期: 2026-10-09'));
    const fm = `状态: done\n级别: L1\n日期: ${date}`;
    const body = '# PLAN — c14\n\n## 改动面\n- src-a.md：改\n';
    const fp = computeFingerprint(`---\n状态: approved\n级别: L1\n日期: ${date}\n---\n${body}`);
    w(T, 'workflow/plans/2026-10-09-c14.md', `---\n${fm}\n确认指纹: ${fp.slice(0, 16)}\n---\n${body}`);
    writeLedger(T, [{ ts: '2026-10-09T01:00:00.000Z', doc: 'workflow/plans/2026-10-09-c14.md', stage: 'done', fingerprint: fp, prev: 'approved', source: 'chat-delegated', batch: 't14', seq: 1, of: 1 }]);
    gitCommitAll(T, 'c14 fixture');
    return T;
  };
  // ① 锚前（confirmDocsEffective=2026-10-06 之前）→ 机制前存量豁免
  let T = mk14('2026-10-05');
  let r = run(T, { git: true });
  check('检查14 锚前 done 无 approved 历史 → 豁免（无确认态缺失）',
    r.status === 0 && !outOf(r).includes('确认态缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 锚后 → WARN 保留（真实纪律缺口留痕）
  T = mk14('2026-10-08');
  r = run(T, { git: true });
  check('检查14 锚后 done 无 approved 历史 → WARN 保留',
    r.status === 0 && outOf(r).includes('确认态缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 14：hard 升级锚 check14HardSince（2026-10-09，policy v7）----
SCEN(async () => {
  const mk14h = (date, ts) => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', '{"policyVersion":7}\n');
    w(T, 'workflow/intents/2026-10-09-c14h.md', INTENT('c14h', '状态: draft\n级别: L1\n日期: 2026-10-09'));
    const body = '# PLAN — c14h\n\n## 改动面\n- src-a.md：改\n';
    const fp = computeFingerprint(`---\n状态: approved\n级别: L1\n日期: ${date}\n---\n${body}`);
    w(T, 'workflow/plans/2026-10-09-c14h.md', `---\n状态: done\n级别: L1\n日期: ${date}\n确认指纹: ${fp.slice(0, 16)}\n---\n${body}`);
    writeLedger(T, [{ ts, doc: 'workflow/plans/2026-10-09-c14h.md', stage: 'done', fingerprint: fp, prev: 'approved', source: 'chat-delegated', batch: 't14h', seq: 1, of: 1 }]);
    gitCommitAll(T, 'c14h fixture');
    return T;
  };
  // ① v7 + 锚当日（2026-10-10）done 无 approved 历史 → HARD-BLOCK exit 1
  let T = mk14h('2026-10-10', '2026-10-10T01:00:00.000Z');
  let r = run(T, { git: true });
  check('检查14 v7 锚后 done 无 approved 历史 → WARN 确认态缺失且 exit 0（第 1 批降档）',
    r.status === 0 && outOf(r).includes('WARN 确认态缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② v7 + 锚前一日（2026-10-09）→ advisory 窗口并入存量豁免（2026-10-15：窗口期关单文档受检查 15
  //    内容绑定不可修订，WARN 属不可消除噪声）→ 无告警 exit 0
  T = mk14h('2026-10-09', '2026-10-09T01:00:00.000Z');
  r = run(T, { git: true });
  check('检查14 v7 锚前一日 → 窗口豁免无告警 exit 0',
    r.status === 0 && !outOf(r).includes('确认态缺失'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ③ v7 + 先 approved 后 done 两提交（留痕齐、台账配对）→ exit 0 无确认态缺失
  {
    const T2 = mkfix();
    gitInit(T2);
    w(T2, '.agents/config/engine.json', '{"policyVersion":7}\n');
    w(T2, 'workflow/intents/2026-10-10-c14h-ok.md', INTENT('c14h-ok', '状态: draft\n级别: L1\n日期: 2026-10-10'));
    const body = '# PLAN — c14h ok\n\n## 改动面\n- src-a.md：改\n';
    const fp = computeFingerprint(`---\n状态: approved\n级别: L1\n日期: 2026-10-10\n---\n${body}`);
    w(T2, 'workflow/plans/2026-10-10-c14h-ok.md', `---\n状态: approved\n级别: L1\n日期: 2026-10-10\n确认指纹: ${fp.slice(0, 16)}\n---\n${body}`);
    gitCommitAll(T2, 'approved');
    w(T2, 'workflow/plans/2026-10-10-c14h-ok.md', `---\n状态: done\n级别: L1\n日期: 2026-10-10\n确认指纹: ${fp.slice(0, 16)}\n---\n${body}`);
    writeLedger(T2, [{ ts: '2026-10-10T01:00:00.000Z', doc: 'workflow/plans/2026-10-10-c14h-ok.md', stage: 'done', fingerprint: fp, prev: 'approved', source: 'chat-delegated', batch: 't14h3', seq: 1, of: 1 }]);
    gitCommitAll(T2, 'done');
    const r2 = run(T2, { git: true });
    check('检查14 v7 approved→done 留痕 → 无确认态缺失 exit 0',
      r2.status === 0 && !outOf(r2).includes('确认态缺失'),
      `exit=${r2.status}\n${outOf(r2)}`);
    rmfix(T2);
  }
});

// ---- 检查 22：机制使用量台账（2026-10-10 mechanism-registry）——格式校验 + 待退役强制处置期限 ----
// 台账文件在场才启用；缺失 = 跳过（装户/历史 clone 无感）。
SCEN(async () => {
  const REG = (rows) => ['# 机制使用量台账', '', '| 机制 | 门禁位置 | 触发统计口径 | 退役阈值 | 最近触发 | 状态 | 处置期限 |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
  const T0 = mkfix();
  w(T0, 'workflow/intents/2026-09-12-r0.md', INTENT('r0', '状态: done\n级别: L1\n日期: 2026-09-12', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:全绿）\n'));
  w(T0, 'workflow/plans/2026-09-12-r0.md', PLAN('r0', '状态: done\n级别: L1'));
  let r = run(T0);
  check('检查22 台账文件缺失 → 跳过不告警（装户无感）',
    r.status === 0 && !outOf(r).includes('机制台账'), outOf(r));
  rmfix(T0);

  const T1 = mkfix();
  w(T1, '.agents/config/mechanism-registry.md', REG([
    '| 三件套配对 | check-loop §1 | WARN 计数 | 6月=0 | 2026-10 | 现役 | — |',
    '| L0 路径 | 枚举+管线 | 使用计数 0/219 | =0 | 2026-10-10 | 待退役 | 收敛系列 1 |',
  ]));
  r = run(T1);
  check('检查22 合法台账（现役+待退役带期限）→ 不告警',
    r.status === 0 && !outOf(r).includes('机制台账'), outOf(r));
  rmfix(T1);

  const T2 = mkfix();
  w(T2, '.agents/config/mechanism-registry.md', REG([
    '| 某机制 | check-loop §9 | WARN 计数 | 6月=0 | 2026-10 | 待退役 |  |',
  ]));
  r = run(T2);
  check('检查22 待退役缺处置期限 → WARN 强制处置',
    r.status === 0 && outOf(r).includes('待退役但缺处置期限'), outOf(r));
  rmfix(T2);

  const T3 = mkfix();
  w(T3, '.agents/config/mechanism-registry.md', REG([
    '| 某机制 | check-loop §9 | WARN 计数 | 6月=0 | 2026-10 | 已删除 | — |',
    '| 列数不足 | check-loop | — | — | — | 现役 |',
  ]));
  r = run(T3);
  check('检查22 状态非法 + 列数≠7 → 双 WARN（格式防线）',
    r.status === 0 && outOf(r).includes('状态非法') && outOf(r).includes('行列数'), outOf(r));
  rmfix(T3);

  const T4 = mkfix();
  w(T4, '.agents/config/mechanism-registry.md', REG([
    '| 三件套配对 | check-loop §1 | WARN 计数 | 6月=0 | 2026-10 | 现役 [检出型] | — |',
    '| 引用有效性 | check-loop §4 | WARN 计数 | 不适用 | 2026-10 | 现役 [健康静默] | — |',
    '| 证据真相核验 | check-loop §8 | hard 计数 | 不退役 | 2026-10 | 现役 [不退役主干] | — |',
    '| 复核效果台账 | metrics | 数据计数 | 6 月=0 | 2026-10 | 现役 [数据面] | — |',
    '| L0 路径 | 枚举+管线 | 使用计数 0/219 | =0 | 2026-10-10 | 待退役 [检出型] | 收敛系列 1 |',
  ]));
  r = run(T4);
  check('检查22 状态带机制类型标记（4 种）→ 剥离后合法，不告警',
    r.status === 0 && !outOf(r).includes('机制台账'), outOf(r));
  rmfix(T4);

  const T5 = mkfix();
  w(T5, '.agents/config/mechanism-registry.md', REG([
    '| 某机制 | check-loop §9 | WARN 计数 | 6月=0 | 2026-10 | 待退役 [检出型] |  |',
  ]));
  r = run(T5);
  check('检查22 待退役带标记 + 缺期限 → 剥离后仍执法（标记不掩盖真问题）',
    r.status === 0 && outOf(r).includes('待退役但缺处置期限'), outOf(r));
  rmfix(T5);

  const T6 = mkfix();
  w(T6, '.agents/config/mechanism-registry.md', REG([
    `| 流水账机制 | check-loop §9 | WARN 计数 | 6月=0 | ${'x'.repeat(820)} | 现役 | — |`,
    '| 正常机制 | check-loop §9 | WARN 计数 | 6月=0 | 2026-10 | 现役 | — |',
  ]));
  r = run(T6);
  check('检查22 单行 > 800B → WARN 压缩（总量另有预算行）',
    r.status === 0 && outOf(r).includes('单行') && outOf(r).includes('> 800B') && !outOf(r).includes('正常机制'),
    outOf(r));
  rmfix(T6);
});

// ---- 检查 23：判据级收敛对账（2026-10-11 convergence-audit；锚 convergenceSince）----
// 场景需 git 模式（锚经 engine.json policyVersion=10 供给）。复刻 s21 的 spec 落态形态（指纹两跳 + 台账 done 行）。
SCEN(async () => {
  const TABLE = (rows) => [
    '## 验收判据',
    '',
    '| 判据（可观察行为） | 证据（测试文件 / 命令 / 证据文件） | 状态 |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
  const mkSpec = (body, date = '2026-10-11', lvl = 'L2', pv = 10) => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', `{"policyVersion":${pv}}\n`);
    w(T, `workflow/intents/2026-10-11-sp.md`, INTENT('sp', `状态: draft\n级别: L1\n日期: ${date}`));
    w(T, `workflow/plans/2026-10-11-sp.md`, PLAN('sp', `状态: draft\n级别: L1`));
    const full = `# SPEC — sp\n\n${body}\n`;
    const fp = computeFingerprint(`---\n状态: approved\n级别: ${lvl}\n日期: ${date}\n---\n${full}`);
    // 两笔提交复刻真实流：approved 留痕（检查 14 hard 要求 git 历史有行首「状态: approved」）→ 置 done + 台账
    w(T, `workflow/specs/2026-10-11-sp.md`, `---\n状态: approved\n级别: ${lvl}\n日期: ${date}\n确认指纹: ${fp.slice(0, 16)}\n---\n${full}`);
    gitCommitAll(T, 'spec approved');
    w(T, `workflow/specs/2026-10-11-sp.md`, `---\n状态: done\n级别: ${lvl}\n日期: ${date}\n确认指纹: ${fp.slice(0, 16)}\n---\n${full}`);
    writeLedger(T, [{ ts: `${date}T01:00:00.000Z`, doc: 'workflow/specs/2026-10-11-sp.md', stage: 'done', fingerprint: fp, prev: 'approved', source: 'chat-delegated', batch: 't-s', seq: 1, of: 1 }]);
    gitCommitAll(T, 'spec done');
    return T;
  };
  // ① 判据全覆盖（命令 + 存在文件）→ 无收敛告警
  let T = mkSpec(TABLE([
    '| 全量套件绿 | npm test | 覆盖 |',
    '| 守卫拒绝超量 | backend/tests/Demo.Tests.cs | 覆盖 |',
  ]));
  fs.mkdirSync(path.join(T, 'backend', 'tests'), { recursive: true });
  w(T, 'backend/tests/Demo.Tests.cs', '// fixture');
  let r = run(T, { git: true });
  check('检查23 判据全覆盖（命令+存在文件）→ 无收敛告警',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 状态自报「覆盖」但文件不存在 → 收敛未覆盖（完成声明不是证据）
  T = mkSpec(TABLE([
    '| 守卫拒绝超量 | backend/tests/Nope.Tests.cs | 覆盖 |',
  ]));
  r = run(T, { git: true });
  check('检查23 状态自报覆盖但证据不存在 → WARN「收敛未覆盖」',
    r.status === 0 && outOf(r).includes('收敛未覆盖'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ③ 无验收判据节 → 收敛无判据
  T = mkSpec('## 风险评估\n\n- 暂无\n');
  r = run(T, { git: true });
  check('检查23 无验收判据节 → WARN「收敛无判据」',
    r.status === 0 && outOf(r).includes('收敛无判据'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ④ 表只有表头/占位行 → 收敛无判据
  T = mkSpec(TABLE(['| <行为 1> | <路径或命令> | <覆盖 / 未覆盖 / 人工> |']));
  r = run(T, { git: true });
  check('检查23 表仅占位行 → WARN「收敛无判据」',
    r.status === 0 && outOf(r).includes('收敛无判据'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑤ 人工判据空证据合法 + 其余覆盖 → 无告警
  T = mkSpec(TABLE([
    '| 视觉布局走查 |  | 人工 |',
    '| 全量套件绿 | npm test | 覆盖 |',
  ]));
  r = run(T, { git: true });
  check('检查23 人工判据（空证据）+ 覆盖 → 无告警',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑥ 锚前存量（日期 < convergenceSince）→ 豁免
  T = mkSpec('## 风险评估\n\n- 暂无\n', '2026-10-10');
  r = run(T, { git: true });
  check('检查23 锚前存量件 → 豁免',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑦ 旧版本（v9 无键）→ 检查整体跳过
  T = mkSpec('## 风险评估\n\n- 暂无\n', '2026-10-11', 'L2', 9);
  r = run(T, { git: true });
  check('检查23 v9 缺键 → 检查整体跳过',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑧ 硬锚之前（v11，日期落在两锚之间）→ 仍是声明口径 WARN，不升 hard
  T = mkSpec(TABLE([
    '| 守卫拒绝超量 | backend/tests/Nope.Tests.cs | 覆盖 |',
  ]), '2026-10-11', 'L2', 11);
  r = run(T, { git: true });
  check('检查23 硬锚前无效证据 → 仍 WARN 不阻断',
    r.status === 0 && outOf(r).includes('[WARN 收敛未覆盖]'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑨ 硬锚起：路径不存在 → HARD，默认硬门（无 --all）也拦
  T = mkSpec(TABLE([
    '| 守卫拒绝超量 | backend/tests/Nope.Tests.cs | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  r = run(T, { git: true, args: [] });
  check('检查23 硬锚起路径不存在 → 默认硬门 HARD「收敛未覆盖」',
    r.status !== 0 && outOf(r).includes('[收敛未覆盖]') && !outOf(r).includes('[WARN 收敛未覆盖]')
      && outOf(r).includes('重录指纹') && !outOf(r).includes('状态临时改回非 done'),
    `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑩ 硬锚起：dotnet test 无全绿行 → HARD（声明不是凭证）
  T = mkSpec(TABLE([
    '| 全量套件绿 | dotnet test | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  r = run(T, { git: true });
  check('检查23 硬锚起命令无全绿行 → HARD',
    r.status !== 0 && outOf(r).includes('[收敛未覆盖]'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑪ 全绿行早于 spec 日期 → 仍 HARD
  T = mkSpec(TABLE([
    '| 全量套件绿 | dotnet test | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  w(T, 'workflow/verify-evidence.md', [
    '# 验证绿凭证摘要',
    '',
    '| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |',
    '|---|---|---|---|---|',
    '| `abc1234` | 2026-10-11T01:00:00.000Z | 15 | PASS 1 / FAIL 0 | — |',
    '',
  ].join('\n'));
  r = run(T, { git: true });
  check('检查23 全绿行早于 spec 日期 → HARD',
    r.status !== 0 && outOf(r).includes('[收敛未覆盖]'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑫ 全绿行不早于 spec 日期 + 全量门命令 → 覆盖
  T = mkSpec(TABLE([
    '| 全量套件绿 | dotnet test | 覆盖 |',
    '| 前端能构建 | npm run build | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  w(T, 'workflow/verify-evidence.md', [
    '# 验证绿凭证摘要',
    '',
    '| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |',
    '|---|---|---|---|---|',
    '| `abc1234` | 2026-10-12T01:00:00.000Z | 15 | PASS 1 / FAIL 0 | — |',
    '',
  ].join('\n'));
  r = run(T, { git: true });
  check('检查23 硬锚起全量门命令且有当日全绿行 → 无收敛告警',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑬ 白名单里但不在全量门的命令，有全绿行也不算覆盖
  T = mkSpec(TABLE([
    '| 页面走查 | verify-ui | 覆盖 |',
  ]), '2026-10-12', 'L3', 11);
  w(T, 'workflow/verify-evidence.md', [
    '# 验证绿凭证摘要',
    '',
    '| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |',
    '|---|---|---|---|---|',
    '| `abc1234` | 2026-10-12T01:00:00.000Z | 15 | PASS 1 / FAIL 0 | — |',
    '',
  ].join('\n'));
  r = run(T, { git: true });
  check('检查23 非全量门命令有全绿行 → HARD',
    r.status !== 0 && outOf(r).includes('[收敛未覆盖]'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑭ 路径存在即覆盖（不读正文是否与判据相关）
  T = mkSpec(TABLE([
    '| 守卫拒绝超量 | backend/tests/Demo.Tests.cs | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  fs.mkdirSync(path.join(T, 'backend', 'tests'), { recursive: true });
  w(T, 'backend/tests/Demo.Tests.cs', '// fixture');
  r = run(T, { git: true });
  check('检查23 硬锚起路径存在 → 无收敛告警',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑭b .vue 与中文目录路径存在即覆盖（2026-10-15）
  T = mkSpec(TABLE([
    '| 页面在 | frontend/src/views/foo/index.vue（同改说明，不得吞进路径） | 覆盖 |',
    '| 批次 SQL 在 | wiki/数据维护/schema变更/01-alter.sql | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  fs.mkdirSync(path.join(T, 'frontend', 'src', 'views', 'foo'), { recursive: true });
  fs.mkdirSync(path.join(T, 'wiki', '数据维护', 'schema变更'), { recursive: true });
  w(T, 'frontend/src/views/foo/index.vue', '<template></template>');
  w(T, 'wiki/数据维护/schema变更/01-alter.sql', '-- fixture');
  r = run(T, { git: true });
  check('检查23 硬锚起 .vue 与中文目录路径存在 → 无收敛告警',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑮ 人工空证据仍合法；无判据表在硬锚日仍是 WARN 不阻断
  T = mkSpec(TABLE([
    '| 视觉布局走查 |  | 人工 |',
    '| 全量套件绿 | npm test | 覆盖 |',
  ]), '2026-10-12', 'L2', 11);
  w(T, 'workflow/verify-evidence.md', [
    '# 验证绿凭证摘要',
    '',
    '| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |',
    '|---|---|---|---|---|',
    '| `abc1234` | 2026-10-12T08:00:00.000Z | 15 | PASS 1 / FAIL 0 | — |',
    '',
  ].join('\n'));
  r = run(T, { git: true });
  check('检查23 硬锚起人工空证据 + 有凭证的命令 → 无告警',
    r.status === 0 && !outOf(r).includes('收敛'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  T = mkSpec('## 风险评估\n\n- 暂无\n', '2026-10-12', 'L2', 11);
  r = run(T, { git: true });
  check('检查23 硬锚起无验收判据表 → 仍 WARN 不阻断',
    r.status === 0 && outOf(r).includes('[WARN 收敛无判据]'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 24：incident 归因字段核查（2026-10-11 incident-attribution；锚 attributionSince）----
// 场景需 git 模式（锚经 engine.json policyVersion=9 供给）。
SCEN(async () => {
  const mkInc = (name, fm) => {
    const T = mkfix();
    gitInit(T);
    w(T, '.agents/config/engine.json', '{"policyVersion":9}\n');
    // L1 配对：s03 要求 L1 incident 有同名 plan（否则 HARD-block 掩盖本段 WARN）
    w(T, `workflow/plans/${name}`, PLAN(name.replace(/\.md$/, ''), '状态: draft\n级别: L1'));
    w(T, `workflow/incidents/${name}`, `---\n${fm}\n---\n# INCIDENT\n\n## 复盘三件套（缺一不可）\n\n1. 结构性修复\n2. 防复发验证\n3. 规范条目\n- 是否需要新 intent：否\n`);
    gitCommitAll(T, 'incident fixture');
    return T;
  };
  // ① 锚后含两键合法值 → 无归因 WARN
  let T = mkInc('2026-10-11-a.md', '状态: open\n级别: L1\n发现: 2026-10-11\n来源: user\n影响环境: dev');
  let r = run(T, { git: true });
  check('检查24 锚后两键合法 → 无归因告警',
    r.status === 0 && !outOf(r).includes('归因'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 锚后缺两键 → 两条「归因缺字段」
  T = mkInc('2026-10-11-b.md', '状态: open\n级别: L1\n发现: 2026-10-11');
  r = run(T, { git: true });
  check('检查24 锚后缺来源/影响环境 → 双 WARN「归因缺字段」',
    r.status === 0 && (outOf(r).match(/归因缺字段/g) || []).length >= 2, `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ③ 锚后值非法 → 「归因非法值」
  T = mkInc('2026-10-11-c.md', '状态: open\n级别: L1\n发现: 2026-10-11\n来源: robot\n影响环境: qa');
  r = run(T, { git: true });
  check('检查24 锚后值不在枚举 → WARN「归因非法值」',
    r.status === 0 && outOf(r).includes('归因非法值'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ④ 锚前存量 → 不回填、零告警
  T = mkInc('2026-10-01-d.md', '状态: open\n级别: L1\n发现: 2026-10-01');
  r = run(T, { git: true });
  check('检查24 锚前存量件缺键 → 豁免不回填',
    r.status === 0 && !outOf(r).includes('归因'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ⑤ legacy 回填件 → 豁免
  T = mkInc('2026-10-11-e.md', '状态: open\n级别: L1\n发现: 2026-10-11\n流程: legacy');
  r = run(T, { git: true });
  check('检查24 legacy 回填件 → 豁免',
    r.status === 0 && !outOf(r).includes('归因'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
});

// ---- 检查 25：路由预判一致性（2026-10-12 prejudgment-ledger；advisory 纯 WARN）----
SCEN(async () => {
  // ① 一致 → 零告警（L1 intent require/L1 + 同名 plan；镜像场景 1 合法形态 + 预判字段）
  const T = mkfix();
  w(T, 'workflow/intents/2026-09-12-pj1.md', INTENT('pj1', '状态: done\n级别: L1\n日期: 2026-09-12\n预判: kind=require level=L1', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T, 'workflow/plans/2026-09-12-pj1.md', PLAN('pj1', '状态: done\n级别: L1'));
  let r = run(T);
  check('检查25 预判与落位一致 → 零告警 exit 0',
    r.status === 0 && !outOf(r).includes('预判'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 类型不符：intent（≡require）预判 fix → WARN 不阻断；incident（≡fix）预判 require 同理
  const T2 = mkfix();
  w(T2, 'workflow/intents/2026-09-12-pj2.md', INTENT('pj2', '状态: done\n级别: L1\n日期: 2026-09-12\n预判: kind=fix level=L1', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T2, 'workflow/plans/2026-09-12-pj2.md', PLAN('pj2', '状态: done\n级别: L1'));
  w(T2, 'workflow/incidents/2026-09-12-pj3.md', `---\n状态: open\n级别: L1\n发现: 2026-09-12\n预判: kind=require level=L1\n---\n# INCIDENT — pj3\n\n${三件套(false)}`);
  w(T2, 'workflow/plans/2026-09-12-pj3.md', PLAN('pj3', '状态: draft\n级别: L1'));
  r = run(T2);
  check('检查25 类型不符（intent 预判 fix / incident 预判 require）→ 双 WARN「预判类型不符」且 exit 0',
    r.status === 0 && (outOf(r).match(/预判类型不符/g) || []).length === 2, `exit=${r.status}\n${outOf(r)}`);
  rmfix(T2);
  // ③ 级别不符：intent 预判 L2 落位 L1 → WARN「预判级别不符」带判低信号；反向（预判 L1 落位 L2）带判高
  const T3 = mkfix();
  w(T3, 'workflow/intents/2026-09-12-pj4.md', INTENT('pj4', '状态: done\n级别: L1\n日期: 2026-09-12\n预判: kind=require level=L2', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T3, 'workflow/plans/2026-09-12-pj4.md', PLAN('pj4', '状态: done\n级别: L1'));
  r = run(T3);
  check('检查25 预判 L2 落位 L1 → WARN「预判级别不符」含判低信号',
    r.status === 0 && outOf(r).includes('预判级别不符') && outOf(r).includes('判低信号'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T3);
  // ④ 词表非法 kind / 整字段不可解析 → WARN「预判字段不可解析」（夹具取 approved 活文档——终态 done
  //   自 2026-10-15 起形态类告警跳过，见 ⑥）
  const T4 = mkfix();
  w(T4, 'workflow/intents/2026-09-12-pj5.md', INTENT('pj5', '状态: approved\n级别: L1\n日期: 2026-09-12\n预判: kind=bug level=L1', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T4, 'workflow/plans/2026-09-12-pj5.md', PLAN('pj5', '状态: draft\n级别: L1'));
  r = run(T4);
  check('检查25 kind=bug 不在词表 → WARN「预判字段不可解析」',
    r.status === 0 && outOf(r).includes('预判字段不可解析'), `exit=${r.status}\n${outOf(r)}`);
  // ④b 词表外 kind 不得叠报「类型不符」（同一根因双计，2026-10-14 修）
  check('检查25 词表外 kind 只报「不可解析」不叠报「类型不符」',
    r.status === 0 && !outOf(r).includes('预判类型不符'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T4);
  const T5 = mkfix();
  w(T5, 'workflow/intents/2026-09-12-pj6.md', INTENT('pj6', '状态: approved\n级别: L1\n日期: 2026-09-12\n预判: 这是个修复', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
  w(T5, 'workflow/plans/2026-09-12-pj6.md', PLAN('pj6', '状态: draft\n级别: L1'));
  r = run(T5);
  check('检查25 预判字段无 kv 形态 → WARN「预判字段不可解析」',
    r.status === 0 && outOf(r).includes('预判字段不可解析'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T5);
  // ⑤ 终态跳过（2026-10-15）：done 文档词表/形态类告警不产——终态受检查 15 内容绑定不可修订，
  //   WARN 永不可消（「不可消除噪声」红线）；类型/级别比对照常（此处 kind=bug 不叠报类型、level 一致）
  {
    const T6 = mkfix();
    w(T6, 'workflow/intents/2026-09-12-pj7.md', INTENT('pj7', '状态: done\n级别: L1\n日期: 2026-09-12\n预判: kind=bug level=L1', '\n## 验收标准（可测试）\n- [x] 用例通过（证据:fixture）\n'));
    w(T6, 'workflow/plans/2026-09-12-pj7.md', PLAN('pj7', '状态: done\n级别: L1'));
    const r6 = run(T6);
    check('检查25 终态 done 词表外 kind → 形态类告警不产（2026-10-15 终态跳过）',
      r6.status === 0 && !outOf(r6).includes('预判字段不可解析'), `exit=${r6.status}\n${outOf(r6)}`);
    rmfix(T6);
  }
});

// ---- 检查 26：闭环漏斗「协议前」占比动作阈值（2026-10-12 funnel-action-threshold；advisory 纯 WARN）----
SCEN(async () => {
  // 漏斗表构造器：行按写入序给出，段外放一个归因节验证「到下一节为止」的分段判据
  const mkMetrics = (rows) => `<!-- GENERATED:BEGIN -->

## 闭环漏斗（机器口径，源：.agents/confirmations.jsonl 的阶段链）

| 月份 | 收口 | 完整链 | 协议前 | 确认链一次通过 | 返工件 | 中位周期(天) | 台账行数 |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r} |`).join('\n')}

## 产品与质量维度（源：incident frontmatter 枚举）

| 月份 | incident | 来源（谁发现） | 影响环境 | 归因未判读 | 引擎面提交占比 |
|---|---|---|---|---|---|
| 2026-10 | 0 | self 0 / user 0 / test 0 / monitor 0 | dev 0 / staging 0 / prod 0 / none 0 | 0 | 0.0%（0/1） |

<!-- GENERATED:END -->
`;
  // ① 无 metrics.md（装户/新仓未启用观测）→ 静默跳过零告警
  const T = mkfix();
  let r = run(T);
  check('检查26 无 metrics.md → 跳过零告警 exit 0',
    r.status === 0 && !outOf(r).includes('漏斗协议前超标'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T);
  // ② 相邻两月均 >30% → WARN「漏斗协议前超标」且不阻断（exit 0）
  const T2 = mkfix();
  w(T2, 'workflow/metrics.md', mkMetrics([
    '2026-09 | 10 | 4 | 6（60%） ⚠️ | 3 | 1 | 1.0 | 20',
    '2026-10 | 10 | 4 | 5（50%） ⚠️ | 4 | 1 | 1.0 | 20',
  ]));
  r = run(T2);
  check('检查26 相邻两月协议前占比均 >30% → WARN 且 exit 0',
    r.status === 0 && outOf(r).includes('漏斗协议前超标') && outOf(r).includes('2026-09 60% → 2026-10 50%'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T2);
  // ③ 仅单月 >30%（无相邻月超标）→ 零告警（单月波动不触发）
  const T3 = mkfix();
  w(T3, 'workflow/metrics.md', mkMetrics([
    '2026-09 | 10 | 9 | 1（10%） | 8 | 1 | 1.0 | 20',
    '2026-10 | 10 | 4 | 5（50%） ⚠️ | 4 | 1 | 1.0 | 20',
  ]));
  r = run(T3);
  check('检查26 仅单月超标（相邻月正常）→ 零告警 exit 0',
    r.status === 0 && !outOf(r).includes('漏斗协议前超标'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T3);
  // ④ 两月都超标但不相邻（跳月 09→11）→ 零告警（判据是日历相邻）
  const T4 = mkfix();
  w(T4, 'workflow/metrics.md', mkMetrics([
    '2026-09 | 10 | 4 | 6（60%） ⚠️ | 3 | 1 | 1.0 | 20',
    '2026-11 | 10 | 4 | 5（50%） ⚠️ | 4 | 1 | 1.0 | 20',
  ]));
  r = run(T4);
  check('检查26 超标两月不相邻（跳月）→ 零告警 exit 0',
    r.status === 0 && !outOf(r).includes('漏斗协议前超标'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T4);
  // ⑤ 收口=0 的月无占比（0/0 不判），且存量裸数字单元格（无百分比）同样可解析
  const T5 = mkfix();
  w(T5, 'workflow/metrics.md', mkMetrics([
    '2026-09 | 0 | 0 | 0 | 0 | 0 | — | 1',
    '2026-10 | 10 | 4 | 5 | 4 | 1 | 1.0 | 20',
  ]));
  r = run(T5);
  check('检查26 收口=0 月不判 0/0；裸数字单元格可解析（10 月 50% 单月不触发）',
    r.status === 0 && !outOf(r).includes('漏斗协议前超标'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T5);
  // ⑥ 存量裸数字 + 相邻两月超标 → 照判（解析只取首个整数，混合形态可读）
  const T6 = mkfix();
  w(T6, 'workflow/metrics.md', mkMetrics([
    '2026-09 | 10 | 4 | 6 | 3 | 1 | 1.0 | 20',
    '2026-10 | 10 | 4 | 5 | 4 | 1 | 1.0 | 20',
  ]));
  r = run(T6);
  check('检查26 存量裸数字单元格相邻两月超标 → 照判 WARN',
    r.status === 0 && outOf(r).includes('漏斗协议前超标') && outOf(r).includes('2026-09 60% → 2026-10 50%'), `exit=${r.status}\n${outOf(r)}`);
  rmfix(T6);
});
// 场景间零共享态（各自 mkfix 独立临时仓 + git init，评估期逐块审计确认）→ 按 idx % K round-robin
// 分片可安全并行。K = clamp(1..8, floor(cpus/1.5))：12 核本机 8；小核 CI 自适应到 1 = 顺序等价（行为
// 与分片化前一致）；CHECK_LOOP_TEST_SHARDS 钉死（调试/复现单线程顺序）。--shard=i/K = 子进程态，
// 只跑本片场景后落文件末既有「合计」汇总；parent 态聚合各子进程「合计」行、任一红即 exit 1，
// 并在文件末汇总前显式退出（parent 未跑场景，模块级计数器恒 0，不走该汇总）。
const SHARD_ARG = process.argv.find((a) => a.startsWith('--shard='));
if (SHARD_ARG) {
  const m = SHARD_ARG.match(/^--shard=(\d+)\/(\d+)$/);
  const si = m && Number(m[1]), sk = m && Number(m[2]);
  if (!m || !Number.isInteger(si) || !Number.isInteger(sk) || sk < 1 || si >= sk) {
    console.error(`check-loop.test: --shard 形态须为 i/K 且 i<K（现 ${SHARD_ARG}）`);
    process.exit(1);
  }
  // 逐场景异常捕获（2026-10-12 CI 代理排障）：环境/夹具异常原样击穿 shard 进程 → 套件红而零诊断
  // 信息（RED 回放只见栈尾，Error 消息被栈行挤出）。转为 FAIL + 消息头（gitRetry 等抛出的
  // 命令与 stderr 直达日志），shard 其余场景照常执行。
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
    const env = Number(process.env.CHECK_LOOP_TEST_SHARDS);
    if (Number.isInteger(env) && env >= 1) return Math.min(env, SCENARIOS.length);
    return Math.min(8, Math.max(1, Math.floor(os.cpus().length / 1.5)));
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
      process.stdout.write(`\n[check-loop.test ▶ shard ${r.i + 1}/${K}]\n${r.out}`);
      if (!ok) {
        console.log(`[check-loop.test] RED shard ${r.i + 1}${r.code != null ? `（exit ${r.code}）` : r.err_obj ? `（spawn ${r.err_obj.code || r.err_obj.message}）` : ''}`);
        // 头 12 + 尾 5 回放（2026-10-12）：仅尾 5 会把 uncaught Error 的消息体挤掉（栈行总在尾部）——
        // 消息头（含抛错命令与 stderr）才是排障要害，中略标记防长转储刷屏。
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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
