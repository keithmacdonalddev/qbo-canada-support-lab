---
name: running-a-medium-sized-business-day
description: Continuous 24-hour operating mix near 220 QuickBooks records/day, due-slot sizing, monthly subscriber renewals, daily collections and weekly coverage of major record types, classes and locations. Use before every same-day batch and daily plan; route to billing, close and support skills when their schedules mature.
---

# Run the business continuously

Read this at each daily planning pass and before sizing a same-day batch. This is a mix guide, **not a new scheduler** or authority to bypass caps. Contracts source-checked 2026-10-31; actual daily volume and feature coverage require saved records.

## Every pass

1. getBusinessState: recover unfinished work and satisfy required calendar verification first. Respect pause, current sync, authority, request/usage budgets and owner decisions.
2. Follow context.todaysPlan. Load receivables-and-collections for today's customer renewals/promises; month-end-and-year-end-close for due releases, accruals/reversals; support-scenarios-for-troubleshooting for new examples and follow-ups.
3. Read today's saved/reserved records, target, behind, dueSlot.records, sliceCap, hourCap/hourUsed and ceiling. Server cadence v3 normally spreads about 220 records over 24 hourly :30 slots, every day, weighted toward daytime. Current context, including any scaled target, is authoritative.
4. When dueSlot exists, prepare one coherent batch near its remaining allowance, execute, verify and reread state. Do not take over timing with loops or timers. Never create a second plan for an already reserved slot.
5. Count records already due from obligations and adjustments before choosing discretionary sales. Don't add transactions simply to fill a count. General writes consume daily/hourly capacity too; a different tool/key is not extra allowance.
6. If no discretionary slot is due, do permitted standing duties, report checks and internal follow-up; do not pad. If a refusal/held result repeats without progress, retain the dependency and continue independent work.

## Size by records, not tool calls

| Activity | New records after successful execution |
| --- | --- |
| Fixed settled field service: Estimate, TimeActivity, Invoice, Payment, Deposit | 5 |
| Fixed field invoice-on-terms | 3 |
| Fixed settled care-plan sale | 3 |
| Fixed care invoice-on-terms | 1 |
| Fixed collect-own/adopted-invoice | 2 (Payment + Deposit) |
| Fixed paid-operating-expense | 2 (Bill + BillPayment) |
| Fixed bill-on-terms / pay-own-bill / cash expense / credit / refund / transfer / journal / PO / full receipt | 1 each |
| Fixed send-estimate / convert-own-estimate | 1 / 2 (TimeActivity + Invoice) |
| Fixed correction | Inspect derived plan: often 2 for credit+application, 1 for refund/reversal |
| General call | Count create operations, including each linked Payment/Deposit and list addition; updates are not new records |

Fixed batches have at most 12 activities. General calls have at most 60 operations. Current capacity may be smaller. Inspect the preview rather than assuming one activity equals one record.

## A mature day near 220 records

Illustrative **new record counts**, not mandatory quotas:
| Record family | Count | Business reason |
| --- | ---: | --- |
| Invoice | 44 | Completed work and customers whose monthly renewals are actually due |
| Estimate / TimeActivity | 16 / 16 | Quoted field jobs; some quotes convert on later days |
| SalesReceipt | 12 | Genuine same-day counter/online non-stock sales |
| Payment / Deposit | 40 / 32 | Prompt, late and partial remittances; some grouped deposits |
| Bill / BillPayment | 20 / 16 | Supplier services/receipts on terms and scheduled payment runs |
| Purchase / PurchaseOrder | 8 / 6 | Direct bank/card/cheque costs and genuine orders |
| CreditMemo / VendorCredit / RefundReceipt | 3 / 2 / 1 | Actual disputes/allowances/cancellations in the modeled business |
| Transfer / JournalEntry | 1 / 1 | Real cash movement or scheduled/reviewed adjustment |
| List additions | 2 | Customer or other genuine master-data growth |
| **Total** | **220** | All families counted once |

Adapt to actual obligations, cash and customer base. This is not 44 invoices to the same handful of parties every day. Twenty-four monthly renewals/day would require roughly 720 monthly subscribers; a small roster only renews on its own anniversary dates. Build the customer base gradually and use genuine project/non-stock activity to fill ordinary demand; record insufficient demand as a volume gap rather than rebilling subscribers. Unneeded journals, refunds, orders and lists are zero that day; rebalance toward genuine sales/collections or report a shortfall.

