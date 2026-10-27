#!/usr/bin/env node
// e2e-fixture.mjs — 样板仓端到端（设计文档 §9 MVP 退出判据的「样板仓实测一轮闭环」；2026-10-27）
// 从零构造临时 git 仓，走完 L1 协作道全生命周期，全程断言无 crash、终态一致：
//   init-engine → grade_task(L1 描述) → fill-plan 建最小 L1 plan → confirm 两次
//   → verify_gate(hard) exit 0 → read_context 报在途 1 → closeout-l1 关单
//   → verify_gate 再跑 exit 0 → ledger_stats 体量 > 0
// 入口口径：宿主侧走 MCP stdio（grade_task / confirm / verify_gate / read_context / ledger_stats），
//   命令侧走 CLI（init-engine / fill-plan / confirm-doc / verify / closeout-l1）——与真实使用一致。
// 确认两次 = ① MCP confirm（任务级确认，kind:"task" 行）+ ② confirm-doc 起草确认（draft→approved，
//   台账配对行）；关单确认由 closeout-l1 内部经 confirm-doc 完成（approved→done）。
// 用法：node test/e2e-fixture.mjs（可重复跑——夹具为独立临时仓，跑完清理）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(TEST_DIR, '..');
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};
const step = (name) => console.log(`\n---- ${name} ----`);

const git = (args, cwd) => {
  for (let i = 0; ; i++) {
    const r = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
    if (!r.error && r.status === 0) return r;
    if (i >= 1) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').slice(0, 300)}`);
  }
};
const runCli = (script, args, opts = {}) => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: opts.cwd ?? PLUGIN_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
};
const jsonOf = (reply) => {
  try {
    const res = reply && reply.result && !reply.result.isError ? reply.result : null;
    return res ? JSON.parse(res.content[0].text) : null;
  } catch { return null; }
};
const callMcp = (root, id, name, args = {}) => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    '',
  ].join('\n');
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'mcp', 'server.mjs')], {
    input, encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024,
  });
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id === id) return msg;
    } catch { /* 非回执行忽略 */ }
  }
  return null;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fixture-'));
