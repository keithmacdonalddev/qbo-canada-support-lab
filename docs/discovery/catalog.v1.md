# Test Data Lab Capability and Report Catalog

**Catalog:** 1.0.0
**Status:** Discovery
**As of:** 2026-08-09
**Authority:** `catalog.v1.json` validated by `registry.schema.v1.json`

This is a human-readable view of the versioned JSON catalog. Run `npm run render:discovery` after catalog changes.

## Practical status

- 14 Tier 1 capabilities; 2 still have a product/API classification unknown.
- 24 total capabilities; 24 still need flagship-dataset evidence.
- 48 reports; 0 still have a product/API classification unknown and 48 still need dataset/report evidence.
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
| `sales.receivables-lifecycle` | Tier 1 | Available | Rest; R:supported · C:unknown · U:unknown · D:supported · V:unknown | Partial | Unknown |
| `expenses.payables-lifecycle` | Tier 1 | Available | Rest; R:supported · C:unknown · U:unknown · D:supported · V:unknown | Partial | Unknown |
| `banking.cash-and-clearing` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:conditional · V:conditional | Not Implemented | Unknown |
| `tax.canadian-sales-tax` | Tier 1 | Available | Rest And Graphql; R:supported · C:conditional · U:conditional · D:unsupported · V:not-applicable | Not Implemented | Unknown |
| `projects.project-lifecycle` | Tier 1 | Conditional | Rest And Graphql; R:supported · C:supported · U:supported · D:supported · V:not-applicable | Not Implemented | Unknown |
| `accounting.journals-and-close` | Tier 1 | Available | Rest; R:supported · C:supported · U:supported · D:supported · V:not-applicable | Partial | Unknown |
| `accounting.reconciliation` | Manual Only Critical | Available | None; R:manual-only · C:manual-only · U:manual-only · D:manual-only · V:not-applicable | Not Implemented | Unknown |
| `accounting.budgets` | Tier 2 | Available | Rest; R:supported · C:unknown · U:unknown · D:unknown · V:not-applicable | Not Implemented | Unknown |
| `company.dimensions` | Tier 2 | Conditional | Rest And Graphql; R:supported · C:conditional · U:conditional · D:conditional · V:not-applicable | Not Implemented | Unknown |
| `users.qbo-company-roles` | Manual Only Critical | Available | None; R:manual-only · C:manual-only · U:manual-only · D:manual-only · V:not-applicable | Not Implemented | Unknown |
| `reporting.reports-api` | Tier 1 | Available | Rest; R:supported · C:not-applicable · U:not-applicable · D:not-applicable · V:not-applicable | Not Implemented | Unknown |
| `administration.api-budgets` | Tier 1 | Available | Rest; R:not-applicable · C:not-applicable · U:not-applicable · D:not-applicable · V:not-applicable | Partial | Unknown |
| `administration.full-pagination` | Tier 1 | Available | Rest; R:supported · C:not-applicable · U:not-applicable · D:not-applicable · V:not-applicable | Not Implemented | Unknown |
| `accounting.recurring-transactions` | Tier 2 | Available | Rest; R:supported · C:supported · U:unknown · D:supported · V:not-applicable | Not Implemented | Unknown |
| `company.multicurrency` | Tier 2 | Conditional | Rest; R:supported · C:conditional · U:conditional · D:unsupported · V:not-applicable | Not Implemented | Unknown |
| `company.custom-fields` | Tier 2 | Conditional | Rest And Graphql; R:conditional · C:conditional · U:conditional · D:conditional · V:not-applicable | Not Implemented | Unknown |
| `administration.attachments` | Tier 2 | Available | Rest; R:supported · C:supported · U:conditional · D:conditional · V:not-applicable | Not Implemented | Unknown |
| `expenses.time-activity` | Tier 2 | Conditional | Rest And Graphql; R:supported · C:supported · U:supported · D:supported · V:not-applicable | Not Implemented | Unknown |
| `accounting.payroll-summary` | Manual Only Critical | Conditional | Rest And Graphql; R:conditional · C:manual-only · U:manual-only · D:manual-only · V:not-applicable | Not Implemented | Unknown |

