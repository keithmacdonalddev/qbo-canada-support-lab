# Coverage: finding gaps from the company's own records

Added 2026-10-02. Coverage answers "which parts of QuickBooks does this company actually use?" by reading the connected company, not by trusting the hand-maintained `coverageState` fields in `docs/discovery/catalog.v1.json` (those remain `unknown`).

## How it works

- `backend/src/modules/coverage.js` gives each catalog feature area a few concrete **signals**, such as "overdue invoices", "a payment not applied to an invoice", "bills tagged with a class" or "time logged to a project".
- One check runs about 31 read-only `SELECT` queries: the list entities (customers, vendors, items, accounts, classes, locations, terms, tax codes, employees, budgets, recurring templates, attachments, currencies, sales tax payments, preferences) and the last 365 days of 16 transaction types, up to 1,000 records each.
- Each signal is scored as:
  - **in use**: matching records exist (activity signals also need one within their freshness window, 45 to 180 days).
  - **stale**: matching records exist, but not recently.
  - **missing**: no matches in the last 12 months.
  - **manual**: apps can't read it (reconciliation, users and roles, payroll).
  - **couldn't check**: QuickBooks refused that read.
- Each gap also records who can close it. **assistant** means the AI can create that record type through an approved plan (`WRITABLE_ENTITY_TYPES` in `ai-tools.js`). **quickbooks** means a person does it in QuickBooks.
- The three catalog areas that describe this app rather than the company's data (`reporting.reports-api`, `administration.api-budgets` and `administration.full-pagination`) aren't scored.

## Where it shows up

- `GET /api/coverage` returns the result for the user's active connection. It is cached in memory per company for 10 minutes. `?refresh=true` reads the company again, at most once a minute. `?cached=true` never calls QuickBooks.
- The UI shows coverage in three places: the **Coverage** page (`/coverage`) with every area's signals, the home page's side panel, and a panel on the Company page. "Ask the assistant to fill" opens a normal case with a prefilled request. Writes still need plan approval and, in production, the typed confirmation.
- The assistant gets the last coverage summary in its instructions and two read-only tools: `getCoverage` and `runReport` (the 23 Reports API reports listed in the catalog).
- Running an approved plan clears the company's cached result, so already-filled gaps aren't proposed again.

## Limits

- The signals are a reviewable set, not the full feature matrix. On 2026-10-02 they were checked against the live company with a read-only census of every queryable entity. That census added current (not yet due) invoices and bills, billable expenses, bills paid by credit card, inventory adjustments and sales tax payments.
- Report coverage isn't scored. The assistant can run reports, but the map only links each area to the reports that depend on it.
- Enhanced custom fields (GraphQL) aren't measured.
