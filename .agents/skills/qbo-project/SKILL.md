---
name: qbo-project
description: QBO Support Lab project workflow and orientation. Use when working in C:\Projects\qbo on repo orientation, status review, backend/frontend changes, docs updates, route/module tracing, AI workflow changes, or any task where Codex needs the QBO Support Lab source map, safe commands, and project-specific development boundaries.
---

# QBO Project

Use this skill to get grounded in the QBO Support Lab before changing or reviewing project files.

## Workflow

1. Read `AGENTS.md`.
2. Read `.codex/memory/PROJECT_MEMORY.md` when durable project state matters.
3. For commit/push or repo-state work, confirm the canonical checkout and `main`/`master` branch rule from `AGENTS.md`; do not use worktrees or non-default branches unless the user explicitly asked.
4. Read only the task-relevant source files from `references/repo-map.md`.
5. Classify the task as one of:
   - docs/agent architecture
   - frontend-only
   - backend read-only
   - backend mutation path
   - QBO/API path
   - AI plan/tool path
6. If the task touches QBO writes, OAuth, stored keys, AI plan execution, seeding, generation, issue packs, checkpoints, or startup behavior, also use `qbo-safety-review`.
7. Prefer non-mutating verification. Do not start services or run QBO scripts unless the user explicitly asked.

## Safe Defaults

- For docs/agent changes, use `git diff --check`.
- For commit/push work, use `git status --short --branch` and push only to the matching `origin/main` or `origin/master` unless explicitly instructed otherwise.
- For frontend changes, prefer `npm run build --workspace=frontend` and `npm run lint --workspace=frontend`.
- For backend changes, prefer `node --check` on touched files or all `backend/src/**/*.js`.
- For live QBO/API checks, state the exact command/route and wait for approval.

## Reference

Read `references/repo-map.md` for the current file map, command map, and mutation hotspots.
