#!/usr/bin/env node
// hook.test.mjs — PreToolUse 风险闸可测化（设计文档 §10.1 第 5 条；spawn hook 进程喂 stdin JSON）
// 断言：①deny 清单命令（git push -f）→ 阻断（permissionDecision='deny'，退出码 0 = 宿主协议——
//       阻断语义在 stdout 决策体，照 systemone hook 同款）；②普通命令（git status）→ 静默放行；
//       ③settings.json 损坏 → WARN + 内置 deny 地板继续执法；④项目侧 ask 整体接管 / deny 不可
//       下调；⑤ask 清单 / 非 shell 工具不管辖；⑥deny 键缺失或空数组 → 地板仍拦；⑦坏 JSON 输入
//       → fail-closed 转 ask；⑧声明面 matcher 与内核名单同口径（shell 段 + 写前门段，防 hook 静默不被调用）；
//       ⑨内部故障 → 转 ask 而非静默放行（2026-10-31 市场审查：顶层 catch 曾 exit 0 无决策体，
//         一条本该命中 deny 的命令凭 hook 自身故障被放行）。
// 零依赖，Node ≥ 18 直接运行：node test/hook.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
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

// ---- ⑧ 声明面 matcher 与内核名单同口径（2026-10-28 市场审查；10-29 与远端的同编号用例合并；
//      2026-11-12 扩写前门段：按条目挂载的脚本分面对账——pretool-risk ↔ SHELL_TOOL_NAMES、
//      pre-write-guard ↔ WRITE_TOOL_NAMES，两段各自锁「matcher 窄于内核」与「内核不认」两向）----
// matcher 决定「hook 会不会被调到」，代码正则决定「调到之后管不管」。两者脱节时风险闸对某类
// shell 工具**静默不存在**——零告警、零现象，比判错更危险。本仓实测踩过两次，方向相反：
//   ① matcher 窄于内核名单（只写 `Bash|Shell|Terminal`，内核认 12 名）→ hook 压根不被调用；
//   ② matcher 宽于内核名单（子串正则命中 `RunCommand`，内核词边界对不上）→ hook 被调用却放行。
// 本用例同时锁两个方向：名字提取失败即报红（防对账空转），并对驼峰宿主名跑真实进程判行为。
{
  const hookSrc = fs.readFileSync(HOOK, 'utf8').replace(/\r/g, ''); // CRLF 会让 $ 锚失配
  // 直接取「纯小写交替组」：SHELL_TOOL 里还有 (^|[_\-.\\s]) 这种边界组，它不满足本模式故被跳过。
  // 正则改形导致取不到名单时下面立即报红——这正是「对账退化成空转」的入口。
  // （2026-11-05 同步注明：内核改为 SHELL_TOOL_NAMES 单源名单数组，从它构建三种形态——边界 /
  //   粘连词尾 / 子串告警（移植 systemone risk-gate），对账提取随之从正则交替组改为数组字面量。）
  const listMatch = /const SHELL_TOOL_NAMES = \[([^\]]*)\]/.exec(hookSrc);
  check('能从 hook 源提取 SHELL_TOOL 名单（提取失败=名单改形，需同步本测试）', Boolean(listMatch),
    hookSrc.split('\n').find((l) => l.includes('SHELL_TOOL_NAMES')) || '(找不到 SHELL_TOOL_NAMES 定义行)');
  const names = listMatch ? (listMatch[1].match(/'([a-z]+)'/g) || []).map((s) => s.slice(1, -1)) : [];
  check('工具名覆盖数 ≥ 12（防交替组被改写后对账空转）', names.length >= 12, `实际 ${names.length}：${names.join(',')}`);

  // 写前门内核名单（hooks/pre-write-guard.mjs WRITE_TOOL_NAMES，对账与 shell 段同构；名单含
  // apply_patch 带下划线，提取字符类要收 _）
  const WRITE_HOOK = path.join(TEST_DIR, '..', 'hooks', 'pre-write-guard.mjs');
  const writeSrc = fs.readFileSync(WRITE_HOOK, 'utf8').replace(/\r/g, '');
  const wListMatch = /const WRITE_TOOL_NAMES = \[([^\]]*)\]/.exec(writeSrc);
  check('能从写前门源提取 WRITE_TOOL 名单（提取失败=名单改形，需同步本测试）', Boolean(wListMatch),
    writeSrc.split('\n').find((l) => l.includes('WRITE_TOOL_NAMES')) || '(找不到 WRITE_TOOL_NAMES 定义行)');
  const writeNames = wListMatch ? (wListMatch[1].match(/'([a-z_]+)'/g) || []).map((s) => s.slice(1, -1)) : [];
  check('写工具名覆盖数 ≥ 5（防交替组被改写后对账空转）', writeNames.length >= 5, `实际 ${writeNames.length}：${writeNames.join(',')}`);

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
    for (const entry of entries) {
      const matcher = entry.matcher;
      if (typeof matcher !== 'string' || !matcher) continue;
      // 分面路由：条目挂的是哪个内核（决定用哪份名单对账）；两段都对不上时按 shell 段对账兜底报红
      const isWriteGuard = Array.isArray(entry.hooks)
        && entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('pre-write-guard.mjs'));
      const hostForms = (n) => [n, n[0].toUpperCase() + n.slice(1), `run_${n}`, `mcp__h__${n}_command`];
      const faceNames = isWriteGuard ? writeNames : names;
      const faceLabel = isWriteGuard ? 'WRITE_TOOL' : 'SHELL_TOOL';
      const missLabel = isWriteGuard ? '写前门' : '风险闸';
      // names 为空时下面的 missing 会空转通过——显式判红，别让对账退化成假绿
      check(`${label} ${missLabel}段对账有实义（${faceLabel} 名单非空）`, faceNames.length > 0, '名单为空，覆盖率断言无意义');
      // 方向①：matcher 必须覆盖内核认的全部名字（含宿主常见包装形态）
      const missed = [];
      for (const name of faceNames) {
        for (const form of hostForms(name)) {
          if (!new RegExp(matcher).test(form)) missed.push(form);
        }
      }
      check(`${label} ${missLabel}段 matcher 覆盖内核 ${faceLabel} 名单全部成员的常见宿主形态`, missed.length === 0,
        missed.length ? `matcher 漏掉 "${missed.join('", "')}"（内核名单 ${faceNames.join('/')}）——该调用不会进${missLabel}` : '');
      // 反向锚：确认对账用的是宿主语义（大小写敏感正则），窄写法必红（shell 段防 `Bash|Shell|Terminal`
      // 三名窄写；写前门段防只认单一写工具的窄写）
      const reg = new RegExp(matcher);
      check(`${label} ${missLabel}段 matcher 非窄写法`,
        isWriteGuard
          ? (reg.test('Write') && reg.test('Edit') && reg.test('Update') && reg.test('NotebookEdit'))
          : (reg.test('Command') && reg.test('pwsh')), matcher);
      if (!isWriteGuard) {
        // 方向②：matcher 是子串正则，比代码 SHELL_TOOL 更宽。驼峰宿主名（RunCommand / ExecuteCommand /
        // BashTool）会被 matcher 命中并调用 hook，但 `Command` 两侧都不是词边界，内核对不上就判
        // 「非 shell 工具」静默放行——闸门被调用却什么都没拦。上面只验了方向①，锁不住这个洞。
        // 这里用真实进程跑，判的是实际行为而不是正则字面量。
        // 2026-11-05 补粘连词尾：matcher（子串）会命中 nushell / fishshell 这类「字母前缀 + shell
        // 词尾」并把 hook 拉起，内核必须经词尾形态认领，否则整类免检零信号（双向对账的两条新词）。
        for (const hostName of ['RunCommand', 'ExecuteCommand', 'BashTool', 'RunShell', 'nushell', 'fishshell']) {
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
}

// ---- ⑨ 内部故障 → 转 ask（2026-10-31 市场审查）----
// 内部故障无法从外部自然触发（settings 损坏已被地板执法降级），走 hook 自带的测试注入口
// AI_NATIVE_HOOK_FAULT_INJECT。要点：deny 清单命令在场时，故障的结局是「ask 由用户确认」，
// 不是静默放行、也不是硬 deny（「绝不硬阻塞」契约仍守）。
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -f' } }),
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, AI_NATIVE_HOOK_FAULT_INJECT: '1' },
  });
  const d = decisionOf(r);
  check('内部故障 → exit 0（宿主协议）', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  check('内部故障 → 转 ask 而非静默放行', d && d.permissionDecision === 'ask', r.stdout);
  check('内部故障 → 理由点明内部故障', d && /内部故障/.test(d.permissionDecisionReason || ''),
    d && d.permissionDecisionReason);
  check('内部故障 → stderr 同步留痕', /内部故障/.test(r.stderr || ''), r.stderr);
}

