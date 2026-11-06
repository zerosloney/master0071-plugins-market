# Marketplace versions

A host reads `marketplace.json`, matches the entry version, and installs the plugin at `source`. The version appears in seven or eight places per plugin; a single stale copy makes a client serve an old build while the checkout says otherwise.

## Sub-features

- Five entries in `marketplace.json` (Agent Plugins standard) and five in `.omp-plugin/marketplace.json` (Oh My Pi shim).
- Four manifests per plugin: `plugins/<name>/plugin.json` (authoritative) plus `.zcode-plugin/`, `.codex-plugin/`, `.omp-plugin/` shims.
- Server identity constants for the two MCP plugins: `mcp/server.mjs` `SERVER_INFO` (systemone-decision) and `mcp/protocol.mjs` `SERVER_INFO` (worktree-ops).
- The plugin table in the root `README.md`.
- `release.mjs` itself, which owns the write path: `node scripts/release.mjs <plugin> <version>`.

## How to get to it (user POV)

A user installs from the marketplace listing or from the repo URL, and reads the root README table to decide what to install. Neither reads `plugin.json` by hand — the host does.

## Driving it with run.mjs

```bash
node .qwen/skills/verify/run.mjs --only version
```

Runs CI step `Version consistency (release.mjs --check)`. Pass looks like one line per plugin:

```text
✓ [systemone-decision] 8 处版本一致：0.5.17
✓ [pstack] 7 处版本一致：0.1.24
```

## Gotchas

- Bump with `node scripts/release.mjs <plugin> <next>`, never by editing one manifest: `--check` compares all spots and fails on any divergence, and the write path validates the new file as JSON before replacing it.
- The pstack Qwen package has no version spot — `build-qwen-extension.mjs` reads the version from `plugins/pstack/plugin.json` at build time, so `dist/qwen-pstack` is stale until rebuilt.
- `--check` without a plugin name is the gate; passing a plugin name switches the script into its write mode.
