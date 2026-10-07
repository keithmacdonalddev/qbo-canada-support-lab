# Transactional company writer coordination

Implemented 2026-10-06. The business step and period stores now share a concrete MongoDB writer adapter. It is not connected to QBO transport, startup, public routes or a live database. The default integration check throws before writer mutation because existing QBO write paths do not yet participate. No company schedule or operation was enabled.

## Ownership and requests

CompanyWriter has one explicitly prepared document per environment/realm and an exact connection. A business operation acquires it in the same transaction that reserves its calendar. Missing documents, changed connections, another owner, invalid revisions and unresolved requests fail closed. No upsert or expiry takeover exists. Required unique indexes and transaction support remain explicit deployment work.

Each step transition writes the current Run, Calendar and Writer revisions in the caller's transaction, alongside the step state and audit. This produces real document conflicts with concurrent stop/state changes rather than relying on a preflight read. Dispatch also verifies the exact step revision/token and persists a non-expiring request barrier.

Settlement requires the normalized validated receipt, exact original request identity, entity, step and current barrier in that same transaction. Phase names alone cannot clear a barrier. Audit or step-save failures roll back barrier release. Physical-ID index conflicts preserve the unresolved request for recovery. Stop prevents new requests while permitting authorized settlement of a request already sent.

Prior-operation verification uses the current operation's writer while preserving the original step operation, plan and creation receipt. Dispatch and recovery remain tied to the original request barrier.

## Period evidence and release

Every step transition atomically increments the operation evidence revision and clears its frozen verification candidate. An old period proof therefore cannot complete after a new verification, failed readback or another step change. A new candidate must be rebuilt from current trusted observations before completion.

Period finish requires an unresolved-free writer and touches its exact ownership in the transaction that commits the calendar cursor. The writer remains held while the pending completion receipt is repaired. Final writer release and clearing Calendar.pendingCommit/currentOperationId share one transaction. A lost commit response can be recovered from that saved state without another cursor advancement or release. Recovery actor identity is rechecked on every transaction attempt.

## Verification and limits

Sixty tests pass across the concrete writer adapter, step store and period store; backend syntax passes 93 files. Both independent reviewers cleared the corrected implementation. Tests cover competing reservations, permanent barriers, receipt requirements, audit/physical-ID rollback, stop/settlement, changed scope, stale completion proof, historical verification and failed/lost final release. They use isolated in-memory transaction fixtures; real MongoDB isolation/indexes and QBO outcomes remain unverified.

The adapter is not a complete global write coordinator yet. Reproduction, generation, seeding, issue packs, legacy plans and administration must all use the shared transport boundary before readiness can become true. The current closed default must not be replaced with a configuration bypass. Compiled payload validation, request/response provenance, real permission/audit/readiness adapters, activated blueprint, approved baseline and deployment proof remain required.

Compiler integration (2026-10-06): dispatch now requires exact compiled intent/request evidence bound to the operation writer revision and a fresh observation timestamp. The writer transition compares that revision; transport rechecks the resulting revision and evidence freshness. See business-transaction-compiler.md. This does not open the activation gate.

Graph snapshots (2026-10-06): graphSnapshot validates the current run, calendar, settled writer ownership and exact revision inside the caller transaction. verifyGraph uses it before invalidating old proof and before saving new proof; normal per-step fences perform the writes in those transactions. This adds no activation or default readiness permission.


Operation-plan integration (2026-10-06): see [business-operation-plan-store.md](business-operation-plan-store.md). Original scoped intents are now retained separately. Step creation requires explicit create disposition; earlier-record intents cannot authorize recreation. Reservation, writer fencing and coordinated business transport require the exact durable plan approval. Runtime activation and storage deployment remain closed/unperformed.
