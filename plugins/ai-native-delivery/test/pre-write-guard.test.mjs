#!/usr/bin/env node
// pre-write-guard.test.mjs — PreToolUse 写前门黑盒测试（2026-11-12 写前门移植配套；spawn hook 进程喂 stdin JSON）
// 断言分组：
//   A 执法面自保护：.agents/ 门禁面写 → deny（config/scripts/settings 形态）；RUNTIME_DIRS 运行时目录
//     → 放（口径单源 install/plan.mjs，五目录全过）；Edit 删改门禁面同拒；仓外路径不管辖。
//   B 三本审计账 append-only：追加（Write / Edit 末行扩展 / MultiEdit）→ 放；整写 / 删改 → 拒；
//     分片 confirmations.d/* 直编即拒（不在追例外）；缺文件首次追加 → 放。
//   C fail-closed：file_path 缺失 / 坏 JSON / 空 stdin / 非对象 JSON / 输入截断 / 内部故障注入口 /
//     项目根解析不出 → 全部转 ask（绝不静默放行）。
//   D 管辖与协议形状：非写工具 / TodoWrite / mcp__* 静默放行；驼峰宿主名（MultiEdit / NotebookEdit）
//     照管；deny/ask 决策体 = hookSpecificOutput{hookEventName, permissionDecision, permissionDecisionReason}。
// 运行：node test/pre-write-guard.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(TEST_DIR, '..', 'hooks', 'pre-write-guard.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// runGuard(payload, cwd, env)：payload 传对象自动 JSON 化，传字符串原样喂（坏 JSON / 截断场景用）。
// cwd=项目根（hook 经 paths.findProjectRoot 从 cwd 锚定根，与 pretool-risk 同口径）。
const runGuard = (payload, cwd, env = {}) => spawnSync(process.execPath, [GUARD], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  encoding: 'utf8',
  cwd,
  env: { ...process.env, ...env },
});
const decisionOf = (r) => {
  try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; }
};
// 静默放行 = exit 0 且 stdout 无决策体（宿主协议：permit 不输出）
const silentPermit = (r) => r.status === 0 && String(r.stdout).trim() === '';
// 决策体形状（deny/ask 共用判据）：exit 0 + 三字段齐 + 事件名/决策值合法 + 理由非空
const shapeOk = (r, want) => {
  const d = decisionOf(r);
  return r.status === 0 && d && d.hookEventName === 'PreToolUse' && d.permissionDecision === want
    && typeof d.permissionDecisionReason === 'string' && d.permissionDecisionReason.length > 0;
};

