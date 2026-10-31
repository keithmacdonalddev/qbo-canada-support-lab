# Job E — QuickBooks call economy, 2026-10-31

Status: reviewed offline implementation; live savings and the <=3 metered calls/record target remain unverified. No commits, QBO calls, explicit database record mutations, or service commands were issued. The metadata-initialization limitation below qualifies the database boundary. Backend source was prepared in an ignored overlay before a single final write batch. Shared tools receive only two locked budget predicates.

## Evidence and attribution

The stored Oct 31 meter row e9f1bf50791312987ac275ea0a8a3358ec80338755ad472a had 7,458 non-sync metered requests (6,173 reads + 781 queries + 504 reports), 2,306 sync requests and 89 write requests. Against the supplied 85 saved records this is **87.74 metered calls/record**. Of these, 4,807 lacked caller labels: 4,393 reads, 413 queries, one report. Historical counts contain no stack information, so an exact retrospective allocation is impossible.

A private read-only Mongo snapshot captured at 2026-10-31T22:41:33.839Z was replayed through the actual business-governance-service.activityOptions path, with the same stored authority, audits, plans, intents, saved steps, and synchronized records. Both old and candidate provider clients were simulated locally; no QBO transport was possible. Frozen replay time preserved list-reader deadlines. Before: **110 GETs + 7 list queries**. After: **zero provider requests**, with identical 40 customers, four services, three suppliers, 15 correction candidates, eight open invoices, eight quotes and three purchase orders. Stale Invoice sync is explicitly surfaced without changing calendar readiness or causing a live fallback.

Example stored identities exercised: Estimate 11081 / operation 875b744e7300ab5ebe8d362e, Estimate 11096 / operation 3359607d8aee4df04a3d88da, Payment 11089 / operation b2cbf83dd9a354dcee95e6d4. Completed general credit-application run ba3d4261cce89ad1b76681c1 qualifies for the exact-settlement reserve lane.

Previously unlabelled source paths include:

| Source | Work |
| --- | --- |
| business-governance-service.activityOptions | PO receiving, correction candidates, their collected payments, own terms invoices/bills and quotes; repeated on every choices request |
| coverage.readSource | Account, TaxCode, Preferences and Customer/Vendor/Item/Employee lists used for setup and master choices |
| business-country / business-dated-tax | CompanyInfo and dated tax definitions |
| qbo-write-gate.preflight | Independent shared Item type reads after resource claim |
| general-write-transport.preflight | Preferences and memoized protected-period/linked-record reads |
| business-agent-tools read fallback | Tools whose synchronized source is unavailable |

QBOClient now captures a caller before its first await. Existing explicit purpose tags win; otherwise a fixed allowlist maps the first source module/route frame to a source-* label. Every attempt and successful response uses that same label; qbo-direct covers external/test callers. Unknown stack text, endpoints, queries, record data and absolute paths are never persisted. Old untagged counts remain historical. The complete source label map is in qbo-request-meter.js.

## Behavior and limits

Activity choices use bounded, generation-matched synchronized snapshots and remain provisional. They expose completion times, unavailable entity types and missing-record counts. The selected original, party, tax, ownership, period, balance and graph are still rechecked by preparation, compilation, dispatch and verification. No verification observation, read contract, report bracket or receipt is replaced.

The 10,000 non-sync daily guard and 450,000 monthly guard still hold new discretionary work. Transport, sync, verification, closes and already-admitted recovery have no new global stop. A narrow reserve lane also permits general Payment/BillPayment applications to existing numeric obligations, and deposits of existing payments or payments created in the same settlement-only batch. Positive exact cents, one link per line, a genuine debt application and exact debt-minus-credit totals are required. New sales/expenses, overpayments, unapplied funding, malformed amounts and mixed discretionary batches remain budgeted. Ordinary governed write checks still run.

No batch-query substitution was made for exact transaction GETs: Intuit's batch read operation is a query, and the saved freshness contract requires exact current entity observations. Official reference: [Intuit batch tutorial](https://github.com/IntuitDeveloper/SampleApp-Batch-Java/blob/main/docs/batch-tutorial.md).

Cost estimate: each choices request now saves the replayed **117 calls** (the number grows with eligible history). If the old day had 30–40 similarly shaped requests, the implied day-wide average falls from 87.74 to roughly **46.45–32.68 calls/record**; this is a scenario, not measured historical attribution or a live after result. Eliminating all historical untagged traffic would still leave 31.19 calls/record. **This patch does not prove the <=3 target.** The unchanged single-operation freshness fixture still measures 45 transaction GETs for a five-record settled-sale chain; retaining correctness constrains further optimization.

## Verification

- Stored full activityOptions replay: identical choices, 117 -> 0 provider calls; stale source surfaced; completed credit-application reserve classification confirmed.
- Focused six-file node --test run: 89 passed, zero failed, two pre-existing skipped tests (superseded by 50868c8). Includes every one of the eight business-operation-freshness chains and new actual general-tool budget admission/transport-tag tests.
- Candidate Node syntax checks: all six changed backend JS modules passed.
- Independent implementation and safety reviews: no remaining findings after fixing fixture injection, advisory readiness and overpayment reserve classification.
- Broader historical workflow checks and final current-source results are recorded in the closeout below. Earlier broad invocations timed out; they are not passes. Their primary processes were terminated by the command timeout; descendant cleanup could not be independently inventoried because Windows CIM access was denied. Subsequent long checks use tracked, single-process test isolation.

