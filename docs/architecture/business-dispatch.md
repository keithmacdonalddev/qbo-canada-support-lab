# Business transaction dispatch and recovery

Implemented 2026-10-06 as an internal runner boundary. No public route, startup activation, storage preparation or live write was added.

The dispatcher connects the retained operation intent, existing compiler, durable step store, company writer fence and existing QBO client. It takes only a company scope, operation ID and logical activity ID. Callers cannot supply replacement payloads, policies or endpoints. Required adapters have no permissive defaults.

## Send and resume

1. Read current saved state and authority. Saved, rejected or possibly-sent activity never enters the creation path again.
2. For an explicitly create-disposition intent, resolve the exact existing QBOClient and claim the step. Read current compilation evidence after claiming, because a claim changes the company writer revision.
3. Compile the original saved step and approved policy; recheck actor and client scope. Commit the exact dispatch marker and retained artifact before sending. An ambiguous marker acknowledgement does not permit a send.
4. Send the frozen compiled bytes through QBOClient.apiCall under the original actor context and single-use business permission. The existing transport gate rechecks scope, approval, stop state, current membership, writer revision and unsent dispatch identity.
5. Reconcile from the exact stored transport receipt and both audit events. A raw provider return value, timeout or error cannot establish whether the record was saved. Missing or uncertain receipts leave recovery_required and replayAllowed=false.
6. Reconcile the complete saved graph before reporting activity completion. Recently verified proof alone is insufficient: a later linked bill/payment can change its parent within five minutes. Cancellation after a possibly-sent request still allows receipt settlement, but skips new graph reads.

There is no retry loop around a POST and no timer that races a write. Aborting after the marker but before admission can leave an unresolved unsent barrier; absence of a transport receipt is not treated as permission to replay. A process loss during provider dispatch similarly leaves durable recovery work. Internal claim expiry is five minutes; it only permits replacing a pre-dispatch claim, never a possibly-sent request.

## Exact receipt evidence

business-dispatch-receipt.js supplies the step store's loadRecovery adapter. It reads the deterministic QboWriteReceipt identity and exact company, connection, operation, logical key, dispatch hash, request hash, entity, create operation and original actor. A saved outcome must include the numeric physical record ID, canonical version, successful HTTP status and response hash. Both original dispatch and response audit identities and their bounded content must match inside one read transaction.

The returned request-correlated-readback source means a read of the retained transport result. It proves creation correlation, not current QBO content or accounting correctness. Current content and linked lifecycle verification still require the graph reader. No lookup by name, amount or approximate date can release a writer barrier.

## Evidence and limits

The initial six-suite verification passed 126 tests across dispatch, step storage, writer fencing, transport admission, permits and compilation. The safety review found a cached-proof completion shortcut; it was removed. The corrected dispatcher suite passes 12 tests, including a later writer change invalidating a recent parent pass. Backend syntax covers 106 files; diff checks pass with existing line-ending warnings. Independent implementation and safety reviews found no remaining blockers in this slice.

The integrated fixture uses the real compiler, step store, writer fence, QBO client, write gate and receipt reader with in-memory transactional models and a simulated provider. It substitutes a root-record verifier for the graph adapter. It does not prove real MongoDB transaction/index behavior, full linked-chain dispatch/graph integration, live Canadian provider acceptance, timing or company outcomes.

Remaining runtime work includes server-owned compilation observations, current tax/deposit evidence, scoped client/actor resolution, composition with the current membership/client adapter in [business-runtime-access.md](business-runtime-access.md), operation state/worker orchestration, full graph adapters, report closure, stop/resume UI and explicitly prepared storage/active blueprint/baseline. The dispatcher is not a claim that the business runner or whole application is complete.


Compilation integration (2026-10-06): [business-compilation-runtime.md](business-compilation-runtime.md) now provides fresh, exact pre-creation observations. The dispatch fixture exercises it together with the concrete verification runtime and saved graph proof. Production runner composition and activation remain unfinished.
