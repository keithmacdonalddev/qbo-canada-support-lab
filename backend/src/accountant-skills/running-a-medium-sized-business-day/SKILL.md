---
name: running-a-medium-sized-business-day
description: How to run the business continuously at the volume you choose: sizing work by records, using the request budget, putting volume through general writes, keeping activity believable and covering record types, classes, locations and accounts. Use before planning or creating same-day activity.
---

# Run the business continuously

You decide what the business is, what it grows into and how much it does (owner direction 2026-11-07). The company exists so any customer's situation, of any kind of business, can be reproduced. Volume is limited only by Intuit's rate limits and the metered request budget; context.today.target, ceiling, hourCap and dueSlot are the capacity that budget supports, not a goal, quota or schedule.

## Every pass

1. getBusinessState: continue your own unfinished work first. Respect pause, authority and owner decisions.
2. Follow context.todaysPlan, then current saved state. Load receivables-and-collections, payables-and-payment-runs, month-end-and-year-end-close or support-scenarios-for-troubleshooting when their work is due.
3. Create what the business needs now. Put everyday volume through manageQboRecord (up to 60 operations per call, about 2–3 QuickBooks reads per saved record; several calls per review is normal). Use activity batches only for what they alone do: receiving purchase orders, settling adopted obligations, correcting their own records.
4. When nothing ordinary is due, advance coverage: the next missing feature, setting, edge case or record state from getCoverageSituations and getWeeklyCoverage, created the way a real business would. Re-checking finished work is not progress.
5. When something is wrong (a mismatch, a broken link, a duplicate, a refused write), fix it yourself in the same review with a correction, reversal, re-link or adjustment, and note it. Use inspectBlocker to understand a blocked operation. File requestCapability only when the tool you need does not exist, and keep working on other things.
6. Never duplicate saved records and never add filler only to raise a count.

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


## Make the business believable

Grow the customer, supplier, item and location base as volume grows so activity does not repeat the same few parties. Keep a realistic mix: sales on terms and settled at the counter, prompt, late and partial payments, grouped deposits, supplier bills and payment runs, purchases by every payment method, occasional credits and refunds, transfers and genuine adjustments. Use multicurrency (home currency CAD) where the business trades abroad. Across a week, every major record type, every active class and location, and every active bank, card and cash account should appear in meaningful activity.

## Dimensions must be present in records

Load classes-locations-and-reporting-dimensions. Use actual active division/location IDs. Put ClassRef in each sales/expense line detail under per-line tracking, DepartmentRef on supported transaction headers; journal dimensions belong in JournalEntryLineDetail. Do not put unsupported ClassRef on Payment headers.

Across seven days ensure Field & Advisory, Care Plans and Supply & Workshop, and Halifax/Dartmouth, each appear in meaningful activity **where enabled and actually used**. General non-stock supply services can represent workshop business; do not route inventory through general writes. Keep service customers assigned to their real location instead of toggling locations for counts. Read per-line classes and header departments to prove use; no label-only claim.

## Read before preparing

`getBusinessActivityChoices({})` for fixed roles/eligible targets; queryCompanyData for general IDs and actual balances. Fixed list additions go in their own list-only batch and become usable only in a later verified batch. General list creates can be referenced by later operations in the same call, subject to schema and guard checks.

`prepareBusinessActivity({decisionKey:"<SERVER_DUE_SLOT_KEY>",purpose:"Today's scheduled service invoice on agreed terms",activities:[{type:"invoice-on-terms",customerKey:"<RETURNED_KEY>",itemKey:"<RETURNED_SERVICE_KEY>",quantity:2,unitPriceCents:15000,termsDays:30,purpose:"Completed two hours of the customer's scheduled service"}]})`.
Inspect its returned operationId/planHash, executeBusinessPeriod, verify, then reread today. For exact general payloads load qbo-api-records and the relevant routine skill.

End each day with actual saved counts by family, open promises, next renewals and releases, scenario IDs and unresolved items. A plan or tool success flag is not a saved record.

## Account rotation

Load banking-and-deposits before each plan. Deliberately distribute weekly activity across **every active bank, card and cash account**, using Account.<id> situations in getWeeklyCoverage and last-7/30-day evidence in getCoverageSituations. Choose due business obligations and intentional support scenarios for unused accounts; each needs a believable role, amount, correct currency and funds. Include monthly card payments, savings interest/sweeps, USD supplier payments, CNY/AUD activity, Square deposits net of fees, petty cash and tips receipt/payout. Review saved IDs after execution. Opening/inactive/zero-balance and reconciliation situations are deliberate support coverage too, subject to the documented setup/UI boundaries. A count of 220 concentrated in one bank is not account coverage.