// ---- ⑩ Windows 可执行后缀形态不得绕过 deny 地板（2026-11-05 市场审查）----
// 子串判据 c.includes(r) 被 `.exe` 断开（`git.exe push -f` 不含 `git push -f`），词元判据切出的
// token 是 `git.exe`、与规则词 `git` 对不上——deny 地板被一个二进制形态整体绕过。修在归一化层：
// 词尾剥 .exe/.bat/.cmd（大小写不敏感）后两条判据同时恢复。反向锚：git.exe status 不得误伤。
{
  for (const command of [
    'git.exe push -f origin main',
    'git.exe commit --no-verify -m x',
    'git.cmd reset --hard',
    'GIT.EXE PUSH -F ORIGIN MAIN',
  ]) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, process.cwd());
    check(`可执行后缀形态仍被 deny：${command}`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
  const ok = run({ tool_name: 'Bash', tool_input: { command: 'git.exe status' } }, process.cwd());
  check('git.exe status 不误伤（静默放行）', ok.status === 0 && ok.stdout.trim() === '', ok.stdout);
}

// ---- ⑪ stdin 挂起 → 本地 deadline 兜底输出 ask（2026-11-05 市场审查）----
// readStdin 只等 end/close/error：宿主喂半截不关管时 hook 挂满宿主 15s 超时被杀——
// 无决策体 = 静默放行。修复后 14s 共享预算 killer（测试经 AI_NATIVE_HOOK_KILLER_MS 注入快值）
// 触发时先输出 ask 决策体再退（与判定分支同一构造器），stderr 留一行诊断。修复前 RED：空输出。
{
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: process.cwd(),
      env: { ...process.env, AI_NATIVE_HOOK_KILLER_MS: '300' }, // 测试注入口：把 14s 预算压缩到 300ms
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutTxt = '';
    let stderrTxt = '';
    child.stdout.on('data', (c) => { stdoutTxt += c; });
    child.stderr.on('data', (c) => { stderrTxt += c; });
    child.stdin.write('{"tool_name":"Bash","tool_input":{"comm'); // 半截 JSON，故意不 end()
    const guard = setTimeout(() => child.kill(), 8000);
    child.on('exit', (code) => { clearTimeout(guard); resolve({ code, stdoutTxt, stderrTxt, ms: Date.now() - t0 }); });
    child.on('error', () => { clearTimeout(guard); resolve({ code: -1, stdoutTxt, stderrTxt, ms: Date.now() - t0 }); });
  });
  let d = null;
  try { d = JSON.parse(r.stdoutTxt).hookSpecificOutput; } catch { /* 挂起场景修复前 stdout 为空 */ }
  check('stdin 挂起 → 本地 deadline 触发自行退出（exit 0）', r.code === 0, `exit=${r.code} stderr=${r.stderrTxt}`);
  check('stdin 挂起 → stdout 有 ask 决策体（不再是静默放行）', d && d.permissionDecision === 'ask', r.stdoutTxt);
  check('stdin 挂起 → stderr 留一行诊断', /stdin 未在共享预算内完成读取/.test(r.stderrTxt || ''), r.stderrTxt);
  check('stdin 挂起 → 赶在宿主 15s 超时前退出（<5s）', r.ms < 5000, `耗时 ${r.ms}ms`);
  // 反向锚：注入 killer 快值时，正常快速输入不受影响（deadline 只兜挂起，不误伤正常流）
  const ok = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -f' } }),
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, AI_NATIVE_HOOK_KILLER_MS: '300' },
  });
  check('killer 注入不影响正常输入（deny 照常命中）', decisionOf(ok)?.permissionDecision === 'deny', ok.stdout);
}

