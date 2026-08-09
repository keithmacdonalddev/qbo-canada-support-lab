# Phase 2 — Reality + Inspection Plan

**Status:** Historical design — superseded by `phase-2-plan.md`, then by the Test Data Lab rebuild for product priority
**Current product authority:** `continual-test-data-lab-rebuild-plan.md`
**Depends on:** Phase 1 complete (Gate B passed)
**Phase objective:** Turn the seeded flagship company into a realistic, inspectable support lab.

---

## Current Status Note

This file is the detailed Phase 2 design plan. The current implementation summary lives in `phase-2-plan.md`.

Source now contains Phase 2 surfaces for historical generation, checkpoints, diffs, entity explorer, issue packs, and run history. Treat this document as design rationale, not the current status tracker.

Known divergence from this original plan:

- The implementation uses `GenerationRun`, `generation-engine.js`, `checkpoint.js`, and `issuepack-engine.js` naming rather than every planned name in this document.
- BullMQ is installed but the current visible route/module implementation still needs a separate verification pass before claiming durable queue behavior.
- Phase 2 acceptance criteria still need fresh QBO-connected testing after revival.
- Section 4.1 assumed `qbo-client.js` needed no changes. As of 2026-05-28 it was hardened on branch `fix/qbo-client-error-handling` (committed, not yet merged): it captures the Intuit `intuit_tid` trace id and throws status-bearing errors, and the Phase 2 checkpoint/explore routes surface them via `backend/src/modules/qbo-error.js`. See `phase-2-plan.md` for status detail.

---

## 1. Phase outcome

At the end of Phase 2, a user should be able to:

- Generate 6 months of backdated, linked AR and AP transaction history
- Create named checkpoints (snapshots of company state)
- Compare any two checkpoints with field-level diffs
- Search and browse QBO entities with linked transaction chain views
- Inject 3-5 predefined issue packs that simulate real customer problems
- View a timeline of changes to any entity or entity family
- See all of the above in a polished, keyboard-navigable UI

**Exit criteria (from PRD):** A user can generate 6 months of realistic history, create a checkpoint, inject an AR issue pack, and inspect the resulting discrepancy using the entity explorer and diff view.

---

## 2. Entry criteria

Phase 2 starts only after Phase 1 provides:

- Working auth, OAuth connection, and company profile
- Master data seeded (50 customers, 30 vendors, 50 items)
- Async background job pattern (fire-and-forget with progress polling)
- QBOClient with token refresh, rate-limit retry, and realm scoping
- Audit log infrastructure

All confirmed complete as of commit `56ea72f`.

---

## 3. Scope

### In scope

1. **BullMQ + Redis job queue** — durable background jobs replacing fire-and-forget pattern
2. **Historical activity generation** — backdated AR/AP chains across 6-month window
3. **Checkpoint system** — snapshot, store, list, delete
4. **Diff engine** — compare two checkpoints, field-level change detection
5. **Entity explorer** — search, browse, detail view, linked transaction chains
6. **Issue packs (5)** — AR mismatch, duplicate payment, tax code inconsistency, unapplied credit, orphaned transaction
7. **Timeline view** — chronological change history per entity
8. **Dashboard enhancements** — generation status, checkpoint count, active issue packs

### Out of scope (Phase 3+)

- AI orchestration, natural language planning, support note generation
- Continuous activity engine (Phase 4)
- Custom issue pack authoring (Phase 4)
- Webhook/CDC change tracking (evaluate during Phase 2, implement Phase 3)

---

## 4. Architecture

### 4.1 New backend modules

```
backend/src/
  modules/
    qbo-client.js          # existing — no changes needed
    job-queue.js            # NEW — BullMQ queue setup, worker definitions
    history-generator.js    # NEW — historical transaction generation logic
    checkpoint-engine.js    # NEW — snapshot creation, storage, diff computation
    chain-resolver.js       # NEW — trace linked transactions from any starting record
    issue-engine.js         # NEW — issue pack definitions, prerequisite checks, execution
```

### 4.2 New models

```
backend/src/models/
  Checkpoint.js             # Named snapshots of entity state
  IssuePack.js              # Issue pack definitions (built-in, seeded at startup)
  IssuePackRun.js           # Execution history per pack per company
  HistoryRun.js             # Historical generation run tracking (like SeedRun)
```

### 4.3 New routes

