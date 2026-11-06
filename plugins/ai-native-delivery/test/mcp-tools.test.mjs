#!/usr/bin/env node
// mcp-tools.test.mjs — MCP 7 工具端到端（spawn mcp/server.mjs，stdio JSON-RPC 往返）
// 断言：tools/list 恰好 7 个具名工具；grade_task 三态；read_context 未初始化/已初始化两态；
//       confirm 落账可解析且 fingerprint 与 confirm-doc.computeFingerprint 同构；
//       confirm 的引文接地与 confirm-doc 同口径（接地留痕 / advisory 默认 / doc 缺失与路径逃逸硬拒 /
//       task 行恒不带 stage）；
//       update_ledger 路径逃逸被拒；verify_gate 在最小 fixture 仓 exit 0；policy_status 返回
//       policyVersion=14；未知工具 / 缺参报 isError。
// 零依赖，Node ≥ 18 直接运行：node test/mcp-tools.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from '../scripts/confirm-doc.mjs';
import { initEngine } from '../scripts/init-engine.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST_DIR, '..', 'mcp', 'server.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// ---- stdio 客户端：一次喂入全部请求行，按 id 收回执 ----
const call = (root, requests) => {
  const input = requests.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [SERVER], { input, encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const replies = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined) replies.set(msg.id, msg);
    } catch { /* 非回执行忽略 */ }
  }
  return { replies, proc: r };
};
const resultOf = (reply) => reply && reply.result && !reply.result.isError
  ? reply.result
  : null;
const jsonOf = (reply) => {
  const res = resultOf(reply);
  if (!res) return null;
  try { return JSON.parse(res.content[0].text); } catch { return null; }
};
const isError = (reply) => Boolean(reply && reply.result && reply.result.isError);

// 夹具 git 调用防瞬时失败（check-loop.test 同款）
const git = (args, cwd) => {
  for (let i = 0; ; i++) {
    const r = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
    if (!r.error && r.status === 0) return r;
    if (i >= 1) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
};
const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-'));
  git(['init', '-q'], d);
  fs.writeFileSync(path.join(d, 'README.md'), 'fixture\n', 'utf8');
  git(['add', '-A'], d);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], d);
  return d;
};

// ---- 会话 1：未初始化仓（无 workflow/）----
const root = mkRepo();
{
  const { replies } = call(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_context', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_ledger', arguments: { file: '../.agents/evil.md', content: 'x', mode: 'create' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'update_ledger', arguments: { file: 'C:/Windows/temp-evil.md', content: 'x', mode: 'create' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'grade_task', arguments: {} } },
  ]);

  const init7 = replies.get(7);
  check('缺 description → isError（required 执行）', isError(init7) && /missing required/.test(init7.result.content[0].text), JSON.stringify(init7 && init7.result));

  const list = replies.get(2);
  const names = (list?.result?.tools || []).map((t) => t.name);
  check('tools/list 恰好 7 个工具', names.length === 7, JSON.stringify(names));
  check('7 个具名工具与设计文档一致', JSON.stringify(names) === JSON.stringify([
    'grade_task', 'read_context', 'update_ledger', 'confirm', 'verify_gate', 'ledger_stats', 'policy_status',
  ]), JSON.stringify(names));
  check('每个工具带 inputSchema', (list?.result?.tools || []).every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  const rc = jsonOf(replies.get(3));
  check('read_context 未初始化 → initialized:false + hint', rc && rc.initialized === false && /init_engine/.test(rc.hint || ''), JSON.stringify(rc));

  check('update_ledger .. 逃逸 → isError', isError(replies.get(4)), JSON.stringify((replies.get(4) || {}).result));
  check('update_ledger 绝对路径 → isError', isError(replies.get(5)), JSON.stringify((replies.get(5) || {}).result));
  // 2026-11-05 同步注明：unknown tool 由「isError 结果」改为 JSON-RPC 规范的 -32602 error 回包
  //（审查 m1 顺带修——isError 结果是「工具执行了但失败」的形态，工具不存在根本没执行，
  //  两者不该共用一个形态；协议层回包对齐姊妹实现 systemone server.mjs 的 RpcError(-32602)）。
  check('未知工具 → -32602 error 回包', replies.get(6)?.error?.code === -32602, JSON.stringify(replies.get(6)));
}

