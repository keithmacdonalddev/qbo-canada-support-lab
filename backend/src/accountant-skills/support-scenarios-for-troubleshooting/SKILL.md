---
name: support-scenarios-for-troubleshooting
description: Daily support and teaching scenarios using real tools: partial/late payers, credits applied later, non-inventory partial PO receipts, mixed-tax invoices, grouped deposits and fees, corrections; explicitly blocked unapplied payments, overpayments and net fee deposits. Use in every daily mix plan and when a scenario follow-up matures.
---

# Support scenarios inside ordinary business

Use genuine modeled business reasons, stable parties and normal amounts. Start one or two scenarios/day, usually no more than 5% of new records including their later steps. Those records replace ordinary volume; they are not extra test batches. Don't intentionally damage books to create a correction.

Read qbo-api-records first. All recipes below are **source-checked, not live-verified** (general-write-v1 / fixed policy v8, 2026-10-31). Substitute actual IDs/dates and published tax codes. General payload money is decimal CAD.

## Operate a scenario lifecycle

Each daily plan selects a missing or aging example; rotate receivables, purchasing, sales tax, banking and accounting over the week. Retain scenario key, purpose, current step, source IDs, next business date and expected evidence with rememberBusinessContext (combined handoff <=4,000 characters). Record longer decisions/evidence pointers with recordBusinessDecision, area troubleshooting. Never assume memory proves a link.

After each step inspect saved outcomes and a fresh record/chain. Schedule follow-up days/weeks later rather than creating every stage immediately. Log actual IDs/document numbers and observed balances/tax/links; mark any missing evidence unverified. linkReproductionCase links an existing case only and never runs it.

## Late and partial payments

Use receivables-and-collections: invoice on Net 7/15/30, collect a realistic part near the due date, then the remainder on its retained promise date. A new current-date invoice becomes overdue by **waiting**, not backdating. Evidence: original DueDate, open Balance after the first Payment, several Payment links and actual days-to-pay.

## Credits issued now, applied later

Issue an ordinary CreditMemo with the same customer/service/tax line shape as the Invoice example in qbo-api-records, using entity CreditMemo (omit DueDate/SalesTermRef). Do not automatically create a refund or immediate application. Retain RemainingCredit and next eligible invoice/customer promise. Confirm auto-application did not already consume it; do not change Preferences to force the scenario.

On a later day, apply a confirmed $50 credit to that customer's open invoice:
```json
{
  "decisionKey":"credit_apply_20261107_customer17",
  "purpose":"Apply the customer's earlier service credit to this month's invoice",
  "operations":[{
    "ref":"credit-application","op":"create","entity":"Payment",
    "payload":{
      "TxnDate":"<TODAY>","CustomerRef":{"value":"<CUSTOMER_ID>"},
      "TotalAmt":0,
      "Line":[
        {"Amount":50,"LinkedTxn":[{"TxnId":"<INVOICE_ID>","TxnType":"Invoice"}]},
        {"Amount":50,"LinkedTxn":[{"TxnId":"<CREDIT_MEMO_ID>","TxnType":"CreditMemo"}]}
      ]
    }
  }]
}
```
Call manageQboRecord; amount is **tax-inclusive**, no more than either remaining balance. Verify the Invoice Balance and CreditMemo.RemainingCredit each fell by $50 and the Payment links both. Zero new cash: no bank deposit.

Supplier variant after a genuine VendorCredit: BillPayment, VendorRef, TxnDate, TotalAmt 0, PayType Check, CheckPayment.BankAccountRef, and two equal Amount lines linking Bill and VendorCredit. Schema-check first; verify AP and remaining credit.

## Non-inventory partial PO receipt

