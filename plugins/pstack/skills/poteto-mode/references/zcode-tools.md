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

- The `Agent` call has **no per-call `model` parameter**. Roles that name a model run on the session's model; a role value of `inherit-parent` or `auto` is the default behavior here. Omit `model` on every dispatch.
- There are no `effort-*` or `poteto-agent-*` effort agents. When a role value carries `@<level>`, or the `default effort` line names a level, treat the role as `session` effort and dispatch unchanged. Do not promise effort-tiered dispatch in replies.
- Give each writing worker its own worktree or branch, review every subagent's diff yourself, and pass file pointers, not inlined context, as the policy already says.

## Model names

Skills name Claude families (`opus`, `fable`, `sonnet`, `haiku`). These do not resolve on ZCode, whose models are provider/model IDs. `/setup-pstack` records the user's choices in the sheet at `~/.zcode/pstack-models.md`; because the `Agent` call has no `model` parameter, the rows are the record of the user's choice and apply where the runtime can, as [setup-pstack's runtime table](../../setup-pstack/SKILL.md#other-runtimes) says. Substitute in conversation:

- Single-model roles: the session's model.
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): diversity comes from distinct subagent types when the host offers them; with one model, note in the verdict that diversity was reduced.

## Session routing hook

The plugin's ZCode shim points at `hooks/zcode/hooks.json`, whose `SessionStart` hook runs `hooks/session-start.mjs zcode` as a node process on startup, resume, clear, and compact. It reads `session hook` from `~/.zcode/pstack-models.md`; `session hook: off` disables injection, and with no sheet the mandate injects. Plugin hooks run without a trust gate. Every hook registration in this port runs node scripts; the `.sh` entries upstream ships are not executed on any host, so Windows is covered everywhere.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these ZCode equivalents:

| Skill or driver named in pstack | On ZCode |
|---------------------------------|----------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `Bash` and observe the real output. |
| Project UI driver | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | The host's skill-authoring guidance, such as the bundled `plugin-creator` skill if installed. Keep `name` + `description` frontmatter and progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`) | ZCode has no `loop` skill. Re-run the step yourself on a cadence, or use the host's scheduled automations if available. |

## Per-skill notes

Most skills need only the tables above. These need one more mapping:

| Skill | On ZCode |
|-------|----------|
| `interrogate` | `Agent` fan-out works as written; omit `model` on every reviewer dispatch and keep the panel verdict honest about single-model diversity. |
| `setup-pstack` | The skill's Other runtimes table names the ZCode sheet path; the role rows are advisory because the `Agent` call has no `model` parameter. |
| `no-comments` | `pstack:comment-sicko` is registered; spawn it as written. |
| `thermos` | Both `pstack:thermo-nuclear-*-subagent` types are registered; spawn them as written. |
| `arena`, `architect`, `how`, `reflect`, `swarm`, `why` | Parallel roles map to `Agent` fan-out; omit `model` and give writing workers their own worktree. |
| `reflect` | The transcript finder reads Claude Code's layout under `~/.claude/projects/`; ZCode sessions live under `~/.zcode/cli/`, so pass the session digest step 1 allows instead. |
| `create-verification-skill`, `maintain-verification-skill` | Write a generated project skill to the host's project-skill location rather than `.claude/skills/verify/`. The app-driving harness is platform-neutral. |
| `babysit` | `loop` and `AskUserQuestion` resolve through the tables above. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher, the `orch` store CLI, and `worktree-audit.mjs`. They use bun and Node.js and run the same on ZCode; invoke them through `Bash`. They need `bun` and `gh`, or `origin` when the forge is Origin.

## Instructions file

Where a pstack skill says "your instructions file", on ZCode that is `AGENTS.md` (project root, plus `~/.zcode/AGENTS.md` global). On Claude Code it is `CLAUDE.md`.