// ---- 显式 root 落在插件根内 → 拒绝（2026-10-29 修复）----
// 旧实现只检查进程 cwd，`requireRoot('<插件安装目录>')` 一路放行：解析出的是该插件所在的
// git 仓库根（本市场仓库），台账与绿凭证于是写进插件自己的仓库——恰好是这道守卫要防的后果
// （插件目录跨项目共享，A 处写出的绿凭证会被 B 处当成关单依据）。
{
  const { requireRoot } = await import('../mcp/core.mjs');
  const pluginRoot = path.resolve(TEST_DIR, '..');
  let rejected = null;
  try {
    requireRoot(pluginRoot);
  } catch (err) {
    rejected = err;
  }
  check('显式 root = 插件根 → 拒绝', rejected !== null && /插件安装目录/.test(rejected.message), rejected ? rejected.message : '(未拒绝)');
  // 反向锚：真实项目根仍然接受（守卫不得把正常用法挡住）
  let accepted = null;
  try {
    accepted = requireRoot(root);
  } catch (err) {
    accepted = `ERR ${err.message}`;
  }
  check('显式 root = 真实项目 → 接受', typeof accepted === 'string' && !accepted.startsWith('ERR'), String(accepted));
}

// ---- 初始化后：会话 2（grade 三态 / confirm / ledger / verify / policy）----
initEngine(root);
{
  const { replies } = call(root, [
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'grade_task', arguments: { description: '修改共享契约：公共接口签名的分页参数默认值' } } },
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'grade_task', arguments: { description: '把登录页标题文案从「用户登录」改为「欢迎登录」' } } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'grade_task', arguments: { description: '订单表新增字段，需要 schema 迁移 SQL' } } },
    { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'confirm', arguments: { task: 'workflow/plans/2026-10-27-mcp.md', decision: 'draft→approved', evidence: '用户对话原话：可以，按这个方案做' } } },
    { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'update_ledger', arguments: { file: 'workflow/papercuts-2026-10.md', content: '# papercuts 10 月\n', mode: 'create' } } },
    { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'update_ledger', arguments: { file: 'workflow/papercuts-2026-10.md', content: '- [x] MCP 工具链端到端补一行', mode: 'append' } } },
    { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'verify_gate', arguments: { lane: 'hard' } } },
    { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'policy_status', arguments: {} } },
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'ledger_stats', arguments: {} } },
  ]);

  const g2 = jsonOf(replies.get(11));
  check('grade_task 契约描述 → L2', g2 && g2.level === 'L2' && g2.hits.length > 0, JSON.stringify(g2));
  const g1 = jsonOf(replies.get(12));
  check('grade_task 页面文案 → L1', g1 && g1.level === 'L1', JSON.stringify(g1));
  const g3 = jsonOf(replies.get(13));
  check('grade_task schema 变更 → L3', g3 && g3.level === 'L3' && g3.hits.length > 0, JSON.stringify(g3));

  // confirm 落账：文件可逐行解析 + 指纹与 confirm-doc 同构
  const ledgerText = fs.readFileSync(path.join(root, '.agents', 'confirmations.jsonl'), 'utf8');
  const rows = ledgerText.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  check('confirm 落账 1 行且可解析', rows.length === 1, ledgerText);
  const expectedFp = computeFingerprint(JSON.stringify({
    task: 'workflow/plans/2026-10-27-mcp.md',
    decision: 'draft→approved',
    evidence: '用户对话原话：可以，按这个方案做',
  }));
  check('confirm fingerprint 与 confirm-doc.computeFingerprint 同构', rows[0] && rows[0].fingerprint === expectedFp, `got ${rows[0] && rows[0].fingerprint}`);
  check('confirm 行带 kind:"task"（台账校验器判别键）', rows[0] && rows[0].kind === 'task', JSON.stringify(rows[0]));
  // 未带 doc 的确认行必须**如实记 unanchored**（2026-10-28 引文接地对齐）：不能留空让审计面
  // 误以为已接地，也不能硬拦（既有调用方与存量语义不变）。
  check('confirm 不带 doc → 行记 quoteGrounding=unanchored 且回传绑定提示',
    rows[0] && rows[0].quoteGrounding === 'unanchored', JSON.stringify(rows[0]));
  check('confirmations.d/ 目录已自动建', fs.existsSync(path.join(root, '.agents', 'confirmations.d')));

  const upd1 = jsonOf(replies.get(16));
  check('update_ledger create 新文件 → written', upd1 && upd1.written === true && fs.existsSync(path.join(root, 'workflow', 'papercuts-2026-10.md')), JSON.stringify(upd1));
  const upd2 = jsonOf(replies.get(17));
  const appended = fs.readFileSync(path.join(root, 'workflow', 'papercuts-2026-10.md'), 'utf8');
  check('update_ledger append 追加成行', upd2 && upd2.written === true && appended.includes('- [x] MCP 工具链端到端补一行'), appended);
  // 原子写（2026-10-27）：tmp+rename —— 台账目录不得残留 .tmp（半写文件的痕迹）
  const tmpLeft = fs.readdirSync(path.join(root, 'workflow')).filter((f) => f.includes('.tmp'));
  check('update_ledger 原子写无 .tmp 残留', tmpLeft.length === 0, JSON.stringify(tmpLeft));

  const vg = jsonOf(replies.get(18));
  check('verify_gate hard 车道 exit 0（最小 fixture 仓）', vg && vg.exitCode === 0 && vg.timedOut === false, JSON.stringify(vg && { exitCode: vg.exitCode, stderr: (vg.stderr || '').slice(0, 400) }));

  const ps = jsonOf(replies.get(19));
  check('policy_status policyVersion=14（初始化后项目侧）', ps && ps.policy && ps.policy.policyVersion === 14 && /项目侧/.test(ps.policy.source || ''), JSON.stringify(ps && ps.policy));
  check('policy_status 棘轮段数 = 上限（22 段种子）', ps && ps.ratchet && ps.ratchet.entries.some((e) => e.name.includes('sections') && e.limit === e.actual), JSON.stringify(ps && ps.ratchet));

  const ls = jsonOf(replies.get(20));
  check('ledger_stats 不变量 ok', ls && ls.invariant && ls.invariant.exitCode === 0, JSON.stringify(ls && ls.invariant));
  check('ledger_stats workflow 体量在场', ls && ls.workflow && typeof ls.workflow.files === 'number' && ls.workflow.files > 0, JSON.stringify(ls && ls.workflow));
}

