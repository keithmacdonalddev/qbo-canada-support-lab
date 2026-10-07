# Business activity preview

Implemented 2026-10-06. Read-only proposed scheduling, not execution or an activated blueprint.

## Current workflow

Company → Business plan → Preview business activity uses the latest saved draft, or the approved-direction business proposal when no draft exists. Unsaved form edits are explicitly excluded. The period defaults to the current Halifax month through the current business date. POST /api/company/business-plan/activity-preview accepts only loaded connection ID, saved content hash (or null), from date and through date; it reads the blueprint under blueprint.read. It performs no QBO call, storage write or authorization change.

The version-1 activity template proposes three recurring cohorts: service jobs (estimate, time, invoice, payment, deposit); stock orders (purchase order, bill, sale, bill payment); and care plans (invoice, payment). It uses 8/5/5 cohorts for Development and 30/15/25 for Flagship, producing nominal 70/260 records per full recurring cycle, matching the approved planning targets. These exact pattern allocations are newly proposed, not owner-approved accounting policies. Month lengths, opening periods and follow-up offsets can change the actual count within an individual month. Existing cohort identities and dates do not shift when the volume increases.

The existing deterministic planner supplies company/environment-scoped stable identities, dependency chains, bounded periods of at most 367 days, at most 10,000 total events and bounded response size. The response retains prior-period prerequisites and future follow-ups. A new or reconnected company or changed draft hash rejects a stale request. Frontend requests are cancelled when dates or loaded company/plan change, and response scope is checked before showing it. Record rows are paged in groups of 50.

## Limits before execution

Every result carries executable=false, calendarVerified=false and baselineCompared=false. Counts describe scheduled records, not a claim that those records are absent from QBO. This template does not supply actual party/item/account bindings, amounts, quantities, approved tax treatment, inventory availability or real cash movement. Its dependency graph is business intent, not necessarily a QBO transaction-link payload.

Credits, returns, late/partial payments, retainers, close entries, reconciliation and remaining capability/report requirements still need reviewed rules. Activation must freeze the reviewed rules and their source version into a durable blueprint; this preview does not silently change saved draft history or activate a calendar. Comparing existing records, compiling allowed writes, durable execution and direct report verification remain unmet.

## Evidence

Forty-three activity/calendar/draft tests passed; the focused activity/draft set passed again (25 tests) after the date-error wording improvement. Source implementation and safety reviews were clear. Backend syntax, frontend build/lint and diff checks passed with existing warnings. In the connected Production app, the October 1–6 preview returned 55 scheduled records, 78 later follow-ups and 81 prior prerequisites; these are calculated proposal counts, not observations of company transactions. The desktop date list and second page were exercised. An inverted range was rejected, and valid dates restored the preview. No QBO record or app database record was changed by this preview.
