# Report Dependency Map v1

**Status:** Static proposal
**As of:** 2026-08-08
**Authority:** `catalog.v1.json` and rebuild plan section 13

A report is not “covered” because its endpoint returns HTTP 200. It moves independently through availability, populated, plausible, reconciled, and manual-verification evidence.

## Required inventory boundary

`required-report-manifest.v1.json` maps all 48 report rows required by plan section 13.2 to stable catalog keys. Twenty-three rows currently map to published Reports API endpoints, four have an initial manual/conditional product classification, and 21 remain explicit `unknown` rows. Those unresolved rows are present so they cannot disappear from review; they are not release evidence.

The unresolved queue covers Journal, Cash Summary, Invoice List, Collections, Customer Statements, Unpaid Bills, purchases by vendor/product/class/location, inventory quantity/purchases/adjustments, project time/cost/unbilled activity, Tax Detail, management comparison, cleared/uncleared activity, account history, audit log, and transaction exceptions. Each needs an exact API, product/manual, unsupported, or approved-exclusion decision plus the same prerequisite and assertion review used below.

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

## Invalidation rules

Evidence becomes stale when any of these changes:

- blueprint version or report prerequisite;
- company preference, entitlement, accounting method, fiscal/closing date, or enabled dimension;
- a managed transaction inside the evidence period;
- a manual reconciliation, tax filing, budget, or user-role state;
- report endpoint/parameter support or QBO product behaviour;
- an assertion definition or rounding tolerance.

Raw report responses are not the product record by default. Retain normalized parameters, totals, assertions, QBO request identifiers where available, freshness, and approved manual evidence references.
