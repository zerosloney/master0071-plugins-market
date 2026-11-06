# pstack on Qwen Code

This extension ships the pstack workflow skills, subagents, and SessionStart routing hook.

Qwen Code registers extension **skills** under the extension name, but extension **subagents** keep the name authored in their frontmatter. For pstack that means:

- Invoke a skill with the `skill` tool as `pstack:<name>`, or type `/pstack:<name>`. A bare `/poteto-mode` is not an alias.
- Dispatch a subagent with its authored name: `subagent_type: "poteto-agent"`, `comment-sicko`, `thermo-nuclear-review-subagent`, or `thermo-nuclear-code-quality-review-subagent`. When a pstack skill says `subagent_type: "pstack:X"`, drop the `pstack:` prefix on Qwen; the prefixed form resolves no agent.

When a pstack skill names a Claude tool, model tier, or path, read `skills/poteto-mode/references/qwen-tools.md` first. It maps the Claude tool names to Qwen Code tools, explains how to expose pstack's `opus` / `fable` / `sonnet` / `haiku` tiers as Qwen model grades, and names the Qwen paths the skills use.

The SessionStart hook reads `${QWEN_HOME:-~/.qwen}/pstack-models.md` and injects pstack's routing mandate unless that sheet contains `session hook: off`. Add `@<qwen-home>/pstack-models.md` to `~/.qwen/QWEN.md` or the project `QWEN.md` to load the role overrides as context.
