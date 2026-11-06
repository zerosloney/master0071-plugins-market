# Qwen Code tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, Claude model names, `~/.claude/` paths). On Qwen Code the skills are the same files; only the tool names, the skill and agent namespace, the model selectors, and the configuration paths resolve differently. Read this when a pstack skill names a Claude tool, a driver or bundled skill, a Claude model, or a Claude Code path. This file is Qwen-specific; other runtimes use their own equivalents.

## Skill and agent namespace

Qwen Code prefixes extension **skills** with the extension name, but extension **subagents** keep the `name:` authored in their frontmatter. This extension is named `pstack`, so:

- Invoke a skill with the `skill` tool and the registered name: `pstack:poteto-mode`.
- Type the registered name at the prompt: `/pstack:poteto-mode`. The bare `/poteto-mode` is **not** an alias.
- Read prose that says "the **architect** skill" or "`/architect`" as `pstack:architect`. The `pstack:` prefix is added at load time, not written into each `SKILL.md`.
- Dispatch a subagent with its authored name: `subagent_type: "poteto-agent"`. Do **not** prefix it with `pstack:`. A pstack skill that says `subagent_type: "pstack:poteto-agent"` (correct on Claude Code and Copilot) must be sent as `"poteto-agent"` on Qwen. Qwen's extension-agent lookup compares the authored `name:` and has no `pstack:` alias.

The Qwen port registers `poteto-agent`, `comment-sicko`, `thermo-nuclear-review-subagent`, and `thermo-nuclear-code-quality-review-subagent`. The ZCode-only `panelist-*`, `poteto-agent-strong`, and `effort-*` agents are **not** part of the Qwen extension: ZCode needed those agent types because its subagent call has no model parameter, while Qwen selects a model per `agent` call. Run every arena, interrogate, or panel seat as `poteto-agent` with a different `model` grade instead of using a `panelist-*` type.

## Tool actions

| pstack / Claude action | Qwen Code equivalent |
|------------------------|----------------------|
| Read a file (`Read`) | `read_file` |
| Create a file (`Write`) | `write_file` |
| Edit a file (`Edit`) | `edit` |
| Run a shell command (`Bash`) | `run_shell_command` |
| Search file contents (`Grep`) | `grep_search` |
| Find files (`Glob`) | `glob` |
| List a directory (`LS`) | `list_directory` when `tools.listDirectory.enabled` is on (disabled by default); otherwise `glob` |
| Fetch a URL (`WebFetch`) | `web_fetch` |
| Search the web (`WebSearch`) | `web_search` |
| Edit a notebook (`NotebookEdit`) | `notebook_edit` |
| Invoke a skill (the `Skill` tool, `/command`) | The `skill` tool with the registered name (`pstack:architect`). Qwen also accepts `/pstack:architect` from the prompt. |
| Dispatch a subagent (the `Agent`/`Task` tool) | The `agent` tool: `subagent_type`, `model` (a configured grade), `prompt`, `run_in_background`. |
| Dispatch N parallel subagents in one turn | N `agent` calls in one response. |
| Background subagent (`run_in_background: true`) | Supported. Named subagents run in the background by default and deliver a completion notification; set `run_in_background: false` when the current turn must wait inline. |
| Read a subagent's result / message a running one | Read the completion notification; `list_agents` finds running agents, `send_message` reaches one, and `task_stop` stops a background task by id. |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | `todo_write`, which is disabled by default. Enable it with `tools.todoWrite.enabled` in `settings.json`; otherwise keep the `todo.md` checklist that poteto-mode's fallback rule describes. |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `ask_user_question`. It takes one question per call with a fixed option list; use `multiSelect` only when the question is genuinely multi-select. |
| Start a long-running server | `run_shell_command` with `is_background: true`; stop it by task id, not by a broad process-name kill. `task_stop` takes that id (`BashOutput` / `KillShell` have no separate Qwen tool). |

