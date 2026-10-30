---
name: qbo-team-delivery
description: Team delivery workflow for building a new capability in C:\Projects\qbo (e.g. a new accountant workflow) with Claude Opus 5.5 implementing, GPT-6.1 Sol (xhigh, via the Codex companion) doing read-only plan and implementation reviews, the qbo-safety-reviewer on QuickBooks write paths, and gpt-6-luna running every test. Use whenever the owner asks to build, extend or "keep going" on accountant tools or other multi-file backend/UI features in this repo.
---

# QBO team delivery

Owner direction (2026-10-29): **Opus builds (backend and all UI/UX), Sol reviews, Luna tests, the lead verifies and commits.** The owner gets a short brief at every checkpoint. The connected QBO company is a test account simulating a business; keep data-integrity checks, but do not add owner approvals for new workflows.

## Roles

| Role | Who | Notes |
| --- | --- | --- |
| Lead | main Claude session | Writes the plan, verifies reviews against code, runs Luna, commits, briefs the owner. |
| Implementer | Claude Opus 5.5 fork (`Agent`, `subagent_type: fork`, background) | Builds backend and UI. One implementer per set of files at a time. |
| Plan and code reviewer | GPT-6.1 Sol, xhigh, read-only | Codex companion `task` **without** `--write`. Its sandbox cannot run Luna or git. |
| Safety reviewer | `qbo-safety-reviewer` subagent | Required for anything that writes to QuickBooks or changes operation state. |
| Test runner | `gpt-6-luna` via the Luna bridge | The only executor of tests, lint and build. |

## Steps

1. **Plan.** Write the design (goal, files, invariants, tests) to `artifacts/luna/tmp/<topic>-plan.txt` (gitignored). Update the relevant `docs/plans/*.md` when scope changes.
2. **Sol plan review.** Start it and arm the watcher **in the same step** (Codex jobs never notify Claude):
   ```bash
   node "$CODEX/scripts/codex-companion.mjs" task --background --model gpt-6.1-sol --effort xhigh "$(cat artifacts/luna/tmp/<topic>-plan.txt)"
   ```
   Then a `Monitor` that loops `codex-companion.mjs status <job-id> --json` every 60s and exits on completed/failed/cancelled/error. Fetch with `codex-companion.mjs result <job-id> > artifacts/luna/tmp/<topic>-review.md`. (`$CODEX` = `C:/Users/NewAdmin/.claude/plugins/cache/openai-codex/codex/<version>`.)
3. **Verify, then brief.** Spot-check the top findings against the cited file:line before accepting them. Never pass a review on as a spec unverified. Brief the owner: top findings, accepted/rejected with reason, what changes.
4. **Implement (Opus fork).** Give the fork the reviewed spec path and these rules:
   - main branch only; no live QBO writes; no service start/stop; never print secrets;
   - the backend runs under nodemon and reloads on every save, so every saved file must stay syntactically valid (`node --check` after each edit). A broken file crashes the live backend;
   - tests only through the Luna bridge; commit and push only its own files.
   Never run two implementers that touch the same files: concurrent writes once corrupted a file and took the backend down.
5. **Reviews of the code.** In parallel, read-only:
   - Sol implementation review of the commit or diff (same command, no `--write`, with a watcher);
   - `qbo-safety-reviewer` when the change writes to QuickBooks or changes operation state.
   Verify each finding against the code, fix confirmed ones (small fixes by the lead, larger by a fork), and brief the owner. If a fix is more than a few lines or touches a write path, send just that fix back to Sol for a focused re-review; repeat until no blocking finding remains. Record deferred findings in the plan doc.
6. **Tests (Luna).**
   - Single-file commands, about 14 per request. Every run needs **new** receipt file names; the bridge refuses to overwrite, and old receipts would be misread as results.
   - Files that take longer than about 2 minutes get killed (exit -1) and leave later commands unrun: rerun those files one per request.
   - "command-evidence-failed" with nothing run is bridge flakiness: retry up to three times.
   - For broad changes run every `backend/test/business-*.test.js` plus `npm run lint --workspace=frontend` and `npm run build --workspace=frontend`.
7. **UI check.** For visible changes, open the page in a named `agent-browser` session at desktop width (owner token placed into localStorage without printing it), screenshot, inspect, then close the session.
8. **Commit and push.** `git status --short --branch`, stage only owned paths/hunks (filter shared files by hunk if another job's edits are mixed in), scan the staged diff for secrets, commit with the attribution trailer, push to `origin/main`.
9. **Live check when the capability runs.** Read-only confirmation in QuickBooks of what the accountant actually saved (`qbo_query`-style scripts through the app client, never printing tokens). Report it plainly.
10. **Brief the owner** at the end: what shipped (commit), proof (tests, review outcome, live evidence), limits, and whether they need to do anything.

## Gotchas

- Changing the same-day activity `POLICY` adds a version. Keep every earlier policy in `SAVED_POLICIES`, each limited to its own workflows, so saved batches still rebuild and finish.
- Keep the owner-facing text current: `businessAgentCapabilities()`, the approval dialog in `BusinessWorkspace.jsx`, catalog rows in `business-agent-catalog.js` and work-list items. A catalog test fails when a tool lacks a description.
- After any batch of edits, check backend health (`curl http://127.0.0.1:3001/api/health`) and `node --check` the changed files. Never restart services; nodemon reloads by itself.
