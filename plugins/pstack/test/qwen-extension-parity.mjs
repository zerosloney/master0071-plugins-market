// Qwen Code extension parity: the builder must assemble a native, self-contained
// extension (no plugin.json) with the shared skills, only the Qwen-runnable
// agents, the qwen hook registration, and the QWEN.md context file.
// Run from the plugin root: node test/qwen-extension-parity.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const P = process.cwd();
if (!existsSync(path.join(P, 'plugin.json')) || !existsSync(path.join(P, 'qwen', 'agents'))) {
  console.error('run this test from the pstack plugin root (plugins/pstack)');
  process.exit(1);
}
const REPO = path.resolve(P, '..', '..');
const OUT = mkdtempSync(path.join(os.tmpdir(), 'pstack-qwen-'));
let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  cond ? pass++ : fail++;
};
const read = (abs) => readFileSync(abs, 'utf8');
const json = (abs) => JSON.parse(read(abs));
const frontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return { meta: m ? m[1] : '', body: m ? text.slice(m[0].length) : text };
};

try {
  const build = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'build-qwen-extension.mjs'), '--out', OUT], {
    cwd: REPO,
    encoding: 'utf8',
  });
  ok('builder exits cleanly', build.status === 0);
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
  }

  const manifestPath = path.join(OUT, 'qwen-extension.json');
  ok('built package has qwen-extension.json', existsSync(manifestPath));
  ok('built package has no plugin.json (Agent Plugins would win)', !existsSync(path.join(OUT, 'plugin.json')));

  const manifest = json(manifestPath);
  const standard = json(path.join(P, 'plugin.json'));
  ok('manifest: name is pstack', manifest.name === 'pstack');
  ok('manifest: version matches plugin.json', manifest.version === standard.version);
  ok('manifest: hooks points at a file', typeof manifest.hooks === 'string' && existsSync(path.join(OUT, manifest.hooks)));
  ok('manifest: context file exists', manifest.contextFileName === './QWEN.md' && existsSync(path.join(OUT, manifest.contextFileName)));

  const skillDirs = readdirSync(path.join(OUT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(OUT, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name);
  ok('built skills tree is non-empty', skillDirs.length > 0);
  ok('every built skill directory has a SKILL.md', skillDirs.length === readdirSync(path.join(OUT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).length);

  const EXPECTED_AGENTS = [
    'comment-sicko',
    'poteto-agent',
    'thermo-nuclear-code-quality-review-subagent',
    'thermo-nuclear-review-subagent',
  ];
  const builtAgents = readdirSync(path.join(OUT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  ok('built agent set is exactly the Qwen-runnable agents', JSON.stringify(builtAgents) === JSON.stringify(EXPECTED_AGENTS));

  for (const name of EXPECTED_AGENTS) {
    const rel = `agents/${name}.md`;
    const shared = frontmatter(read(path.join(P, 'agents', `${name}.md`)));
    const qwen = frontmatter(read(path.join(OUT, rel)));
    const metaName = (qwen.meta.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
    ok(`${rel}: frontmatter name matches the shared agent`, metaName === name);
    ok(`${rel}: no ZCode model pin`, !/^model:/m.test(qwen.meta));
    ok(`${rel}: no thoughtLevel`, !/^thoughtLevel:/m.test(qwen.meta));
    ok(`${rel}: body is not a truncated copy`, qwen.body.trim().length >= shared.body.trim().length * 0.5);
    if (name === 'poteto-agent' || name.startsWith('thermo-nuclear-')) {
      ok(`${rel}: names pstack skills with the pstack: prefix`, qwen.body.includes('pstack:'));
    }
    ok(`${rel}: does not prefix subagent_type with pstack:`, !/subagent_type:\s*"pstack:/.test(qwen.body));
  }

  const hookReg = json(path.join(OUT, manifest.hooks));
  const sessionStart = hookReg?.hooks?.SessionStart?.[0];
  ok('built hook: SessionStart registration exists', Boolean(sessionStart));
  ok('built hook: matcher covers startup/resume/clear/compact', sessionStart?.matcher === 'startup|resume|clear|compact');
  const command = sessionStart?.hooks?.[0]?.command ?? '';
  ok('built hook: command runs the shared script with the qwen runtime',
    command.includes('session-start.mjs') && /session-start\.mjs"?\s+qwen\b/.test(command));
  ok('built hook: command uses the substituted plugin root', command.includes('${CLAUDE_PLUGIN_ROOT}'));
  for (const file of ['hooks/session-start.mjs', 'hooks/sheet.mjs', 'hooks/session-start-context.md']) {
    ok(`built package carries ${file}`, existsSync(path.join(OUT, file)));
  }

  const qwenContext = read(path.join(OUT, 'QWEN.md'));
  ok('QWEN.md: names the pstack: skill namespace', qwenContext.includes('pstack:<name>'));
  ok('QWEN.md: names extension agents without a prefix', qwenContext.includes('subagent_type: "poteto-agent"'));
  ok('QWEN.md: points at qwen-tools.md', qwenContext.includes('qwen-tools.md'));
  ok('QWEN.md: names the Qwen sheet path', qwenContext.includes('pstack-models.md'));

  const mapping = read(path.join(P, 'skills', 'poteto-mode', 'references', 'qwen-tools.md'));
  for (const tool of ['read_file', 'write_file', 'edit', 'run_shell_command', 'grep_search', 'glob', 'web_fetch', 'web_search', 'skill', 'agent', 'ask_user_question', 'todo_write']) {
    ok(`qwen-tools.md maps ${tool}`, mapping.includes(`\`${tool}\``));
  }
  ok('qwen-tools.md: documents model grades', mapping.includes('agents.modelGrades'));
  ok('qwen-tools.md: documents the qwen sheet path', mapping.includes('${QWEN_HOME:-~/.qwen}/pstack-models.md'));
  ok('qwen-tools.md: documents the pstack: skill namespace', mapping.includes('pstack:<name>') || mapping.includes('pstack:poteto-mode'));
  ok('qwen-tools.md: dispatches extension agents by authored name', mapping.includes('subagent_type: "poteto-agent"'));
  ok('qwen-tools.md: explains the agent-prefix mismatch', mapping.includes('drop the `pstack:` prefix') || mapping.includes('Do **not** prefix'));

  const setup = read(path.join(P, 'skills', 'setup-pstack', 'SKILL.md'));
  ok('setup-pstack: points at the Qwen setup', setup.includes('(qwen.md)'));
  ok('setup-pstack: lists the Qwen runtime row', setup.includes('| Qwen Code |'));

  const hookScript = read(path.join(P, 'hooks', 'session-start.mjs'));
  ok('session-start.mjs: supports the qwen runtime', /qwen:\s*\(\)\s*=>/.test(hookScript));
  ok('session-start.mjs: reads QWEN_HOME', hookScript.includes('QWEN_HOME'));
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
