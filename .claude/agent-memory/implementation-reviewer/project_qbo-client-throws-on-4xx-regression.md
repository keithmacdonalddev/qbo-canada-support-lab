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

**How to apply:** No caller in backend/src inspects a returned `.Fault`/`.fault` (verified via grep). Callers using respondQboError: explore.js, company.js. Other callers (generation-engine, issuepack-engine, ai-orchestrator, ai-tools, seed, checkpoint) wrap in `catch (err)` and record/return `err.message` — all benefit from the now-meaningful message. Residual gap: a 5xx WITHOUT an intuit_tid is not detected by isQboError (no numeric err.status set in the catch path, message doesn't match the regex) → falls through to generic HTTP 500 instead of 502.
