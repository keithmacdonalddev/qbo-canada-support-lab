# Accountant full tooling — 2026-10-29

Owner direction, 2026-10-29: "build all of them, also it needs the tool list
and descriptions in app … ensure the api is fully tooled to the agent".

## Outcome

The accountant can run the whole business through the QuickBooks API: every
record type QuickBooks lets apps create is reachable through a governed tool,
and the app shows the owner exactly which tools exist and what they reach.

## Done

- In-app tool list and API reach: `/company/accountant/tools`
  (`backend/src/modules/business-agent-catalog.js`, GET
  `/api/company/business-agent/tools`, `frontend/src/pages/AccountantTools.jsx`).
  The coverage table must be updated with every workflow below; a test fails
  when a live tool has no description.
- Agent-approved operations can be inspected and resumed (approval audit
  type `ai_plan`), Progress Invoicing's dropped estimate link is accepted as a
  recorded limitation, QuickBooks per-page `totalCount` is read correctly.

## Constraint that shapes every workflow

Every write must stay inside the governed operation pipeline. Period
verification compares the trial balance with opening balances plus the
postings of managed records (`business-financial-movements.js`). A record
written outside that pipeline makes the next period fail. So each new kind of
record needs, together:

1. Activity policy: a workflow type, its choice validation, the steps it
   creates and their lifecycle contract (`business-activity-batch.js`).
2. Compiler support for the entity payload (`business-transaction-compiler.js`).
3. Read-back verification of the saved record (`business-readback.js`).
4. Postings for financial movements (`business-financial-movements.js`).
5. The agent tool schema and choices (`business-agent-tools.js`,
   governance `activityOptions`).
6. The catalog coverage row (`business-agent-catalog.js`).

Changing the activity policy changes `POLICY_HASH`, which requires the owner's
one-time "Approve the accountant's updated business rules". Ship the new
workflows together under one policy version so the owner approves once.

## Workflows, in order

| # | Workflow | Records | Key difficulty |
|---|---|---|---|
| 1 | Collect an open invoice / pay an open bill | Payment (+Deposit), BillPayment | Parent may be an adopted (imported) record, not a managed step; read-back and graph need an adopted-parent path. |
| 2 | Receive a purchase order | Bill linked to PurchaseOrder lines | Stock FIFO cost; partial receipts. |
| 3 | Credit a customer / refund | CreditMemo (unblock Production), RefundReceipt | Credit application already exists in calendar templates. |
| 4 | Supplier credit | VendorCredit | New compiler + postings. |
| 5 | Cash expense | Purchase | New compiler + postings. |
| 6 | Journal entry, bank transfer | JournalEntry, Transfer | Account selection must be governed; postings are explicit. |
| 7 | New customer, supplier, item | Customer, Vendor, Item | Lists, not postings; business blueprint must accept new roles. |
| 8 | Correct own records | void/update of records it created | Voids change verified periods; needs a correction period model. |

Not reachable through the API (shown as "QuickBooks only"): bank
reconciliation, bank feeds, company settings, sales tax setup.