Keep at least a third of invoices on terms over the week; leave them open until each payer's scheduled date. Credits and disputes stay occasional, not a compulsory daily percentage.

## Across all 24 hours

| Halifax period | Suitable work |
| --- | --- |
| 00:00-07:59 | Prior-day recovery/verification, daily management review, due online renewals, scheduled remittances, internal follow-up |
| 08:00-17:59 | Most quotes, field-service time and invoices, purchases/receipts, collections and supplier runs |
| 18:00-23:59 | Counter/online receipts, grouped deposits/fees, next-day preparation, due recurring releases; month-end accruals before midnight |

Follow the server's weighted allowance; no hand-set per-hour quota or catch-up burst beyond hourCap. Overnight field visits need a plausible emergency reason. Weekend activity continues at the current target but follows real modeled demand.

## Weekly coverage rotation

Check the trailing seven days before adding work. These are weekly coverage opportunities, not permission for pointless transactions.
| Day focus | Major types / lifecycle |
| --- | --- |
| Monday | Estimate -> later Invoice, TimeActivity; renewals on terms, new Customer if needed |
| Tuesday | PurchaseOrder -> later Bill; non-stock partial receipt example; normal supplier payments |
| Wednesday | SalesReceipt, partial Payment, grouped Deposit and separately posted processor fee |
| Thursday | CreditMemo -> later zero-cash Payment; VendorCredit -> later BillPayment |
| Friday | Purchase Cash/Check/CreditCard variants, genuine RefundReceipt, Transfer if cash management needs it |
| Saturday | Late-payer follow-up, quote conversion, service-item/customer growth as demand supports |
| Sunday | Coverage/report review, due JournalEntry releases; month-end/year-end schedule takes priority on its actual date |

Every day has ordinary sales and collections as due, not only the day's focus. JournalEntry follows a genuine adjustment schedule; no invented errors to force corrections. Physical inventory, payroll, reconciliation and settings are not record-volume fillers. Some features will remain explicitly unverified or manual.

Use general writes for supported shapes missing from fixed workflows: SalesReceipt, ordinary multi-line sales, non-inventory PO partial receipts, dimensions, flexible credits/applications, balance-sheet journals and list maintenance. Use fixed v8 for eligible stock ordering/**full** receipt and established service chains. Inventory in general writes stays off.

## Dimensions must be present in records

Load classes-locations-and-reporting-dimensions. Use actual active division/location IDs. Put ClassRef in each sales/expense line detail under per-line tracking, DepartmentRef on supported transaction headers; journal dimensions belong in JournalEntryLineDetail. Do not put unsupported ClassRef on Payment headers.

Across seven days ensure Field & Advisory, Care Plans and Supply & Workshop, and Halifax/Dartmouth, each appear in meaningful activity **where enabled and actually used**. General non-stock supply services can represent workshop business; do not route inventory through general writes. Keep service customers assigned to their real location instead of toggling locations for counts. Read per-line classes and header departments to prove use; no label-only claim.

## Read before preparing

`getBusinessActivityChoices({})` for fixed roles/eligible targets; queryCompanyData for general IDs and actual balances. Fixed list additions go in their own list-only batch and become usable only in a later verified batch. General list creates can be referenced by later operations in the same call, subject to schema and guard checks.

Typical fixed call:
`prepareBusinessActivity({decisionKey:"<SERVER_DUE_SLOT_KEY>",purpose:"Today's scheduled service invoice on agreed terms",activities:[{type:"invoice-on-terms",customerKey:"<RETURNED_KEY>",itemKey:"<RETURNED_SERVICE_KEY>",quantity:2,unitPriceCents:15000,termsDays:30,purpose:"Completed two hours of the customer's scheduled service"}]})`.
Inspect its returned operationId/planHash, executeBusinessPeriod, verify, then reread today. For exact general payloads load qbo-api-records and the relevant routine skill.

End each day with actual saved counts by family, overdue/partial promises, next renewals/releases, scenario IDs and unresolved manual items. A 220-record target, tool success flag or plan does not prove 220 saved records.
