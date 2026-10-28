#!/usr/bin/env node
// acceptance.mjs — 设计文档 §10 验收标准黑盒落地（十条逐条断言，2026-10-27）
// 方法：全部走 CLI / stdio 入口（spawn 子进程），不 import 任何内部函数——被测面与用户/宿主所见一致。
// fixture：每条 §10 独立临时 git 仓（mkRepo + init-engine CLI 种子），场景内可续变造；跑完即清理。
// 输出：逐条 ✓/✗ 且标注对应 §10 条目；末尾打印十条对应表与合计行；任一失败 exit 非 0。
// 对照：§10 原文见 design/ai-native-delivery.md；个别断言的落地口径偏离在断言名内注明（§10.6）。
// 用法：node test/acceptance.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(TEST_DIR, '..');
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'pretool-risk.mjs');
const MARKET_ROOT = path.join(PLUGIN_ROOT, '..', '..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'; // Windows spawn 不补 .exe 扩展名
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const results = []; // { item: '§10.1', desc, ok }
const check = (item, desc, cond, detail = '') => {
  const ok = Boolean(cond);
  if (ok) pass++;
  else fail++;
  results.push({ item, desc, ok });
  console.log(`${ok ? '✓' : '✗'} [${item}] ${desc}${ok || !detail ? '' : `\n      ${detail}`}`);
};

// ---- 通用夹具与执行辅助（全部进程外，零内部 import）----
const git = (args, cwd) => {
  for (let i = 0; ; i++) {
    const r = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
    if (!r.error && r.status === 0) return r;
    if (i >= 1) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').slice(0, 300)}`);
  }
};
const mkRepo = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `accept-${tag}-`));
  git(['init', '-q'], d);
  fs.writeFileSync(path.join(d, 'README.md'), 'fixture\n', 'utf8');
  git(['add', '-A'], d);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], d);
  return d;
};
const rmRepo = (d) => fs.rmSync(d, { recursive: true, force: true });
const commitAll = (d, msg) => {
  git(['add', '-A'], d);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], d);
};
const runCli = (script, args, opts = {}) => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: opts.cwd ?? PLUGIN_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
};
const initEngine = (root) => runCli('init-engine.mjs', ['--root', root], { cwd: root });

// MCP stdio 客户端（一次喂入全部请求行，按 id 收回执；夹具形态同 mcp-tools.test）
const callMcp = (root, requests) => {
  const input = requests.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'mcp', 'server.mjs')], {
    input, encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024,
  });
  const replies = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined) replies.set(msg.id, msg);
    } catch { /* 非回执行忽略 */ }
  }
  return replies;
};
const mcpCall = (root, id, name, args = {}) => callMcp(root, [
  { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
]).get(id);
const jsonOf = (reply) => {
  try {
    const res = reply && reply.result && !reply.result.isError ? reply.result : null;
    return res ? JSON.parse(res.content[0].text) : null;
  } catch { return null; }
};

// check-loop 夹具（git 模式，cwd 注入——门禁经 git toplevel 锚定根）
// CHECK_LOOP_VERBOSE=1：断言按告警逐条原文匹配；插件形态下折叠默认生效（2026-10-28 修复），故走逐条出口。
const runCheckLoop = (root, args = []) => runCli('check-loop.mjs', args, { cwd: root, env: { CHECK_LOOP_VERBOSE: '1' } });

const planDoc = (name, fm, body = '') => `---\n${fm}\n---\n# PLAN — ${name}\n${body}`;
const w = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
};

console.log(`acceptance — 设计文档 §10 验收黑盒（${TODAY}）\n`);

