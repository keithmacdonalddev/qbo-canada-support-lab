# Related business-record verification

2026-10-06. Internal read-only integration; not a deployed runner or live verification claim.

## Complete chains

business-graph-readback.js connects retained compilation, creation receipts and exact current observations across related managed activities. It loads both originating activities and known saved downstream activities from OperationStep, including related prior operations. Dispatched/unknown dependants block verification; a foreign connection, changed intent, missing parent or unknown provider backlink cannot be silently omitted. Dependencies must be acyclic. The graph can start from one to one hundred distinct roots and contain at most one thousand related records.

The first pass verifies downstream content in reverse dependency order. The second closes parent relationships in forward order using the same observations. This handles invoice/time and payment/balance changes without circular waits. Financial mismatches propagate through the affected chain; no completion is inferred from a successful provider read. Results explicitly say persisted:false. The step store now uses preparation and read modes to invalidate and persist the complete graph transactionally. Period evidence and the running business worker remain separate integration tasks.

## Read loader and limits

The loader uses explicitly supplied, company-scoped model, transaction, authority, writer-fence, QBO-read and tax-policy adapters. It has no server defaults, public routes or write capability. It checks read authority and the company writer before and after provider reads; changed activity or an unresolved writer discards the result.

Stored records stream through a projected cursor with batch size one and a ten-second query limit. Each cursor is closed; cleanup has a five-second bound. Retained serialized artifacts/evidence have a 32MB budget, checked as records arrive. This is a serialized evidence budget, not a claim about exact JavaScript heap usage. Provider adapters must also bound their individual network response size and honor AbortSignal.

At most three workers read QBO records. The full read operation has a three-minute deadline, covering readiness, permission, writer, storage, record and tax reads. Caller cancellation and elapsed deadlines produce distinct errors. Cancellation/deadline checks after final awaits and reconciliation prevent a late success. The outer budget cannot guarantee that an adapter which ignores cancellation has stopped its own I/O; real adapter/cursor behavior still requires integration evidence.

OperationStep declares an index on company scope, dependency logical key and state for incoming-link discovery. No index or collection was created in the live database.

## Evidence

63 focused graph/read-back/step tests passed across the suite and graph correction rerun; backend syntax passed for 100 files. Full sales (estimate, time, invoice, payment, deposit) and purchase (PO, bill, stock sale, bill payment) fixture chains pass with updated record versions. Tests cover missing or unresolved neighbours, foreign connections, financial drift, unknown links, worker bounds, cancellation during cursor/final-fence reads, timeout classification, failed-provider cleanup and oversized responses. Independent implementation and safety source reviews are clear.

No live QBO calls, database preparation, service restarts or route activation were performed. Real provider acceptance, transaction isolation, cursor cancellation, approved tax adapters, atomic proof persistence, operation runner integration and complete business/report outcomes remain unverified or incomplete.

## Atomic persistence — 2026-10-06

The graph reader has a metadata-only preparation mode, which validates the connected storage graph without provider reads. Its exact roots, record revisions, compilation identities and writer revision are hashed into a manifest. Read mode can require a precise post-invalidation writer snapshot before reading any provider records.

The step store verifyGraph path requires explicit graph reader and transactional writer-snapshot adapters. It authorizes the exact current-operation intents, clears reusable proof for every prepared member in one audited/fenced transaction, reads QuickBooks outside transactions, and commits all completed proof in dependency order in another audited/fenced transaction. Missing evidence, permission changes, changed records/writer, cancellation, wrong proof kinds or parent versions fail without partial graph passes. A failed provider read leaves the entire prepared chain unverified. Original creation receipts and historical ownership stay unchanged.

Every proof is checked again after the final database work and after commit acknowledgement. A lost acknowledgement may leave a complete committed graph, but retry only reads/re-verifies saved records and cannot create duplicates. The graph evidence hash is retained on each saved verification. This is not a business-period completion receipt.

The integrated graph/read-back/step/writer/period set passes 115 tests and the 100-file backend syntax check. Independent reviews are clear. The thousand-record cap is a safety ceiling, not a measured MongoDB capacity promise: per-record audit/fence calls must fit the existing transaction timeout. Real transaction performance, provider adapters, durable operation plans and the runner remain unverified or incomplete.
