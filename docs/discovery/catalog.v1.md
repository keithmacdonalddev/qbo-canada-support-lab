# Capability and Report Catalog v1 — Review Copy

**Catalog version:** 1.0.0
**State:** Discovery; not approved coverage
**As of:** 2026-08-08
**Machine-readable source:** `catalog.v1.json`

## Practical result

The starter catalog establishes 18 capability candidates and 17 report candidates. It confirms a small set of cross-cutting official facts, but it deliberately does not claim that the Production company is covered. Sixteen capabilities and all 17 reports still contain at least one release-blocking unknown.

Two cross-cutting capabilities have a non-unknown dataset state, both **partially covered**: full pagination because the existing explorer stops at 100 rows, and API budgets because the current client has some rate-limit handling but no rebuild-wide operation budget. Neither is complete.

## Confirmed from current official Intuit documentation

- The Accounting API models list, transaction, report, inventory, and journal resources. The API Explorer is the authority for each entity's fields and supported operations.
- Queries default to 100 entities, return at most 1,000 per response, and use `STARTPOSITION` plus `MAXRESULTS` for pagination. The current 100-row explorer therefore cannot prove a complete entity catalog.
- The Reports API is read-only report retrieval. Intuit recommends limiting a report request date range to six months, which affects a planned 36-month validation strategy.
- Published REST limits include 500 requests per minute per realm and 10 requests per second per realm/app; HTTP 429 is the documented throttle response. Published ceilings are not an approved target budget.
- The official batch guide says up to 10 payloads, while the limits page says a recommended maximum of 30. That conflict is recorded and must be resolved before the operation engine chooses a batch budget.
- Inventory uses the Item entity. The official guide documents service, non-inventory, inventory, and bundle/group types; inventory relies on inventory asset, income, and COGS accounts and uses FIFO accounting. Item query/create support is documented, while the remaining operation matrix still needs exact entity review.
- Projects and the Project API are documented for QBO Advanced, but app access is conditional: a paid Intuit partner tier, the restricted `project-management.project` scope, Accounting scope, and an enabled Projects preference are required. A product subscription alone is not enough.
- Restricted GraphQL scopes exist for Projects, Custom Fields, Sales Tax, and Payroll Compensation. Their existence does not prove the current app is entitled or that a specific Canada workflow is supported.

Official sources are listed with access dates in `catalog.v1.json`. No community article or search-result inference is used as capability evidence.

## Capability candidates

| Key | Tier | Product/API evidence so far | Dataset state | What remains |
| --- | --- | --- | --- | --- |
| `company.preferences` | Tier 1 | General read/update documented | Unknown | Per-field Canada rules and connected-company observation |
| `accounting.chart-of-accounts` | Tier 1 | Account is a documented resource | Unknown | Exact operations, subtypes, blueprint, close constraints |
| `sales.customers` | Tier 1 | Customer is a documented list resource | Unknown | Exact operations, hierarchy/Canada fields, realistic segments |
| `expenses.vendors` | Tier 1 | Vendor is a documented list resource | Unknown | Exact operations, tax fields, realistic segments |
| `inventory.items` | Tier 1 | Conditional product support; query/create documented | Unknown | Connected preference, full operations, lifecycle fixtures |
| `sales.receivables-lifecycle` | Tier 1 | Core transaction resources documented generally | Unknown | Per-entity links/operations, tax, idempotency, reports |
| `expenses.payables-lifecycle` | Tier 1 | Bill/BillPayment documented generally | Unknown | Purchase orders, links/operations, idempotency, reports |
| `banking.cash-and-clearing` | Tier 1 | Not yet classified | Unknown | Cash entities, cleared state, bank-feed boundary |
| `tax.canadian-sales-tax` | Tier 1 | Restricted tax scope exists | Unknown | Exact Canada REST/GraphQL/manual surface and filing evidence |
| `projects.project-lifecycle` | Tier 1 | Advanced support and GraphQL CRUD documented conditionally | Unknown | Current app tier/scope/preferences and sandbox fixtures |
| `accounting.journals-and-close` | Tier 1 | JournalEntry documented generally | Unknown | Exact operations, golden entries, closed-period behaviour |
| `accounting.reconciliation` | Manual-only critical | No endpoint established yet | Unknown | Official surface review and honest manual evidence model |
| `accounting.budgets` | Tier 2 | Not yet classified | Unknown | Product, API, UI, and report support |
| `company.dimensions` | Tier 2 | Preference flags documented conditionally | Unknown | Entity operations, enabled settings, populated variation |
| `users.qbo-company-roles` | Manual-only critical | No company-user API established yet | Unknown | Official product/API review and manual inventory procedure |
| `reporting.reports-api` | Tier 1 | Reports API documented | Unknown | Full endpoint/parameter map, normalization, assertions |
| `administration.api-budgets` | Tier 1 | Limits documented with a batch conflict | Partially covered | Resolve conflict, define tested budgets, add enforcement |
| `administration.full-pagination` | Tier 1 | Pagination documented | Partially covered | Adapter/tests and approved read-only benchmark |

