# Job E2 — request economy, 2026-10-31

Status: applied locally in one seven-module source batch at 23:26:52.197Z, with current-source replay and focused tests passing. Live whole-day savings remain unverified. No commits, QBO calls, MongoDB writes, or service controls.

## Stored meter and attribution

Meter row e9f1bf50791312987ac275ea0a8a3358ec80338755ad472a was read at 23:02:55Z and 23:21:01Z with collection/index creation disabled. The second connection's command monitor observed only find and endSessions. Both samples contain 7,926 metered non-sync calls: 6,613 reads, 809 queries and 504 reports. The 89 writes are excluded from this project's metered-read budget; sync rose by four requests during the interval. No non-sync traffic or saved records arrived in this observation interval, so it supplies no post-reload calls/record rate. Commit 96fe35a is timestamped 23:01:52Z; its source was already saved at 22:56Z in round 1.

For the 85 saved records represented by today's nine stored verified operations, the historical day ratio is 93.25 metered calls/record. That ratio includes activity choices performed before round 1; it is not the new implementation's rate.

| Stored caller | Metered calls |
| --- | ---: |
| untagged | 5,275 |
| business-transaction | 398 |
| business-stock | 392 |
| business-period-guard | 199 |
| business-report-operation | 190 |
| business-report-preparation | 126 |
| business-receivables | 102 |
| business-deposit-guard | 72 |
| business-reference | 21 |
| Older aggregate calls without a caller bucket | 1,151 |

The historical meter retains counts rather than stack traces. Exact attribution of the last row and old untagged traffic cannot be reconstructed. No new round-1 source labels appeared during this interval. Remaining source causes are repeated graph and compilation observations, per-record control-account ledger reports, all-stock/lots scans, linked-period reads and two complete deposit scans. Full approval/closing report sets remain necessary; existing report-source/ledger reuse is retained.

## Changes and correctness boundaries

- Group fresh full records by entity and exact numeric IDs, at most 50 per SELECT query. Require the complete exact ID set, unique non-sparse records, bounded bytes, valid versions, scoped original QBO client and per-attempt authority. Missing or malformed query results fail closed; the existing forced graph retry uses exact GETs.
- Reuse original record observations for at most 60 seconds within the same company/operation. Verification bookkeeping changes the writer revision, so reuse across those revisions additionally authenticates unchanged transport receipts and synchronized data. Any new send/reply, unresolved send, newly observed mirror record, changed company/actor, expired observation or unavailable safety evidence restores live reads. Each graph still reloads its exact topology and validates its before/after writer fence. Forced retries clear/bypass reuse. Compilation uses the same authenticated graph observations and rebinds ledger proofs to its current fence.
- An old receipt remaining unknown after owner attribution is terminal only after the existing full Step/Authority/Audit/terminal-transport contract is replayed. Exact receipt identity and recovery pointer are bound. A missing attribution audit, forged identity or tampered pointer refuses reuse.
- Coalesce control-account reports by exact endpoint and writer fence; preserve their actual original observation times. Keep independent record/report brackets and approved account definitions. A retained pre-report observation still needs an independent post-report read. The bounded record report cache now holds 32 entries.
- Period and stock guards may use a full mirror record only with current, generation-matched CDC, coverage strictly newer than that record's last provider change, and no uncovered affecting send/reply. Old in-flight requests count regardless of send time; batch receipts conservatively invalidate. Edit/delete/void targets and closing Preferences stay live. Stock fiscal CompanyInfo stays live. Stock projections, original FIFO lots and cost checks are unchanged.
- Deposit availability may use the complete synchronized Deposit set only with exact count/generation, bounded full records, CDC coverage after the payment's last change and all included deposit changes, and no uncovered or unresolved deposit/batch send. It validates the same complete lines/links twice and retains the independent final Payment read. Failure of freshness proof restores both complete live scans.

External QBO changes not yet observed by synchronization can remain unseen during the bounded 60-second operation observation window. This is explicit reuse, not a claim of instantaneous synchronization. Known writes invalidate all retained operation observations conservatively. The 10,000/day and 450,000/month admission guards are unchanged.

Grouped GET queries were chosen deliberately: Intuit's [official batch tutorial](https://github.com/IntuitDeveloper/SampleApp-Batch-Java/blob/main/docs/batch-tutorial.md) says each BatchItemRequest is metered separately. Grouping IDs inside a full query saves metered calls; wrapping separate queries in POST /batch does not and would require changing the write gate. No POST read exception was introduced.

