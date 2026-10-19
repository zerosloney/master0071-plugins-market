// Sheet decode and check shared by the node hook entries. Ports
// skills/setup-pstack/scripts/read-sheet.sh (decode) and sheet.awk (parse and
// check); POSIX awk, run under LC_ALL=C, was the original engine.
import { readFileSync } from 'node:fs';

export const ROLES = [
  'feature, refactoring',
  'bug-fix',
  'perf-issue',
  'hillclimb',
  'judgment and prose',
  'strongest judgment',
  'how explorer',
  'how explainer',
  'why investigators',
  'why synthesizer',
  'reflect tooling',
  'reflect judgment, divergent, synthesizer',
  'arena runners',
  'arena cross-judge pool',
  'swarm workers',
  'architect runners',
  'interrogate reviewers',
];

export const PANEL = new Set(['arena runners', 'arena cross-judge pool', 'architect runners', 'interrogate reviewers']);

const EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const MAX_BYTES = 1024 * 1024;

// Decode like read-sheet.sh: 1 MiB cap, UTF-16LE BOM or UTF-8, leading BOM
// stripped, CR at line ends dropped. Undecodable means missing.
export function decodeSheet(buf) {
  if (buf.length > MAX_BYTES) return null;
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function readSheet(path) {
  try {
    return decodeSheet(readFileSync(path));
  } catch {
    return null;
  }
}

function trim(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// The key of `key: value` at the start of a line, or "" for any other line.
function key(line) {
  if (/^[^ \t]/.test(line) && line.includes(':')) return trim(line.slice(0, line.indexOf(':')));
  return '';
}

// Drops a role value's reasoning effort suffix, as in `gpt-5.5 @xhigh`.
function modelOf(entry) {
  const m = entry.match(/[ \t]+@([a-z]+)$/);
  if (m && EFFORT.has(m[1])) return entry.slice(0, m.index);
  return entry;
}

function vendor(id) {
  const i = id.indexOf('-');
  return i < 0 ? id : id.slice(0, i);
}

function alias(id) {
  return id === 'inherit-parent' || id === 'auto';
}

// Parses a decoded sheet. VALUE holds the last line's value for each known
// role plus `default effort`; problems lists what is wrong, "; "-separated,
// or "" when the sheet is well formed (mirrors sheet_problems). On success,
// models is the model set, modelList its display list of explicit IDs, and
// modelAliases records whether any role inherits its model.
export function parseSheet(text) {
  const value = {};
  const models = new Set();
  let modelList = '';
  let modelAliases = false;
  let anyVendor = false;

  const lines = text.replace(/\n+$/, '').split('\n');
  for (const line of lines) {
    const k = key(line);
    const v = trim(line.slice(line.indexOf(':') + (k ? 1 : 0)));
    if (!k) continue;
    if (ROLES.includes(k) || k === 'default effort') value[k] = v;
    else if (k === 'panel vendors' && v === 'any') anyVendor = true;
  }

  let out = '';
  for (const r of ROLES) if (!(r in value)) out += `; missing role \`${r}\``;
  if ('default effort' in value && value['default effort'] !== 'session' && !EFFORT.has(value['default effort'])) {
    out += '; default effort is not session or a level';
  }
  for (const r of ROLES) {
    if (!(r in value)) continue;
    const entries = value[r] === '' ? [] : value[r].split(',');
    if (entries.length === 0) out += `; no model in \`${r}\``;
    const vendors = new Set();
    let vendorList = '';
    let real = false;
    for (let entry of entries) {
      entry = modelOf(trim(entry));
      if (entry === '') {
        out += `; an empty entry in \`${r}\``;
        continue;
      }
      if (alias(entry)) {
        modelAliases = true;
        models.add(entry);
        continue;
      }
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(entry)) {
        out += `; \`${r}\` has an entry that is not a model ID`;
        continue;
      }
      if (!models.has(entry)) modelList += (modelList === '' ? '' : ', ') + `\`${entry}\``;
      models.add(entry);
      real = true;
      const ve = vendor(entry);
      if (!vendors.has(ve)) {
        vendors.add(ve);
        vendorList += (vendorList === '' ? '' : ', ') + ve;
      }
    }
    if (PANEL.has(r) && real && vendors.size < 2 && !anyVendor) {
      out += `; \`${r}\` has models from one vendor (${vendorList})`;
    }
  }
  return { value, models, modelList, modelAliases, problems: out === '' ? '' : out.replace(/^; /, '') };
}
