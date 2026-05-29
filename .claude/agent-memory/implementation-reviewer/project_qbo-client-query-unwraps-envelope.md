---
name: qbo-client-query-returns-full-body
description: qbo-client.query() returns the FULL QBO JSON body WITH the QueryResponse envelope intact (not unwrapped). Every caller correctly reads result.QueryResponse.X (e.g. r.QueryResponse.totalCount, r.QueryResponse.Customer). This is the established, consistent convention.
metadata:
  type: project
---

RESOLVED 2026-05-28 by reading the full method chain (supersedes an earlier draft that wrongly guessed query() unwraps the envelope).

`backend/src/modules/qbo-client.js`:
- `query(queryStr)` (line 338) → `return this.apiCall('GET', 'query?query=...')`.
- `apiCall()` on 2xx returns `parsed` (line 268), where `parsed = response.getJson() || response.json || JSON.parse(response.body)` — i.e. the **entire** QBO JSON response body, including the top-level `QueryResponse` envelope. It is NOT unwrapped.

**Correct caller pattern (used everywhere, all working):** `const r = await qbo.query(...); r.QueryResponse?.Customer`, `r.QueryResponse?.totalCount`, `r.QueryResponse?.Account?.[0]`.
Confirmed at: explore.js:56, seed.js:70 & 98, company.js:68/74/225, issuepacks.js:30-34, ai-tools.js:361/403/454, issuepack-engine.js:132, generation-engine.js, checkpoint.js.

**How to apply:** When reviewing a new `qbo.query()` caller, `result.QueryResponse?.X` is CORRECT, not a bug. The opposite (reading `result.X` directly) would be the bug. `SELECT COUNT(*)` returns the count at `QueryResponse.totalCount`, so `company.js` `countOf()` reading `r.QueryResponse?.totalCount ?? null` is correct.