// ---- ⑫ 粘连词尾形态纳入管辖 + shellfish 反例兜底告警（2026-11-05 市场审查）----
// matcher 是子串正则，nushell / myshell / fishshell 会被它命中拉起 hook，而内核边界字符类要求
// 关键词两侧是分隔符——整类免检零信号。修复后词尾形态纳入管辖（fish 排除防误收 shellfish 族）；
// matcher 命中而内核不认（shellfish / catfish）时 stderr 一行兜底告警，缺口可见。
{
  for (const toolName of ['nushell', 'myshell', 'fishshell', 'Nushell']) {
    const r = run({ tool_name: toolName, tool_input: { command: 'git reset --hard' } }, process.cwd());
    check(`粘连词尾 ${toolName} → deny（内核认词尾形态）`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
  const sf = run({ tool_name: 'shellfish', tool_input: { command: 'git reset --hard' } }, process.cwd());
  check('shellfish → 内核不认（静默放行，不误拦非 shell 工具）', sf.status === 0 && sf.stdout.trim() === '', sf.stdout);
  check('shellfish → stderr 兜底告警（matcher 命中但内核不认可见）',
    /命中 matcher 但风险闸内核不认/.test(sf.stderr || ''), sf.stderr);
  const cat = run({ tool_name: 'catfish', tool_input: { command: 'git reset --hard' } }, process.cwd());
  check('catfish 不被词尾形态误收（fish 排除）且告警可见',
    cat.status === 0 && cat.stdout.trim() === '' && /内核不认/.test(cat.stderr || ''),
    `stdout=${cat.stdout} stderr=${cat.stderr}`);
}

// ---- ⑬ 空 stdin → fail-closed 转 ask（2026-11-05 收尾批 ③）----
// 空 stdin 旧实现 input={} → tool_name='' → 判「非 shell 工具」静默放行——与坏 JSON/截断转 ask
// 的 fail-closed 方向相反。已裁决：空输入同样按不可信处理转 ask（reason 说明 hook 输入为空）。
{
  for (const [label, raw] of [['空串', ''], ['纯空白', '  \n ']]) {
    const r = spawnSync(process.execPath, [HOOK], { input: raw, encoding: 'utf8', cwd: process.cwd(), env: { ...process.env } });
    const d = decisionOf(r);
    check(`空 stdin（${label}）→ exit 0（宿主协议）`, r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    check(`空 stdin（${label}）→ fail-closed 转 ask（不再静默放行）`, d && d.permissionDecision === 'ask', r.stdout);
    check(`空 stdin（${label}）→ 理由点明输入为空`, d && /输入为空/.test(d.permissionDecisionReason || ''), d && d.permissionDecisionReason);
  }
}

// ---- ⑭ 决策体 write 撞断管 → EPIPE 静默 exit 0（2026-11-05 收尾批 ⑦）----
// 决策体 write 返回 false 时旧实现只等 once('drain')：宿主已死（读端已销毁）则 drain 永不来，
// 进程悬到宿主 15s 超时；更常见的是 write 直接撞 EPIPE——旧实现无 error 处理，uncaught 崩栈
// exit 1。修复后等 drain 的同时挂一次性 error，先到者胜；EPIPE 静默 exit 0（口径同
// mcp/server.mjs 的 stdout error 处理）。
{
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTxt = '';
    child.stderr.on('data', (c) => { stderrTxt += c; });
    child.stdout.destroy(); // 先销毁读端：决策体 write 必撞断管
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -f' } }));
    const guard = setTimeout(() => child.kill(), 8000);
    child.on('exit', (code) => { clearTimeout(guard); resolve({ code, stderrTxt }); });
    child.on('error', () => { clearTimeout(guard); resolve({ code: -1, stderrTxt }); });
  });
  check('宿主销毁 stdout 读端 → 决策体写挂 exit 0（EPIPE 静默，不崩栈/不悬死）', out.code === 0,
    `exit=${out.code} stderr=${out.stderrTxt.slice(0, 200)}`);
  check('stderr 无 EPIPE 崩栈痕迹', !/EPIPE|Unhandled/i.test(out.stderrTxt), out.stderrTxt.slice(0, 200));
}

// ---- ⑮ 长选项缩写与 shell 转义字符不得绕过 deny 地板（2026-11-08 市场审查 C1/C2）----
// C1：git 接受长选项的无歧义唯一前缀缩写（`--har` ≡ `--hard`、`--no-veri` ≡ `--no-verify`），
//     旧词元判据只做精确等值，缩写形态实测静默放行。
// C2：反斜杠转义由 shell 消化（`printf '%s\n' \-f` 输出 `-f`），git 收到的就是完整选项；
//     cmd.exe 宿主（hooks.json matcher 覆盖）另有 `^` 转义符。`\` 在 JS 字符串与 JSON 两个
//     层面都要转义正确：JS 源里写 `\\`，经 JSON.stringify 注入 stdin 后 hook 读回恰为一个 `\`。
// 反向锚：普通命令不受归一化影响，仍静默放行。
{
  const denyCases = [
    'git reset --har HEAD~1',          // C1 长选项缩写
    'git commit --no-veri -m x',       // C1 长选项缩写
    'git push --no-verif origin main', // C1 长选项缩写
    'git push \\-f origin main',       // C2 反斜杠转义（shell 消化后即 git push -f）
    'git reset \\--hard',              // C2 反斜杠转义
    'git commit \\-n',                 // C2 反斜杠转义
    'git push -\\f',                   // C2 反斜杠转义（剥后成 -f，走短簇形态）
    'git push ^-^f origin main',       // C2 cmd.exe 转义符
  ];
  for (const command of denyCases) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, process.cwd());
    check(`缩写/转义变体仍被 deny：${command}`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
  const okCases = ['git status', 'git push origin main', 'git commit -m "fix: typo"', 'git log --oneline -5'];
  for (const command of okCases) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, process.cwd());
    check(`控制组不受影响（静默放行）：${command}`, r.status === 0 && r.stdout.trim() === '', `stdout=${r.stdout}`);
  }
  // 裸 `--` 分隔符控制组（2026-11-08 设计调整）：前缀模糊要求命令侧词元与规则词长度均 > 3——
  // 否则裸 `--`（len 2）会被 `--hard`.startsWith(`--`) 拉进前缀命中，`git reset -- file.txt`
  // 这类日常命令被误拦（实测）。本组锁修复前基线：前者静默放行（原不命中任何清单）、
  // 后者 ASK（原命中 ask 清单 `git checkout`），不得因前缀调整漂移。
  const rSep = run({ tool_name: 'Bash', tool_input: { command: 'git reset -- file.txt' } }, process.cwd());
  check('裸 -- 分隔符不参与前缀匹配：git reset -- file.txt 静默放行（不误拦日常命令）',
    rSep.status === 0 && rSep.stdout.trim() === '', `stdout=${rSep.stdout}`);
  const rSepAsk = run({ tool_name: 'Bash', tool_input: { command: 'git checkout -- src/a.js' } }, process.cwd());
  check('裸 -- 分隔符不抬升 ask 基线：git checkout -- src/a.js 仍 ASK（锁修复前行为）',
    decisionOf(rSepAsk)?.permissionDecision === 'ask', `stdout=${rSepAsk.stdout}`);
}

