# General governed QuickBooks write tool — design, 2026-10-31 (revision 3)

Status: approved for implementation by the lead, 2026-10-31, after two GPT-6.1 Sol
reviews. Revision 1 findings are marked **[R1-n]**. The second review's three contract
fixes are marked **[R2-n]** and its notes **[R2-note]**. Nothing dispatches to the live
company until the lead has completed one implementation review.

Owner direction, 2026-10-31: "why doesnt the accountant know all that... its a
fronteir model", "give the accountant all the tools, all the api skills ... be able to
write /read do anything else in qbo, why is it so narrow", "why waste qbo reads when
youve built syncing in and ensured its hardened and works".

## Outcome

The accountant composes any business event the QuickBooks Online Accounting API
supports, as real QuickBooks payloads, through one tool. The app does not dictate the
shape of the event: no workflow-shaped restrictions such as whole-number quantities or
linked-only deposit lines. It enforces safety and verification generically and
deterministically, from declarative per-entity rules.

Cost target **[R1-8]**: on a normal day, at most 2 vendor-metered QuickBooks
operations per saved record, including verification. Transport attempts and metered
operations are measured separately.

## What stays unchanged

- Activity policies v1–v8 and their fixed workflows, the monthly calendar, and their
  period verification by compiler-predicted postings (`business-financial-movements.js`).
  This includes corrections, adopted settlements and receiving. Saved plans rebuild
  exactly as before.
- Owner protection of closed and reconciled periods (`qbo-write-period.js`). The general
  tool cannot write into a protected period. That protection is not weakened.
- The standing grant model: new tools need no owner prompt (only a changed published
  business does).

## A versioned general execution contract **[R1-suggestion]**

Today's contract does not fit general writes, so this is a new, explicitly versioned
contract (`general-write-v1`) alongside the existing one, not a stretch of it:

- the dispatcher accepts creates only (`business-dispatch.js:54`);
- the runner requires a graph verification per record (`business-operation-runner.js:65`);
- governance requires seven-report approval evidence (`business-governance-service.js`
  approval path).

| Concern | Existing contract (unchanged) | `general-write-v1` |
|---|---|---|
| Plan content | compiled step intents from fixed workflows | normalized payloads + target versions + resource graph |
| Approval evidence | seven fresh reports | guard results on the effective records + the copy's CDC watermark |
| Dispatch | one create per request | batch items with exact transport identity (below) |
| Per-record proof | fresh GET + graph read-back | complete write response (or one GET when incomplete) |
| Period proof | compiler-predicted movements per operation | declarative posting rules + version-aware completeness at day close |

A plan, run, receipt and evidence record each carry `contract: 'general-write-v1'`.
Mixed plans (fixed-workflow and general items in one operation) are refused. A day may
contain both kinds of operation; day close applies each contract to its own records.

## Tools

1. `manageQboRecord` (core, `quickbooks-write`). Input: `decisionKey`, `purpose`, and
   1–60 `operations`, each `{ ref, op: create|update|void|delete, entity, id?,
   payload, reason? }`.
   - `$ref` placeholders name earlier creates.
   - `update` is a sparse update. The server supplies `Id` and `SyncToken` from the
     local copy.
   - A decisionKey is bound to its normalized content: reuse with different content is
     refused **[R1-6]**.
2. `getQboEntitySchema(entity)` (deferred, `quickbooks-read`): fields, required and
   read-only fields, operations, link rules, posting notes and Canadian tax notes from
   a static guide (`qbo-entity-schema.js`, built). It makes no QuickBooks call.
3. Faults go back to the model per item, as tool results, with Intuit's message and
   `intuit_tid`. The model may correct and re-propose in the same review. A corrected
   payload is a new attempt; successful siblings are kept (see recovery).

## Allow-list

Create, update, void and delete only where the Accounting API allows that operation for
the entity. Each cell is confirmed against Intuit's current API reference before it is
enabled.

