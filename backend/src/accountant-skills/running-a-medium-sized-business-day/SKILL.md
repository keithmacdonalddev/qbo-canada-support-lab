---
name: running-a-medium-sized-business-day
description: A realistic day in this medium-sized business: sizing each slice from context.today, record counts per activity, the daily mix of sales, collections, purchases, adjustments and list growth, and varied customer behaviour. Use before preparing any same-day activity batch.
---

# Running a medium-sized business day

## Read the day first
`context.today` (or `getBusinessState`) gives the target, what QuickBooks already received, work in progress, the ceiling, the due slot and its size (`dueSlot.records`), and the slice allowance (`sliceCap`). The server owns the rhythm and slot identity: prepare **one batch for the due slot**, of about `dueSlot.records` new records; never exceed `sliceCap` or the ceiling, and never pad. With no slot due, do standing duties only (receiving, settlements, corrections, list additions).

## Record counts per activity (for sizing)
| Activity | New records |
| --- | --- |
| Field-service sale settled (estimate, time, invoice, payment, deposit) | 5 |
| Care-plan sale settled (invoice, payment, deposit) | 3 |
| Field-service invoice on terms (estimate, time, invoice) | 3 |
| Care-plan invoice on terms | 1 |
| Collection of an open invoice (payment, deposit) | 2 |
| Paid operating expense (bill, bill payment) | 2 |
| Bill on terms / cash expense / supplier credit / customer credit / refund / transfer / journal entry | 1 |
| Bill payment of an open bill | 1 |
| Receive a purchase order (bill) | 1 |
| Add customer / supplier / item | 1 |
Up to 12 activities per batch.

## A believable daily mix (about 220 records)
Spread across the day's slices, roughly:
- **Sales 55-60%**: field-service jobs (larger, quoted and timed), care-plan billings (many, small, recurring around the same day each month), and a share invoiced on terms rather than paid at once (aim for at least a third of sales on terms so receivables exist).
- **Collections 15%**: customers paying open invoices, on time, late or in part.
- **Purchases and payments 15%**: bills on terms from rent, utilities, software and suppliers, payment runs once or twice a week, a few cash expenses, receiving due purchase orders.
- **Adjustments 3-5%**: an occasional credit memo, refund, supplier credit, correction or reclassifying journal entry; never routine.
- **List growth 3-5%**: as volume rises, add customers (and occasionally suppliers and services) in their own batch, so sales are not concentrated on a few names.
Slices overnight (if the rhythm runs 24 hours) should be lighter and different in kind: online care-plan renewals, card-paid expenses, scheduled bill payments, not field jobs.

## Customer behaviour variety
- Rotate customers: no customer more than a few times a day; frequent buyers weekly, others monthly.
- Vary quantities and prices within each service's normal range (field hours 1-8, care plans 1-3 months, price changes only at a reason such as renewal).
- Each customer keeps its habit (prompt payer, slow payer, partial payer, disputes occasionally).
- Write a specific business `purpose` per activity ("Dartmouth Clinic — quarterly HVAC inspection, 6 h"), not a template phrase.

## Before you prepare
1. Recover unfinished work and close the calendar first (they come before same-day activity).
2. Check `context.todaysPlan`: follow its changes (mix steer, scenario, list growth).
3. `getBusinessActivityChoices` for valid keys; never guessed names or ids.
4. Check cash before paying and stock before selling stock.
5. Keep one `decisionKey` across retries (the server assigns it for a due slot). When an earlier preview expired unsent (an earlier day, no saved records), prepare today’s work under a new `decisionKey`: that is correct, not a bypass.

## Do not
- Repeat the same parties, amounts or purposes slot after slot.
- Add overhead or credits simply to hit the count.
- Exceed the ceiling or prepare a second batch for a slot that already has one.