Operation abbreviations are Read, Create, Update, Delete, and Void. `Unknown` means the reviewed sources do not establish the exact operation yet. `Conditional` means support is established but varies by entity, entitlement, preference, locale, or record state and must be resolved at the operation boundary.

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
| `report.reconciliation-summary` | Critical | Reconciliation | Available | Manual product evidence | Unknown |
| `report.journal` | Critical | Financial | Available | Manual product evidence | Unknown |
| `report.cash-summary` | Supporting | Cash | Conditional | Manual product evidence | Unknown |
| `report.invoice-list` | Supporting | Receivables | Available | Manual product evidence | Unknown |
| `report.collections` | Supporting | Receivables | Available | Manual product evidence | Unknown |
| `report.customer-statements` | Supporting | Receivables | Available | Manual product evidence | Unknown |
| `report.unpaid-bills` | Supporting | Payables | Available | Manual product evidence | Unknown |
| `report.purchases-by-vendor` | Supporting | Payables | Available | Manual product evidence | Unknown |
| `report.purchases-by-product` | Supporting | Payables | Available | Manual product evidence | Unknown |
| `report.purchases-by-class` | Supporting | Payables | Conditional | Manual product evidence | Unknown |
| `report.purchases-by-location` | Supporting | Payables | Conditional | Manual product evidence | Unknown |
| `report.inventory-quantity-on-hand` | Critical | Inventory | Conditional | Manual product evidence | Unknown |
| `report.inventory-purchases` | Supporting | Inventory | Conditional | Manual product evidence | Unknown |
| `report.inventory-adjustments` | Supporting | Inventory | Conditional | Manual product evidence | Unknown |
| `report.project-time-cost` | Supporting | Projects | Conditional | Manual product evidence | Unknown |
| `report.project-unbilled-activity` | Supporting | Projects | Conditional | Manual product evidence | Unknown |
| `report.tax-detail` | Critical | Tax | Conditional | Manual product evidence | Unknown |
| `report.management-comparison` | Supporting | Budget | Available | Manual product evidence | Unknown |
| `report.cleared-uncleared` | Supporting | Reconciliation | Conditional | Manual product evidence | Unknown |
| `report.account-history` | Supporting | Reconciliation | Available | Manual product evidence | Unknown |
| `report.audit-log` | Supporting | Audit | Available | Manual product evidence | Unknown |
| `report.transaction-exceptions` | Supporting | Audit | Conditional | Manual product evidence | Unknown |

## Remaining static classification queue

- `sales.receivables-lifecycle`: Current generation covers only narrow randomized AR chains and is not resumable. Exact create/update operation sections are not recorded from the current per-entity references and remain unknown for all seven entities. Invoice has direct void documentation, while webhook Void events for SalesReceipt, Payment, CreditMemo, and RefundReceipt do not establish an invokable API operation. The draft entity matrix is maintained in entity-operation-matrix.v1.json; its 18 unknown AR operations and all sandbox mutation evidence remain release-blocking.
- `expenses.payables-lifecycle`: Current generation covers only narrow randomized AP chains and does not model a durable purchasing narrative. Exact create/update operation sections are not recorded from the current per-entity references and remain unknown for all five entities. Webhook Void events for Purchase and BillPayment do not establish invokable API void operations; both remain unknown. The draft matrix records 12 unknown AP operations, including the historical Phase 0 PurchaseOrder create failure. No new write path is authorized.
- `accounting.budgets`: General budget write operations are not established by the current official-source pass; keep create/update/delete manual until API Explorer review is recorded. The separate premium Project Budget API is US-only for the documented QBO Advanced use case and is not a Canada substitute.
- `accounting.recurring-transactions`: Update support is not established by the reviewed release notes. Generated occurrences require their own managed lifecycle and idempotency evidence.

## Dataset and live evidence queue

- Observe current connected-company preferences, entitlements, dimensions, custom fields, Projects, time/payroll availability, and report availability only after a read-only target is explicitly approved.
- Run pagination and rate/latency benchmarks only against an explicitly approved sandbox or read-only target.
- Run uncertain writes only as separately approved sandbox spikes with exact budgets and cleanup/compensation notes.
- Keep Canadian tax and accounting fixtures behind current authoritative research and accounting review.
- Keep Production scheduling and automatic mutations disabled.

## Official sources

