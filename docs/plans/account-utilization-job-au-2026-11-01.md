# Account utilization — job AU, 2026-11-01

Outcome: every active bank, card and cash account has explicit measured weekly use and applicable support situations; reconciliation remains honest about API visibility. Essential task. Started 2026-11-01T04:00:12.329Z.

Smallest proof: replay the real scoped CompanySyncRecord snapshot through getMirrorCoverage and general-write preparation offline with transport disabled. No QBO calls, DB writes, commits or service controls. Backend source will be saved in one final locked batch.

Owned scope: business-account-coverage.js (new), business-situation-catalog.js, business-weekly-breadth.js, qbo-entity-schema.js, general-write-guards.js, general-write-currency.js if required; banking, daily review, running-business and multicurrency skills; dedicated AU tests. Preserve parallel V/FX/RG2 edits.

Work-value checkpoint: real snapshot captured, 11,493 rows; only account 123 used in trailing seven days (60 records); 15 other cash/bank/card accounts unused. Continue essential catalog and offline replay. Raw snapshot stays private in temporary storage.

Work-value checkpoint 2026-11-01T04:04:39.886Z: stored-data replay exercises the route scorer and actual general-write prepare/context. First run identified a scratch-only new-module resolution issue; corrected. 79 focused checks passed; one replay assertion exposed an incorrect expected account total (16, not 17), corrected without changing measurement. Essential work continues through reviews and final batch.

Work-value checkpoint 2026-11-01T04:11:41.579Z: core stored-data and banking integration replay passed 162 checks (one BK1 private replay skipped at that pass). Scope extended only to documented native card payments after finding Intuit SDK CreditCardPaymentTxn evidence. Native amounts, account types, CAD-only guards, wrapper recovery and ledger mapping reviewed. Final replay includes BK1 private retained banking evidence. No live data delivery claimed or attempted.

## Before: scoped synced-copy replay

Production company ending 2856, connection ending 3e03. Private snapshot captured 2026-11-01T04:00:12.329Z; 11493 records. Inclusive windows: 2026-10-26–2026-11-01 and 2026-10-03–2026-11-01. Counts deduplicate account references per transaction, and scan nested references; they are not native GL row counts. Snapshot collection and source-state reads are not an atomic database snapshot.

| Account (ID; currency) | All retained references | Last 7 days | Last 30 days | Retained transaction types |
| --- | ---: | ---: | ---: | --- |
| capital one (1150040000; CAD) | 0 | 0 | 0 | None |
| Chequing USD (1150040002; USD) | 2 | 0 | 0 | BillPayment 1, Payment 1 |
| Amex 1234 (1150040005; CAD) | 1 | 0 | 0 | Purchase 1 |
| Test Credit Union (1150040006; CAD) | 0 | 0 | 0 | None |
| Savings (1150040007; CAD) | 1 | 0 | 0 | Transfer 1 |
| checking (1150040008; CNY) | 0 | 0 | 0 | None |
| money (1150040011; CAD) | 0 | 0 | 0 | None |
| Cash on hand (120; CAD) | 0 | 0 | 0 | None |
| Square deposit account (121; CAD) | 0 | 0 | 0 | None |
| Harbour & Pine Operations Inc. - Operating bank (123; CAD) | 3533 | 60 | 106 | BillPayment 670, Deposit 1376, Payment 923, SalesReceipt 564 |
| Tips from customers (53; CAD) | 0 | 0 | 0 | None |
| Chequing (60; CAD) | 219 | 0 | 11 | BillPayment 14, Deposit 56, Invoice 1, Payment 23, Purchase 105, RefundReceipt 3, SalesReceipt 13, Transfer 4 |
| Chequing XYZ (66; CAD) | 6 | 0 | 0 | Deposit 1, Payment 3, SalesReceipt 1, Transfer 1 |
| Cash on hand AUD (68; AUD) | 2 | 0 | 0 | Deposit 1, JournalEntry 1 |
| Credit Card (85; CAD) | 5 | 0 | 0 | BillPayment 1, Purchase 2, Transfer 2 |
| tey (90; CAD) | 0 | 0 | 0 | None |

No cleared/reconciled flags are present in these mirrored transaction rows. Missing flags mean unknown. The original snapshot has no CreditCardPayment or TaxPayment source; counts are observed lower bounds and absence cannot be certified. BK1 owns source backfill and canonical response aliases. Its separately retained native audit identifies card payment 483 (2026-05-18, CAD 100, bank 1150040006 -> card 1150040005), explaining the additional native bank/card entries. BK1 native feature marks (13 R / 20 C) are not mirror flags or completed reconciliation proof.

## Delivered code behavior

- Dynamic catalog expands to 262 per-account situations across 16 bank/card/cash accounts; 166 are reachable with current governed contracts, subject to current data/settings/eligibility. 80 per-account native UI states/checklists remain unknown/manual. Missing sources or scan caps explicitly prevent absence claims.
- Every active account gets weekly-use, applicable deposits/withdrawals/cheques, transfer directions, card charges/credits/payments, fees/interest, Square net settlements, petty cash/tips, and foreign rate evidence. Monthly interest/card payments use a 35-day freshness window instead of becoming artificial weekly mandates. Opening/inactive/zero-balance states are retained honestly.
- Native CreditCardPayment: create-only CAD bank -> CAD card, positive exact Amount; bank/card types, malformed refs, earlier-create placeholders, money caps, protected dates, receipts, identity/recovery, full responses and GL posting rules remain governed. JSON wire/response is CreditCardPaymentTxn, REST is creditcardpayment. Foreign native card payment, editing and deletion remain held. Transfer is still an alternative.
- Purchase Cash/Check requires Bank; CreditCard requires Credit Card. Credit:true uses positive line amounts and is restricted to card refunds. Non-inventory foreign Purchase uses observed dated exchange rates and matching payment currency; category routes cannot bypass AR/AP settlements or bank/card transfers. Existing foreign Transfer/Deposit and net-fee Deposit remain governed.
- Skills deliberately rotate all accounts with medium-business amounts and monthly payment/interest timing. Reconciliation is a feature-test checklist in existing visible coverage text, not a fabricated bank statement match.

