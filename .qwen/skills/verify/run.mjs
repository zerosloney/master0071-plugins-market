#!/usr/bin/env node
// Drive this repository the way CI does: parse .github/workflows/ci.yml, replay
// every `run:` step against the real artifacts, and keep one log per step under
// artifacts/verify/<stamp>/.
//
//   node .qwen/skills/verify/run.mjs --doctor           # read-only preflight
//   node .qwen/skills/verify/run.mjs --list             # steps, in CI order
//   node .qwen/skills/verify/run.mjs                    # every step
//   node .qwen/skills/verify/run.mjs --only worktree    # steps matching text
//   node .qwen/skills/verify/run.mjs --keep-going       # do not stop at first failure
//
// Exit code is non-zero when a step fails. The runner never kills processes and
// never deletes dist/; tests clean their own temporary directories.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

function findRoot(start) {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, '.github', 'workflows', 'ci.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no .github/workflows/ci.yml above ${start}`);
}

const ROOT = findRoot(SKILL_DIR);
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');

function parseCi(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  let lastName = null;
  for (let i = 0; i < lines.length; i += 1) {
    const nameMatch = lines[i].match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (nameMatch) lastName = nameMatch[1].replace(/^["']|["']$/g, '');
    const runMatch = lines[i].match(/^(\s*)run:\s*(.*)$/);
    if (!runMatch) continue;
    const indent = runMatch[1].length;
    const value = runMatch[2];
    if (/^[A-Za-z_][\w-]*:\s/.test(value)) continue; // `run: shell: bash` is a map, not a command
    const commands = [];
    if (/^[|>][-+]?\s*$/.test(value)) {
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') {
          block.push('');
          continue;
        }
        if (lines[j].search(/\S/) <= indent) break;
        block.push(lines[j]);
      }
      const indents = block.filter((line) => line.trim()).map((line) => line.search(/\S/));
      const minIndent = Math.min(...indents);
      for (const line of block) commands.push(line.slice(minIndent).replace(/\s+$/, ''));
      i = j - 1;
    } else if (value !== '') {
      commands.push(value);
    }
    const usable = commands.filter((line) => line.trim() && !line.trim().startsWith('#'));
    if (usable.length > 0) steps.push({ name: lastName ?? `step ${steps.length + 1}`, commands: usable });
    lastName = null;
  }
  return steps;
}

const steps = parseCi(readFileSync(CI, 'utf8'));

function git(argsList, cwd = ROOT) {
  const res = spawnSync('git', argsList, { cwd, encoding: 'utf8' });
  return res.status === 0 ? (res.stdout || '').trim() : null;
}