| Entity | create | update | void | delete |
|---|---|---|---|---|
| Invoice, SalesReceipt, Payment, RefundReceipt, BillPayment | yes | yes | yes | yes |
| CreditMemo, Estimate, Bill, VendorCredit, Purchase, PurchaseOrder, Deposit, Transfer, JournalEntry, TimeActivity | yes | yes | — | yes |
| Customer, Vendor, Employee, Item, Account, Class, Department, Term, PaymentMethod | yes | yes (inactivate via `Active:false`) | — | — |
| Attachable (notes; file upload later) | yes | yes | — | yes |
| Preferences | — | sparse update of a fixed safe list | — | — |

**R2-2 implementation update:** see [inventory implementation and remaining return dependency](general-inventory-write-implementation-2026-10-31.md). Default-off current-day stock creates now have FIFO costing, partial PO receipt guards, original native receipt/audit provenance and combined period carry. Generic inventory returns remain disabled without authenticated native valuation evidence; R2-2 remains incomplete for that requested path. The following paragraph describes the original pre-implementation gate.

**Inventory is gated off in general-write-v1 [R2-2].** Any operation is refused when its
effective record (before or after) moves inventory: inventory item lines on any
transaction, fractional stock quantities, inventory invoices or sales, returns, or
historical stock edits. Creating or editing an Inventory-type Item, and journal or
account lines on the inventory asset account, are refused too.

The existing stock-cost calculator accepts only whole-unit Bills and SalesReceipts, and
it rejects ambiguous unequal-cost same-day activity. Its evidence excludes returns
(`business-stock-cost.js:81`, `business-stock-evidence.js:158`). Inventory stays with the
fixed workflows (`receive-purchase-order`, `order-stock` and the calendar) until the
stock cost and replay rules and their fixtures cover general operations. Non-inventory
entities ship first.

Never through the tool: `TaxCode`/`TaxRate`/`TaxAgency` creation, `TaxPayment`,
`CompanyInfo` identity, reconciliation and bank feeds (not in the API), and any
Preferences field outside the safe list.

**Multicurrency.** Turning multicurrency on is irreversible in QuickBooks. It is not on
the safe list, so the tool refuses it. The owner can turn it on in the QuickBooks UI.
Foreign-currency activity is then a separate reviewed change, because every proof below
assumes CAD.

## Guards **[R1-5]**

Pure functions over the proposal, the local copy and the published business.

**When the guards run.** Each guard runs at preparation (so the model gets fast
feedback), again at approval, and again immediately before each batch is sent, inside
the writer fence. The second and third runs use the local copy at its current CDC
watermark. A 5010 refresh reruns them too.

**What they check.** The guards check the **effective record**:
- for a create, the payload;
- for an update, the current record from the local copy merged with the sparse payload;
- for a void or delete, the current record and its reversal.

| # | Guard | Rule |
|---|---|---|
| 1 | Shape | Entity and operation allowed. No read-only fields. CAD only. Bounded size. **No tax overrides:** `TxnTaxDetail`, line tax amounts and `TaxInclusiveAmt` are refused wherever QuickBooks computes tax. |
| 2 | Dates | Creates are dated on the open business day. For updates, voids and deletes, the old and new dates of the record, of every affected source (linked parents, applied credits, deposited payments) and inventory start dates (`InvStartDate`) must be outside owner-protected periods. A date inside a verified period triggers history invalidation (below). |
| 3 | Amounts | Gross amounts **including tax**. QuickBooks computes the tax; the guard uses the dated rates from the published tax policy to bound it. Per record ≤ $50,000 gross. Plan-wide total ≤ $120,000 of absolute exposure: creates, plus the absolute change of updates, plus the reversed amount of voids and deletes. Journal exposure is the sum of debits; each line ≤ $10,000. Quantities: any finite non-negative number within bounds; fractions are allowed. |
| 4 | References | Exist in the copy (or are an earlier `$ref` create), have the right entity and account type, are active, and parties, banks and AR/AP are CAD. |
| 5 | Applications | Payment, BillPayment, credit application and Deposit lines: the party, control account (AR/AP) and currency must match the target's. Applied amounts per target never exceed its open balance or remaining credit. Net credit allocations balance (`TotalAmt` = applied − credits). A Deposit may mix linked undeposited receipts (each once, in full) with free `DepositLineDetail` lines (for example a bank interest line); linked-only is not required. |
| 6 | Tax | `GlobalTaxCalculation` `TaxExcluded`. Every taxable line's `TaxCodeRef` is in the published tax policy for the direction. |
| 7 | Stock | For each inventory item, on-hand from the copy + receipts − sales, including the reversed deltas of updates, voids and deletes of stock records, never goes negative. This is checked across the whole plan, and resource dependencies enforce the order at dispatch. |
| 8 | Ownership and history | Records the accountant did not create need a stated reason. A full before-image is kept in the receipt. History invalidation applies. |
| 9 | Volume | ≤ 60 operations per plan; the owner's daily request and record limits; one general operation on the writer at a time. |