```
backend/src/routes/
  history.js                # POST /start, GET /status, GET /runs
  checkpoints.js            # POST /, GET /, GET /:id, DELETE /:id, POST /diff
  entities.js               # GET /search, GET /:type/:id, GET /:type/:id/chain
  issues.js                 # GET /packs, POST /packs/:id/run, GET /runs, GET /runs/:id
  timeline.js               # GET /:type/:id/timeline, GET /company/timeline
```

### 4.4 New frontend pages

```
frontend/src/pages/
  EntityExplorer.jsx        # Search, browse, detail panel, chain visualization
  ScenarioLibrary.jsx       # Issue pack catalog, run history, execution
  TimelineDiff.jsx          # Timeline view + checkpoint diff (combined page)
```

### 4.5 Frontend route additions

```
/entities                   # Entity explorer
/entities/:type/:id         # Entity detail with chain
/scenarios                  # Scenario library (issue packs)
/scenarios/:id/run          # Issue pack execution
/timeline                   # Company timeline + checkpoint management
/timeline/diff/:a/:b        # Checkpoint diff view
```

---

## 5. Detailed design

### 5.1 BullMQ + Redis job queue

**Why:** The current fire-and-forget `runSeedingJob()` pattern loses jobs on server restart, can't retry failed jobs, and has no concurrency control. Phase 2 adds multiple long-running job types (history generation, issue pack execution, checkpoint creation) that need durability.

**Implementation:**
- Install `bullmq` and `ioredis`
- `job-queue.js` exports named queues: `history`, `seed`, `issues`, `checkpoints`
- Each queue has a dedicated worker with concurrency=1 per realm (prevent conflicting writes)
- Job progress updates via BullMQ's built-in `job.updateProgress()`
- Migrate existing seed route to use BullMQ (backward-compatible — same `/seed/start` + `/seed/status` API)
- Redis connection config in `.env`: `REDIS_URL=redis://localhost:6379`

**Job schema (common):**
```
{
  userId, realmId, jobType,
  status: pending | active | completed | failed,
  progress: { phase, detail, percent },
  result: { ... },
  error: String,
  startedAt, completedAt
}
```

### 5.2 Historical activity generation

**Goal:** Generate 6 months of realistic, linked transactions that make the flagship company feel like a real small-to-mid-sized Canadian business.

**Transaction mix per month (~25-35 transactions):**

| Type | Count/month | Notes |
|------|------------|-------|
| Invoices | 8-12 | Varying customers, mix of full/partial amounts, some with estimates first |
| Payments received | 6-10 | Some same-day, some 15-30 days late, some partial |
| Credit memos | 1-2 | Applied to open invoices |
| Bills | 5-8 | Varying vendors, expense and item-based lines |
| Bill payments | 4-7 | Some prompt, some delayed |
| Vendor credits | 0-1 | Occasional |
| Journal entries | 2-3 | Period-end adjustments, accruals |
| Deposits | 2-4 | Unlinked bank deposits |

**Generation strategy:**
- Work backward from today: month -6 → month -1
- Each month picks random subsets of seeded customers/vendors/items
- AR chains: ~30% start with estimate, all create invoice, ~70% get full payment, ~20% partial, ~10% unpaid
- AP chains: bill → bill payment (80% paid, 20% open)
- Dates distributed across the month with natural clustering (more activity mid-month)
- All amounts use realistic Canadian dollar ranges ($50-$15,000)
- Tax codes applied per item's existing tax assignment

**Linking rules (critical):**
- Estimate → Invoice via `LinkedTxn: [{ TxnId, TxnType: 'Estimate' }]`
- Payment → Invoice via `Line[].LinkedTxn: [{ TxnId, TxnType: 'Invoice' }]`
- Credit Memo → Invoice via `Line[].LinkedTxn` (when applied)
- Bill Payment → Bill via `Line[].LinkedTxn: [{ TxnId, TxnType: 'Bill' }]`
- Vendor Credit → linked to vendor (not directly to bill in QBO API)

**Rate limit management:**
- 2.2 ops/sec sustained (Phase 0 confirmed)
- ~180 transactions/month × 6 months = ~1,080 entities
- Each entity requires 1 create + possible 1 query = ~2,160 API calls
- At 2.2/sec ≈ 16 minutes total generation time
- BullMQ job with progress: "Month 3 of 6 — Creating invoices (45%)"

**Idempotency:**
- HistoryRun tracks which months have been generated
- Re-running skips completed months, resumes from last incomplete month
- Each transaction gets a `PrivateNote` with a generation tag: `[QBO-LAB:hist:2025-10:inv:003]`
- Query by PrivateNote before creating to detect duplicates

