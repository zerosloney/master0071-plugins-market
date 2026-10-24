// Parity between the node sheet engine (hooks/sheet.mjs) and the POSIX awk
// engine it was ported from (skills/setup-pstack/scripts/sheet.awk +
// check-sheet.awk): every fixture must produce the same verdict and the same
// problems string on both sides. Skips when awk is unavailable (plain Windows
// hosts without a POSIX toolkit), which is also why the hook port itself never
// depends on awk. Run: node test/sheet-parity.mjs (from the plugin root).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseSheet } from '../hooks/sheet.mjs';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AWK_DIR = path.join(PLUGIN_ROOT, 'skills', 'setup-pstack', 'scripts');

const ROLES = ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment and prose', 'strongest judgment',
  'how explorer', 'how explainer', 'why investigators', 'why synthesizer', 'reflect tooling',
  'reflect judgment, divergent, synthesizer'];
const PANELS = ['arena runners', 'arena cross-judge pool', 'architect runners', 'interrogate reviewers'];
const validSheet = () => ['# pstack model configuration',
  ...ROLES.map((r) => `${r}: inherit-parent`),
  ...PANELS.map((r) => `${r}: a-1, b-1`),
  'swarm workers: inherit-parent',
  'default effort: session',
  'session hook: on'].join('\n') + '\n';

const dropRole = (role) => validSheet().split('\n').filter((l) => !l.startsWith(`${role}:`)).join('\n') + '\n';
const swapLine = (from, to) => validSheet().replace(from, to);

const fixtures = [
  { name: 'valid sheet', text: validSheet() },
  { name: 'missing role', text: dropRole('bug-fix') },
  { name: 'missing panel role', text: dropRole('architect runners') },
  { name: 'unknown line', text: swapLine('session hook: on', 'session hook: on\nmade-up role: inherit-parent') },
  { name: 'invalid default effort', text: swapLine('default effort: session', 'default effort: ultra') },
  { name: 'high default effort', text: swapLine('default effort: session', 'default effort: high') },
  { name: 'no default effort line', text: dropRole('default effort: session').replace('default effort: session\n', '') },
  { name: 'empty role value', text: swapLine('bug-fix: inherit-parent', 'bug-fix:') },
  { name: 'panel with double space', text: swapLine('arena runners: a-1, b-1', 'arena runners: a-1,  b-1') },
  { name: 'hook off still validates', text: swapLine('session hook: on', 'session hook: off') },
];

// Probe PATH first, then the usual Windows awk installs (Git for Windows ships
// gawk in usr/bin; MSYS2 and GnuWin32 are the other common sources), so the
// parity check actually runs on Windows hosts instead of always skipping.
const AWK_CANDIDATES = [
  'awk',
  'C:/Program Files/Git/usr/bin/awk.exe',
  'C:/msys64/usr/bin/awk.exe',
  'C:/Program Files (x86)/GnuWin32/bin/awk.exe',
];
const findAwk = () => AWK_CANDIDATES.find((a) => !spawnSync(a, ['--version'], { encoding: 'utf8', timeout: 5000 }).error);
const AWK = findAwk();

const runAwk = (text) => spawnSync(AWK, ['-f', path.join(AWK_DIR, 'sheet.awk'), '-f', path.join(AWK_DIR, 'check-sheet.awk')], {
  input: text, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 20000,
});

if (AWK === undefined) {
  console.log('skip: awk unavailable (nothing on PATH or in the usual Git/MSYS2 installs); the node engine is the only sheet checker on this host');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  cond ? pass++ : fail++;
};

const awkProblems = (r) => {
  const out = (r.stdout ?? '').trim();
  if (out === 'sheet ok') return '';
  if (out.startsWith('sheet invalid: ')) return out.slice('sheet invalid: '.length);
  return `<unrecognized awk output: ${JSON.stringify(out)} exit=${r.status}>`;
};

for (const f of fixtures) {
  const node = parseSheet(f.text);
  const nodeProblems = node === null ? '<undecodable>' : node.problems;
  const awk = awkProblems(runAwk(f.text));
  ok(`${f.name}: same verdict`, (nodeProblems === '') === (awk === ''), `node="${nodeProblems}" awk="${awk}"`);
  ok(`${f.name}: same problems`, nodeProblems === awk, `node="${nodeProblems}" awk="${awk}"`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
