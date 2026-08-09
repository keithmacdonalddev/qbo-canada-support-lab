# Test Data Lab Rebuild Roadmap

**Status:** Rebuild underway
**Updated:** 2026-08-08
**Product contract:** `prd.md`
**Detailed plan and phase gates:** `continual-test-data-lab-rebuild-plan.md`

## Current position

Phase 0 is complete and Phase 1 discovery has started. This means the product direction and terminology are approved, the older AI/issue-pack/checkpoint emphasis is no longer the roadmap, and the first capability/report catalog artifacts now exist. It does **not** mean any new generation, scheduling, QBO mutation, or database architecture is implemented.

The current application remains usable as an implementation baseline while the rebuild proceeds by gated vertical slices. Existing OAuth, QBO client handling, production confirmation, auth, audit, seeding, generation, explorer, checkpoint, issue-pack, and AI code is preserved. Source presence is not evidence that a rebuild phase is complete.

The connected company is a real Production QBO Advanced Canada company. No rebuild phase may live-test a write merely because production access exists.

## Program sequence

| Phase | Goal | Status | Gate before moving on |
| --- | --- | --- | --- |
| 0. Product reset | Establish the mission, public name, legacy status, and evidence contract | **Complete — 2026-08-08** | Product statement, outcomes, non-goals, owners, and legacy priorities are unambiguous |
| 1. Capability and report discovery | Replace assumptions with a verified Advanced Canada catalog | **In progress** | Tier 1 candidates classified; report definitions approved; no unsupported automation claims |
| 2. Design system and prototypes | Prove the operating model in fixture-driven desktop and narrow workflows | Not started | Visual direction, six workflows, accessibility, and reachability approved |
| 3. Server foundation | Add realm context, memberships, permissions, feature flags, durable operations, and safe startup behavior | Not started | Server-owned authority and invariant tests pass; no legacy data loss |
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

- versioned registry contract and starter catalog under `docs/discovery/`;
- official-source research notes with confirmed facts separated from unknowns;
- initial Tier 1 candidates and report families;
- a local catalog validation command.

Still required to pass Phase 1:

- review every candidate entity and operation in the current official API Explorer;
- finish Canada/Advanced product applicability and current-app entitlement checks;
- classify users/roles, reconciliation, budgets, tax, projects, custom fields, attachments, and other Advanced features;
- complete exact report names, endpoints or manual navigation, prerequisites, assertions, and evidence methods;
- propose Development, Flagship, and Scale volumes from evidence;
- obtain separate authorization for any read benchmark or sandbox mutation spike.

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

Phase 1 discovery and Phase 2 design may proceed in parallel using documents and fixtures. New mutation infrastructure waits for both gates.

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

1. Review and expand the starter catalog until all candidate Tier 1 capabilities are classified.
2. Complete the official QBO Advanced Canada product/API/manual-only evidence pass.
3. Define the report dependency map and critical-report assertions.
4. Propose the flagship business blueprint and evidence-backed scale profiles.
5. Create and render the Phase 2 design system and six critical workflow prototypes using fixtures.
6. Return for approval of the Phase 1 and Phase 2 gates before implementing new QBO mutation paths.
