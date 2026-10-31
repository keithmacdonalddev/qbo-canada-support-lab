---
name: support-scenarios-for-troubleshooting
description: The situations support staff need (partial and overdue payments, credits, refunds, corrections, supplier credits, PO receiving, HST rate change) with recipes for each using the available tools, and which still need a capability. Use when scheduling or creating a support scenario.
---

# Support scenarios for troubleshooting

The company exists so that support staff can find realistic examples of what customers call about. A scenario is genuine business activity with a believable reason, not a test record. Schedule one or two a day, spread across areas.

## Scenario recipes
| Scenario | Why support needs it | How to create it now | Records to point at |
| --- | --- | --- | --- |
| Invoice paid in part | "Why is my invoice still open?" | `invoice-on-terms`, later `collect-own-invoice` with an amount below the balance | Invoice with Balance > 0 and a linked Payment |
| Overdue invoice | Aging, statements, reminders | `invoice-on-terms` with short terms to a slow-payer customer; do not collect by the due date | AgedReceivables over 30 days |
| Paid late after several parts | Payment history, days to pay | Two or three `collect-own-invoice` over weeks | Invoice with several Payments |
| Customer credit memo | Applying credits | `customer-credit` for a genuine dispute; later a correction applies a full credit to your own unpaid invoice | Open CreditMemo; RemainingCredit |
| Customer refund | Refund receipt vs credit | `customer-refund` for an overpaid or cancelled plan | RefundReceipt from the bank |
| Correction of a mistake | Credit memo vs void vs delete | `correct-own-record` on your own eligible record | Original plus reversing record |
| Supplier credit | Vendor credits, AP balance | `supplier-credit` for overbilling | VendorCredit; supplier balance |
| Bill paid in part | Open bills, cash planning | `bill-on-terms`, later `pay-own-bill` with part | Bill Balance > 0 |
| Overdue bill | AP aging | `bill-on-terms`, pay after the due date with a reason | AgedPayables |
| Undeposited Funds grouping | "My payment is not in the bank" | Collections deposit automatically; explain the Payment → Deposit chain | Deposit with linked Payments |
| Estimate to invoice | Converting estimates | Field-service sale (estimate, time, invoice) | Closed Estimate linked to Invoice |
| Billable time | Time on invoices | Field-service sale | TimeActivity linked to Invoice |
| Purchase order received | PO to bill | `receive-purchase-order` | Closed PO, linked Bill |
| HST rate change (15% → 14%) | Wrong tax on old dates | Compare a pre-April-2025 sale with a current one; a correction of an old sale repeats 15% when possible | TxnTaxDetail on both |
| Reclassification | Journal entries | `journal-entry` between income or expense roles with a real reason | JournalEntry |
| Bank transfer | Transfers vs deposits | `bank-transfer` when two bank roles exist | Transfer |

## Not possible yet (file `requestCapability` once each, with the scenario as the why)
Unapplied customer payment, stock-out / negative stock sale, partial purchase-order receipt, new purchase orders today, inventory adjustment, mixed-tax invoice (two tax codes), out-of-province customer, bad-debt write-off, cheque and credit-card expenses, class and location on transactions, recurring transactions, attachments, payroll journal, multicurrency.

## Keep scenarios natural and findable
- Each has a business reason in `purpose` ("Bayview Marine disputed 2 h of travel; credit issued").
- Spread over customers and suppliers who fit the behaviour (the late-payer cohort pays late; prompt payers rarely).
- Keep a short scenario log in `rememberBusinessContext` (scenario, record numbers, date) so later reviews and support staff can find them, and mention new ones in the daily plan's owner note.
- `linkReproductionCase` attaches an existing troubleshooting case to your work; it never runs the case.

## Checklist
- [ ] At most one or two new scenarios a day; never more than about 5% of the day's records.
- [ ] Amounts proportionate to that party's normal business.
- [ ] Logged with record numbers.