/* ================================================================ §10.1 定级可测 */
{
  const d = mkRepo('grade');
  try {
    const l2 = JSON.parse(runCli('grade-task.mjs', ['修改共享契约：公共接口签名的分页参数默认值', '--root', d]).stdout);
    check('§10.1', '定级：公共接口签名描述 → L2 且 hits 非空', l2.level === 'L2' && l2.hits.length > 0, JSON.stringify(l2));
    const l1 = JSON.parse(runCli('grade-task.mjs', ['把登录页标题文案从「用户登录」改为「欢迎登录」', '--root', d]).stdout);
    check('§10.1', '定级：纯页面文案描述 → L1（hits 空，判低也是结论）', l1.level === 'L1' && l1.hits.length === 0, JSON.stringify(l1));
    const l3 = JSON.parse(runCli('grade-task.mjs', ['订单表新增字段，需要 schema 迁移 SQL', '--root', d]).stdout);
    check('§10.1', '定级：schema 变更描述 → L3', l3.level === 'L3' && l3.hits.length > 0, JSON.stringify(l3));
  } finally { rmRepo(d); }
}

/* ================================================================ §10.2 判低拦截可测 */
{
  const d = mkRepo('prejudge');
  try {
    initEngine(d);
    // 勾红线的 L1 plan（plan 即入口；红线勾选 = 自证触达 L2 面）→ §1 红线判低 hard
    // （git 模式下门禁只扫 tracked 文档——夹具文档须先入库）
    w(d, 'workflow/plans/2026-10-27-rl.md', planDoc('rl', '状态: draft\n级别: L1\n日期: 2026-10-27',
      '\n## 入口\n- [x] 规则 / 契约变更 → 级别至少 L2\n'));
    commitAll(d, 'L1 plan with redline');
    let r = runCheckLoop(d);
    check('§10.2', '判低拦截：勾红线的 L1 plan → check-loop exit≠0 且含「红线判低」',
      r.status !== 0 && r.out.includes('红线判低'), `exit=${r.status}\n${r.out.slice(-600)}`);
    // 改立 L2（intent+spec+plan 三件套，draft——确认面不涉，隔离判低单一变量）→ exit 0
    fs.rmSync(path.join(d, 'workflow', 'plans', '2026-10-27-rl.md'));
    w(d, 'workflow/intents/2026-10-27-rl.md', `---\n状态: draft\n级别: L2\n日期: 2026-10-27\n---\n# INTENT — rl\n\n## 触达红线（对照 AGENTS.md）\n- [x] 规则 / 契约变更（接口签名）→ 级别至少 L2\n`);
    w(d, 'workflow/specs/2026-10-27-rl.md', `---\n状态: draft\n级别: L2\n日期: 2026-10-27\n---\n# SPEC — rl\n`);
    w(d, 'workflow/plans/2026-10-27-rl.md', planDoc('rl', '状态: draft\n级别: L2\n日期: 2026-10-27'));
    commitAll(d, 'L2 trio');
    r = runCheckLoop(d);
    check('§10.2', '判低拦截：改立 L2（intent+spec+plan）后 → exit 0', r.status === 0, `exit=${r.status}\n${r.out.slice(-600)}`);
  } finally { rmRepo(d); }
}

