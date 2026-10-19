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
import { join } from 'node:path';
import { parseSheet, readSheet, ROLES } from './sheet.mjs';

const runtime = process.argv[2];
const sheets = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'pstack-models.md'),
  codex: () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pstack-models.md'),
  copilot: () => join(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'pstack-models.md'),
  zcode: () => join(homedir(), '.zcode', 'pstack-models.md'),
};
if (!(runtime in sheets)) {
  console.error(`session-start.mjs: unknown runtime '${runtime ?? ''}' (expected claude, codex, copilot, or zcode)`);
  process.exit(2);
}

const root = process.env.COPILOT_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
if (!root) {
  console.error('session-start.mjs: no plugin root variable (CLAUDE_PLUGIN_ROOT / ZCODE_PLUGIN_ROOT / COPILOT_PLUGIN_ROOT) is set');
  process.exit(1);
}
const hooksDir = join(root, 'hooks');

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
