# Job OB: historical opening balances and tax-adjustment evidence

Offline result: **317 of 324 external bank/card periods ready; seven draft. All 324 book/statement checks tie exactly.** Four cash accounts retain 116 separate cashbook/count periods. Generated files are reconstructed simulated evidence, not independent bank confirmation or proof of native upload/matching/reconciliation.

## Evidence and decisions

- Frozen BF1 input: `backend/test/fixtures/bank-settlement-history.json`, 3,789 ledger rows and 1,385 payment/deposit links, through 2026-10-31.
- Retained original: [banking-research-20261101.json](../../artifacts/goal-realization/banking-research-20261101.json), SHA-256 `80d14fb4b16ca4107e73abcce40a675227dbfeb8ebc032429613864bf6daecc5`.
- Scoped read-only Mongo inspection: 130 accounts, 43 journals, entity inventory and stored report metadata. No bank opening-equity journal and no explicit Account.OpeningBalance/OpeningBalanceDate were found. Journal 200 is zero-native-cash revaluation; journals 631/632 move between equity accounts, not bank accounts.
- Each opening is the retained native closing balance minus **every** retained native ledger movement. Each resulting zero is derived, not assumed. Source reference, original file hash, per-account ledger hash, mirror projection/hash and per-account evidence hash are retained in [the sanitized evidence fixture](../../backend/test/fixtures/bank-opening-history-evidence.json).
- Accounts existing before their first activity carry the derived first known pre-activity balance through quiet periods. Creation timestamps establish neither economic opening dates nor money movements.
- Later mirror account 123 has balance CAD 1,300,690.05; the frozen anchor is CAD 1,299,563.73. These different observations are explicitly flagged and never mixed. Current live-company readiness is unverified; replay readiness applies to the frozen retained snapshot.

| Account | Native currency | First simulated month | Opening | Retained closing anchor |
|---|---|---|---:|---:|
| 1150040005 | CAD | 2026-05 | 0.00 | 124.00 |
| 1150040000 | CAD | 2025-04 | 0.00 | 0.00 |
| 120 | CAD | 2026-09 | 0.00 | 0.00 |
| 68 | AUD | 2023-08 | 0.00 | 5000.00 |
| 1150040008 | CNY | 2026-06 | 0.00 | 0.00 |
| 60 | CAD | 2020-04 | 0.00 | 67298.74 |
| 1150040002 | USD | 2023-12 | 0.00 | 30.00 |
| 66 | CAD | 2020-10 | 0.00 | 8544.14 |
| 85 | CAD | 2022-04 | 0.00 | 305.65 |
| 123 | CAD | 2023-09 | 0.00 | 1299563.73 |
| 1150040011 | CAD | 2026-10 | 0.00 | 0.00 |
| 1150040007 | CAD | 2026-06 | 0.00 | 1000.00 |
| 121 | CAD | 2026-09 | 0.00 | 0.00 |
| 1150040006 | CAD | 2026-05 | 0.00 | -100.00 |
| 90 | CAD | 2023-11 | 0.00 | 0.00 |
| 53 | CAD | 2023-08 | 0.00 | 0.00 |

Card anchors use amount owed. Account mirror CurrentBalance has the opposite sign for cards. USD/CNY/AUD amounts are never replaced with CAD report amounts.

## The five adjustments

All five are report-only Sales Tax Adjustment postings to **CAD Chequing account 60**. The mirrored entity records and retained evidence do **not** contain their counterpart-account postings. That part of the requested investigation remains unavailable under the no-QBO-call boundary; no counterpart account is invented.

