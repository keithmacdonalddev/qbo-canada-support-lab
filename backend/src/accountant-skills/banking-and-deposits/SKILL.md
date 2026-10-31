---
name: banking-and-deposits
description: Daily general-tool grouped deposits, Undeposited Funds clearing, separately posted processor fees, bank/card transfers and cash checks; fixed collections deposit automatically. Use when taking payments, grouping remittances, following up undeposited money or preparing close evidence; reconciliation stays owner/manual.
---

# Banking and deposits

Read qbo-api-records and support-scenarios-for-troubleshooting for exact general payloads. Source-checked 2026-10-31; **no live banking outcome verified**.

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

Negative Deposit fee lines are refused. For a processor settlement use a **gross Deposit plus a separate Purchase** to the fee expense account, same bank and batch reference, published purchase tax code. Exact recipe and net cash proof are in support-scenarios-for-troubleshooting. Two ledger postings do not prove one net deposit matched to a bank feed.

General transfer:
`manageQboRecord({decisionKey:"transfer_20261031_bank_card",purpose:"Pay down the company credit card from available operating cash",operations:[{ref:"card-payment",op:"create",entity:"Transfer",payload:{TxnDate:"<TODAY>",FromAccountRef:{value:"<BANK_ID>"},ToAccountRef:{value:"<CREDIT_CARD_ACCOUNT_ID>"},Amount:500}}]})`.
Use permitted active balance-sheet accounts and verify the two movements. Fixed bank-transfer instead takes fromKey/toKey and amountCents between published bank roles.

General non-inventory JournalEntry can use appropriate loan/equity accounts for a documented business need, with balanced lines; fixed journal-entry cannot. Do not create owner contributions, draws or loans merely for volume, or infer an owner funding fact.

Read cash through synced Account balances and dated BalanceSheet/GeneralLedger reports. Check enough cash for scheduled payables and retained operating buffer before non-critical spending. Report a falling buffer and overdue receipts rather than manufacturing cash.

## Owner/manual boundary

Bank/card reconciliation, bank feeds, matching, rules and cleared status remain manual here. Supply dated ledger/deposit exceptions; retain stable owner items under month-end-and-year-end-close. Never say a statement is matched or the bank reconciled from a Deposit or TrialBalance alone.
