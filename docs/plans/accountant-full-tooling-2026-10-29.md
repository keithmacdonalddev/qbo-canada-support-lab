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

- Workflow 2 (code, not yet live): same-day activity policy v5
  (`business-activity-v5`) adds `receive-purchase-order`. Choices list only
  wholly unreceived open inventory POs created by managed workflows or the
  financially verified adopted import; unmanaged and partially received orders
  are unavailable. The full order becomes an unpaid Bill dated today at original
  quantities and costs, linked by PO header and line, with dated purchase tax.
  Fresh source checks run before preparation and inside the writer fence.
  Managed orders stay in the normal verification graph; imported orders get
  fresh financial-content and post-save PO closure checks.
  Same-day receipts replay alongside yesterday’s FIFO carry for later batches
  and day close. An early managed receipt replaces its unsaved scheduled Bill;
  later scheduled sales and payments use the actual receiving Bill. A receipt
  is refused during preparation if a same-item sale is scheduled that day and
  its original purchase cost, carried FIFO costs or incoming receipt costs differ.
  The existing FIFO guard also remains in place.
  Requires published stock-cost evidence and renewed owner policy approval.
  Batches under v1–v4 still rebuild and cannot claim receiving. Independent
  implementation and safety reviews found no unresolved source findings. Checks
  remain unexecuted: the verified Luna bridge failed workspace routing before any
  command ran, including retries (local receipts receive-po-4/5/6-receipt.json).
  The final check request is artifacts/luna/receive-po-final-request.json. Git
  staging is blocked by read-only .git/index.lock permissions; changes are local
  and uncommitted. No live QBO write or report acceptance is claimed.
- Workflow 7 (code, not yet live): same-day activity policy v6 adds `add-customer`,
  `add-supplier` and `add-item` (Service items only), following GPT-6.1 Sol's plan
  review. List records are explicit zero-movement steps with allowlisted fields
  (no opening balances, parents, quantities or arbitrary account/tax IDs). The
  role registry is derived, append-only evidence (`business-added-roles.js`): a
  role exists only when its list step verified and its whole operation verified,
  so additions are usable only in a later batch. Membership also re-checks the
  creation evidence (company-scoped compiled request, dispatch, the receipt rebuilt
  from its transport receipt row and audits, and a read-back evidence hash
  recomputed from that receipt and the observed record), the step's own
  verification audit, and the operation's committed period evidence through the
  same proof stock carries use (`committedReceipt`: proof hash recomputed, period
  proof revalidated, completion and evidence audits present). Names must be free across
  the shared customer/supplier/employee namespace (and items), checked at
  preparation and again before dispatch. Read-back retains the verified full
  definition hash of each added record (the shared reference-definition contract:
  all fields except version metadata and balances); a role whose current
  definition differs (for example a new parent, job, contact or account) is
  refused. A role verified before definition hashes were retained stays unusable
  by design; none exist (Production had no list steps or add-* runs when this
  rule landed), so there is no migration. Additions go in their own batch (add-*
  activities only), so an unrelated sale or expense cannot fail the batch after
  a record was created. Anomalous registry entries (incomplete evidence,
  duplicates, over the 1,000-record capacity, unverified batches) are listed as
  `unusableAddedRecords` with a reason instead of blocking other activity. The
  own-batch rule is enforced at preparation, at approval (including an already
  approved operation) and when a saved operation starts; capacity at preparation,
  at approval and immediately before each list record is sent (counting every
  created or possibly created list record, while the operation holds the company
  writer), so a saved or approved batch can never create a record past capacity
  or inside a mixed batch. Added customers and
  items are usable in `settled-service-sale` (the item's retained income role and
  unit drive the income mapping); added suppliers in `paid-operating-expense`.
  Batches under v1–v5 rebuild with their exact original rules. A lost response
  follows the same recovery as transactions: a recorded transport response is
  recovered automatically (request-correlated read-back), and an unknown outcome
  is never resent and waits for the owner-reviewed attribution in
  `business-unknown-recovery.js` (entity-generic; not yet covered by a list-specific
  test). Known limits: NonInventory items and added roles in
  credits/refunds/cash expenses are not built.
