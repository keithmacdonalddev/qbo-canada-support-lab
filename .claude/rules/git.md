---
paths:
  - "**"
---

# Git Workflow Rules

- Use the canonical checkout at `C:\Projects\qbo` as the default workspace.
- Do not create, use, or continue work inside Git worktrees, `.claude/worktrees/`, alternate clones, temp checkouts, or detached worktrees unless the user explicitly asks for that in the current conversation.
- Work on `main` for this checkout. Use `master` only if the repo is explicitly configured with `master` as its default branch.
- Do not create, switch to, commit on, or push from feature branches unless the user explicitly asks for a branch or worktree in the current conversation.
- Before committing or pushing, run `git status --short --branch` and confirm the current branch is `main` or `master`.
- If the current branch is not `main` or `master`, the HEAD is detached, or the path is a worktree, stop and ask the user before changing branch state.
- When the user asks to commit or push without naming a branch, commit on the current `main`/`master` checkout and push to the matching upstream (`origin/main` or `origin/master`).