General inventory is off. For a real purchased **Service/NonInventory** item, create a non-posting PO:
```json
{
  "decisionKey":"po_20261031_service_supplies",
  "purpose":"Order ten non-stock service kits for scheduled customer jobs",
  "operations":[{
    "ref":"order","op":"create","entity":"PurchaseOrder",
    "payload":{
      "TxnDate":"<TODAY>","VendorRef":{"value":"<VENDOR_ID>"},
      "APAccountRef":{"value":"<AP_ACCOUNT_ID>"},
      "GlobalTaxCalculation":"TaxExcluded","POStatus":"Open",
      "DepartmentRef":{"value":"<LOCATION_ID>"},
      "Line":[{
        "Amount":250,"DetailType":"ItemBasedExpenseLineDetail",
        "ItemBasedExpenseLineDetail":{
          "ItemRef":{"value":"<NONINVENTORY_ITEM_ID>"},
          "Qty":10,"UnitPrice":25,
          "TaxCodeRef":{"value":"<PUBLISHED_PURCHASE_TAX_CODE_ID>"},
          "ClassRef":{"value":"<CLASS_ID>"}
        }
      }]
    }
  }]
}
```
Read the **saved** PO ID and actual Line.Id. On the actual later receipt date:
```json
{
  "decisionKey":"po_receive_20261102_firstfour",
  "purpose":"Supplier delivered four of the ten non-stock kits; six remain due",
  "operations":[{
    "ref":"first-receipt","op":"create","entity":"Bill",
    "payload":{
      "TxnDate":"<TODAY>","DueDate":"<TODAY_PLUS_30>",
      "VendorRef":{"value":"<SAME_VENDOR_ID>"},
      "APAccountRef":{"value":"<SAME_AP_ACCOUNT_ID>"},
      "GlobalTaxCalculation":"TaxExcluded",
      "DepartmentRef":{"value":"<LOCATION_ID>"},
      "Line":[{
        "Amount":100,"DetailType":"ItemBasedExpenseLineDetail",
        "LinkedTxn":[{"TxnId":"<SAVED_PO_ID>","TxnType":"PurchaseOrder","TxnLineId":"<SAVED_PO_LINE_ID>"}],
        "ItemBasedExpenseLineDetail":{
          "ItemRef":{"value":"<SAME_NONINVENTORY_ITEM_ID>"},
          "Qty":4,"UnitPrice":25,
          "TaxCodeRef":{"value":"<PUBLISHED_PURCHASE_TAX_CODE_ID>"},
          "ClassRef":{"value":"<CLASS_ID>"}
        }
      }]
    }
  }]
}
```
Validate same supplier/item/cost and all prior linked receipts before sending; the general guard's Open check alone is not a remaining-quantity proof. Expected evidence: Bill link to exact PO line, quantities received 4, balance due 6, no inventory valuation movement. If QBO does not preserve the relationship/open remainder, label it unverified and stop that chain; never mark the PO received from a successful Bill alone. Later receive at most the verified remainder under a new decision.

For **inventory** use fixed v8 order-stock and full receive-purchase-order only, with exact choices. Fixed receiving requires a wholly unreceived PO and cannot make a partial receipt. A non-stock example does not prove inventory partial-receipt coverage.

## Mixed-tax sale

**Currently unavailable:** createGeneralWriteContext in general-write-service.js permits exactly one sales TaxCodeRef, mappings.salesTax. The schema accepts a tax code per line but the runtime refuses a second code, even if that code exists in the company. Fixed v8 also cannot shape a mixed-tax invoice. No executable mixed-tax recipe is supplied under this contract.

Compare existing mixed-tax history read-only if available, checking each saved line code and computed tax. File/reuse one capability request for a governed multiple-sales-tax-code policy. Continue ordinary multi-line invoices using the single permitted code only where the actual treatment is appropriate; a two-line invoice is not mixed-tax evidence. No guessed zero-rated/exempt code, tax override or setting/policy change to manufacture this scenario.

## Grouped deposits and merchant fees