### 5.3 Checkpoint system

**Checkpoint model:**
```js
{
  userId: ObjectId,
  realmId: String,
  name: String,                    // user-provided, e.g. "Before AR issue pack"
  description: String,             // optional
  entityCounts: {
    customers: Number, invoices: Number, payments: Number,
    bills: Number, billPayments: Number, creditMemos: Number,
    vendorCredits: Number, journalEntries: Number, items: Number,
    estimates: Number, deposits: Number
  },
  entities: {                      // the actual snapshot data
    customers: [{ qboId, SyncToken, data: Mixed }],
    invoices: [{ qboId, SyncToken, data: Mixed }],
    payments: [{ qboId, SyncToken, data: Mixed }],
    // ... same for each entity type
  },
  createdAt: Date
}
```

**Snapshot process (BullMQ job):**
1. Query each entity type: `SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '1970-01-01' MAXRESULTS 1000`
2. Page through results (QBO max 1000 per query, use `STARTPOSITION` for pagination)
3. Store full response objects in checkpoint document
4. Update `CompanyProfile.checkpointCount`
5. Progress: "Snapshotting invoices (3 of 11 entity types)"

**Size consideration:** A mature company might have ~1,500 entities. At ~2KB average per entity = ~3MB per checkpoint. Acceptable for MongoDB. Add TTL index or manual cleanup for old checkpoints.

### 5.4 Diff engine

**Input:** Two checkpoint IDs.

**Output:**
```js
{
  summary: {
    created: 45,    // entities in B but not A
    modified: 12,   // entities in both with different SyncToken or field changes
    deleted: 2,     // entities in A but not B
  },
  byType: {
    invoices: {
      created: [{ qboId, summary: "Invoice #1042, $3,500 to Maple Corp" }],
      modified: [{
        qboId,
        summary: "Invoice #1001",
        changes: [
          { field: "Balance", before: "1500.00", after: "0.00" },
          { field: "MetaData.LastUpdatedTime", before: "...", after: "..." }
        ]
      }],
      deleted: []
    },
    // ... per entity type
  }
}
```

**Algorithm:**
1. For each entity type, build Maps keyed by `qboId`
2. Set difference for created/deleted
3. For shared keys: deep-compare data objects, report changed fields
4. Skip noise fields: `MetaData.LastUpdatedTime`, `SyncToken`, `domain`, `sparse`

**Endpoint:** `POST /api/checkpoints/diff` with body `{ checkpointA, checkpointB }`

### 5.5 Entity explorer

**Backend — chain resolver:**

Given any transaction, trace its linked graph:
- Read the entity → extract `LinkedTxn` array
- For each linked transaction, read it and extract its links
- Build a graph: `{ nodes: [...], edges: [...] }`
- Limit depth to 5 hops (prevent infinite loops)

Example chain for an invoice:
```
Estimate #1001 → Invoice #1042 → Payment #2001 → Deposit #3001
                                → Credit Memo #2050
```

**Backend — search:**
- `GET /api/entities/search?q=maple&type=customer` → QBO query: `SELECT * FROM Customer WHERE DisplayName LIKE '%maple%'`
- `GET /api/entities/search?q=1042&type=invoice` → `SELECT * FROM Invoice WHERE DocNumber = '1042'`
- Supports: Customer, Vendor, Invoice, Bill, Payment, BillPayment, CreditMemo, VendorCredit, Estimate, JournalEntry, Item, Account

**Frontend — entity explorer page:**
- Left panel: search bar + type filter + results list
- Right panel: entity detail (formatted JSON → readable fields)
- Bottom panel or tab: linked transaction chain (horizontal flow diagram or indented tree)
- Click any linked entity to navigate to it

### 5.6 Issue packs

**5 built-in packs:**

**1. AR Mismatch — "Misapplied Payment"**
- Creates: Invoice A ($5,000 to Customer X), Invoice B ($3,000 to Customer X)
- Applies: Payment of $5,000 but links it to Invoice B instead of A
- Symptom: Invoice A shows open, Invoice B shows overpaid/credit balance
- Investigation: check Payment.Line[].LinkedTxn → wrong invoice reference

**2. Duplicate Payment — "Bill Paid Twice"**
- Creates: Bill ($2,500 to Vendor Y)
- Applies: BillPayment #1 ($2,500 via check), BillPayment #2 ($2,500 via bank transfer)
- Symptom: Vendor Y shows $2,500 credit; AP report off by $2,500
- Investigation: query all BillPayments linked to this Bill → two found

