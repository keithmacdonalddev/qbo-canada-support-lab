# Current business compilation observations

Implemented 2026-10-06. createBusinessCompilationRuntime supplies the concrete loadCompilationEvidence adapter required by the dispatcher. It binds company connection, operation and plan, reloads the immutable creation intent, and compares it with the dispatch request. Extra dependency metadata remains retained in the step, while identities use the plan store's logicalKey/entity/fingerprint projection.

## Before sending

The adapter refreshes and persists the complete source graph, then captures the company writer revision. It reads unique approved master records and exact saved source transactions through the current scoped QBO client, with at most three provider workers. A source must have fresh saved graph proof, and the new full GET must match that proof's record hash and version. Every observation is tagged with the current operation and writer revision. Changed master definitions are rejected by the existing compiler.

The writer and actual actor/owner are checked again after observation. The complete compiler runs as a preflight, including independent retained tax expectations for item transactions. Missing tax expectations now prevent this runtime from proceeding to creation. The dispatcher recompiles these observations and retains its existing durable admission/no-replay boundaries. The adapter itself issues no QBO writes.

A three-minute overall observation budget covers graph refresh and reads. Cancellation discards incomplete evidence. As with existing readers, underlying SDK GETs are not forcibly aborted and may finish later. No late read can authorize a write through this adapter.

## Deposit availability

A Deposit requires a verified exact Payment, two complete matching unfiltered Deposit scans, and a final unchanged Payment read. Each scan uses fixed ordered queries, pages of up to 1,000 records and a 10,000-record/32-MB limit. Returned page positions/counts, record IDs/versions and complete recognized line structures are checked; duplicates, malformed lines, warning envelopes and partial results fail. Any deposit link naming the target payment prevents availability proof. No name, amount or date heuristic is used.

The resulting evidence describes current observed absence of a deposit link. It is not an atomic QBO snapshot or a guarantee against later external edits. Company writer fencing detects participating app writes during observation; a live acceptance pass must still establish supported Canadian response shapes and behavior. Exceeding the scan budget remains visibly unverified rather than silently accepting a partial set.

Official references inspected: Intuit's [Deposit collection](https://www.postman.com/intuit-developer/intuit-developer-quickbooks-online-accounting-api/folder/4884662-ea187ea3-b1b9-48bb-92d4-7c90fb5d09de) documents customer-payment links on deposit lines; its [API limits](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html) document the 1,000-entity query page limit. These references support the API structure, not Canadian live acceptance or the sufficiency of this app's independent tax policy.

## Evidence and remaining work

The initial runtime/verifier/compiler set passes 67 tests. After review corrections, the runtime/plan-store/dispatch set passes 55 tests (overlapping sets). The dispatch fixture now uses both concrete compilation and verification runtimes through the original QBOClient and actual step-store graph persistence. A changed saved amount clears verification without duplicate creation. Backend syntax covers 109 files; required implementation and safety reviews are clear after fixing malformed deposit lines and dependency metadata handling.

These are isolated model/provider fixtures. No live company request, storage preparation, service startup/restart, commit or push occurred. Production operation composition, the durable runner, storage/owner setup, independently prepared tax policy, approved baseline/blueprint and full live business/report outcomes remain unfinished.
