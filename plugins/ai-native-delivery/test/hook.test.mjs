#!/usr/bin/env node
// hook.test.mjs — PreToolUse 风险闸可测化（设计文档 §10.1 第 5 条；spawn hook 进程喂 stdin JSON）
// 断言：①deny 清单命令（git push -f）→ 阻断（permissionDecision='deny'，退出码 0 = 宿主协议——
//       阻断语义在 stdout 决策体，照 systemone hook 同款）；②普通命令（git status）→ 静默放行；
//       ③settings.json 损坏 → 放行 + stderr WARN（fail-open）；④ask 清单 / 项目侧清单单源 /
//       非 shell 工具不管辖。
// 零依赖，Node ≥ 18 直接运行：node test/hook.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(TEST_DIR, '..', 'hooks', 'pretool-risk.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'; // Windows spawn 不补 .exe 扩展名

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// run：cwd=项目根（hook 经 paths.findProjectRoot 从 cwd 锚定根）；payload = hook JSON
const run = (payload, cwd) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  cwd,
  env: { ...process.env },
});
const decisionOf = (r) => {
  try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; }
};

// 临时 git 仓（项目侧 settings 单源场景的容器）
const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-risk-'));
  spawnSync(GIT, ['init', '-q'], { cwd: d });
  return d;
};

// ---- ① 内置 deny 清单：git push -f → 阻断（decision 体 + exit 0 宿主协议）----
{
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } }, process.cwd());
  const d = decisionOf(r);
  check('deny 命令 → exit 0（宿主协议：阻断在决策体）', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  check('deny 命令 → permissionDecision=deny', d && d.permissionDecision === 'deny', r.stdout);
  check('deny 理由含命中条目', d && d.permissionDecisionReason.includes('git push -f'), d && d.permissionDecisionReason);
  check('deny 事件名 = PreToolUse', d && d.hookEventName === 'PreToolUse');
}

// ---- ①' deny 变体与链式：--force 与 `x && git push -f` 子串命中 ----
{
  const r = run({ tool_name: 'Bash', tool_input: { command: 'cd app && git push --force' } }, process.cwd());
  check('链式命令里的 git push --force 仍被 deny', decisionOf(r)?.permissionDecision === 'deny', r.stdout);
}

// ---- ② 普通命令 → 静默放行（无 stdout 决策体）----
{
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git status' } }, process.cwd());
  check('git status → 放行（exit 0）', r.status === 0, `exit=${r.status}`);
  check('git status → 无 permissionDecision（静默）', r.stdout.trim() === '', `stdout=${r.stdout}`);
}

// ---- ③ settings.json 损坏 → fail-open（放行 + stderr WARN）----
{
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', 'settings.json'), '{broken json!!', 'utf8');
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git push -f' } }, repo);
  check('损坏 settings → 放行（无阻断决策体）', r.status === 0 && r.stdout.trim() === '', `exit=${r.status} stdout=${r.stdout}`);
  check('损坏 settings → stderr WARN', /settings\.json 损坏/.test(r.stderr || ''), r.stderr);
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ④ 清单单源 = 项目侧 .agents/settings.json（文件在场即整体单源，含空清单；不与内置默认合并）----
{
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', 'settings.json'), JSON.stringify({
    permissions: {
      deny: ['ship-explode-cmd', 'git push -f'],
      ask: [],
      allow: ['git push -f'],
    },
  }), 'utf8');
  const r = run({ tool_name: 'Bash', tool_input: { command: 'ship-explode-cmd --now' } }, repo);
  check('项目侧 deny 条目生效', decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  const r2 = run({ tool_name: 'Bash', tool_input: { command: 'rm -rf build/output' } }, repo);
  check('项目侧文件在场即单源（ask:[] → rm -rf 不再 ask，不合并内置默认）', r2.status === 0 && r2.stdout.trim() === '', r2.stdout);
  const r3 = run({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } }, repo);
  check('deny 优先于 allow（同命令两清单并存 → deny）', decisionOf(r3)?.permissionDecision === 'deny', r3.stdout);
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ⑤ ask 清单 + 非 shell 工具不管辖 ----
{
  const r = run({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules/cache' } }, process.cwd());
  check('rm -rf → ask（内置 ask 清单）', decisionOf(r)?.permissionDecision === 'ask', r.stdout);
  const r2 = run({ tool_name: 'Read', tool_input: { command: 'git push -f' } }, process.cwd());
  check('非 shell 工具不归风险闸管（静默放行）', r2.status === 0 && r2.stdout.trim() === '', r2.stdout);
  const r3 = run({ tool_name: 'Bash', tool_input: { file_path: '/var/data/notes.md' } }, process.cwd());
  check('shell 工具缺 command 字段 → fail-closed 转 ask', decisionOf(r3)?.permissionDecision === 'ask', r3.stdout);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