function doctor() {
  const checks = [];
  const add = (label, ok, detail, fatal = true) => checks.push({ label, ok, detail, fatal });

  const major = Number(process.versions.node.split('.')[0]);
  add(`node ${process.version}`, major >= 18, 'tests target Node 18 and newer', true);
  add('git on PATH', git(['--version']) !== null, git(['--version']) || 'git --version failed', true);

  const email = git(['config', '--get', 'user.email']);
  const name = git(['config', '--get', 'user.name']);
  const hasIdentity = Boolean(email && name);
  add(
    'git identity for worktree-ops commits',
    hasIdentity,
    hasIdentity ? `${name} <${email}>` : 'missing; the runner exports GIT_AUTHOR_*/GIT_COMMITTER_* for the test subprocesses',
    false,
  );

  const names = steps.map((step) => step.name);
  const sentinels = ['Version consistency (release.mjs --check)', 'Manifest / shim consistency (manifest-lint.mjs)'];
  const hasSuite = steps.some((step) => /\stests$/.test(step.name));
  const parsed = sentinels.every((name) => names.includes(name)) && hasSuite;
  add(`ci.yml parses (${steps.length} steps)`, parsed, parsed ? CI : `${CI} — missing a known step; the parser drifted`, true);

  let plugins = [];
  try {
    plugins = JSON.parse(readFileSync(path.join(ROOT, 'marketplace.json'), 'utf8')).plugins;
  } catch (error) {
    add('marketplace.json reads', false, String(error), true);
  }
  if (plugins.length > 0) {
    const missing = plugins
      .filter((entry) => !existsSync(path.join(ROOT, entry.source, 'plugin.json')))
      .map((entry) => entry.name);
    add(`marketplace entries resolve (${plugins.length})`, missing.length === 0, missing.join(', ') || 'all plugin.json present', true);
  }

  const distManifest = path.join(ROOT, 'dist', 'qwen-pstack', 'qwen-extension.json');
  add(
    'dist/qwen-pstack',
    true,
    existsSync(distManifest) ? 'present (regenerate before trusting it)' : 'absent — run node scripts/build-qwen-extension.mjs when driving the Qwen package',
    false,
  );

  let failed = false;
  for (const check of checks) {
    const mark = check.ok ? '✓' : check.fatal ? '✗' : '!';
    console.log(`${mark} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
    if (!check.ok && check.fatal) failed = true;
  }
  console.log(failed ? '\nnot worth driving until the ✗ lines are fixed' : '\ninstance is worth driving');
  return failed ? 1 : 0;
}

if (flag('--doctor')) process.exit(doctor());

const only = option('--only');
const selected = only
  ? steps.filter((step) => (step.name + '\n' + step.commands.join('\n')).toLowerCase().includes(only.toLowerCase()))
  : steps;

if (flag('--list')) {
  for (const step of selected) {
    console.log(step.name);
    for (const command of step.commands) console.log(`    ${command}`);
  }
  process.exit(0);
}

if (selected.length === 0) {
  console.error(`no ci.yml step matches "${only}" — try --list`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, 'Z');
const evidence = path.join(ROOT, 'artifacts', 'verify', stamp);
mkdirSync(evidence, { recursive: true });

const env = { ...process.env };
if (!git(['config', '--get', 'user.email']) || !git(['config', '--get', 'user.name'])) {
  env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME || 'verify-runner';
  env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL || 'verify-runner@example.invalid';
  env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME || 'verify-runner';
  env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL || 'verify-runner@example.invalid';
}

const results = [];
const startedAt = new Date();
let aborted = false;

for (const [index, step] of selected.entries()) {
  if (aborted) {
    results.push({ name: step.name, status: 'skipped' });
    continue;
  }
  // CI sets a global git identity on the runner. Replaying that here would rewrite
  // the user's own ~/.gitconfig, so the step is reported and skipped; the env
  // fallback below already covers the suites that need to commit.
  if (step.commands.some((command) => /git\s+config\s+--global/.test(command))) {
    results.push({ name: step.name, status: 'skipped', reason: 'CI-only: writes the global git identity' });
    console.log(`– ${step.name} (skipped: CI-only, writes the global git identity)`);
    continue;
  }
  const began = Date.now();
  const log = [];
  let cwd = ROOT;
  let failure = null;

  for (const command of step.commands) {
    const cd = command.match(/^cd\s+(.+?)\s*$/);
    if (cd) {
      const next = path.resolve(cwd, cd[1]);
      log.push(`$ cd ${cd[1]}`);
      if (!next.startsWith(ROOT)) {
        failure = `cd escapes the repository: ${cd[1]}`;
        break;
      }
      if (!existsSync(next)) {
        failure = `cd target does not exist: ${cd[1]}`;
        break;
      }
      cwd = next;
      continue;
    }
    log.push(`$ ${command}`);
    const res = spawnSync(command, { cwd, env, encoding: 'utf8', shell: true });
    log.push((res.stdout || '').trimEnd(), (res.stderr || '').trimEnd());
    if (res.status !== 0) {
      failure = `exit ${res.status === null ? 'spawn error' : res.status} from: ${command}`;
      break;
    }
  }

  const slug = step.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const logPath = path.join(evidence, `${String(index + 1).padStart(2, '0')}-${slug}.log`);
  writeFileSync(logPath, `${step.name}\n\n${log.filter((line) => line !== '').join('\n')}\n`);
  const durationMs = Date.now() - began;
  const status = failure ? 'failed' : 'passed';
  results.push({ name: step.name, status, durationMs, log: path.relative(ROOT, logPath), failure });
  console.log(`${failure ? '✗' : '✓'} ${step.name} (${(durationMs / 1000).toFixed(1)}s)`);

  if (failure) {
    console.error(`    ${failure}`);
    const tail = log.slice(-12).filter((line) => line.trim());
    for (const line of tail) console.error(`    ${line}`);
    if (!flag('--keep-going')) aborted = true;
  }
}

writeFileSync(
  path.join(evidence, 'summary.json'),
  `${JSON.stringify(
    {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      node: process.version,
      head: git(['rev-parse', 'HEAD']),
      dirtyFiles: (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length,
      only: only ?? null,
      results,
    },
    null,
    2,
  )}\n`,
);

const failed = results.filter((result) => result.status === 'failed');
const passed = results.filter((result) => result.status === 'passed');
const skipped = results.filter((result) => result.status === 'skipped');
console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped — evidence: ${path.relative(ROOT, evidence)}`,
);
process.exit(failed.length > 0 ? 1 : 0);
