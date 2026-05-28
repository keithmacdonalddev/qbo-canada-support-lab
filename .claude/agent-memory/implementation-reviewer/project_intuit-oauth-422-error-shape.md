---
name: intuit-oauth-422-error-shape
description: Verified runtime behavior of intuit-oauth@4.2.2 makeApiCall — which HTTP statuses resolve vs throw, and the shape of each. Load-bearing for reviewing backend/src/modules/qbo-client.js.
metadata:
  type: project
---

intuit-oauth@4.2.2 `makeApiCall()` behavior, verified from `node_modules/intuit-oauth/src/OAuthClient.js` + `AuthResponse.js` (2026-05-28).

The axios instance uses `validateStatus: status >= 200 && status < 500` (OAuthClient.js:66). Therefore:

- 2xx / 3xx / ALL 4xx (incl. 400/401/403/429): axios RESOLVES. `makeApiCall` returns a plain object `{ status, statusText, headers, json, body }` (OAuthClient.js:482-488). `headers` is the raw axios headers object (lowercased keys → `headers.intuit_tid`). NOT an AuthResponse instance, so `getJson()`/`getIntuitTid()` do NOT exist on it.
- 5xx (>=500) and network errors: axios REJECTS → `makeApiCall` THROWS an `OAuthError` (OAuthClient.js:558-649). `OAuthError` carries `.code` (string like '500'), `.intuitTid` (camelCase), `.message`, `.description` — but NO `.status`, NO `.statusCode`, NO `.authResponse`. `makeApiCall` internally retries 5xx/network up to maxRetries=3 with its own backoff before throwing.

**Why:** The commit `043bb30` comment in qbo-client.js claims "makeApiCall RESOLVES on HTTP error statuses (401/4xx/5xx/429) instead of throwing." That is only true for 4xx (incl 429). 5xx actually THROWS. The status-based 5xx branch (qbo-client.js: `status >= 400`) is therefore dead for real 500s; 5xx lands in the catch block instead, where status resolves to 'unknown' because the catch reads err.status/err.statusCode but OAuthError puts it in err.code.

**How to apply:** When reviewing qbo-client.js error handling, verify both the resolved-object path (4xx/429) AND the thrown-OAuthError path (5xx/network). Check that the catch block reads `err.code` (not just err.status/statusCode) if accurate 5xx status reporting matters, and that `_extractIntuitTid` falls back to `err.intuitTid` (camelCase). See [[qbo-client-throws-on-4xx-regression]].
