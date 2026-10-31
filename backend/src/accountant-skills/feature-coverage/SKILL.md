---
name: feature-coverage
description: Using every QuickBooks feature naturally: how coverage is measured from records, the feature map with what is built, not built or manual, and how to work an unused feature into genuine activity or request a capability. Use in the management review or when choosing what slices emphasise.
---

# Feature coverage

## Where coverage comes from
- `context.management.coverage` and `getBusinessWork` measure coverage **from records in the company** (local copy), never from claims. A feature counts when real records exist for it.
- The in-app tool list (Tools page) shows what each record type can do: create yes, limited (inside a fixed workflow), no (not built), manual (QuickBooks does not offer it to apps).
- Confirm with `queryCompanyData` (for example count by `_entity`, or by `Line.DetailType`) before saying a feature is present or absent.

## Feature map for this company
| Area | Features | Covered by |
| --- | --- | --- |
| Sales | Estimates, invoices (paid and on terms), sales receipts (scheduled periods), payments (full, partial), deposits, credit memos, refunds, billable time | Field-service and care-plan sales, collections, credits, refunds |
| Purchases | Purchase orders (scheduled), bills (paid and on terms), bill payments (full, partial), supplier credits, cash expenses, PO receiving | Expense workflows, payment runs, receiving |
| Banking | Transfers, journal entries | bank-transfer (needs two bank roles), journal-entry |
| Lists | Customers, suppliers, service items | add-customer, add-supplier, add-item |
| Tax | GST/HST on every taxable record; dated rates | All taxed workflows |
| Not built | Employees, accounts, classes, locations, terms list, stocked items, inventory adjustments, partial receipts, cheques and card charges, recurring transactions, attachments, projects, budgets, custom fields | `requestCapability` |
| Manual (owner/UI) | Bank reconciliation, bank feeds and rules, sales tax filing, company settings, multicurrency enablement, users and roles, closing date | Report once; never ask repeatedly |

## Working an unused feature into the business
1. Pick the gap with the most support value (see the support-scenarios-for-troubleshooting skill).
2. Find a genuine business reason it would happen this week (a dispute, a supplier rebate, a slow payer).
3. Use the workflow that creates it, at a believable scale, in a normal slice.
4. Re-measure the next day; do not repeat a feature only to raise a count.

## When no tool can close the gap
File `requestCapability` once (reuse the same `key`; `context.management.capabilityRequests` lists open ones): `missing` (tool or workflow), `feature` (QuickBooks feature or report), `why` (business and support value), `priority`. Never ask the owner to build or do it.

## Reports coverage
Critical reports should all have data behind them: BalanceSheet, ProfitAndLoss, TrialBalance, GeneralLedger, CashFlow, AgedReceivables, AgedPayables, InventoryValuationSummary. Detail and sales reports (CustomerSales, ItemSales, VendorExpenses, ClassSales, DepartmentSales) need the matching activity or dimensions.
