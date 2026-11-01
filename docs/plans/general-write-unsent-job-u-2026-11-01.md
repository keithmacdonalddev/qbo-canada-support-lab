# JOB U: prior-day unsent general writes (2026-11-01)

User boundaries: no commits, service control, QBO calls, or MongoDB writes. MongoDB inspection was read-only. Source was prepared and tested in Temp before one final backend save batch.

## Stored evidence

At inspection the calendar was verified through 2026-10-30, with no pending commit or Stop.

- Deposit run `2ad4e5010968ba5e43815bbf`, prepared 2026-11-01T02:42:06.197Z for Oct 31; requestid `764bc190e657dda9cfe09f79aaaf87dd`.
- Vendor 31 deactivation run `557b37779733d8cbca44dcd9`, prepared 2026-11-01T02:48:42.470Z for Oct 31; requestid `2facb682c4642adc6d7dd23f23701075`.

Both had status prepared, a sending-shaped batch with sends:0, no transport, no items, owned records, dirty markers, scoped general-write receipts, or writer/claim barriers. Their saved errors explicitly record write_admission with outcomeUnknown:false and “Nothing was sent.” No matching Deposit existed in the local CDC mirror under the real request comparer; Vendor31 remained Active:true/SyncToken0 (its mirror observation is older, so receipt/dispatch evidence is authoritative). No QBO API absence claim is made.

## Changes and offline proof

Prior-day wholly unsent accountant runs now become expired-unsent, retaining immutable plans and batch identities. Expiry checks receipts and writer claims, conflicts with concurrent gate admission through run revision, and commits its audit with the state transition in one transaction. Unknown/sent requests retain recovery barriers. Close ignores proved-unsent plans; execute returns a current-day replan action. Changed-day admission refusals do not become business blockers.

Stored data replay through createGeneralCloseGate.assertPeriodReady first reproduced GENERAL_DAY_CLOSE_UNVERIFIED for the unsent deposit. After expiry it exposed three Estimate copy differences: 11209,11217,11218 (all SyncToken0) add only FreeFormAddress:false. Existing entity-specific default comparison now treats this absent/false Estimate presentation flag equally; true, Invoice and accounting differences remain strict.

The final offline close replay passes five saved dated records and expires exactly the two runs with two audits, without changing completed runs or making external writes. It derives zero postings independently for every saved general transaction and uses an explicitly synthetic native-shaped zero-posting ledger. The retained native Oct31 report was observed at 10:58:52Z, predates these records and lacks required debt_amt/credit_amt columns; it is insufficient for a live-close claim.

The actual receipt calendar gate (business-activity-batch.assertBatchPreparation) refuses Nov1 receiving at cursor Oct30 and releases that prerequisite at cursor Oct31. Native stock-cost/carry proof remains mandatory. The full next close and stock receipt are unverified until the accountant attempts them using current QBO evidence.

## Verification

Distinct read-only implementation and safety reviewers checked the final scratch change, including Estimate stored rows; no unresolved findings. Focused tests cover idempotent atomic audit, rollback, concurrent revision failure, receipts, sent counters, missing counter crash, unknown outcomes, writer claims, mixed saved/unsent first close, midnight races, blocker filtering, Estimate default boundaries and receipt calendar release. Exact commands/results are recorded at closeout.

Private raw replay inputs remain outside the repository in the job-specific Temp directory; no raw company records or secrets were added to tracked evidence.

## Delivered files and final results

- backend/src/modules/general-write-unsent.js: unsent proof and transactional expiry/audit.
- backend/src/models/GeneralWriteRun.js: expired-unsent status and retirement evidence.
- backend/src/modules/general-write-day-close.js: expire stale runs and exclude proved-unsent batches; retain settled run snapshots.
- backend/src/modules/general-write-close-gate.js: pass expiry stores/clock and settle before freezing history snapshots.
- backend/src/modules/general-write-service.js: expire before prepare reuse/execute and handle both midnight races; return current-day replan.
- backend/src/modules/general-write-transport.js: typed definite day-change refusal.
- backend/src/modules/business-error-detail.js: exclude expiry and definite day-change refusals; unknown remains visible.
- backend/src/modules/qbo-semantic-compare.js: narrow Estimate presentation default.
- backend/test/general-write-unsent-job-u.test.js: 24 regressions.

Saved source bytes equal reviewed scratch bytes. Eight backend files saved together at 2026-11-01T03:28:34.690Z; basename locks removed. No further backend saves.

Final direct command from backend/ (exit 0, **136 pass / 0 fail**):

`node --test test/general-write-unsent-job-u.test.js test/general-write-service.test.js test/general-write-close-gate.test.js test/general-write-gate.test.js test/general-write-admission-errors.test.js test/general-write-recovery.test.js test/general-write-settlements.test.js test/general-write-inventory-carry.test.js`

A broader scratch run additionally included business-error-detail.test.js, general-write-daily-count.test.js, qbo-semantic-compare.test.js and business-stock-runtime.test.js: **165 pass / 6 fail**, exit 1. A separate baseline run of the three failing files against unchanged source reproduced the same six failures (**26 pass / 6 fail**, exit 1). Failures concern older definition/witness expectations, request-budget fixture canonicalization and two dated-tax/master expectations; no new failure is introduced by JOB U. The stock runtime file passed in the broader run. All eight prepared source syntax checks and git diff --check passed. Final saved-source stored-row replay also passed (exit 0; five records, two audited expiries, synthetic zero-posting ledger, zero external writes).

Final read-only observation at 2026-11-01T03:29:23Z: cursor remains Oct30, both real runs remain prepared and no Oct31 GeneralDayClose row exists. The runtime has not yet exercised this change. The known two stale requests and three Estimate-default refusals pass offline; full Oct31 calendar completion and stock receipt remain unverified. No commit/push or service control occurred; all owned changes are local.
