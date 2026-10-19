// One-shot test suite for the node hook port: session-start.mjs (all four
// runtimes x sheet states) and pre-tool-use.mjs (view/task/bash rules, parser
// strictness). Run: node hooks/run-hook-tests.mjs (from the plugin root).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const P = process.cwd().replaceAll('\\', '/');
const envBase = { ...process.env, CLAUDE_PLUGIN_ROOT: P };
const run = (script, args, env, input = '') => {
  const r = spawnSync(process.execPath, [path.join(P, 'hooks', script), ...args], {
    env, input, encoding: 'utf8', timeout: 20000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  cond ? pass++ : fail++;
};

const home = mkdtempSync(path.join(tmpdir(), 'pstack-hook-test-'));
const claudeHome = path.join(home, 'claude');
const codexHome = path.join(home, 'codex');
const copilotHome = path.join(home, 'copilot');
const zcodeHome = path.join(home, '.zcode');
const ws = path.join(home, 'ws');
for (const d of [claudeHome, codexHome, copilotHome, zcodeHome, ws]) mkdirSync(d);
const posix = (p) => p.replaceAll('\\', '/');

const ROLES = ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment and prose', 'strongest judgment',
  'how explorer', 'how explainer', 'why investigators', 'why synthesizer', 'reflect tooling',
  'reflect judgment, divergent, synthesizer'];
const PANELS = ['arena runners', 'arena cross-judge pool', 'architect runners', 'interrogate reviewers'];
const VALID_SHEET = ['# pstack model configuration',
  ...ROLES.map((r) => `${r}: inherit-parent`),
  ...PANELS.map((r) => `${r}: a-1, b-1`),
  'swarm workers: inherit-parent',
  'default effort: session',
  'session hook: on'].join('\n') + '\n';

// ── session-start.mjs ────────────────────────────────────────────────────────
const mandate = readFileSync(path.join(P, 'hooks', 'session-start-context.md'), 'utf8');

let r = run('session-start.mjs', ['claude'], { ...envBase, CLAUDE_CONFIG_DIR: path.join(home, 'missing') });
ok('claude no sheet: byte-identical mandate', r.code === 0 && r.out === mandate);
writeFileSync(path.join(claudeHome, 'pstack-models.md'), 'session hook: off\n');
r = run('session-start.mjs', ['claude'], { ...envBase, CLAUDE_CONFIG_DIR: claudeHome });
ok('claude off (utf8): silent', r.code === 0 && r.out === '');
writeFileSync(path.join(claudeHome, 'pstack-models.md'), '\uFEFF# x\r\nsession hook: off\r\n', 'utf16le');
r = run('session-start.mjs', ['claude'], { ...envBase, CLAUDE_CONFIG_DIR: claudeHome });
ok('claude off (utf16le BOM): silent', r.code === 0 && r.out === '');

r = run('session-start.mjs', ['codex'], { ...envBase, CODEX_HOME: codexHome });
ok('codex no sheet: mandate', r.code === 0 && r.out === mandate);
writeFileSync(path.join(codexHome, 'pstack-models.md'), 'session hook: off\n');
r = run('session-start.mjs', ['codex'], { ...envBase, CODEX_HOME: codexHome });
ok('codex off: silent', r.code === 0 && r.out === '');

r = run('session-start.mjs', ['zcode'], { ...envBase, USERPROFILE: home });
let j = JSON.parse(r.out);
ok('zcode no sheet: JSON mandate', r.code === 0 && j.hookSpecificOutput.hookEventName === 'SessionStart'
  && j.hookSpecificOutput.additionalContext.includes('pstack:poteto-mode'));
writeFileSync(path.join(zcodeHome, 'pstack-models.md'), 'session hook: off\n');
r = run('session-start.mjs', ['zcode'], { ...envBase, USERPROFILE: home });
ok('zcode off: silent', r.code === 0 && r.out === '');
rmSync(path.join(zcodeHome, 'pstack-models.md'));

r = run('session-start.mjs', ['copilot'], { ...envBase, COPILOT_HOME: copilotHome });
j = JSON.parse(r.out);
const ac = j.additionalContext;
ok('copilot no sheet: setup note spliced before close tag', ac.includes('no valid pstack model sheet')
  && ac.indexOf('no valid pstack model sheet') < ac.indexOf('</EXTREMELY_IMPORTANT>'));
writeFileSync(path.join(copilotHome, 'pstack-models.md'), VALID_SHEET);
r = run('session-start.mjs', ['copilot'], { ...envBase, COPILOT_HOME: copilotHome });
j = JSON.parse(r.out);
ok('copilot valid sheet: role lines + no invalid marker', j.additionalContext.includes('feature, refactoring: inherit-parent')
  && j.additionalContext.includes('arena runners: a-1, b-1') && j.additionalContext.includes('default effort: session')
  && !j.additionalContext.includes('sheet invalid'));
writeFileSync(path.join(copilotHome, 'pstack-models.md'), '# only\nbug-fix: inherit-parent\n');
r = run('session-start.mjs', ['copilot'], { ...envBase, COPILOT_HOME: copilotHome });
j = JSON.parse(r.out);
ok('copilot invalid sheet: names problems + setup note', j.additionalContext.includes('sheet invalid: missing role')
  && j.additionalContext.includes('no valid pstack model sheet'));
r = run('session-start.mjs', ['nonsense']);
ok('unknown runtime: exit 2 + stderr', r.code === 2 && r.err.includes('unknown runtime'));

// ── host auto-detection: ZCode registers hooks/hooks.json by convention, so
// the claude-arg registration must switch to the zcode branch on ZCode ──────
const zRoot = mkdtempSync(path.join(tmpdir(), 'pstack-hook-test-.zcode-'));
mkdirSync(path.join(zRoot, 'hooks'), { recursive: true });
writeFileSync(path.join(zRoot, 'hooks', 'session-start-context.md'), mandate);
r = run('session-start.mjs', ['claude'], { ...envBase, ZCODE_PLUGIN_ROOT: P, USERPROFILE: home });
j = JSON.parse(r.out);
ok('detect via ZCODE_PLUGIN_ROOT: zcode JSON despite claude arg', j.hookSpecificOutput.hookEventName === 'SessionStart'
  && j.hookSpecificOutput.additionalContext.includes('pstack:poteto-mode'));
r = run('session-start.mjs', ['claude'], { ...envBase, CLAUDE_PLUGIN_ROOT: zRoot, USERPROFILE: home });
j = JSON.parse(r.out);
ok('detect via .zcode root path: zcode JSON despite claude arg', j.hookSpecificOutput.hookEventName === 'SessionStart');
writeFileSync(path.join(zcodeHome, 'pstack-models.md'), 'session hook: off\n');
r = run('session-start.mjs', ['claude'], { ...envBase, ZCODE_PLUGIN_ROOT: P, USERPROFILE: home });
ok('detect zcode + off: silent', r.code === 0 && r.out === '');
r = run('session-start.mjs', ['claude'], { ...envBase, CLAUDE_CONFIG_DIR: path.join(home, 'missing') });
ok('no detection signals: claude arg stays claude (plain mandate)', r.code === 0 && r.out === mandate);
rmSync(zRoot, { recursive: true, force: true });

// ── pre-tool-use.mjs ─────────────────────────────────────────────────────────
writeFileSync(path.join(copilotHome, 'pstack-models.md'), VALID_SHEET);
const ptu = (input) => run('pre-tool-use.mjs', [], {
  ...envBase, COPILOT_PLUGIN_ROOT: P, COPILOT_HOME: copilotHome,
}, input);
const payload = (o) => JSON.stringify(o);
const wsPosix = posix(ws);
const ALLOW = '{"permissionDecision":"allow"}';

r = ptu(payload({ tool_name: 'Read', tool_input: { path: `${P}/skills/tdd/SKILL.md` }, cwd: wsPosix }));
ok('view plugin file: allow', r.code === 0 && r.out.trim() === ALLOW);
r = ptu(payload({ toolName: 'view', toolArgs: { path: `${P}/skills/tdd/SKILL.md` } }));
ok('PascalCase payload: allow', r.out.trim() === ALLOW);
r = ptu(payload({ tool_name: 'Read', tool_input: { path: 'C:/Windows/win.ini' }, cwd: wsPosix }));
ok('view outside plugin: silent', r.out === '');
r = ptu(payload({ tool_name: 'Read', tool_input: { path: `${P}/x"y` }, cwd: wsPosix }));
ok('view quoted path: silent', r.out === '');

r = ptu(payload({ tool_name: 'Task', tool_input: { agent_type: 'pstack:poteto-agent', model: 'gpt-x' }, cwd: wsPosix }));
ok('task unsaved model (all-alias sheet): deny without model', r.out.includes('"permissionDecision":"deny"')
  && r.out.includes('inherit-parent or auto'));
writeFileSync(path.join(copilotHome, 'pstack-models.md'), VALID_SHEET.replace('swarm workers: inherit-parent', 'swarm workers: a-1'));
r = ptu(payload({ tool_name: 'Task', tool_input: { agent_type: 'pstack:poteto-agent', model: 'a-1' }, cwd: wsPosix }));
ok('task saved model: silent', r.out === '');
r = ptu(payload({ tool_name: 'Task', tool_input: { agent_type: 'pstack:poteto-agent', model: 'gpt-x' }, cwd: wsPosix }));
ok('task unsaved real model: deny lists saved ids', r.out.includes('deny') && r.out.includes('`a-1`'));
r = ptu(payload({ tool_name: 'Task', tool_input: { agent_type: 'general-purpose', model: 'gpt-x' }, cwd: wsPosix }));
ok('task non-pstack agent: silent', r.out === '');
r = ptu(payload({ tool_name: 'Task', tool_input: { agent_type: 'pstack:poteto-agent' }, cwd: wsPosix }));
ok('task without model: silent', r.out === '');

r = ptu(payload({ tool_name: 'Bash', tool_input: { command: `node ${P}/skills/poteto-mode/scripts/check-plan.mjs ${wsPosix}/plan.md` }, cwd: wsPosix }));
ok('bash contracted script: allow', r.out.trim() === ALLOW);
r = ptu(payload({ tool_name: 'Bash', tool_input: { command: `node ${P}/skills/poteto-mode/scripts/check-plan.mjs ${wsPosix}/a; rm x` }, cwd: wsPosix }));
ok('bash metacharacter: silent', r.out === '');
r = ptu(payload({ tool_name: 'Bash', tool_input: { command: `node ${P}/skills/poteto-mode/scripts/orch/orch.ts ${wsPosix}/x` }, cwd: wsPosix }));
ok('bash unregistered script: silent', r.out === '');
r = ptu(payload({ tool_name: 'Bash', tool_input: { command: `node ${P}/skills/poteto-mode/scripts/check-plan.mjs /etc/passwd` }, cwd: wsPosix }));
ok('bash absolute operand outside cwd: silent', r.out === '');
r = ptu(payload({ tool_name: 'Bash', tool_input: { command: `node ${P}/skills/poteto-mode/scripts/check-plan.mjs ../plan.md` }, cwd: wsPosix }));
ok('bash dotdot operand: silent', r.out === '');

r = ptu('{"tool_name":"Read","tool_name":"Bash","tool_input":{},"cwd":"/tmp"}');
ok('duplicate keys: silent', r.out === '' && r.code === 0);
r = ptu(payload({ tool_name: 'Read', tool_input: { path: '/x' }, cwd: wsPosix }) + ' trailing');
ok('trailing garbage: silent', r.out === '');
r = ptu('');
ok('empty stdin: silent', r.out === '' && r.code === 0);

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
