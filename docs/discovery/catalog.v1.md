# Test Data Lab Capability and Report Catalog

**Catalog:** 1.0.0
**Status:** Discovery
**As of:** 2026-08-08
**Authority:** `catalog.v1.json` validated by `registry.schema.v1.json`

This is a human-readable view of the versioned JSON catalog. Run `npm run render:discovery` after catalog changes.

## Practical status

- 14 Tier 1 capabilities; 2 still have a product/API classification unknown.
- 24 total capabilities; 19 still need flagship-dataset evidence.
- 48 reports; 21 still have a product/API classification unknown and 47 still need dataset/report evidence.
- Unknown dataset coverage is intentional until a fixture, sandbox, or approved connected-company observation proves it.
- Production scheduling and discovery mutations remain disabled.

## Capabilities

| Key | Tier | Product | API surface and operations | App | Dataset |
| --- | --- | --- | --- | --- | --- |
| `company.preferences` | Tier 1 | Available | Rest; R:supported · C:not-applicable · U:supported · D:not-applicable · V:not-applicable | Partial | Unknown |
| `accounting.chart-of-accounts` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:unsupported · V:not-applicable | Partial | Unknown |
| `sales.customers` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:unsupported · V:not-applicable | Partial | Unknown |
| `expenses.vendors` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:unsupported · V:not-applicable | Partial | Unknown |
| `inventory.items` | Tier 1 | Conditional | Rest; R:supported · C:supported · U:supported · D:unsupported · V:not-applicable | Partial | Unknown |
| `sales.receivables-lifecycle` | Tier 1 | Available | Rest; R:supported · C:supported · U:unknown · D:unknown · V:unknown | Partial | Unknown |
| `expenses.payables-lifecycle` | Tier 1 | Available | Rest; R:supported · C:supported · U:unknown · D:unknown · V:unknown | Partial | Unknown |
| `banking.cash-and-clearing` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:conditional · V:conditional | Not Implemented | Unknown |
| `tax.canadian-sales-tax` | Tier 1 | Available | Rest And Graphql; R:supported · C:conditional · U:conditional · D:unsupported · V:not-applicable | Not Implemented | Unknown |
| `projects.project-lifecycle` | Tier 1 | Conditional | Rest And Graphql; R:supported · C:supported · U:supported · D:supported · V:not-applicable | Not Implemented | Unknown |
| `accounting.journals-and-close` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:supported · V:not-applicable | Partial | Unknown |
| `accounting.reconciliation` | Manual Only Critical | Available | None; R:manual-only · C:manual-only · U:manual-only · D:manual-only · V:not-applicable | Not Implemented | Manual Only |
| `accounting.budgets` | Tier 2 | Available | Rest; R:supported · C:unknown · U:unknown · D:unknown · V:not-applicable | Not Implemented | Unknown |
| `company.dimensions` | Tier 2 | Conditional | Rest And Graphql; R:supported · C:conditional · U:conditional · D:conditional · V:not-applicable | Not Implemented | Unknown |
| `users.qbo-company-roles` | Manual Only Critical | Available | None; R:manual-only · C:manual-only · U:manual-only · D:manual-only · V:not-applicable | Not Implemented | Manual Only |
| `reporting.reports-api` | Tier 1 | Available | Rest; R:supported · C:not-applicable · U:not-applicable · D:not-applicable · V:not-applicable | Not Implemented | Unknown |
| `administration.api-budgets` | Tier 1 | Available | Rest; R:not-applicable · C:not-applicable · U:not-applicable · D:not-applicable · V:not-applicable | Partial | Partially Covered |
| `administration.full-pagination` | Tier 1 | Available | Rest; R:supported · C:not-applicable · U:not-applicable · D:not-applicable · V:not-applicable | Not Implemented | Partially Covered |
| `accounting.recurring-transactions` | Tier 2 | Available | Rest; R:supported · C:supported · U:unknown · D:supported · V:not-applicable | Not Implemented | Unknown |
| `company.multicurrency` | Tier 2 | Conditional | Rest; R:supported · C:conditional · U:conditional · D:unsupported · V:not-applicable | Not Implemented | Unknown |
| `company.custom-fields` | Tier 2 | Conditional | Rest And Graphql; R:conditional · C:conditional · U:conditional · D:conditional · V:not-applicable | Not Implemented | Unknown |
| `administration.attachments` | Tier 2 | Available | Rest; R:supported · C:supported · U:conditional · D:conditional · V:not-applicable | Not Implemented | Unknown |
| `expenses.time-activity` | Tier 2 | Conditional | Rest And Graphql; R:supported · C:supported · U:supported · D:supported · V:not-applicable | Not Implemented | Unknown |
| `accounting.payroll-summary` | Manual Only Critical | Conditional | Rest And Graphql; R:conditional · C:manual-only · U:manual-only · D:manual-only · V:not-applicable | Not Implemented | Manual Only |