/* ================================================================ §10.3 台账闭环可测 */
{
  const d = mkRepo('ledger');
  try {
    initEngine(d);
    commitAll(d, 'init engine');
    // 合法行 update（经 MCP stdio 的 update_ledger）——metrics.md 为 init-engine 种子件，用独立验收件名
    const upd = jsonOf(mcpCall(d, 1, 'update_ledger', { file: 'workflow/metrics-acceptance.md', mode: 'create', content: '# metrics（验收夹具）\n\n- 关键字段标记 acceptance-ledger-key\n' }));
    check('§10.3', '台账闭环：update_ledger create → written', upd && upd.written === true, JSON.stringify(upd));
    let inv = runCli('check-ledger-invariant.mjs', ['--root', d], { cwd: d });
    check('§10.3', '台账闭环：update 后 invariant exit 0', inv.status === 0, inv.out.slice(-400));
    // confirm-doc 产生分片行（L1 plan 自入口 draft→approved），compact 归并后关键字段仍在
    w(d, 'workflow/plans/2026-10-27-metrics.md', planDoc('metrics', `状态: draft\n级别: L1\n日期: ${TODAY}\n模块: pipeline`,
      '\n## 改动方案\n\n- workflow/metrics.md：登记验收指标行\n'));
    const cd = runCli('confirm-doc.mjs', ['workflow/plans/2026-10-27-metrics.md', '--delegated', '可以，按这个方案登记', '--root', d], { cwd: d });
    check('§10.3', '台账闭环：confirm-doc 起草确认落分片行 → exit 0', cd.status === 0, cd.out.slice(-400));
    const shardDir = path.join(d, '.agents', 'confirmations.d');
    const shardsBefore = fs.existsSync(shardDir) ? fs.readdirSync(shardDir).filter((f) => f.endsWith('.jsonl')) : [];
    check('§10.3', '台账闭环：确认行进分片（confirmations.d/ 非空）', shardsBefore.length > 0, JSON.stringify(shardsBefore));
    const compact = runCli('compact-ledgers.mjs', [], { cwd: d });
    check('§10.3', '台账闭环：compact-ledgers 归并 exit 0', compact.status === 0, compact.out.slice(-400));
    const mainText = fs.readFileSync(path.join(d, '.agents', 'confirmations.jsonl'), 'utf8');
    const rows = mainText.split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const metricRow = rows.find((e) => e && e.doc === 'workflow/plans/2026-10-27-metrics.md');
    check('§10.3', '台账闭环：compact 后关键字段（doc/stage/fingerprint/ts）仍在主台账',
      Boolean(metricRow) && ['doc', 'stage', 'fingerprint', 'ts'].every((k) => k in metricRow), mainText.slice(-400));
    const shardsAfter = fs.existsSync(shardDir) ? fs.readdirSync(shardDir).filter((f) => f.endsWith('.jsonl')) : [];
    check('§10.3', '台账闭环：compact 后分片已清空', shardsAfter.length === 0, JSON.stringify(shardsAfter));
    commitAll(d, 'compact merge');
    inv = runCli('check-ledger-invariant.mjs', ['--root', d], { cwd: d });
    check('§10.3', '台账闭环：compact 提交后 invariant exit 0（归并删片有凭据）', inv.status === 0, inv.out.slice(-400));
  } finally { rmRepo(d); }
}

/* ================================================================ §10.4 断崖恢复可测 */
{
  const d = mkRepo('resume');
  try {
    initEngine(d);
    // 在途 plan（approved ∈ 活跃集）+ INDEX（含 next 指向的下一命令——INDEX 是恢复入口的承重面）
    w(d, 'workflow/plans/2026-10-27-wip.md', planDoc('wip', `状态: approved\n级别: L1\n日期: ${TODAY}\n模块: pipeline`));
    w(d, 'workflow/INDEX.md', '# workflow 索引\n\n| 文档 | 状态 |\n|---|---|\n| plans/2026-10-27-wip.md | approved |\n\n下一步：node .agents/scripts/closeout-l1.mjs workflow/plans/2026-10-27-wip.md\n');
    const out = runCli('read-context.mjs', ['--root', d], { cwd: d });
    let ctx = null;
    try { ctx = JSON.parse(out.stdout); } catch { /* 解析失败按断言处置 */ }
    check('§10.4', '断崖恢复：read_context CLI 输出含在途 plan', ctx && ctx.initialized === true
      && Array.isArray(ctx.inFlight.plans) && ctx.inFlight.plans.some((p) => p.file === 'plans/2026-10-27-wip.md'), out.stdout.slice(0, 500));
    check('§10.4', '断崖恢复：INDEX 头部带出 next 指向的下一命令（closeout-l1）', ctx && ctx.index && ctx.index.exists === true
      && ctx.index.head.some((l) => l.includes('closeout-l1.mjs')), JSON.stringify(ctx && ctx.index));
  } finally { rmRepo(d); }
}

