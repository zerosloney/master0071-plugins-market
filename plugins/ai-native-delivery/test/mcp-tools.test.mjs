#!/usr/bin/env node
// mcp-tools.test.mjs — MCP 7 工具端到端（spawn mcp/server.mjs，stdio JSON-RPC 往返）
// 断言：tools/list 恰好 7 个具名工具；grade_task 三态；read_context 未初始化/已初始化两态；
//       confirm 落账可解析且 fingerprint 与 confirm-doc.computeFingerprint 同构；
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
  check('未知工具 → isError', isError(replies.get(6)), JSON.stringify((replies.get(6) || {}).result));
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

console.log(`\n${pass} 通过 / ${fail} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
