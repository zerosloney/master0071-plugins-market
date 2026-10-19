#!/usr/bin/env node
// GitHub Copilot PreToolUse gate for pstack. Replaces pre-tool-use.sh plus its
// awk engine (json.awk, sheet.awk, script-contracts.awk, pre-tool-use.awk):
// Windows hosts execute .sh through a shell that opens it as a document
// instead of running it. Decides one call: it approves `view` of this plugin's
// own files and the strict form of a vendored script run, and it denies a
// pstack agent dispatch on a model the user did not save. Anything else gets
// no output and takes the normal permission flow. Copilot denies the call when
// the hook exits non-zero, so every path exits 0.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseSheet, readSheet } from './sheet.mjs';

const root = process.env.COPILOT_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT;
// Node's realpathSync returns backslash-separated paths on Windows while the
// gate compares forward-slash segments, like `pwd -P` output on POSIX.
const toPosix = (p) => p.replaceAll('\\', '/');
const real = (() => {
  try {
    return toPosix(realpathSync(root));
  } catch {
    return root;
  }
})();
const sheetPath = path.join(process.env.COPILOT_HOME ?? path.join(homedir(), '.copilot'), 'pstack-models.md');

// ── strict JSON: one complete object, duplicate keys rejected ────────────────
// Mirrors json.awk: stores node types in JT and raw string values in M under
// JSON-Pointer-style paths, so a permission decision never depends on parser
// precedence.
const JT = new Map();
const M = new Map();

