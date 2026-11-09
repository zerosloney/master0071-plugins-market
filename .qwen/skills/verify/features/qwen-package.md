# Qwen package

`plugins/pstack` stays an Agent Plugin for the other hosts, and `scripts/build-qwen-extension.mjs` stages a separate native Qwen Code extension into `dist/qwen-pstack`: `qwen-extension.json`, `skills/`, `agents/` (the four base subagents only), `hooks/hooks.json` plus `hooks/session-start.mjs`, `QWEN.md`, `models.json`, `README.md`, and the licenses. No `plugin.json` is written — if one appears in the output, the builder fails on purpose.

## Sub-features

- Build (`node scripts/build-qwen-extension.mjs [--out <dir>]`): copies shared skills, the Qwen-runnable agents, the Qwen hook registration and context file, and writes the `qwen-extension.json` manifest. Prints the skill/agent counts and both install commands.
- Assembly parity (`cd plugins/pstack && node test/qwen-extension-parity.mjs`): builds into a temp dir and asserts the package is native, self-contained, carries the shared skills and only Qwen-runnable agents, registers the hook, and includes `QWEN.md`.
- Install: `qwen extensions install --consent dist/qwen-pstack`, or `qwen extensions link dist/qwen-pstack` for development.
- Routing: the SessionStart hook reads `${QWEN_HOME:-~/.qwen}/pstack-models.md` and injects the poteto-mode mandate unless that sheet says `session hook: off`.

## How to get to it (user POV)

A Qwen Code user installs the extension, restarts, and gets `pstack:*` skills plus the base subagents in the session. The observable end state is the hook's instruction block naming `pstack:poteto-mode`, the `pstack` extension listed and enabled, and skills callable as `/pstack:arena`.

## Driving it with run.mjs

```bash
node scripts/build-qwen-extension.mjs
cd plugins/pstack && node test/qwen-extension-parity.mjs
```

Build output must end with `Built dist\qwen-pstack` and `N skills, 4 agents, 1 SessionStart hook`. The parity test prints `✓` per structural assertion.

To drive it as a user, install into a throwaway Qwen home so the real one is untouched (needs the `qwen` CLI on `PATH`):

```bash
set "QWEN_HOME=%TEMP%\qwen-verify"
qwen extensions install --consent dist\qwen-pstack
qwen extensions list
node "%QWEN_HOME%\extensions\pstack\hooks\session-start.mjs" qwen
```

The hook must print the `<EXTREMELY_IMPORTANT>` block that names `pstack:poteto-mode`. Remove `%TEMP%\qwen-verify` afterwards.

This isolated recipe was proven on 2026-11-07 (Windows, Qwen CLI 0.26.8): the install landed at `%TEMP%\qwen-verify-pstack\extensions\pstack`, `qwen extensions list` showed 66 skills and 4 agents enabled, and the hook printed the mandate. A real user install differs only in the home path (`~/.qwen`) and in needing a session restart before the extension and its model grades load.

## Gotchas

- Never install `plugins/pstack` directly: Qwen 0.26 sees the standard `plugin.json` and loads it as an Agent Plugin, which drops the agents and hooks. Always build into `dist/` first.
- `dist/` is gitignored and never committed. A stale `dist/qwen-pstack` still installs and still passes its own parity test — rebuild after any skill, agent or hook change, or the proof covers old sources.
- The package ships the same four subagents as `agents/` (`poteto-agent`, `comment-sicko`, both thermo audit subagents). Multi-model seats run as `poteto-agent` with a different model grade.
- Model grades live in `settings.json` under `agents.modelGrades` and apply only after a session restart; the extension's hook is unaffected by missing grades.
