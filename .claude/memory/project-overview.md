---
name: Project Overview
description: QBO Support Lab architecture, stack, and safety model summary
type: project
---

QBO Canada Support Lab is a local web app for QuickBooks Online Canada support workflows. A user connects one QBO Advanced Canada company, then uses deterministic app tools to seed data, generate business history, create checkpoints, run issue packs, inspect entities, and use AI-assisted investigation/support-note workflows.

Stack:

- Backend: Node/Express CommonJS in `backend/src/`.
- Frontend: Vite/React in `frontend/src/`.
- Database: MongoDB via Mongoose.
- QBO integration: Intuit OAuth and QBO API client modules. Error handling is status-based: `backend/src/modules/qbo-client.js` `apiCall()` captures `intuit_tid`, retries 429 with clamped backoff, and throws errors carrying `err.status`/`err.intuit_tid`; `backend/src/modules/qbo-error.js` maps QBO upstream errors to HTTP 502 (429 passthrough). A QBO-side 401 must never reach the client as an app-level 401 (the frontend force-logs-out on any 401). SDK note: `intuit-oauth@4.2.2` resolves on 2xx-4xx and throws on 5xx/network with the status in `err.code`.
- AI integration: Anthropic SDK behind `backend/src/modules/ai-provider.js`, orchestrated by `ai-orchestrator.js` and `ai-tools.js`.

Important safety model:

- Backend startup connects to MongoDB, seeds built-in issue packs, and marks stale jobs/plans failed.
- Phase 0 scripts and several backend routes can mutate QBO or database state.
- Agents must not start services, run QBO scripts, execute AI plans, or call mutating routes without explicit current user approval.
- Agents must use the canonical checkout at `C:\Projects\qbo` on `main` by default; do not use `.claude/worktrees/`, Git worktrees, alternate clones, detached checkouts, or non-`main`/`master` branches unless explicitly instructed in the current conversation.
- Secrets and tokens must never be printed or saved into docs, memory, or chat.

Status (2026-05-28):

- Production status (verified 2026-07-11): Intuit production API access is unlocked and a real QBO Advanced Canada company is connected. The local `.env` uses `QBO_ENVIRONMENT=production`; the ngrok reserved-domain tunnel is needed only for connect/reconnect OAuth callbacks. Treat live QBO actions as real-company operations.
- App identity is an INDEPENDENT personal application; public/app names must NOT contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit registration "Support Lab").
- Frontend error surfacing uses `frontend/src/components/ui/toast.jsx` (`ToastProvider`/`useToast`) and `alert.jsx` (mounted in `App.jsx`); prefer these over silent catches.
