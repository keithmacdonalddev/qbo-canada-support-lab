# Scheduled record checks and managed-history re-verification

2026-10-31, job H. Coding only; no services, live QuickBooks calls, database writes or commits were authorized or performed.

Saved needs-check roots and pending report evidence are queued through the existing accountant recovery wake at one-minute intervals. Retained saved roots receive a fresh live GET during execution, preserving their original receipts and IDs. Failed general closes are re-read and re-verified; a newer pass supersedes the failed close.

General-created records in the current managed fiscal year may be edited when a committed accounting observation exists through the cursor. The exact batch persists its dirty dates before admission. Admission installs durable markers atomically after acquiring the company writer and before sending to QuickBooks. A busy writer creates no marker. Markers hold subsequent general and specialized admissions until every affected closed day through the cursor has fresh record, debit/credit ledger and complete report evidence. Relevant pre-opening changes also re-prove the opening baseline. Endpoint checks compare all account balances against the retained observation plus original accepted mutations. Fixed records must still match their original graph proof. Successful marker clearing commits with the proof summary; interruption or failed proof retains the hold.

Date moves expect zero postings on the old day and current postings on the new day. Exact durable validation refusals prove no write; unknown responses keep their original recovery barrier. Daily evidence is stored separately to stay within document limits.

## Boundaries still unmet

The owner's broader request for all historical edits is not fully implemented. Historical fixed-workflow records, their linked effects, adopted history and earlier fiscal years remain refused before dispatch. Fixed-workflow amendments require an additional immutable amendment witness consumed by original graph, tax and movement verification. Adopted history does not retain the full original report sources required by this path. Earlier fiscal years need explicit retained-earnings rebasing. These holds preserve existing creation/ownership contracts and prevent an edit that cannot subsequently recover.

Live operation is unverified. Non-live fixtures cover retry cadence, fresh graph reads, failed-close retries, baseline and daily checks, date moves, atomic marker clearing, fixed-record changes, durable no-effect refusal and writer contention. No frontend files were changed by H.

## Verification and changed files

Actual saved files: 311 tests passed across the 18 affected node --test files; all 14 changed backend JavaScript files passed node --check; git diff --check passed. Independent implementation and safety reviews of the final canonical files found no remaining blocker within the supported scope. Live integration was not run. Frontend build/lint was not applicable to H.

A broader general-write-daily-count.test.js check has three failing tests (unsent reservation expiry/refused items; same-key retry budget/permission; proposed count versus daily ceiling). The identical three failures reproduce with the pre-H source snapshot loaded in an isolated test process. Parallel work was preserved.

Core files: general-write-close.js, general-write-close-gate.js, general-write-day-close.js, general-write-recovery.js, general-write-guards.js, general-write-service.js, general-write-transport.js under backend/src/modules.

Integration files: business-agent-service.js, business-agent-store.js, business-authority.js, business-dispatch.js, business-operation-runner.js, business-runtime.js under backend/src/modules; backend/src/models/GeneralDayClose.js.

Fixtures: backend/test/general-write-recovery.test.js, general-write-guards.test.js, general-write-fixtures.test.js, general-write-gate.test.js, business-agent-service.test.js. All source files were prepared/tested outside the serving tree, re-read under basename locks, merged with parallel job changes, and saved once each in one final batch. Changes remain local; H made no commits.
