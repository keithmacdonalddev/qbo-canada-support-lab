# Claude Project Memory

Last verified: 2026-07-11. See `../../AGENT_HARNESS.md` for memory boundaries and authority.

This memory is for Claude Code sessions in `C:\Projects\qbo`.

Stable facts:

- The app is the QBO Canada Support Lab.
- Root shared guidance is `AGENTS.md`; Claude-specific guidance is `CLAUDE.md`.
- Do not start services or run QBO mutation scripts without explicit current user approval.
- Default to the canonical checkout at `C:\Projects\qbo` on `main`; do not use `.claude/worktrees/`, Git worktrees, alternate clones, detached checkouts, or non-`main`/`master` branches unless the user explicitly asks in the current conversation.
- Do not print `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, or AI API keys.
- Use `.claude/agents/qbo-safety-reviewer.md` for QBO, OAuth, AI execution, key handling, and MongoDB mutation risk.

Durable decisions (2026-05-28):

- QBO error handling is status-based: `backend/src/modules/qbo-client.js` `apiCall()` throws errors carrying `err.status`/`err.intuit_tid` and retries 429 with clamped backoff; `backend/src/modules/qbo-error.js` (`respondQboError`) maps QBO upstream errors to HTTP 502 (429 passthrough). A QBO-side 401 must NEVER be returned to the client as an app-level 401 — the frontend force-logs-out on any 401. Wired into `ai`/`checkpoint`/`company`/`explore` routes; `seed`/`generate`/`issuepacks` intentionally unchanged (background jobs surfaced via `/status` and `/log`).
- The error-handling + frontend-hardening work is MERGED to `main` via PR #1 (merged 2026-05-28); branch `fix/qbo-client-error-handling` is complete.
- Git workflow (2026-05-29): unqualified commit/push requests stay on the current `main`/`master` checkout and push to the matching `origin/main` or `origin/master`; feature branches/worktrees require explicit current user instruction.
- Production is LIVE (2026-05-28): a REAL QBO Advanced Canada company is connected. `.env` is `QBO_ENVIRONMENT=production`; the OAuth callback used an ngrok reserved-domain tunnel to the local backend (port 3001) — frontend stayed on localhost:5173 with no code change. Tunnel only needed during connect/reconnect.
- Dashboard split (completed 2026-05-28, reviewed by both safety and implementation reviewers): Dashboard = read-only awareness; write actions live under `/lab` Lab Tools. Production guard `backend/src/middleware/productionGuard.js` gates `seed`/`generate`/`issuepacks` write routes unless production intent is confirmed. Follow-ups: AI plan-execution writes are not yet guarded; multicurrency remains planned but unbuilt.

Do not store secrets, raw QBO data, private customer details, or raw API responses in this memory.
