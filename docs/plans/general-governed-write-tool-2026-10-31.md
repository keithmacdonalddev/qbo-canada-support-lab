# General governed QuickBooks write tool — design, 2026-10-31

Status: design for independent review. Nothing here is wired into live approval or
dispatch. Pure parts (payload validator, guards, entity schema guide, tests) may be
built first; they change no live behaviour.

Owner direction, 2026-10-31: "why doesnt the accountant know all that... its a
fronteir model", "give the accountant all the tools, all the api skills ... be able to
write /read do anything else in qbo, why is it so narrow", "why waste qbo reads when
youve built syncing in and ensured its hardened and works".

## Outcome

The accountant composes any business event the QuickBooks Online Accounting API
supports, as real QuickBooks payloads, through one tool. The app does not dictate the
shape of the event. It enforces safety and verification generically and
deterministically, and it keeps the cost to **3 or fewer metered QuickBooks calls per
saved record on average, including verification** (today: about 100).

## What stays unchanged

- Activity policies v1–v8 and their fixed workflows, the monthly calendar, period
  verification by compiler-predicted postings (`business-financial-movements.js`), the
  corrections, adopted settlements and receiving. Saved plans rebuild exactly as before.
- The durable pipeline: immutable saved plan → lease-fenced approval under the standing
  grant → company writer fence → transport receipt saved before dispatch → dispatch only
  through `qbo-write-gate.js` → unknown-outcome recovery (`business-unknown-recovery.js`)
  that never resends without attribution.
- Owner protection of closed and reconciled periods (`qbo-write-period.js`). The general
  tool cannot write into a protected period. That protection is not weakened.
- The standing grant model: new tools need no owner prompt (only a changed published
  business does).

## Tools

1. `manageQboRecord` (core, `quickbooks-write`). Input: `decisionKey`, `purpose`, and
   1–60 `operations`, each `{ ref, op: create|update|void|delete, entity, payload,
   reason }`.
   - `ref` is a short local name, so later operations can say `{ "$ref": "inv1" }`
     where a QuickBooks id is needed.
   - `update` is a sparse update. The server supplies `Id` and `SyncToken` from the
     local copy; the model never sends them.
   - Preparation only validates and saves the plan. The same tool then runs it, so one
     review can propose, see faults and retry.
2. `getQboEntitySchema(entity)` (deferred, `quickbooks-read`). It returns, from a
   static, versioned reference file:
   - fields, required fields, allowed operations and read-only fields;
   - link rules (which `LinkedTxn.TxnType` values may appear where);
   - Canadian notes: `GlobalTaxCalculation` `TaxExcluded`, `TaxCodeRef` on every line,
     the published tax code ids, HST/GST/PST behaviour, and that QuickBooks omits
     `ARAccountRef` on CA reads;
   - one worked example per common event.

   No QuickBooks call is made.
3. Fault feedback. A QuickBooks validation fault (400 `ValidationFault`, 6000-series,
   duplicate document number, and so on) returns to the model as the tool result, per
   operation, with Intuit's message and `intuit_tid`. It is never retried automatically.
   The model may correct the payload and re-propose in the same review (bounded by the
   review's tool-call limit). A stale-token fault (5010) is handled by the server: one
   targeted fresh read of that record, then one retry with the new SyncToken.

## Allow-list

Create, update, void and delete only where the Accounting API allows that operation for
the entity (checked against the schema guide). The table is the intended starting point;
step 1 confirms each cell against Intuit's current API reference before it is enabled,
and any cell the API does not support is removed:

| Entity | create | update | void | delete |
|---|---|---|---|---|
| Invoice, SalesReceipt, Payment, RefundReceipt, BillPayment | yes | yes | yes | yes |
| CreditMemo, Estimate, Bill, VendorCredit, Purchase, PurchaseOrder, Deposit, Transfer, JournalEntry, TimeActivity | yes | yes | — | yes |
| Customer, Vendor, Employee, Item, Account, Class, Department, Term, PaymentMethod | yes | yes (inactivate via `Active:false`) | — | — |
| Attachable (notes, attachments by upload) | yes | yes | — | yes |
| Preferences | — | sparse update of allowed fields only | — | — |

Never allowed through the tool: `CompanyInfo` legal/tax identity, `TaxAgency`,
`TaxCode`/`TaxRate` creation, `TaxPayment`, bank-feed and reconciliation endpoints (not in
the API), and any `Preferences` field outside a fixed safe list.

The safe list is `SalesFormsPrefs` terms and messages, custom transaction numbers,
`ProductAndServicesPrefs.QuantityOnHand`, and class and location tracking. Accounting
basis, closing date, home currency, and the automatic-credit and tax settings are
excluded: the write gate requires automatic credit application to stay off.

**Multicurrency.** Turning multicurrency on is irreversible in QuickBooks: it can never
be turned off, and it changes home-currency and account behaviour for the whole company.
`MultiCurrencyEnabled` is not on the safe list, so the tool refuses it whether or not the
API would accept it. If the owner wants it, the owner turns it on in the QuickBooks UI.
After that, foreign-currency customers, suppliers and transactions with `ExchangeRate`
become a separate reviewed change, because the period checks assume CAD.

## Generic guards (server-side, deterministic, before a plan is saved)

Each guard is a pure function over the proposal, the local copy (CompanySyncRecord,
fresh to the last change-data-capture (CDC) sync) and the published business. No guard
calls QuickBooks.

1. **Shape.** Every payload is validated against the schema guide: allowed entity and
   operation, no read-only fields (`Id`, `SyncToken`, `MetaData`, `Balance`,
   `TotalAmt` on most entities), CAD only, bounded size (100 lines, 64 KiB).
2. **Date.** `TxnDate` equals the business calendar's current open day (verified
   through + 1, which is today). For update, void and delete, the record's current and
   new dates must not be inside an owner-protected period. A date inside an
   already-verified (unprotected) period is allowed only with the history rule below.
