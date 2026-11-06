#!/usr/bin/env node
// Assemble a self-contained Qwen Code extension from pstack's shared sources.
//
// Qwen 0.26 treats a directory with a valid Agent Plugins `plugin.json` as an
// Agent Plugin first, and its native loader hard-codes `skills/` and `agents/`
// at the extension root. pstack's root must stay an Agent Plugin for the other
// hosts, so the Qwen package is staged here without plugin.json and with only
// the Qwen-runnable agents. Run:
//   node scripts/build-qwen-extension.mjs
//   qwen extensions install --consent dist/qwen-pstack
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'pstack');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex !== -1 && !args[outIndex + 1]) {
  console.error('build-qwen-extension: --out needs a directory');
  process.exit(1);
}
const OUT = path.resolve(args[outIndex + 1] ?? path.join(ROOT, 'dist', 'qwen-pstack'));

const need = (rel) => {
  const abs = path.join(PLUGIN, rel);
  if (!existsSync(abs)) {
    console.error(`build-qwen-extension: missing ${path.relative(ROOT, abs)}`);
    process.exit(1);
  }
  return abs;
};

need('skills');
need('qwen/agents');
need('hooks/hooks.qwen.json');
need('hooks/session-start.mjs');
need('hooks/sheet.mjs');
need('hooks/session-start-context.md');
need('QWEN.md');

const plugin = JSON.parse(readFileSync(path.join(PLUGIN, 'plugin.json'), 'utf8'));
const skillDirs = readdirSync(path.join(PLUGIN, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(PLUGIN, 'skills', e.name, 'SKILL.md')))
  .map((e) => e.name);
const agentFiles = readdirSync(path.join(PLUGIN, 'qwen', 'agents')).filter((f) => f.endsWith('.md'));

if (OUT === PLUGIN || OUT.startsWith(PLUGIN + path.sep)) {
  console.error('build-qwen-extension: refusing to write inside the plugin source tree');
  process.exit(1);
}
if (OUT === path.parse(OUT).root || OUT === ROOT || ROOT.startsWith(OUT + path.sep)) {
  console.error('build-qwen-extension: refusing to use the repo root, an ancestor, or a filesystem root as the output');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

cpSync(path.join(PLUGIN, 'skills'), path.join(OUT, 'skills'), { recursive: true });
cpSync(path.join(PLUGIN, 'qwen', 'agents'), path.join(OUT, 'agents'), { recursive: true });
mkdirSync(path.join(OUT, 'hooks'), { recursive: true });
for (const file of ['session-start.mjs', 'sheet.mjs', 'session-start-context.md']) {
  cpSync(path.join(PLUGIN, 'hooks', file), path.join(OUT, 'hooks', file));
}
cpSync(path.join(PLUGIN, 'hooks', 'hooks.qwen.json'), path.join(OUT, 'hooks', 'hooks.json'));
for (const file of ['QWEN.md', 'models.json', 'README.md']) {
  if (existsSync(path.join(PLUGIN, file))) cpSync(path.join(PLUGIN, file), path.join(OUT, file));
}
for (const file of readdirSync(PLUGIN)) {
  if (/^(LICENSE|NOTICE)/.test(file)) {
    cpSync(path.join(PLUGIN, file), path.join(OUT, file));
  }
}

const manifest = {
  name: plugin.name,
  version: plugin.version,
  description: `${plugin.description} Qwen Code native extension: shared skills, four base subagents, and a SessionStart routing hook.`,
  skills: './skills',
  agents: './agents',
  hooks: './hooks/hooks.json',
  contextFileName: './QWEN.md',
};
writeFileSync(path.join(OUT, 'qwen-extension.json'), JSON.stringify(manifest, null, 2) + '\n');

if (!existsSync(path.join(OUT, 'plugin.json'))) {
  console.log(`Built ${path.relative(ROOT, OUT) || OUT}`);
  console.log(`  ${skillDirs.length} skills, ${agentFiles.length} agents, 1 SessionStart hook`);
  console.log('Install: qwen extensions install --consent ' + (path.relative(ROOT, OUT) || OUT));
  console.log('Dev link: qwen extensions link ' + (path.relative(ROOT, OUT) || OUT));
} else {
  console.error('build-qwen-extension: output unexpectedly contains plugin.json');
  process.exit(1);
}
