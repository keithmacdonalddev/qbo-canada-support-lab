---
name: banking-and-deposits
description: Daily general-tool grouped deposits, Undeposited Funds clearing, net-of-fee processor deposits, bank/card transfers and cash checks; fixed collections deposit automatically. Use when taking payments, grouping remittances, following up undeposited money or preparing close evidence; native banking runs through owner-authenticated browser automation with retained evidence.
---

# Banking and deposits

Read qbo-api-records and support-scenarios-for-troubleshooting for exact general payloads. Source-checked 2026-11-01; **no live banking outcome verified**.

## Daily money-in routine

1. General Payment/SalesReceipt can name the active Undeposited Funds account as DepositToAccountRef. Fixed sales/collections already create their own Deposit; never deposit those again.
2. Inspect actual saved receipt totals and existing Deposit links with queryCompanyData mode links (or getTransactionChain). Stale/incomplete copy is not proof a payment is undeposited.
3. Group genuine undeposited receipts into one Deposit, with one full-amount line per receipt. No partial depositing and no duplicate source links.
4. Verify the saved Deposit, receipt backlinks, clearing reduction and bank ledger movement. Record any short intentional holding interval and the planned deposit date; investigate unexplained old clearing balances.
5. Same-day clearing is the default; temporary holding is for a genuine bank batch/teaching lifecycle, not a growing unexplained asset.

Example manageQboRecord input:
```json
{
  "decisionKey":"bank_deposit_20261031_group1",
  "purpose":"Group today's two customer remittances into the operating bank deposit",
  "operations":[{
    "ref":"deposit","op":"create","entity":"Deposit",
    "payload":{
      "TxnDate":"<TODAY>","DepositToAccountRef":{"value":"<BANK_ID>"},
      "DepartmentRef":{"value":"<LOCATION_ID>"},
      "Line":[
        {"Amount":100,"LinkedTxn":[{"TxnId":"<PAYMENT_ID>","TxnType":"Payment","TxnLineId":"0"}]},
        {"Amount":200,"LinkedTxn":[{"TxnId":"<SALES_RECEIPT_ID>","TxnType":"SalesReceipt","TxnLineId":"0"}]}
      ]
    }
  }]
}
```
Replace example amounts with each receipt's actual tax-inclusive TotalAmt. The Deposit's computed total is $300 only for these example amounts; do not send TotalAmt.

## Fees, transfers and cash

For a Square/merchant settlement use full linked undeposited Payment/SalesReceipt lines plus a negative DepositLineDetail fee line: {Amount:-3,DetailType:"DepositLineDetail",DepositLineDetail:{AccountRef:{value:"<ACTIVE_FEE_EXPENSE_ID>"}}}. The net total must stay positive. This fee shape accepts no tax override; post taxable fees separately with the published purchase tax code. Verify gross clearing, fee expense and net bank movement; never deposit a source twice. This negative expense-line shape is supported by the current app guards. Native bank-feed matching of the net payout is unverified until the exact company preview and saved Match evidence are retained. A fee already included in the net Deposit must not produce another bank-origin fee, Purchase or withdrawal. Stored Deposit 208 illustrates $113 from Payment 206 less $10 fee = $103 bank movement.

General transfer:
`manageQboRecord({decisionKey:"transfer_20261031_bank_card",purpose:"Pay down the company credit card from available operating cash",operations:[{ref:"card-payment",op:"create",entity:"Transfer",payload:{TxnDate:"<TODAY>",FromAccountRef:{value:"<BANK_ID>"},ToAccountRef:{value:"<CREDIT_CARD_ACCOUNT_ID>"},Amount:500}}]})`.
Use permitted active balance-sheet accounts and verify the two movements. Fixed bank-transfer instead takes fromKey/toKey and amountCents between published bank roles.

General non-inventory JournalEntry can use appropriate loan/equity accounts for a documented business need, with balanced lines; fixed journal-entry cannot. Do not create owner contributions, draws or loans merely for volume, or infer an owner funding fact.

Read cash through synced Account balances and dated BalanceSheet/GeneralLedger reports. Check enough cash for scheduled payables and retained operating buffer before non-critical spending. Report a falling buffer and overdue receipts rather than manufacturing cash.

## Native banking boundary

Load banking-feed-operations for simulated bank-origin advice, creator ownership and the native checklist. Upload, Match/Add/Exclude, bank rules and reconciliation use QuickBooks screens through browser automation logged in as the owner. The Accounting API does not perform these steps. If the banking tool/workspace is not exposed in this run, record an exact capability request; do not claim execution or ask the owner to perform routine work. Never say a statement is matched or the bank reconciled from a Deposit or TrialBalance alone.