## Report candidates

API-supported below means the official Reports API documentation names an endpoint. It does not mean Canada applicability, dataset population, accounting plausibility, reconciliation, or UI parity has passed.

| Key | Tier | API status | Product status | Coverage |
| --- | --- | --- | --- | --- |
| `report.balance-sheet` | Critical | `BalanceSheet` documented | Unknown for current Canada company | Unknown |
| `report.profit-and-loss` | Critical | `ProfitAndLoss` documented | Unknown for current Canada company | Unknown |
| `report.trial-balance` | Critical | Named; exact endpoint spelling pending | Unknown | Unknown |
| `report.general-ledger` | Critical | `GeneralLedger` documented generally | Unknown | Unknown |
| `report.cash-flow` | Critical | `CashFlow` documented | Unknown | Unknown |
| `report.ar-aging` | Critical | Unknown | Unknown | Unknown |
| `report.ap-aging` | Critical | Unknown | Unknown | Unknown |
| `report.customer-sales` | Supporting | `CustomerSales` documented | Unknown | Unknown |
| `report.customer-income` | Supporting | `CustomerIncome` documented | Unknown | Unknown |
| `report.item-sales` | Supporting | `ItemSales` documented | Unknown | Unknown |
| `report.class-sales` | Supporting | `ClassSales` documented | Conditional on class data | Unknown |
| `report.inventory-valuation-summary` | Critical | `InventoryValuationSummary` documented | Conditional on inventory | Unknown |
| `report.inventory-valuation-detail` | Supporting | `InventoryValuationDetail` documented | Conditional on inventory | Unknown |
| `report.project-profitability` | Supporting | Unknown | Conditional on Projects and entitlement | Unknown |
| `report.tax-liability` | Critical | Unknown | Unknown for Canada | Unknown |
| `report.budget-vs-actual` | Supporting | Unknown | Unknown | Unknown |
| `report.reconciliation-summary` | Critical | Unknown/manual candidate | Unknown | Unknown |

## Highest-priority research queue

1. Review the exact current API Explorer entry for every Tier 1 entity and record read/create/update/delete/void independently.
2. Resolve QBO company users/roles and reconciliation as product/API/manual-only surfaces without treating a missing search result as proof.
3. Complete the non-US/Canada tax model, filing, and report pass.
4. Verify current Intuit partner tier, restricted scopes, and relevant company preferences without printing credentials or starting OAuth.
5. Finish the exact report list, endpoints, parameters, Canada applicability, UI-only reports, prerequisites, and assertion design.
6. Resolve the official batch-payload discrepancy with current Intuit guidance or support before selecting budgets.
7. Design Development, Flagship, and Scale volume proposals, then request authorization for narrowly bounded sandbox/read observations only where documents and fixtures cannot answer the question.

## Explicitly not done

- No app server was started or restarted.
- No OAuth flow ran.
- No QBO read or write was made.
- No Production company data was inspected or changed.
- No MongoDB record was created, updated, or deleted.
- No capability was marked covered merely because existing source code mentions it.
