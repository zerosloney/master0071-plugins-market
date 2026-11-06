# Feature map — master0071-plugins

One file per user-facing feature. Each answers: what it is, how a user reaches it, how to drive it, and what end state proves it works. Start with the feature you changed; a proof that drives one entry point is incomplete when the map lists others.

| Feature | What it proves | Drive it |
| --- | --- | --- |
| [marketplace-versions](marketplace-versions.md) | every version pin for all five plugins agrees | `node .qwen/skills/verify/run.mjs --only version` |
| [manifest-portability](manifest-portability.md) | the standard manifest and the three host shims say the same thing | `node .qwen/skills/verify/run.mjs --only manifest` |
| [mcp-plugins](mcp-plugins.md) | SystemOne decisions and worktree lifecycle work over real stdio JSON-RPC | `node .qwen/skills/verify/run.mjs --only systemone` · `--only worktree` |
| [workflow-plugins](workflow-plugins.md) | pipeline and governance skill packs are complete, copies agree, hooks answer | `node .qwen/skills/verify/run.mjs --only agent-pipelines` · `--only "pstack tests"` · `--only ai-native` |
| [qwen-package](qwen-package.md) | pstack builds into an installable Qwen Code extension and routes tasks | `node scripts/build-qwen-extension.mjs` then `cd plugins/pstack && node test/qwen-extension-parity.mjs` |

Run `node .qwen/skills/verify/run.mjs --doctor` before trusting any of these, and read `artifacts/verify/<stamp>/` afterwards for the step logs.

Maintenance: re-run `/maintain-verification-skill` when a plugin gains or loses skills, tools, or manifest fields, so this map keeps matching the repo.