## Every account gets a deliberate role

Before the daily plan, page through getCoverageSituations and getWeeklyCoverage. Account.<id>.weekly-use shows every active bank, credit card and cash account individually; the coverage response also measures last 7/30 days by transaction type. Enumerate active Account rows with queryCompanyData, including CurrencyRef, AccountSubType and CurrentBalance. Assign each account a real modeled purpose and a date this week; prioritise accounts with zero weekly use. Never send everything to operating account 123 just because fixed workflows default there. Use manageQboRecord with the measured IDs.

- Cards: rotate supplies ($75–600), fuel ($40–180), subscriptions ($15–300) across Credit Card, Amex 1234 and capital one. Purchase PaymentType CreditCard and AccountRef card; a genuine returned purchase uses Credit:true with positive amounts. Pay the actual statement amount monthly (or a justified partial amount) from a bank using Transfer bank -> card. Alternatively use native CreditCardPayment with TxnDate, BankAccountRef, CreditCardAccountRef and positive Amount; current native governed support is CAD-to-CAD creation only. The SDK wire/response wrapper is CreditCardPaymentTxn. This differs from customer card processing and BillPayment.CreditCardPayment.
- Banks: spread collections and supplier payments across Chequing, Chequing XYZ, Test Credit Union and money according to their assigned roles. Fund an account before spending; keep a cash buffer. Savings sweeps typically $500–5,000 when affordable, with monthly documented interest via Deposit to an actual interest-income account and bank charges via Purchase to a fee expense account. No invented interest amount described as bank-observed.
- Square: receive modeled merchant sales into Undeposited Funds, then Deposit into Square deposit account net of actual modeled fees; sweep available net funds to the operating bank with Transfer. Retain source IDs and settlement reference.
- Cash on hand, tey and AUD cash: funded petty-cash float, small Cash purchases ($5–80), replenishment by Transfer. Tips from customers: Deposit to cash with the real tips-liability counterpart, then Cash Purchase to the same liability for payout; do not call tips revenue or create a second expense. Use the correct Canadian tax policy for each line, including out-of-scope when applicable.
- Foreign: Chequing USD supplier bills/payments in USD; CNY checking and AUD cash receive/deploy modest modeled foreign funds. Load multicurrency: use their CurrencyRef, same-currency parties/payment accounts and a dated observed ExchangeRate (CAD per foreign unit); never guess rates or transfer directly between two different foreign currencies. Foreign Purchase supports non-inventory cash/check/card activity with the same-currency payment account. Foreign Transfer and Deposit already have governed rate/posting checks.

Support breadth is an explicit business purpose in this simulated company: deliberately schedule applicable deposits, cash/cheque withdrawals, transfers both ways, card refunds, bank fees, interest, petty cash and tips even when ordinary operations would not naturally create them. Record why, realistic amounts, record IDs and follow-up. This authorises no fabricated external bank evidence, unsupported shapes, duplicate settlements or protected-history edits. Keep zero-balance, opening and inactive accounts visible as support states; never invent opening equity or deactivate an operating account just to fill a gap.

## Reconciliation feature tests in QuickBooks UI

Get the per-account reconciliation situation checklist: exact account ID/name, statement date, synced account-currency ending balance and UI steps. Those balances are simulated statement targets, not external bank statements or reconstructed historical balances. Recheck the register before use because the business continues operating. Only QuickBooks UI can create/attest blank/C/R states, incomplete reconciliation, discrepancy and completed reconciliation report evidence; the Accounting API does not expose a Reconcile operation or supported read/write reconciliation status. Keep these as **needs native browser evidence** and unknown until native evidence is retained. Never use a balanced trial balance, Deposit, or absent flag as reconciliation proof.

Intuit references checked 2026-11-01: [Purchase](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchase), [Deposit](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit), [Transfer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/transfer), [exchange rates](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/exchangerate), [reconciliation visibility](https://help.developer.intuit.com/s/question/0D5TR00000KQGyp0AH/is-it-is-possible-to-query-reconciliation-status-if-so-please-advise-where-to-find-thisthank-you).

Native card-payment schema/endpoint evidence: [Intuit SDK transaction shape](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPCreditCardPaymentTxn.php), [Intuit SDK REST endpoint mapping](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/DataService/DataService.php).
