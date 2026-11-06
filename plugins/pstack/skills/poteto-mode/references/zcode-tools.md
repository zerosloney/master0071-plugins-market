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

poteto-mode's Subagents section sets `subagent_type: "pstack:poteto-agent"` and `run_in_background: true`. On ZCode both work as written: the plugin's `agents/` directory registers `pstack:poteto-agent`, `pstack:poteto-agent-strong`, the four panel seats `pstack:panelist-minimax`, `pstack:panelist-spark`, `pstack:panelist-zai-glm`, `pstack:panelist-glm-flash`, `pstack:comment-sicko`, both `pstack:thermo-nuclear-*-subagent` types, and the effort variants `pstack:poteto-agent-low/high/max` and `pstack:effort-low/high/max` (bare names register too). Differences:

- The `Agent` call has **no per-call `model` parameter**. Model and effort are pinned in each agent type's frontmatter instead; dispatch resolves a role's tier and effort level to a `subagent_type` through the mapping table in [Model names](#model-names) below. A role value of `inherit-parent` or `auto` is the default behavior here. Omit `model` on every dispatch.
- ZCode registers effort-tiered agents, so a role value carrying `@<level>`, or a `default effort` line naming a level, dispatches through the type instead of falling back to the session. Map the upstream level first: `low`, `medium`, `high`, `xhigh`, `max` resolve to `low`, `high`, `high`, `max`, `max` (registered variants: `low`, `high`, `max`). Then rewrite the `subagent_type` to that variant: `pstack:poteto-agent` becomes `pstack:poteto-agent-<level>`, and `general-purpose` or no named type becomes `pstack:effort-<level>`. The variant's frontmatter still decides the model, so pass no `model`.
- Give each writing worker its own worktree or branch, review every subagent's diff yourself, and pass file pointers, not inlined context, as the policy already says.

## Model names

Skills name Claude families (`opus`, `fable`, `sonnet`, `haiku`). These do not resolve on ZCode, whose models are provider/model IDs. `/setup-pstack` records the user's choices in the sheet at `~/.zcode/pstack-models.md`; because the `Agent` call has no `model` parameter, the rows dispatch through agent types, not model slugs: resolve every tier word with this table, as [setup-pstack's runtime table](../../setup-pstack/SKILL.md#other-runtimes) describes. Each type's frontmatter decides its model and effort, so pass no `model`.

| Tier word | Subagent type |
|-----------|---------------|
| `opus` | `pstack:poteto-agent` |
| `fable` | `pstack:poteto-agent-strong` |
| `sonnet` | `pstack:panelist-minimax` |
| `haiku` | `pstack:panelist-glm-flash` |

- Single-model roles: dispatch the mapped type. `pstack:poteto-agent` runs the session's model; `pstack:poteto-agent-strong` pins the strongest model at max effort.
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): run the default four seats, `pstack:panelist-minimax`, `pstack:panelist-spark`, `pstack:panelist-zai-glm`, `pstack:panelist-glm-flash`. MiniMax and Spark are the families other than the parent's; the zai seat samples the GLM family through a second route, so a four-seat panel still runs four independent passes. Judge pools draw from the MiniMax and Spark seats.
- Shrink a seat only when its type is missing or the `Agent` tool rejects the dispatch, and note the reduction in the verdict.

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
| `interrogate` | `Agent` fan-out works as written; omit `model` on every reviewer dispatch and run the four seats per the [Model names](#model-names) mapping (`minimax`, `spark`, `zai-glm`, `glm-flash`); shrink a seat only when its type is missing or the `Agent` tool rejects it, and note the reduction in the verdict. |
| `setup-pstack` | The skill's Other runtimes table names the ZCode sheet path; the role rows dispatch through agent types per the [Model names](#model-names) mapping above (the `Agent` call still takes no `model`). |
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
