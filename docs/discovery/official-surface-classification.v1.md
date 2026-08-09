# Official QBO Surface Classification v1

**Status:** Report static classification complete; Tier 1 operation, connected-company, and sandbox evidence remain open
**As of:** 2026-08-09
**Scope:** QuickBooks Online Advanced Canada and the Test Data Lab integration
**Rule:** Product availability, API support, app implementation, and flagship-dataset coverage are four different facts.

## Practical result

The published surface is broad enough for a believable accounting spine: accounts, customers, vendors, items, sales, payables, cash transactions, journals, reports, time activity, and conditional Advanced features all have documented API paths. It is not broad enough to automate every important support workflow honestly.

Two release-critical areas are classified as manual evidence:

- QBO company users and custom roles are managed in the QBO product. No company-user administration entity appears in the reviewed Accounting API index.
- Official bank and credit-card reconciliation is completed in the QBO product. No reconciliation entity or Reconciliation Report endpoint appears in the reviewed Accounting API entity/report indexes.

Those are dated conclusions about the current published indexes, not timeless claims. Recheck them when Intuit changes the API surface.

## Classification matrix

| Capability | QBO Advanced Canada product | Published API surface | Rebuild treatment | Evidence still required |
| --- | --- | --- | --- | --- |
| Company preferences | Available | REST read/update by field | Tier 1, server-policy writes later | Read-only connected Preferences inventory; field allowlist |
| Chart of accounts | Available | REST read/create/update; deactivate through update | Tier 1 | Canada subtype fixture; intended blueprint accounts |
| Customers | Available | REST read/create/update; deactivate through update | Tier 1 | Hierarchy, province, tax, and lifecycle fixtures |
| Vendors | Available | REST read/create/update; deactivate through update | Tier 1 | Tax identifiers, terms, and behavioural segments |
| Items and inventory | Conditional on product preference | REST read/create/update; item-type conditions | Tier 1 | Connected preference; FIFO/accounting lifecycle fixtures |
| Receivables lifecycle | Available | REST read/delete established across seven entities; exact create/update references and most void operations unresolved | Tier 1 | Record 18 exact operation references in `entity-operation-matrix.v1.json`; then idempotency, linked-state, closed-period, and Canadian tax sandbox fixtures |
| Payables lifecycle | Available | REST read/delete established across five entities; exact create/update references and void operations unresolved | Tier 1 | Record 12 exact operation references in `entity-operation-matrix.v1.json`; then idempotency, linked-state, closed-period, and Canadian tax sandbox fixtures |
| Banking/cash accounting | Available | REST Deposit, Transfer, Purchase, Payment, and account data | Tier 1 accounting preparation | Bank feeds and official reconciliation are not assumed |
| Canadian sales tax | Available | REST tax fields/entities plus restricted premium GraphQL Sales Tax API | Tier 1, entitlement-dependent | Partner scope, current company setup, reviewed Canada tax fixtures |
| Projects | Conditional | Premium REST/GraphQL Project API and accounting transactions | Tier 1 product target | Partner tier, restricted scope, Projects preference, sandbox fixtures |
| Journals and close | Available | REST JournalEntry and Preferences | Tier 1 | Golden debit/credit fixtures; closed-period rejection tests |
| Official reconciliation | Available | No published Accounting API entity/report endpoint found | Manual-only critical | Redacted UI evidence and statement/control-account preparation |
| Budgets | Available | REST Budget read/query established; general writes unresolved | Tier 2 | API Explorer write-operation review; manual comparison evidence |
| Classes and locations | Conditional on preferences | REST entities plus newer premium Dimensions API | Tier 2 | Enabled settings and premium entitlement observation |
| QBO company users/roles | Available, including Advanced custom roles | No published Accounting API administration entity found | Manual-only critical | Redacted role inventory and review cadence |
| Reports | Available | 23 published Reports API endpoints in the current table | Tier 1 | Connected-company availability, population, parity, assertions |
| Recurring transactions | Available | REST read/create/delete documented; update unresolved | Tier 2 | Per-operation API Explorer review and sandbox templates |
| Multicurrency | Conditional and irreversible once enabled | REST Preferences/currency-aware entities | Tier 2, separate activation decision | Current preference and sandbox-only accounting fixtures |
| Enhanced custom fields | Advanced-only | Restricted premium Custom Fields API plus entity fields | Tier 2 | Partner entitlement and per-entity support |
| Attachments | Available | REST Attachable/upload surface | Tier 2 | Privacy, retention, size/type fixtures, sandbox check |
| Time activity | Conditional | REST TimeActivity; richer Workforce/payroll APIs are restricted | Tier 2 | Product/entitlement inventory and project-cost fixtures |
| Payroll summary | Conditional on payroll product | Restricted payroll/time surfaces exist | Manual-only default | Redacted product inventory and accountant-reviewed aggregate fixtures |
| Request budgets | Available | Published REST/GraphQL limits and 429 behaviour | Tier 1 platform rule | Sandbox latency/rate observation; batch conflict resolution |
| Full pagination | Available | REST query paging; 100 default and 1,000 maximum results | Tier 1 platform rule | Adapter contract tests and approved read-only benchmark |

## Reports API inventory

The plan-required manifest contains 48 report rows. The current official Reports API table names 23 endpoints:

`BalanceSheet`, `ProfitAndLoss`, `ProfitAndLossDetail`, `TrialBalance`, `CashFlow`, `InventoryValuationSummary`, `InventoryValuationDetail`, `CustomerSales`, `ItemSales`, `DepartmentSales`, `ClassSales`, `CustomerIncome`, `CustomerBalance`, `CustomerBalanceDetail`, `AgedReceivables`, `AgedReceivableDetail`, `VendorBalance`, `VendorBalanceDetail`, `AgedPayables`, `AgedPayableDetail`, `VendorExpenses`, `AccountListDetail`, and `GeneralLedgerDetail`.