Built: `general-write-guards.js` implements guards 1–9 at preparation level. The
remaining work for this revision:
- evaluate the effective post-update record;
- measure gross amounts including tax;
- count absolute exposure;
- match party and control account on applications;
- compute stock deltas for updates, voids and deletes;
- check affected source dates;
- allow free Deposit lines.

## Scheduling: references and resources **[R1-4]**

QuickBooks batch items are unordered, so plan order guarantees nothing. Items go into
the same batch only when they share no resource. Each item's resource set contains:
- `$ref` targets (it needs their ids);
- each existing record it updates, voids, deletes, links or applies (one writer per
  record);
- each inventory item whose quantity it moves (a receipt and a sale of one item never
  share a batch);
- each open balance it consumes (invoice, bill, credit, undeposited receipt).

Resources come from **both the before and the after record [R2-note]**. An update that
removes a link, or a void or delete of a record with links, still claims the records it
was linked to, because their balances and backlinks change.

Batches are built by the greedy layering of `business-population-batch.js:54`
(`consumed` parents, stock items): an item waits for a later batch when it conflicts
with an item already placed or depends on an unfinished one. Each batch holds at most
30 items.

## Exact idempotency and recovery contract **[R1-6]**

Before any send, the saved plan and receipt hold:
- the normalized payload of each item;
- the target `Id` and `SyncToken`, and for updates the full before-image (version,
  date, amounts, lines and links);
- batch membership and order;
- the `requestid`, and each item's `bId`.

Then:

1. **Lost response.** The unchanged batch is resent with the **same** `requestid` and
   bIds, so QuickBooks dedupes it.
2. **Item outcomes.** Each item's outcome is saved as it arrives: entity, fault, or
   absent. An absent item stays unknown. It is resolved by request-correlated read-back
   (by `requestid`/`DocNumber`/private-note marker), never by resending under a new
   identity.
3. **Fault correction.** A faulted item that the model corrects, or a 5010 stale token,
   is a **new attempt** with a new `requestid` for that item only. The new attempt
   reruns every guard affected by the refreshed record and captures its actual
   before-image. Successful siblings are kept.
4. **One decision.** A decisionKey whose content differs from its saved plan is refused
   (see `activityRequestKey` for the same rule on activity batches).

Unknown outcomes in general writes are not handled by the existing creation-specific
unknown recovery, which needs owner attribution. The general contract gets its own
item-level unknown resolution, with fixtures, before any live transport.

That resolution has an explicit **unresolved** outcome **[R2-note]**. Some entities and
operations have no reliable correlation field: list records without a unique name, and
updates or deletes whose result cannot be told apart from an external change. When an
exact replay or read-back cannot establish their identity, the item stays unresolved.
The barrier holds: no later item that depends on its resources is sent, and the owner
or accountant must attribute it.

## Write responses and the local copy **[R1-7]**

