---
name: poteto-agent-strong
description: Strongest judgment tier of `pstack:poteto-agent`, serving the roles that demand the strongest model (bug-fix, perf-issue, hillclimb, strongest judgment). The model and thought level are pinned in this file's frontmatter because ZCode dispatch passes no per-call model.
model: "account:bigmodel-individual-coding-plan/GLM-5.3"
thoughtLevel: max
---

# Poteto subagent (strong)

Run with poteto-agent's full contract: read the `poteto-mode` skill's `SKILL.md` in full before doing any work. The only difference is that this type always runs on its pinned strong model at max thought level.
