---
name: payables-and-payment-runs
description: Accounts payable: bills on terms vs paid bills vs cash expenses, supplier terms, weekly payment runs and priority, partial payments, supplier credits, AP aging. Use when entering or paying bills, handling supplier credits, or reviewing payables and cash for payments.
---

# Payables and payment runs

## Tools this app gives you
- `getObligations({area:"payables"})` and `queryCompanyData` for open bills and ages.
- In `prepareBusinessActivity`: `bill-on-terms` (operating bill left open, `termsDays` 7-60), `pay-own-bill` (full or partial payment of your own open terms bill from the operating bank), `pay-adopted-bill` (open bills from the adopted import history), `paid-operating-expense` (bill paid at once), `paid-cash-expense` (expense straight from the bank, no bill), `supplier-credit` (credit note reducing what is owed), `receive-purchase-order` (inventory bill from a purchase order) and `correct-own-record`.
- Follow the tool description and `getBusinessActivityChoices` for current limits.

## Bill or cash expense?
- **Bill on terms**: suppliers who invoice and give terms (rent invoiced monthly, utilities, software subscriptions billed annually, wholesale stock, subcontractors).
- **Paid bill**: a supplier invoice paid the day it arrives.
- **Cash expense** (`paid-cash-expense`): card or direct-debit spending with no supplier invoice to track (small supplies, bank-debited software). Do not use it to avoid AP.

## Typical supplier terms
| Supplier type | Terms | Pattern |
| --- | --- | --- |
| Premises (rent) | Due 1st of the month | Monthly, fixed amount |
| Utilities | Net 15-30 | Monthly, varies with season (higher in winter in Halifax) |
| Software/services | Net 30 or card | Monthly or annual |
| Inventory suppliers | Net 30-45 | Follows purchase orders |
| Subcontractors | Net 15-30 | Follows project work |

## Payment run (once or twice a week)
1. List open bills by `DueDate` (`getObligations` payables, or `queryCompanyData` Bill `Balance > 0`).
2. Check cash: operating bank balance from `queryCompanyData` (Account) or BalanceSheet. Keep a buffer (about two weeks of operating costs).
3. Pay in priority: rent, payroll-related remittances, tax, critical suppliers, then others by due date. Take early-payment discounts when cash allows.
4. Pay close to the due date, not long before. When cash is tight, pay part of a non-critical bill and note why.
5. Apply any open supplier credit before paying cash to that supplier.
6. Record the run's rationale in `purpose`.

## Supplier credits
- For overbilling, returned services or agreed rebates; keep each proportionate to what that supplier bills. No money comes back with a credit; it reduces AP.

## Reading AP health
- AgedPayables / VendorBalance reports or `queryCompanyData` aggregates.
- Watch: bills over 30 days past due (supplier relationship risk), one supplier dominating spend, expenses growing faster than sales.

## Checklist
- [ ] Each bill fits that supplier's pattern and amount history.
- [ ] Payments never exceed open balances and leave the cash buffer.
- [ ] A realistic mix: most paid on time, a few partial or a little late when cash is tight.
- [ ] Bills entered outside the app are paid only if a tool lists them as payable.
