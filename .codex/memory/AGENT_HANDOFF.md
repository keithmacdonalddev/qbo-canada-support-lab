# Codex Agent Handoff

## Verified company population (2026-10-16T17:35:14.167Z)

- Production company ending 2856 now has 60 actual newly created native masters: 7 accounts, 48 customers, 1 employee and 4 Service Items. Every ID has its original accepted receipt and independent readback. The app visibly shows 60 verified records and saved draft v4. This does not establish historical transactions, report acceptance or full-goal completion.
- Original plan 9d373b4c is closed after native subset application; its 5 Inventory and 6 Vendor entries were proved untouched and retired. Never replay it or recreate the 60 existing IDs. The final retained receipt is artifacts/goal-realization/company-native-masters-prefix-completion-execute-result-20261016.json.
- An actual MongoDB cursor-continuation failure stopped ordinal 51 before admission. Three native proved-unsent attempts remain in its history; the fourth succeeded after the bounded snapshot-query fix. All earlier IDs are unchanged, no unknown result remains, and the final child/token/database cleanup succeeded. Source fixes c6cd381 and 630a684 are pushed to origin/main; focused snapshot regression passed 74/74. See docs/architecture/intent-completion-2026-10.md and business-master-preparation.md for direct evidence and limits.
- A native company survey is now saved and reread successfully for 2026-10-01 through 2026-10-16 against draft v4: all 7 critical report scopes, 4 displayed structural comparisons and 2 agreeing scans of 777 current records. It remains Saved · Not accepted; huge old balances and coherent managed history are not accepted. Its native validation/audit/current-draft/writer-idle storage proof is artifacts/goal-realization/company-native-survey-verification-20261016.json.
- Continue the full flagship-company outcome, including actual history, meaningful variations and direct report acceptance. Existing full-goal authority covers necessary bounded reads, local preparation and ordinary new records in this exact company. Exact pre-existing-record destruction and unconfirmed money/workflow/costing facts remain pending decisions. Current generic master creation must not be treated as completion. Refresh the old cleanup inventory before use; its 718-record source predates these 60 masters.


## Owner-confirmed company context (2026-10-16T15:38:51.736Z)

- The active outcome is a robust flagship QuickBooks company filled to Test Data Lab’s intended business/history/report standard. Code milestones and a saved draft alone do not finish that outcome; continue necessary authorized goal work. See `docs/architecture/intent-completion-2026-10.md` for current implementation and direct evidence.
- On 2026-10-16 the owner explicitly confirmed that Production company ending 2856 contains test data with no reconciled or bank-matched transactions, filed tax returns, or protected accounting periods to preserve. This is the owner’s dated factual statement for this company, not an API inference or an assertion about another company or future state.
- The owner can open the connected QuickBooks account in a browser available to the agent when direct inspection is needed. Use that offer to check settings/evidence the API cannot establish; request the signed-in company view when needed without asking for passwords. Existing-record destruction still follows its exact disposition approval boundary.


> Status refresh (2026-08-09): the older dashboard branch notes below are historical. The rebuild now has an owner-approved catalog/profile/volume direction, a draft 12-entity matrix with 30 explicit Tier 1 operation unknowns, complete report static classification, an accepted Phase 2 fixture-design gate, and an initial read-only Phase 3 foundation. Use fresh `git status`, `roadmap.md`, and `REBUILD_RELEASE_EVIDENCE.md` as current authority.

Use this file to orient future coding agents on current repo-specific workflow.

## Branch State (historical facts through 2026-05-28; workflow refreshed 2026-07-11)

- The QBO error-handling + frontend-hardening work (status-based `qbo-client.js` `apiCall()`, `qbo-error.js` helper, `toast.jsx`/`alert.jsx`) is MERGED to `main` via PR #1 (merged 2026-05-28). Branch `fix/qbo-client-error-handling` is complete; `main` is now the active line of work.
- Agent git workflow (2026-05-29): work in the canonical `C:\Projects\qbo` checkout on `main`; do not use `.claude/worktrees/`, Git worktrees, alternate clones, detached checkouts, or non-`main`/`master` branches unless the user explicitly asks in the current conversation. Unqualified commit/push requests target `origin/main` for this checkout, or `origin/master` only if a future checkout is configured that way.
- DONE (2026-05-28): Production wiring. A REAL QBO Advanced Canada company is connected. `.env` is `QBO_ENVIRONMENT=production` with production client id/secret and an ngrok reserved-domain redirect URI registered in Intuit "Support Lab" Production. The ngrok tunnel fronts the local backend (port 3001) for the OAuth callback only; frontend stays on localhost:5173 (no code change needed for backend-only tunneling). Tunnel only needed during connect/reconnect.
- DONE (2026-05-28): Dashboard split into a read-only "awareness" Dashboard + a guarded `/lab` "Lab Tools" page, with a production write guard (`backend/src/middleware/productionGuard.js`). Reviewed by both safety + implementation reviewers (blocker fixed). See `PROJECT_MEMORY.md` and `phase-4-hardening-plan.md`.
- Current next steps:
  - Begin the Phase 4 React shell/read-only coverage slice using the accepted fixture contract; retain React interaction/NVDA/forced-colours as Phase 4 gates.
  - Complete the Phase 3 membership dry run and encrypted realm-owned connection design without running a migration.
  - Expand server authorization tests across every mutation route.
  - Keep multicurrency activation and fixtures separately gated.
- App identity is an INDEPENDENT personal app; public/app names must NOT contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit registration "Support Lab"). Hosted legal pages exist at the project's GitHub Pages site; local `legal/` source is untracked.

## Default Workflow

1. Read `AGENTS.md`.
2. Read `.codex/memory/PROJECT_MEMORY.md`.
3. For coding work, commit and push owned changes promptly or before completion unless the user explicitly says to leave them local. For repo-state work, run full `git status --short --branch --untracked-files=all`; continue only from the canonical checkout on `main` unless the user explicitly instructed a branch/worktree.
4. Select the smallest relevant source files for the request.
5. Avoid live server starts and QBO/database mutations unless the user explicitly asks.
6. Run non-mutating verification before reporting completion.

## Risk Hotspots

- `scripts/phase-0/`: direct QBO OAuth and validation scripts using `.tokens.json`.
- `backend/src/server.js` and `backend/src/app.js`: explicit startup versus import-safe app construction. MongoDB connection still requires startup permission; legacy startup writes are default-off.
- `backend/src/routes/rebuild.js`, `modules/rebuild-context.js`, and `modules/rebuild-permissions.js`: server-owned realm and permission boundaries.
- `backend/src/routes/seed.js`, `generate.js`, `issuepacks.js`, `checkpoint.js`, `ai.js`: mutation and approval boundaries.
- `backend/src/modules/qbo-client.js`: OAuth token refresh, status-based QBO API calls, 429 backoff, thrown errors with `err.status`/`err.intuit_tid`.
- `backend/src/modules/qbo-error.js`: maps QBO upstream errors to HTTP 502 (429 passthrough). Never let a QBO-side 401 reach the client as an app-level 401 (forces logout).
- `backend/src/modules/ai-orchestrator.js` and `ai-tools.js`: AI plan/tool execution boundaries.
- `frontend/src/pages/Settings.jsx`: user AI key and app configuration handling.

## Verification Defaults

- Agent/docs changes: `git diff --check`.
- Frontend changes: `npm run build --workspace=frontend` and `npm run lint --workspace=frontend` when practical.
- Backend changes: `node --check` on touched files or all `backend/src/**/*.js` for shared changes.
- Live QBO/API verification: only with explicit approval and stated target environment.