// 夹具仓：.agents/ 门禁面（config + 分片 + 三账本）一次建齐并 base 提交
const mkRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-write-guard-'));
  const g = (args) => {
    const r = spawnSync(GIT, args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture git 失败: git ${args.join(' ')}\n${r.stderr}`);
    return r;
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'confirmations.d'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), '{"gate":"on"}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), 'c1\n', 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'judgments.jsonl'), 'j1\n', 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'verifications.jsonl'), 'v1\n', 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.d', 'x.jsonl'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src.js'), 'console.log(1)\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  return root;
};
const writePayload = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });
const editPayload = (file_path, old_string, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, old_string, new_string } });

// ---- A 执法面自保护 ----
{
  const root = mkRepo();
  const r = runGuard(writePayload('.agents/config/engine.json', '{"gate":"off"}\n'), root);
  check('A1 写 .agents/config/engine.json → deny', shapeOk(r, 'deny'), `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  check('A1 deny 理由点名执法面自保护', /执法面自保护/.test(decisionOf(r)?.permissionDecisionReason || ''), decisionOf(r)?.permissionDecisionReason);
  check('A1 exit 0（宿主协议：阻断在决策体）', r.status === 0, `exit=${r.status}`);
  check('A2 写 .agents/settings.json → deny', shapeOk(runGuard(writePayload('.agents/settings.json', '{}'), root), 'deny'), '');
  check('A3 写 .agents/scripts/ 门禁脚本位 → deny', shapeOk(runGuard(writePayload('.agents/scripts/check-loop.mjs', '#!/usr/bin/env node\n'), root), 'deny'), '');
  // 反问锚：Edit 删空门禁面文件内容同样拒（Edit 形态同判据）
  check('A4 Edit 清空 .agents/config/engine.json → deny', shapeOk(runGuard(editPayload('.agents/config/engine.json', '{"gate":"on"}\n', ''), root), 'deny'), '');
  // 运行时目录（RUNTIME_DIRS 单源：cache/loop/notes/board/tmp）可写——init-engine 落什么放什么
  for (const dir of ['cache', 'loop', 'notes', 'board', 'tmp']) {
    check(`A5 写 .agents/${dir}/x → 静默放行（RUNTIME_DIRS 例外）`,
      silentPermit(runGuard(writePayload(`.agents/${dir}/x.txt`, 'data\n'), root)), '');
  }
  check('A6 业务路径 src.js → 静默放行（非管辖）', silentPermit(runGuard(writePayload('src.js', 'console.log(2)\n'), root)), '');
  check('A7 workflow/ 台账正文 → 静默放行（非管辖）', silentPermit(runGuard(writePayload('workflow/plans/x.md', '# p\n'), root)), '');
  // 仓外绝对路径不管辖（沿源口径）：tmp 下夹具仓之外的另一目录
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-write-guard-out-'));
  check('A8 仓外绝对路径 → 静默放行', silentPermit(runGuard(writePayload(path.join(outside, 'a.txt'), 'x\n'), root)), '');
  fs.rmSync(outside, { recursive: true, force: true });
  // Windows 反斜杠路径形态同判据
  check('A9 反斜杠路径写门禁面 → deny（rel 归一后同判）', shapeOk(runGuard(writePayload('.agents\\config\\engine.json', '{}'), root), 'deny'), '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B 三本审计账 append-only ----
{
  const root = mkRepo();
  const ledgerOf = (name) => path.join(root, '.agents', name);
  for (const name of ['confirmations.jsonl', 'judgments.jsonl', 'verifications.jsonl']) {
    const cur = fs.readFileSync(ledgerOf(name), 'utf8');
    check(`B1 ${name} 追加（前缀扩展）→ 静默放行`, silentPermit(runGuard(writePayload(`.agents/${name}`, `${cur}appended\n`), root)), '');
  }
  check('B2 confirmations.jsonl 整写（替换内容）→ deny', shapeOk(runGuard(writePayload('.agents/confirmations.jsonl', 'rewritten\n'), root), 'deny'), '');
  check('B2 deny 理由点名 append-only/追加', /append-only|追加/.test(decisionOf(runGuard(writePayload('.agents/verifications.jsonl', 'x\n'), root))?.permissionDecisionReason || ''), '');
  check('B3 verifications.jsonl 删改历史行 → deny', shapeOk(runGuard(writePayload('.agents/verifications.jsonl', ''), root), 'deny'), '');
  // Edit 形态：末行扩展 = 前缀扩展 → 放；删改 = 非前缀 → 拒
  check('B4 Edit 末行扩展 confirmations.jsonl → 放', silentPermit(runGuard(editPayload('.agents/confirmations.jsonl', 'c1\n', 'c1\nc2\n'), root)), '');
  check('B5 Edit 删改 judgments.jsonl（清空）→ deny', shapeOk(runGuard(editPayload('.agents/judgments.jsonl', 'j1\n', ''), root), 'deny'), '');
  // MultiEdit 形态（驼峰宿主名）：全扩展 → 放；含删改步 → 拒
  const multi = (edits) => ({ tool_name: 'MultiEdit', tool_input: { file_path: '.agents/verifications.jsonl', edits } });
  check('B6 MultiEdit 追加步 → 放（驼峰名经拆词入管辖）', silentPermit(runGuard(multi([{ old_string: 'v1\n', new_string: 'v1\nv2\n' }]), root)), '');
  check('B7 MultiEdit 含删改步 → deny', shapeOk(runGuard(multi([{ old_string: 'v1\n', new_string: 'v1\nv2\n' }, { old_string: 'v1\n', new_string: '' }]), root), 'deny'), '');
  // 分片不在追例外：confirmations.d/* 直编即拒（分片写走 confirm-doc / ledger-shards 的 Bash 面）
  check('B8 分片 confirmations.d/x.jsonl 整写 → deny（不在追例外）', shapeOk(runGuard(writePayload('.agents/confirmations.d/x.jsonl', '{"fake":1}\n'), root), 'deny'), '');
  fs.rmSync(root, { recursive: true, force: true });
  // 缺文件 = 首次追加，放行（口径：账本工具建账场景）
  const root2 = mkRepo();
  fs.rmSync(path.join(root2, '.agents', 'confirmations.jsonl'));
  check('B9 台账缺席时新建 → 静默放行（首次追加）', silentPermit(runGuard(writePayload('.agents/confirmations.jsonl', 'c1\n'), root2)), '');
  fs.rmSync(root2, { recursive: true, force: true });
}

// ---- C fail-closed（写目标不可判定 → ask，绝不静默放行）----
{
  const root = mkRepo();
  const ask = (label, payloadOrRaw, env = {}, cwd = root) => {
    const r = runGuard(payloadOrRaw, cwd, env);
    check(label, shapeOk(r, 'ask'), `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    return r;
  };
  const r1 = ask('C1 Write 缺 file_path → ask（fail-closed）', { tool_name: 'Write', tool_input: { content: 'x\n' } });
  check('C1 理由点明 file_path 不可判定', /file_path/.test(r1 && decisionOf(r1)?.permissionDecisionReason || ''), decisionOf(r1)?.permissionDecisionReason);
  ask('C2 坏 JSON → ask', '{"tool_name":');
  ask('C3 空 stdin → ask', '');
  ask('C4 非对象 JSON（标量）→ ask', '123');
  ask('C5 输入截断（>100k 字符）→ ask', `{"tool_name":"Write","tool_input":{"file_path":"a${'x'.repeat(100_000)}`);
  const r6 = ask('C6 内部故障注入 → ask', writePayload('src.js', 'x\n'), { AI_NATIVE_HOOK_FAULT_INJECT: '1' });
  check('C6 stderr 同步留痕', /内部故障/.test(r6?.stderr || ''), r6?.stderr);
  // 项目根解析不出（非 git 目录）→ ask：执法面定位不了，不能静默放行
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-write-guard-norepo-'));
  ask('C7 非 git 目录 → ask（项目根解析不出）', writePayload('.agents/config/engine.json', '{}'), {}, nonRepo);
  fs.rmSync(nonRepo, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- D 管辖面与协议形状 ----
{
  const root = mkRepo();
  check('D1 非 写工具 Read → 静默放行', silentPermit(runGuard({ tool_name: 'Read', tool_input: { file_path: 'src.js' } }, root)), '');
  check('D2 shell 工具 Bash → 静默放行（shell 面归风险闸）', silentPermit(runGuard({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, root)), '');
  check('D3 TodoWrite → 静默放行（速记面豁免）', silentPermit(runGuard({ tool_name: 'TodoWrite', tool_input: { todos: [] } }, root)), '');
  check('D4 mcp__update_ledger → 静默放行（mcp 豁免优先于词族）', silentPermit(runGuard({ tool_name: 'mcp__update_ledger', tool_input: { file_path: '.agents/config/engine.json' } }, root)), '');
  // 驼峰宿主名照管：NotebookEdit 用 notebook_path 别名字段
  check('D5 NotebookEdit（notebook_path 门禁面）→ deny', shapeOk(runGuard({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '.agents/config/engine.json', content: '{}' } }, root), 'deny'), '');
  // 决策体形状单一性：deny 输出恰为 hookSpecificOutput 三字段，stdout 是单条 JSON
  const r = runGuard(writePayload('.agents/config/engine.json', '{}'), root);
  const parsed = JSON.parse(r.stdout);
  check('D6 决策体 = hookSpecificOutput{hookEventName/permissionDecision/permissionDecisionReason}',
    typeof parsed === 'object' && parsed.hookSpecificOutput
    && parsed.hookSpecificOutput.hookEventName === 'PreToolUse'
    && parsed.hookSpecificOutput.permissionDecision === 'deny'
    && typeof parsed.hookSpecificOutput.permissionDecisionReason === 'string'
    && Object.keys(parsed).length === 1, r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