- **A whole mirror row is replaced only by a complete effective entity [R2-3].** A
  sparse update's response may carry only `Id`, `SyncToken` and the changed fields.
  Accepting it would lose the record's lines, date and totals.
  - **Complete** means the response is a full entity of its type: every field the
    entity guide marks as part of the effective record (for transactions: `TxnDate`,
    `Line`, totals, party and tax detail) is present and agrees with the requested
    effective record.
  - Anything less triggers one GET. Delete responses are tombstones.
- Write responses and CDC go through **one shared, version-aware merge** into
  `CompanySyncRecord`. A row is replaced by a higher SyncToken or a later
  `LastUpdatedTime` for the same id. Read-start times guard against overlapping reads.
- **Equal-version parent refresh [R2-3].** A row may also be replaced by a complete
  entity of the **same** version when that row is marked stale (invalidated by a child
  write), and the new entity was demonstrably read after the invalidation (read start
  later than the invalidation time).
  - This covers a settlement that changes an invoice's balance without changing its
    SyncToken or timestamp; `business-request-economy.test.js:71` is the fixture case.
  - An equal-version entity is never accepted over a row that is not stale.
  The upsert is idempotent per (entity, id, version), so concurrent writers cannot raise
  duplicate-key failures. This replaces the current split, where response retention
  checks SyncToken but CDC persistence checks read-start time
  (`qbo-write-gate.js:153`, `business-observation-store.js:30`,
  `business-agent-sync.js:188`).
- **Dependent invalidation is kept.** A child write (a payment, a deposit, a credit
  application) changes its parent's balance and backlinks without necessarily changing
  the parent's SyncToken. The merge marks every linked parent stale. The parent's next
  use takes its current version from the next CDC or one targeted GET.

## Verification at day close

### Declarative posting rules **[R1-1]**

The GL is never compared with itself. Each accountant record's expected postings are
derived from **its own saved lines** by entity-generic rules:

- **Lines.** An item line posts to the item's income, expense or asset account (from
  the item in the copy). An account-based or journal line posts to its `AccountRef`. A
  tax code posts to its published tax payable or receivable account, for the tax
  QuickBooks returned on the record.
- **Control side, by entity:**
  - Invoice: AR +gross. CreditMemo: AR −gross.
  - SalesReceipt and RefundReceipt: deposit or refund account ±gross.
  - Bill: AP +gross. VendorCredit: AP −gross.
  - Purchase: payment account −gross.
  - Payment: AR −applied, and deposit-to account +`TotalAmt`.
  - BillPayment: AP +applied, and bank or card −`TotalAmt`.
  - Deposit: linked receipts move from undeposited funds to the bank; free lines post
    to their account.
  - Transfer: from −, to +.
  - JournalEntry: each line as posted.
- **Inventory.** Gated off in general-write-v1 [R2-2]. A general record carrying
  inventory postings is refused before dispatch, and it fails classification at close.
- **Non-posting, classified explicitly:** Estimate, PurchaseOrder, TimeActivity,
  Attachable, list records, Preferences, and zero-funds applications (`TotalAmt` 0, with
  equal links).
- **Two different comparisons [R2-1].**
  - **Current postings.** A record's General Ledger rows (by transaction type and id)
    must equal the rules applied to its **current, after-state** record, account by
    account and to the cent. An update from $100 to $150 expects $150 of current
    postings; a deleted record expects no rows; a voided record expects zero amounts.
  - **Period movement.** The opening-to-closing movement of each tracked account uses
    **date-allocated** differences. The before-image's postings are removed on the
    before-image's date, and the after-image's postings are added on its date.
    - A $100 → $150 update on the same date moves that date by +$50.
    - A date move from day A to day B moves A by −$100 and B by +$100.
    - A delete moves its date by −$100.
    - A create adds its postings on its date.

    These movements join the fixed workflows' compiler postings in the existing period
    assertion (opening + movements = trial balance). A movement on a date inside a
    verified period dirties that period (history invalidation).

This catches a balanced posting to the wrong expense, tax or inventory account, and it
never mixes a change amount with a current amount.

### Version-aware completeness **[R1-2]**

Every transaction dated in the day, and every record changed since the last close (from
CDC), is classified against its **current version** in the copy:

