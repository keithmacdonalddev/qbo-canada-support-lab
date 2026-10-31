---
name: receivables-and-collections
description: Monthly care-plan and subscription renewals per customer, scheduled service invoices on terms, stable late and partial payer cohorts, collection promises, credits applied later and follow-up. Use before daily billing or collections, when a renewal is due, or when reviewing AR aging; maintain the next month's schedule.
---

# Recurring services, billing and collections

Use this procedure every day, including overnight renewal slices. Read qbo-api-records for common call/retry rules. Recipes are source-checked against general-write-v1 and fixed policy v8 (2026-10-31), **not live-verified**. This is accountant-managed scheduling, not a QBO RecurringTransaction template or an email service.

## Keep a customer renewal register

Recover existing memory, owner direction and synced history before creating a schedule. For each active care/subscription customer retain:
- customer ID and fixed-workflow role key if one exists; active Service item ID; class/location;
- agreed monthly net price, quantity, published sales tax code and terms days;
- anniversary day (1-31), service period convention (advance or arrears), nextBillingDate;
- payer habit, expected payment date/instalments, promises, suspension/cancellation;
- last billed service period, Invoice ID, decisionKey/runId and outcome.

Use a compact `rememberBusinessContext({memory:"..."})` handoff, **under 4,000 characters total**, preserving other open work; do not replace the handoff with only this register. Keep confirmed scheduling decisions in `recordBusinessDecision` as well. Memory is a pointer, not proof of payment or an invoice. If the register outgrows memory, retain stable customer/period keys in Invoice.PrivateNote and reconstruct from the synced records; no imaginary recurring-scheduler or external store tool.

For a new simulated customer, infer the first schedule from actual service history and record it once as a modeled business choice. Do not invent an owner contract. Stagger anniversaries to match customers' start dates. On a short month bill on its last day, then return to the original anniversary. Keep service-period and billing-date fields separate.

## Daily billing pass

1. `getBusinessState({})`, recover retained work, check budget/capacity, and follow today's plan. Date every new transaction today.
2. Find due renewals from the register. Recheck the synced invoices for this customer and service period, including pending saved plans, **before** preparing work.
3. Invoice one monthly period per customer on its scheduled date. Do not bill the same subscriber daily to fill volume. Quantity usually 1 month; annual/quarterly arrangements need their own retained agreement.
4. If a day was missed, first resolve any uncertain prior attempt. Create only genuinely missing invoices today, naming the actual missed service period in PrivateNote; never backdate or replay a billed period.
5. Use `manageQboRecord` for exact price, service-period note, terms, line class and location (example in qbo-api-records). Explicit DueDate = today + the customer's terms; optionally include a known SalesTermRef. A monthly invoice is left open, not automatically collected.
6. Read the execution outcome, verify the Invoice and tax/Balance, then advance nextBillingDate by one month. A held/refused/uncertain plan keeps the period pending. Retain Invoice ID and future collection dates.
7. At cancellation, stop future renewals; credit only undelivered service under the actual cancellation facts. A RefundReceipt is a money-out sale reversal, not automatic settlement of an unapplied credit.

Duplicate check (substitute the actual customer/period; page all results):
```json
{
  "mode":"find","entities":["Invoice"],
  "where":[
    {"field":"CustomerRef.value","op":"eq","value":"<CUSTOMER_ID>"},
    {"field":"PrivateNote","op":"contains","value":"service-period 2026-10"}
  ],
  "fields":["Id","DocNumber","TxnDate","Balance","PrivateNote"],"limit":200
}
```
Older invoices may lack the marker: inspect date, item, amount and service history too. A matching note alone is not financial proof.

## Fixed v8 alternative for published roles

Use when the standard care-plan price/shape fits and no custom dimensions or note are needed. Copy customerKey/itemKey from current choices (values below illustrate the published roles); use the due slot's decisionKey when supplied.
```json
{
  "decisionKey":"care_20261031_client001",
  "purpose":"Monthly care renewal for the customer on its billing anniversary",
  "activities":[{
    "type":"invoice-on-terms","customerKey":"care-client-001",
    "itemKey":"care-plan-1","quantity":1,"unitPriceCents":20000,
    "termsDays":7,"purpose":"October monthly care service billed on seven day terms"
  }]
}
```
Call `prepareBusinessActivity` with that object; inspect the returned plan and call `executeBusinessPeriod` with its operationId, planHash and reason. Verify before updating the register. Added customers/items are limited in fixed v8; use general IDs for terms invoices when fixed choices do not allow them.