## Documentation and proof

Intuit sources checked 2026-11-01: [native card-payment schema](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPCreditCardPaymentTxn.php), [SDK endpoint mapping](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/DataService/DataService.php), [Purchase schema including PaymentType/Credit and inherited ExchangeRate](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/Purchase.html), [Transfer properties](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/906fa304-2f7c-0f3a-86c5-a668f5b0597b.htm), [Deposit API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit), [Exchangerate API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/exchangerate), [reconciliation read limitation](https://help.developer.intuit.com/s/question/0D5TR00000KQGyp0AH/is-it-is-possible-to-query-reconciliation-status-if-so-please-advise-where-to-find-thisthank-you), [no reconciliation action API](https://help.developer.intuit.com/s/question/0D54R000074DKlvSAG/is-there-an-internal-api-used-by-intuit-not-available-for-public-use-that-can-connect-with-the-reconciliation-functions). Current API reference pages for several banking entities returned a sign-in/compiling shell; the official SDK primary sources supply the exact native schema. No unsupported cleared-status fields or Reconcile action were enabled.

Real stored replay: 11,493 rows through coverage.getMirrorCoverage; real Payment 11089 (CAD 169.86, Undeposited Funds 5) through general-write preparation into Square account 121 net of CAD 3 fee (166.86 bank / 169.86 clearing / 3 expense). Stored account IDs/currencies through createGeneralWriteContext + createGeneralWriteService.prepare for CAD purchases/credits/card payments and USD/CNY/AUD purchases/transfers/deposits. Exchange-rate API is replaced by explicit offline test observations (USD 1.4, AUD 0.9, CNY 0.2), not claimed as live rates. Native card-payment wrapper/amount/account/protected-period/recovery checks use mocked responses; no QBO transport occurred.

Independent read-only implementation and safety reviewers found and resolved void/zero-use counting, invisible checklist text, stale skills/cadence, foreign category bypass, native response aliases and placeholder account typing. Native QBO saves/GL behavior and rendered UI remain unverified live.

Owned source files:

- `backend/src/modules/business-account-coverage.js`
- `backend/src/modules/business-situation-catalog.js`
- `backend/src/modules/business-weekly-breadth.js`
- `backend/src/modules/qbo-entity-schema.js`
- `backend/src/modules/general-write-guards.js`
- `backend/src/modules/general-write-currency.js`
- `backend/src/accountant-skills/banking-and-deposits/SKILL.md`
- `backend/src/accountant-skills/daily-management-review/SKILL.md`
- `backend/src/accountant-skills/running-a-medium-sized-business-day/SKILL.md`
- `backend/src/accountant-skills/multicurrency/SKILL.md`
- `backend/src/accountant-skills/support-scenarios-for-troubleshooting/SKILL.md`
- `backend/src/modules/general-write-postings.js`
- `backend/src/modules/general-write-merge.js`
- `backend/src/modules/general-write-transport.js`
- `backend/src/modules/general-write-recovery.js`
- `backend/src/modules/qbo-write-contract.js`
- `backend/src/modules/qbo-write-period.js`
- `backend/src/modules/general-write-service.js`
- `backend/src/modules/general-write-day-close.js`
- `backend/src/modules/business-governance-service.js`

Tests: dedicated `backend/test/account-utilization-au.test.js` plus one updated expectation in `backend/test/business-situation-coverage.test.js` (foreign Bill is already reachable). Parallel BK1/RG2 source edits preserved, including source aliases, TaxPayment dates and replay capture wrappers.

## Final verification

Recent type breakdown:

Harbour & Pine Operations Inc. - Operating bank (123): last 7 days BillPayment 6, Deposit 52, SalesReceipt 2; last 30 days BillPayment 14, Deposit 71, Payment 11, SalesReceipt 10
Chequing (60): last 7 days none; last 30 days Deposit 1, Purchase 10

204 integrated offline tests passed with zero failures/skips before the save, including both private snapshots and preserved RG2 hooks. All 15 owned JavaScript modules passed node --check. Distinct implementation/safety review findings resolved. Source saved once at 2026-11-01T04:13:45.285Z in one batch under basename locks; all 20 files read back exactly. No commits, QBO API calls, MongoDB writes, or manual service controls.

Actual affected command from backend/ (with private replay file environment variables, no provider access):

```text
node --test test/account-utilization-au.test.js test/business-situation-coverage.test.js test/general-write-guards.test.js test/general-write-currency.test.js test/general-write-settlements.test.js test/general-write-gate.test.js test/general-write-service.test.js test/general-write-recovery.test.js test/banking-reconciliation.test.js test/qbo-write-period.test.js test/general-write-capabilities.test.js test/replay-evidence-rg2.test.js
```

A direct installed-source rerun is the final verification; result to be appended.

Direct installed-source verification finished: **204 passed, 0 failed, 0 skipped**, exit 0; 27.9 seconds. Owned git diff --check passed. Branch main...origin/main verified. No AU locks remain. Changes intentionally remain uncommitted; new AU test and this report are untracked. Private replay snapshots/logs remain under the temporary AU/BK1 evidence directories, outside tracked source. No serving source was rewritten after the one final batch.