// ---- 会话 3：confirm 落账后的断崖恢复视图（read_context 见最近确认行）----
{
  const { replies } = call(root, [
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'read_context', arguments: {} } },
  ]);
  const rc = jsonOf(replies.get(21));
  check('read_context 已初始化 → INDEX 在场', rc && rc.initialized === true && rc.index && rc.index.exists === true, JSON.stringify(rc && rc.index));
  check('read_context 在途清单三键齐备', rc && rc.inFlight && Array.isArray(rc.inFlight.plans) && Array.isArray(rc.inFlight.specs) && Array.isArray(rc.inFlight.intents));
  check('read_context 最近确认行字段齐备', rc && Array.isArray(rc.confirmations) && rc.confirmations.length === 1
    && ['ts', 'task', 'decision', 'evidence', 'fingerprint'].every((k) => k in rc.confirmations[0]), JSON.stringify(rc && rc.confirmations));
}

// ---- 会话 4：confirm 的引文接地（2026-10-28 第二轮审查，与 confirm-doc 同口径）----
// 判据来自 quote-grounding.mjs，默认档也一致：接地不成立**只留痕不拦**（advisory），
// 硬拦的只有客观缺陷——doc 不存在、路径逃逸、以及调用方显式 strict_quote。
{
  const DOC = 'workflow/papercuts-2026-10.md'; // 会话 2 建的：正文含「MCP 工具链端到端补一行」
  const grounded = '放行原话：MCP 工具链端到端补一行';
  const unrelated = '把库存盘点模块的批次号规则按季度重置并回填历史单据';
  const { replies } = call(root, [
    { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'confirm', arguments: { task: '接地正例', decision: '用户放行', evidence: grounded, doc: DOC } } },
    { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'confirm', arguments: { task: 'doc 不存在', decision: '用户放行', evidence: grounded, doc: 'workflow/specs/never-exists.md' } } },
    { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'confirm', arguments: { task: '不相干引文', decision: '用户放行', evidence: unrelated, doc: DOC } } },
    { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'confirm', arguments: { task: '不相干引文 strict', decision: '用户放行', evidence: unrelated, doc: DOC, strict_quote: true } } },
    { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'confirm', arguments: { task: '逃逸', decision: '用户放行', evidence: grounded, doc: '../../outside.md' } } },
  ]);
  const ok31 = jsonOf(replies.get(31));
  check('confirm 带 doc + 可对质引文 → 落账且记接地形态',
    ok31 && ok31.written === true && ['verbatim', 'anchor'].includes(ok31.entry.quoteGrounding), JSON.stringify(ok31));
  check('confirm 带 doc → 行内 doc 字段如实记录指向',
    ok31 && ok31.entry.doc === DOC, JSON.stringify(ok31 && ok31.entry));
  // 不变量（2026-10-28）：task 行的 doc 只是**来源注记**，绝不能带 stage。§15 的文档配对判据是
  // `e.doc === rel && VALID_STAGES.has(e.stage)`——一旦 task 行补上 stage，它就会被当成文档确认行，
  // 「任务级确认」随即获得伪造文档关单凭证的能力。这条断言把该绕过面钉死。
  check('task 确认行不得携带 stage（否则进 §15 文档配对集，可伪造关单凭证）',
    ok31 && !('stage' in ok31.entry), JSON.stringify(ok31 && ok31.entry));
  check('confirm doc 不存在 → isError 硬拒（客观缺陷，非语义猜测）',
    isError(replies.get(32)) && /不存在/.test(replies.get(32).result.content[0].text), JSON.stringify(replies.get(32)));
  const ok33 = jsonOf(replies.get(33));
  check('confirm 引文不相干 → advisory 放行并记 quoteGrounding=ungrounded（默认不拦）',
    ok33 && ok33.written === true && ok33.entry.quoteGrounding === 'ungrounded' && /quoteGrounding/.test(ok33.hint || ''),
    JSON.stringify(ok33));
  check('confirm 引文不相干 + strict_quote → isError 拒绝落账',
    isError(replies.get(34)) && /接地不成立/.test(replies.get(34).result.content[0].text), JSON.stringify(replies.get(34)));
  check('confirm doc 路径逃逸 → isError（与 update_ledger 同围栏）',
    isError(replies.get(35)), JSON.stringify(replies.get(35)));

  // 落账面：strict 与逃逸两条**不得**进台账（advisory 那条应在），逐行仍可解析
  const txt = fs.readFileSync(path.join(root, '.agents', 'confirmations.jsonl'), 'utf8');
  const rows = txt.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  check('被拒的确认不落账（5 次调用只落 3 行，台账无半行）', rows.length === 3, txt);
  check('接地留痕行不落 .tmp 残留', fs.readdirSync(path.join(root, '.agents')).filter((f) => f.includes('.tmp')).length === 0);
}

