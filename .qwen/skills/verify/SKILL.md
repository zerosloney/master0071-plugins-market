---
name: verify
description: Drive the master0071-plugins marketplace the way CI does — version pins, standard manifests and host shims, MCP servers over stdio, skill-pack contracts, and the pstack Qwen package. Use after changing any plugin.json, shim manifest, skill, agent, hook, or script, before claiming the change works.
---

# Verify master0071-plugins

This repo ships five portable plugins, not a server: `systemone-decision`, `worktree-ops`, `agent-pipelines`, `pstack`, `ai-native-delivery`. The user-facing surface is threefold —

- the marketplace entry a host client reads (`marketplace.json`, `.omp-plugin/marketplace.json`),
- each plugin's standard manifest plus its Codex / OMP / ZCode shims and the skills, agents, MCP servers and hooks they declare,
- the generated Qwen Code extension package for `pstack`.

Verification means replaying CI's gates against those real artifacts. The authority is `.github/workflows/ci.yml`; `run.mjs` parses it rather than restating it, so a new CI step is covered the next time you run.

## Launch

There is nothing to keep alive. Launch is a toolchain check plus, when the Qwen package is in scope, a build:

```bash
node --version                 # 18 or newer; the suites deliberately avoid Node 20+ APIs
node scripts/build-qwen-extension.mjs
```

The build is ready when it exits 0 and `dist/qwen-pstack/qwen-extension.json` exists. `dist/` is generated and gitignored — never edit it by hand, always rebuild.

## Doctor

Run this first whenever a result looks wrong:

```bash
node .qwen/skills/verify/run.mjs --doctor
```

It reports node, git, git identity (worktree-ops commits real history; when identity is missing the runner exports `GIT_AUTHOR_*` / `GIT_COMMITTER_*` instead of touching your config), whether `ci.yml` still parses into steps, whether every `marketplace.json` entry resolves to a `plugin.json`, and whether `dist/qwen-pstack` exists. `✗` lines mean do not trust a red or green run yet; `!` lines are advisory.

## Drive

```bash
node .qwen/skills/verify/run.mjs --list              # steps, in CI order
node .qwen/skills/verify/run.mjs                     # everything
node .qwen/skills/verify/run.mjs --only worktree     # steps whose name or commands match
node .qwen/skills/verify/run.mjs --keep-going        # keep going after a failure
```

Each `run:` step executes with the repo root as cwd; a `cd <dir>` line inside a step sets the cwd for the commands after it and must stay inside the repo. Commands run through the platform shell, so this works on Windows and POSIX alike. One CI step is reported and skipped: `Configure git identity` writes the runner's global git config, which must never happen on your machine — the runner exports `GIT_AUTHOR_*` / `GIT_COMMITTER_*` to the test subprocesses instead. Per-feature recipes live in [`features/`](features/README.md) — read the file for the feature you changed.

## Evidence

The run writes `artifacts/verify/<stamp>/`:

- `NN-<step>.log` — the commands and their captured stdout/stderr for one step,
- `summary.json` — timestamps, node version, git `HEAD`, dirty-file count, per-step status and log path.

Proof standards for this repo:

- Exit 0 alone is weak evidence. Quote the step's own assertions: `✓ [pstack] 7 处版本一致：0.1.24` from `release.mjs --check`, `PASS <name>` lines from the contract suites, `✓ <name>` from the smoke suites.
- The MCP features are driven end to end: a real `mcp/server.mjs` subprocess speaks JSON-RPC over stdio, and worktree-ops also builds a throwaway git repo with real commits. The only mock is the external SystemOne HTTP endpoint in `systemone-decision`, and it is a local `node:http` server started by the test.
- A static gate proves declaration, not behavior. `agent-pipelines` and `pstack` skills are prompt-driven with no runtime to assert; their suites check file completeness, copy parity and hook behavior. Do not report them as proof that a pipeline runs well.

## Cleanup

The runner creates no long-lived process and kills nothing. The suites create their own temp directories under the OS temp dir and remove them; `build-qwen-extension.mjs` writes only `dist/` (regenerable, ignored by git). Leaving `dist/` in place is fine — delete it only when you need to prove a rebuild from scratch. Evidence under `artifacts/verify/` is never removed by cleanup; keep it until the change is reviewed.

## Helpers

- `run.mjs` — the only script this skill ships. Invoke it as shown above; `--doctor`, `--list`, `--only <text>`, `--keep-going`. It is read-only apart from writing evidence and never modifies repo files.