/* ================================================================ §10.5 hook 可测 */
{
  const d = mkRepo('hook');
  try {
    initEngine(d);
    const runHook = (payload) => {
      const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', cwd: d });
      let decision = null;
      try { decision = JSON.parse(r.stdout).hookSpecificOutput; } catch { /* 静默放行无决策体 */ }
      return { status: r.status, decision };
    };
    const deny = runHook({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } });
    check('§10.5', 'hook：deny 清单命令（git push -f）→ permissionDecision=deny（exit 0 宿主协议）',
      deny.status === 0 && deny.decision && deny.decision.permissionDecision === 'deny', JSON.stringify(deny));
    const allow = runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    check('§10.5', 'hook：allow 命令（git status）→ 放行（无决策体、exit 0）',
      allow.status === 0 && allow.decision === null, `exit=${allow.status} stdout=${JSON.stringify(allow.decision)}`);
  } finally { rmRepo(d); }
}

/* ================================================================ §10.6 确认指纹可测 */
{
  const d = mkRepo('fingerprint');
  try {
    initEngine(d);
    commitAll(d, 'init engine');
    // confirm（kind task 行）落账并入库——给台账建立提交史（行级校验只覆盖有史路径）
    const cf = jsonOf(mcpCall(d, 1, 'confirm', { task: 'workflow/plans/2026-10-27-fp.md', decision: 'draft→approved', evidence: '用户对话原话：可以' }));
    check('§10.6', '确认指纹：MCP confirm 落 kind:"task" 行', cf && cf.written === true && cf.entry && cf.entry.kind === 'task', JSON.stringify(cf));
    commitAll(d, 'confirm task row');
    let inv = runCli('check-ledger-invariant.mjs', ['--root', d], { cwd: d });
    check('§10.6', '确认指纹：合法 task 行 invariant exit 0（正控制）', inv.status === 0, inv.out.slice(-400));
    // 篡改该行 fingerprint 为乱值（仅工作区，不动历史——命中行级 fingerprint 校验路径）
    const led = path.join(d, '.agents', 'confirmations.jsonl');
    const lines = fs.readFileSync(led, 'utf8').split(/\r?\n/);
    const idx = lines.findIndex((l) => l.trim() && JSON.parse(l).kind === 'task');
    const row = JSON.parse(lines[idx]);
    row.fingerprint = 'deadbeef';
    lines[idx] = JSON.stringify(row);
    fs.writeFileSync(led, lines.join('\n'), 'utf8');
    inv = runCli('check-ledger-invariant.mjs', ['--root', d], { cwd: d });
    check('§10.6', '确认指纹：篡改 task 行 fingerprint → invariant 行级 exit≠0（fingerprint 校验路径，断言名注明：§15 配对面只认 doc 绑定行，task 行的指纹对质走本路径）',
      inv.status !== 0 && inv.out.includes('64 位 hex'), `exit=${inv.status}\n${inv.out.slice(-400)}`);
  } finally { rmRepo(d); }
}