// ---- 并发追加不丢行（2026-10-29 市场审查回归）----
// 旧实现是 read→concat→writeAtomic 且无锁：8 进程各追加 20 行，实测 3 轮分别丢 6/7/19 行，
// 且**每次都返回 written:true**——调用方拿到成功回执、台账里没有那行，事后无从对质。
// 同一轮还出现 3–5 次 `EPERM rename`（两个进程同时 rename 到同一目标必有一方失败）。
// 现在走 appendFileSync（O_APPEND），与同文件 confirm() 路径同口径。
{
  const raceRoot = mkRepo();
  initEngine(raceRoot);
  const WORKERS = 8;
  const PER_WORKER = 20;
  const TOTAL = WORKERS * PER_WORKER;
  // 每个 worker 一个独立进程、各自开一次 MCP 会话：并发发生在进程之间
  // （真实形态是多个 agent 会话同时写同一台账）。
  const worker = path.join(raceRoot, 'race-worker.mjs');
  fs.writeFileSync(worker, `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const [server, root, wid, n, outFile] = process.argv.slice(2);
const reqs = [];
for (let i = 0; i < Number(n); i++) {
  reqs.push({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'update_ledger', arguments: {
    file: 'workflow/papercuts-2026-10.md', mode: 'append', content: \`- racer \${wid}-\${i}\` } } });
}
const r = spawnSync(process.execPath, [server], {
  input: reqs.map((x) => JSON.stringify(x)).join('\\n') + '\\n',
  encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024 });
const acked = [];
for (const line of (r.stdout || '').split('\\n')) {
  if (!line.trim()) continue;
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  if (!msg || msg.id === undefined || !msg.result || msg.result.isError) continue;
  let payload; try { payload = JSON.parse(msg.result.content[0].text); } catch { continue; }
  if (payload && payload.written === true) acked.push(msg.id);
}
fs.writeFileSync(outFile, JSON.stringify({ acked: acked.length }));
`, 'utf8');

  const { spawn } = await import('node:child_process');
  const runs = [];
  for (let w = 0; w < WORKERS; w++) {
    const ackFile = path.join(raceRoot, `ack-${w}.json`);
    runs.push(new Promise((resolve) => {
      const c = spawn(process.execPath, [worker, SERVER, raceRoot, String(w), String(PER_WORKER), ackFile], {
        cwd: raceRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      c.on('exit', () => resolve(ackFile));
      c.on('error', () => resolve(ackFile));
    }));
  }
  await Promise.all(runs);

  let ackedTotal = 0;
  for (let w = 0; w < WORKERS; w++) {
    try {
      ackedTotal += JSON.parse(fs.readFileSync(path.join(raceRoot, `ack-${w}.json`), 'utf8')).acked || 0;
    } catch { /* worker 崩了就是 0 条 ack */ }
  }
  const ledgerFile = path.join(raceRoot, 'workflow', 'papercuts-2026-10.md');
  const text = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '';
  const racerLines = text.split(/\r?\n/).filter((l) => l.includes('- racer '));
  const unique = new Set(racerLines);
  check(
    `并发 ${WORKERS}×${PER_WORKER} 追加无丢行（落盘 ${unique.size}/${TOTAL}，自称成功 ${ackedTotal}）`,
    unique.size === TOTAL && ackedTotal === TOTAL,
    `重复/粘连 ${racerLines.length - unique.size} 行`,
  );
  check('并发追加后每行仍自成一行（无粘连半行）', racerLines.every((l) => /^- racer \d+-\d+$/.test(l)), JSON.stringify(racerLines.slice(0, 5)));
  check('并发追加不残留 .tmp', fs.readdirSync(path.join(raceRoot, 'workflow')).filter((f) => f.includes('.tmp')).length === 0);
  fs.rmSync(raceRoot, { recursive: true, force: true });
}

// ---- resolveLedgerTarget 符号链接逃逸（2026-10-31 市场审查）----
// path.resolve 不解引用：`workflow/<symlink>/x` 指向树外时白名单按字面路径放行，写却落在
// workflow/ 之外。解引用后须重走 containment + workflow 白名单；指向树内的 symlink 不受影响。
// Windows 无符号链接特权时整段跳过（junction 型不需要特权，通常可达）。
{
  const { resolveLedgerTarget, ToolError } = await import('../mcp/core.mjs');
  const sroot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-symlink-'));
  fs.mkdirSync(path.join(sroot, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(sroot, '.agents'), { recursive: true });
  const throws = (fn) => {
    try { fn(); return null; } catch (e) { return e; }
  };
  try {
    fs.symlinkSync(path.join(sroot, '.agents'), path.join(sroot, 'workflow', 'leak'), 'junction');
    fs.symlinkSync(path.join(sroot, 'workflow', 'intents'), path.join(sroot, 'workflow', 'alias'), 'junction');
    const out = throws(() => resolveLedgerTarget(sroot, 'workflow/leak/x.md'));
    check('symlink 指向 workflow 外 → 拒（解引用后判）', out instanceof ToolError || (out && /逃逸|离开/.test(String(out.message))), String(out && out.message));
    const inside = throws(() => resolveLedgerTarget(sroot, 'workflow/alias/2026-10-31-a.md'));
    check('symlink 指向 workflow 内 → 放行', inside === null, String(inside && inside.message));
    const plain = throws(() => resolveLedgerTarget(sroot, 'workflow/intents/2026-10-31-a.md'));
    check('无 symlink 的常规路径不受影响', plain === null, String(plain && plain.message));
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      console.log('SKIP  符号链接用例（本机无创建权限）');
    } else {
      throw e;
    }
  } finally {
    fs.rmSync(sroot, { recursive: true, force: true });
  }
}

// ---- 协议层闸门：无 id / 非法 id / 版本外（2026-11-05 市场审查）----
// 此前：无 id 通知被回包（且回包缺 id 字段，宿主无法配对）、无 id tools/call 照样执行副作用
// 工具、非法对象 id 原样回显。修复后（照 systemone server.mjs 四道闸）：无 id 一律不回包且
// 不执行工具（通知语义不触发工具）；id 非字符串/数字拒收；jsonrpc 版本白名单外拒收。
{
  const { replies: gate, proc } = call(root, [
    { jsonrpc: '2.0', method: 'ping' }, // 通知（无 id）→ 不回包
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'update_ledger', arguments: { file: 'workflow/gate-echo.md', content: 'must not exist\n', mode: 'create' } } }, // 通知 → 不执行副作用工具
    { jsonrpc: '1.0', id: 'old', method: 'ping' }, // 版本白名单外 → 拒收
    { jsonrpc: '2.0', id: { bad: 1 }, method: 'ping' }, // 非法 id（对象）→ 拒收，不回显
    { jsonrpc: '2.0', id: true, method: 'ping' }, // 非法 id（布尔）→ 拒收
    { jsonrpc: '2.0', id: 'alive', method: 'ping' }, // 闸门之后服务照常应答
  ]);
  const lines = (proc.stdout || '').split('\n').filter((l) => l.trim());
  check('协议闸门后恰好 1 条回包（无 id / 非法 id / 版本外全部静默）',
    lines.length === 1 && Boolean(gate.get('alive')), proc.stdout);
  check('无 id tools/call → 副作用未发生', !fs.existsSync(path.join(root, 'workflow', 'gate-echo.md')),
    fs.readdirSync(path.join(root, 'workflow')).join(','));
}