3. **Amounts.** Per record and per operation, the existing policy caps apply: $50,000
   per settlement or record, $120,000 per operation. Journal lines are capped at $10,000
   each. Quantities must be whole and bounded (0–1,000,000).
4. **References.** Every `*Ref.value` exists in the local copy with the expected entity
   type, is active, and is CAD for parties and bank, AR and AP accounts. Alternatively it
   is a `$ref` to an earlier operation in the same plan. An item line's account follows
   the item; a free account line must use an account of a type allowed for that line.
5. **Links and balances.** Payment, BillPayment, CreditMemo application and Deposit
   lines link only to records the local copy shows open (`Balance`, `RemainingCredit`,
   undeposited and not yet deposited). The applied totals per target, across the whole
   plan, are never more than the open amount. Each Deposit line must reference an
   undeposited Payment or SalesReceipt exactly once. Payment `UnappliedAmt` must be 0
   unless the operation explicitly records a customer prepayment.
6. **Tax.** `GlobalTaxCalculation` `TaxExcluded`. Every taxable line's `TaxCodeRef`
   is a code in the published Canadian tax policy for that direction (sales or
   purchases). Tax amounts are left to QuickBooks.
7. **Stock.** For each inventory item, local on-hand plus the plan's receipts minus its
   sales and adjustments must never go negative, in plan order. Inventory adjustments
   (`InventoryAdjustment` where available, or journal lines on stock accounts) are
   refused in the first build.
8. **Ownership and history.** Records the accountant created carry ownership in the
   step registry. Records it did not create, including imported history, may be updated,
   voided or deleted only with a non-empty `reason`. The full before image (from the
   local copy, refreshed if stale) and after image are retained in the audit. If the
   record's old or new date falls inside an already-verified period, that period is
   marked *needs re-verification*. It is re-verified at the next day close, and the
   result is shown on the Company page. Verified history is never silently changed.
9. **Volume.** Per review at most 60 operations, and per day the owner's existing
   daily request and record limits. Only one general operation holds the company writer
   at a time, as today.

## Pipeline mapping (reuse, not new machinery)

- **Plan.** The validated proposal is saved as an immutable plan
  (`OperationPlan.manifest.generalWrite`). Its intents are one per operation, keyed
  `hash({ scope, decisionKey, ref })`, so lost-response retries reuse the plan.
- **Approval.** Same governed approval under the standing grant, without the
  seven-report snapshot (see verification). Fenced by the calendar revision and the
  local copy's CDC watermark: if CDC moved since preparation, the references are
  re-checked.
- **Dispatch.** Operations are grouped into dependency layers, because QuickBooks batch
  items cannot reference each other. Each layer goes out as one `POST batch?requestid=…`
  of up to 30 items (the population batch builder already does this,
  `business-population-batch.js`).
  - Receipts are saved before each batch.
  - `requestid` makes a lost-response resend return the original result.
  - The write gate gets a coordinated general-batch transport like the population one.
  - Each item's fault or entity is recorded separately; a faulted item stops only the
    layers that depend on it.
- **Read-back = the write response.** The create, update or batch response carries the
  full saved entity. Verification compares the requested fields as a subset of the
  response (the same subset rule `business-readback.js` uses for headers and lines,
  plus `TotalAmt` = lines + `TxnTaxDetail.TotalTax`, tax codes from policy, links as
  requested). It then writes the entity into the local copy immediately, as a
  write-through mirror row with the response hash. Ownership is recorded as a step. No
  GET per record.

## Verification without per-type posting code

Fixed workflows keep their current period check. Days containing general-tool records
use this check at **day close** (one set of reports per day, not per operation):

1. **Completeness, from the local copy (no extra calls).** Every transaction with
   `TxnDate` in the day, and every record changed since the last close (from CDC), is
   one of:
   - an accountant receipt whose saved response hash equals the current mirror version;
   - a fixed-workflow step already verified;
   - an adopted or imported record unchanged since import;
   - anything else, which is an **external change**. External changes are flagged on the
     Company page and explicitly accepted or explained by the accountant. They never
     pass silently.