function jkey(key) {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function parse(text) {
  let pos = 0;
  const ws = () => {
    while (pos < text.length && ' \t\r\n'.includes(text[pos])) pos++;
  };
  const str = () => {
    if (text[pos] !== '"') return null;
    // Sticky, anchored at lastIndex: a leading ^ would only ever match at 0.
    const re = /"(?:[^"\\\x00-\x1f]|\\(?:["\\\/bfnrt]|u[0-9A-Fa-f]{4}))*"/y;
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return null;
    pos = re.lastIndex;
    return m[0].slice(1, -1);
  };
  const prim = () => {
    const re = /^(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/;
    const rest = text.slice(pos);
    const m = rest.match(re);
    if (!m) return null;
    pos += m[0].length;
    return m[0];
  };
  const value = (p) => {
    ws();
    const c = text[pos];
    if (c === '{') return object(p);
    if (c === '[') return array(p);
    if (c === '"') {
      const raw = str();
      if (raw === null) return false;
      JT.set(p, 'string');
      M.set(p, raw);
      return true;
    }
    JT.set(p, 'primitive');
    return prim() !== null;
  };
  const object = (p) => {
    ws();
    if (text[pos] !== '{') return false;
    JT.set(p, 'object');
    pos++;
    ws();
    if (text[pos] === '}') {
      pos++;
      return true;
    }
    for (;;) {
      ws();
      const raw = str();
      if (raw === null) return false;
      const key = jdecode(raw);
      const child = `${p}/${jkey(key)}`;
      if (JT.has(child)) return false;
      ws();
      if (text[pos] !== ':') return false;
      pos++;
      if (!value(child)) return false;
      ws();
      const c = text[pos++];
      if (c === '}') return true;
      if (c !== ',') return false;
    }
  };
  const array = (p) => {
    JT.set(p, 'array');
    let i = 0;
    pos++;
    ws();
    if (text[pos] === ']') {
      pos++;
      return true;
    }
    for (;;) {
      if (!value(`${p}/${i++}`)) return false;
      ws();
      const c = text[pos++];
      if (c === ']') return true;
      if (c !== ',') return false;
    }
  };
  if (!object('')) process.exit(0);
  ws();
  if (pos < text.length) process.exit(0);
}

function jdecode(s) {
  return s.replace(/\\(u[0-9A-Fa-f]{4}|.)/g, (_, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[g] ?? g;
  });
}

const jget = (p) => (JT.get(p) === 'string' ? jdecode(M.get(p)) : '');

// ── decision output ──────────────────────────────────────────────────────────
const allow = () => console.log('{"permissionDecision":"allow"}');
const deny = (reason) => console.log(`{"permissionDecision":"deny","permissionDecisionReason":${JSON.stringify(reason)}}`);

const control = (s) => /[\x00-\x1f\x7f]/.test(s);

// True when path is strictly below dir and every segment after dir is a name.
function under(p, dir) {
  if (!dir || !p.startsWith(`${dir}/`)) return false;
  const segs = p.slice(dir.length + 1).split('/');
  if (segs.length === 0) return false;
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

// ── rules ────────────────────────────────────────────────────────────────────
// The plugin's own files: playbooks, references, and scripts.
function viewRule(P) {
  const p = jget(`${P}/path`);
  if (/["\\]/.test(p) || control(p)) return;
  if (under(p, root) || under(p, real)) allow();
}

// A pstack agent dispatched with an explicit model must use one of the user's
// saved choices in a valid sheet. A call with no model, or for another agent,
// is not ours.
function taskRule(P) {
  const type = jget(`${P}/agent_type`);
  const model = jget(`${P}/model`);
  if (!type.startsWith('pstack:') || model === '') return;
  const sheet = readSheet(sheetPath);
  if (sheet === null) return;
  const p = parseSheet(sheet);
  if (p.problems !== '') return;
  if (p.models.has(model)) return;
  if (p.modelList === '') {
    deny(
      `pstack model check: every role in the user's saved pstack model choices (${sheetPath}) is inherit-parent or auto, so call \`task\` for ${type} without \`model\`.`,
    );
    return;
  }
  deny(
    `pstack model check: \`${model}\` is not one of the user's saved pstack model choices (${sheetPath}). Set \`model\` to the model saved for this role: one of ${p.modelList}.` +
      (p.modelAliases ? ' A role saved as inherit-parent or auto omits `model`.' : '') +
      ' To change the choices, the user reruns setup-pstack.',
  );
}

// Approved entry points and their argument shapes. Adding a script under
// skills/ does not grant it automatic approval. Unknown forms stay silent.
const CONTRACT = new Map([
  ['skills/show-me-your-work/scripts/log.sh', 'log'],
  ['skills/reflect/scripts/find-transcript.mjs', 'transcript'],
  ['skills/setup-pstack/scripts/check-sheet.sh', 'optional-path'],
  ['skills/poteto-mode/scripts/check-playbooks.mjs', 'optional-path'],
  ['skills/poteto-mode/scripts/check-plan.mjs', 'one-path'],
  ['skills/poteto-mode/scripts/worktree-audit.mjs', 'paths'],
  ['skills/poteto-mode/scripts/resume.mjs', 'resume'],
]);

// resume.mjs: operation first, then named paths. Only publication accepts
// note/artifact inputs. Both --option=value and --option value are supported.
function resumeContract(T, first, n) {
  const op = T[first];
  if (op !== 'begin' && op !== 'read' && op !== 'publish') return false;
  const seen = new Set();
  for (let i = first + 1; i <= n; i++) {
    const arg = T[i];
    const eq = arg.indexOf('=');
    const key = eq ? arg.slice(0, eq) : arg;
    if (key !== '--project' && key !== '--note' && key !== '--artifact') return false;
    if (op !== 'publish' && key !== '--project') return false;
    if (key !== '--artifact' && seen.has(key)) return false;
    seen.add(key);
    let value;
    if (eq) value = arg.slice(eq + 1);
    else {
      if (++i > n || T[i].startsWith('--')) return false;
      value = T[i];
    }
    if (!safePath(value)) return false;
  }
  return op === 'publish' || seen.has('--note');
}

function scriptContract(script, runner, T, first, n) {
  const kind = CONTRACT.get(script);
  if (!kind) return false;
  if (runner !== '') {
    if (kind === 'log') {
      if (runner !== 'bash') return false;
    } else if (script.endsWith('.sh')) {
      if (runner !== 'sh' && runner !== 'bash') return false;
    } else if (runner !== 'node') return false;
  }
  const count = n - first + 1;
  if (kind === 'log') return count === 6 && safePath(T[first]);
  if (kind === 'transcript') {
    return (
      (count === 2 || count === 3) && safePath(T[first]) && T[first + 1] !== '' && (count === 2 || safePath(T[first + 2]))
    );
  }
  if (kind === 'resume') return resumeContract(T, first, n);
  if (kind === 'one-path' && count !== 1) return false;
  if (kind === 'optional-path' && count > 1) return false;
  for (let i = first; i <= n; i++) if (!safePath(T[i])) return false;
  return true;
}

// Tokenize a strict shell form, then let the registered script contract select
// its path operands. Prose and operation names are not filesystem paths.
function scriptRule(P) {
  const cmd = jget(`${P}/command`);
  if (/[;|&$`<>()\\"]/.test(cmd) || control(cmd)) return;
  cwd = resolve(cwd);
  // A workspace that holds the plugin, or sits in it, could rewrite its files.
  if (!root || !cwd || root === cwd || under(root, cwd) || under(cwd, root) || real === cwd || under(real, cwd) || under(cwd, real)) return;
  const tokenized = words(cmd);
  if (!tokenized) return;
  const { T, Q } = tokenized;
  const n = T.length;
  let first = 0;
  let runner = '';
  if (!Q[0] && (T[0] === 'node' || T[0] === 'sh' || T[0] === 'bash')) {
    runner = T[0];
    first = 1;
  }
  if (first > n - 1) return;
  const script = T[first];
  let rel;
  if (under(script, root)) rel = script.slice(root.length + 1);
  else if (under(script, real)) rel = script.slice(real.length + 1);
  else return;
  if (scriptContract(rel, runner, T, first + 1, n - 1)) allow();
}

// Called only for path operands identified by a script contract.
function safePath(p) {
  if (p === '') return false;
  if (p.split('/').includes('..')) return false;
  if (!p.startsWith('/')) {
    if (cwd === '') return false;
    p = `${cwd}/${p}`;
  }
  return inside(resolve(p));
}

// Path operands stay in the workspace: one in the plugin could rewrite the
// context every later session loads.
function inside(p) {
  return p !== '' && (p === cwd || under(p, cwd));
}

// Resolves the longest existing directory prefix of p, like `cd <dir> && pwd
// -P`. A dangling symlink, or a symlink to a file, fails; missing prefixes
// keep climbing.
function resolve(p) {
  if (p === '' || p.includes("'") || control(p)) return '';
  let d = p;
  let rest = '';
  while (d !== '' && d !== '/') {
    let lst = null;
    try {
      lst = lstatSync(d);
    } catch {
      lst = null;
    }
    if (lst) {
      let st = null;
      try {
        st = statSync(d);
      } catch {
        st = null;
      }
      if (st?.isDirectory()) {
        try {
          return toPosix(realpathSync(d)) + rest;
        } catch {
          return '';
        }
      }
      return '';
    }
    const i = d.lastIndexOf('/');
    if (i <= 0) {
      rest = d + rest;
      d = '';
    } else {
      rest = d.slice(i) + rest;
      d = d.slice(0, i);
    }
  }
  return p;
}

// Splits cmd into tokens on spaces. A word is plain, from a strict safe set,
// or single-quoted with no quote inside (Q[i] = true). Returns null on
// anything else.
function words(cmd) {
  const T = [];
  const Q = [];
  let rest = cmd;
  for (;;) {
    rest = rest.replace(/^ +/, '');
    if (rest === '') return { T, Q };
    const c = rest[0];
    if (c === "'") {
      const j = rest.indexOf("'", 1);
      if (j < 1) return null;
      T.push(rest.slice(1, j));
      Q.push(true);
      rest = rest.slice(j + 1);
    } else {
      const m = rest.match(/^[A-Za-z0-9_.\/:=@%+,-]+/);
      if (!m) return null;
      T.push(m[0]);
      Q.push(false);
      rest = rest.slice(m[0].length);
    }
    if (rest !== '' && rest[0] !== ' ') return null;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
// Copilot sends Claude-format input to PascalCase hooks, so `view` arrives as
// `Read`.
let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
if (input.trim() === '') process.exit(0);
parse(input);

const tool = JT.has('/tool_name') ? jget('/tool_name') : jget('/toolName');
const P = JT.has('/tool_name') ? '/tool_input' : '/toolArgs';
if (JT.get(P) !== 'object') process.exit(0);
let cwd = jget('/cwd').replaceAll('\\', '/');

if (tool === 'Read' || tool === 'view') viewRule(P);
else if (tool === 'Agent' || tool === 'Task' || tool === 'task') taskRule(P);
else if (tool === 'Bash' || tool === 'bash') scriptRule(P);
// No process.exit here: stdout on a Windows pipe is asynchronous, and exiting
// right after the write would drop the decision.