- **Accountant record, current version accounted for.** The version is the
  write-response version, or a later version whose difference is explained only by the
  accountant's own later settlements (balance and backlinks from its own payments,
  credits and deposits, each itself verified).
- **Fixed-workflow record.** Its stored verification `observedHash` equals the current
  version, or the same own-settlement explanation applies.
- **Adopted or imported record.** Its import proof matches the current version, or the
  same own-settlement explanation applies.
- **Anything else is an external change** (an external create, edit, delete or date
  move). Historical verification alone never clears an externally edited record. The
  change is flagged, and the record must be accepted with a reason, or corrected,
  before the day closes.

### History invalidation **[R1-3]**

- **Before dispatch.** Any change to a record dated in a verified period, by the
  accountant or detected from CDC, first writes a **durable dirty-period marker**. The
  marker holds the earliest affected date (from the old and new dates of the record and
  its affected sources), the reason and the receipt id.
- **What becomes invalid.** Every close from that date through the current cursor is
  invalidated: opening balances roll forward, and FIFO costs of later stock sales can
  change. A change before the managed opening date invalidates the opening baseline. The
  runner's shortcut that returns an existing verified completion
  (`business-operation-runner.js:13`) is bypassed for dirty days.
- **Re-verification.** Dirty days re-verify in date order at the next close, using one
  report set per affected range. The result is shown on the Company page. The calendar
  does not advance while a dirty day fails.
- **Before-images.** The receipt keeps them, because the copy holds only current
  versions. They let a later external move or deletion be re-verified against what was
  originally proven.

## Request budget, in vendor-metered operations **[R1-8]**

This is a **projection [R2-note]**. It is not measured yet: today's meter increments
once per HTTP attempt (`qbo-request-meter.js:48`), and the batch metering assumption
comes from Intuit's sample documentation. The meter will record transport attempts and
metered operations separately, and the figures below will be replaced with
measurements. They also count only the **writer's incremental cost**.

**Total company cost** additionally includes background synchronization: ongoing CDC
polling, the 23 nightly COUNT checks and the amount reconciliation
(`business-agent-sync.js`). That cost is reported separately, as a fixed daily overhead
independent of write volume.

Intuit meters batch items individually. One batch request of 25 items is one transport
attempt but 25 metered operations. The meter (`qbo-request-meter.js`) records both
counts: transport attempts and metered operations, including retries.

Normal day, 60 saved records in 8 operations:

| Source | Metered operations |
|---|---|
| Writes: 60 batch items, one per record | 60 |
| CDC before each operation: 8 calls | 8 |
| Day-close reports: TB, GL, P&L, BS, AR aging, AP aging, cash flow | 7 |
| Report support: account query for report mapping | 1–2 |
| Period protection: Preferences closing date once per operation (cached per day) | 1–8 |
| Partial responses and 5010 refreshes | ~2 |
| **Writer total** | **~80–87, about 1.3–1.5 per record** |
| Background sync and nightly reconciliation (company overhead, reported separately) | fixed per day |

That meets the target of ≤ 2 per record. A low-volume day (5 records) costs about 30,
or 6 per record, because day close and reconciliation are fixed costs. The target
applies to a normal day, and low days are reported as such.

Today's per-record calls go away as follows:
- the GET read-back is replaced by the response;
- reference GETs are replaced by the local copy plus CDC;
- per-invoice receivables reports are replaced by day-close GL rows;
- the seven reports per operation become seven per day;
- TaxCode and TaxRate reads per operation are served from the copy, refreshed daily.

Kept, and counted above:
- the period-protection read of Preferences;
- link-date reads, but only for linked records missing from the copy;
- one targeted GET for partial responses and 5010.

## Risks

- **Model-composed payloads that are safe but wrong for the business** (wrong customer,
  wrong price). Guards prove safety and correct posting, not intent. The stated purpose
  and reason are kept per item, the daily management review audits outcomes, and
  corrections stay governed.
- **History edits** cascade re-verification through the cursor. This is bounded by the
  affected range and visible, and the calendar holds while a dirty day fails.
