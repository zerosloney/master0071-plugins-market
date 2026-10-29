#!/usr/bin/env node
// hook.test.mjs — PreToolUse 风险闸可测化（设计文档 §10.1 第 5 条；spawn hook 进程喂 stdin JSON）
// 断言：①deny 清单命令（git push -f）→ 阻断（permissionDecision='deny'，退出码 0 = 宿主协议——
//       阻断语义在 stdout 决策体，照 systemone hook 同款）；②普通命令（git status）→ 静默放行；
//       ③settings.json 损坏 → WARN + 内置 deny 地板继续执法；④项目侧 ask 整体接管 / deny 不可
//       下调；⑤ask 清单 / 非 shell 工具不管辖；⑥deny 键缺失或空数组 → 地板仍拦；⑦坏 JSON 输入
//       → fail-closed 转 ask；⑧声明面 matcher 与代码 SHELL_TOOL 同口径（防风险闸静默不被调用）。
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

// ---- ①'' 选项位置差异：force 写在参数之后 / 参数夹在中间（2026-10-28 词元判据）----
// 三种写法在 git 里等价，但只有第一种是 `git push --force` 的子串——后两种在补词元判据前
// 静默放行（实测），而它们恰是最常见的写法。
{
  const cases = [
    'git push origin main --force',
    'git push --force origin main',
    'git -C /repo push origin main --force',
    'git push -f origin main',
    'git  push   origin   main   --force',
  ];
  for (const command of cases) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, process.cwd());
    check(`选项位置不影响 deny：${command}`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
}

// ---- ①'' 引号变体与 --no-verify（2026-10-29 市场审查）----
// 旧判据按原样切词元，`"--force"` 带引号切出来是 `"--force"`，与规则里的 `--force` 对不上，
// 而子串判据也命中不了——三种写法实测全部静默放行。shell 本身会剥引号，判据必须看剥完之后的命令。
// `--no-verify` 单列：它是从 shell 层单方面关掉已安装 git hook 的唯一开关，
// 让「插件钩子 + 本 hook」两层拦截中的一层可以被一条参数解除。
{
  const cases = [
    'git push "--force"',
    "git push '--force'",
    'git push origin main "--force"',
    'git push --no-verify',
    'git push origin main --no-verify',
    'git commit --no-verify -m "wip"',
    'git commit -m "wip" --no-verify',
  ];
  for (const command of cases) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, process.cwd());
    check(`引号/--no-verify 变体仍被 deny：${command}`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
  // 反向锚：剥引号不得把正常命令误判
  const ok = run({ tool_name: 'Bash', tool_input: { command: 'git commit -m "add forced retry note"' } }, process.cwd());
  check('剥引号不误伤正常提交信息', ok.stdout.trim() === '', ok.stdout);
}

