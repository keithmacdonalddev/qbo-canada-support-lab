# Claude Project Memory

This memory is for Claude Code sessions in `C:\Projects\qbo`.

Stable facts:

- The app is the QBO Canada Support Lab.
- Root shared guidance is `AGENTS.md`; Claude-specific guidance is `CLAUDE.md`.
- Do not start services or run QBO mutation scripts without explicit current user approval.
- Do not print `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, or AI API keys.
- Use `.claude/agents/qbo-safety-reviewer.md` for QBO, OAuth, AI execution, key handling, and MongoDB mutation risk.

Durable decisions (2026-05-28):

- QBO error handling is status-based: `backend/src/modules/qbo-client.js` `apiCall()` throws errors carrying `err.status`/`err.intuit_tid` and retries 429 with clamped backoff; `backend/src/modules/qbo-error.js` (`respondQboError`) maps QBO upstream errors to HTTP 502 (429 passthrough). A QBO-side 401 must NEVER be returned to the client as an app-level 401 — the frontend force-logs-out on any 401. Wired into `ai`/`checkpoint`/`company`/`explore` routes; `seed`/`generate`/`issuepacks` intentionally unchanged (background jobs surfaced via `/status` and `/log`).
- Branch `fix/qbo-client-error-handling` holds the error-handling + frontend-hardening work (4 commits), NOT yet merged to main and NOT pushed. Pending: production wiring (tunnel + redirect URI + `.env` flip from `QBO_ENVIRONMENT=sandbox`) and planned-but-unbuilt multicurrency support (foreign-currency accounts, revaluation, balance-sheet FX). Intuit production access is unlocked but no real company is connected yet.

Do not store secrets, raw QBO data, private customer details, or raw API responses in this memory.
