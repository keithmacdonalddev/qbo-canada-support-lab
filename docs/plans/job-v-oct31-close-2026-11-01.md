# Job V: October 31 close failure (2026-11-01)

Outcome: the reproduced general day-close failure is fixed offline. Actual calendar close completion remains unverified. No Git commits, service commands, QBO calls or MongoDB writes were performed by this job. All owned backend source was saved once in one locked batch at 2026-11-01T03:57:38.802Z–03:57:38.807Z.

## Findings and direct evidence

- Transcript attempt bc567755-ee18-4dbb-95e6-babfdbdf0176, result 6ae6b4e607223e1883ddf6c4 at 03:41:26.958Z, failed prepareBusinessPeriod before an OperationRun existed: GENERAL_DAY_CLOSE_UNVERIFIED, general-write-day-close.js, walk, line 47. Attempt c05ed67e-2a75-4dc9-a458-a10d4fbca9b4 had the same failure at 03:36:26.339Z. There were no GeneralDayClose documents because parsing threw before their creation; the old audit log held no close-failure detail.
- Exact reproduced error: A General Ledger row is dated outside 2026-10-31. The first failing row is the Beginning Balance data row under account 68, with no transaction identity or period movement. Stack: fail:15 -> walk:47 -> walk:42 -> parseLedger:52 -> closeGeneralDay:138 -> verifyRange:87 -> assertPeriodReady:95 (original general-write-day-close.js / general-write-close-gate.js).
- A second stored report shape is zero-cash Payment 11132 under Not Specified, with no account ID and no amount. The old parser would reject that after the opening-row failure was corrected.
- GENERAL_DAY_CLOSE_* was absent from the diagnostic message allowlist, hiding its real message. Preparation failures were absent from the blockers feed because it only read operation/step/general-write runs.
- Replay source: OperationEvidence c5eaff367237ceeb8e9a8875, operation cbf7d5a7d5d4ac7752785dcb, observed 2026-11-01T02:53:57.431Z, plus read-only current general runs and synced records. All 330 stored GL data rows were replayed through createGeneralCloseGate.assertPeriodReady, the same gate invoked by business-governance-service.prepare. The retained fixed-workflow report has signed natural amounts; the offline fixture projects its amount columns into explicit debit/credit columns, retaining its original dates, identities, sections and zero rows. This is not an unchanged response from the later failed explicit-column request, which was not retained. Baseline fails at the exact stored line; saved source passes five dated general records: Payment 11132, Estimates 11209/11217/11218, PurchaseOrder 11216. Undated masters are not posting records.
- Real todayActivity -> summarizeToday replay at 03:46 UTC: November 1 saved 0, expected 2, no batch due because the threshold is five records; next due 04:22 UTC. This explains catch-up-only cadence at that time. Job G's independent-work path already exists. Regression proves an older failed close, including a retained calendar operation, yields to current-day sales when due and to due collections/bills. No scheduling change was needed; stock receiving retains its FIFO dependency.

## Changes and files

- backend/src/modules/general-write-day-close.js: exclude only exact blank-identity Beginning Balance rows with zero debit and credit; accept accountless zero movement; retain failures for any nonzero unattributed movement or out-of-period transaction, with record/date differences.
- backend/src/modules/general-write-close.js: retain external-change field differences and nested posting exception diagnostics. Per-record own-line posting comparison is preserved.
- backend/src/modules/general-write-close-gate.js: save one complete failed preparation attempt, including code/check/record/differences; preserve original errors if diagnostic storage fails; record successful cached-proof reuse so later failures clear without another report read.
- backend/src/models/GeneralDayClose.js: optional bounded errorDetail field.
- backend/src/modules/business-error-detail.js: recognize day-close messages, include latest period-close attempts in blockers, retain repeat count/first-failure age until a passing proof.
- backend/src/modules/business-agent-store.js: make close-attempt storage available to agent diagnostics.
- backend/src/modules/business-agent-service.js: expose current blocker errorDetail and message on agent status. Existing review context and tool-result paths consume the same diagnostics.
- backend/test/general-write-oct31-close-regression.test.js: eight focused parser, posting, diagnostic, cached-recovery and independent-work regressions.
- backend/test/general-write-close-gate.test.js and backend/test/general-write-settlements.test.js: update four assertions to require retained failed attempts while still rejecting unsafe proof.

## Verification

From backend/, node --test over:

- test/general-write-oct31-close-regression.test.js
- test/general-write-close-gate.test.js
- test/business-error-detail.test.js
- test/business-agent-cadence.test.js
- test/business-agent-service.test.js
- test/business-agent-store.test.js
- test/general-write-fixtures.test.js
- test/general-write-recovery.test.js
- test/general-write-settlements.test.js
- test/general-write-currency.test.js
- test/business-observation-general-write.test.js

Result: 203 passed, 0 failed, 0 skipped, exit 0, both staged and saved-source runs. node --check on all seven touched source files: exit 0. git diff --check: exit 0. Independent implementation and safety review: no remaining findings after addressing failure-age resets, duplicate failure rows, masking of original errors, and stale blockers after cached success.

Private local replay inputs, scripts, full reproduced stack, results and test logs: C:/Users/NewAdmin/AppData/Local/Temp/qbo-job-v/. before-replay.json has expected baseline exit 1; after-replay.json has saved-source exit 0. Raw company data stays outside tracked documentation.

## Outcome ledger and remaining proof

Essential issue started approximately 03:46 UTC; direct proof achieved at 03:54 UTC and final source saved 03:57 UTC. Decision: deliver the narrow verified fix; no live execution authority was inferred. Final read-only company check still showed verifiedThrough 2026-10-30 and no new close attempt. The known general close gate should pass on the next attempt if the records/report shape remain consistent. Completing the rest of the real calendar close is unverified; no claim is made that the live company is already closed or producing new November records. No owner action was requested. All changes remain local on main as instructed; concurrent FX/RG2 changes were preserved.
