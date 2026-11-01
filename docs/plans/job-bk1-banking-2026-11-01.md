# BK1 banking reconciliation fixes

Started 2026-11-01T04:01:48.886Z. Essential: unblock complete bank/card/cash historical coverage without claiming completed reconciliations. Smallest proof: replay the retained 16-account/3,789-row banking audit and scoped Mongo mirror through the production period review and sync paths offline. No QBO calls, database writes, service control, commits or pushes.

Plan: stage sync sources, coverage, versioned account-currency/cash-count evidence, and PeriodClose UI in scratch; preserve v1 historical decision validation; test and obtain independent reviews before one final source batch. Existing 13 R / 20 C owner feature-test marks remain untouched and cannot establish business reconciliation. Full CSV/statement generation and native import/reconciliation remain outside BK1.

Completed source batch: 2026-11-01T04:08:55.877Z–04:08:55.881Z (10 files, locks acquired/released). Main checkout, no commits or pushes as requested. Read-only scoped Mongo query returned all 130 Account records; connection closed. No QBO calls, database writes or persistent service control by BK1.

Findings and changes:
- Native CreditCardPayment 483 (bank 1150040006 / card 1150040005, 100.00) and 13 TaxPayment records were absent from sync. Added both canonical sources. Native query key CreditCardPaymentTxn is normalized in sync and legacy AI coverage without creating duplicate identities. Zero TaxPayment 576 remains represented. TaxPayment dates/amount summaries use PaymentDate/PaymentAmount. CreditCardCredit is already Purchase with Credit=true; Transfer/Deposit/Purchase/Payment/BillPayment/SalesReceipt/RefundReceipt/JournalEntry/VendorCredit/Invoice were already mirrored. Invoice 486 has a 50.00 deposit, not its 94.56 full invoice amount: a future generator must retain this distinction.
- Existing governed sync automatically bootstraps any missing source cursor with a paged full read, then CDC catchup, before declaring current. This is the one-time historical backfill; no new migration or direct DB write. It retains existing scope, lease/authorization, request budget, overlap, cursor and tombstone rules. Its actual live run remains unverified.
- New v2 period evidence binds account currency/type to the freshly observed inventory and home currency to observed preferences. Reconciliation arithmetic is in the account currency. Dated home equivalents and their source reference are retained separately and informational; revaluation never enters the native difference. No exchange rate is guessed from CurrentBalance. The real USD account 1150040002 is 30.00 after -1100/+1130, not the CAD equivalents. AUD cash account 68 is 5000.00; adjustment 200 is +86.84 CAD with zero AUD movement.
- CashOnHand subtype selects cash-count for accounts 120,68,90,53 (Cash on hand, Cash on hand AUD, tey, Tips from customers). Cash counts require direct counted-cash versus dated cashbook agreement; bank timing items are rejected.
- New checks require explicit FX/feature-mark exclusion attestations. Native R/C marks are neither modified nor used as completion evidence. All 13 R / 20 C marks remain unchanged in the real replay; no historical month is waived or claimed reconciled.
- The all-account, zero-difference company-wide reconciliation gate remains. Fresh v1 record/close requests are rejected before SDK reads, closing the stale-client bypass found independently. Retained v1 inventory/decision proof and exact applied/cancelled recovery remain compatible.
- Desktop PeriodClose form shows the account currency, cash-count labels, home equivalents/reference and exclusion confirmations. It still retains references rather than statement files, and explicitly describes matching as manually attested.

Owned files:
- backend/src/modules/business-agent-sync.js
- backend/src/modules/business-situation-catalog.js
- backend/src/modules/business-weekly-breadth.js
- backend/src/modules/business-company-query.js
- backend/src/modules/coverage.js
- backend/src/modules/period-close-reader.js
- backend/src/modules/period-close-contract.js
- backend/src/modules/period-close-service.js
- backend/src/modules/period-close-proof.js
- frontend/src/components/PeriodClose.jsx
- backend/test/banking-reconciliation.test.js
- backend/test/helpers/period-close-fixture.js
- backend/test/period-close.test.js
- docs/plans/job-bk1-banking-2026-11-01.md

Verification:
- Against saved source from backend/: node --require ../artifacts/goal-realization/bk1-banking-replay-preload-20261101.cjs --test test/banking-reconciliation.test.js test/business-agent-sync.test.js test/period-close.test.js test/period-close-routes.test.js test/coverage.test.js test/business-company-query.test.js test/business-local-reads.test.js. Equivalent temporary preload was used for the observed run: 124 passed, 0 failed, 0 skipped. This includes seven new tests, real-data service.review through the original SDK GET path with mocked transport/in-memory adapters, v1 historical proof/retry, both alias readers, backfill restart and no-repeat queries, home/FX/currency binding and mark preservation.
- Broader affected set including business-situation-coverage.test.js: 147 passed, 1 failed, 1 skipped. The failed assertion at line73 expects foreign Bill writing to be reachable; it was concurrently changed by another job and fails identically against source without BK1 changes. Preserved that job's test. No unrelated implementation fix made.
- node scripts/agent-harness/check-backend-syntax.mjs: passed.
- Frontend vite build (same script as npm run build --workspace=frontend): passed; existing >500kB chunk warning. Frontend eslint . (same as npm run lint --workspace=frontend): passed, 0 errors / 3 warnings. Full scratch build/lint also passed before source save.
- git diff --check: passed.
- Distinct read-only implementation and safety reviews found the alias-reader and v1 downgrade gaps; both were fixed and re-reviewed with no unresolved findings. Reviewers made no edits or live calls.
- Desktop local fixture build succeeded, but browser URL policy rejected file:// navigation. No workaround attempted. Rendered desktop inspection is unverified. Actual form read/submit was not driven because account reads call QBO, forbidden for BK1.

Replay provenance and limits:
- Private ignored inputs: artifacts/goal-realization/bk1-banking-replay-inputs-20261101.json; repeat-run preload beside it. Original banking-research-20261101.json contains 16 accounts and 3789 retained postings, native-currency/home amounts and the owner clarification. The input also retains the read-only 130-account mirror and prior sync cursors. No raw records are in tracked tests or this handoff.
- Real account arithmetic replay uses book-derived audit balances plus synthetic manual report/statement attestations, not independently verified bank statements or actual completed native reconciliation. Missing source parsing/backfill replays use retained audit projections (IDs, dates, amounts, refs), not full raw entity payload metadata. This is not proof that QBO accepts CDC for both sources in this company; source errors must remain visible if it does not.
- Native Sales Tax Adjustment IDs 93,91,94,98,97 are report-only bank postings, absent from the retained entity mirror. Do not claim all bank movements are mirrored or use entity coverage alone to generate statements. A future complete banking generator needs ledger/report evidence for these and must distinguish invoice deposits, undeposited receipts, voids and FX-only postings. CSV/statement generation, import tracking and native reconciliation execution remain outside BK1.

Work-value ledger:
- Essential issue: complete historical banking prerequisites. Started 2026-11-01T04:01:48Z; milestone at 04:08:55Z delivered reviewed source and real-data offline replay. No live company records or periods delivered because this job is explicitly read-only operationally. Continue decision: finish non-live closeout; defer native CDC and rendered proof to authorized orchestrator.
- Rendered local fixture: browser blocked file protocol. Decision: stop at policy boundary; retain build/fixture evidence and report rendering unverified. No service started to work around it.