Use general Payments or SalesReceipts to Undeposited Funds (fixed collections already deposit and cannot be deposited again). After saving two actual undeposited Payments totalling $300:
```json
{
  "decisionKey":"deposit_20261102_processor_batch",
  "purpose":"Deposit two customer remittances and record the processor's separate fee",
  "operations":[
    {"ref":"gross-deposit","op":"create","entity":"Deposit","payload":{
      "TxnDate":"<TODAY>","DepositToAccountRef":{"value":"<BANK_ID>"},
      "DepartmentRef":{"value":"<LOCATION_ID>"},
      "Line":[
        {"Amount":100,"LinkedTxn":[{"TxnId":"<PAYMENT_100_ID>","TxnType":"Payment","TxnLineId":"0"}]},
        {"Amount":200,"LinkedTxn":[{"TxnId":"<PAYMENT_200_ID>","TxnType":"Payment","TxnLineId":"0"}]}
      ]}},
    {"ref":"processor-fee","op":"create","entity":"Purchase","payload":{
      "TxnDate":"<TODAY>","PaymentType":"Cash","AccountRef":{"value":"<SAME_BANK_ID>"},
      "EntityRef":{"type":"Vendor","value":"<PROCESSOR_VENDOR_ID>"},
      "GlobalTaxCalculation":"TaxExcluded",
      "Line":[{"Amount":3,"DetailType":"AccountBasedExpenseLineDetail",
        "AccountBasedExpenseLineDetail":{"AccountRef":{"value":"<FEE_EXPENSE_ACCOUNT_ID>"},"TaxCodeRef":{"value":"<PUBLISHED_PURCHASE_FEE_TAX_CODE_ID>"},"ClassRef":{"value":"<CLASS_ID>"}}}],
      "DepartmentRef":{"value":"<LOCATION_ID>"},
      "PrivateNote":"Fee for this gross processor deposit; retain batch reference"
    }}
  ]
}
```
The linked amounts must equal the **full actual saved** Payment totals. Use only not-yet-deposited sources. For a no-tax $3 fee the bank movement is +$297; use the actual fee tax treatment and tax-inclusive bank effect. Evidence: Payment -> Deposit links, clearing reduced $300, separate fee expense and bank net. This is **two bank postings**, not one net bank deposit/match; net fee deposit representation is held because negative lines are refused. It does not reconcile the bank.

## Corrections

Prefer fixed correct-own-record for an eligible genuine mistake:
`prepareBusinessActivity({decisionKey:"correct_20261102_invoice17",purpose:"Reverse the duplicate service charge discovered during review",activities:[{type:"correct-own-record",target:{entity:"Invoice",qboId:"<ELIGIBLE_ID>"},purpose:"Duplicate service charge; reverse once using the original tax"}]})`.
Copy the eligible target from getBusinessActivityChoices, inspect and execute the returned operation. A wholly unpaid invoice gets CreditMemo + zero-cash Payment; a fully collected sale gets RefundReceipt; unpaid operating Bill gets VendorCredit + zero-cash BillPayment; JournalEntry gets its exact reverse. Original stays unchanged; inspect both original and reversal. General current-day balanced reversal journals can correct non-inventory close adjustments under their own guard.

Do not intentionally create an incorrect record just to meet a correction count. No general voids, verified-history edits or unapproved pre-existing case-record changes.

## Blocked scenarios and truthful fallback

| Requested scenario | Current tool result / action |
| --- | --- |
| Unapplied customer payment | Refused: positive TotalAmt with no invoice application fails equality guard |
| Overpayment | Refused: TotalAmt greater than net linked applications fails equality guard; no fake invoice or AR journal workaround |
| Apply an old unapplied Payment later | Would need the missing supported prepayment lifecycle; retain existing records read-only, no duplicate cash |
| Partial **inventory** PO receipt | Outside this inventory-off scope; fixed workflow receives full orders only |
| Single deposit net of fees | Negative Deposit line refused; supported gross Deposit + separate fee Purchase shown above |
| Mixed-tax sale | Current runtime permits only mappings.salesTax; requires a governed multi-code policy capability, not an invented tax code |
| Historical tax-rate scenario | Compare existing dated history read-only; no backdated new sales or tax overrides |

Check getManagementReview for existing requests, then submit missing-tool gaps once, e.g.
`requestCapability({key:"unapplied-payment-lifecycle",requirement:"R01",missing:"Governed unapplied and excess customer receipts and later application without duplicate cash",feature:"Unapplied payments and overpayments",why:"Teach customer credits and aging with verifiable cash and later applications",priority:"medium"})`.
Reuse the same key for this gap; use an existing matching key if present. Owner/UI work belongs in manual decisions, not a build request.