## Offline replay of original stored operations

Private inputs remain ignored under artifacts/job-e2-call-economy/private-replay-input.json, copied from the read-only round-1 snapshot at 22:41:33.839Z. Frozen copies of the seven original modules and baseline-preload.cjs keep the before replay reproducible after applying the fix. No Connection secrets were captured. The replay uses the original stored Steps, Intents, policies/amendments, receipts, attribution audits, mirror records, control-account reports, stock opening states and Preferences. An in-memory original SDK asserts GET-only. The child also blocks real HTTP, HTTPS, sockets and fetch. No database connection is made by replay/tests.

The same createBusinessStepStore.verifyGraph -> createBusinessVerificationRuntime -> graph/content/readback verifier path used by the live run is exercised. In-memory persistence follows the real verification-start and verify transitions, advancing the writer revision twice per record (for example 10000 -> 10072 -> 10144 for the 36-record operation). This matters: a preliminary constant-revision replay overstated cache reuse and was replaced after independent review. The final replay advances time by 20ms per simulated provider request, preserving independent report bracket costs.

| Operation ID | Saved records | First verification before -> after | Repeat before -> after |
| --- | ---: | ---: | ---: |
| 3f91fc7065975cc70e9945e9 | 12 | 24 -> 9 | 12 -> 0 |
| 3359607d8aee4df04a3d88da | 36 | 66 -> 21 | 66 -> 9 |
| b2cbf83dd9a354dcee95e6d4 | 8 | 16 -> 10 | 8 -> 4 |
| 875b744e7300ab5ebe8d362e | 7 | 11 -> 6 | 7 -> 0 |
| 9d4ec16d7e3e36a58264e436 | 4 | 8 -> 5 | 4 -> 0 |
| 87943af9cc3d075eceeb2ef1 | 9 | 15 -> 7 | 9 -> 0 |
| fe38d779eec7311f9a294493 | 1 | 3 -> 3 | 1 -> 0 |
| 53a8f3c7452ef127d45d0bef | 3 | 3 -> 1 | 3 -> 0 |
| 05781d1aea04bbd9db533d47 | 5 | 11 -> 8 | 5 -> 1 |
| Total | 85 | 157 -> 70 | 115 -> 14 |

All nine graphs pass, including their original relationships/tax/account-posting checks. First-verification calls/record fall 1.85 -> 0.82; two consecutive verifications fall 3.20 -> 0.99. Reports in the first set fall 36 -> 9. Those nine include two distinct account/date report endpoints in the five-record operation.

Actual stored stock sources contain five Items and eight original Bills: each operation's stock read falls 14 -> 1 (126 -> 9 across nine operations), preserving the exact projected-content hash. The remaining call is live fiscal CompanyInfo. Actual Deposit requests 11134, 11136, 11139, 11140, 11142 and 11144 traverse 3,3,3,3,7,7 linked records: period calls fall 32 -> 8 with identical linked-date, record and Preferences hashes. Two uncovered linked observations still require GETs; six Preferences checks remain live.

Together the first verification, stock checks and these six period guards fall 315 -> 87 calls, or 3.71 -> 1.02 per represented saved record. Including a second graph verification gives 430 -> 101, or 5.06 -> 1.19. These are explicitly sampled verification/guard layers, not a replay of every preparation, dispatch, recovery, day-close or AI tool call. The full company <=3/day target remains unverified; no live calls or writes are authorized for this job.

## Verification and review

- Focused seven-file candidate run: 104 passed, zero failed, two inherited skips. Includes all eight business-operation-freshness chains, concrete graph/compilation tests, period controls and new exact-query/receipt/CDC/fallback/expiry/authority tests.
- Report/period/receivables/approval/stock-cost run: 64 passed, zero failed.
- Nested original-SDK report/runtime chain: 3 passed, zero failed.
- Stock controls: all 8 cases passed, including wrong postings, stock drift, purchase edits, fiscal rollover, Stop/continue, unknown purchase attribution and close recovery. The combined controls/runtime command reached its 180-second whole-process deadline after those eight passes and was terminated; it is not claimed as a command pass. The missing runtime file then ran alone: 4 passed, exit 0 (90.0 seconds). All tracked isolated processes reached close events; test isolation was disabled, so no test-runner descendant processes were created.
- Seven candidate backend modules pass node --check.
- Distinct read-only implementation and safety reviewers found no remaining concrete findings after the recorded fixes. Reviews do not authorize or prove live savings.

