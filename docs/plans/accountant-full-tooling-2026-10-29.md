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

- Workflow 1 (code, not yet live): same-day activity policy v2
  (`business-activity-v2`) adds `collect-adopted-invoice` (Payment to
  undeposited funds, then Deposit) and `pay-adopted-bill` (BillPayment from the
  operating bank) for open invoices and bills of the adopted import. The
  obligation is not a managed dependency: compilation reads it fresh inside
  the writer fence (`business-adopted-settlement.js`), binds it to its saved,
  financially verified import record and the adoption marker, checks party,
  CAD, control account and that the amount never exceeds the open balance.
  Preparation repeats those checks before saving a plan;
  `getBusinessActivityChoices` lists the open adopted obligations. Usable only
  after the owner approves the updated rules (policy hash changed). Open
  invoices and bills entered outside the app before the import (55 invoices on
  Production) are still out of scope.
  Safety review (2026-10-29) fixes: only records saved by the adopted job
  (`authorityHash`) with a matching financial proof and no failed recheck
  qualify, in both preparation and the choices list; batches saved under the
  first policy still rebuild (the verified Oct 29 batch is one); the owner's
  approval text names the new payment authority. Known limits: a plan whose
  target balance drops before saving stops part-way and holds the writer until
  recovered; re-running the import's relationship recheck on a settled
  obligation reports a false failure (and then excludes it from further
  settlement).
- Workflows 4 and 5 (code, not yet live): same-day activity policy v3
  (`business-activity-v3`) adds `paid-cash-expense` (a Purchase paid as cash
  from the operating bank to the operating-expense account with purchase tax)
  and `supplier-credit` (a VendorCredit from an operating supplier to the
  operating-expense account, reducing accounts payable; applying it to a bill
  is not built). Postings: Purchase bank −gross and expense +net; VendorCredit
  payables +gross and expense −net. Batches saved under v1 and v2 still
  rebuild and cannot claim the new workflows. Usable only after the owner
  approves the updated rules.
- Workflows 3 and 6 (code, not yet live): same-day activity policy v4
  (`business-activity-v4`) adds `customer-credit` (an open CreditMemo for a
  published service, sales tax, not applied), `customer-refund` (a
  RefundReceipt paid from the operating bank), `bank-transfer` (a Transfer
  between two published bank roles) and `journal-entry` (2–4 balanced lines on
  operating bank, income or operating-expense roles; never receivables,
  payables, undeposited funds or stock). Postings: credit AR −gross and income
  +net; refund bank −gross and income +net; transfer from −amount, to +amount;
  journal debit minus credit per tracked line. Income evidence counts credits,
  refunds and journal income lines. QuickBooks omits a credit memo's
  receivables account, so read-back proves it from the General Ledger
  ("Credit Memo" rows), as for invoices. Only one bank role is published, so
  no transfer can be prepared yet; choices say so. The scheduled
  credit-and-application cycle stays gated on Production. Batches saved under
  v1–v3 still rebuild and cannot claim the new workflows.

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
