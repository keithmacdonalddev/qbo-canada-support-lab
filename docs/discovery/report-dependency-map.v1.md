# Report Dependency Map v1

**Status:** Static proposal
**As of:** 2026-08-09
**Authority:** `catalog.v1.json` and rebuild plan section 13

A report is not “covered” because its endpoint returns HTTP 200. It moves independently through availability, populated, plausible, reconciled, and manual-verification evidence.

## Required inventory boundary

`required-report-manifest.v1.json` maps all 48 report rows required by plan section 13.2 to stable catalog keys. Twenty-three rows map to published Reports API endpoints. The remaining 25 are classified product/manual or conditional with dated product sources and exact navigation; none remains statically `unknown`.

Static completion is not report coverage. Forty-seven rows still have `coverageState: unknown` because no approved connected-company observation proves availability, population, plausibility, parity, or freshness. The catalog also records where a stable plan-family key maps to a customized view or close equivalent instead of an identically named native report.

## Critical release reports

| Report | Product/API class | Required capability spine | Minimum meaningful fixture | Core assertion |
| --- | --- | --- | --- | --- |
| Balance Sheet | API | Preferences, chart of accounts, AR, AP, cash, journals | Opening balances plus sales, purchases, cash, and close activity | Assets = liabilities + equity; AR/AP controls agree |
| Profit and Loss | API | Accounts, sales, payables/expenses, inventory, journals | Revenue, COGS, operating expense, month-end entries | Net income = income - COGS - expenses |
| Trial Balance | API | Accounts and all posting lifecycles | At least one close period | Total debits = total credits |
| General Ledger Detail | API | Accounts and posting transactions | Selected control accounts with opening/activity/closing | Opening + activity = closing by account |
| Statement of Cash Flows | API | Cash accounts, receipts, payments, transfers, capital | Operating, investing/financing where in scope | Opening cash + net change = closing cash |
| A/R Aging Summary | API | Customers and receivables | Current and overdue invoices, partial payment, credit | Aging total = scoped AR control |
| A/P Aging Summary | API | Vendors and payables | Current and overdue bills, partial payment, credit | Aging total = scoped AP control |
| Inventory Valuation Summary | Conditional API | Inventory setting/items, purchases, sales, adjustments | Opening quantity, purchase, sale, return/adjustment | Inventory value = scoped asset control |
| Canadian Sales Tax Liability | Manual product evidence | Canadian tax setup and taxable sales/purchases | Reviewed province/tax-code fixture and filing period | Liability/detail = tax controls and managed lifecycles |
| Reconciliation Report | Manual product evidence | Cash, statement fixture, cleared/outstanding evidence | One bank and one credit-card statement period | Statement +/- outstanding = scoped book balance; QBO completion manually proven |

## Supporting endpoint reports

| Family | Reports | Shared dependencies | Relationship check |
| --- | --- | --- | --- |
| Financial detail | Profit and Loss Detail, Account List | Chart of accounts and posting lifecycles | Detail rolls to summary; blueprint accounts exist exactly once |
| Receivables | Customer Balance Summary/Detail, A/R Aging Detail | Customers, invoices, payments, credits | Detail and customer totals agree to aging/control totals |
| Payables | Vendor Balance Summary/Detail, A/P Aging Detail | Vendors, bills, payments, credits | Detail and vendor totals agree to aging/control totals |
| Sales | Sales by Customer, Income by Customer, Sales by Product/Service | Customers, items, sales forms, credits | Grouped totals roll to the same scoped revenue |
| Dimensions | Sales by Class, Sales by Department | Enabled dimensions and dimensioned sales | Assigned + unassigned totals reconcile to scoped sales |
| Expenses | Expenses by Vendor | Vendors, bills/expenses/credits | Vendor totals roll to scoped expense/COGS totals |
| Inventory | Inventory Valuation Detail | Inventory lifecycle and item/account setup | Movements roll to summary for the same date |

## Manual/conditional supporting reports

| Report | Why manual/conditional | Required evidence |
| --- | --- | --- |
| Project Profitability | Projects are conditional and no endpoint is named in the current Reports API table | QBO UI availability, entitlement, project income/cost/time fixture, screenshot/reference |
| Budget vs Actual | Canada product supports budgets, but no endpoint is named in the current table | Budget setup evidence, actual comparison, UI path, scoped totals |
| Journal, receivables, and payables lists | Named Canada product reports or statements; no exact endpoint is named | Exact product navigation, scoped source transactions, totals/aging relationships, manual evidence |
| Purchase dimensions | Supplier/product reports are named; class/location variants depend on tracking and customization | Enabled dimensions, assigned/unassigned completeness, product render |
| Inventory quantity/purchases/adjustments | Product inventory views, filtered purchase reports, or Advanced transaction search | Inventory preference, item-line coverage, quantity/value roll-forward, manual evidence |
| Project time/cost/unbilled | Projects and related settings are conditional; no exact endpoint is named | Entitlement, selected cost basis, per-project completeness, manual evidence |
| Canadian tax detail/exceptions | Canada product provides GST/HST/provincial and Exception Detail workflows; `TaxSummary` is not a Canada substitute | Province/filing basis, tax controls, exceptions, reviewed manual evidence |
| Management, cleared/account-history, and audit | Product compositions or account/admin views rather than published report endpoints | Exact scope, permissions, filters, retention/freshness, manual evidence |

## Invalidation rules

Evidence becomes stale when any of these changes:

- blueprint version or report prerequisite;
- company preference, entitlement, accounting method, fiscal/closing date, or enabled dimension;
- a managed transaction inside the evidence period;
- a manual reconciliation, tax filing, budget, or user-role state;
- report endpoint/parameter support or QBO product behaviour;
- an assertion definition or rounding tolerance.

Raw report responses are not the product record by default. Retain normalized parameters, totals, assertions, QBO request identifiers where available, freshness, and approved manual evidence references.
