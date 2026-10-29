#!/usr/bin/env node
// SessionStart entry for pstack, all runtimes: `node session-start.mjs <runtime>`
// with runtime one of claude, codex, copilot, zcode. Replaces the POSIX
// session-start.sh / PowerShell session-start.ps1 pair: Windows hosts execute
// .sh through a shell that opens it as a document instead of running it, so
// every hook registration now runs this node script instead. Behavior is the
// sh entry's: a sheet that cannot be decoded counts as missing, `session hook:
// off` stays silent, and otherwise the mandate is injected. Claude Code and
// Codex get the bare mandate text; ZCode parses hook stdout as strict JSON, so
// it gets hookSpecificOutput.additionalContext; GitHub Copilot parses stdout as
// one JSON object and its sheet sits outside its sandbox, so its role lines are
// checked here and spliced into the mandate (ports copilot-context.awk).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSheet, readSheet, ROLES } from './sheet.mjs';

// 插件内的 hooks 目录：脚本自身位于 <plugin>/hooks/session-start.mjs，据此定位比读宿主
// 环境变量可靠。各宿主给的变量名并不统一（CLAUDE_ / ZCODE_ / COPILOT_ / CODEX_），
// 少一个就拿不到插件根；环境变量只用来识别宿主，不用来定位路径。
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
// 宿主声明的插件根：只用于识别宿主（ZCode 的注册会带 claude 参数，靠这个切分支）。
const hostRoot = process.env.COPILOT_PLUGIN_ROOT
  ?? process.env.ZCODE_PLUGIN_ROOT
  ?? process.env.CLAUDE_PLUGIN_ROOT
  ?? process.env.CODEX_PLUGIN_ROOT;

// ZCode registers hooks/hooks.json by convention and ignores a manifest hooks
// pointer, so the one registration file serves both hosts and arrives here
// with the claude argument on ZCode too. Detect the host instead of trusting
// it: ZCODE_PLUGIN_ROOT set, or the expanded plugin root living under a
// `.zcode` directory segment. The segment comparison is case-insensitive and
// exact per segment, so a sibling like `.zcodebackup` or a name that merely
// contains `.zcode` cannot trigger it.
const isZcodeSegment = (p) => p.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.zcode');
const detected = (process.env.ZCODE_PLUGIN_ROOT || isZcodeSegment(hostRoot ?? '')) ? 'zcode' : null;
const runtime = detected ?? process.argv[2];
const sheets = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'pstack-models.md'),
  codex: () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pstack-models.md'),
  copilot: () => join(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'pstack-models.md'),
  // ZCODE_HOME mirrors CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME: an
  // override for tests and relocated installs.
  zcode: () => join(process.env.ZCODE_HOME ?? join(homedir(), '.zcode'), 'pstack-models.md'),
};
// Object.hasOwn 而非 `in`（2026-10-29 修复）：`in` 沿原型链匹配，runtime="toString" /
// "constructor" / "valueOf" 时全部通过校验，随后 `sheets[runtime]()` 取到的是原型函数——
// 实测 `toString` 分支静默输出 **claude** 的路由令（把一张无关的表当成用户模型表读），
// `__proto__` 则直接抛未捕获 TypeError、exit 1。运行时名来自 argv，不是可信输入。
if (!Object.hasOwn(sheets, runtime)) {
  console.error(`session-start.mjs: unknown runtime '${runtime ?? ''}' (expected claude, codex, copilot, or zcode)`);
  process.exit(2);
}

const hooksDir = HOOKS_DIR;

// A file's text without its trailing newline, like the awk text() helper.
const text = (name) => readFileSync(join(hooksDir, name), 'utf8').replace(/\n$/, '');

const sheet = readSheet(sheets[runtime]());
if (sheet !== null && sheet.split('\n').includes('session hook: off')) process.exit(0);

if (runtime === 'zcode') {
  const mandate = readFileSync(join(hooksDir, 'session-start-context.md'), 'utf8').trimEnd();
  // No process.exit after the write: stdout on a Windows pipe is asynchronous.
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: mandate },
    })}\n`,
  );
} else if (runtime === 'copilot') {
  const p = sheet === null ? null : parseSheet(sheet);
  let notes = text('session-start-copilot.md');
  const problems = p === null ? 'no sheet' : p.problems;
  if (problems === '') {
    notes += `\n\n${text('session-start-copilot-sheet.md')}\n`;
    for (const role of ROLES) notes += `\n${role}: ${p.value[role]}`;
    if ('default effort' in p.value) notes += `\ndefault effort: ${p.value['default effort']}`;
  } else {
    if (p !== null) notes += `\n\nsheet invalid: ${problems}`;
    notes += `\n\n${text('session-start-copilot-setup.md')}`;
  }
  let body = text('session-start-context.md');
  const closeTag = '</EXTREMELY_IMPORTANT>';
  const i = body.indexOf(closeTag);
  body = i >= 0 ? `${body.slice(0, i)}\n${notes}\n${body.slice(i)}` : `${body}\n${notes}`;
  process.stdout.write(`${JSON.stringify({ additionalContext: body })}\n`);
} else {
  // Claude Code and Codex: the mandate verbatim, byte for byte like `cat`.
  process.stdout.write(readFileSync(join(hooksDir, 'session-start-context.md')));
}
