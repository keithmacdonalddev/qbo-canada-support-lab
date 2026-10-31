---
name: qbo-api-records
description: Governed QuickBooks payloads and exact manageQboRecord calls for service invoices, terms, partial payments, credit applications, non-stock purchases, deposits, journals and dimensions. Use before general writes, recurring billing, close adjustments or support scenarios; distinguishes real guard limits from API possibilities.
---

# QuickBooks record tools

## The general record tool

Use `manageQboRecord({decisionKey,purpose,operations})` for work fixed workflows cannot shape. It prepares and attempts execution under the accountant's standing grant; it is not a raw API client. Only actual saved/read-back results count as company activity.

Contract checked against `business-agent-tools.js`, `qbo-entity-schema.js`, `general-write-guards.js` and `general-write-service.js` on 2026-10-31. These recipes are source-checked, **not live-verified**. Current tool refusals and company policy take precedence. Dispatch may be held by server configuration; a saved plan is not a saved QBO record.

Examples in these skills are tool argument objects. Replace every `<...>` placeholder with today's Halifax business date, a calculated date, or an actual synced ID/value before calling. Example amounts are CAD decimal dollars for general writes. Never send placeholders literally.

```json
{
  "decisionKey":"care_20261031_customer17",
  "purpose":"Monthly care service delivered to this customer for October",
  "operations":[{
    "ref":"renewal","op":"create","entity":"Invoice",
    "payload":{
      "TxnDate":"<TODAY>","DueDate":"<TODAY_PLUS_7>",
      "CustomerRef":{"value":"<CUSTOMER_ID>"},
      "GlobalTaxCalculation":"TaxExcluded",
      "PrivateNote":"Care renewal customer17 service-period 2026-10",
      "Line":[{
        "Amount":200,"DetailType":"SalesItemLineDetail",
        "SalesItemLineDetail":{
          "ItemRef":{"value":"<SERVICE_ITEM_ID>"},
          "Qty":1,"UnitPrice":200,
          "TaxCodeRef":{"value":"<PUBLISHED_SALES_TAX_CODE_ID>"},
          "ClassRef":{"value":"<CARE_CLASS_ID>"}
        }
      }],
      "DepartmentRef":{"value":"<LOCATION_ID>"}
    }
  }]
}
```

### Read, write, verify

1. `getBusinessState({})`: recover unfinished work, respect calendar, grant, pause, sync, budget, daily/hourly capacity and owner instructions. Both fixed same-day activities and general writes require verified history through yesterday; general writes also retain their own admission/day-close gates.
2. Use `queryCompanyData` for IDs, balances and complete lines; page with the returned cursor and check freshness. `getBusinessActivityChoices({})` supplies **role keys** for fixed workflows, not interchangeable with QBO IDs.
3. Discover schemas: `searchTools({query:"select:getQboEntitySchema"})`, then `useTool({name:"getQboEntitySchema",input:{entity:"Invoice"}})`. Deferred tools elsewhere in these skills use the same `useTool({name,input})` wrapper after discovery.
4. Call `manageQboRecord` once per coherent decision, max 60 operations, each `{ref,op,entity,payload}`. A ref starts with a lowercase letter and contains lowercase letters, digits and dashes, at most 40 characters. decisionKey is 8-100 letters, digits, underscores or dashes. purpose is 10-2,000 characters.
5. Read `data.execution.status`, every item's `outcome`, `qboId`, faults and `next`. Held/refused/uncertain work is not completion. Retain the returned runId and exact inputs. Retry the same admitted content with the same key; never recreate a possibly saved record under a new key. A refusal explicitly saying nothing was sent can be corrected with that key. Once retained, a key's content is immutable.
6. Confirm saved records and balances from fresh synced data; use `getEntityDetail({type:"Invoice",id:"<ID>"})` or `getTransactionChain({entityType:"Invoice",entityId:"<ID>"})` when necessary. General runId is not automatically a fixed-workflow operationId: do not pass it to unrelated recovery tools. Follow returned recovery instructions; if unclear, retain and escalate without replay.

### General writes versus fixed workflows

- **General** payloads use QuickBooks field casing and decimal dollars: `Amount:125`, `UnitPrice:125`, `TotalAmt:125` on Payment/BillPayment and `Amount` on Transfer. Item lines satisfy Qty × UnitPrice = Amount.
- **Fixed** `prepareBusinessActivity` takes lower-case business choices and integer cents: `amountCents:12500`, `unitPriceCents:12500`. It saves a preview, then `executeBusinessPeriod({operationId:"<RETURNED_ID>",planHash:"<RETURNED_HASH>",reason:"Save the reviewed activity under standing authority"})` queues it. Inspect/recover the exact operation rather than preparing duplicates.
- For same-plan creates, use `CustomerRef:{"value":{"$ref":"new-customer"}}` or `LinkedTxn:[{"TxnId":{"$ref":"new-invoice"},"TxnType":"Invoice"}]`. Name an earlier create; the server resolves IDs and orders dependent requests.
- General updates use `{ref:"adjust",op:"update",entity:"Invoice",id:"<ID>",payload:{PrivateNote:"Reason and current information"}}`. The server supplies Id, SyncToken and sparse mode. Sending Line replaces **all** lines. Do not copy read-only fields.
- General delete uses `{ref:"remove",op:"delete",entity:"Invoice",id:"<ID>",reason:"Specific reason this open-day duplicate is safe to remove"}`, without payload. Do not routinely delete issued documents; prefer new credit/reversal records. List records use update `Active:false`.
- A reason of 10-1,000 characters is required when changing a record the accountant did not create. That guard requirement does not override owner restrictions or case-specific authority. Never edit an original reproduction-case record.

