# MCP plugins

Two plugins ship a real MCP server. `systemone-decision` exposes 2 tools (scenario dispatch + custom question) over 15 built-in decision scenarios; `worktree-ops` exposes 10 tools for creating, auditing, merging and removing git worktrees. A host calls them over stdio, so the proof must speak JSON-RPC to the shipped `server.mjs`, not call the internal modules.

## Sub-features

- `systemone-decision`: tool listing and calls, scenario resolution, custom scenario override via `SYSTEMONE_SCENARIOS` / `SYSTEMONE_SCENARIOS_FILE`, answer templates per question type, batch budget, cache and quota files, plus two hooks (requirement-precheck and shell risk gate) that stay silent without `SYSTEMONE_API_KEY`.
- `worktree-ops`: create (new or existing branch) / list / status / audit / remove / lock / unlock / merge_back / config / handoff; enforcement that `remove` refuses dirty or unmerged trees unless `confirmDiscard=true`, that locked trees and paths outside the managed root are refused, and that `force` alone never overrides either.
- Both: stdio framing, protocol version, server identity, and config precedence (env > per-repo override > global config).

## How to get to it (user POV)

The user installs the plugin into a host, the host spawns `mcp/server.mjs` over stdio, and the tools appear in the host's tool list. Everything the user notices — a decision with a disposition, a worktree that refuses to be deleted — arrives through that channel.

## Driving it with run.mjs

```bash
node .qwen/skills/verify/run.mjs --only systemone
node .qwen/skills/verify/run.mjs --only worktree
```

- `systemone`: `smoke.mjs`, `hook.smoke.mjs`, `contract.smoke.mjs`. The smoke suite starts a local `node:http` mock of the SystemOne endpoint and spawns the real server, so no API key or network is needed.
- `worktree`: `smoke.mjs`, `lock.mjs`, `bucket.mjs`, `exclude.mjs`, `paths.mjs`, `inside.mjs`, `merge-main.mjs`, `timeout.mjs`. The smoke suite creates a throwaway git repo and config dir under the OS temp dir, then drives the server with JSON-RPC.

Evidence is the per-assertion `✓ <label>` lines in the step log, not the exit code alone.

## Gotchas

- `systemone-decision` clears the whole `SYSTEMONE_*` / `PLUGIN_DATA` variable family before each case. If you export those in your shell to test a real endpoint, the suite still passes against its mock — do not read that as proof your endpoint works.
- `worktree-ops` commits real history, so it needs a git identity. `run.mjs --doctor` reports it; when absent the runner exports `GIT_AUTHOR_*` / `GIT_COMMITTER_*` for the child instead of changing your config.
- The suite normalizes the fixture path with `realpath` because Windows `TEMP` can be an 8.3 short name while git reports the long name. If you add assertions, compare normalized paths, not raw strings.
- A refusal is a passing assertion here: `force=true` without `confirmDiscard=true` is expected to be rejected. Do not "fix" a red refusal test by relaxing the tool.