- **Batch partial failure and unknown items** have an exact item-level contract and
  never use a new identity for an unknown item.
- **Mirror drift.** The shared version-aware merge and parent invalidation contain it.
  The nightly reconciliation compares counts and totals, which cannot detect every
  substitution. Day-close completeness and posting rules cover each changed record.
- **Production Canada quirks** (omitted `ARAccountRef`, dropped estimate links,
  zero-amount payments) are handled because posting rules are checked against GL rows,
  not against fields QuickBooks omits.

## Build order **[R1-suggestion]**

1. Pure, now:
   - entity guide (built);
   - guards upgraded to effective-record and gross checks, with inventory gated off;
   - declarative posting rules (current postings and date-allocated movements);
   - resource-aware scheduler (before and after resources);
   - version-aware completeness classifier;
   - dirty-period invalidation model;
   - the merge decision (complete-entity and equal-version rules).
2. Fixtures, still no live transport. These cover:
   - adopted-invoice settlement;
   - external edit, deletion and date move;
   - non-posting records;
   - a wrong counterpart account (must fail at close);
   - shared-stock batches;
   - partial batch failure;
   - lost responses and unknown items;
   - 5010 refresh;
   - history edit invalidating later closes and the baseline.
3. `general-write-v1` plan, receipts and evidence records; preparation and approval
   through governance; tool definition, behind a server flag that stays off.
4. General batch transport in the write gate, with the exact identity contract; shared
   version-aware merge; tested on the simulated company.
5. Day-close verification for general records, joined with the existing movement
   assertion.
6. Prompt and tool descriptions. Then enable on Production after a full simulated run
   and the lead's go-ahead.

## Implementation status (2026-10-31)

Verified with isolated fixtures and in-memory storage. Runtime configuration was checked
with dispatch disabled (`GENERAL_WRITE_DISPATCH_ENABLED=false`). No live company or
database verification is part of the implementation-review fixes.

- Tools: `manageQboRecord` and `getQboEntitySchema`; plans are saved as
  `GeneralWriteRun` (`general-write-service.js`).
- Transport: the company gate retains the exact request identity, receipt, original
  period proof and item outcomes. The service reloads gate revisions before saving its
  results and ingests retained responses after a crash. Mismatched or ambiguous items
  remain unresolved and cannot become new creates. Lost responses replay only the
  admitted identity across midnight, including updates and deletions, with current
  protected-period controls and fresh closing preferences. Void remains disabled.
- Admission: every unadmitted saved batch reruns full guards inside the admission
  transaction, including balances, caps, inventory accounts and daily creation counts.
  General creates and unresolved reservations share the native daily ceiling without
  double-counting a retry. General parent evidence also invalidates the shared reader.
- Close: all runs are enumerated with keyset paging. Reuse requires the same run, record
  and posting-reference snapshot; changes during the ledger read refuse the proof.
  Requested account/item/tax details must match the response and current record. Tax
  account identities stay distinct; ambiguous attribution blocks close. Successful
  authorized deletions use their exact dispatched version and before-image and require
  no remaining ledger rows. Results are retained as `GeneralDayClose`.
- Historical edits are held before dispatch. Existing dirty-history markers block later
  closes even if an older record-only verification passed. Full invalidation and reproof
  of fixed completions, downstream report movements and the opening baseline are not
  implemented; markers cannot be cleared by the general-record check. The history
  invalidation section above describes the required future contract.
- Still unavailable: attribution of unresolved items by read-back, full historical
  reproof, multiple-tax-account attribution without a rate-to-account proof, and a
  Company-page view of close results. Dispatch remains off.

Implementation-review regressions: all 135 tests in the requested general-write, shared
write-gate, observation, agent store/tools and unknown-recovery suites passed. All 289
backend JavaScript files passed syntax checks. Distinct implementation and safety
reviewers re-reviewed the final fixes without remaining concrete findings. These checks
prove isolated behavior and source boundaries, not live accounting outcomes.