If the `agent` tool is unavailable (safe mode, an untrusted workspace, or a headless run that forbids background work), pstack's fan-out skills degrade to a single sequential pass. A required independent review stays blocked, exactly as poteto-mode's [Subagents](../SKILL.md#subagents) section says; do not silently substitute the parent's own review.

## Model names

pstack's `opus`, `fable`, `sonnet`, and `haiku` are Claude tier names, not Qwen model IDs. Qwen's `agent` tool accepts only grade names configured in `agents.modelGrades`. Expose the pstack tier names as grades so the skill text works unchanged:

```json
{
  "agents": {
    "modelGrades": {
      "opus": "<strongest available model>",
      "fable": "<second strong model, ideally another family>",
      "sonnet": "<default workhorse model>",
      "haiku": "fast"
    },
    "allowedGrades": ["opus", "fable", "sonnet", "haiku"]
  }
}
```

Each grade value uses the same selector as subagent `model` frontmatter: `fast`, a bare model ID, or `authType:modelId`. `haiku: "fast"` follows the session's configured fast model. When you have fewer distinct models, point several tiers at the same selector; the arena then has fewer independent families, so say so in its synthesis note instead of pretending the seats differ.

- A role value of `auto` or `inherit-parent` means the parent model: omit `model` on the `agent` call.
- With no grades configured, omit `model` and run on the parent model. If Qwen rejects a grade, use pstack's existing fallback: run the seat on the role's default or the parent model and say so.
- Qwen has no per-subagent `effort` / `thoughtLevel` field. A sheet value such as `opus @xhigh` changes nothing on Qwen: strip the suffix, omit `model` only when the value is `auto`, and pick the grade or a stronger model instead. Do not dispatch `effort-*` agent types; they are not registered here.
- The Qwen agent files under `qwen/agents/` deliberately omit `model`, so the grade passed to the `agent` call decides the model.

The `setup-pstack` skill writes the sheet and can add the grades. Its Qwen instructions are in [setup-pstack/qwen.md](../../setup-pstack/qwen.md).

## Sheet and SessionStart hook

The override sheet lives at `${QWEN_HOME:-~/.qwen}/pstack-models.md`.

- Add `@<qwen-home>/pstack-models.md` to `~/.qwen/QWEN.md` or the project `QWEN.md` to load the role lines as context. Qwen resolves `@path` imports relative to the `QWEN.md` that names them.
- The generated package registers `hooks/hooks.json` (copied from `hooks/hooks.qwen.json`). Its `SessionStart` hook runs the shared `session-start.mjs` with the `qwen` runtime, reads the same sheet, stays silent on `session hook: off`, and otherwise prints the routing mandate as bare text. Qwen adds bare `SessionStart` stdout to the model context, so no JSON envelope is needed.
- The hook command uses `${CLAUDE_PLUGIN_ROOT}`, which Qwen substitutes with the installed extension path. Do not hard-code an install path in the sheet or the hook.

## Paths the skills refer to

pstack skills name paths in host-neutral terms. On Qwen Code they resolve to:

| Neutral term in a pstack skill | On Qwen Code |
|-------------------------------|--------------|
| the host's project-skill directory | `.qwen/skills/` in the repository. |
| the host's user-level skill directory | `~/.qwen/skills/` (Qwen also reads `~/.agents/skills/`; `~/.qwen/skills/` wins on a name clash). |
| the host's per-project transcripts directory | `~/.qwen/projects/<sanitized-project-path>/chats/` (or under `$QWEN_RUNTIME_DIR` when set). If the layout is uncertain, pass the session id or transcript path your parent supplied. |
| the host's agent store (`<agent-store>/`) | `~/.qwen/orchestrate/`. The skill creates the store, so any writable path outside the repo and outside the session works. |
| the project instructions file | `QWEN.md` at the project root, or `~/.qwen/QWEN.md` for global instructions. |
| the host's settings file | `~/.qwen/settings.json` (`QWEN_HOME` relocates the whole directory). |

## Per-skill notes

The generated Qwen package includes the skills tree (with its node-only `skills/poteto-mode/scripts/` helpers) but not `extras/`. A skill that calls `extras/poteto-mode-scripts/watch-pr` or `extras/poteto-mode-scripts/orch` needs a repo clone and `bun`; without them, use `gh` directly for PR watching and a plain file-based store for orch rather than improvising an install path.

Most skills need only the tables above. These need one more mapping:

| Skill | On Qwen Code |
|-------|--------------|
| `setup-pstack` | Read [qwen.md](../../setup-pstack/qwen.md); it replaces the model, effort, hook, and sheet-header questions with the Qwen sheet and grade setup. The role lines are still the same. The generated package registers its own `SessionStart` hook, so ask whether to keep it; the answer is the `session hook` line in the Qwen sheet. |
| `arena` | Run each runner as `poteto-agent` with a different grade from `arena runners`. Treat two grades that resolve to the same model as one family; the cross-judge must use a grade from another family when one exists. |
| `interrogate` | The `agent` fan-out works as written. Use `poteto-agent` for the reviewer seats and pass grades for diversity; omit `model` for an `auto` seat. Shrink a seat only when the `agent` tool rejects it or the grade is unavailable, and note the reduction in the verdict. |
| `why` / `how` / `swarm` / `reflect` | Spawn with the `agent` tool. Background results arrive as notifications; do not read a background agent's transcript while it runs. `list_agents` finds an id you lost. |
| `no-comments` | Read with `read_file` and search with `grep_search`; the comment rules themselves are unchanged. |
| `automate-me` / `recall` / `reflect` | Use the Qwen per-project transcript path above. If the finder cannot locate a transcript, ask for the session id or path rather than searching the whole home directory. |
| `create-verification-skill` / `maintain-verification-skill` | Write project skills under `.qwen/skills/<name>/SKILL.md`; user-level skills under `~/.qwen/skills/`. Do not write into the extension's read-only `skills/` directory. |
| `create-formal-verification-skill` / `maintain-formal-verification-skill` | The same `.qwen/skills/` locations, and run the project's verifier with `run_shell_command`. |
| `babysit` | Prefer Qwen's bundled `loop` skill (registered without the `pstack:` prefix) for a cadence. If it is unavailable, re-run the step yourself on the stated cadence. |
| `run` / `verify` | Qwen ships no separate `run` skill. Start the app with `run_shell_command` (background when it must stay up) and follow the project's own verification skill when one exists. |
| `orchestrate` | Keep the agent store under `~/.qwen/orchestrate/`; use `list_agents` and `send_message` to recover a lost background agent. |
| `teach` | Write the lesson where the user asks; there is no Qwen-specific transcript format to match. |
