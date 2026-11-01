# Job P: writer contention, 2026-11-01 UTC

Requested outcome: independent batches admitted concurrently, conflicts/close/history exclusive, quiet contention retry for up to fifteen minutes. No commits, service control, QBO calls or database writes authorized. Canonical checkout main; changes local.

## Direct findings

- Read-only MongoDB at 01:27 UTC: CompanyWriter had operationId ea80b5f064cbc4be57cf67c3, plan 50c951979cf836babed0fdb171254e20b421b004a359e6f518cc7961bc684f68, null unresolved and empty resourceClaims/resourceQueue. It was an 18-record fixed-workflow adopted-collections batch, created 01:24:56 UTC, running then awaiting evidence.
- The reported id 14bc98000f3c4b0a48a9d3b3 is in generalwriteruns, not operationruns. It is a one-Vendor batch, prepared, original requestId 820a00f97def697506d0f7802595c241, sends 0. Stored writer-denial occurrences span 00:40:40 through 01:25:39 UTC; a second scalar-owner denial was recorded at 01:27:33. The same run also has separate full-guard refusals, most recently reobserved in the later capture; this change does not diagnose those.
- Fixed operationruns from 01:00 through 01:23 completed back to back. business-period-store.reserve -> business-writer-fence.reserve still assigns one scalar company operation owner. Resource acquire rejected any such owner; general transport also rejected its scalar ownership. d80f312 added concurrent general batch claims but did not replace this fixed-workflow contract.
- Fixed verification binds complete selected-account movements, scalar unresolved receipt and observation revision. Removing owner checks alone would admit posting changes that invalidate its financial proof.

## Delivered boundary and remaining outcome

- Compatible new Customer/Vendor/Employee and unlinked Estimate creates can overlap a same-day fixed activity owner after exact saved manifest/approval checks. New party types share the native name namespace: any fixed party create excludes another parallel party create. Scalar unknown same-entity or unidentified requests stay fenced.
- Compatible resource claims keep the scalar receipt and observation revision intact, with a separate resourceRevision counter. Fixed steps/verification/finish can continue; release transfers the compatibility pointer to an outstanding general receipt instead of losing it.
- General/general record/resource concurrency remains. Conflicting claims queue in order, keep queue position across quiet yields, and re-read period/balance evidence after grant. Four actual QBO HTTP slots remain unchanged.
- Busy waits yield after about one second, returning prepared + waiting (since/retryAt), keeping original requestid/bIds and refunding unsent attempts including exact replays with an earlier unknown receipt. Existing accountant recovery retries prepared general work on its wake cadence; retryAt is advice, not a new timer. Contention is a blocker only after fifteen minutes from the first wait (old writer-denial history carries forward). Guard refusals and unknown outcomes remain distinct.
- **Unmet:** two fixed posting operationruns still serialize, and a general posting batch still waits behind a fixed workflow's whole-account proof. This is a bounded concurrency correction, not completion of unrestricted independent posting concurrency. That requires replacing/composing fixed financial proof with per-operation write/read claims and calendar ownership. No unsafe owner-check removal was made.
- **Unverified:** live admissions, saved QBO outcomes and blocker clearance after installation. No QBO calls were used.

## Verification and review

- Private exact stored-row baseline replay reproduces the original company-owner denial with zero simulated SDK sends. The same vendor/run/plan/writer data passes service.execute -> sendBatch -> gate.preflight/begin -> createGeneralGateTransport -> receipt/settlement under the correction, with original requestId retained and scalar ownership unchanged. Dependencies for authority/cadence counters and company context are controlled offline; responses are simulated. This is not live financial proof. Private data and runner output remain under C:/Users/NewAdmin/AppData/Local/Temp/qbo-job-p-1793496631324 outside Git.
- 178 focused node tests pass: general-write-gate, business-writer-fence, qbo-write-gate, general-write-service, general-write-recovery, business-period-evidence, business-run-state. New coverage: 2/3 concurrent batches beside fixed owner; fixed fence graph/step/settled/release while general receipt is active; FIFO, four-slot cap, quiet fifteen-minute boundary; unknown replay timeout then immediate retry; three service retries at sends9 without consuming replay budget; party namespace and scalar unknown exclusions.
- All five changed/new source files pass node --check. git diff --check required at closeout.
- Distinct read-only implementation and safety reviewers found and then verified fixes for replay reservation leakage, shared party-name collisions, scalar unknown exclusion and replay-attempt refunds. No remaining findings within this bounded scope; neither certifies live/full posting concurrency.

## Work-value ledger

| UTC | Issue / proof | Decision |
| --- | --- | --- |
| 01:27:32 | Essential Job P opened; smallest proof stored-row replay + 2/3 batch concurrency | Trace active fixed owner before source edits |
| 01:33 | Scalar fixed ownership and whole-account proof confirmed; unrestricted bypass unsafe | Choose bounded list/quote coexistence; retain ledger proof exclusion and document unmet posting concurrency |
| 01:38:21 | 178 focused regressions pass; real fixed fence lifecycle covered | Continue to baseline/stored-row replay and final source batch |
| 01:41 checkpoint | Offline baseline and correction supported, no authorized live writes; full posting outcome remains unmet | Install only verified bounded correction; defer larger fixed-proof/calendar redesign for coordinated scope, preserve safety |

No Job X owned files changed. All source prepared and tested outside backend/src, then installed once in a short final batch after checking writer transport state. No explicit service controls used; nodemon may reload because source changes are watched.

## Saved-source closeout

Installed 2026-11-01T01:41:36.507Z in one 5 ms write batch after two read-only checks showed operationId null, unresolved null, no claims and no queue. All 178 focused tests passed again against saved source; stored-row corrected replay passed without the staged-source loader. Saved-source syntax checks passed for all five source files; git diff --check passed. No commits/pushes or service-control commands were issued.

Read-only observation at 01:42:31 UTC: supplier run 14bc98000f3c4b0a48a9d3b3 and quote run 90f1e797dc0c6890ce978ae6 both remained prepared with sends0. Both had fresh errors at 01:42:03/01:42:05 respectively: QBO_WRITE_ADMISSION_DENIED, Full general-write guards could not be verified. Nothing was sent., general-write-transport Object.admit line161. These are separate genuine guard failures and were not reclassified as contention. Live completion/blocker clearance is therefore still unmet.

15-minute value checkpoint (01:42:31): delivery is a tested local concurrency correction and fresh factual diagnosis; zero company records are attributed to this coding job (live mutation was prohibited). Preserve the correction; carry full fixed posting concurrency and the separate generic guard exception forward explicitly. Avoid Job X owned accountant/blocker files; no additional backend source saves in this job.
