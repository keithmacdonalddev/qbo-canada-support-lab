# Durable business-period verification

Implemented 2026-10-06 as an internal persistence foundation. No route, startup import, QBO executor, database migration or live initialization is included. The active company has not acquired a verified business baseline or calendar from this work.

## State and identity

BusinessCalendar records the company/environment, connection, immutable business identity/opening date, active blueprint, explicit baseline evidence, verified-through date, revision, current operation and stop flag. A null cursor means unverified; it does not imply that QBO is empty. The existing unusual company balances still require classification before baseline adoption.

OperationRun separates immutable plan/blueprint/period/cursor identity from mutable execution progress. It holds a bounded required assertion contract and expected record-set hash. Planned intents, steps, managed records and detailed evidence will be separately persisted/paginated. Neither schema is imported at startup; autoIndex is disabled. Declared indexes and immutable schema options alone are not deployment readiness or append-only enforcement.

## Internal store

createBusinessPeriodStore requires trusted adapters for readiness, current authority, evidence loading, idempotent audit, transactions and a company-writer coordinator. It has no permissive defaults and is not a public request-data handler.

- reserve requires the exact approved operation and verified baseline. A transaction changes Run from approved to reserved, claims the exact calendar revision/cursor and reserves the same company writer. A lost response can recover that same reservation after revalidation. Reservation is not an execution lease or permission to replay an uncertain QBO call.
- requestStop sets the company-scoped durable stop flag. It does not claim that an already-sent QBO request was cancelled or settled.
- finish requires awaiting-evidence, the exact frozen evidence revision/hash, complete expected managed-record identities including entity types and relationship keys, fresh saved versions and audit references, and all exact named period assertions. Assertions cannot substitute another period, currency, evidence type, basis or record-set observation. A transaction changes Run to committing and advances Calendar only when the expected owner, connection, blueprint, baseline, cursor, revision and stop conditions still match.
- repair reads the authoritative pendingCommit receipt, writes the stable completion audit, repairs Run verification, and only then releases the company writer and clears the pending receipt/current operation together in one transaction. Another operation cannot replace the pending receipt. Crashes during this projection repair do not require another cursor advancement or replaying external writes.

Commit evidence is dated, not a promise that QBO can never drift. The evidence includes observed content hashes, SyncTokens, relationship versions, observation times, actor and audit receipts. Saved verification candidates must be immutable; any changed observation requires a new candidate hash/revision before committing.

## Transaction contract

business-transaction.js uses the installed MongoDB driver's withTransaction API with one session, snapshot reads, majority writes, a 15-second timeout budget and 10-second maximum commit time. Session cleanup runs in finally. All transition DB operations receive that session. Audit, provider and QBO calls stay outside retryable callbacks. Every callback attempt rechecks read-only authority and requires the original actor, including automatic retries. An ambiguous transaction result is recovered from durable state, never by a nontransactional fallback or clearing a reservation.

The real adapter must verify the connected deployment supports transactions and has installed required indexes. Permission checks immediately precede sensitive transitions, but are not represented as a guarantee against a permission change at every possible instant. Executor dispatch must recheck scope/authority/stop state and enforce its own durable lease and unknown-write barrier.

## Evidence and remaining work

Twenty focused mocked persistence tests cover exact proof, a crash after cursor commit, idempotent reservation recovery, competing attempts, rollback on state changes, stop fencing, stale/mismatched evidence, permission loss, missing audit, frozen evidence revisions and transaction cleanup. These establish the contract against the in-memory repository fixture. They do not prove real MongoDB transaction/index deployment or QBO outcomes. Independent implementation and safety reviews found no remaining blockers after corrections. The combined calendar, persistence and book-evidence suite passes all 51 tests, with syntax and diff checks passing.

Remaining integration: append-only activated blueprint, company mappings and intent compiler; immutable OperationPlan and separately paginated steps/managed receipts/evidence; real readiness/authorization/audit/repository adapters; global company writer coordination; execution and recovery; public routes and desktop flows; authorized real-database and QBO verification. No business calendar date is shown as newly complete from these fixtures.

## Writer integration update — 2026-10-06

The concrete adapter in business-writer-fence.md is now required for period ownership and completion. Every step transition invalidates old frozen completion proof; unresolved dispatch prevents cursor advancement. Writer release is delayed through receipt repair and atomic with the final calendar clear. Sixty current combined writer/step/period tests pass, including recovery actor retry checks. The default integration gate remains closed; existing QBO write paths, real deployment and company outcomes are still not verified.


Operation-plan integration (2026-10-06): see [business-operation-plan-store.md](business-operation-plan-store.md). Original scoped intents are now retained separately. Step creation requires explicit create disposition; earlier-record intents cannot authorize recreation. Reservation, writer fencing and coordinated business transport require the exact durable plan approval. Runtime activation and storage deployment remain closed/unperformed.
