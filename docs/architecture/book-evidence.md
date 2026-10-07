# Read-only book evidence

Added 2026-10-06 as part of whole-app completion. This is evidence infrastructure, not company catch-up or period close.

GET /api/company/book-evidence reads five fixed reports (TrialBalance, BalanceSheet, ProfitAndLoss, AgedReceivables, AgedPayables) and a bounded Account list from the server-selected active company. It accepts a real calendar period of at most one year ending no later than today in America/Halifax, the current flagship planning timezone. No QBO records or report-evidence database records are written by this endpoint. Existing connection token refresh behavior is unchanged.

The Company page displays four distinct assertions: trial-balance debits equal credits, assets equal liabilities and equity, receivables agree with aging, and payables agree with aging. Amount comparisons use integer cents. Ledger reports must confirm report identity, period, accrual basis and CAD currency. Canadian aging may omit ReportBasis: it remains null and is described as dated open-balance evidence, never as a reported accrual basis.

Exact trial-balance account IDs are matched to QBO AccountType. When that mapping is unavailable, one unambiguous supported balance-sheet summary can supply the aggregate receivable/payable balance. Supported English Canadian labels are based on the observed live report summaries. Missing, duplicate, renamed or unsupported totals remain unverified.

Report traversal is bounded to 100,000 rows and 30 levels; each report is flattened once and account rows are indexed. Account discovery has a four-page budget. This bounds dispatch/processing but does not add a transport timeout to the existing client. Separate report calls are not a consistent snapshot; concurrent company edits can require a fresh check.

The UI exposes period, currency, accounting scope, comparison amounts, and up to 50 supporting summary rows per report. Computational checks use the full supported report. A passing result never claims historical continuity, plausible business scale, bank reconciliation or a closed period. Results are scoped to the mounted company/environment and expire from the view on a company change or a new period selection.

## Verification

- Twelve focused fixture tests pass, covering matched/different totals, missing accounts, wrong scope, malformed amounts/dates, duplicate totals, flat/deep row budgets, fixed read endpoints, and Canadian aging/layout differences.
- Backend syntax, frontend build/lint and diff checks pass. Existing bundle-size and three AICommandCenter hook warnings remain.
- Independent implementation and safety reviews were completed; row-budget and indexing findings were corrected.
- Live Production reads exercised the Canadian report layouts and UI loading/partial evidence states. Final four-check observation is recorded in the whole-app completion ledger. No business records changed.
