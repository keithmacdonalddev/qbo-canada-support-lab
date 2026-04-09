# Phase 2: Reality + Inspection — Implementation Plan

**Status:** Implemented  
**Date:** 2026-04-09

## Scope

### In Scope
- Historical activity generation (AR/AP transaction chains, backdated across configurable months)
- Checkpoint creation (snapshot key entity sets to MongoDB)
- Checkpoint diff (compare two snapshots, field-level changes)
- Entity explorer (search/browse QBO entities, linked transaction chain tracing)
- 5 built-in issue packs with execution engine and run history
- Generation run tracking (analogous to SeedRun)

### Out of Scope
- Continuous activity engine (Phase 4)
- AI orchestration (Phase 3)
- Custom issue pack authoring (Phase 4)
- Purchase orders / sales orders (not available via API — Phase 0 finding)

---

## Architecture

```
Frontend (React)                          Backend (Express)
├── Dashboard (generation UI)             ├── /api/generate    → generation-engine.js
├── EntityExplorer (search + chains)      ├── /api/checkpoint  → checkpoint.js module
├── Checkpoints (snapshot + diff)         ├── /api/explore     → live QBO queries
└── IssuePacks (catalog + runner)         ├── /api/issuepacks  → issuepack-engine.js
                                          └── issuepack-seeder.js (startup)
```

All routes authenticated via JWT. All mutations audited via `createAuditEntry()`.

---

## New MongoDB Models

| Model | Collection | Purpose |
|-------|-----------|---------|
| `GenerationRun` | generationruns | Tracks historical generation jobs |
| `Checkpoint` | checkpoints | Named entity snapshots |
| `IssuePack` | issuepacks | Issue pack definitions (5 built-in) |
| `IssuePackRun` | issuepackruns | Issue pack execution history |

**Modified:** `CompanyProfile` — added `generationStatus` and `lastGenerationDate` fields.

---

## Backend Modules

### Generation Engine (`modules/generation-engine.js`)
- `runGenerationJob()` — main entry point, loops month-by-month oldest→newest
- `generateMonth()` — creates AR chains (60% weight) and AP chains (40% weight) per month
- `createARChain()` — invoice → payment (full/partial/unpaid) → optional credit memo
- `createAPChain()` — bill → bill payment → optional vendor credit
- `createJournalEntry()` — period-end adjustments (1-2 per month)
- Realistic distributions: amounts vary ($200-$5000), weighted entity selection, 60% full pay / 25% partial / 15% unpaid
- Progress saved to GenerationRun every 5 transactions

### Checkpoint Module (`modules/checkpoint.js`)
- `createCheckpoint()` — queries all 10 entity types from QBO, stores full records
- `diffCheckpoints()` — field-level comparison of two snapshots (added/modified/deleted)
- Skips `MetaData` field in diffs (noisy timestamp changes)

### Issue Pack Engine (`modules/issuepack-engine.js`)
Five built-in packs:
1. **ar-mismatch** — Invoice + payment off by $0.01
2. **duplicate-payment** — Bill paid twice (bill payment + direct check)
3. **tax-code-inconsistency** — Same item with TAX vs NON codes
4. **unapplied-credit** — Credit memo not linked to outstanding invoice
5. **orphaned-payment** — Payment with no linked invoice

### Issue Pack Seeder (`modules/issuepack-seeder.js`)
- Upserts 5 built-in IssuePack documents on server startup

---

## API Endpoints

### Generation (`/api/generate`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/start` | Kick off historical generation (fire-and-forget) |
| GET | `/status` | Latest GenerationRun progress |
| GET | `/history` | All GenerationRuns for user/realm |

### Checkpoints (`/api/checkpoint`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create named checkpoint |
| GET | `/` | List checkpoints (excludes entity data) |
| GET | `/:id` | Get checkpoint metadata |
| GET | `/:id/diff/:compareId` | Diff two checkpoints |
| DELETE | `/:id` | Delete checkpoint |

### Entity Explorer (`/api/explore`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/search` | Search by type + query string |
| GET | `/timeline` | Recent changes from AuditLog |
| GET | `/:entity/:id` | Full entity detail |
| GET | `/:entity/:id/chain` | Recursive linked transaction trace |

### Issue Packs (`/api/issuepacks`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List all pack definitions |
| GET | `/runs` | All runs for user/realm |
| GET | `/runs/:runId` | Run detail with execution log |
| GET | `/:slug` | Single pack detail |
| POST | `/:slug/run` | Execute pack (fire-and-forget) |

---

## Frontend Pages

### Entity Explorer (`/explorer`)
- Entity type dropdown + text search
- Results table with type-appropriate columns
- Detail panel with all fields
- Chain trace button → linked transaction graph

### Checkpoints (`/checkpoints`)
- Create checkpoint form (name + description)
- Checkpoint list table with entity counts
- Diff view: select two checkpoints → added (green), deleted (red), modified (yellow) with field-level before/after

### Issue Packs (`/issuepacks`)
- Pack catalog: cards with name, description, category/severity badges, symptoms, hints
- Run button with confirmation dialog
- Run history tab with execution log expansion

### Dashboard Extension
- "Generate History" card below seed button
- Configuration: months back (3-12), transactions per month (10-60)
- Progress polling while generation runs
- Result summary on completion

### Navigation
Added 3 nav items to sidebar: Entity Explorer, Checkpoints, Issue Packs

---

## Files Created

```
backend/src/models/GenerationRun.js
backend/src/models/Checkpoint.js
backend/src/models/IssuePack.js
backend/src/models/IssuePackRun.js
backend/src/modules/generation-engine.js
backend/src/modules/checkpoint.js
backend/src/modules/issuepack-engine.js
backend/src/modules/issuepack-seeder.js
backend/src/routes/generate.js
backend/src/routes/checkpoint.js
backend/src/routes/explore.js
backend/src/routes/issuepacks.js
frontend/src/pages/EntityExplorer.jsx
frontend/src/pages/Checkpoints.jsx
frontend/src/pages/IssuePacks.jsx
```

## Files Modified

```
backend/src/models/index.js          — Export 4 new models
backend/src/models/CompanyProfile.js  — Add generationStatus, lastGenerationDate
backend/src/server.js                 — Mount 4 routes, call issuepack seeder
frontend/src/App.jsx                  — Add 3 routes
frontend/src/components/Layout.jsx    — Add 3 nav items
frontend/src/pages/Dashboard.jsx      — Add generation UI section
```

---

## Verification Checklist

- [ ] Generation: Start from dashboard → poll shows progress → completion shows transaction counts
- [ ] Checkpoint: Create → list shows entity counts → diff after changes shows added/modified/deleted
- [ ] Entity Explorer: Search entities → click detail → trace chain shows linked transactions
- [ ] Issue Packs: Browse catalog → run pack → execution log shows steps → entities appear in explorer
- [ ] Audit: All operations logged in audit log page

## Exit Criteria

> A user can generate 6 months of realistic history, create a checkpoint, inject an AR issue pack, and inspect the resulting discrepancy using the entity explorer and diff view.