2. **Financial, from QuickBooks' own reports.**
   - The day's General Ledger report rows (transaction type, id, account, amount) are
     the posting authority. Every GL row must belong to a record classified above, and
     every accountant record must appear in the GL.
   - For AR, AP and bank-side accounts, each record's GL total must equal its expected
     sign × gross. This one rule covers every transaction type: receivable or payable up
     or down, money in or out. It needs no per-type posting code.
   - Trial balance for the day = opening + sum of the day's GL rows, per account (QBO
     internal consistency). Opening = the previous close's trial balance.
   - Fixed-workflow expectations still apply to their own records.
   - Profit and loss, Balance Sheet, aged receivables and payables totals must agree
     with the trial balance and the local copy's open balances.
3. **Nightly reconciliation.** The separate sync-versus-QuickBooks reconciliation
   (another worker) closes any gap between the local copy and QuickBooks; a difference
   reopens the day's check.

Least-invasive integration: `business-financial-movements.js` gains a
`generalPostings` input. These are the GL-observed postings of classified general
records, added to the existing expectation for accounts it tracks. The rest of
`createFinancialExpectation` and the movement assertion stays as it is, so fixed
records are still checked against compiler-predicted postings.

## Request budget (metered calls, sync excluded)

Measured 2026-10-31 UTC: 5 writes against 404 single-record reads, 76 reports and 53
queries, about 100 calls per saved record.

| Today's call | Why it exists | New design | Calls |
|---|---|---|---|
| Fresh GET of each saved record (`createBusinessTransactionReader`) | read-back | write response is the read-back | 0 |
| Fresh GET of each referenced customer, item, account and tax code (`createBusinessReferenceReader`) | reference freshness | local copy fresh to the last CDC; one CDC call per operation | ~0.05 |
| Receivables report per invoice (`verifyInvoiceReceivables`) | CA omits `ARAccountRef` | day-close GL proves the AR posting | 0 |
| 7 critical reports at approval and again at verification, per operation | approval evidence, period proof | one set at day close | 7 per day |
| TaxCode / TaxRate reads per operation (`deriveBusinessPolicies`) | dated rates | local copy (daily refreshed); rates change rarely | ~0 |
| Writes | the work | batch of up to 30 per request, one per dependency layer | ~0.1 |
| Stale SyncToken | concurrency | one targeted GET + retry, only on 5010 | rare |
| Freshness refresh before writes | stale copy | already a single CDC call (a98df80) | 1 per operation |

Example: a medium business day of 60 records in 8 operations costs about:
- 8 CDC calls;
- about 10 batch requests (two to three dependency layers per operation, some operations
  a single layer);
- 7 reports at day close;
- about 5 reconciliation queries.

That is about 30 calls, or **~0.5 calls per saved record**, inside the 3-call target even
at a third of that volume.

## Risks and how they are contained

- **Weaker per-record proof than the fixed workflows.** The GL-row ownership rule and
  the control-account rule catch misposted or unexplained effects at day close, not at
  write time. Mitigation: write-time subset verification from the response; day close
  must pass before the calendar advances. Fixed workflows remain available.
- **Model-composed payloads that QuickBooks accepts but that are wrong for the
  business** (wrong customer, wrong price). Guards prove safety, not intent. The plan
  keeps the stated purpose and reason per operation, and the daily management review
  audits outcomes. Corrections remain governed.
- **Editing imported or verified history.** Allowed only with a reason, a full
  before/after audit and re-verification of the affected period. Owner-protected
  periods stay refused.
- **Batch partial failure.** Results are per item. Dependent layers stop; unknown
  outcomes go through the existing never-resend recovery; `requestid` dedupes resends.
- **Write-through mirror drift.** The write response is authoritative at write time;
  CDC and the nightly reconciliation overwrite it with QuickBooks' later truth and flag
  any difference.
- **Production Canada quirks** (omitted `ARAccountRef`, dropped estimate links with
  Progress Invoicing, zero-amount payments). The schema guide documents them, and day
  close checks postings from the GL rather than from fields QuickBooks omits.
- **Cost of re-verifying old periods** after history edits: bounded to the affected
  days, run at the next close, shown with the result.

## Build order (each step reviewable; nothing live until the design is confirmed)

1. Pure: schema guide data and `getQboEntitySchema`; payload validator; guards 1–9 over
   a local-copy interface; tests with fixtures. No live behaviour change.
2. Plan and intents for `generalWrite`; preparation through the governance service;
   tool definition. Approval and dispatch stay disabled behind a server flag.
3. General batch transport in the write gate, receipts, response read-back,
   write-through mirror and ownership; tested on the simulated company.
4. Day-close verification (completeness + GL ownership + control accounts + TB
   consistency) and the `generalPostings` input to financial movements.
5. Updates, voids and deletes of own records; then records it did not create, with
   audit and re-verification.
6. Prompt and tool descriptions. The accountant can run the business like a real one:
   terms, partial and late payments, quotes to invoices, purchase orders to receipts to
   bills, stock sales, grouped deposits, time billing, classes and departments. Then
   enable the flag on Production after a sandbox-equivalent run.