/* ================================================================ §10.7 收敛对账可测（§23） */
{
  const d = mkRepo('convergence');
  const base = '2026-10-13-conv'; // 日期落在 convergenceHardSince（10-12）之后、clarify/coverage 锚（10-22）之前
  try {
    initEngine(d);
    fs.writeFileSync(path.join(d, '.agents', 'config', 'engine.json'), '{"policyVersion":11}\n', 'utf8');
    w(d, `workflow/intents/${base}.md`, `---\n状态: draft\n级别: L2\n日期: 2026-10-13\n模块: pipeline\n---\n# INTENT — conv\n`);
    w(d, `workflow/specs/${base}.md`, `---\n状态: draft\n级别: L2\n日期: 2026-10-13\n模块: pipeline\n---\n# SPEC — conv\n\n## 验收判据\n\n| 判据（可观察行为） | 证据（测试文件 / 命令 / 证据文件） | 状态 |\n|---|---|---|\n| 守卫拒绝超量 | backend/tests/Nope.Tests.cs | 覆盖 |\n`);
    w(d, `workflow/plans/${base}.md`, planDoc('conv', '状态: draft\n级别: L2\n日期: 2026-10-13\n模块: pipeline'));
    const cd = (doc, quote) => runCli('confirm-doc.mjs', [doc, '--delegated', quote, '--root', d], { cwd: d });
    // intent → spec 逐级确认（逐阶段前置门要求入口先确认）；委派台账行（L2 →done 在场门）
    let r = cd(`workflow/intents/${base}.md`, '入口确认，可以');
    check('§10.7', '收敛对账：intent 起草确认 → exit 0', r.status === 0, r.out.slice(-400));
    r = cd(`workflow/specs/${base}.md`, 'spec 确认，可以');
    check('§10.7', '收敛对账：spec 起草确认 → exit 0', r.status === 0, r.out.slice(-400));
    commitAll(d, 'approved trace');
    runCli('ledger-shards.mjs', ['--append', 'delegations', '--section', '委派结果',
      '--row', `| 2026-10-13 | ${base} 判据级收敛对账验证 | 一次通过 | — | — |`], { cwd: d });
    r = cd(`workflow/specs/${base}.md`, 'spec 关单，可以');
    check('§10.7', '收敛对账：spec 关单确认（done 行落账）→ exit 0', r.status === 0, r.out.slice(-400));
    // 状态列自报「覆盖」而证据文件不存在 → §23 hard
    r = runCheckLoop(d);
    check('§10.7', '收敛对账：台账自报覆盖但证据不存在 → exit≠0 且「收敛未覆盖」',
      r.status !== 0 && r.out.includes('收敛未覆盖'), `exit=${r.status}\n${r.out.slice(-600)}`);
    // 修正：证据文件真实存在 → §23 认可
    w(d, 'backend/tests/Nope.Tests.cs', '// fixture evidence\n');
    r = runCheckLoop(d);
    check('§10.7', '收敛对账：补齐证据文件后 → exit 0', r.status === 0, `exit=${r.status}\n${r.out.slice(-600)}`);
  } finally { rmRepo(d); }
}

/* ================================================================ §10.8 回归证据可测（§3x） */
{
  const d = mkRepo('regr');
  const inc = '2026-10-27-regr';
  try {
    initEngine(d);
    w(d, `workflow/incidents/${inc}.md`, `---\n状态: open\n级别: L1\n日期: ${TODAY}\n来源: self\n影响环境: dev\n---\n# INCIDENT — regr\n\n## 时间线\n- ${TODAY} 用户确认：按单点修复处理\n`);
    commitAll(d, 'incident open'); // git 模式下 §3x 的建档日锚 = git 首加日，文档须先入库
    const cd = runCli('confirm-doc.mjs', [`workflow/incidents/${inc}.md`, '--delegated', '修复落地确认，可以', '--root', d], { cwd: d });
    check('§10.8', '回归证据：incident open→fixed 确认 → exit 0', cd.status === 0, cd.out.slice(-400));
    let r = runCheckLoop(d);
    check('§10.8', '回归证据：关单缺回归证据 fixture → exit≠0 且「回归证据缺失」',
      r.status !== 0 && r.out.includes('回归证据缺失'), `exit=${r.status}\n${r.out.slice(-600)}`);
    // 补齐：防复发验证落到自动化用例引用
    const p = path.join(d, 'workflow', 'incidents', `${inc}.md`);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n- 回归用例 acceptance-regr-fixture.test.mjs 已覆盖\n', 'utf8');
    r = runCheckLoop(d);
    check('§10.8', '回归证据：补齐自动化用例引用后 → exit 0', r.status === 0, `exit=${r.status}\n${r.out.slice(-600)}`);
  } finally { rmRepo(d); }
}