Commands run from backend (isolated, in-memory SDK):

~~~text
node --require ../artifacts/job-e2-call-economy/test-sandbox.cjs --require ../artifacts/job-e2-call-economy/offline-only.cjs --require ../artifacts/job-e2-call-economy/preload.cjs --test --test-isolation=none --test-reporter=spec test/business-call-economy-v2.test.js test/business-operation-freshness.test.js test/business-compilation-runtime.test.js test/business-request-economy.test.js test/business-graph-readback.test.js test/qbo-write-period.test.js test/business-observation-general-write.test.js
node --require ../artifacts/job-e2-call-economy/test-sandbox.cjs --require ../artifacts/job-e2-call-economy/offline-only.cjs --require ../artifacts/job-e2-call-economy/preload.cjs --test --test-isolation=none --test-reporter=spec test/business-report-evidence.test.js test/business-period-evidence.test.js test/business-receivables-route.test.js test/business-approval-report-evidence.test.js test/business-stock-cost.test.js
node --require ../artifacts/job-e2-call-economy/offline-only.cjs ../artifacts/job-e2-call-economy/replay.cjs before
node --require ../artifacts/job-e2-call-economy/offline-only.cjs --require ../artifacts/job-e2-call-economy/preload.cjs ../artifacts/job-e2-call-economy/replay.cjs after
~~~

After the source batch, the same commands run without preload.cjs. Sandbox/production preloads only align the isolated configuration with each fixture's company. They never change .env. All isolated process exits/cleanup are recorded in the private logs.

## Owned files

- backend/src/modules/business-transaction-batch-reader.js
- backend/src/modules/business-verification-runtime.js
- backend/src/modules/business-compilation-runtime.js
- backend/src/modules/business-observation-store.js
- backend/src/modules/qbo-write-period.js
- backend/src/modules/business-stock-source.js
- backend/src/modules/business-graph-readback.js
- backend/test/business-call-economy-v2.test.js
- backend/test/helpers/business-economy-fixture.js
- backend/test/business-graph-readback.test.js (SDK exact-ID query support, simulated child save advances writer revision, final corruption check forces the independent live retry)
- docs/plans/request-economy-job-e2-2026-10-31.md

## Work-value record

- 23:00Z: essential request-economy work; smallest proof is real stored path replay plus existing freshness chains; no dataset writes authorized.
- 23:17Z checkpoint: nine actual stored operations and all 85 records verified offline; revision-only cache assumption rejected and replaced with receipt/sync proof. Continue focused stock/report checks and review, then one source batch; no broader architecture work.
- Subsequent advancing-clock replay retains 14 necessary independent bracket GETs on repeat. Report that evidence instead of the earlier frozen-clock zero-call result.

## Final closeout

- Source batch applied at 23:26:52.197Z under seven exclusive per-file locks. Every original was re-read and matched its starting identity before any save. All seven saved modules match the reviewed/tested overlay byte-for-byte; all locks released. No backend source was saved again.
- Actual saved source, without candidate preload: seven-file core test run 104 passed, zero failures, two inherited skips; exit 0. All eight chronological freshness chains pass. Stored real StepStore replay: all nine operations/85 records pass, first157 ->70 and repeat115 ->14. Frozen-original baseline independently replays after apply. Stock and guard content hashes match the original-code replay. Attribution negative checks pass.
- Distinct candidate suite totals: 183 passed across core, report/period, nested-runtime and twelve stock cases; two inherited skips. The one combined stock command timeout is explicitly qualified above.
- Current backend syntax: 303 JavaScript files, zero failures, exit0. Owned diff/whitespace checks pass. Exact replay results and command logs remain ignored under artifacts/job-e2-call-economy.
- Current-source core command is the seven-file command above with preload.cjs omitted. Current-source after replay likewise omits preload.cjs; before replay installs its frozen baseline internally.
- Changes remain local and uncommitted by explicit instruction. Other jobs' files and commits are preserved. No frontend changes, service controls or live company verification were needed or performed.
