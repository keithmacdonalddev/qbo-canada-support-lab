# Test Data Lab Rebuild Roadmap

**Status:** Rebuild underway
**Updated:** 2026-08-09
**Product contract:** `prd.md`
**Detailed plan and phase gates:** `continual-test-data-lab-rebuild-plan.md`

## Current position

Phase 0 is complete. Phase 1 now has a complete 24-capability/48-report inventory and a schema-valid 12-entity operation matrix. The catalog direction, flagship identity/operating shape, and Development/Flagship planning targets were owner-approved on 2026-08-09; 30 exact Tier 1 create/update/void references, two lower-tier API questions, and all dataset evidence remain open, so Phase 1 is still in progress. Phase 2 is accepted at its fixture-design gate with six rendered workflows; React interaction, NVDA, and Windows forced-colours acceptance remain Phase 4 work. The user authorized an initial non-live Phase 3 slice: authenticated server-owned context, static definition reads, additive membership/blueprint models, off-by-default experimental mutation gates, and safer startup defaults now exist. No new generation, scheduling, QBO mutation, or database migration has been implemented or run.

The current application remains usable as an implementation baseline while the rebuild proceeds by gated vertical slices. Existing OAuth, QBO client handling, production confirmation, auth, audit, seeding, generation, explorer, checkpoint, issue-pack, and AI code is preserved. Source presence is not evidence that a rebuild phase is complete.

The connected company is a real Production QBO Advanced Canada company. No rebuild phase may live-test a write merely because production access exists.

## Program sequence

| Phase | Goal | Status | Gate before moving on |
| --- | --- | --- | --- |
| 0. Product reset | Establish the mission, public name, legacy status, and evidence contract | **Complete — 2026-08-08** | Product statement, outcomes, non-goals, owners, and legacy priorities are unambiguous |
| 1. Capability and report discovery | Replace assumptions with a verified Advanced Canada catalog | **In progress** | Tier 1 candidates classified; report definitions approved; no unsupported automation claims |
| 2. Design system and prototypes | Prove the operating model in fixture-driven desktop and narrow workflows | **Accepted — 2026-08-09** | Visual direction, six workflows, accessibility, and reachability approved |
| 3. Server foundation | Add realm context, memberships, permissions, feature flags, durable operations, and safe startup behavior | **In progress — initial read-only foundation** | Server-owned authority and invariant tests pass; no legacy data loss |
| 4. Shell and read-only coverage | Ship the new shell, Overview, and truthful coverage views | Not started | Scope, status, freshness, errors, and legacy placement are clear without mutation |
| 5. Blueprint and master data | Publish the business definition and build coherent master-data operations | Not started | Sandbox idempotency, accounting fixtures, preview, and audit pass |
| 6. Historical lifecycles | Backfill linked, realistic history across the approved horizon | Not started | No gaps/duplicates; critical reports populate plausibly and reconcile |
| 7. Continual operations | Add the business calendar, catch-up, recurring work, recovery, and optional scheduling | Not started | Stop/restart/rate-limit/partial-failure matrix passes; production scheduling remains off |
| 8. Reports, reconciliation, close | Validate report relationships and recurring close evidence | Not started | Critical report gate passes; reconciliation states do not overclaim QBO confirmation |
| 9. Data management | Complete supported QBO and application-data administration | Not started | Full pagination and entity-specific mutation policies pass |
| 10. Cutover and hardening | Finish migration, evidence, performance, accessibility, and operating documentation | Not started | Rebuild definition of done passes; no P0/P1 defect or unexplained discrepancy |

## Active slice

### Phase 0 — completed

Delivered by the first rebuild slice:

- approved `continual-test-data-lab-rebuild-plan.md` as the detailed product-priority authority;
- replaced the old PRD and roadmap direction;
- adopted the public name **Test Data Lab** while keeping QBO terminology descriptive only;
- classified checkpoints as deferred and issue packs/AI as legacy or experimental;
- marked earlier phase documents as historical implementation records;
- added `REBUILD_RELEASE_EVIDENCE.md`.

### Phase 1 — in progress

Current work is deliberately static and read-only:

