#!/usr/bin/env node
// ZCode SessionStart entry for pstack. Mirrors the claude branch of
// hooks/session-start.sh: a sheet that cannot be decoded counts as missing,
// `session hook: off` stays silent, and otherwise the mandate is injected.
// ZCode parses hook stdout as strict JSON and runs command hooks through a
// Windows shell, so this entry is a plain node script (no shell) emitting
// hookSpecificOutput.additionalContext instead of the bare text the sh entry
// prints for Claude Code.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sheetPath = join(homedir(), '.zcode', 'pstack-models.md');
const maxBytes = 1024 * 1024;

// Decode like skills/setup-pstack/scripts/read-sheet.sh: 1 MiB cap, UTF-16LE
// BOM or UTF-8, leading BOM stripped, CR at line ends dropped.
function readSheet() {
  let buf;
  try {
    buf = readFileSync(sheetPath);
  } catch {
    return null;
  }
  if (buf.length > maxBytes) return null;
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

const sheet = readSheet();
if (sheet !== null && sheet.split('\n').includes('session hook: off')) process.exit(0);

const root = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
if (!root) {
  console.error('session-start-zcode.mjs: ZCODE_PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT is not set');
  process.exit(1);
}
let mandate;
try {
  mandate = readFileSync(join(root, 'hooks', 'session-start-context.md'), 'utf8');
} catch (err) {
  console.error(`session-start-zcode.mjs: cannot read the mandate: ${err.message}`);
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: mandate.trimEnd() },
  })}\n`,
);
