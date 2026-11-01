# Job L — general-write lost-reply settlement

Observed 2026-11-01 UTC. Scope: code fixes and offline tests, read-only MongoDB inspection; no coding-agent QBO calls, database writes, service control, commits or pushes.

## Finding and direct evidence

- General operation `01b4f4b62cae18ccc27b617a`, decision `winter-access-po-20261031-149`, batch 0, requestid `c1793dea9f59daa0fdb3ed90731e564e`, bId `1`, remained unknown since 02:07:07Z.
- Original receipt `14b5eb39a75528b126efd40988d90d3db8b2874fc1533762798525468d163018` recorded HTTP 200 and PO `11216`; its item was tagged mismatch/unknown. The CDC mirror contains the same PO (not deleted), native creation time 02:07:09Z, observed at 02:09:36Z. No QBO call was needed to establish the saved identity.
- QBO omitted requested `DueDate: 2026-11-02`. The request-to-response comparison therefore failed. This is an existing saved-record value mismatch, not a missing create reply.
- The service collapsed the gate's unproved classification into “response was lost.” General unknown runs were not selected by fixed-workflow automatic recovery or ordinary continuation. Error serialization used plain objects without a stack, producing null check.file/check.line.
- Older general transport retained only BatchItemResponse, losing the envelope time used by its aggregate hash. Original per-item SHA256 hashes remain available; real stored-row replay required those exact hashes.

## Changes and decisions

- A native saved create/update identity settles transport independently of semantic verification. Saved value mismatches remain `needs-correction`, retain their QBO id and ownership, and cannot be resent. Void proof remains strict. No field is silently ignored.
- The existing one-minute recovery wake now selects unanswered general unknown/sending batches under the current active agent grant, before applying the bounded query limit. It does not reconstruct proposals.
- Retained successful replies are reclassified only against the original receipt/request and aggregate or complete unique per-item response hashes. Receipt/run/writer settlement and audit use the existing transaction. No QBO dispatch occurs for this stored PO.
- Incomplete, hash-proven replies can retry only the original saved batch requestid/bIds through the normal gate. Unbound/tampered evidence stays held. Legacy partial replies lacking enough retained hash evidence can still remain held.
- Actual Error objects preserve source file:line for lost-reply and saved-value diagnostics.

## Verification

Prepared all four source changes outside backend/src, then saved them together at 02:42:10.792Z after both independent implementation and safety reviews. Reviewed corrections included original receipt-state compare-and-set, original HTTP status binding, and filtering eligible recovery candidates before limiting.

- Untouched private stored run/receipt/writer/CDC rows replayed offline through recheckGeneralWrites -> createGeneralWriteService.execute -> createGeneralGateTransport / createQboWriteGate.recoverGeneral -> normal receipt settlement. Nine tests passed; zero resend attempts; original receipt becomes saved, writer claim clears, PO11216 is attributed, DueDate remains mismatch with source file:line. Raw rows remain only in the private temporary task directory.
- Sanitized regression fixture preserves operation/receipt/PO identifiers and native field shape, with company/actor scope and text sanitized and hashes recomputed. It exercises the dropped-envelope per-item hash path.
- From backend: `node --test test/general-write-lost-reply-replay.test.js test/general-write-gate.test.js test/general-write-service.test.js test/general-write-recovery.test.js test/general-write-admission-errors.test.js test/qbo-write-gate.test.js test/general-write-capabilities.test.js` — **141 passed, 0 failed**, both staged and after the source batch.
- Node syntax checks passed for all four prepared source files.

## Live outcome

Read-only MongoDB observation at 02:46:44.456Z confirms automatic settlement at **02:46:18.358Z**, on the existing recovery wake at 02:46:18.078Z after the previous worker lease expired:

- Original receipt state: **saved**.
- Original PO identity: **11216**, retained on winter-access-order.
- Original scalar/resource writer barrier: **absent**.
- Batch sends: **1**, unchanged; requestid remains c1793dea9f59daa0fdb3ed90731e564e.
- Operation status: **needs-correction**, with the saved DueDate mismatch reported at backend/src/modules/general-write-service.js:236.

The lost-reply/duplicate-risk hold is resolved without a resend or owner input. The missing DueDate is not verified and still prevents this record from passing day-close checks. No execution route or QBO API was called by this coding job. The original raw-row regression also passed all nine tests against the saved source, without the staging overlay.

Private machine-readable observation: temporary task directory, final-live-observation.json.

## Work-value checkpoint

Essential issue: remove the duplicate-risk hold from an already-created PO. Smallest proof: exact stored receipt/CDC identity plus zero-send replay through the recovery gate. First recorded timing checkpoint 02:34:49Z; source delivered 02:42:10Z. Two test-fixture corrections exposed the older envelope/hash distinction; the original-row replay then passed. Continue decision: bounded recovery fix and required reviews completed; automatic live receipt settlement observed at 02:46:18Z. Optional PO date mapping and broader legacy partial-reply recovery are deferred.

All changes remain local on main as requested; concurrent changes were preserved.
