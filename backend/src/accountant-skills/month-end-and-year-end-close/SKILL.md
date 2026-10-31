---
name: month-end-and-year-end-close
description: Executable monthly and fiscal year-end close: general-tool accruals and next-day reversals, prepaid amortisation, report tie-outs, calendar verification and owner/manual reconciliation and closing-date items. Use when the last open day of a month or the first day after it arrives, calendarClose is due, or an adjusting schedule is due.
---

# Monthly and fiscal year-end close

Read qbo-api-records for units, execution, recovery and guard limits. Recipes are checked against the 2026-10-31 tool contracts, **not live-verified accounting results**. General JournalEntry supports balance-sheet accounts for non-inventory adjustments; fixed v8 journal-entry is only an income/expense reclassification.

## Three distinct outcomes

1. **API accounting work:** create dated balanced adjustments, inspect balances and reports, retain evidence.
2. **App calendar verification:** prepare and execute one elapsed month (or shorter in-month period) with its native proof gates. This is not bank reconciliation or a QBO closing date.
3. **Owner/manual work:** bank/card reconciliation, closing date, filings and tax-centre work. Record those as open until the owner supplies evidence.

Never equate a successful journal, a balanced trial balance or a calendar close with reconciled books.

## Last open day, before that date is verified

- Resolve unfinished operations and any unknown writes first. Inspect owner holds, business calendar, sync and budget.
- Read the adjustment register: accrual amount/basis/accounts/reversal date; prepaid original Bill/Purchase ID, service dates, original asset cost, amount released so far, remaining balance and next release; any approved depreciation/deferred-revenue schedule.
- Compare to source bills, service obligations and actual reports. Use existing accounts by ID, with correct account type. If genuinely absent, schema-check and create an Account under the published business purpose (Expense, Other Current Asset for prepaid, Other Current Liability for accrual), then verify it. Do not create tax or inventory postings.
- Post necessary adjustments **today**, before today's native verification. No backdated creates: if month-end is already verified/past, record a dated exception and only make a justified current-day adjustment. Do not describe it as a restatement of the closed month.
- Do not accrue a cost already billed; do not amortise an asset beyond its remaining cost. Use net expense amounts; tax belongs on the source supplier transaction under published tax codes, not an estimated tax journal.

## Accrual and explicit next-day reversal

Example: $600 services consumed this month, supplier bill expected next month.
```json
{
  "decisionKey":"close_202610_utilities_accrual",
  "purpose":"Accrue services consumed this month but not yet billed",
  "operations":[{
    "ref":"accrual","op":"create","entity":"JournalEntry",
    "payload":{
      "TxnDate":"<TODAY>","PrivateNote":"October utilities estimate; reverse next open day",
      "Line":[
        {"Amount":600,"Description":"Service consumed, invoice pending","DetailType":"JournalEntryLineDetail",
         "JournalEntryLineDetail":{"PostingType":"Debit","AccountRef":{"value":"<EXPENSE_ACCOUNT_ID>"},"ClassRef":{"value":"<CLASS_ID>"},"DepartmentRef":{"value":"<LOCATION_ID>"}}},
        {"Amount":600,"Description":"Accrued utilities liability","DetailType":"JournalEntryLineDetail",
         "JournalEntryLineDetail":{"PostingType":"Credit","AccountRef":{"value":"<ACCRUED_LIABILITY_ID>"},"ClassRef":{"value":"<CLASS_ID>"},"DepartmentRef":{"value":"<LOCATION_ID>"}}}
      ]
    }
  }]
}
```
Call manageQboRecord. Confirm the saved JournalEntry ID and both GeneralLedger postings; retain basis, amount, accounts, original ID and reversal due date. A reversal is **not automatic** and is not sent with a future TxnDate.

On the first open day of the next month, use the same shape with **PostingType swapped on both lines**, TxnDate today, a distinct key such as `reverse_20261101_oct_utilities`, and PrivateNote naming the original ID. Re-read the original and register first to prevent duplicate reversal. This creates a new JournalEntry; it does not edit verified history. Verify the accrual account nets to zero for this pair.

Record the actual supplier Bill normally when it arrives (expense debit and tax via purchase code), then settle it on terms. With the reversal, the full expense is not counted twice. If the bill never arrives, investigate the estimate rather than silently re-accruing it forever.

## Prepaid purchase and monthly amortisation

For annual cover paid in advance, code the **source** Bill or Purchase to prepaid asset rather than expense. General Purchase example:
```json
{
  "decisionKey":"prepaid_20261031_annual_cover",
  "purpose":"Annual cover paid upfront and recognised over its service period",
  "operations":[{
    "ref":"prepaid-cost","op":"create","entity":"Purchase",
    "payload":{
      "TxnDate":"<TODAY>","PaymentType":"Check",
      "AccountRef":{"value":"<PAYING_BANK_ID>"},
      "EntityRef":{"type":"Vendor","value":"<VENDOR_ID>"},
      "GlobalTaxCalculation":"TaxExcluded",
      "Line":[{
        "Amount":1200,"DetailType":"AccountBasedExpenseLineDetail",
        "AccountBasedExpenseLineDetail":{
          "AccountRef":{"value":"<PREPAID_ASSET_ID>"},
          "TaxCodeRef":{"value":"<PUBLISHED_PURCHASE_TAX_CODE_ID>"},
          "ClassRef":{"value":"<CLASS_ID>"}
        }
      }],
      "DepartmentRef":{"value":"<LOCATION_ID>"},
      "PrivateNote":"Annual cover; retain exact service dates and amortisation schedule"
    }
  }]
}
```
Use only the supported tax treatment for that supplier charge. If already booked correctly, reuse its saved ID instead of purchasing it again. Never silently edit an old expensed charge into a prepaid.

