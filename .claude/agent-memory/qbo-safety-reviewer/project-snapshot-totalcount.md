---
name: project-snapshot-totalcount
description: company/snapshot reads QueryResponse.totalCount from QBO COUNT(*) queries — verify the field name against live QBO
metadata:
  type: project
---

`GET /company/snapshot` in `backend/src/routes/company.js` issues `SELECT COUNT(*) FROM <Entity>` QBO queries via a `countOf(qbo, q)` helper that returns `r.QueryResponse?.totalCount ?? null`.

**Why:** This is the read-only "Live Snapshot" on the new awareness Dashboard. It is strictly read-only (COUNT queries, no create/update), per-query isolated (one failure yields null, not a whole-request failure), and routed through `respondQboError` so a QBO upstream 401 maps to 502 rather than force-logging-out the user.

**How to apply:** The QBO v3 query API returns the count for `COUNT(*)` at `QueryResponse.totalCount`. This is correct for QBO's documented shape, but if snapshot cards ever render as all em-dashes ("—") against a live company despite a healthy connection, suspect the `totalCount` field path / response shape first (the `?? null` swallows mismatches silently). Not a safety blocker — worst case is a cosmetic null. Relates to [[feedback-401-passthrough]] and [[project-production-guard]].