Commands run from backend (simulated SDK only; stock fixture files require their production-shaped scope, other files use sandbox-shaped scope):

~~~text
node --require ../artifacts/job-e-call-economy/test-sandbox.cjs --require ../artifacts/job-e-call-economy/preload.cjs --test --test-reporter=spec test/business-activity-choice-economy.test.js test/qbo-request-meter.test.js test/business-agent-cadence.test.js test/business-agent-tools.test.js test/business-request-economy.test.js test/business-operation-freshness.test.js
~~~

The overlay path above is local to this job; after apply the same files run without preload.cjs. Private raw replay inputs and logs stay ignored under artifacts/job-e-call-economy. No secret-bearing Connection fields were captured.

## Work-value record

- 22:35Z: essential daily-cap work; proof is stored-data replay plus freshness and budget tests; next milestone attribute and remove advisory scans.
- 22:41Z: captured bounded read-only input. Exact historical untagged ownership is unrecoverable; instrument future calls instead of guessing.
- Stored replay milestone: 117 calls removed from one complete choices request, identical results. Preserve exact GET verification; do not expand into a new batching transport.
- Broad workflow timeouts: stop repeated broad attempts without a new cause; use focused source-path proof and retain any unresolved verification limitation. No dataset writes were authorized, so record delivery is outside this job.

## Final closeout — 2026-10-31T22:57Z

- Applied the six backend source modules together at 22:56:40.013Z, after replay, focused tests and both reviews. Seven per-file locks (including the shared tools and test helper) were acquired, originals re-read, and all locks released. business-agent-tools.js has only two added budget predicates; management review and blockers/attention source were untouched.
- Replayed actual saved source without the overlay: 117 -> 0 calls, identical choices, stale-source status correct; exit 0. The private replay uses a frozen original governance module as its before baseline.
- Actual-source core tests: 89 passed, zero failed, two inherited skips; exit 0. All eight freshness chains passed. New tests exercise the actual general tool at the cap, reserve misuse/overpayments, transport caller tags, mirror generation/staleness/cancellation, and existing master/setup reader contracts.
- Additional completed candidate-overlay workflow files: lifecycle-v8 3/3; order-stock 1/1; receiving 2/2. **95 passing tests total**, plus two inherited skips. The stock helper uses production-shaped fake scope: initial sandbox-preloaded stock attempts failed the client-scope guard, then the correct production-shaped simulated fixture passed. No live SDK transport was used.
- business-activity-batch-lists.test.js and business-correction-flow.test.js each exceeded the tracked 180-second file allowance and were terminated; no result is claimed. Stop-loss decision: retain their incomplete status rather than continue broad historical runs after the direct replay and affected freshness/budget checks passed. Tracked later test processes all reached close events; no persistent service was controlled. Earlier multi-process timeout descendant cleanup remains independently unverified because CIM inventory was denied.
- Current full backend syntax check: 299 files, zero failures; exit 0. Final owned diff/whitespace and current file identity checks are recorded below.
- All changes remain local, as requested. Concurrent general-write, close-checklist, billable-link, situation-coverage and frontend edits belong to other jobs and were preserved.

Owned files:

- backend/src/modules/business-activity-choice-client.js (new)
- backend/src/modules/business-governance-service.js
- backend/src/modules/business-request-budget.js (new)
- backend/src/modules/business-agent-tools.js (two locked predicates)
- backend/src/modules/qbo-client.js
- backend/src/modules/qbo-request-meter.js
- backend/test/business-activity-choice-economy.test.js (new)
- backend/test/helpers/business-governance-fixture.js (explicit advisory-client test adapter)
- docs/plans/request-economy-job-e-2026-10-31.md (this evidence)

Final current-source core command, from backend:

~~~text
node --require ../artifacts/job-e-call-economy/test-sandbox.cjs --test --test-reporter=spec test/business-activity-choice-economy.test.js test/qbo-request-meter.test.js test/business-agent-cadence.test.js test/business-agent-tools.test.js test/business-request-economy.test.js test/business-operation-freshness.test.js
~~~

The sandbox preload changes only the isolated test process's configuration to match those fixtures; reading the authorized Mongo snapshot had loaded production configuration into the parent environment. The stock tests instead used test-production.cjs plus offline-only.cjs, with --test-isolation=none and their in-memory SDKs. Logs and command evidence remain under the ignored job artifact directory.

- Final identity check: all seven applied candidate files matched the reviewed overlay byte-for-byte. Owned tracked git diff --check passed. Trailing whitespace in the new test was removed; the subsequent owned whitespace scan passed. No source was saved after the one final batch.

## Mongo metadata initialization limitation

At final closeout the snapshot parent was disconnected (readyState 0), but Mongoose autoIndex and autoCreate were both true. The legacy User, Connection, CompanyMembership and AuditLog schemas do not disable those defaults. These models were registered while obtaining read-only snapshot evidence without passing autoIndex:false/autoCreate:false on the connection. No insert/update/delete/save or other record-mutation command was issued by this job, but collection/index initialization commands may have been attempted implicitly. Their absence was not proved. This was a verification-boundary mistake; do not treat the snapshot procedure as proof of zero Mongo metadata writes. No cleanup or schema rollback was attempted.
