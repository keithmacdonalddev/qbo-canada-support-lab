# Job Y: expired unsent Estimate recovery

Prepared on main/origin/main; changes intentionally uncommitted and unpushed at the owner's request. No service-control command, QBO call, or MongoDB write was performed. MongoDB connections were read-only and closed.

## Direct evidence and cause

Operation 2bb2bd8194d01a1239285eca is blocked at ordinal 0 of 1. Estimate step 6ae67cbb10ae4dae8c6c89c9 is claimed at revision 1, attempts 1, with a lease ending 2026-10-31T23:46:47.274Z. It has no dispatch, compilation, receipt, or QBO ID. Its 23:43:31 retry correctly refused the still-live claim.

Approval audit 761c16f05794e273b01f6045 and report observation audit becece189e66971633a95a00 exist. The standing grant is 9d73286e296380947c0d91724e34b954603ed4e6903675d9e4e98e13394b4bf2. Candidate b1b1a3c5768e1f68be129c84 lost sources.reports={} through Mongoose's default empty-object minimization. An Estimate requires zero approval reports. Restoring that one empty field reproduces BOTH the original source hash 236917650e0b5a172ba80cecb43ea3f910fe4312096678e49a58c843465649f2 and payload hash 077bbfced798f8a3004fbe548e82838424482fd34acb43bae683b11e1a63cd89. The actual approval reader previously threw BUSINESS_APPROVAL_REPORT_UNVERIFIED at line 56. No new owner decision is needed.

The first retained compiler failure was separate: Item 47, field-service-hour, had approved DeferredRevenue=null and observed DeferredRevenue=false, both SyncToken 0. This patch does not assert that reference difference is resolved.

## Change and boundaries

- BusinessCandidate.js preserves empty objects for new immutable evidence.
- business-approval-report-evidence.js reconstructs only missing empty reports for zero-report version-2 payloads, in memory, requiring both original audit-bound hashes; all remaining plan, scope, actor and observation-audit validation remains.
- business-unknown-recovery.js recognizes expired never-dispatched claims. The hint is stable per claim revision/expiry and suppresses the already-requested continuation key. The existing worker queues the original operation under its standing grant; the existing runner reclaims by transaction and revision. It cannot clear sent/saved/uncertain evidence or a writer barrier.
- business-step-store.js additionally refuses reclaim when compilation, QBO ID, verification or rejection evidence exists.
- business-agent-engine.js directs slice/obligation reviews to independent work first and bounds recovery attempts per review. Existing cadence/service concurrency is retained and tested; model compliance remains a runtime observation, not a mechanically enforced guarantee.

A backend restart retains live leases. Existing pending execution scanning resumes after the operation lease expires; an early retry may block on the step lease. The new hint resumes that blocked unsent claim on the next accountant re-check after expiry. It never shortens a live lease. Job X-owned files were not edited.

All five backend source saves occurred in one batch, 2026-11-01T00:32:51.916Z–00:32:51.919Z, after scratch verification and independent read-only implementation and safety review (no findings). Per-basename locks were released.

## Verification and outcome ledger

- Exact stored run, step, approval audits, candidate, plan, intent, grant and writer captured privately under C:/Users/NewAdmin/AppData/Local/Temp/qbo-job-y-1793492927412/stored.json; raw rows remain outside the repository.
- Before: actual approval reader rejects; automatic continuation reports false.
- After: seven exact-row replay tests pass. The actual dispatcher reclaims the same step and reaches compilation; replay intentionally stops before transport. No QBO write or company completion is claimed.
- From backend/: node --test test/business-unsent-claim-recovery.test.js test/business-approval-report-evidence.test.js test/business-step-store.test.js test/business-unknown-auto-recovery.test.js test/business-agent-engine.test.js test/business-agent-service.test.js test/business-agent-cadence.test.js test/business-execution-service.test.js — 176 passed, zero failed. Includes restart queue recovery and independent reviews during unresolved recovery. Five touched source files pass node --check; git diff --check passes.
- Read-only post-save observation at 2026-11-01T00:34:51.315Z proves automatic recovery ran on the next scheduled wake: step reclaimed at 00:34:47.753Z as attempts 2 / revision 2. Run settled at 00:34:48.822Z with BUSINESS_REFERENCE_UNVERIFIED; no dispatch, receipt or QBO ID exists. Accountant status is reviewing. Automatic claim recovery is achieved; Estimate creation and independent saved records remain unverified. The reference failure remains for the orchestrator/Job X.

## Work-value checkpoints

The essential outcome is restoring continuity without replaying a possibly-sent record. Smallest direct coding proof: exact stored approval loads and the original expired unsent claim reaches the existing dispatcher; next delivery milestone: saved source and focused tests. Investigation identified two independent failures (minimized evidence and omitted unsent scheduling), so no new recovery framework or shared-service rewrite was introduced. At the source batch checkpoint, code/replay proof is achieved. At the 00:34:51Z read-only checkpoint, automatic reclaim is directly observed; reference validation still prevents dispatch, so live record delivery remains unmet. Do not reset this step or replay a sent request. Continue independent activity through existing governed tools and route the exact remaining Item definition failure to its owning job. No optional feature work was added.
