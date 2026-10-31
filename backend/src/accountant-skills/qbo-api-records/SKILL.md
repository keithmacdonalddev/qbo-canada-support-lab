---
name: qbo-api-records
description: QuickBooks API record rules: required fields, LinkedTxn links, terms and due dates, partial and unapplied payments, deposits, SyncToken and sparse updates, void vs delete, batch, faults and fixes. Use before building or troubleshooting a record payload or when a QuickBooks fault comes back.
---

# QuickBooks API records

This company is QuickBooks Online Advanced **Canada**, home currency CAD, multicurrency off, tax calculated by QuickBooks from tax codes (`GlobalTaxCalculation: "TaxExcluded"`). The app's governed tools build and verify most payloads for you; use this skill to choose inputs, read results, explain faults, and use a general record tool correctly.

## The general record tool

`manageQboRecord` (always loaded) creates, updates and deletes any non-inventory record the QuickBooks API allows, in one plan of up to many operations: invoices on terms, partial and full payments, bills and bill payments, estimates, purchase orders, sales receipts, deposits grouping undeposited payments, transfers, journal entries, credit memos, refunds, supplier credits, expenses, time entries, and list records (customers, suppliers, non-inventory items, accounts, terms, payment methods, classes, locations, employees). Use `getQboEntitySchema` (find it with `searchTools`) for an entity's fields and link rules before writing an unfamiliar payload.

- Date every record today. Edits to records in verified history are refused for now.
- Refer to records created earlier in the same plan with `$ref`; the tool orders batches for you.
- A refused operation comes back with its reason: correct that operation and call again with the same `decisionKey`.
- Stock (inventory) items, inventory sales and voids are not available in this version; use the fixed workflows for purchase orders and receiving.
- Prefer it over `prepareBusinessActivity` when the business needs something the fixed workflows cannot shape.

## Rules that apply to every record

