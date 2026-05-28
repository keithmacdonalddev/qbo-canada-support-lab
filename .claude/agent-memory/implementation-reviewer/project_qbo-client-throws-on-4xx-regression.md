---
name: qbo-client-throws-on-4xx-regression
description: As of commit 043bb30, qbo-client.apiCall THROWS on QBO 4xx/5xx instead of returning a Fault body. Callers use qbo-error.respondQboError to map to HTTP 502 (429 passthrough). Affects regression analysis of any QBO consumer.
metadata:
  type: project
---

Commit `043bb30` (branch fix/qbo-client-error-handling) changed `backend/src/modules/qbo-client.js` `apiCall()` so QBO HTTP errors now THROW instead of returning a Fault-body object.

**Pre-commit behavior:** because intuit-oauth validateStatus resolves 4xx (see [[intuit-oauth-422-error-shape]]), the old code returned `{ Fault: {...} }` to callers on 4xx. Callers that read `result.Invoice.Id`, `result.QueryResponse[type]`, etc. would get undefined → either a downstream TypeError (write helpers) or silently-empty results (queries).

**Post-commit behavior:** apiCall throws `Error("QBO API error (HTTP <status>): <Fault message>")` with `err.status` (number) and `err.intuit_tid` (when a tid header was present). `backend/src/modules/qbo-error.js` (`respondQboError`/`isQboError`) maps these: 429 → HTTP 429 passthrough, all other QBO statuses (incl QBO 401) → HTTP 502. QBO 401 is deliberately NOT surfaced as app 401 (frontend force-logs-out on any 401).

**Why:** intuit-oauth@4.2.2 made 4xx resolve, so the prior catch-based handling never fired and Fault bodies leaked to callers as fake "success". This was a real prior bug.

**How to apply:** No caller in backend/src inspects a returned `.Fault`/`.fault` (verified via grep). Callers using respondQboError: explore.js, company.js, checkpoint.js, and ai.js (via a local `sendQboErrorJson` clone that adds `success:false`). Other callers (generation-engine, issuepack-engine, ai-orchestrator, ai-tools, seed) wrap in `catch (err)` and record/return `err.message` — all benefit from the now-meaningful message. Residual gap: a 5xx WITHOUT an intuit_tid is not detected by isQboError (no numeric err.status set in the catch path, message doesn't match the regex) → falls through to generic HTTP 500 instead of 502.

**isQboError numeric-status heuristic is SAFE (verified 2026-05-28):** `isQboError` returns true if `typeof err.status === 'number'`, which looks like it could misclassify an app 400/404 as a 502. It does not — a repo-wide grep for `.status =`/`.statusCode =` assignments in backend/src shows the ONLY place a numeric `.status` is ever attached to an Error is qbo-client.js (lines 151, 185, 221, all on the QBO error path). Application/Mongoose/validation errors never carry a numeric `.status`, so they fall through to each route's existing 400/404/500 handling. ai.js routes' `res.status(err.status || 500)` fallback therefore always resolves to 500 for non-QBO errors (QBO ones are intercepted first). If future code starts attaching numeric `.status` to non-QBO errors, this invariant breaks and isQboError would start masking them as 502.