try {
  /* ---- ① 从零建仓 + init-engine ---- */
  step('① init-engine');
  git(['init', '-q'], root);
  fs.writeFileSync(path.join(root, 'README.md'), '样板仓端到端夹具\n', 'utf8');
  git(['add', '-A'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], root);
  const init = runCli('init-engine.mjs', ['--root', root], { cwd: root });
  check('init-engine CLI exit 0（幂等种子落位）', init.status === 0, init.out.slice(-400));
  check('workflow/ 台账骨架与 .agents/config 种子在场',
    fs.existsSync(path.join(root, 'workflow', 'plans'))
    && fs.existsSync(path.join(root, '.agents', 'config', 'engine.json')), init.out.slice(0, 300));

  /* ---- ② grade_task：L1 描述 → L1 ---- */
  step('② grade_task');
  const g = jsonOf(callMcp(root, 1, 'grade_task', { description: '把登录页标题文案从「用户登录」改为「欢迎登录」' }));
  check('grade_task L1 描述 → L1（MCP stdio）', g && g.level === 'L1', JSON.stringify(g));

  /* ---- ③ fill-plan 建最小 L1 plan（closeout-l1.test 夹具形态）---- */
  step('③ fill-plan');
  const planRel = 'workflow/plans/2026-10-27-e2e-demo.md';
  const fp = runCli('fill-plan.mjs', ['--level', 'L1', '--topic', 'e2e-demo', '--output', planRel, '--root', root], { cwd: root });
  check('fill-plan L1 草稿生成 → exit 0', fp.status === 0, fp.out.slice(-300));
  // 承诺面内容在起草确认**前**回填（承诺面绑定门：approved 后改承诺须重新点头）；
  // 验收勾验与证据回填留在 approved 后（关单期合法动作，commitmentFingerprint 归一口径）。
  const planAbs = path.join(root, planRel);
  let planText = fs.readFileSync(planAbs, 'utf8');
  planText = planText
    .replace('- <文件/组件>：<做什么；判据细节直接写进条目，如「L771 message.success 改『更新成功』」>',
      '- web/views/login.vue：标题文案「用户登录」改「欢迎登录」（loginTitle 常量单点改动）')
    .replace('- 约束：<对照 AGENTS.md 红线，说明如何满足；不许动什么>', '- 约束：纯文案常量，不触接口/schema/共享口径（两问③：L1）')
    .replace('- 风险：<潜在影响 / 破坏性风险>', '- 风险：低（无逻辑改动，UI 实测即可回退）')
    // 验收判据文本属于承诺面——批准前写定；批准后只允许勾选 + 证据回填（归一口径）
    .replace('- [ ] <逐条可测试；写不出判据 = 还没想清楚>', '- [ ] 登录页标题显示「欢迎登录」');
  fs.writeFileSync(planAbs, planText, 'utf8');
  check('plan 承诺面（改动方案/约束/风险/判据）已回填',
    planText.includes('loginTitle') && planText.includes('纯文案常量') && planText.includes('- [ ] 登录页标题显示「欢迎登录」'));

  /* ---- ④ confirm 两次 ---- */
  step('④ confirm ×2');
  const c1 = jsonOf(callMcp(root, 2, 'confirm', {
    task: planRel, decision: 'draft→approved（改动方案过目放行）', evidence: '用户对话原话：可以，就这么改',
  }));
  check('confirm ①（MCP 任务级）落 kind:"task" 行', c1 && c1.written === true && c1.entry && c1.entry.kind === 'task', JSON.stringify(c1));
  const c2 = runCli('confirm-doc.mjs', [planRel, '--delegated', '可以，按这份方案做', '--root', root], { cwd: root });
  check('confirm ②（confirm-doc 起草确认）→ exit 0 且 plan 转 approved', c2.status === 0
    && /状态: approved/.test(fs.readFileSync(planAbs, 'utf8')), c2.out.slice(-400));
  // approved 态先入库（doneGateFor：→done 须 git 历史留痕「状态: approved」——先 done 后提交会被拒）
  git(['add', '-A'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'plan approved'], root);

  /* ---- ⑤ verify_gate(hard) ---- */
  step('⑤ verify_gate hard（关单前）');
  const v1 = jsonOf(callMcp(root, 3, 'verify_gate', { lane: 'hard' }));
  check('verify_gate hard → exit 0（approved L1 plan 闭环证据齐）', v1 && v1.exitCode === 0 && v1.timedOut === false,
    JSON.stringify(v1 && { exitCode: v1.exitCode, stderr: (v1.stderr || '').slice(-500) }));

  /* ---- ⑥ read_context：在途 1 ---- */
  step('⑥ read_context');
  const rc = jsonOf(callMcp(root, 4, 'read_context', {}));
  check('read_context 报在途 1（approved plan ∈ 活跃集）', rc && rc.initialized === true
    && rc.inFlightCount === 1 && rc.inFlight.plans.some((p) => p.file === 'plans/2026-10-27-e2e-demo.md'),
    JSON.stringify(rc && rc.inFlight));

  /* ---- ⑦ closeout-l1 关单 ---- */
  step('⑦ closeout-l1');
  // 勾验收 + 证据回填（关单期合法动作——commitmentFingerprint 归一口径：勾选态与「（证据：…）」尾注不改承诺面），
  // 再补 24h 内 verify 绿凭证（stub 夹具门走生产尾段落账）
  planText = fs.readFileSync(planAbs, 'utf8')
    .replace('- [ ] 登录页标题显示「欢迎登录」', '- [x] 登录页标题显示「欢迎登录」（证据：UI 实测 login 页截图比对 PASS）');
  fs.writeFileSync(planAbs, planText, 'utf8');
  const vg = runCli('verify.mjs', ['--stub-gate', 'node -e "process.exit(0)"'], { cwd: root, env: { CHECK_LOOP_ROOT: root, RUN_E2E: '' } });
  check('verify 夹具单门全绿 → 绿凭证落账（exit 0）', vg.status === 0
    && fs.existsSync(path.join(root, '.agents', 'verifications.jsonl')), vg.out.slice(-300));
  const co = runCli('closeout-l1.mjs', [planRel, '--delegated', '验收都过了，关单', '--root', root], { cwd: root });
  check('closeout-l1 执行关单 → exit 0', co.status === 0, co.out.slice(-600));
  // 关单即随确认滚动归档：活跃层原路径消失，终态 done 落 workflow/archive/<月>/plans/
  const archiveRel = path.join('workflow', 'archive', TODAY.slice(0, 7), 'plans', '2026-10-27-e2e-demo.md');
  const archivedText = (() => { try { return fs.readFileSync(path.join(root, archiveRel), 'utf8'); } catch { return ''; } })();
  check('plan 终态 done 且已随关单归档（活跃层原路径消失）',
    /状态: done/.test(archivedText) && !fs.existsSync(planAbs), `archive=${archiveRel}\n${co.out.slice(-300)}`);

  /* ---- ⑧ verify_gate 再跑 + read_context 终态 ---- */
  step('⑧ 关单后终态');
  const v2 = jsonOf(callMcp(root, 5, 'verify_gate', { lane: 'hard' }));
  check('verify_gate hard 再跑 → exit 0（done plan 仍闭环）', v2 && v2.exitCode === 0 && v2.timedOut === false,
    JSON.stringify(v2 && { exitCode: v2.exitCode, stderr: (v2.stderr || '').slice(-500) }));
  const rc2 = jsonOf(callMcp(root, 6, 'read_context', {}));
  check('read_context 终态一致：在途归零', rc2 && rc2.initialized === true && rc2.inFlightCount === 0,
    JSON.stringify(rc2 && rc2.inFlightCount));

  /* ---- ⑨ ledger_stats ---- */
  step('⑨ ledger_stats');
  const ls = jsonOf(callMcp(root, 7, 'ledger_stats', {}));
  check('ledger_stats workflow 体量 > 0 且不变量 ok', ls && ls.workflow && ls.workflow.files > 0
    && ls.invariant && ls.invariant.exitCode === 0, JSON.stringify(ls && { workflow: ls.workflow, invariant: ls.invariant }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
