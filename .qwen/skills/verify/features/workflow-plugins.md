# Workflow plugins

Three plugins ship skills, subagents and hooks rather than a server: `pstack` (66 skills, 4 registered subagents, session-start and pre-tool-use hooks), `agent-pipelines` (`/ralph-pipeline`, `/coding-pipeline` and six companion subagents), `ai-native-delivery` (risk lanes, check-loop gates, ledgers, and a deterministic shell deny/ask hook). Their behavior is prompt-driven, so the gates prove structure and hook contracts — never that a pipeline produced a good result.

## Sub-features

- `pstack`: hook runtime across runtimes and sheet states (`run-hook-tests.mjs`), model-sheet formatting parity with the awk engine (`sheet-parity.mjs`), role-table parity (`role-table-parity.mjs`), Qwen package assembly (`qwen-extension-parity.mjs`), and the shipped `check-plan.mjs` script.
- `agent-pipelines`: file completeness, four-copy parameter parity, skill self-sufficiency, shim declarations (`contract.mjs`), pipeline wiring (`pipeline.mjs`), equivalence across copies (`equivalence.mjs`), and regressions (`regression.mjs`).
- `ai-native-delivery`: roughly forty suites covering check-loop gates and their reversals, warn format and folding, judgment ledgers, ledger invariants and compaction, delegation and metrics aggregation, plus `verify`, `policy`, `hook`, `init`, and `mcp-tools` behavior.

## How to get to it (user POV)

The user types a command (`/pstack:arena`, `/ralph-pipeline`) or triggers a hook, and gets a routed workflow or a blocked shell command. The contract is: the skill exists where the host looks, the copies agree, and the hook answers the same way the docs claim.

## Driving it with run.mjs

```bash
node .qwen/skills/verify/run.mjs --only "pstack tests"
node .qwen/skills/verify/run.mjs --only agent-pipelines
node .qwen/skills/verify/run.mjs --only ai-native
```

Run only the plugin you touched — `ai-native-delivery` alone is about forty node invocations.

## Gotchas

- Two steps change directory: `pstack` runs from `plugins/pstack` because `run-hook-tests.mjs` resolves paths from `process.cwd()`, and `ai-native-delivery` runs from `plugins/ai-native-delivery`. Calling a single test from the repo root fails with a "run this from the plugin root" error — that is the guard, not a bug.
- `pstack` hook tests set `CLAUDE_PLUGIN_ROOT` themselves and use temporary home directories per runtime; they do not touch your real `~/.claude`, `~/.codex`, or `~/.qwen`.
- The `extras/` bun suite is deliberately out of CI: it was verified only on POSIX and has documented Windows failures (`plugins/pstack/extras/README.md`). Do not run it as a gate, and do not treat its absence from CI as missing coverage for the shipped port.
- These suites assert declarations and hook responses. If you changed prompt text only, a green run means "nothing broke structurally", not "the workflow behaves better".
