---
name: qbo-implementation-plan
description: Scoped implementation planning workflow for QBO Support Lab. Use before larger or risky work in C:\Projects\qbo, especially when a change touches multiple backend/frontend files, QBO integration, AI orchestration, auth, stored keys, database models, route contracts, roadmap/phase docs, or requires deciding safe verification without mutating QBO.
---

# QBO Implementation Plan

Use this skill to plan work before editing when scope or safety risk is non-trivial.

## Workflow

1. Restate the user goal in project terms.
2. Read `AGENTS.md`, `.codex/memory/PROJECT_MEMORY.md`, and only task-relevant source files.
3. For commit/push or repo-state work, plan against the canonical checkout and `main`/`master` branch rule from `AGENTS.md`; worktrees and non-default branches require explicit user instruction.
4. Classify risk using `references/planning-checklist.md`.
5. Define the smallest implementation boundary.
6. List files likely to change and files to inspect only.
7. Identify verification:
   - static checks
   - frontend build/lint
   - backend syntax checks
   - live checks requiring approval
8. If QBO/API/AI execution risk exists, include `qbo-safety-review` in the plan.

## Plan Quality Bar

A good plan says:

- what will change
- what will not change
- what can be verified safely
- what requires explicit live approval
- what docs/memory need updating
- what branch/upstream is assumed for commit/push tasks

Avoid plans that start servers, hit QBO, or mutate database state unless the user explicitly asked for that.

## Reference

Read `references/planning-checklist.md` for planning prompts and risk categories.