## Consistent payer habits

Apply an initial modeled distribution only where history is absent: about 70% prompt, 20% late, 10% partial. These are customer cohorts, not a daily quota.
| Cohort | Expected behavior |
| --- | --- |
| Prompt care-plan | Net 7; pays near due date, occasionally 1-3 days early/late |
| Project / regional | Net 15/30/45; pays near due date or in weekly AP runs |
| Late | Usually 7-30 days late, a few 31-60 with a recorded reason |
| Partial | 40-60% near due date, balance 7-21 days later; occasionally a third part |

Keep actual customer terms/history over these defaults. Let invoices age naturally; do not manufacture a 30-day overdue invoice today. Keep over-60 balances exceptional and explained. Continue other customers' business while holding further terms sales to a seriously overdue customer under the retained credit policy.

## Daily collections and follow-up

Discover `getObligations` if needed, then `useTool({name:"getObligations",input:{area:"receivables",overdueOnly:false,limit:50}})`. For complete balances and payer history use:
```json
{
  "mode":"find","entities":["Invoice"],
  "where":[{"field":"Balance","op":"gt","value":0}],
  "sort":[{"field":"DueDate","direction":"asc"}],
  "fields":["Id","CustomerRef","TxnDate","DueDate","Balance","_daysLate"],
  "limit":200
}
```
Check freshness, page with cursor, and choose today's actual modeled remittances from the cohort/promise schedule. Do not collect every invoice as soon as it is due.

General partial payment example (decimal CAD):
```json
{
  "decisionKey":"collect_20261107_invoice17_part1",
  "purpose":"Customer paid the agreed first instalment; balance due in two weeks",
  "operations":[{
    "ref":"part-payment","op":"create","entity":"Payment",
    "payload":{
      "TxnDate":"<TODAY>","CustomerRef":{"value":"<CUSTOMER_ID>"},
      "DepositToAccountRef":{"value":"<UNDEPOSITED_FUNDS_ID>"},
      "TotalAmt":100,"PrivateNote":"First instalment; next promise <DATE>",
      "Line":[{"Amount":100,"LinkedTxn":[{"TxnId":"<INVOICE_ID>","TxnType":"Invoice"}]}]
    }
  }]
}
```
Use the actual tax-inclusive invoice Balance; never derive the payment from net price alone. Deposit the **full** saved Payment.TotalAmt using banking-and-deposits (group several payments if useful). General workflows may hold receipts briefly for a planned deposit; fixed collections deposit automatically.

For eligible own invoices in choices, fixed alternative:
`prepareBusinessActivity({decisionKey:"collect_20261107_invoice17_part1",purpose:"First instalment on the customer's open care invoice",activities:[{type:"collect-own-invoice",invoiceId:"<INVOICE_ID>",customerKey:"<RETURNED_CUSTOMER_KEY>",amountCents:10000,purpose:"Customer remitted first instalment; remainder promised in two weeks"}]})`.
This creates Payment + Deposit after execution. Do not run both alternatives.

At 1-15 days late record a friendly reminder; 16-30 record the second reminder and next promise; 31-60 apply the credit hold/payment-plan policy; 61+ escalate the actual balance and risk. These are **internal follow-up notes**, not messages sent to customers. No tool here sends reminders or charges a card.

Retain a stable issue such as:
`recordBusinessDecision({issueKey:"ar-customer17-followup",title:"Care invoice payment promise",detail:"Invoice <ID>, remaining CAD <AMOUNT>, reminder noted internally; next follow-up <DATE>.",requiresOwner:false,area:"receivables"})`.

## Credits and evidence

Use support-scenarios-for-troubleshooting for a later zero-cash Payment applying a CreditMemo to an Invoice. Do not create another cash payment to use the credit. Unapplied payments and overpayments are currently refused; retain existing examples read-only and request the missing application lifecycle once.

Each day log new invoices, payments, remaining balances and next promises. Each month reconcile AR aging, customer balances and the AR GeneralLedger to the BalanceSheet under month-end-and-year-end-close. Discover reports before use. Report unverified sync/links separately from saved outcomes.