// ---- schema 类型/枚举执行（2026-11-05 市场审查）----
// 此前协议层只查未知键与 required，schema 声明的 type/enum 完全不执行：doc:123 静默丢弃、
// strict_quote:"yes" 静默按 false、update_ledger content:123 落盘 "123\n"。修复后类型/枚举在
// 协议层拒收（错误消息点名参数/期望/实际），handler 侧宽松兜底保留作防御纵深。
{
  const { replies: types } = call(root, [
    { jsonrpc: '2.0', id: 'ty1', method: 'tools/call', params: { name: 'confirm', arguments: { task: 't', decision: 'd', evidence: 'e', doc: 123 } } },
    { jsonrpc: '2.0', id: 'ty2', method: 'tools/call', params: { name: 'confirm', arguments: { task: 't', decision: 'd', evidence: 'e', strict_quote: 'yes' } } },
    { jsonrpc: '2.0', id: 'ty3', method: 'tools/call', params: { name: 'update_ledger', arguments: { file: 'workflow/type-echo.md', content: 123, mode: 'append' } } },
    { jsonrpc: '2.0', id: 'ty4', method: 'tools/call', params: { name: 'verify_gate', arguments: { lane: 'turbo' } } },
  ]);
  const textOf = (id) => {
    const r = types.get(id);
    return r && r.result && Array.isArray(r.result.content) ? r.result.content[0].text : '';
  };
  check('doc:123 → 参数错（点名参数与 string/number）',
    isError(types.get('ty1')) && /"doc"/.test(textOf('ty1')) && /string/.test(textOf('ty1')) && /number/.test(textOf('ty1')),
    JSON.stringify(types.get('ty1')));
  check('strict_quote:"yes" → 参数错（点名 boolean）',
    isError(types.get('ty2')) && /"strict_quote"/.test(textOf('ty2')) && /boolean/.test(textOf('ty2')),
    JSON.stringify(types.get('ty2')));
  check('content:123 → 参数错（且未落盘）',
    isError(types.get('ty3')) && /"content"/.test(textOf('ty3')) && !fs.existsSync(path.join(root, 'workflow', 'type-echo.md')),
    JSON.stringify(types.get('ty3')));
  check('lane:"turbo" → 枚举错（点名参数与候选）',
    isError(types.get('ty4')) && /"lane"/.test(textOf('ty4')) && /hard/.test(textOf('ty4')),
    JSON.stringify(types.get('ty4')));
}