**3. Tax Code Inconsistency — "Wrong Tax on Sale"**
- Creates: 3 invoices for same item, but one uses Exempt tax code while item is normally HST-taxable
- Symptom: Tax liability report shows lower collected tax than expected for the item volume
- Investigation: compare tax codes across invoices for same item

**4. Unapplied Credit — "Credit Memo Not Applied"**
- Creates: Invoice ($4,000), Credit Memo ($1,000) for same customer — but credit memo NOT linked to invoice
- Symptom: Customer balance shows $4,000 open + $1,000 available credit instead of $3,000 net
- Investigation: Credit Memo exists but has no LinkedTxn to the invoice

**5. Orphaned Transaction — "Dangling Payment"**
- Creates: Payment received ($2,000) with `UnappliedAmt: 2000` — not linked to any invoice
- Symptom: Shows in bank register but not reflected in any customer balance
- Investigation: Payment.Line has no LinkedTxn entries

**IssuePack model:**
```js
{
  packId: String,           // e.g. "ar-mismatch-v1"
  name: String,
  description: String,
  category: String,         // "AR", "AP", "Tax", "Data Hygiene"
  difficulty: String,       // "beginner", "intermediate", "advanced"
  prerequisites: {
    minCustomers: Number,
    minVendors: Number,
    minItems: Number,
    requiresHistory: Boolean
  },
  expectedSymptoms: [String],
  investigationHints: [String],
  builtIn: Boolean,         // true for shipped packs, false for user-created (Phase 4)
}
```

**IssuePackRun model:**
```js
{
  userId: ObjectId,
  realmId: String,
  packId: String,
  status: enum ['pending', 'running', 'completed', 'failed'],
  entitiesCreated: [{ type: String, qboId: String, role: String }],
  // role = "invoice_a", "misapplied_payment", etc. — semantic labels for the scenario
  preCheckpointId: ObjectId,    // auto-created before injection
  postCheckpointId: ObjectId,   // auto-created after injection
  startedAt: Date,
  completedAt: Date,
  error: String
}
```

**Execution flow:**
1. Check prerequisites (enough master data? history generated?)
2. Auto-create "before" checkpoint
3. Execute mutations (create entities with deliberate issues)
4. Auto-create "after" checkpoint
5. Log to AuditLog with `actionType: 'inject'`
6. Return run ID — frontend shows created entities + "Inspect Diff" button

### 5.7 Timeline view

**Data source:** Audit log entries + checkpoint diffs.

**Company timeline:** `GET /api/timeline/company?since=2025-01-01&limit=50`
- Returns audit log entries ordered by `createdAt` desc
- Enriched with entity summaries where available

**Entity timeline:** `GET /api/timeline/entity/:type/:id`
- Query audit log for entries referencing this entity
- Query checkpoint diffs that include this entity
- Merge and sort chronologically

**Frontend:** Vertical timeline with cards per event. Each card shows:
- Timestamp
- Action type badge (seed, generate, inject, manual)
- Summary (e.g., "Payment #2001 applied to Invoice #1042")
- "View details" expands to show before/after values
- "View in explorer" links to entity explorer

---

## 6. Frontend pages — detailed layout

### 6.1 Entity Explorer (`/entities`)

```
┌──────────────────────────────────────────────────────┐
│ Entity Explorer                                       │
├──────────────┬───────────────────────────────────────┤
│ Search       │ Entity Detail                          │
│ [________]   │                                        │
│ Type: [All▼] │ Invoice #1042                          │
│              │ Customer: Maple Corp                   │
│ Results:     │ Date: 2025-01-15                       │
│ ▸ Inv #1042  │ Total: $3,500.00                       │
│   Inv #1043  │ Balance: $0.00                         │
│   Inv #1044  │ Status: Paid                           │
│   ...        │                                        │
│              │ Line Items:                             │
│              │  1. Consulting Service  $2,000          │
│              │  2. Software License    $1,500          │
│              │                                        │
│              │ ─── Linked Chain ──────────────────── │
│              │ Est #501 → [Inv #1042] → Pmt #2001    │
│              │                        → CM #2050      │
├──────────────┴───────────────────────────────────────┤
│ Raw JSON (toggle)                                     │
└──────────────────────────────────────────────────────┘
```

### 6.2 Scenario Library (`/scenarios`)

