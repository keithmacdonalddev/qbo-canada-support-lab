# AGENTS.md

> FOR OPENAI CODEX ONLY. Claude Code sessions should read `CLAUDE.md`, which imports this file and adds Claude-specific guidance.

## Project Identity

This repository is `C:\Projects\qbo`, the QBO Canada Support Lab.

The product is a local web application for QuickBooks Online Canada support work. A user connects one QBO Advanced Canada company, then uses the app to seed realistic support data, generate history, create checkpoints, inject issue packs, inspect QBO state, and use AI-assisted investigation and support-note workflows.

The practical mental model is:

`one user -> one connected QBO company -> generate, break, inspect, explain`

## Current Implementation Snapshot

Treat docs as useful but potentially stale. Re-check source before making status claims.

- Root docs: `prd.md`, `roadmap.md`, `phase-0-api-validation-spike.md`, `phase-1-foundation-plan.md`, `phase-2-plan.md`, `phase-2-reality-inspection-plan.md`, `phase-3-ai-layer-plan.md`.
- Phase 0 scripts exist under `scripts/phase-0/`.
- Backend code exists under `backend/src/` with Express, Mongoose, QBO OAuth/client modules, seeding, generation, checkpoints, issue packs, audit, and AI routes.
- Frontend code exists under `frontend/src/` with Vite, React, protected routes, dashboard, onboarding, explorer, checkpoints, issue packs, settings, audit, and AI command center pages.
- The old `CLAUDE.md` claimed Phase 1/Phase 2 status and should not be treated as current source of truth after this architecture update.
- QBO error handling is status-based. `backend/src/modules/qbo-client.js` `apiCall()` captures Intuit `intuit_tid` from response headers (`getLastIntuitTid()`), retries 429 with clamped exponential backoff (60s/attempt cap, max 5 attempts), and throws errors carrying `err.status`, `err.intuit_tid`, and the QBO Fault message on 4xx/5xx. Helper `backend/src/modules/qbo-error.js` (`isQboError`/`respondQboError`) maps QBO upstream errors to HTTP 502 (429 passthrough) with `{ error, intuit_tid, qboStatus }`. Routes must NOT surface a QBO-side 401 as an app-level 401: the frontend treats any 401 as session expiry and force-logs-out the user. Wired into `ai`, `checkpoint`, `company`, `explore` routes; `seed`/`generate`/`issuepacks` are intentionally unchanged (fire-and-forget background jobs surfaced via `/status` and `/log`).
- SDK gotcha: installed `intuit-oauth@4.2.2` is axios-based. `makeApiCall` RESOLVES on 2xx-4xx (`validateStatus < 500`) and THROWS an OAuthError on 5xx/network failures with the HTTP status in `err.code` (a string), not `err.status`/`.statusCode`/`.authResponse`.
- Frontend error-surfacing primitives: `frontend/src/components/ui/toast.jsx` (`ToastProvider` + `useToast`) and `frontend/src/components/ui/alert.jsx`, mounted in `frontend/src/App.jsx`. Prefer these over silent catches when surfacing errors.
- Production status (2026-05-28): Intuit Developer production API access is UNLOCKED (passed full App Assessment; app "IN PRODUCTION"). Connecting a real company is NOT done — `.env` still uses `QBO_ENVIRONMENT=sandbox`; production OAuth needs a public HTTPS redirect URI (tunnel/deploy). App identity is an INDEPENDENT personal application; public/app names must NOT contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit dashboard registration "Support Lab").

## First Files To Read

Read only the files needed for the task. Use this routing before broad scanning.

- Project orientation: `prd.md`, `roadmap.md`, `package.json`, `backend/package.json`, `frontend/package.json`.
- Backend startup and side effects: `backend/src/server.js`, `backend/src/config/index.js`, `backend/src/config/database.js`.
- QBO auth/client work: `backend/src/routes/qbo.js`, `backend/src/modules/qbo-client.js`, `backend/src/modules/qbo-error.js`, `scripts/phase-0/lib/qbo-client.js`.
- Seeding/generation: `backend/src/routes/seed.js`, `backend/src/routes/generate.js`, `backend/src/modules/generation-engine.js`.
- Inspection/checkpoints: `backend/src/routes/explore.js`, `backend/src/routes/checkpoint.js`, `backend/src/modules/checkpoint.js`.
- Issue packs: `backend/src/routes/issuepacks.js`, `backend/src/modules/issuepack-engine.js`, `backend/src/modules/issuepack-seeder.js`, `backend/src/models/IssuePack.js`, `backend/src/models/IssuePackRun.js`.
- AI layer: `phase-3-ai-layer-plan.md`, `backend/src/routes/ai.js`, `backend/src/modules/ai-provider.js`, `backend/src/modules/ai-orchestrator.js`, `backend/src/modules/ai-tools.js`, `backend/src/modules/ai-notes.js`, `frontend/src/pages/AICommandCenter.jsx`, `frontend/src/components/ai/`.
- Frontend shell/routes: `frontend/src/App.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/api/client.js`, `frontend/src/context/AuthContext.jsx`, `frontend/src/index.css`.
- Error surfacing (frontend): `frontend/src/components/ui/toast.jsx`, `frontend/src/components/ui/alert.jsx`.
- Agent architecture: `.codex/memory/PROJECT_MEMORY.md`, `.codex/memory/AGENT_HANDOFF.md`, `.agents/rules/`, `.agents/skills/`.