## Effective limits, not just schema possibilities

- All transaction creates are dated **today**, including reversals. Future DueDate is allowed; future TxnDate and backdated creates are not. Updates/deletes affecting verified history are refused; closed/reconciled dates and linked sources remain protected.
- **Inventory is off for these recipes**: no inventory item creates/edits, stock sales/returns or inventory-asset journals through general writes. Fixed v8 order-stock/full receive-purchase-order remain available only when choices and policy allow. Do not change feature flags.
- **Void is refused**, even if a schema lists it.
- **Unapplied payments and overpayments are refused**: Payment.TotalAmt must equal invoice applications minus credit applications. Empty Line with positive TotalAmt fails. Do not fake an invoice or post to AR by journal to evade this.
- **Negative line amounts are refused**, including a negative deposit fee line. Use a full gross Deposit and separate fee Purchase; mark net-deposit representation unavailable.
- Discounts via DiscountLineDetail are refused; use a justified lower unit price. Currency must be CAD. No opening balances, balances, computed tax or totals (except the writable amount fields above).
- Default caps: $50,000 gross per record, $120,000 plan exposure, $10,000 per journal line; 100 lines/record and 64 KiB/payload. Current server limits prevail. Never split work to bypass a cap.

## Posting and linking rules

| Record | Required content / relationship |
| --- | --- |
| Invoice, CreditMemo | CustomerRef, TxnDate, Line; sales item detail, published sales tax code, TaxExcluded |
| SalesReceipt, RefundReceipt | Same, plus DepositToAccountRef (holding/bank for sale; paying bank for refund) |
| Payment | CustomerRef, TxnDate, TotalAmt, Line; one LinkedTxn per line to Invoice or CreditMemo |
| Bill, VendorCredit | VendorRef, TxnDate, Line; item or account expense detail, published purchase tax code, TaxExcluded |
| PurchaseOrder | Bill-style content plus APAccountRef; non-posting; Bill line links exact PO TxnLineId |
| BillPayment | VendorRef, TxnDate, TotalAmt, PayType; CheckPayment.BankAccountRef or CreditCardPayment.CCAccountRef; lines link Bill/VendorCredit |
| Purchase | PaymentType Cash/Check/CreditCard, AccountRef, TxnDate, expense Line; EntityRef can name Vendor |
| Deposit | DepositToAccountRef, TxnDate, Line; each Payment/SalesReceipt link uses full saved TotalAmt and TxnLineId "0" |
| Transfer | FromAccountRef, ToAccountRef, Amount, TxnDate; different permitted balance-sheet accounts |
| JournalEntry | TxnDate, balanced debit/credit Line; detail contains PostingType, AccountRef, optional ClassRef/DepartmentRef |
| TimeActivity | NameOf Employee/Vendor, matching party ref, TxnDate; CustomerRef, ItemRef and BillableStatus for billable work |

- References use active synced IDs; do not invent an ID, tax code, account or tracking preference.
- The current runtime allows exactly the single mapped sales tax code and single mapped purchase tax code (createGeneralWriteContext), not every TaxCode in the company. Mixed-tax sales are therefore held. Every taxed line carries the correct **published sales/purchase** TaxCodeRef. Use GlobalTaxCalculation TaxExcluded. QuickBooks computes TxnTaxDetail: never send tax amounts or guess a rate for a correction.
- Payment/credit applications use the same customer, control account and CAD currency; BillPayment does the same for supplier/AP. Never exceed open balances. Historical sources may be read-only prerequisites for a **new** settlement; a general update of a protected linked source is different.
- Invoice header can link Estimate/TimeActivity; verify the saved relationship (an accepted invoice alone does not prove conversion).
- Journal AR/AP lines need the corresponding entity; prefer invoices, bills and their applications. Never journal directly to tax or inventory accounts.
- For a definitively rejected stale SyncToken item, re-read and re-decide only that unsaved work. Inspect every prior item outcome first: a new decision must exclude saved siblings and uncertain items. Recover uncertain transport without resending it under a new key.
- Record API faults with their problem/ref and any returned request identifier, never credentials.

## References

Read entity schemas first; older reference notes describe API possibilities and may exceed the current guard. Supporting background: [sales](reference/sales.md), [purchases](reference/purchases.md), [banking and journals](reference/banking-and-journals.md), [lists and items](reference/lists-and-items.md), [faults](reference/faults.md). Related procedures: receivables-and-collections, month-end-and-year-end-close, support-scenarios-for-troubleshooting, running-a-medium-sized-business-day.