At each service month-end, create a JournalEntry using the accrual example's line shape: **Debit expense $100; Credit prepaid asset $100**, both dated today, naming the original source ID and release period in PrivateNote. This illustrative $1,200/12 schedule assumes twelve equal service months; use the actual schedule/proration and true asset balance. Final release is the remaining cents. Verify after each release; advance the schedule only on confirmed save. No release before service starts and no reversing journal for ordinary prepaid amortisation.

Deferred revenue or book depreciation can use the same balanced JournalEntry pattern only with a supported retained service/asset schedule and non-inventory accounts. Do not invent capital allowances, payroll calculations or tax provisions.

## Review checklist with direct evidence

Discover report tools once: `searchTools({query:"select:runReport,getEntityDetail"})`.
Example calls through `useTool`:
```json
{"name":"runReport","input":{"report":"ProfitAndLoss","startDate":"<MONTH_START>","endDate":"<MONTH_END>","accountingMethod":"Accrual","summarizeColumnBy":"Total"}}
{"name":"runReport","input":{"report":"BalanceSheet","reportDate":"<MONTH_END>","accountingMethod":"Accrual"}}
{"name":"runReport","input":{"report":"GeneralLedger","startDate":"<MONTH_START>","endDate":"<MONTH_END>","accountingMethod":"Accrual"}}
```
Page reports with returned nextOffset as rowOffset; retain dates, basis and whether all pages were read. Incomplete/truncated reports are unverified evidence. Prefer local queries for routine details before spending live report requests.

| Review | Evidence and action |
| --- | --- |
| Completeness | Saved record IDs, known outcomes, no unresolved writer/duplicate renewal/reversal; fresh copy through review watermark |
| Trial balance | TrialBalance as of month-end; debits = credits, then compare control accounts to BalanceSheet; balance alone cannot prove correct coding |
| Cash / clearing | Bank GL vs available statement totals; Deposit links and Undeposited Funds aged items explained; say reconciliation remains manual |
| Receivables | AgedReceivables / AgedReceivableDetail at month-end vs AR balance; partial balances, open credits and overdue promises explained |
| Payables | AgedPayables / AgedPayableDetail vs AP; unpaid bills and VendorCredit applications traced |
| Adjustments | Accrual liability listing, upcoming reversals, prepaid roll-forward opening + additions - releases = closing GL |
| Sales tax | Published-code source tax totals vs tax-control movements; explain payments/adjustments, do not assert filed status |
| Inventory | Read-only InventoryValuationSummary vs inventory asset GL; flag differences/negative quantities; no general inventory fix |
| Performance | ProfitAndLoss vs prior month/year, revenue/service-period cut-off, material swings; CashFlow where useful |
| Dimensions | ProfitAndLoss summarizeColumnBy Classes / Departments; explain unclassified amounts rather than relabel verified history |

Record each variance and disposition with `recordBusinessDecision({issueKey:"close-2026-10-review",title:"October close review",detail:"Report dates/basis, IDs, tie-outs, variances, pending owner items and next action",requiresOwner:false,area:"accounting"})`. A checklist item is passed only with evidence; missing report access or factual input remains open. Merge a short next-action handoff via rememberBusinessContext.

## App calendar verification

When context.calendarClose names an elapsed period, recover unfinished work first. Call `prepareBusinessPeriod({throughDate:"<LAST_ELAPSED_DATE>"})`, inspect the saved plan, then `executeBusinessPeriod({operationId:"<RETURNED_ID>",planHash:"<RETURNED_HASH>",reason:"Verify this elapsed period after reviewing its accounting evidence"})`. ThroughDate is yesterday or earlier, at most 31 days and never across a calendar month-end; shorten within the month if capacity requires it.

Calendar-close priority does not license a missed backdated adjustment. Finish last-day adjustments on that day; next-day reversals are created on the next day after the prior period's required proof. Respect native refusal/dirty-period gates rather than claiming the date advanced.

## Fiscal year-end and owner/manual list

Read `getEntityDetail({type:"CompanyInfo",id:"1"})` and verify FiscalYearStartMonth; September in older profile notes is not current evidence. Perform the full monthly review plus annual prepaid/accrual roll-forwards, fixed-asset additions/depreciation schedule, bad-debt evidence, inventory count evidence and owner/shareholder balances. Read reports in complete supported date windows and compare consistently. Do not manually zero income/expense to retained earnings; check QBO's year transition reports. Book-to-tax adjustments need an approved basis, not a guessed tax entry.

Create stable owner items once and retain unresolved status:
`recordBusinessDecision({issueKey:"manual-bank-recon-2026-10",title:"Owner bank reconciliation for October",detail:"Account <ID>, statement end <DATE>; API review completed only to the stated extent. Complete reconciliation in QuickBooks and retain evidence.",requiresOwner:true,area:"accounting"})`.

| Owner/manual item | Accountant can supply | Completion it must not claim |
| --- | --- | --- |
| Bank and credit-card reconciliation | Ledger/deposit/statement comparison and exceptions | Reconciled status or cleared transactions |
| Closing date / password | Reviewed through-date and unresolved close exceptions | Closing date set; Preferences closing-date writes are refused |
| GST/HST filing / tax-centre payment workflow | Tax review, balances and exceptions | Filed return, remittance or tax-centre completion |
| Physical inventory count / external year-end facts | Variances and records to check | Owner factual attestation or an API stock adjustment |

Manual work is an owner item, not a missing API capability request. Continue independent accountant duties under the existing authority; respect explicit owner/protected-period holds.