// ---- stdout EPIPE：宿主销毁读端 → 静默 exit 0（2026-11-05 市场审查）----
// server.mjs 此前无 stdout error 处理：宿主正常关停时挂起的 write 抛 EPIPE → uncaught 崩栈
// exit 1。修复后 EPIPE 静默 exit 0（口径同 systemone server.mjs），其余异常记 stderr 后退出。
{
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTxt = '';
    child.stderr.on('data', (c) => { stderrTxt += c; });
    // 回包洪流压进管道后立刻销毁读端：挂起/排队中的 write 必撞断管（单条 ping 有冲掉前先完成竞态）
    const flood = [];
    for (let i = 0; i < 300; i++) flood.push(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }));
    child.stdin.write(flood.join('\n') + '\n');
    child.stdout.destroy();
    const guard = setTimeout(() => child.kill(), 8000);
    child.on('exit', (code) => { clearTimeout(guard); resolve({ code, stderrTxt }); });
    child.on('error', () => { clearTimeout(guard); resolve({ code: -1, stderrTxt }); });
  });
  check('宿主销毁 stdout 读端 → exit 0（EPIPE 静默，不崩栈）', out.code === 0,
    `exit=${out.code} stderr=${out.stderrTxt.slice(0, 200)}`);
  check('stderr 无 EPIPE 崩栈痕迹', !/EPIPE/.test(out.stderrTxt), out.stderrTxt.slice(0, 200));
}

