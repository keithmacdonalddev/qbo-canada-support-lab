# Roles, limits and pitfalls

## Contents
- Roles
- Codex companion (Sol)
- Luna bridge
- Accountant workflow conventions
- Pitfalls

## Roles

| Role | Who | Notes |
| --- | --- | --- |
| Lead | main Claude session | Plans, verifies review claims against code, runs Luna, commits, briefs the owner. |
| Implementer | fresh Claude Opus subagent (`Agent`, `subagent_type: worker`, `model: opus`, background) | Backend and all UI/UX. One implementer per set of files. Never `fork`: it copies the whole conversation into its context. |
| Plan and code reviewer | GPT-6.1 Sol at xhigh effort | Read-only: Codex companion `task` without `--write`. |
| Safety reviewer | `qbo-safety-reviewer` subagent | Required when QuickBooks writes or operation state change. |
| Test runner | `gpt-6-luna` via the Luna bridge | The only executor of tests, lint and build. |

The owner set this split. The connected QuickBooks company is a test account simulating a business: keep data-integrity checks, but new accountant workflows do not need fresh owner approval.

## Codex companion (Sol)

- `scripts/codex.sh` resolves the newest installed companion under `~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` and forwards its arguments.
- Status: `codex.sh status <job> --json`. Result: `codex.sh result <job>`. Resume a finished job with `task --resume-last`.
- Sol's sandbox cannot run the Luna bridge or `git commit` (`.git/index.lock` is denied). Plan for the lead to do both.
- Several fresh `task` jobs can run at once. Only one can be resumed at a time.

## Luna bridge

- Command: `node scripts/agent-harness/luna-exec.mjs --request artifacts/luna/<req>.json --receipt artifacts/luna/<new-receipt>.json`.
- Allowed commands: `node --test backend/test/<file>.test.js` (one file per command), `npm run test|lint|build --workspace=...`, `node --check backend/src/...`.
- Every run needs a **new** receipt path. The bridge refuses to overwrite one, and the leftover file would be misread as fresh results.
- About 14 commands per request work well. A command running longer than about 2 minutes is killed with exit -1, and the commands after it don't run. Rerun those one per request.
- "command-evidence-failed" with no commands run is bridge flakiness. Retry up to 3 times.
- Read failures from the transcript at `receipt.runner.transcript.path` (`aggregated_output` of the failed `CommandExecution`).

## Accountant workflow conventions

- A new same-day workflow adds a `POLICY` version in `backend/src/modules/business-activity-batch.js`. Keep every earlier policy in `SAVED_POLICIES`, limited to its own workflows and original semantics, so saved batches still rebuild and finish.
- Each new record type needs:
  - compiler payload
  - read-back checks
  - financial-movement postings (or an explicit zero-movement case)
  - lifecycle contract
  - dated tax for taxed types (`business-dated-tax.js` `CHARGES`)
  - tool schema
  - choices
- Owner-facing text must stay current:
  - `businessAgentCapabilities()`
  - the approval dialog in `frontend/src/pages/BusinessWorkspace.jsx`
  - catalog rows in `business-agent-catalog.js` (a test fails when a tool lacks a description)
  - work-list items

## Pitfalls

- The backend runs under nodemon. A half-written file crashes it, and two writers on one file once corrupted it. After edits, run `scripts/check-changed-syntax.sh` and check `http://127.0.0.1:3001/api/health`. Never restart services.
- Lean Mongoose rows contain `Date` values, and the project's `hash()`/`canonical()` refuses them. Convert with `JSON.parse(JSON.stringify(row))` before hashing.
- QuickBooks paged queries report `totalCount` for each page, not for the whole query.
- Test fixtures can hide live shapes. When the shape matters, compare against a real record read-only through the app's client, never printing tokens.
