# Durable business-step receipts

Implemented 2026-10-06 as an internal storage boundary. No route, startup import, collection creation, real adapter or QBO dispatch was added. This supplies execution-state rules for the future business runner; it does not make the prepared operation executable.

## State and identity

OperationStep is unique by company environment, realm and logical activity key. Original connection, operation, plan, entity, intent fingerprint and exact dependency fingerprints are immutable. A second unique index prevents distinct activities from recording the same scoped physical entity/ID. Database readiness must prove both indexes and transaction support; model declarations are not deployment proof.

Claimed work can be reclaimed only before dispatch, after an expired valid lease, with a new worker token and revision. The maximum is 20 attempts. Dispatched means possibly sent, including a crash immediately before the external request. Neither time, a missing search result nor a lost commit response ever restores creation eligibility. Unknown retains the same dispatch evidence and writer barrier. Saved records have a request-correlated creation receipt; verified records additionally have fresh read-back evidence of expected content and relationships.

Cross-operation reuse never transfers ownership or clears history. A later operation may inspect and refresh an identical prior intent, but cannot claim or dispatch it. Changed fingerprints, scope, entity or dependencies conflict. Unrecorded means no managed receipt was found; it does not prove the real company lacks that business activity.

## Required adapters

The store has no default authority, persistence, evidence or global-writer adapters. Every mutation requires current permission and transaction readiness. The fence adapter must WRITE the exact operation/calendar/global-writer revision in the same Mongo transaction as the step transition and audit. A read-only preflight or an expiring worker lease is not sufficient. The dispatch fence must retain a durable unresolved-write barrier until a saved outcome is established. Stop may prevent new dispatch while still allowing an already-sent outcome to be recorded.

The trusted manifest loader supplies immutable approved intent; the dispatch fence must bind the request hash to validated compiled payload and approved plan. This module does not compile or validate QBO payloads. The audit adapter writes an idempotent event in the supplied transaction. Transaction callbacks must not call QBO, providers or external audit services, because the driver may retry them.

After a committed dispatch marker, an external runner may send once. If that commit response is ambiguous, it must recover the marker and outcome rather than send again. A successful external response followed by a failed database/audit save leaves the dispatch barrier intact. Late stale-worker responses use the recovery path instead of overwriting newer revisions. Recovery requires trusted request-correlated saved-record evidence; matching names, dates or amounts is insufficient. If no reliable correlation exists, work remains unresolved. The dispatch key is an internal correlation identity, not a claim of provider idempotency support.

Proof adapters receive an explicit bounded metadata projection with BSON connection/operation IDs normalized to strings. Raw request payloads, unrelated document properties and provider errors are not copied. Evidence hashes reference trusted retained evidence; hashes alone do not prove an observation took place.

## Read-back and dependencies

Starting any read-back transactionally clears previous reusable verification while preserving the creation receipt. A mismatch, network failure or crash cannot leave an old pass eligible for new work. Successful proof must match company, logical intent, physical ID, canonical version and saved relationships, with a five-minute freshness limit.

Dependent dispatch and evidence freshness check the full saved prerequisite chain, bounded to 1,000 identities. Each parent must match its expected entity/fingerprint and exact physical relationship versions; stale evidence, cycles and inconsistent ancestor references fail closed. A later operation can refresh older prerequisites under its current fence without changing the original operation, plan or receipt.

The eventual period evidence set must include the transitive prior-period parents referenced by current records. The existing period-store contract requires referenced parents inside that frozen record set; it cannot be satisfied by supplying only newly created records. This step store does not advance a business cursor.

## Verification and remaining integration

Twenty-one isolated step tests cover competing claims, pre-dispatch expiry, stale-worker rejection, stop behavior, ambiguous commits, audit rollback, unknown recovery, duplicate physical IDs, exact dependencies, invalid read-back, transitive invalidation, later-operation refresh and actual BSON ID projection. Combined with period-store and operation-preview tests, 47 tests pass; backend syntax passes 91 files. Both independent reviewers cleared the corrections after the mixed-revision evidence response was fixed. Read-only evidence uses one snapshot session and returns the exact root validated with its dependencies. These are in-memory transaction fixtures, not proof of real MongoDB isolation or actual QBO recovery.

Still required: immutable operation/intent storage, real readiness/authority/audit/fence adapters, coordination with all other company writers, compiled QBO tool payloads, retained provenance/read-back evidence, bounded runner and recovery routes, desktop progress/stop/resume, deployment setup, and authorized company verification. Blueprint activation and baseline adoption remain separate prerequisites.

## Concrete writer adapter update — 2026-10-06

The required fence now receives the exact step revision/token and normalized receipt. business-writer-fence.md describes the concrete transactional adapter and its closed default integration gate. Each step transition invalidates any previous period-completion candidate; failed settlement preserves the company barrier. The current combined writer/step/period suite passes 60 tests. This does not yet connect the shared QBO transport or authorize live operation.

Compiler integration (2026-10-06): dispatch now requires exact compiled intent/request evidence bound to the operation writer revision and a fresh observation timestamp. The writer transition compares that revision; transport rechecks the resulting revision and evidence freshness. See business-transaction-compiler.md. This does not open the activation gate.

## Retained compilation and completed proof — 2026-10-06

Dispatch now snapshots only the defined compiled-artifact fields, validates its complete hash, exact scope/request/intent/evidence and saved dependency IDs/versions, and stores it in OperationStep.compilation in the same transaction as the marker and audit. The artifact has an 8.5MB serialized storage bound. No raw observations or unrelated caller context are retained. A scoped authorized internal compilation read validates the original dispatch and returns a defensive projection; later operations cannot adopt ownership or regenerate the original instructions.

Read-back and dependency reads require the business-readback proof kind and exact dispatched compilation hash. Content-only observations cannot mark a step verified. See business-readback.md for exact financial, tax and lifecycle verification and proof-ordering rules.

The focused five-suite set passes 109 tests; a subsequent 26-test step-store rerun verifies the field-projection correction. Required implementation and safety reviews are clear. No real storage preparation or live writes were performed; runtime orchestration and real database/provider acceptance remain open.

## Atomic related-record refresh — 2026-10-06

verifyGraph connects explicit metadata preparation, current company-writer snapshots and exact current-operation intents to whole-chain verification. Preparation is followed by one transaction clearing all old proof, a bounded external read, and one transaction saving the full parent-ordered proof and audit set. Every stored row retains original operation/plan/creation ownership. Writer/row changes and failed reads or audits cannot leave a partial graph reported as verified. Proof freshness is checked at the end of the transaction and after acknowledgement. See business-graph-readback.md.

The five-suite integrated set passes 115 tests; required source reviews are clear. No live MongoDB writes or provider requests were performed. The method has no default execution adapters or new route, and practical graph size/performance still needs deployment evidence.


Operation-plan integration (2026-10-06): see [business-operation-plan-store.md](business-operation-plan-store.md). Original scoped intents are now retained separately. Step creation requires explicit create disposition; earlier-record intents cannot authorize recreation. Reservation, writer fencing and coordinated business transport require the exact durable plan approval. Runtime activation and storage deployment remain closed/unperformed.


Dispatch integration (2026-10-06): [business-dispatch.md](business-dispatch.md) connects the internal claim/marker/recovery interfaces to exact compiled QBOClient requests. The receipt reader requires original persisted transport and audit correlation; graph reconciliation runs on every settled resume. Runtime adapters, activated setup and actual company verification remain incomplete.