// ---- ①''' 驼峰宿主工具名必须同样受管辖（2026-10-28 内核拆词）----
// matcher 是子串正则，这三种名字都会被它命中并调用 hook；但 `Command` 两侧都不是词边界，
// 补拆词前内核判「非 shell 工具」静默放行——闸门被调用却什么都没拦。
{
  for (const toolName of ['RunCommand', 'ExecuteCommand', 'BashTool']) {
    const r = run({ tool_name: toolName, tool_input: { command: 'git reset --hard' } }, process.cwd());
    check(`驼峰工具名 ${toolName} → deny（不再静默放行）`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
}

// ---- ② 普通命令 → 静默放行（无 stdout 决策体）----
{
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git status' } }, process.cwd());
  check('git status → 放行（exit 0）', r.status === 0, `exit=${r.status}`);
  check('git status → 无 permissionDecision（静默）', r.stdout.trim() === '', `stdout=${r.stdout}`);
}

// ---- ③ settings.json 损坏 → WARN + 内置 deny 地板继续执法（2026-10-28 收紧）----
// 此前损坏即整体 fail-open 放行：把 .agents/settings.json 写坏就能解除风险闸，与被治理对象
// 「自写空清单」是同一类旁路。现在坏文件只让它自己的追加项失效，地板照拦。
{
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', 'settings.json'), '{broken json!!', 'utf8');
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git push -f' } }, repo);
  check('损坏 settings → 地板仍拦（decision=deny，不再整体放行）',
    r.status === 0 && decisionOf(r)?.permissionDecision === 'deny', `exit=${r.status} stdout=${r.stdout}`);
  check('损坏 settings → stderr WARN 点明地板执法', /deny 面按内置地板继续执法/.test(r.stderr || ''), r.stderr);
  check('损坏 settings → WARN 点名是哪个文件', /settings\.json/.test(r.stderr || ''), r.stderr);
  const r2 = run({ tool_name: 'Bash', tool_input: { command: 'git status' } }, repo);
  check('损坏 settings → 普通命令不受影响（仍静默放行）', r2.status === 0 && r2.stdout.trim() === '', r2.stdout);
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ④ 项目侧 .agents/settings.json：ask 可整体接管，deny 只能追加（内置地板不可下调）----
{
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', 'settings.json'), JSON.stringify({
    permissions: {
      deny: ['ship-explode-cmd', 'git push -f'],
      ask: ['git push -f'],
    },
  }), 'utf8');
  const r = run({ tool_name: 'Bash', tool_input: { command: 'ship-explode-cmd --now' } }, repo);
  check('项目侧 deny 条目生效', decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  // 关键反证：项目侧 deny 里**没有** git reset --hard，仍必须被拦——deny 是地板 ∪ 追加，
  // 被治理项目不能靠重写清单把内置拦阻删掉（2026-10-28 市场审查修复的就是这一点）。
  const rFloor = run({ tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~3' } }, repo);
  check('项目侧未列内置地板项 → 地板仍拦（deny 不可下调）',
    decisionOf(rFloor)?.permissionDecision === 'deny', rFloor.stdout);
  const r2 = run({ tool_name: 'Bash', tool_input: { command: 'rm -rf build/output' } }, repo);
  check('ask 仍可被项目侧整体接管（ask 里无 rm -rf → 不再 ask）', r2.status === 0 && r2.stdout.trim() === '', r2.stdout);
  const r3 = run({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } }, repo);
  check('deny 优先于 ask（同命令两清单并存 → deny）', decisionOf(r3)?.permissionDecision === 'deny', r3.stdout);
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

// ---- ⑥ deny 键缺失 / deny 写成空数组 = 想清空 deny（2026-10-28 地板修复）----
// 这两种形态以前都会把 deny 面清空：缺键判损坏 → fail-open 整体放行；空数组判合法 → deny 面为空。
// 现在两者都只是「没有追加项」，地板项照拦，并留一条 WARN 让降级可见。
{
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', 'settings.json'), JSON.stringify({
    permissions: { ask: ['rm -rf'] }, // 无 deny 键
  }), 'utf8');
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } }, repo);
  check('deny 键缺失 → stderr WARN（降级可见）', /deny 键缺失/.test(r.stderr || ''), r.stderr);
  check('deny 键缺失 → 地板仍拦（不再 fail-open 放行）',
    r.status === 0 && decisionOf(r)?.permissionDecision === 'deny', `exit=${r.status} stdout=${r.stdout}`);
  fs.writeFileSync(path.join(repo, '.agents', 'settings.json'), JSON.stringify({
    permissions: { deny: [], ask: [] }, // 显式清空
  }), 'utf8');
  const r2 = run({ tool_name: 'Bash', tool_input: { command: 'drop database prod_users' } }, repo);
  check('deny 写成空数组 → 地板仍拦（清空无效）', decisionOf(r2)?.permissionDecision === 'deny', r2.stdout);
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ⑦ 坏 JSON 输入 → fail-closed 转 ask（2026-10-27 插件化修复）----
// 此前坏 JSON 被 catch 成 {} → tool_name='' → 判为非 shell 工具 → 静默放行（与截断转 ask 方向相反）。
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: '{not valid json',
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env },
  });
  const d = decisionOf(r);
  check('坏 JSON 输入 → exit 0（宿主协议）', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  check('坏 JSON 输入 → fail-closed 转 ask（非静默放行）', d && d.permissionDecision === 'ask', r.stdout);
  check('坏 JSON 输入 → 理由点明「不是合法 JSON」', d && /不是合法 JSON/.test(d.permissionDecisionReason || ''),
    d && d.permissionDecisionReason);
}