/* ================================================================ §10.9 进化环可测 */
{
  // ① 判定流水：跑 N=2 次 check-loop --all 后 judgments.jsonl 行数与 per-rule 计数一致
  {
    const d = mkRepo('judgment');
    try {
      initEngine(d);
      fs.writeFileSync(path.join(d, '.agents', 'config', 'engine.json'), '{"policyVersion":2}\n', 'utf8');
      w(d, 'workflow/intents/2026-10-27-j.md', planDoc('j', '状态: draft\n级别: L1\n日期: 2026-10-27').replace('# PLAN', '# INTENT'));
      w(d, 'workflow/plans/2026-10-27-j.md', planDoc('j', '状态: draft\n级别: L1\n日期: 2026-10-27'));
      // init-engine 装的 pre-commit 钩子会在提交时触发一次 check-loop（hard）——污染「跑 N 次记 N 行」
      // 的计数口径，本夹具卸掉两钩子再入库（git 模式下门禁只扫 tracked 文档）。
      for (const h of ['pre-commit', 'pre-push']) fs.rmSync(path.join(d, '.git', 'hooks', h), { force: true });
      commitAll(d, 'fixture docs');
      runCheckLoop(d, ['--all']);
      runCheckLoop(d, ['--all']);
      const rows = fs.readFileSync(path.join(d, '.agents', 'judgments.jsonl'), 'utf8')
        .split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
      check('§10.9①', '进化环：跑 2 次 check-loop 后 judgments.jsonl 恰 2 行（一运行一行）', rows.length === 2, `rows=${rows.length}`);
      const counts = rows.map((r) => {
        const cell = (r.rules || []).find((x) => x.rule === '逐阶段' && x.level === 'WARN');
        return cell ? cell.count : 0;
      });
      check('§10.9①', '进化环：per-rule 计数与运行次数一致（同夹具每次运行同类告警逐规则同数）',
        rows.length === 2 && counts[0] >= 1 && counts[0] === counts[1], JSON.stringify(counts));
    } finally { rmRepo(d); }
  }
  // ② 退役候选：6+ 个有数据月、候选规则尾部窗口全零命中 → policy_status 识别
  {
    const d = mkRepo('retire');
    try {
      initEngine(d);
      // 7 个有数据月（2026-03..09）：alpha 只在首月命中（尾部窗口 04..09 全零 → 退役候选）；
      // beta 近两月命中（在役）；gamma 各月垫场（保证每月都有运行记录）
      const row = (ym, rule) => JSON.stringify({
        ts: `${ym}-01T00:00:00.000Z`, mode: 'hard', rev: null, blockers: 0, warnings: 1,
        rules: [{ rule, level: 'WARN', count: 1 }],
      });
      const lines = [row('2026-03', 'alpha')];
      for (const ym of ['2026-04', '2026-05', '2026-06', '2026-07']) lines.push(row(ym, 'gamma'));
      lines.push(row('2026-08', 'beta'), row('2026-09', 'beta'));
      fs.writeFileSync(path.join(d, '.agents', 'judgments.jsonl'), lines.join('\n') + '\n', 'utf8');
      const ps = jsonOf(mcpCall(d, 1, 'policy_status', {}));
      const retire = ps && ps.retire;
      check('§10.9②', '进化环：policy_status 读出 7 个数据月（≥6 窗口）', retire && retire.ledgerPresent === true && retire.dataMonths === 7, JSON.stringify(retire));
      check('§10.9②', '进化环：尾部 6 月全零命中的 alpha 被识别为退役候选、在役 beta 不入列',
        retire && Array.isArray(retire.candidates) && retire.candidates.some((c) => c.rule === 'alpha')
        && !retire.candidates.some((c) => c.rule === 'beta'), JSON.stringify(retire && retire.candidates));
    } finally { rmRepo(d); }
  }
  // ③ 棘轮：rule-budgets 上限外新增段文件 → 校验报超限 exit 1；合规数量 exit 0
  {
    const d = mkRepo('ratchet');
    try {
      const secDir = path.join(d, '.agents', 'scripts', 'check-loop-sections');
      fs.mkdirSync(secDir, { recursive: true });
      fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
      fs.writeFileSync(path.join(d, '.agents', 'config', 'rule-budgets.txt'), '.agents/scripts/check-loop-sections/ 2#count\n', 'utf8');
      for (const f of ['a.mjs', 'b.mjs', 'c.mjs']) fs.writeFileSync(path.join(secDir, f), '// fixture\n', 'utf8');
      let r = runCli('rule-budget.mjs', ['--all'], { cwd: d });
      check('§10.9③', '进化环：段文件数 3 > 棘轮上限 2 → exit≠0 且报「条目数」超限',
        r.status !== 0 && r.out.includes('条目数'), `exit=${r.status}\n${r.out.slice(-300)}`);
      fs.rmSync(path.join(secDir, 'c.mjs'));
      r = runCli('rule-budget.mjs', ['--all'], { cwd: d });
      check('§10.9③', '进化环：退役一段至 2/2 后 → exit 0（一进一出）', r.status === 0, `exit=${r.status}\n${r.out.slice(-300)}`);
    } finally { rmRepo(d); }
  }
  // ④ gate-budgets 超限 → advisory 告警出现且 exit 仍为 0（只告警不阻断的口径被锁死）
  {
    const d = mkRepo('budget');
    try {
      initEngine(d);
      fs.writeFileSync(path.join(d, '.agents', 'config', 'gate-budgets.json'), JSON.stringify({ fullMs: 1, scopeMs: 1 }), 'utf8');
      const r = runCli('verify.mjs', ['--stub-gate', 'node -e "process.exit(0)"'], { cwd: d, env: { CHECK_LOOP_ROOT: d, RUN_E2E: '' } });
      check('§10.9④', '进化环：墙钟超预算 → advisory 告警出现（超预算 + 退役一门提示）且 exit 仍为 0',
        r.status === 0 && r.stdout.includes('超预算') && r.stdout.includes('下一批须退役一门'), `exit=${r.status}\n${r.stdout.slice(-400)}`);
    } finally { rmRepo(d); }
  }
}