```
┌──────────────────────────────────────────────────────┐
│ Scenario Library                                      │
├──────────────────────────────────────────────────────┤
│ ┌─────────────────────┐ ┌─────────────────────┐      │
│ │ AR Mismatch         │ │ Duplicate Payment    │      │
│ │ [AR] [Beginner]     │ │ [AP] [Beginner]      │      │
│ │ Misapplied payment  │ │ Bill paid twice via   │      │
│ │ creates balance     │ │ different methods     │      │
│ │ discrepancy.        │ │                       │      │
│ │ [Run Pack]          │ │ [Run Pack]            │      │
│ └─────────────────────┘ └─────────────────────┘      │
│ ┌─────────────────────┐ ┌─────────────────────┐      │
│ │ Tax Inconsistency   │ │ Unapplied Credit     │      │
│ │ [Tax] [Intermediate]│ │ [AR] [Beginner]      │      │
│ │ Wrong tax code on   │ │ Credit memo exists    │      │
│ │ one of several      │ │ but not linked to     │      │
│ │ identical sales.    │ │ outstanding invoice.  │      │
│ │ [Run Pack]          │ │ [Run Pack]            │      │
│ └─────────────────────┘ └─────────────────────┘      │
│                                                       │
│ ─── Run History ────────────────────────────────────│
│ Pack              Status     Date         Actions    │
│ AR Mismatch       completed  2025-04-08  [Inspect]  │
│ Duplicate Payment completed  2025-04-07  [Inspect]  │
└──────────────────────────────────────────────────────┘
```

### 6.3 Timeline + Checkpoints (`/timeline`)

```
┌──────────────────────────────────────────────────────┐
│ Timeline & Checkpoints                                │
├────────────────────┬─────────────────────────────────┤
│ Checkpoints        │ Company Timeline                 │
│                    │                                   │
│ + Create New       │ ● Apr 8 — Issue pack injected    │
│                    │   AR Mismatch v1                  │
│ ▸ After AR issue   │   [View Diff] [View in Explorer] │
│   Apr 8, 2025      │                                   │
│                    │ ● Apr 8 — Checkpoint created      │
│ ▸ Before AR issue  │   "Before AR issue"               │
│   Apr 8, 2025      │                                   │
│                    │ ● Apr 7 — History generated       │
│ ▸ Post-generation  │   6 months, 187 transactions      │
│   Apr 7, 2025      │                                   │
│                    │ ● Apr 6 — Company seeded          │
│ [Compare ▼]        │   130 entities created             │
│ A: [Before AR ▼]   │                                   │
│ B: [After AR  ▼]   │                                   │
│ [View Diff]        │                                   │
├────────────────────┴─────────────────────────────────┤
│ Diff: Before AR issue → After AR issue                │
│ Created: 3  Modified: 0  Deleted: 0                   │
│                                                       │
│ + Invoice #1050 — $5,000 to Maple Corp                │
│ + Invoice #1051 — $3,000 to Maple Corp                │
│ + Payment #2020 — $5,000 (linked to #1051, not #1050)│
└──────────────────────────────────────────────────────┘
```

---

## 7. Sequencing

### Sprint 1 (Week 1-2): Infrastructure + History Generation

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 1.1 | Install BullMQ + ioredis, configure Redis connection | Backend | — |
| 1.2 | Create `job-queue.js` module with queue definitions and workers | Backend | 1.1 |
| 1.3 | Migrate seed route to use BullMQ | Backend | 1.2 |
| 1.4 | Create `HistoryRun` model | Backend | — |
| 1.5 | Build `history-generator.js` — AR chain generation (estimates, invoices, payments, credit memos) | Backend | 1.2 |
| 1.6 | Build `history-generator.js` — AP chain generation (bills, bill payments, vendor credits) | Backend | 1.5 |
| 1.7 | Build `history-generator.js` — supplemental (journal entries, deposits) | Backend | 1.6 |
| 1.8 | Create `history` routes (start, status, runs) | Backend | 1.5 |
| 1.9 | Add "Generate History" button + progress UI to Dashboard | Frontend | 1.8 |

**Sprint 1 gate:** User can trigger 6-month history generation, see progress, and verify transactions exist in QBO.

### Sprint 2 (Week 2-3): Checkpoints + Entity Explorer

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 2.1 | Create `Checkpoint` model | Backend | — |
| 2.2 | Build `checkpoint-engine.js` — snapshot creation with pagination | Backend | 2.1 |
| 2.3 | Build `checkpoint-engine.js` — diff computation | Backend | 2.2 |
| 2.4 | Create `checkpoints` routes | Backend | 2.2 |
| 2.5 | Build `chain-resolver.js` — linked transaction graph traversal | Backend | — |
| 2.6 | Create `entities` routes (search, detail, chain) | Backend | 2.5 |
| 2.7 | Build Entity Explorer page (search + results + detail panel) | Frontend | 2.6 |
| 2.8 | Add chain visualization to Entity Explorer | Frontend | 2.7 |

