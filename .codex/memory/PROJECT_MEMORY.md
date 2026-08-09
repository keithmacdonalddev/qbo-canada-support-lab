# Codex Project Memory

Last verified: 2026-08-09. Authority: `AGENTS.md`, `prd.md`, `roadmap.md`, `continual-test-data-lab-rebuild-plan.md`, current source, and the live environment state verified without printing secrets.

This memory is for coding agents working on `C:\Projects\qbo`.

It is not the app runtime's durable user memory. It is local project context for future coding sessions.

## Current State

- Project: Test Data Lab (internal checkout `C:\Projects\qbo`).
- Root: `C:\Projects\qbo`.
- Product purpose: maintain one flagship QBO Advanced Canada company as a believable, continually evolving business with blueprint, capability/report coverage, controlled operations, data management, reconciliation evidence, and manual support reproduction.
- Rebuild status (2026-08-09): Phase 0 is complete. Phase 1 has 24 capabilities, a schema-valid 12-entity Tier 1 operation matrix, and 48 statically classified report rows; 24 create/update cells, six void operations, two lower-tier API questions, all dataset evidence, and owner approval remain open. Phase 2 is fixture verified pending owner visual approval. An initial non-live Phase 3 read-only foundation is implemented; no new QBO mutation path, migration, scheduler, or live verification exists.
- Phase 3 source: `backend/src/routes/rebuild.js` exposes server-owned context and static definition reads; `CompanyMembership` and `BlueprintVersion` are additive models; `docs/architecture/rebuild-phase-3-foundation.md` records the migration/encryption/startup decisions and open gates.
- Legacy AI plan execution and issue-pack execution are off by default through server feature flags. Server import is side-effect-free, and legacy issue-pack seeding/stale-run rewrites are default-off even on explicit startup unless `LEGACY_STARTUP_MAINTENANCE_ENABLED=true`. Explicit startup still connects MongoDB and requires user authorization.
- Legacy priority: checkpoints are deferred; current issue packs and AI are preserved as legacy/experimental and are not normal rebuild workflow requirements.
- Backend: Node/Express CommonJS under `backend/src/`.
- Frontend: Vite/React under `frontend/src/`.
- Database: MongoDB via Mongoose.
- QBO integration: Intuit OAuth and QBO client modules.
- AI integration: Anthropic SDK in `backend/src/modules/ai-provider.js`; user keys can be stored per user, and a global key can be enabled by environment.
- Current source includes the old Phase 1-3 surfaces, but those historical phases do not map to the rebuild phases. Verify current source and the rebuild evidence checklist before claiming completion.
- Backend startup connects MongoDB. Built-in issue-pack seeding and stale job/AI plan rewrites are retained but default-off behind `LEGACY_STARTUP_MAINTENANCE_ENABLED`; importing the server performs neither startup nor database work.
- QBO error handling is status-based (as of 2026-05-28). `backend/src/modules/qbo-client.js` `apiCall()` captures Intuit `intuit_tid` via `getLastIntuitTid()`, retries 429 with clamped exponential backoff (60s/attempt cap, max 5), and throws errors carrying `err.status` + `err.intuit_tid` + QBO Fault message on 4xx/5xx. Helper `backend/src/modules/qbo-error.js` (`isQboError`/`respondQboError`) maps QBO upstream errors to HTTP 502 (429 passthrough) with `{ error, intuit_tid, qboStatus }`. Wired into `ai`, `checkpoint`, `company`, `explore` routes; `seed`/`generate`/`issuepacks` intentionally unchanged (fire-and-forget jobs surfaced via `/status` and `/log`). Routes must NOT return a QBO-side 401 as an app-level 401 — the frontend treats any 401 as session expiry and force-logs-out the user.
- SDK gotcha: `intuit-oauth@4.2.2` is axios-based. `makeApiCall` RESOLVES on 2xx-4xx (`validateStatus < 500`) and THROWS on 5xx/network with the HTTP status in `err.code` (string), not `err.status`/`.statusCode`/`.authResponse`.
- Frontend error-surfacing primitives: `frontend/src/components/ui/toast.jsx` (`ToastProvider` + `useToast`) and `frontend/src/components/ui/alert.jsx`, mounted in `frontend/src/App.jsx`. Prefer these over silent catches.
- Production status (2026-05-28): Intuit production API access is UNLOCKED, and a REAL production QBO company is now CONNECTED. `.env` is `QBO_ENVIRONMENT=production` with production client id/secret and `QBO_REDIRECT_URI=https://<ngrok-reserved-domain>/api/qbo/callback`. The connection used an ngrok tunnel to the local backend (port 3001) ONLY for the OAuth callback; frontend stays on localhost:5173 (no code change needed for backend-only tunneling). The tunnel is only needed during connect/reconnect; normal QBO calls go backend->Intuit directly. App identity is an INDEPENDENT personal app; public/app names must NOT contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit registration "Support Lab").
- Legacy Production guard: `requireProductionConfirm` remains on seed/generate/issue-pack execution and AI plan execution. In addition, issue-pack and AI plan execution now require their default-off server feature flags before reaching Production confirmation or handlers.

## Durable Decisions

- Public name is Test Data Lab. Use QBO/QuickBooks only as descriptive integration terms, not as the application name.
- The continual rebuild plan is the detailed product-priority authority; capability/report discovery and fixture-driven design gate new QBO mutation architecture.
- Automatic Production scheduling remains off until separate approval after stable manual evidence.
- Do not run QBO mutation scripts or mutating backend routes without explicit current user approval.
- Do not start or restart long-running app services without explicit current user approval.
- Keep provider credentials and personal model/account settings out of repo files.
- Treat AI as a controlled assistant that uses internal tools and approval flows, not raw QBO API access.
- Use repo-local skills for repeatable QBO orientation, implementation planning, and safety review.
- Git workflow: agents default to the canonical checkout at `C:\Projects\qbo` on `main`; do not create or use worktrees, alternate clones, detached checkouts, or non-`main`/`master` branches unless the user explicitly asks in the current conversation. Unqualified commit/push requests target the current `main`/`master` checkout and matching `origin/main` or `origin/master` upstream.

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
