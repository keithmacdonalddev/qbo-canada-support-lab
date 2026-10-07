# Durable business operation runner

Implemented 2026-10-06. Internal composition only; no startup, route, scheduler or live storage activation.

## Execution and recovery

The runner consumes an exact approved saved operation. It reserves the scoped business calendar and company writer, acquires one ten-minute worker lease, and reads retained intent in pages of at most 50 activities. Creation flows through the existing dispatcher and common QBO write gate. Existing activities are freshly verified rather than recreated. Each saved ordinal advances only after current persisted graph evidence matches the exact plan entry.

Run progress and leases are audited transactional state, not in-memory completion flags. Replacing an expired worker invalidates its claim, dispatch-marker, POST-admission, progress and period-completion authority. Receipt recovery remains possible without granting another creation request. An unresolved transport outcome blocks subsequent work. Cancellation never races or truncates a possibly-sent POST; the runner attempts exact receipt settlement before releasing its worker. A stop is reported only when the company stop request is present and its outstanding request is settled.

At the end of the record plan, including an empty plan, the runner enters evidence collection. Missing or failed evidence does not recreate records on retry. The period store independently checks the entire record set and named report requirements before advancing the business date. A lost completion acknowledgement repairs the durable calendar receipt. A historical completed operation remains readable after later periods advance.

## Interfaces

- business-run-state supplies scoped inspect, claim, renew, advance and release. It requires concrete current authority, storage readiness, transactional stores and an audit writer.
- business-operation-runner composes saved plans, dispatch, graph verification, period storage and prepareEvidence. The evidence collector must persist a current frozen candidate bound to the exact operation and lease.
- Step claim and beginDispatch accept optional runLeaseToken; a leased operation requires its exact current token. Unleased legacy internal callers remain compatible.
- Period finish accepts optional leaseToken and checks current ownership both before preparation and inside the commit transaction.

## Verification limits

Focused fixtures exercise real run-state, period and writer stores with serialized in-memory transactions. Dispatcher fixtures compose the real step/compiler/writer/client/admission/receipt code with a stubbed provider. These prove module contracts and recovery branches, not Mongo transaction behavior, Canadian provider acceptance, report collector wiring or real business completeness. No live QBO requests, database setup or service restarts were performed for this change.

A concrete internal report collector and append-only evidence store are now implemented; see business-period-evidence.md. Production runtime composition, explicit storage readiness, approved company blueprint/baseline/tax policy, activation and direct records/report evidence remain open. The product completion ledger remains authoritative about those missing outcomes.