Operation abbreviations are Read, Create, Update, Delete, and Void. `Conditional` means the operation varies by entity, entitlement, preference, locale, or record state and must be resolved at the operation boundary.

## Reports

| Key | Tier | Family | Product | Retrieval | Dataset |
| --- | --- | --- | --- | --- | --- |
| `report.balance-sheet` | Critical | Financial | Available | API: BalanceSheet | Unknown |
| `report.profit-and-loss` | Critical | Financial | Available | API: ProfitAndLoss | Unknown |
| `report.trial-balance` | Critical | Financial | Available | API: TrialBalance | Unknown |
| `report.general-ledger` | Critical | Financial | Available | API: GeneralLedgerDetail | Unknown |
| `report.cash-flow` | Critical | Cash | Available | API: CashFlow | Unknown |
| `report.ar-aging` | Critical | Receivables | Available | API: AgedReceivables | Unknown |
| `report.ap-aging` | Critical | Payables | Available | API: AgedPayables | Unknown |
| `report.profit-and-loss-detail` | Supporting | Financial | Available | API: ProfitAndLossDetail | Unknown |
| `report.customer-balance` | Supporting | Receivables | Available | API: CustomerBalance | Unknown |
| `report.customer-balance-detail` | Supporting | Receivables | Available | API: CustomerBalanceDetail | Unknown |
| `report.ar-aging-detail` | Supporting | Receivables | Available | API: AgedReceivableDetail | Unknown |
| `report.vendor-balance` | Supporting | Payables | Available | API: VendorBalance | Unknown |
| `report.vendor-balance-detail` | Supporting | Payables | Available | API: VendorBalanceDetail | Unknown |
| `report.ap-aging-detail` | Supporting | Payables | Available | API: AgedPayableDetail | Unknown |
| `report.vendor-expenses` | Supporting | Expenses | Available | API: VendorExpenses | Unknown |
| `report.department-sales` | Supporting | Sales | Conditional | API: DepartmentSales | Unknown |
| `report.account-list-detail` | Supporting | Financial | Available | API: AccountListDetail | Unknown |
| `report.customer-sales` | Supporting | Sales | Available | API: CustomerSales | Unknown |
| `report.customer-income` | Supporting | Sales | Available | API: CustomerIncome | Unknown |
| `report.item-sales` | Supporting | Sales | Available | API: ItemSales | Unknown |
| `report.class-sales` | Supporting | Sales | Conditional | API: ClassSales | Unknown |
| `report.inventory-valuation-summary` | Critical | Inventory | Conditional | API: InventoryValuationSummary | Unknown |
| `report.inventory-valuation-detail` | Supporting | Inventory | Conditional | API: InventoryValuationDetail | Unknown |
| `report.project-profitability` | Supporting | Projects | Conditional | Manual product evidence | Unknown |
| `report.tax-liability` | Critical | Tax | Available | Manual product evidence | Unknown |
| `report.budget-vs-actual` | Supporting | Budget | Available | Manual product evidence | Unknown |
| `report.reconciliation-summary` | Critical | Reconciliation | Available | Manual product evidence | Manual Only |
| `report.journal` | Critical | Financial | Unknown | Unknown | Unknown |
| `report.cash-summary` | Supporting | Cash | Unknown | Unknown | Unknown |
| `report.invoice-list` | Supporting | Receivables | Unknown | Unknown | Unknown |
| `report.collections` | Supporting | Receivables | Unknown | Unknown | Unknown |
| `report.customer-statements` | Supporting | Receivables | Unknown | Unknown | Unknown |
| `report.unpaid-bills` | Supporting | Payables | Unknown | Unknown | Unknown |
| `report.purchases-by-vendor` | Supporting | Payables | Unknown | Unknown | Unknown |
| `report.purchases-by-product` | Supporting | Payables | Unknown | Unknown | Unknown |
| `report.purchases-by-class` | Supporting | Payables | Unknown | Unknown | Unknown |
| `report.purchases-by-location` | Supporting | Payables | Unknown | Unknown | Unknown |
| `report.inventory-quantity-on-hand` | Critical | Inventory | Unknown | Unknown | Unknown |
| `report.inventory-purchases` | Supporting | Inventory | Unknown | Unknown | Unknown |
| `report.inventory-adjustments` | Supporting | Inventory | Unknown | Unknown | Unknown |
| `report.project-time-cost` | Supporting | Projects | Unknown | Unknown | Unknown |
| `report.project-unbilled-activity` | Supporting | Projects | Unknown | Unknown | Unknown |
| `report.tax-detail` | Critical | Tax | Unknown | Unknown | Unknown |
| `report.management-comparison` | Supporting | Budget | Unknown | Unknown | Unknown |
| `report.cleared-uncleared` | Supporting | Reconciliation | Unknown | Unknown | Unknown |
| `report.account-history` | Supporting | Reconciliation | Unknown | Unknown | Unknown |
| `report.audit-log` | Supporting | Audit | Unknown | Unknown | Unknown |
| `report.transaction-exceptions` | Supporting | Audit | Unknown | Unknown | Unknown |

