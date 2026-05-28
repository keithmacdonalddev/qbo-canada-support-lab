# Codex Project Memory

This memory is for coding agents working on `C:\Projects\qbo`.

It is not the app runtime's durable user memory. It is local project context for future coding sessions.

## Current State

- Project: QBO Canada Support Lab.
- Root: `C:\Projects\qbo`.
- Product purpose: connect one QBO Advanced Canada company per user, then support realistic lab data generation, issue reproduction, inspection, checkpoints, and AI-assisted explanation.
- Backend: Node/Express CommonJS under `backend/src/`.
- Frontend: Vite/React under `frontend/src/`.
- Database: MongoDB via Mongoose.
- QBO integration: Intuit OAuth and QBO client modules.
- AI integration: Anthropic SDK in `backend/src/modules/ai-provider.js`; user keys can be stored per user, and a global key can be enabled by environment.
- Current source includes Phase 2 surfaces and Phase 3 AI surfaces, but roadmap/status docs may be stale. Verify from source before claiming completion.
- Backend startup has side effects: MongoDB connection, built-in issue pack seeding, and stale job/AI plan recovery.
- QBO error handling is status-based (as of 2026-05-28). `backend/src/modules/qbo-client.js` `apiCall()` captures Intuit `intuit_tid` via `getLastIntuitTid()`, retries 429 with clamped exponential backoff (60s/attempt cap, max 5), and throws errors carrying `err.status` + `err.intuit_tid` + QBO Fault message on 4xx/5xx. Helper `backend/src/modules/qbo-error.js` (`isQboError`/`respondQboError`) maps QBO upstream errors to HTTP 502 (429 passthrough) with `{ error, intuit_tid, qboStatus }`. Wired into `ai`, `checkpoint`, `company`, `explore` routes; `seed`/`generate`/`issuepacks` intentionally unchanged (fire-and-forget jobs surfaced via `/status` and `/log`). Routes must NOT return a QBO-side 401 as an app-level 401 — the frontend treats any 401 as session expiry and force-logs-out the user.
- SDK gotcha: `intuit-oauth@4.2.2` is axios-based. `makeApiCall` RESOLVES on 2xx-4xx (`validateStatus < 500`) and THROWS on 5xx/network with the HTTP status in `err.code` (string), not `err.status`/`.statusCode`/`.authResponse`.
- Frontend error-surfacing primitives: `frontend/src/components/ui/toast.jsx` (`ToastProvider` + `useToast`) and `frontend/src/components/ui/alert.jsx`, mounted in `frontend/src/App.jsx`. Prefer these over silent catches.
- Production status (2026-05-28): Intuit production API access is UNLOCKED (passed App Assessment; app "IN PRODUCTION"). Real-company connection NOT done — `.env` still `QBO_ENVIRONMENT=sandbox`; production OAuth needs a public HTTPS redirect URI (tunnel/deploy). App identity is an INDEPENDENT personal app; public/app names must NOT contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit registration "Support Lab").

## Durable Decisions

- Do not run QBO mutation scripts or mutating backend routes without explicit current user approval.
- Do not start or restart long-running app services without explicit current user approval.
- Keep provider credentials and personal model/account settings out of repo files.
- Treat AI as a controlled assistant that uses internal tools and approval flows, not raw QBO API access.
- Use repo-local skills for repeatable QBO orientation, implementation planning, and safety review.

## First Files To Read

1. `AGENTS.md`
2. `prd.md`
3. `roadmap.md`
4. `backend/src/server.js`
5. `backend/src/config/index.js`
6. `frontend/src/App.jsx`
7. QBO error handling: `backend/src/modules/qbo-client.js`, `backend/src/modules/qbo-error.js`
8. Relevant route/module/page files for the task

## Update Rules

Update this file when future Codex sessions need a durable project fact that is not obvious from source or root docs.

Do not store secrets, raw tokens, private QBO data, customer records, raw prompts, or API responses here.
