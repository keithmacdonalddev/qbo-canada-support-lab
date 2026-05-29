---
name: feedback-401-passthrough
description: Frontend force-logs-out on ANY 401 — QBO-side 401 must never be surfaced as an app-level 401
metadata:
  type: feedback
---

Routes must NOT surface a QBO upstream 401 as an app-level 401.

**Why:** The frontend (`frontend/src/api/client.js`) treats any HTTP 401 as session expiry and force-logs-out the user. If a QBO token expiry (upstream 401) leaks through as an app 401, the user gets kicked out of the app for an unrelated QBO-side condition. This is a known footgun in this repo.

**How to apply:** Any route that calls QBO must wrap upstream errors with `respondQboError` (from `backend/src/modules/qbo-error.js`), which maps QBO errors to HTTP 502 (with 429 passthrough) carrying `{ error, intuit_tid, qboStatus }`. When reviewing a new/changed route that touches QBO, confirm it uses `isQboError`/`respondQboError` rather than letting a raw upstream status propagate. Relates to [[project-production-guard]].