- [What you can do with the QuickBooks Online Accounting API](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api) — Intuit Developer; accessed 2026-08-08. Platform overview for entity categories, common operations, query, batch, CDC, update, and delete semantics.
- [Get started with the API Explorer](https://developer.intuit.com/app/developer/qbo/docs/get-started/get-started-with-the-api-explorer) — Intuit Developer; accessed 2026-08-08. Records the API Explorer as the per-entity authority for supported operations and fields.
- [Manage linked transactions](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-linked-transactions) — Intuit Developer; accessed 2026-08-09. Documents API Invoice-void support and linked-transaction effects, and points to the per-entity API reference for the specific request.
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
- [Configure webhooks: supported entity lifecycle events](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks/configure-webhooks) — Intuit; accessed 2026-08-09. Entity-level Create, Update, Delete, and Void event matrix used only with the Accounting API overview and API Explorer guide; webhook support is corroborating documentation, not runtime mutation evidence.
- [Differences in report features among QuickBooks Online subscriptions](https://quickbooks.intuit.com/learn-support/en-ca/help-article/purchase-orders/differences-report-features-among-quickbooks/L8c99Bwex_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product inventory for Journal, Audit Log, inventory reports, transaction reports, and related standard report availability.
- [Custom fields and reports in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/class-list/tag-transactions-quickbooks-online/L7x3G0aLv_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product report list includes Collections, Open Invoices, Invoice List, and Unpaid Bills.
- [Create and send customer statements in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/customer-statements/create-send-customer-statements-quickbooks-online/L8bvb69Gg_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product procedure and Balance Forward, Open Item, and Transaction statement variants.
- [Use reports to track cash flow](https://quickbooks.intuit.com/learn-support/en-us/help-article/banking/track-cash-flow-quickbooks-online/L9xpDaG5b_US_en_US) — Intuit; accessed 2026-08-09. Product procedures for Statement of Cash Flows, Open Invoices, and Unpaid Bills; used to classify the plan's Cash Summary family without inventing a second Reports API endpoint.
- [Create and send purchase orders](https://quickbooks.intuit.com/learn-support/en-ca/help-article/purchase-orders/create-send-purchase-orders-quickbooks-online/L2mVpjOoq_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product procedure names Purchases by Product/Service Detail and Purchases by Supplier Detail reports.
- [Run reports by class](https://quickbooks.intuit.com/learn-support/en-ca/help-article/class-list/run-reports-class/L73XjI7rG_CA_en_CA) — Intuit; accessed 2026-08-09. Canada Plus/Advanced product procedure for Purchases by Class Detail and class-based reporting.
- [Small business financial reporting](https://quickbooks.intuit.com/ca/reporting/) — Intuit; accessed 2026-08-09. Canada reporting overview documents report filtering by customer, vendor, product, project, and location and Advanced custom reporting.
- [Set up and track inventory in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/inventory-management/set-track-inventory-quickbooks-online/L22FZLBGN_CA_en_CA) — Intuit; accessed 2026-08-09. Canada Plus/Advanced inventory availability, quantity-on-hand workflow, purchases, sales, and inventory report guidance.
- [Adjust inventory quantity on hand in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/stock-quantity/adjust-inventory-quantity-hand-quickbooks-online/L6O3QhOEZ_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product procedure for finding inventory quantity adjustments with Advanced transactions search.
- [Track hourly labour costs and profitability by project](https://quickbooks.intuit.com/learn-support/en-ca/help-article/regular-payroll/track-hourly-labour-costs-profitability-project/L9ZxBA4sn_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product procedure for Project Profitability and Time cost by employee or supplier.
- [Use project profitability reports](https://quickbooks.intuit.com/learn-support/en-us/help-article/job-costing/use-project-profitability-reports-quickbooks/L7QByPplv_US_en_US) — Intuit; accessed 2026-08-09. Official product report guidance covers project profit margin, time cost, and unbilled time and expenses; Canada connected-company availability remains unobserved.
- [Use reports to troubleshoot problems with sales tax amounts](https://quickbooks.intuit.com/learn-support/en-ca/help-article/sales-taxes/use-reports-troubleshoot-problems-sales-tax/L3EOU7upE_CA_en_CA) — Intuit; accessed 2026-08-09. Canada product procedure for GST/HST or provincial summaries, Exception Detail, and Tax Payable Account reports.
- [Create, view, or edit a Management report](https://quickbooks.intuit.com/learn-support/en-ca/help-article/report-management/view-edit-management-reports-quickbooks-online/L90RAh2XZ_CA_en_CA) — Intuit; accessed 2026-08-09. Canada Advanced management report packages, periods, standard/custom report composition, and export.
- [Run an uncleared cheque report in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/pay-bills/run-report-uncleared-cheques/L5VCVXTIE_CA_en_CA) — Intuit; accessed 2026-08-09. Canada account-report procedure for sorting and filtering transactions by cleared status.
- [Find, review, and edit transactions in account history](https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-registers/find-review-edit-transactions-account-history/L2zTRtQRZ_CA_en_CA) — Intuit; accessed 2026-08-09. Canada account history navigation, filters, sorting, and reconciliation-status behavior.
- [Use the audit log in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/audit-log/use-audit-log-quickbooks-online/L2WoVnW6I_CA_en_CA) — Intuit; accessed 2026-08-09. Canada admin-only Audit Log behavior, event scope, two-year availability, filters, and 150-row product pagination.

## Related artifacts

- `official-surface-classification.v1.md` — product/API/manual conclusions and remaining unknowns.
- `entity-operation-matrix.v1.json` — exact AR/AP entity operation classifications and safety limitations.
- `report-dependency-map.v1.md` — report prerequisites and relationship assertions.
- `flagship-business-profile.v1.json` — proposed coherent business identity and rules.
- `volume-profiles.v1.json` — Development, Flagship, and Scale proposals.

No live QBO call, OAuth flow, database write, or server startup is required to render this summary.
