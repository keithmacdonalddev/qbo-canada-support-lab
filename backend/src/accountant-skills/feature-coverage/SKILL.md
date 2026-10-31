---
name: feature-coverage
description: Weekly record and lifecycle coverage using general governed writes plus fixed v8 workflows; distinguishes supported non-stock records/dimensions from refused prepayments, inventory limits and manual work. Use in daily management review and before choosing underused features for the next slice.
---

# Feature coverage from actual records

Use context.management, getBusinessWork and fresh queryCompanyData results. Capability descriptions, skill recipes and planned counts are not saved-record proof. Older Not built labels must be checked against the currently supplied tools and guard.

Source-checked 2026-10-31; recipes remain **unverified live** until actual record/link/report evidence exists.

| Area | Available path | Limits to retain |
| --- | --- | --- |
| Service sales | Fixed v8 quotes, time, terms/settled invoices; general Invoice, Estimate, TimeActivity, SalesReceipt | Actual Estimate/time link must survive readback |
| Collections | Fixed eligible own/adopted collections; general partial/full Payment + grouped Deposit | No unapplied payment/overpayment; don't deposit a receipt twice |
| Credits/refunds | General CreditMemo and later zero-cash Payment application, RefundReceipt; fixed eligible correction workflows | Genuine reason, same customer, open balances; refund alone does not apply open credit |
| Purchasing | General non-inventory PurchaseOrder, partial linked Bill, BillPayment, VendorCredit, Cash/Check/CreditCard Purchase | Fixed stock order/full receipt remains separate; general inventory off for these recipes |
| Close/banking | General balance-sheet JournalEntry, Deposit, Transfer; fixed income/expense reclassification | No tax/inventory journals, no negative deposit lines, no verified-history edits/voids |
| Lists | General Customer, Vendor, Employee, Service/NonInventory Item, Account, Class, Department, Term, PaymentMethod | No opening balances; create only for real demand; employees are not payroll |
| Dimensions | General line ClassRef and supported DepartmentRef | Existing tracking settings, proper field placement and actual saved use |
| Recurring business | Accountant's per-customer renewal register + new dated invoices, due collections and close schedules | No native recurring-template management or future-dated writes |
| Notes | General Attachable note metadata per schema | File upload not enabled; Attachable is not mirrored by queryCompanyData, so don't claim local-copy proof |
| Still missing/held | Unapplied/excess receipts and later application, mixed-tax sales (one runtime sales code), single net fee deposits, general inventory adjustments/returns, unsupported custom fields/projects/budgets/multicurrency | Request only the specific missing capability; CAD only |
| Owner/manual | Bank/card reconciliation, closing date/password, tax filing/tax-centre work, feeds/matching/rules | Record manual items once; never claim API completion |

## Work a gap into normal volume

1. Query the trailing seven days by record type and actual link/dimension fields. Inspect freshness and all pages before saying a feature is absent.
2. Load running-a-medium-sized-business-day and select a genuine due business need with support value. Schedule follow-up, not just initial creation.
3. Use a general payload where fixed choices cannot express a supported shape. Read the entity schema first; never send raw accounting fields to prepareBusinessActivity.
4. Verify actual saved outcomes, links/balances and relevant reports. A non-stock partial receipt proves that non-stock lifecycle only.
5. Re-measure next day; don't create needless lists, transfers, corrections or credits for a coverage count.

Sample coverage query:
```json
{
  "mode":"aggregate",
  "entities":["Invoice","Estimate","TimeActivity","SalesReceipt","Payment","Deposit","Bill","BillPayment","Purchase","PurchaseOrder","CreditMemo","VendorCredit","RefundReceipt","Transfer","JournalEntry"],
  "where":[{"field":"TxnDate","op":"gte","value":"<SEVEN_DAY_START>"}],
  "groupBy":[{"field":"_entity"}],"metrics":[{"op":"count"}]
}
```
For dimensions query sales/expense detail ClassRef and header DepartmentRef, not just Class/Department list counts. Reports need matching postings: BalanceSheet, ProfitAndLoss, TrialBalance, GeneralLedger, CashFlow, AR/AP aging and, where authorized stock exists, InventoryValuationSummary.

## When supplied tools cannot close a gap

Discover getManagementReview and requestCapability, reuse the existing gap key, and give requirement, missing tool/lifecycle, feature, why and priority. Do not repeatedly request tools already supplied by manageQboRecord. Owner/manual facts belong in recordBusinessDecision with requiresOwner true, not a request to build an unsupported API.