- Workflow 8 (committed a8a7e1c after one safety review and three GPT-6.1 Sol code
  reviews; all business and write-gate tests pass; not yet used live): same-day activity policy v7
  (`business-activity-v7`) adds `correct-own-record`, following GPT-6.1 Sol's plan
  review (artifacts/luna/tmp/sol-plan-w8-result.md, "recommended first build"). The
  accountant corrects its OWN earlier record by a full reversal dated today; the
  original is never edited or voided. The agent sends only the target
  (`entity`, `qboId`) and a reason; `business-correction.js` derives the party,
  original lines, accounts and tax from the original's immutable creation intent and
  approved policy, and the current balance decides the kind:
  wholly unpaid service Invoice → CreditMemo + zero-funds Payment applying it;
  fully collected service Invoice/SalesReceipt → RefundReceipt from the operating
  bank (never also a credit); wholly unpaid operating Bill → VendorCredit +
  zero-funds BillPayment applying it; accountant JournalEntry → exact reversing
  JournalEntry. The original and its saved dependency closure are existing
  prerequisites of the batch.
  Tax repeats the ORIGINAL supply (CRA Notice 342): the original tax code is reused
  (not today's dated choice) and policy derivation must reproduce the original
  rate, taxable base and cents on a record dated today, else the correction is
  refused before anything is sent (for example a 15% original whose code now yields
  14%). The compiler re-checks, inside the writer fence, that the fresh original
  still carries that exact tax, lines, party and total, and is still wholly unpaid
  with no credits (or fully collected by its own payments).
  Ownership needs the complete chain: managed step for this company (imported,
  adopted and unmanaged records refused explicitly), immutable create intent via the
  plan store's validated history, compilation/dispatch, receipt rebuilt from its
  transport row and audits (or owner attribution), current verification and audit,
  and the creating operation's committed period evidence (`committedReceipt`)
  containing this record with its original verification audit.
  One correction per original, ever: correction step identities derive from the
  original (rule key + original date), not the batch or decision key, so any other
  attempt collides on the unique step identity; preparation also refuses any
  existing reversal step (any state, including unknown) and any other unsent
  prepared batch for it, and the runtime re-checks before every write.
  Refused before any write: voids, paid bills, bank-expense refunds, partial
  settlements, prior credits or unexpected links, stock/inventory targets,
  corrections of corrections, records from today, records using accountant-added
  customers/suppliers/items, and applications that would touch a closed or
  reconciled period (protection is not weakened). Durable "corrected" disposition:
  calendar preparation drops unsent scheduled follow-ups (collections, payments,
  credits) that depend on an original whose reversal was sent, recorded as
  `correctedFollowUps` in the new manifest; saved plans are not rewritten.
  Postings: the reversal counts once (credit AR −gross, income +net; refund bank
  −gross, income +net; supplier credit AP +gross, expense −net; journal lines
  reversed); zero-funds applications post nothing. Old saved evidence is untouched.
  `getBusinessActivityChoices` lists `correctableRecords` with eligibility or the
  reason. v6 is frozen in `SAVED_POLICIES` (hash unchanged); v1–v6 batches cannot
  claim corrections. Lost-response retries return the originally saved terms.
  Known limits: tax-control posting is proved by record read-back and report checks,
  not by a separate tax-account comparison; a credit saved before its application
  failed leaves an open credit until the operation is recovered (never resent);
  QuickBooks' Canadian acceptance of zero-funds bill payments applying a supplier
  credit, and of zero-amount payments without an omitted receivables field, is
  unverified on Production.
- Business lifecycles over time (code, not yet live; 2026-10-31): same-day activity
  policy v8 (`business-activity-v8`; v7 frozen in `SAVED_POLICIES`, hash unchanged)
  adds seven workflows so the accountant's own work creates open receivables and
  payables, aging, partial payments, quotes and orders instead of only same-day
  settled sales:
  `invoice-on-terms` (a published service invoice left open, due 7/15/30/45/60 days
  later; a field-service hour also records its estimate and time, as a settled sale
  does), `bill-on-terms` (one nonbillable operating-expense bill left open until due),
  `collect-own-invoice` (Payment to undeposited funds, then Deposit, for any amount up
  to the open balance), `pay-own-bill` (BillPayment from the operating bank, up to the
  open balance), `send-estimate` (a field-service Estimate left open) with
  `convert-own-estimate` (today's TimeActivity and an Invoice on terms linked to the
  earlier estimate, at its quoted hours and price), and `order-stock` (a PurchaseOrder
  for one to five workshop stock items, 500 units per line, received later by the
  existing `receive-purchase-order`). Payment terms are a lifecycle contract
  (`paymentTerms.days`, due date = transaction date + days); every other v1–v7 invoice
  or bill still needs immediate terms.
  The agent sends only the record, its party and the amount or terms;
  `business-own-settlement.js` derives the original from its immutable creation intent
  (plan-store history) and saves it with its dependency closure as the batch's
  existing prerequisites. Eligible only: a verified record created by an activity batch
  on terms (or a sent estimate), for this company, with the full ownership chain used
  by corrections, from an earlier day, never imported, never corrected, with only its
  own verified payments so far (an estimate: still Pending/Accepted, unlinked, no time
  or invoice yet) and no other unsent prepared work depending on it. Calendar and
  same-day settled records are refused (their schedule settles them). The compiler
  re-proves inside the writer fence that the original still belongs to the party,
  carries only its own payment links, and that its fresh open balance covers the
  amount; read-back already reconciles each invoice or bill balance to its verified
  settlements, and financial movements count each payment once. A partly paid own
  invoice cannot be corrected (existing rule); a fully collected one can be refunded.
  Choices: `ownOpenInvoices`, `ownOpenBills` (balance, due date, terms, eligibility)
  and `ownOpenEstimates`. Effective without owner action: the standing grant covers new
  workflows (only a changed published business needs re-approval,
  `business-agent-work.js`). Known limits: only published customers, suppliers and
  services (no added roles); only field-service estimates convert (they bill recorded
  time) and only whole; collections are always deposited the same day (no grouped
  bank deposit of several payments yet); stock sales from the activity batch are not
  built; a stock order received on a day the same item is sold at a different unit
  cost is refused by the existing FIFO proof (reorder at the published unit cost);
  partial PO receipts remain unavailable. Not yet run on Production.

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
| 8 | Correct own records | Reversals dated today (CreditMemo/RefundReceipt/VendorCredit/JournalEntry + zero-funds applications) | Built as policy v7 reversals; voids, paid bills, expense refunds, partial settlements and stock deferred. |

Not reachable through the API (shown as "QuickBooks only"): bank
reconciliation, bank feeds, company settings, sales tax setup.