// ---- ⑯ 合法 JSON 但非对象（标量/数组）→ fail-closed 转 ask（2026-11-08 市场审查 M1）----
// stdin 喂 `123` / `[1]` / `"x"` 这类**合法 JSON 但非对象**的输入时 tool_name 读不出 → 判
// 「非 shell 工具」静默放行（实测 stdin `123` → 空输出 exit 0）；null 则经 TypeError 顶层 catch
// 才转 ask——与坏 JSON/截断/空输入的 fail-closed 方向三向不一致。修复后并入同一不可信分支，
// ask 理由点明「不是合法的工具调用对象」。null 修复前已 ASK（路径不同、理由不同），只锁决策形态。
{
  for (const [label, raw] of [['数字标量', '123'], ['数组', '[1]'], ['字符串标量', '"x"']]) {
    const r = spawnSync(process.execPath, [HOOK], { input: raw, encoding: 'utf8', cwd: process.cwd(), env: { ...process.env } });
    const d = decisionOf(r);
    check(`非对象 JSON（${label}）→ exit 0（宿主协议）`, r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
    check(`非对象 JSON（${label}）→ fail-closed 转 ask（不再静默放行）`, d && d.permissionDecision === 'ask', r.stdout);
    check(`非对象 JSON（${label}）→ 理由点明非工具调用对象`,
      d && /不是合法的工具调用对象/.test(d.permissionDecisionReason || ''), d && d.permissionDecisionReason);
  }
  const rNull = spawnSync(process.execPath, [HOOK], { input: 'null', encoding: 'utf8', cwd: process.cwd(), env: { ...process.env } });
  check('非对象 JSON（null）→ 仍 fail-closed 转 ask（锁定修复前决策形态）',
    rNull.status === 0 && decisionOf(rNull)?.permissionDecision === 'ask', rNull.stdout);
}

// ---- ⑰ 宿主 shell 辅助工具不误伤（2026-11-09 审查收口）----
{
  // BashOutput/KillShell 不携带 command：按非管辖静默放行（旧实现每次读输出都转 ask）
  for (const name of ['BashOutput', 'KillShell', 'bash_output', 'kill shell']) {
    const r = run({ tool_name: name, tool_input: { shell_id: 'abc' } }, process.cwd());
    check(`宿主辅助工具 ${name} → 静默放行（ask 弹窗噪音消除）`,
      r.status === 0 && String(r.stdout).trim() === '', `stdout=${JSON.stringify(r.stdout)}`);
  }
}

// ---- ⑱ git force 安全变体不误拦（2026-11-09 市场审查）----
// `--force-with-lease`（含 `=ref[:expect]` 带值形态）/ `--force-if-includes`（含 `=n`）是覆盖推送的
// **带保护**形态（租约校验远端引用未被他人更新才推），deny 地板（git push --force）防的是
// 「无保护覆盖他人提交」，安全变体不具该风险面——旧判据按子串前缀 / 词元前缀把它们一并拦下，
// 属过严门禁。修复后安全变体放行（不 deny 也不 ask）；裸 --force / -f 组合形态与其余地板行为不变。
// 值段不被吞：`--force-with-lease=main;git reset --hard` 中和后 `git reset --hard` 子串仍命中地板。
{
  const repo = mkRepo();
  const safeCases = [
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-if-includes origin main',
  ];
  for (const command of safeCases) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, repo);
    check(`force 安全变体放行（非 deny）：${command}`,
      decisionOf(r)?.permissionDecision !== 'deny', `stdout=${r.stdout}`);
  }
  const denyCases = [
    'git push --force --force-with-lease',               // 中和后剩裸 --force → 地板仍拦
    'git push -f origin main',
    'git push origin main --force',
    'git reset --hard HEAD~1',
    'git commit --no-verify -m x',
    'git push --force-with-lease=main;git reset --hard', // 值段不吞后续语句
  ];
  for (const command of denyCases) {
    const r = run({ tool_name: 'Bash', tool_input: { command } }, repo);
    check(`裸 force/组合形态仍被 deny：${command}`, decisionOf(r)?.permissionDecision === 'deny', r.stdout);
  }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
