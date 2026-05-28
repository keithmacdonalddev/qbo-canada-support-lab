# Codex Agent Handoff

Use this file to orient future coding agents on current repo-specific workflow.

## Branch State (as of 2026-05-28)

- Branch `fix/qbo-client-error-handling` holds the QBO error-handling + frontend-hardening work (status-based `qbo-client.js` `apiCall()`, `qbo-error.js` helper, `toast.jsx`/`alert.jsx`). 4 commits, NOT yet merged to main and NOT pushed.
- Pending next steps:
  - Production wiring: tunnel/deploy a public HTTPS redirect URI, register it, and switch `.env` `QBO_ENVIRONMENT` from `sandbox` to production. Intuit production API access is already UNLOCKED; only the real-company connection remains.
  - Planned-but-unbuilt: multicurrency support (foreign-currency accounts, revaluation, balance-sheet FX).
- App identity is an INDEPENDENT personal app; public/app names must NOT contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit registration "Support Lab"). Hosted legal pages exist at the project's GitHub Pages site; local `legal/` source is untracked.

## Default Workflow

1. Read `AGENTS.md`.
2. Read `.codex/memory/PROJECT_MEMORY.md`.
3. Select the smallest relevant source files for the request.
4. Avoid live server starts and QBO/database mutations unless the user explicitly asks.
5. Run non-mutating verification before reporting completion.

## Risk Hotspots

- `scripts/phase-0/`: direct QBO OAuth and validation scripts using `.tokens.json`.
- `backend/src/server.js`: startup side effects.
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