| Adjustment | Book date | Posting to account 60 | Decision | Simulated posting period |
|---|---|---:|---|---|
| 91 | 2020-09-30 | +500.00 CAD | Explicit simulated bank line; native inspection required | 2020-10 |
| 93 | 2020-09-30 | +500.00 CAD | Explicit simulated bank line; native inspection required | 2020-10 |
| 94 | 2020-09-30 | +2,000.00 CAD | Explicit simulated bank line; native inspection required | 2020-10 |
| 97 | 2020-12-31 | +100.00 CAD | Explicit simulated bank line; native inspection required | 2021-01 |
| 98 | 2020-12-31 | -50.00 CAD | Explicit simulated bank line; native inspection required | 2021-01 |

Net: +3,050.00 CAD. Excluding these nonzero bank postings would leave an unexplained book/statement difference. Each receives one reconstructed simulated line referencing its existing TaxAdjustment ID; **no new bookkeeping is proposed or executed**. The original BF1 posting-lag policy determines its simulated posting period. Outstanding items explain the intervening September/December difference. Missing counterparts remain explicit native-action blockers on the two posting periods, rather than an unclassified event poisoning every later opening.

## Implementation boundary

- Added pure `buildBankStatementEvidence(history, retained)` in [bank-statement-evidence.js](../../backend/src/modules/bank-statement-evidence.js). It verifies source/scope/currency/hash/cutoff consistency, derives all 16 openings, classifies only explicitly evidenced adjustments through the existing BF1 converter, and builds native book balances for all periods.
- Minimal locked change to [bank-statement-package.js](../../backend/src/modules/bank-statement-package.js): accept `options.balanceEvidence`; require the exact settlement-snapshot hash; expose source evidence and cashbook balances; block readiness unless settled closing plus signed outstanding items equals retained book closing. Existing manual opening inputs remain supported; they cannot override a bound evidence bundle.
- Caller sequence: `const {dataset,evidence}=buildBankStatementEvidence(history,retained); generateBankStatementPackages(dataset,{balanceEvidence:evidence});`.
- Prepared and tested outside `backend/src`, then saved both production modules in one final batch under the shared package-file lock. BF3 files, source contracts, routes, persistent services and databases were not changed.

## Why seven packages stay draft

| Account | Periods | Reason |
|---|---|---|
| 60 | 2020-07, 2020-08 | Existing R marks require native inspection |
| 60 | 2020-10, 2021-01 | Five report-only adjustment lines require native inspection/counterpart evidence |
| 66 | 2023-08, 2024-02 | Existing R marks require native inspection |
| 85 | 2022-04 | Existing R mark requires native inspection |

The other 317 packages have no remaining generator blockers. This does not grant native execution authority or certify live company state.

## Verification and retained artifacts

From `backend/`, one file at a time, after the final source batch:

- `node --test test/bank-statement-evidence.test.js`: **7 passed**, zero failed.
- `node --test test/bank-statement-package.test.js`: **9 passed**, zero failed, including in-memory BF4 registration/revision compatibility.
- Staged `node --check` for both production modules: passed; final bytes match the checked staging files.
- `git diff --check`: passed. No full suite, QBO request, database write, service command, commit or push.

The first new-test invocation omitted the staging preload and failed with MODULE_NOT_FOUND before source was installed. It was rerun with the staging preload successfully; both saved-production test commands above then passed normally.

Private ignored evidence: [replay-result.json](../../artifacts/goal-realization/job-ob-20261101/replay-result.json), [balance-evidence.json](../../artifacts/goal-realization/job-ob-20261101/balance-evidence.json), [test-results.json](../../artifacts/goal-realization/job-ob-20261101/test-results.json). The private packages directory retains all 324 PDFs, 324 manifests and 82 CSV files, including drafts. Reproduce offline with `node ../artifacts/goal-realization/job-ob-20261101/replay.cjs` from `backend/`; existing differing artifact bytes are refused.

All owned changes remain uncommitted on main as requested. No independent specialist review was required: this change is confined to pure offline statement conversion/export, with no auth, route, runtime writer, QBO client or database mutation changes. Native tax-counterpart inspection and R-mark handling remain for the separately authorized native workflow.