/* ================================================================ §10.10 工程准入 */
{
  // release.mjs 在市场仓根 scripts/（非插件 scripts/）——显式绝对路径 spawn
  const rel = spawnSync(process.execPath, [path.join(MARKET_ROOT, 'scripts', 'release.mjs'), '--check'],
    { cwd: MARKET_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  check('§10.10', '工程准入：node scripts/release.mjs --check exit 0', rel.status === 0, `${rel.stdout || ''}${rel.stderr || ''}`.slice(-500));

  // 本插件全部测试文件逐个可跑通（循环）。acceptance.mjs（本脚本）与 e2e-fixture.mjs（独立端到端）
  // 不入循环——前者是本条断言的载体（自递归），后者由 CI 单独接线；其余全部覆盖。
  const testDir = path.join(PLUGIN_ROOT, 'test');
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs') && f !== 'acceptance.mjs' && f !== 'e2e-fixture.mjs')
    .map((f) => path.join(testDir, f));
  for (const skill of ['session-resume/scripts/worktree-audit.test.mjs', 'verify-ui/scripts/gen-verify-feature.test.mjs', 'decision-log/scripts/decision-log.test.mjs']) {
    files.push(path.join(PLUGIN_ROOT, 'skills', skill));
  }
  let red = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, [f], { cwd: PLUGIN_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const ok = r.status === 0;
    if (!ok) red.push({ file: path.relative(PLUGIN_ROOT, f), status: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-500) });
    check('§10.10', `工程准入：node ${path.relative(PLUGIN_ROOT, f).split(path.sep).join('/')} exit 0`, ok,
      ok ? '' : red[red.length - 1].tail);
  }
}

/* ================================================================ 汇总 */
const items = [...new Set(results.map((r) => r.item))].sort();
console.log('\n§10 十条对应表：');
for (const item of items) {
  const rs = results.filter((r) => r.item === item);
  const bad = rs.filter((r) => !r.ok).length;
  console.log(`  ${bad ? '✗' : '✓'} ${item.padEnd(8)} ${rs.length} 断言（红 ${bad}）`);
}
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
