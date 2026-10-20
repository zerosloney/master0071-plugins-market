---
name: worktree-manager
description: Create, inspect, audit, hand off, merge back, and clean up git worktrees in a user-configurable directory outside the repository. Use when the user wants an isolated branch working directory, a parallel writer workspace, a worktree outside the repo, a custom worktree root, a worktree cleanup or disk-reclaim pass, or asks to move work into / start a session in a worktree. Never use it to change the running location of the current session.
---

# Worktree Manager

## The one hard constraint

Most agent hosts pin a session's working directory when the session starts, and subagents
inherit it. A worktree plugin therefore cannot relocate the running session. State this once,
up front, whenever worktree isolation comes up:

> This session runs in `<current cwd>`. To work in a separate directory, I create the worktree
> and give you the exact path; you then open a session whose working directory is that path.

Check what your host actually supports before promising a specific mechanism. If the host can
repoint a session at a directory, use that. Otherwise hand over the path and let the user open
the session. Either way the worktree path is the contract — never imply the current session
moved.

## Tools

`worktree_create`, `worktree_list`, `worktree_status`, `worktree_audit`, `worktree_remove`,
`worktree_lock`, `worktree_unlock`, `worktree_merge_back`, `worktree_set_root`, `worktree_handoff`.

All of them run `git` themselves; do not hand-roll `git worktree` shell commands when a tool
covers the request.

## Where worktrees go

There is no default location: a root must be configured (WORKTREE_ROOT, or `worktree_set_root`)
before `worktree_create` runs — it refuses with the configuration options when none is set.
A root outside the repository keeps `git status` in the main checkout clean and avoids accidentally
committing a worktree. A root inside the repository is allowed too: `worktree_create` first writes
it into `.git/info/exclude` (the local-only ignore file, never the tracked `.gitignore`), so the
main checkout still shows clean; only a root inside the `.git` directory itself is refused.

Change it with `worktree_set_root`:

- `scope: "global"` — every repository, stored in the user config file.
- `scope: "repo"` — one repository only; pass `repoPath`.

`root: null` clears the root — `worktree_create` refuses until one is set again. Other knobs: `baseRef`
(`auto` = the current checked-out branch of the session repository, repository default branch when
detached), `branchPrefix` (default `wt/`), `staleDays` (idle threshold for the audit, default 14).

Precedence is environment first (`WORKTREE_ROOT`, `WORKTREE_BASE_REF`, `WORKTREE_BRANCH_PREFIX`,
`WORKTREE_STALE_DAYS`), then the per-repository override, then the global config file. Hosts that
offer a settings page usually map their fields onto those environment variables, so a value the
user typed in the UI wins over anything you configured earlier. Every tool's `Config:` line marks
each value's source (`env` / `repo` / `global` / `default`) — read it before concluding that a
setting "did not apply". Passing `null` to `root` / `baseRef` / `branchPrefix` resets to the
default; an empty string is rejected, so never send `""` to mean "leave unchanged".

Read the current setting before the first operation of a session if the user has not pinned it in
this conversation. Report the resolved root path in your answer; users care where worktrees land.

## Creating one

1. Confirm the repo (`repoPath` defaults to the session directory).
2. `worktree_create` with a `name` — a real branch name (`feat/login`) is used as-is; a short task
   name gets the prefix and slug applied. An existing branch is checked out as-is (the way to
   inspect or verify a PR branch); git refuses when it is already checked out in another worktree.
3. Give the user the three concrete steps: open a new session, set the printed path as its
   working directory, paste the printed briefing.
4. Stay in the current session and keep doing current-session work. Creating a worktree is not a
   hand-off, and pretending otherwise strands the task.

When the output contains a `base lag:` line, the session branch is behind the repository default
branch, so this worktree starts without those commits. Say so instead of calling the result
complete, and offer to re-create with `baseRef: "<the default branch it names>"`.

Failures worth handling yourself: a non-empty target directory (leftover from a removed worktree),
a `baseRef` that does not exist, or an unset root (configure it with `worktree_set_root`, then retry).
An `ambiguous worktree name` error means several worktrees match what you passed — re-issue the call
with the absolute path of the one you mean; never guess between the candidates.
Fix the path or the ref and retry; do not escalate to the user
before you have tried the obvious correction.

## Listing and auditing

- `worktree_list` — cheap inventory: branch, clean state, ahead/behind, merge state.
- `worktree_audit` — the cleanup pass. Buckets are `safe` (clean and already merged), `review`
  (clean but not merged or idle), `hold` (dirty, unmerged, locked, or the primary worktree).

Neither deletes anything. Report the table, then ask before removing anything, even `safe` rows.

## Removing

`worktree_remove` refuses dirty worktrees, unmerged commits, and worktrees outside the managed root
unless `force: true`. Pass `force` only when the user has explicitly said to discard uncommitted or
unmerged work, and say in your answer that data was destroyed. After removing, offer
`deleteBranch: true` when the branch is fully merged.

Lock a worktree someone else is working in with `worktree_lock` (release it with `worktree_unlock`);
remove and merge-back refuse to touch locked worktrees, and the audit buckets them `hold`.

Never prune or remove the primary worktree.

## Merging back

`worktree_merge_back` is report-only unless you pass `rebase`, `merge`, or `remove`. Default flow:

1. Call it with no flags to get the plan (clean, ahead count, already merged).
2. `rebase: true` — the tool stops and reports on conflict instead of resolving it; hand the
   conflicted file list to the user or fix it in the worktree, then re-run.
3. `merge: true` — merges into the checked-out target in the main worktree, and refuses when the
   main worktree has a different branch checked out. Check that first; a dirty main checkout turns
   the merge into a conflict for the user. Pass `ff: true` for a fast-forward-only merge (linear
   history, no merge commit); it refuses when the branches diverged — rebase first or drop `ff`.
4. `remove: true` (+ `deleteBranch`) once the merge is verified.

After the merge, run the repository's own checks before telling the user the branch is ready.

## Handoff

`worktree_handoff` produces the ready-to-paste briefing: absolute path, branch, base target, task
text, and the session constraints. Use it whenever work moves to another session or another person
— including a parallel agent run the user will open by hand.

## Rules

- Confirm with the user before any destructive call (`worktree_remove`, `force`, `deleteBranch`).
- Never invent a worktree path; always report the tool's output.
- One worktree per branch. A branch already checked out in a worktree cannot be checked out again.
- Do not edit files inside a worktree this session does not own, unless the user asked for exactly
  that; it usually has an agent or another session working in it.