// ---- ⑧ 声明面 matcher 与代码 SHELL_TOOL 同口径（2026-10-28 市场审查；10-29 与远端的同编号用例合并）----
// matcher 决定「hook 会不会被调到」，代码正则决定「调到之后管不管」。两者脱节时风险闸对某类
// shell 工具**静默不存在**——零告警、零现象，比判错更危险。本仓实测踩过两次，方向相反：
//   ① matcher 窄于内核名单（只写 `Bash|Shell|Terminal`，内核认 12 名）→ hook 压根不被调用；
//   ② matcher 宽于内核名单（子串正则命中 `RunCommand`，内核词边界对不上）→ hook 被调用却放行。
// 本用例同时锁两个方向：名字提取失败即报红（防对账空转），并对驼峰宿主名跑真实进程判行为。
{
  const hookSrc = fs.readFileSync(HOOK, 'utf8').replace(/\r/g, ''); // CRLF 会让 $ 锚失配
  // 直接取「纯小写交替组」：SHELL_TOOL 里还有 (^|[_\-.\s]) 这种边界组，它不满足本模式故被跳过。
  // 正则改形导致取不到名单时下面立即报红——这正是「对账退化成空转」的入口。
  const listMatch = /const SHELL_TOOL = [^\n]*\(([a-z|]+)\)/.exec(hookSrc);
  check('能从 hook 源提取 SHELL_TOOL 名单（提取失败=正则改形，需同步本测试）', Boolean(listMatch),
    hookSrc.split('\n').find((l) => l.includes('const SHELL_TOOL')) || '(找不到 SHELL_TOOL 定义行)');
  const names = listMatch ? listMatch[1].split('|') : [];
  check('工具名覆盖数 ≥ 12（防交替组被改写后对账空转）', names.length >= 12, `实际 ${names.length}：${names.join(',')}`);

  const decls = [
    ['hooks/hooks.json', path.join(TEST_DIR, '..', 'hooks', 'hooks.json')],
    ['.codex-plugin/plugin.json', path.join(TEST_DIR, '..', '.codex-plugin', 'plugin.json')],
  ];
  for (const [label, file] of decls) {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const holder = obj.hooks && obj.hooks.hooks ? obj.hooks.hooks : obj.hooks;
    const entries = (holder && holder.PreToolUse) || [];
    const matchers = entries.map((e) => e.matcher).filter((m) => typeof m === 'string' && m);
    check(`${label} 声明了 PreToolUse matcher`, matchers.length > 0, JSON.stringify(entries));
    for (const matcher of matchers) {
      // names 为空时下面的 missing 会空转通过——显式判红，别让对账退化成假绿
      check(`${label} 对账有实义（SHELL_TOOL 名单非空）`, names.length > 0, '名单为空，覆盖率断言无意义');
      // 方向①：matcher 必须覆盖内核认的全部名字（含宿主常见包装形态）
      const hostForms = (n) => [n, n[0].toUpperCase() + n.slice(1), `run_${n}`, `mcp__h__${n}_command`];
      const missed = [];
      for (const name of names) {
        for (const form of hostForms(name)) {
          if (!new RegExp(matcher).test(form)) missed.push(form);
        }
      }
      check(`${label} matcher 覆盖内核 SHELL_TOOL 名单全部成员的常见宿主形态`, missed.length === 0,
        missed.length ? `matcher 漏掉 "${missed.join('", "')}"（内核名单 ${names.join('/')}）——该调用不会进风险闸` : '');
      // 反向锚：确认对账用的是宿主语义（大小写敏感正则），`Bash|Shell|Terminal` 那种窄写法必红
      check(`${label} matcher 非窄写法（不只 Bash/Shell/Terminal）`,
        new RegExp(matcher).test('Command') && new RegExp(matcher).test('pwsh'), matcher);
      // 方向②：matcher 是子串正则，比代码 SHELL_TOOL 更宽。驼峰宿主名（RunCommand / ExecuteCommand /
      // BashTool）会被 matcher 命中并调用 hook，但 `Command` 两侧都不是词边界，内核对不上就判
      // 「非 shell 工具」静默放行——闸门被调用却什么都没拦。上面只验了方向①，锁不住这个洞。
      // 这里用真实进程跑，判的是实际行为而不是正则字面量。
      const reg = new RegExp(matcher);
      for (const hostName of ['RunCommand', 'ExecuteCommand', 'BashTool', 'RunShell']) {
        check(`${label} 前提：matcher 会命中 "${hostName}"`, reg.test(hostName));
        if (!reg.test(hostName)) continue;
        const r = run({ tool_name: hostName, tool_input: { command: 'git reset --hard' } }, process.cwd());
        check(`${label} 驼峰名 "${hostName}" 的 deny 命令确实被拦`,
          decisionOf(r)?.permissionDecision === 'deny', `stdout=${r.stdout}`);
      }
      // 拆词不能把普通工具也拉进管辖（否则每次文件读写都发判定）
      for (const notShell of ['Read', 'Write', 'Edit', 'Grep', 'WebFetch']) {
        const r = run({ tool_name: notShell, tool_input: { command: 'git reset --hard' } }, process.cwd());
        check(`${label} 非 shell 工具 "${notShell}" 不被管辖`, r.status === 0 && r.stdout.trim() === '', r.stdout);
      }
    }
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
