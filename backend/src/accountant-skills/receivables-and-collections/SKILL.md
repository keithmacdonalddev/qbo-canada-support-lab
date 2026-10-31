---
name: receivables-and-collections
description: Accounts receivable: payment terms by customer type, invoicing on terms, full and partial collection, dunning overdue customers, credits and refunds, AR aging health. Use when planning terms sales, deciding what to collect, handling late or partial payers, or reviewing receivables.
---

# Receivables and collections

## Tools this app gives you
- `getObligations({area:"receivables", overdueOnly})` and `queryCompanyData` for open invoices, ages and days-to-pay (no QuickBooks request).
- In `prepareBusinessActivity`: `invoice-on-terms` (a service invoice left open, `termsDays` 7, 15, 30, 45 or 60), `collect-own-invoice` (full or partial collection of your own open terms invoice, deposited), `collect-adopted-invoice` (open invoices from the adopted import history listed by `getBusinessActivityChoices`), `settled-service-sale` (paid at once), `customer-credit` (open credit memo), `customer-refund`, and `correct-own-record`.
- The tool description and `getBusinessActivityChoices` are authoritative for what is allowed today; when they differ from this skill, follow them.

## Terms by customer type
| Segment | Typical terms | Behaviour to model |
| --- | --- | --- |
| Local project clients | Net 15 or Net 30 | Mostly on time; some pay a few days late |
| Regional business clients | Net 30 or Net 45 | Pay in batches; occasional partial payment |
| Wholesale buyers | Net 30 | Regular; dispute small lines sometimes (credit memo) |
| Care-plan subscribers | Net 7 or due on receipt | Monthly; a few late, rare cancellations with credit |
| Late/partial payer cohort | Net 30 | Pay 15-60 days late, often in two or three parts |

Keep each customer consistent: a customer's terms and payment habit should be the same from month to month, with occasional exceptions.

## Daily collection routine
1. List open invoices due or overdue: `queryCompanyData` on Invoice with `Balance > 0`, `_daysLate`, grouped by customer.
2. Collect what a believable customer would pay today: most on-time customers pay within a few days of `DueDate`; late payers later; some pay part.
3. Partial payment: collect a round, plausible part (for example half, or a whole number of months for care plans), leaving the rest open. Never collect more than the open balance.
4. Every collection is deposited from Undeposited Funds to the operating bank in the same batch (the tools do this).
5. Record the business reason in `purpose` (for example "Harbour Electric paid 50% of INV-1042, balance promised in two weeks").

## Dunning (overdue steps)
| Days past due | Action in this simulated business |
| --- | --- |
| 1-15 | Friendly reminder (note in decision/memory only; no email is sent by the app) |
| 16-30 | Second reminder; expect partial payment from the late cohort |
| 31-60 | Hold new terms sales for that customer; settle on a payment plan |
| 61-90 | Escalate in `recordBusinessDecision`; consider a credit for a genuine dispute |
| 90+ | Bad-debt candidate: a write-off needs a credit memo to a bad-debt item or a journal entry; if no tool supports it, file `requestCapability` |

## Credits and refunds
- **Credit memo**: price dispute, service not delivered, goodwill. Keep it proportionate to that customer's sales. It stays open until applied; the correction workflow applies a full credit to your own wholly unpaid invoice.
- **Refund**: only when money was received and is genuinely owed back (overpayment, cancelled prepaid plan).
- **Unapplied payment** (money with no invoice) shows as a negative item on aging; resolve it by applying to the next invoice. If no tool can, record it.

## Reading AR health
- `runReport` AgedReceivables / AgedReceivableDetail, CustomerBalance; or `queryCompanyData` aggregates (sum of Balance by `_ageDays` bucket).
- Healthy for this business: most of AR current or 1-30 days; under about 10% over 60 days; days sales outstanding roughly near the average terms.
- Advise when one customer exceeds about 20% of AR, when over-60 grows two months running, or when a customer's days-to-pay keeps rising.

## Checklist
- [ ] Terms and amounts fit the customer's segment and history.
- [ ] A mix today: some on time, some late, a few partial; not every invoice collected the day it falls due.
- [ ] Never collect invoices entered outside the app unless a tool lists them as collectable.
- [ ] Aging stays believable; no customer's balance grows without explanation.