**Sprint 2 gate:** User can search entities, view details with linked chains, and create/list checkpoints.

### Sprint 3 (Week 3-4): Issue Packs + Diffs

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 3.1 | Create `IssuePack` and `IssuePackRun` models | Backend | — |
| 3.2 | Build `issue-engine.js` — pack definitions for all 5 packs | Backend | 3.1 |
| 3.3 | Build `issue-engine.js` — execution flow (prereq check → before checkpoint → mutate → after checkpoint) | Backend | 3.2, 2.2 |
| 3.4 | Create `issues` routes | Backend | 3.3 |
| 3.5 | Build Scenario Library page (pack catalog + run button) | Frontend | 3.4 |
| 3.6 | Build run detail view with "Inspect Diff" integration | Frontend | 3.5, 2.3 |
| 3.7 | Build Timeline + Checkpoints page (diff view) | Frontend | 2.4 |

**Sprint 3 gate:** User can run an issue pack, see before/after diff, and inspect the injected discrepancy.

### Sprint 4 (Week 4-5): Timeline + Polish + Integration Testing

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 4.1 | Create `timeline` routes | Backend | — |
| 4.2 | Build timeline UI components | Frontend | 4.1 |
| 4.3 | Enhanced Dashboard — generation status, checkpoint count, active packs, entry points | Frontend | 1.9, 2.4, 3.5 |
| 4.4 | Sidebar navigation updates (add Entity Explorer, Scenarios, Timeline) | Frontend | — |
| 4.5 | End-to-end integration testing: generate → checkpoint → inject → diff → explore | Testing | All |
| 4.6 | agent-browser visual verification of all new pages | Testing | All frontend |
| 4.7 | Performance testing: checkpoint creation with 1,500+ entities | Testing | 2.2 |

**Sprint 4 gate (Phase 2 exit):** Full exit criteria met.

---

## 8. Infrastructure requirements

### Redis
- Required for BullMQ
- Local development: `redis-server` or Docker (`docker run -d -p 6379:6379 redis:7-alpine`)
- Add `REDIS_URL=redis://localhost:6379` to `.env`
- Consider Redis Cloud or AWS ElastiCache for production

### MongoDB sizing
- Checkpoints are the largest new collection (~3MB per checkpoint)
- Recommend: set a soft limit of 20 checkpoints per user, warn at 15
- Add TTL index on old IssuePackRun documents (90 days)

### New npm packages
- `bullmq` — job queue
- `ioredis` — Redis client (BullMQ peer dependency)

---

## 9. Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| History generation exceeds rate limits | Generation fails or takes >30 min | Pace at 2/sec (validated in Phase 0), show ETA in progress UI |
| Checkpoint documents too large for MongoDB | Write failures or slow queries | Limit snapshot to key fields (not full QBO response), paginate storage |
| Issue pack mutations conflict with existing data | Packs create confusing state | Each pack uses fresh entities with distinctive names, auto-checkpoint before |
| QBO query pagination edge cases | Missing entities in snapshots | Test with STARTPOSITION, implement cursor-based fallback if needed |
| Redis not available in all dev environments | BullMQ queue fails silently | Graceful fallback: if no Redis, fall back to in-process execution with warning |

---

## 10. Gate C — Phase 2 exit criteria

All of the following must be true:

- [ ] Historical generation creates 150+ linked transactions across 6 months
- [ ] At least 3 complete AR chains and 3 complete AP chains with correct linking
- [ ] Checkpoint captures all 11 entity types with accurate counts
- [ ] Diff correctly identifies created, modified, and deleted entities between two checkpoints
- [ ] All 5 issue packs execute successfully and produce the documented symptoms
- [ ] Issue pack auto-creates before/after checkpoints
- [ ] Entity explorer search returns results for all supported entity types
- [ ] Chain resolver traces at least 3 hops (e.g., Estimate → Invoice → Payment)
- [ ] Timeline shows chronological audit events for a selected entity
- [ ] All new pages pass design review (agent-browser + professional-design skill)
- [ ] No regression in Phase 1 functionality
- [ ] Lint clean, build passes
