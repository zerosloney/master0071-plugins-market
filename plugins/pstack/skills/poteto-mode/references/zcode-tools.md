# ZCode tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, Claude model names). ZCode's tool surface mirrors Claude Code closely, so most skills run as written; only model selection and effort dispatch resolve differently. Read this when a pstack skill names a Claude tool, a driver or bundled skill, or a Claude model. This file is ZCode-specific. Other runtimes must use their own concrete tools, model names, and configuration paths.

## Tool actions

| pstack / Claude action | ZCode equivalent |
|------------------------|------------------|
| Read / create / edit a file | `Read`, `Write`, `Edit` |
| Run a shell command | `Bash` |
| Search file contents / find files | `Grep`, `Glob` |
| Fetch a URL | `WebFetch` |
| Search the web | `WebSearch` |
| Invoke a skill (the `Skill` tool, `/command`) | Skills load natively under the `pstack:` namespace (bare names register too). Follow the instructions presented. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `Agent` with `subagent_type`; plugin agents register as `pstack:poteto-agent` and kin |
| Dispatch N parallel subagents in one turn | N `Agent` calls in one response; `run_in_background: true` is supported |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | `TodoWrite` |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `AskUserQuestion`, same name |

## Subagent policy

poteto-mode's Subagents section sets `subagent_type: "pstack:poteto-agent"` and `run_in_background: true`. On ZCode both work as written: the plugin's `agents/` directory registers `pstack:poteto-agent`, `pstack:comment-sicko`, and both `pstack:thermo-nuclear-*-subagent` types (bare names register too). Differences:

- The `Agent` call has **no per-call `model` or effort parameter**. Every dispatch runs the session's model and effort; this port registers no model-pinned or effort-tiered variants. Omit `model` on every dispatch. A role value of `inherit-parent` or `auto` is the default behavior here.
- The sheet at `~/.zcode/pstack-models.md` still controls `session hook`. Its role rows and any `@<level>` suffix are inert on ZCode: dispatch the base type and let the session settings apply, and say so if a level was requested. On Codex the level maps to `spawn_agent`'s `reasoning_effort`; see [Model names](#model-names) for the full explanation.
- Give each writing worker its own worktree or branch, review every subagent's diff yourself, and pass file pointers, not inlined context, as the policy already says.

## Model names

Skills name Claude families (`opus`, `fable`, `sonnet`, `haiku`). These do not resolve on ZCode, whose models are provider/model IDs. `/setup-pstack` records the user's choices in the sheet at `~/.zcode/pstack-models.md`, but ZCode's `Agent` call takes neither `model` nor an effort value, and this port registers no model-pinned variants. Every role therefore runs `pstack:poteto-agent` on the session model:

- Single-model roles: dispatch `pstack:poteto-agent` with no `model`.
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): fan out one `pstack:poteto-agent` per seat. The passes stay independent, but they share the session model; note in the verdict that model diversity is unavailable on ZCode.
- A role value carrying `@<level>` does not change dispatch on ZCode. Keep the suffix in the sheet only if you also use a runtime that honors it.

## Session routing hook

ZCode registers the plugin's `hooks/hooks.json` by convention and ignores a manifest hooks pointer, so the one registration every host shares runs `hooks/session-start.mjs` with node; the script detects ZCode itself (`ZCODE_PLUGIN_ROOT` set, or the plugin root under `.zcode`) and switches to the ZCode branch on startup, resume, clear, and compact. It reads `session hook` from `~/.zcode/pstack-models.md`; `session hook: off` disables injection, and with no sheet the mandate injects as `hookSpecificOutput.additionalContext` JSON. Plugin hooks run without a trust gate. Every hook registration in this port runs node scripts, so Windows is covered everywhere.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these ZCode equivalents:

| Skill or driver named in pstack | On ZCode |
|---------------------------------|----------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `Bash` and observe the real output. |
| Project UI driver | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | The host's skill-authoring guidance, such as the bundled `plugin-creator` skill if installed. Keep `name` + `description` frontmatter and progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`) | ZCode has no `loop` skill. Re-run the step yourself on a cadence, or use the host's scheduled automations if available. |

## Paths the skills refer to

pstack skills name the paths they need in host-neutral terms ("the host's project-skill directory", "the host's per-project transcripts directory", "the host's agent store"). On ZCode they resolve to:

| Neutral term in a pstack skill | On ZCode |
|-------------------------------|----------|
| the host's project-skill directory | The directory your ZCode install scans for project-local skills. The plugin's own skills live under the plugin root's `skills/`. |
| the host's user-level skill directory | `~/.zcode/skills/`. |
| the host's per-project transcripts directory | `~/.zcode/cli/`. The transcript finder reads Claude Code's layout, so on ZCode pass the session digest step 1 allows instead of a directory. |
| the host's agent store (`<agent-store>/`) | `~/.zcode/orchestrate/`. The skill creates the store, so any writable path works; keep it outside the repo and outside the session. |

A runtime with no mapping file of its own uses its own agent directory for the store and its own skill directory for skills.

## Per-skill notes

Most skills need only the tables above. These need one more mapping:

| Skill | On ZCode |
|-------|----------|
| `interrogate` | `Agent` fan-out works as written; omit `model` on every reviewer dispatch and run one `pstack:poteto-agent` per seat (models follow the session), noting the reduced diversity in the verdict. |
| `setup-pstack` | The skill's Other runtimes table names the ZCode sheet path; its role rows are inert on ZCode (see [Model names](#model-names)), so only `session hook` applies. |
| `no-comments` | `pstack:comment-sicko` is registered; spawn it as written. |
| `thermos` | Both `pstack:thermo-nuclear-*-subagent` types are registered; spawn them as written. |
| `arena`, `architect`, `how`, `reflect`, `swarm`, `why` | Parallel roles map to `Agent` fan-out; omit `model` and give writing workers their own worktree. |
| `reflect` | The transcript finder reads Claude Code's layout under `~/.claude/projects/`; ZCode sessions live under `~/.zcode/cli/`, so pass the session digest step 1 allows instead. |
| `create-verification-skill`, `maintain-verification-skill` | Write a generated project skill to the host's project-skill location rather than `.claude/skills/verify/`. The app-driving harness is platform-neutral. |
| `babysit` | `loop` and `AskUserQuestion` resolve through the tables above. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the node-only helpers: `check-plan.mjs`, `check-playbooks.mjs`, `resume.mjs`, and `worktree-audit.mjs` — invoke them through `Bash` with `node`. The bun-gated `watch-pr` PR watcher and `orch` store CLI live under `extras/poteto-mode-scripts/` (enable conditions in `extras/README.md`); they need `bun` and `gh`, or `origin` when the forge is Origin.

## Instructions file

Where a pstack skill says "your instructions file", on ZCode that is `AGENTS.md` (project root, plus `~/.zcode/AGENTS.md` global). On Claude Code it is `CLAUDE.md`.
