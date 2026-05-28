---
paths:
  - "backend/**"
---

# Backend Rules

- Use CommonJS (`require` and `module.exports`) unless a file already uses another pattern.
- Express routes live in `backend/src/routes/`; shared logic belongs in `backend/src/modules/`.
- Mongoose models live in `backend/src/models/`.
- Preserve the existing response style in the file being edited. This repo currently has both `{ success: true, data }` and other route-local patterns; avoid broad response-shape refactors unless requested.
- Do not bypass `authenticate` on protected routes.
- For QBO upstream failures, use `respondQboError` from `backend/src/modules/qbo-error.js` (maps to HTTP 502, 429 passthrough). Never return a QBO-side 401 as an app-level 401 — the frontend treats any 401 as session expiry and force-logs-out the user.
- Do not log tokens, API keys, raw Authorization headers, user-stored AI keys, or QBO OAuth payloads.
- Treat `backend/src/server.js` startup as side-effecting because it connects to MongoDB, seeds issue packs, and recovers stale jobs/plans.
- Do not run backend dev/start commands unless explicitly asked.
- For verification, prefer `node --check` on touched files; broaden to all `backend/src/**/*.js` when shared modules or route loading changed.
