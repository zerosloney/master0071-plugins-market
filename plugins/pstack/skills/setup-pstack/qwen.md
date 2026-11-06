# Setup pstack on Qwen Code

On Qwen Code this file replaces steps 1, 3, 4, and 7 of [setup-pstack](SKILL.md) and step 6's header. Steps 2, 5, 8, 9, and 10 still apply.

Qwen Code has no per-subagent reasoning-effort field, and pstack's `opus` / `fable` / `sonnet` / `haiku` values are not Qwen model IDs. The Qwen Agent tool accepts only grade names configured in `agents.modelGrades`. Setup therefore does two things: it exposes the pstack tiers as model grades, and it writes the per-role sheet the skills read.

Read [qwen-tools.md](../poteto-mode/references/qwen-tools.md) before starting. It names the Qwen tools, the `pstack:` skill namespace, the unprefixed subagent names, and the sheet path.

## Asking

Use `ask_user_question` for every model question. It takes one question per call with a fixed option list; use `multiSelect` only when the question is genuinely multi-select, otherwise ask a sequence of single-select questions.

- On a first setup, do not propose, pre-select, or label a model `(Recommended)`. There is no default to recommend.
- On a re-run, put the saved value first, labeled `(current)`.
- A typed answer counts only when it is a model ID the user has seen in `/model`, a grade name that already exists, or `auto` / `inherit-parent`. Otherwise ask again.
- An answer the user already gave in the request counts; ask only what it leaves open.
- If `ask_user_question` is unavailable (a `-p` run or `--no-ask-user`) and a model question is still open, do not choose for the user and do not write the sheet. Tell the user to run `setup-pstack` in an interactive session.

## 1. Detect models and grades

The Qwen home directory is `$QWEN_HOME` when set and `~/.qwen` otherwise. This file calls it `<qwen-home>`.

1. Read `<qwen-home>/settings.json` if it exists and note `agents.modelGrades` and `agents.allowedGrades`. Never print API keys, tokens, or provider credentials; quote only model selectors and grade names.
2. Ask the user to run `/model` in the session and paste the model IDs they want pstack to use. `/model` lists the selectors the session can resolve. Never invent a model ID from a family name.
3. Treat an existing grade as the current choice for its tier. Do not overwrite it without asking.
4. Ask which model each pstack tier should use, one question at a time:
   - `opus` — strongest judgment
   - `fable` — second strong model, ideally from another provider family
   - `sonnet` — default workhorse
   - `haiku` — fast or cheap
   Several tiers may share a selector when the user has fewer distinct models. Say what that does to arena diversity instead of implying the seats differ.
5. Offer to write the grades. Show the exact block first and ask for confirmation; this edits a shared settings file, so never do it silently. Preserve every other setting and key.

```json
{
  "agents": {
    "modelGrades": {
      "opus": "<selector>",
      "fable": "<selector>",
      "sonnet": "<selector>",
      "haiku": "fast"
    },
    "allowedGrades": ["opus", "fable", "sonnet", "haiku"]
  }
}
```

Each value uses the same selector as subagent `model`: `fast`, a bare model ID, or `authType:modelId`. `fast` follows the session's configured fast model. If the user declines, do not invent grades or write Claude model slugs into the sheet; explain that pstack skills without a configured grade omit `model` and run on the parent model.

Ask whether the grades belong in the user settings (`<qwen-home>/settings.json`) or the project settings (`.qwen/settings.json`). User settings apply everywhere; project settings travel with the repository. If an `allowedGrades` list already exists, add the four tier names to it only with consent.

## 3. Reasoning effort

Skip this step. Qwen Code has no `effort` / `thoughtLevel` field for subagents. Do not ask the `default effort` question and do not write `default effort` or `@level` suffixes into the Qwen sheet. Existing suffixes are inert; leave them or remove them with the user's consent. Model choice is the only lever.

## 4. Session hook

The generated Qwen package registers its own `SessionStart` hook through `hooks/hooks.json` (copied from `hooks/hooks.qwen.json`); the hook runs the shared script with the `qwen` runtime and reads the same sheet. Ask whether to keep automatic routing. The default is on. The answer is the `session hook` line in the sheet: `on` or `off`. With no sheet or no line, the hook injects. `off` stops the routing mandate; the skills remain callable by name.

## 6. Sheet header and role lines

Write the sheet at `<qwen-home>/pstack-models.md`. Use the same role shape as step 6 of [setup-pstack](SKILL.md), with these Qwen differences:

- Omit `default effort`.
- Every role value is a grade name (`opus`, `fable`, `sonnet`, `haiku`), `auto`, or `inherit-parent`. Do not write a raw Qwen model ID here; the sheet's values are passed to the Agent tool, which accepts grades.
- Do not add `@low`, `@medium`, `@high`, `@xhigh`, or `@max` suffixes.

Keep the `session hook` line. If the user gave overrides for a role, write that role line; otherwise omit it so the skill's default applies.

## 7. Load the sheet

Add an import line to the global `~/.qwen/QWEN.md` or the project `QWEN.md`, using the resolved absolute sheet path:

```text
@<qwen-home>/pstack-models.md
```

Ask which file to edit. The project file is shared with the repository; prefer the global file unless the team wants the same overrides. If neither file exists, create the global one after confirming the path. The import is what puts the role lines in context; the hook reads the sheet only for the hook setting and does not inject the role rows.

## 5. Validate

Re-read the sheet after writing it. Confirm:

- every value is a configured grade, `auto`, or `inherit-parent`;
- every grade is in `allowedGrades` when that list is set;
- no `default effort` line and no `@level` suffix was written;
- the `session hook` line is `on` or `off` when present;
- the imported path in `QWEN.md` is the real sheet path.

If a value is not resolvable, stop and ask again rather than writing a best guess. Then continue with steps 8, 9, and 10 of the main skill.