The same table marks `TaxSummary` as France-only. Test Data Lab therefore treats Canadian Sales Tax Liability as a product/manual report unless Intuit publishes a Canada endpoint later.

The other 25 rows are classified as product/manual or conditional workflows because no exact endpoint is named in the current Reports API table. This includes the four initial manual rows plus the 21 rows completed on 2026-08-09. Several stable catalog keys intentionally map a plan family to an exact product view or customized report rather than pretending an identically named API report exists—for example Cash Summary, Purchases by Location, Inventory Adjustments, and Transaction Exceptions.

All 48 required rows now have a static API/product decision, prerequisites, assertions, navigation when manual, dated sources, and explicit discrepancies. That completes static classification only. Connected-company availability, populated output, accounting plausibility, report parity, freshness, and owner approval remain release-blocking evidence.

## Tier 1 entity operation matrices

`entity-operation-matrix.v1.json` records the exact seven receivables and five payables entities. The reviewed overview establishes reads and permanent deletion for the named transaction entities, but the catalog does not yet record each entity reference's create/update operation sections. All 24 create/update cells therefore remain `unknown`. Invoice void has direct API documentation. Webhook Void events for SalesReceipt, Payment, CreditMemo, RefundReceipt, Purchase, and BillPayment establish notification availability only, so those six API void operations also remain `unknown`. No Void operation was established for Estimate, Deposit, PurchaseOrder, Bill, or VendorCredit; the matrix says `not-documented` rather than inventing support or a timeless unsupported claim. The historical Phase 0 PurchaseOrder create failure is retained as a discrepancy, not generalized into a timeless unsupported claim.

The matrix combines the Accounting API overview and per-entity API Explorer authority with Intuit's current entity lifecycle-event table. It does not make a write safe. Linked transactions, record state, preferences, entitlements, locale, and closed periods still require an approved sandbox test before a new mutation path can be implemented.

## Limits and provisional operating policy

Published REST limits include 500 requests per minute per realm, 10 requests per second per realm/app, a maximum of 1,000 query entities per response, and a recommended report range of six months. The current limits page recommends no more than 30 payloads in a batch, while the batch guide says up to 10.

Until Intuit resolves that conflict or a controlled sandbox observation proves otherwise, the proposal uses the stricter value: at most 10 payloads per batch. That is a defensive design input, not permission to run a workload.

## Known unknowns that remain release-blocking

- Current connected-company preferences, entitlements, custom fields, Projects access, dimensions, payroll/time availability, and actual report availability.
- Exact general Budget create/update/delete support.
- RecurringTransaction update support.
- Exact create/update references for all 12 AR/AP entities and exact void support for SalesReceipt, Payment, CreditMemo, RefundReceipt, Purchase, and BillPayment: 30 Tier 1 operation questions total.
- Entity-specific request payload, linked-state, entitlement, and closed-period behavior for any future receivables/payables mutation path.
- Current dataset coverage, report population, report parity, and accounting plausibility.
- Pagination, rate, and latency behaviour on an explicitly approved target.
- Canadian tax golden fixtures and accounting review.

## Official sources

- [Accounting API overview](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api)
- [API Explorer guide](https://developer.intuit.com/app/developer/qbo/docs/get-started/get-started-with-the-api-explorer)
- [Reports API](https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports)
- [Query operations and pagination](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
- [API limits and throttles](https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles)
- [Batch operations](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/batch)
- [Projects](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-projects)
- [Scopes](https://developer.intuit.com/app/developer/qbo/docs/learn/scopes)
- [QBO release notes](https://developer.intuit.com/app/developer/qbo/docs/release-notes/general-release-notes)
- [Manage linked transactions](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-linked-transactions)
- [Supported entity lifecycle events](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks/configure-webhooks)
- [Canada users](https://quickbooks.intuit.com/learn-support/en-ca/account-settings/add-delete-or-change-user-access/00/262171)
- [Canada Advanced custom roles](https://quickbooks.intuit.com/learn-support/en-ca/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_CA_en_CA)
- [Canada reconciliation](https://quickbooks.intuit.com/learn-support/en-ca/help-article/reconciliation-reports/reconcile-account-quickbooks-online/L96JWj4je_CA_en_CA)
- [Canada reconciliation reports](https://quickbooks.intuit.com/learn-support/en-ca/reports/how-do-i-view-print-or-export-a-reconciliation-report/00/262145)
- [Canada sales tax setup](https://quickbooks.intuit.com/learn-support/en-ca/help-article/sales-taxes/set-use-sales-tax-quickbooks-online/L4Lx8eL7V_CA_en_CA)
- [Canada sales tax filing boundary](https://quickbooks.intuit.com/learn-support/en-ca/help-article/remit-sales-taxes/file-sales-tax-return-record-tax-payment-online/L7ZeSlAr1_CA_en_CA)
- [Canada report feature inventory](https://quickbooks.intuit.com/learn-support/en-ca/help-article/purchase-orders/differences-report-features-among-quickbooks/L8c99Bwex_CA_en_CA)
- [Canada management reports](https://quickbooks.intuit.com/learn-support/en-ca/help-article/report-management/view-edit-management-reports-quickbooks-online/L90RAh2XZ_CA_en_CA)
- [Canada sales-tax troubleshooting reports](https://quickbooks.intuit.com/learn-support/en-ca/help-article/sales-taxes/use-reports-troubleshoot-problems-sales-tax/L3EOU7upE_CA_en_CA)

No live QBO call, OAuth flow, database write, or server startup was used for this classification.
