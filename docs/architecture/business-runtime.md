# Saved-operation runtime composition

Implemented 2026-10-06. This is the server-side composition for an already retained operation. The composition itself does not launch work, migrate storage, activate a business or approve a plan. The separate execution service now binds it to authenticated routes and recovery of saved execution requests.

## One bound operation

createBusinessRuntime binds the authenticated actor, workspace owner, environment, company connection and operation ID. It uses the concrete current-access adapter, original saved-plan reader, transactional run/step/period stores, company writer, original QBOClient and common write gate, compiled observations, related-record verification, exact response receipts, report collection and retained period evidence. The runtime exposes execute, inspect and stop. Status inspection does not expose the worker lease token. Construction performs no reads or writes.

The default loader reuses already-registered User, Connection, CompanyMembership and AuditLog models. Missing legacy registrations reject composition instead of triggering Mongoose's automatic collection/index behavior. All newly registered operation models disable automatic collection and index creation.

The read-only plan-store mode exposes page and loadIntent only; it does not require or expose preparation/approval adapters. The step-store graph-only mode supports complete related-record verification and rejects the standalone verifySaved path when no standalone adapter is supplied.

## Readiness and coordination

The concrete readiness inspector checks all runtime collections, required schema index definitions including key order/partial uniqueness, ordinary collection type/options, and transaction-capable deployment. It never creates storage or indexes. Successful static schema inspection is cached for 30 seconds within a runtime to avoid repeating the same catalog reads for every step. Disconnection or database-object replacement invalidates this cache. Authority, approval, leases and company ownership are not cached. The common QBO write gate also retains its transport checks.

A scoped coordination policy with version, connection, valid revision and a retained preparation-evidence hash is required. This checks the prepared-state contract; it does not perform or prove the preparation procedure. That procedure remains a separate deployment/activation gate. Reserve, claim and dispatch require active policy and touch its exact revision in the caller's transaction, preventing a concurrent switch to preparing from creating an unsent marker. Recovery and verification remain available while preparing. An already-sent request is never replayed merely because policy changed.

## Audit

The shared audit adapter persists only bounded allowed scalar operation metadata, under the actual actor and workspace owner. IDs are deterministic per scope/actor/event. Reusing an event verifies exact saved contents; changed contents reject. Calls inside a state transaction join it; standalone period receipt audits get their own transaction. Historical committed-actor metadata remains distinct from the person currently repairing the receipt. Secret or arbitrary nested fields are rejected.

## Evidence and limits

The integrated fixture exercises real authority, plan validation, runner, compiler, step/writer/gate, QBOClient, graph read-back, report reader, retained evidence and period completion, with simulated database/provider responses. It covers preparing-state rejection, preparing-mode recovery, scope/access loss, cancelled writes and no-duplicate resume. Separate tests inspect storage-readiness and audit boundaries.

This does not establish real Mongo conflict behavior or live Canadian API acceptance. The authenticated operation routes now call this runtime through the durable background execution service; see [business-execution-service.md](business-execution-service.md). Real service restart recovery has not yet been exercised. Operation preparation/activation, approved company mappings/tax/baseline, explicit storage deployment and full live records/report outcomes remain open. No live company/database action, service restart, commit or push was performed for this change.