1. **References, never names.** Every party, item, account, term, class, location and tax code is a `{ "value": "<Id>" }` ref (an optional `name` is ignored on write). Read ids from `getBusinessActivityChoices`, `queryCompanyData` or `searchEntities`; never invent one.
2. **Money.** Amounts are decimal dollars with two places in QuickBooks; the app's tools take integer **cents** (`amountCents: 12500` = $125.00). Line `Amount` must equal `Qty × UnitPrice` for item lines.
3. **Dates.** `TxnDate` and `DueDate` are `YYYY-MM-DD` business dates (Halifax). Never date a record inside a protected or verified period.
4. **Tax on every sales and purchase line.** Canada requires a `TaxCodeRef` on each item/expense line (or on the transaction for the governed tools). Missing tax gives fault 6000 "Make sure all your transactions have a GST/HST rate before you save".
5. **Doc numbers.** `DocNumber` is free text up to 21 characters; QuickBooks can auto-number sales forms. Duplicates may be refused (6140) depending on preferences.
6. **Names are unique across customers, suppliers and employees** (a supplier cannot share a customer's DisplayName): fault 6240 "Duplicate Name Exists".
7. **Lists are deactivated, not deleted.** Customer, Vendor, Item, Account, Class, Department, Term: set `Active: false` (sparse update). Transactions can be deleted or voided.

## Updates: SyncToken and sparse

- Every update sends `Id` and the current `SyncToken`. If someone changed the record since you read it, QuickBooks returns **5010 Stale Object Error**: re-read, re-decide, resend. Never retry blindly with an old token.
- `"sparse": true` changes only the fields you send. A full update (no sparse) **clears every omitted writable field**, including lines. Prefer sparse; to change lines you must send the complete `Line` array.
- This app never edits an original record that existed before its own work. Corrections are new records dated today (see `correct-own-record` in prepareBusinessActivity).

## Linking (LinkedTxn)

Links make the chains that reports and support cases depend on. Write the link on the **later** record:

| Later record | Link to | Where | Effect |
| --- | --- | --- | --- |
| Invoice | Estimate | `LinkedTxn: [{TxnId, TxnType:"Estimate"}]` | Estimate status Closed |
| Payment | Invoice | `Line[].LinkedTxn: [{TxnId, TxnType:"Invoice"}]`, `Line.Amount` = amount applied | Invoice Balance falls |
| Payment (credit applied) | CreditMemo | another `Line` with `TxnType:"CreditMemo"`; `TotalAmt` may be 0 | Credit used against invoice |
| Deposit | Payment / SalesReceipt in Undeposited Funds | `Line[].LinkedTxn: [{TxnId, TxnType:"Payment", TxnLineId:"0"}]` | Leaves Undeposited Funds |
| Bill | PurchaseOrder | item line `LinkedTxn: [{TxnId, TxnType:"PurchaseOrder", TxnLineId:<PO line Id>}]` | PO line received |
| BillPayment | Bill / VendorCredit | `Line[].LinkedTxn: [{TxnId, TxnType:"Bill"}]` (or `"VendorCredit"`) | Bill Balance falls |

Read chains with `getTransactionChain`. In mirrored data, QuickBooks names some links differently: `ReceivePayment` = Payment, `BillPaymentCheck` = BillPayment, `Check`/`Expense` = Purchase.

## Terms, due dates, partial and unapplied money

- `SalesTermRef` (customer) or `SalesTermRef` on a Bill/Invoice sets terms; with terms and no `DueDate`, QuickBooks calculates the due date. The governed `invoice-on-terms` and `bill-on-terms` take `termsDays` (7, 15, 30, 45 or 60) and set `DueDate` themselves.
- **Partial payment:** a Payment line amount below the invoice balance leaves the remainder open; aging uses the remaining Balance and the original DueDate.
- **Unapplied payment:** `TotalAmt` greater than the sum of linked lines leaves `UnappliedAmt` on the customer as a credit. It shows as a negative open item on aging.
- **Undeposited Funds:** a Payment or SalesReceipt without `DepositToAccountRef` lands in Undeposited Funds (Payments Clearing) and must be deposited by a Deposit that links it. A Deposit total equals its linked lines.

## Void versus delete

- **Void** keeps the record with zero amounts and an audit trail; numbers and links stay visible. Prefer it for issued documents (invoices, cheques) in real practice.
- **Delete** removes the record (`POST /<entity>?operation=delete` with Id and SyncToken). Deleting a payment reopens its invoices.
- API void is documented for Invoice (`?operation=void`). For Payment, SalesReceipt, BillPayment and Purchase the exact void call varies by minor version (verify before relying on it).
- This app's policy: edit, void or delete only records the app created for the current case or its own work; an earlier record is corrected by a new reversing record, never edited.

## Batch, query and limits

- **Batch** groups up to 30 operations per request (one realm); each item succeeds or fails on its own, so read every item's result. Older docs say 10 (verify the current limit before relying on more than 10).
- **Query**: `SELECT * FROM Invoice WHERE Balance > '0' AND TxnDate >= '2026-10-01' ORDERBY TxnDate STARTPOSITION 1 MAXRESULTS 100`. The default page is 100 and the maximum 1,000. There is no `OR` and no joins; `LIKE` supports `%`; `IN ('1','2')` is supported. Prefer `queryCompanyData` (local copy, no QuickBooks request) for searches and totals.
- **Throttle**: about 500 requests a minute and 10 at once per company; 429 is retried with backoff by the client. The app's daily request budget is stricter: check `context.qboRequestBudget`.
- Reports: keep date ranges to about six months per request; larger ranges can be truncated.

## Common faults

See [reference/faults.md](reference/faults.md) for codes, meanings and fixes. Per-entity payload notes: [reference/sales.md](reference/sales.md), [reference/purchases.md](reference/purchases.md), [reference/banking-and-journals.md](reference/banking-and-journals.md), [reference/lists-and-items.md](reference/lists-and-items.md).

## Checklist before any write

- [ ] Every ref came from a tool result, and the record it names is Active.
- [ ] Tax code on every taxable line; the date gives the intended rate (Nova Scotia HST 15% before 2025-04-01, 14% from then).
- [ ] Links point at records with enough open Balance.
- [ ] Amounts in cents for app tools; totals add up.
- [ ] The date is open (not in a verified period) and is today for same-day activity.
- [ ] One decisionKey kept across retries, so a retry never duplicates work.
