# Durable business operation plans

Implemented 2026-10-06. Internal persistence and execution-admission contracts; not a deployed operation runner.

The original activities, record choices, prices, dependency fingerprints and approved Canadian business policies are saved before execution. A continuation reads that saved intent. It does not regenerate a different business plan or infer that an earlier record should be created again.

## Stored contracts

- OperationPlan is an append-only manifest with exact company connection, blueprint and baseline hashes, opening date, continuous period/cursor/revision, dependency-first record descriptors, required report assertions and expected record-set hash.
- OperationIntent stores each original compiler step and its exact approved policy separately, indexed uniquely by plan/logical key and plan/ordinal. The immutable manifest binds both hashes. No creation receipts, live evidence or evolving verification state are put in the plan.
- OperationRun starts previewed and links that exact manifest. Its durable approval records the plan hash, actor, audit receipt, current-state fence and timestamp. Approval means reviewed intent, not that any QuickBooks transaction has been created or verified.
- Earlier activities have explicit existing disposition and new activities have explicit create disposition. Missing/null disposition is rejected by the step store; an earlier activity cannot be claimed for creation even if its receipt is missing.

One operation covers at most 31 elapsed Halifax business days, 500 new activities, 1,000 total records including complete prior dependency closure, and 8 MB of canonical candidate JSON. These are safety ceilings, not measured production capacity. Pages return up to 100 entries. A zero-activity interval still requires its named report assertions.

## Store flow

createBusinessOperationPlanStore requires explicit storage, transaction, readiness, authorization, audit, candidate-loader and current-state-fence adapters. There are no permissive defaults and no route accepting client-supplied step/policy claims.

1. prepare receives only a request identifier and exact server-candidate hash. It validates complete dependency fingerprints, scope, dates, references, policy bindings and assertions. Plan, intents, run and audit are saved atomically. Server-owned storage identity is projected separately from candidate data.
2. A retry uses the same actor/company/request identity. It checks the stored manifest, run and entire retained intent set without requiring an expired candidate to be regenerated. A changed request cannot reuse that identifier.
3. approve checks the exact reviewed plan and every saved intent, requires operations.execute permission, invokes the transactional current-state fence, and saves approval and audit together. This internal approval transition can be invoked by an authorized autonomous workflow; it does not impose repeated per-record user prompts.
4. page and loadIntent recheck scope, authority, manifest, run and requested row hashes. loadIntent directly supplies the existing step store and compiler contracts. Earlier-record fingerprints and relationships are preserved under the current operation without transferring original record ownership.
5. Reservation, company writer fencing and coordinated QuickBooks admission require a matching durable approval. A status field alone is insufficient. Lost approval replies return the existing receipt after validating all retained intent rows; they do not approve again or claim current execution readiness.

The candidate loader must read server-owned local preparation/policy records. The checkCurrent adapter must atomically fence the activated blueprint, exact approved policies, baseline and calendar revision in the supplied transaction, and bind its receipt to the exact plan, operation and actor. A read-only boolean check does not satisfy this contract. Both adapters remain unwired to production. Prepared plans require approved reference definition hashes and preserve original versions. [business-reference.md](business-reference.md) implements full-read revalidation of newer versions without changing saved intent; runtime reader wiring remains unverified.

## Verification and remaining integration

142 focused plan/step/period/compiler/writer/transport tests pass. They cover lost replies, concurrent retries, transactional rollback, missing or changed saved intent, conflicting request reuse, scope isolation, candidate field shadowing, exact dependency closure, explicit creation disposition, and durable approval at actual execution boundaries. Backend syntax covers 103 files; diff check passes. Required implementation and safety source reviews are clear.

Fixtures and mocked transactions do not prove MongoDB indexing, transaction capacity, live Canadian acceptance or the complete business workflow. No collections/indexes were created, company records written, services changed or schedules activated. The new models disable automatic creation/indexing and are not imported at startup. Real setup authorization, activation/baseline/policy adapters, runtime reference readers, the durable runner, complete report closure and direct company outcomes remain open. The whole-app goal remains active.

## Original activity history — 2026-10-06

The read-only store now exposes history(scope, logicalKeys). It reads OperationStep by the existing environment/realm/logical-key index before checking connection identity, so an earlier connection cannot appear as missing work. Within one snapshot it checks original Run approval, immutable Plan/manifest, creation intent, policy hash, owned step fingerprint and original dependency identities. The complete original dependency closure is loaded, rather than generated from the current business template. Repeated nodes and operation reads are shared; duplicate physical record ownership and cycles fail closed.

The reader permits at most 1,000 roots/visited nodes and 8 MB of retained entries/manifests. Individual indexed reads use three-second server execution limits; the caller has a 30-second deadline and cancellation races around readiness, authority, reads and transaction acknowledgement. Current authority is checked before, within and after the snapshot. Late replies cannot return accepted history or trigger subsequent history reads. Already-running database/driver work may finish after the caller is cancelled.

Missing local receipts remain unknown; saved verification requires fresh QBO readback. No QBO request, plan creation, approval or mutation is performed by history(). Full original steps/policies remain internal. The preparation route returns only provenance, IDs, dates, hashes, saved states and dependency identities. Current-period matches require inspecting/resuming their original operation and skip redundant full master GETs. Storage without the existing required collections/indexes produces explicit unavailable evidence and is never prepared automatically.


Original history now retains its originating business key so [candidate assembly](business-operation-candidate.md) can reject cross-business ancestry while preserving original step and policy content. The assembler can feed the existing candidate validator and Plan/Intent persistence; it does not replace the still-required production activation/policy fence.