- versioned catalog and draft 12-entity Tier 1 operation matrix under `docs/discovery/`;
- official-source classification for all 48 required report rows;
- an owner-approved flagship direction and Development/Flagship planning targets, with unresolved blueprint details and Scale retained as proposals;
- Draft 2020 schema and cross-reference validation.

Still required to pass Phase 1:

- observe Canada/Advanced connected-company applicability and entitlements only after an approved read target;
- resolve 24 entity create/update cells and six void operations from exact current entity references or separately approved sandbox evidence;
- resolve general Budget create/update/delete and RecurringTransaction update support without guessing;
- collect company-specific dataset/report population, parity, plausibility, and freshness evidence;
- obtain separate authorization for any read benchmark or sandbox mutation spike.

The owner approved the catalog direction, public-safe flagship identity and three operating divisions, and the Development/Flagship planning targets on 2026-08-09. This decision did not resolve the remaining API/dataset evidence or authorize live work.

### Phase 2 — accepted

The design contract, six workflows, 28 light/dark desktop/narrow renders, and reproducible interaction/contrast checks are implemented. The lab owner accepted the visual direction and six workflows on 2026-08-09. Manual NVDA, Windows forced-colours, and real component interaction acceptance move with the React implementation into Phase 4.

### Phase 3 — initial foundation in progress

The first slice is documented in `docs/architecture/rebuild-phase-3-foundation.md`. It adds read-only context/definition contracts, additive membership and blueprint-version models, request correlation, server feature flags, off-by-default legacy AI/issue-pack execution, import-safe server construction, and default-off legacy startup writes. No migration or live runtime check was performed.

## Non-negotiable dependencies

```text
Product approval
  ├─> Capability/report discovery ─> Blueprint and server contracts
  │                                  ├─> Master data ─> History ─> Continual work
  │                                  └─> Reports/reconciliation ────────────────┘
  └─> Design system/prototypes ─────> New shell ─> Vertical-slice migration

Server-owned authorization + realm context ─> Any new QBO write
Managed entities + durable operation steps ─> Safe retry, recovery, and scheduling
Report prerequisites ───────────────────────> Credible coverage claims
Sandbox and manual evidence ────────────────> Any bounded Production canary
```

Phase 1 discovery, Phase 2 design, and non-live Phase 3 foundation work may proceed in parallel using documents, fixtures, and mocked contracts. New QBO mutation infrastructure waits for the owner gates and the server authorization/safety gate.

## Approval boundaries

- Static documentation, schema, fixtures, builds, lint, and mocked tests are safe default work.
- Starting or restarting the app still requires an explicit current request.
- QBO reads, benchmarks, OAuth, database-changing checks, sandbox writes, and production writes require the approval boundary defined in `AGENTS.md` and the rebuild plan.
- Sandbox mutations require per-spike approval and a stated target.
- Production mutations require a separately approved operation, exact realm/company/environment, budget, rollback or compensation approach, and retained evidence.
- Automatic Production scheduling remains off until its own Phase 7 approval.

## Historical document map

The following files record the implementation that existed before this rebuild. They may contain useful technical evidence, but they do not set current product priority:

- `phase-0-api-validation-spike.md` — completed historical REST/API spike;
- `phase-1-foundation-plan.md` — historical auth, connection, seeding, dashboard, and audit foundation;
- `phase-2-plan.md` — historical generation, checkpoint, explorer, and issue-pack implementation note;
- `phase-2-reality-inspection-plan.md` — superseded detailed design for the old Phase 2;
- `phase-3-ai-layer-plan.md` — historical AI implementation note; AI is experimental for the rebuild;
- `phase-4-hardening-plan.md` — unimplemented old hardening proposal, superseded as a roadmap.

No historical plan should be deleted until the rebuild's retention and migration decisions are approved.

## Next gate work

1. Complete the Phase 3 membership migration dry run and realm-owned encrypted connection decision without running a migration.
2. Expand authorization/correlation tests across every legacy mutation route.
3. Resolve the 30 Tier 1 operation gaps and two lower-tier API questions, then seek separate approval for any connected-company read or sandbox spike.
4. Begin the Phase 4 React shell/read-only coverage slice; keep React interaction, NVDA, and Windows forced-colours acceptance in that phase.
5. Do not implement a new QBO mutation path until its server-owned authority, preview, idempotency, budget, audit, sandbox, and owner gates pass.
