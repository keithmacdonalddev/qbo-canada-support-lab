# Deterministic business calendar

Implemented 2026-10-06 as a pure planning foundation, not a runnable business operation. Module: backend/src/modules/business-calendar.js.

## Contract

A version-1 calendar definition supplies a stable business key, opening date and up to 200 activity rules. Each rule has a stable key, division, start/end, monthly or weekly cadence and up to 20 ordered steps. Each step declares its stable key, entity, offset of 0–365 days, dependencies and plain JSON business intent. Intents are not raw QBO payloads; tax, entity compatibility, prices and company mappings still need a separate validated compiler before execution.

Dates are explicit YYYY-MM-DD calendar dates between 1900 and 2200, calculated in UTC without time-of-day. Requested intervals include both endpoints, end no later than the supplied business date, and span at most 367 days. Monthly rules clamp to each month's last day without drifting the anchor. Weekly rules are anchored to their start date. A rule end stops new occurrences; it does not cancel obligations from earlier occurrences.

The planner looks back at most 365 days to include follow-up activity due in this interval. It returns current events, future obligations, and prior-period prerequisites. Their combined maximum is 10,000 with an 8 MB expanded-content budget; exceeding the budget fails the whole plan rather than silently truncating it. Planning a period in parts retains the same event identities and fingerprints as planning it at once.

Logical identity includes environment, realm, business key, rule key, occurrence date and step key. It excludes revision, request window, current date and array position. A separate fingerprint covers content and relationships. Changes to intent therefore conflict with a saved record instead of creating a second identity automatically. Canonical plan hashes detect changed saved plans. Revision comparisons for an identical company/business/period explicitly identify removed, added and changed activities, including renamed or moved rules.

## Recovery boundaries

Reconciliation accepts only a complete server-owned managed-record lookup that covers exactly all current, future and prerequisite keys. Duplicate or unrelated results fail. Different logical activities cannot claim the same physical entity/ID pair. A record is reusable only when its entity/fingerprint match and its state is verified with a saved QBO ID. Unknown, sending or changed records block. All prior dependency chains must have exact verified receipts. An existing child with a missing in-window parent blocks instead of reusing a payment while recreating its invoice. Dependency checks are memoized and fail closed on cycles.

These checks do not independently read QBO, prove absence of unmanaged records, establish a historical baseline, approve writes, validate a real tax treatment or certify a business period. Every result explicitly has executable=false and calendarVerified=false. The calling execution service must not treat create/reuse actions as authorization.

## Remaining integration

- Immutable activated blueprint with exact company mappings and source fingerprints.
- Stable rule lineage and revision comparison over affected historical/future periods before activation. The comparison helper alone does not prevent renaming rules.
- Durable company-scoped managed-record ledger and full interval discovery; a keys-only lookup cannot discover removed historical activity.
- Closed-period, authority, source freshness, provenance and operation-budget checks.
- Persisted bounded previews, durable write receipts, stop/resume and uncertain-write recovery.
- Verified saved records plus exact-period report assertions before a compare-and-set update of the business cursor.
- Lifecycle-specific intent validation/compilation and the rest of the required activity catalog.

## Evidence

Eighteen focused calendar tests pass, covering repeatability, partition independence, leap/month ends, weekly anchors, future obligations, revision changes/removals, company isolation, budgets, prior dependency chains and interrupted-state conflicts. Combined with report tests, 31 tests pass; syntax and diff checks pass. Independent implementation review found no remaining blockers after recovery corrections. No app route or live company mutation was added; this module is not yet exposed as a user workflow.
