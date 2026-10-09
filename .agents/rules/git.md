---
paths:
  - "**"
---

# Git Workflow Rules

- Coding requests authorize committing and pushing the agent's own code/documentation changes by default. Commit a coherent unit promptly when practical; otherwise commit and push before reporting task completion. This applies to the main agent and implementation subagents without another confirmation. An explicit user instruction to leave changes local or not to commit/push overrides this default. Reviewers stay read-only.
- Use the canonical checkout at `C:\Projects\qbo` as the default workspace.
- Do not create, use, or continue work inside Git worktrees, `.claude/worktrees/`, alternate clones, temp checkouts, or detached worktrees unless the user explicitly asks for that in the current conversation.
- Work on `main` for this checkout. Use `master` only if the repo is explicitly configured with `master` as its default branch.
- Do not create, switch to, commit on, or push from feature branches unless the user explicitly asks for a branch or worktree in the current conversation.
- Before editing and at closeout, inspect full status, branch and upstream. Confirm the current branch is `main` or `master`; if not, stop and follow the root branch rule.
- Stage only owned paths/hunks, inspect the staged diff, and keep pre-existing/concurrent changes, secrets, local settings and unintended generated files out.
- Push promptly to the configured upstream. If unrelated local commits are ahead or policy/push errors prevent a safe push, report the exact blocker and do not claim remote completion.