## Remaining static classification queue

- `sales.receivables-lifecycle`: Current generation covers only narrow randomized AR chains and is not resumable. The composite row does not yet contain an entity-by-entity update/delete/void matrix; those operations remain unknown until exact references are recorded.
- `expenses.payables-lifecycle`: Current generation covers only narrow randomized AP chains and does not model a durable purchasing narrative. The composite row does not yet contain an entity-by-entity update/delete/void matrix; those operations remain unknown until exact references are recorded.
- `accounting.budgets`: General budget write operations are not established by the current official-source pass; keep create/update/delete manual until API Explorer review is recorded. The separate premium Project Budget API is US-only for the documented QBO Advanced use case and is not a Canada substitute.
- `accounting.recurring-transactions`: Update support is not established by the reviewed release notes. Generated occurrences require their own managed lifecycle and idempotency evidence.
- `report.journal`: Product/API/manual classification and QBO UI navigation remain unresolved.
- `report.cash-summary`: Relationship to Statement of Cash Flows and any product-only cash summary is unresolved.
- `report.invoice-list`: A query-backed app view must not be mislabeled as an official QBO report.
- `report.collections`: Product report, workflow, and API/query boundary are unresolved.
- `report.customer-statements`: Statement generation and report API support are unresolved.
- `report.unpaid-bills`: A query-backed app view must not be mislabeled as an official QBO report.
- `report.purchases-by-vendor`: Product/API/manual classification remains unresolved.
- `report.purchases-by-product`: Product/API/manual classification remains unresolved.
- `report.purchases-by-class`: Product/API/manual classification and preference requirements remain unresolved.
- `report.purchases-by-location`: Product/API/manual classification and preference requirements remain unresolved.
- `report.inventory-quantity-on-hand`: Product/API/manual classification remains unresolved.
- `report.inventory-purchases`: Product/API/manual classification remains unresolved.
- `report.inventory-adjustments`: Product/API/manual classification remains unresolved.
- `report.project-time-cost`: Product entitlement and product/API/manual classification remain unresolved.
- `report.project-unbilled-activity`: Product entitlement and product/API/manual classification remain unresolved.
- `report.tax-detail`: Canada product/API/manual classification and exact report names remain unresolved.
- `report.management-comparison`: Product/API/manual classification remains unresolved.
- `report.cleared-uncleared`: Product/API/manual classification and cleared-state semantics remain unresolved.
- `report.account-history`: Official register/history, API report, and query-backed evidence boundaries remain unresolved.
- `report.audit-log`: Product/API/manual classification, retention, and export limits remain unresolved.
- `report.transaction-exceptions`: Product/API/manual classification and duplicate-detection policy remain unresolved.

## Dataset and live evidence queue

- Observe current connected-company preferences, entitlements, dimensions, custom fields, Projects, time/payroll availability, and report availability only after a read-only target is explicitly approved.
- Run pagination and rate/latency benchmarks only against an explicitly approved sandbox or read-only target.
- Run uncertain writes only as separately approved sandbox spikes with exact budgets and cleanup/compensation notes.
- Keep Canadian tax and accounting fixtures behind current authoritative research and accounting review.
- Keep Production scheduling and automatic mutations disabled.

## Official sources

