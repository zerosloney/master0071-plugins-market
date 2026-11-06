# Manifest portability

Each plugin declares itself once in the standard `plugin.json` and three times in host shims. The copies were written in different rounds, so `./skills/` versus `./skills`, a missing `homepage`, or a skills array that pins two directories drifts silently: the plugin loads on one host and quietly loads less on another.

## Sub-features

- Per-plugin shim parity for `.codex-plugin/`, `.omp-plugin/`, `.zcode-plugin/`.
- Required metadata on every manifest: `homepage`, `repository`, `license`, `keywords`, and `author` with a `url`.
- Only the Agent Plugins 1.0.0 top-level keys are allowed (no `engines`; the Node floor lives in each README and the runtime self-check).
- Skill-name uniqueness across the whole market, so a host cannot collide two equally named skills.
- CI reconciliation: every `node <path>` in `.github/workflows/ci.yml` must exist **and** be tracked by git.
- The self-test (`scripts/manifest-lint.selftest.mjs`) proves the tracking guard still fires by building a violation in a throwaway git repo.

## How to get to it (user POV)

The user experiences this as a plugin that installs and behaves the same on Codex, OMP, ZCode and Agent Plugins hosts, and as hooks that actually register instead of pointing at `"hooks"` while the loader expects `"./hooks"`.

## Driving it with run.mjs

```bash
node .qwen/skills/verify/run.mjs --only manifest
```

Two CI steps: `Manifest / shim consistency (manifest-lint.mjs)` and `manifest-lint tracking guard (selftest)`. A clean run prints no `✗` lines and exits 0; the self-test asserts its own injected violation was caught.

## Gotchas

- A new test file that `ci.yml` references must be `git add`ed before lint passes. The check reads `git ls-files`, so an untracked file is red locally by design — that is the case CI catches on a clean checkout.
- When git is unavailable, lint prints `! git ls-files 失败` and skips the tracking half: that is a loud skip, not a pass. Fix the environment before reporting green.
- Do not add a root-level `qwen-extension.json`: the linter fails it, because a standard `plugin.json` plus that file makes Qwen load the plugin as an Agent Plugin and drop agents and hooks. The Qwen package is generated into `dist/qwen-pstack` instead.