## Provider Architecture

This repo uses both OpenAI Codex and Claude Code.

- Codex persistent guidance lives in this file.
- Codex repo skills live in `.agents/skills/`.
- Codex project memory/handoff notes live in `.codex/memory/`.
- Codex scoped rules live in `.agents/rules/` and are referenced by skills and this file.
- Claude persistent guidance lives in `CLAUDE.md`.
- Claude memory lives in `.claude/memory/`.
- Claude path rules live in `.claude/rules/`.
- Claude subagents live in `.claude/agents/`.
- Claude project skills live in `.claude/skills/`.

Do not put provider login, API keys, base URLs, telemetry keys, or personal account settings in repo files. Keep those in user-level tool config or local environment.

## Safety Rules

This project can mutate a real or sandbox QBO company and a local/Atlas MongoDB database. Default to read-only inspection unless the user explicitly asks for a mutating action.

- Never print `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, API keys, raw Authorization headers, or user-supplied AI keys.
- Do not run Phase 0 QBO scripts unless explicitly asked in the current conversation: `npm run connect`, `npm run seed`, `npm run ar-chain`, `npm run ap-chain`, `npm run read-chains`, `npm run rate-limits`, `npm run sales-order`.
- Do not call backend routes that mutate QBO or database state unless explicitly requested. This includes seeding, generation, issue pack execution, plan execution, QBO OAuth flows, checkpoint creation/deletion, and settings changes that save keys.
- Do not start, stop, restart, or replace long-running backend/frontend servers unless explicitly asked. Backend startup connects to MongoDB, seeds built-in issue packs, and marks stale jobs/plans failed.
- It is OK to inspect code, read logs, check `git status`, run static checks, and explain what command the user should run.
- If live verification requires a running app or QBO-connected company, say so and ask before starting or mutating anything.

## Commands

Root:

- `npm run dev` - starts backend and frontend together. Do not run without explicit user request.
- `npm run connect` - Phase 0 OAuth flow. Mutating/auth flow; explicit request only.
- `npm run seed` - Phase 0 master-data seeding. Mutates QBO; explicit request only.
- `npm run ar-chain`, `npm run ap-chain`, `npm run read-chains`, `npm run rate-limits`, `npm run sales-order` - Phase 0 validation scripts. Explicit request only.

Backend:

- `npm run dev --workspace=backend` - starts nodemon. Explicit request only.
- `npm run start --workspace=backend` - starts server. Explicit request only.
- No backend test script is currently defined.
- Safe default syntax check: `Get-ChildItem backend/src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`

Frontend:

- `npm run dev --workspace=frontend` - starts Vite. Explicit request only.
- `npm run build --workspace=frontend` - safe static build.
- `npm run lint --workspace=frontend` - safe lint.
- `npm run preview --workspace=frontend` - starts preview server. Explicit request only.

## Implementation Rules

- Keep backend code CommonJS unless a file already uses another module system.
- Keep frontend code ESM/React JSX.
- Keep QBO mutations behind explicit user intent, visible company scope, audit logging, and existing route/module boundaries.
- Use existing modules before adding new abstractions.
- Keep AI writes behind plan/approval flows. AI should use internal tool contracts, not raw QBO API calls.
- Update docs or memory when a durable project fact changes.
- Use project skills when their trigger matches:
  - `.agents/skills/qbo-project` for repo orientation and general changes.
  - `.agents/skills/qbo-safety-review` for QBO/API/database/secret risk review.
  - `.agents/skills/qbo-implementation-plan` for scoped planning before larger changes.

## Verification

Prefer the smallest useful verification step.

- Documentation or agent-architecture changes: inspect files, validate skill frontmatter, and run `git diff --check`.
- Frontend code changes: run `npm run build --workspace=frontend` and `npm run lint --workspace=frontend` when practical.
- Backend code changes: run Node syntax checks against touched backend files; broaden to all `backend/src/**/*.js` for shared changes.
- QBO mutation paths: do not live-test without explicit user approval and a stated target company/environment.
- Browser testing: use the available browser tool only if the app is already running or the user asks to start/open it.

## Review Standard

For reviews, lead with findings ordered by severity and include file/line references. Focus on bugs, regressions, missing safety checks, missing tests, stale docs, and places where the implementation violates QBO safety or AI approval boundaries.

## Done Criteria

Before reporting completion:

- Re-check the files changed in the current turn.
- Run the relevant non-mutating verification.
- Report commands run and any commands skipped because they would start services or mutate QBO/database state.
- Mention any repo state that remains local-only or intentionally untracked.