// ---- 单行上限：>1MiB 的行拒收回 -32700（2026-11-05 收尾批 ①）----
// 移植姊妹实现 plugins/systemone-decision/mcp/server.mjs 的 LINE_MAX_BYTES 先例：旧实现用
// readline，一行迟迟不出现换行时（宿主异常灌数据/管道错位）行缓冲无限累积直到吃光内存。
// 修复后超限行（含未完结尾的半行）直接拒收并回 JSON-RPC 约定的 Parse error（id=null：行级
// 超限无法可靠解析出 id），拒收后清缓冲，服务对后续行照常应答。
{
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutTxt = '';
    let stderrTxt = '';
    child.stdout.on('data', (c) => { stdoutTxt += c; });
    child.stderr.on('data', (c) => { stderrTxt += c; });
    const big = 'a'.repeat(1024 * 1024 + 100);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'big', method: 'ping', pad: big }) + '\n');
    child.stdin.write(big); // 无换行的超限尾巴：旧 readline 在此无限缓冲
    child.stdin.write('\n' + JSON.stringify({ jsonrpc: '2.0', id: 'after', method: 'ping' }) + '\n');
    child.stdin.end();
    const guard = setTimeout(() => child.kill(), 10000);
    child.on('exit', () => { clearTimeout(guard); resolve({ stdoutTxt, stderrTxt }); });
    child.on('error', () => { clearTimeout(guard); resolve({ stdoutTxt, stderrTxt }); });
  });
  const frames = [];
  for (const line of out.stdoutTxt.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && (m.id !== undefined || m.error)) frames.push(m);
    } catch { /* 非回执行忽略 */ }
  }
  const parseErrs = frames.filter((m) => m.error && m.error.code === -32700 && m.id === null);
  check('超限行 → -32700 Parse error（id=null）恰好 2 帧（完整行 + 无换行尾巴），不再按正常请求应答',
    parseErrs.length === 2 && !frames.some((m) => m.id === 'big' && m.result),
    JSON.stringify(frames.map((m) => ({ id: m.id, code: m.error && m.error.code, hasResult: !!m.result }))));
  check('超限拒收后服务照常应答后续行（id=after 正常回包）', frames.some((m) => m.id === 'after' && m.result), out.stdoutTxt.slice(0, 200));
  check('超限拒收不产生崩栈 stderr', !/uncaught|EPIPE/i.test(out.stderrTxt), out.stderrTxt.slice(0, 200));
}