- [What you can do with the QuickBooks Online Accounting API](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api) — Intuit Developer; accessed 2026-08-08. Platform overview for entity categories, common operations, query, batch, CDC, update, and delete semantics.
- [Get started with the API Explorer](https://developer.intuit.com/app/developer/qbo/docs/get-started/get-started-with-the-api-explorer) — Intuit Developer; accessed 2026-08-08. Records the API Explorer as the per-entity authority for supported operations and fields.
- [Run reports](https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports) — Intuit Developer; accessed 2026-08-08. Reports API overview, endpoint table, response model, and six-month request-range recommendation.
- [Query operations and syntax](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries) — Intuit Developer; accessed 2026-08-08. Query language and pagination behaviour, including default 100 and maximum 1,000 entities per response.
- [API call limits and throttles](https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles) — Intuit Developer; accessed 2026-08-08. Published request, batch, timeout, entity-response, line, link, and attachment limits.
- [Batch operation](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/batch) — Intuit Developer; accessed 2026-08-08. Batch-operation guide; its ten-payload wording conflicts with the current limits page's recommended maximum of thirty and requires resolution before setting operation budgets.
- [What customers can do with QuickBooks Online](https://developer.intuit.com/app/developer/qbo/docs/learn/learn-quickbooks-online-basics) — Intuit Developer; accessed 2026-08-08. Company preferences, class, department, currency, numbering, and inventory-setting overview.
- [Items and inventory in QuickBooks Online](https://developer.intuit.com/app/developer/qbo/docs/learn/learn-basic-bookkeeping/manage-inventory) — Intuit Developer; accessed 2026-08-08. Item types, FIFO behaviour, account prerequisites, product conditions, and documented create/query support.
- [Manage projects](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-projects) — Intuit Developer; accessed 2026-08-08. Projects product applicability and supported transaction families.
- [Get Started with the Project API](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-projects/get-started) — Intuit Developer; accessed 2026-08-08. Premium partner-tier, OAuth scope, company-preference, REST, and GraphQL access conditions.
- [Learn about scopes](https://developer.intuit.com/app/developer/qbo/docs/learn/scopes) — Intuit Developer; accessed 2026-08-08. Accounting and restricted GraphQL scopes for Projects, Custom Fields, Sales Tax, and Payroll Compensation.
- [QuickBooks Online release notes](https://developer.intuit.com/app/developer/qbo/docs/release-notes/general-release-notes) — Intuit Developer; accessed 2026-08-08. Current premium API, dimensions, project budget, custom-field, sales-tax, and payroll/time surface changes.
- [Minor version summary](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions) — Intuit Developer; accessed 2026-08-08. REST schema history including recurring-transaction read/create/delete and international tax fields.
- [Add and manage users](https://quickbooks.intuit.com/learn-support/en-ca/account-settings/add-delete-or-change-user-access/00/262171) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada product workflow for company users, roles, invitations, changes, and deletion.
- [Add and manage custom roles in QuickBooks Online Advanced](https://quickbooks.intuit.com/learn-support/en-ca/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Advanced product workflow and limits for custom roles.
- [Reconcile an account in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/reconciliation-reports/reconcile-account-quickbooks-online/L96JWj4je_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada product workflow for statement matching, zero-difference completion, and reconciliation history.
- [View, print, or export a reconciliation report](https://quickbooks.intuit.com/learn-support/en-ca/reports/how-do-i-view-print-or-export-a-reconciliation-report/00/262145) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Defines reconciliation report contents, static snapshot behaviour, and QBO UI access.
- [Create recurring invoices and other transactions in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/recurring-transactions/create-recurring-transactions-quickbooks-online/L3WoKX2R8_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada product workflow for scheduled, reminder, and unscheduled templates.
- [Create budgets in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/taxation/create-import-budgets-quickbooks-online/L7SvmSAsU_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada product workflow for profit-and-loss and balance-sheet budgets.
- [Set up and use sales tax in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/sales-taxes/set-use-sales-tax-quickbooks-online/L4Lx8eL7V_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada product workflow for tax setup, transaction tax, liability review, and filing.
- [File a sales tax return and record sales tax payments](https://quickbooks.intuit.com/learn-support/en-ca/help-article/remit-sales-taxes/file-sales-tax-return-record-tax-payment-online/L7ZeSlAr1_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada manual filing boundary and QBO payment-recording workflow.
- [Set up and use Multicurrency in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/multicurrency/learn-multicurrency-quickbooks-online/L5krkKQi8_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Canada product availability, irreversible enablement, and transaction constraints for multicurrency.
- [Create and edit custom fields](https://quickbooks.intuit.com/learn-support/en-ca/help-article/purchase-orders/create-edit-custom-fields-quickbooks-online/L56PQNif3_CA_en_CA) — Intuit QuickBooks Support Canada; accessed 2026-08-08. Advanced product availability and supported forms/profile surfaces for enhanced custom fields.

## Related artifacts

- `official-surface-classification.v1.md` — product/API/manual conclusions and remaining unknowns.
- `report-dependency-map.v1.md` — report prerequisites and relationship assertions.
- `flagship-business-profile.v1.json` — proposed coherent business identity and rules.
- `volume-profiles.v1.json` — Development, Flagship, and Scale proposals.

No live QBO call, OAuth flow, database write, or server startup is required to render this summary.