// ---- 协议版本协商 + 裸 initialized 带 id 回包（2026-11-05 收尾批 ②）----
// initialize 只认单一版本时，客户端报**受支持的旧版本**（2025-03-26）也被回落声明——等于对
// 受支持版本谎报不兼容；照姊妹实现收成版本列表（支持则原样回显，未知才回落）。裸 initialized
// 以请求形态（带 id）到达时旧实现不回包，客户端挂到自己的超时；修复后回空 result。标准通知
// 形态（notifications/initialized，无 id）仍不回包（id 闸拦截，进不了分派）。
{
  const { replies: nego, proc: negoProc } = call(root, [
    { jsonrpc: '2.0', id: 'v1', method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 'v2', method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    { jsonrpc: '2.0', id: 'initdone', method: 'initialized' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'nego-alive', method: 'ping' },
  ]);
  check('受支持的旧版本 2025-03-26 → 原样回显（不回落）',
    nego.get('v1')?.result?.protocolVersion === '2025-03-26', JSON.stringify(nego.get('v1')));
  check('未知版本 1999-01-01 → 回落声明 2025-06-18',
    nego.get('v2')?.result?.protocolVersion === '2025-06-18', JSON.stringify(nego.get('v2')));
  check('裸 initialized 带 id → 回空 result（客户端不再挂到超时）',
    nego.get('initdone') && nego.get('initdone').result !== undefined && !nego.get('initdone').error,
    JSON.stringify(nego.get('initdone')));
  const negoLines = (negoProc.stdout || '').split('\n').filter((l) => l.trim());
  check('通知形态（无 id）仍不回包：恰好 4 条回包（v1/v2/initdone/nego-alive）',
    negoLines.length === 4 && Boolean(nego.get('nego-alive')), negoProc.stdout);
}

// ---- append 前置探测与回执统计的失败面（2026-11-05 收尾批 ④⑤）----
// 进程内直驱 core.toolUpdateLedger，以 fs.statSync 桩注入读失败（EACCES 在常规夹具里造不出来；
// ESM 侧 node:fs 的默认导出与 core.mjs 共享同一对象，桩只在断言窗口挂上、用完即还原）。
{
  const core = await import('../mcp/core.mjs');
  const realStat = fs.statSync.bind(fs);

  // ④ 末字节探测读失败（非 ENOENT）→ 响亮抛错：旧实现把 EACCES 一并 catch 成「无前导换行」，
  // 文件尾半行会被新内容直接粘连（坏行进台账）。修复后只把 ENOENT 当「文件不存在」。
  fs.statSync = (p, ...rest) => {
    if (String(p).endsWith('probe-deny.md')) { const e = new Error('EACCES: permission denied (test stub)'); e.code = 'EACCES'; throw e; }
    return realStat(p, ...rest);
  };
  let probeErr = null;
  try { core.toolUpdateLedger({ root, file: 'workflow/probe-deny.md', content: '- x', mode: 'append' }); } catch (e) { probeErr = e; }
  fs.statSync = realStat;
  check('append 末字节探测读失败 → 响亮抛错（ToolError 点名探测）',
    probeErr instanceof core.ToolError && /末字节探测/.test(probeErr.message),
    probeErr ? `${probeErr.name}: ${probeErr.message.slice(0, 120)}` : '(未抛错——静默按无换行追加)');
  check('append 探测失败 → 数据未落盘（不粘半行）',
    !fs.existsSync(path.join(root, 'workflow', 'probe-deny.md')),
    fs.existsSync(path.join(root, 'workflow', 'probe-deny.md')) ? '文件被创建（探测失败被吞后照写）' : '');

  // 反向锚：ENOENT（目标不存在）仍按「文件不存在：直接追加」——首次建文件不被误伤
  const payloadOf = (r) => { try { return JSON.parse(r.content[0].text); } catch { return null; } };
  const enoentR = payloadOf(core.toolUpdateLedger({ root, file: 'workflow/probe-new.md', content: '- first', mode: 'append' }));
  check('append 目标不存在（ENOENT）→ 正常建文件追加',
    enoentR && enoentR.written === true && fs.readFileSync(path.join(root, 'workflow', 'probe-new.md'), 'utf8').includes('- first'),
    JSON.stringify(enoentR));

  // ⑤ 追加**成功后**的回执 stat 失败 → 回执降级「已追加（大小未知）」而非 isError：数据已落盘，
  // 报错等于回执与磁盘状态相反。桩按调用计数：第 1 次（探测步）放行、第 2 次（回执步）抛 EACCES。
  const target5 = path.join(root, 'workflow', 'receipt-stat.md');
  fs.writeFileSync(target5, '', 'utf8'); // 空文件：探测步不读末字节，stat 恰好只在回执处二次触桩
  let statCalls = 0;
  fs.statSync = (p, ...rest) => {
    if (String(p) === target5 && ++statCalls >= 2) { const e = new Error('EACCES after append (test stub: compact/archive moved it)'); e.code = 'EACCES'; throw e; }
    return realStat(p, ...rest);
  };
  let r5 = null;
  let receiptErr = null;
  try { r5 = payloadOf(core.toolUpdateLedger({ root, file: 'workflow/receipt-stat.md', content: '- line', mode: 'append' })); } catch (e) { receiptErr = e; }
  fs.statSync = realStat;
  check('append 成功后回执 stat 失败 → 仍 written:true（bytesUnknown，大小未知），不报错',
    receiptErr === null && r5 && r5.written === true && r5.bytesUnknown === true,
    JSON.stringify({ r5, err: receiptErr && receiptErr.message.slice(0, 120) }));
  check('append 成功后回执 stat 失败 → 数据确实落盘', fs.readFileSync(target5, 'utf8').includes('- line'), fs.readFileSync(target5, 'utf8'));
}

// ---- gate-budgets.json fullMs 封顶（2026-11-05 收尾批 ⑥）----
// fullMs 只验 >0 时项目可写 1e12——verify_gate 的 spawnSync 是**串行**的，单线程服务会被一次
// 自定预算拖住数小时，其余请求全部饿死。修复后按同文件预算常量量级封顶（600_000），越界按
// 封顶执行并 stderr 告警，让「成本异动」可见而不是默默变慢/变死。
{
  const capRoot = mkRepo();
  initEngine(capRoot);
  fs.mkdirSync(path.join(capRoot, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(capRoot, '.agents', 'config', 'gate-budgets.json'), JSON.stringify({ fullMs: 1e12 }), 'utf8');
  const t0 = Date.now();
  const { replies: cap, proc: capProc } = call(capRoot, [
    { jsonrpc: '2.0', id: 'cap1', method: 'tools/call', params: { name: 'verify_gate', arguments: { lane: 'hard' } } },
  ]);
  const vg = jsonOf(cap.get('cap1'));
  check('fullMs=1e12 → verify_gate 按封顶预算照常执行完（不被自定预算拖死）',
    vg && vg.timedOut === false && Date.now() - t0 < 120_000,
    JSON.stringify(vg && { exitCode: vg.exitCode, timedOut: vg.timedOut }));
  check('fullMs=1e12 → stderr 点名封顶与上限值 600000',
    /超过封顶/.test(capProc.stderr || '') && /600[_.]?000/.test(capProc.stderr || ''), (capProc.stderr || '').slice(-400));
  // 反向锚：合规预算（种子标定值 30000）不告警
  fs.writeFileSync(path.join(capRoot, '.agents', 'config', 'gate-budgets.json'), JSON.stringify({ fullMs: 30000 }), 'utf8');
  const { proc: okProc } = call(capRoot, [
    { jsonrpc: '2.0', id: 'cap2', method: 'tools/call', params: { name: 'verify_gate', arguments: { lane: 'hygiene' } } },
  ]);
  check('fullMs 合规 → 无封顶告警', !/超过封顶/.test(okProc.stderr || ''), (okProc.stderr || '').slice(-200));
  fs.rmSync(capRoot, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
