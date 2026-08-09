# Rebuild owner approval packet

**Status:** Awaiting lab-owner decisions
**Prepared:** 2026-08-09
**Scope:** Static discovery and fixture design only

The implementation is ready for four owner decisions. Approval here does not start the app, call QBO, write MongoDB, enable Production scheduling, or authorize a mutation.

## Decision 1 — Catalog direction

**Recommendation:** Approve the direction, while keeping Phase 1 `In progress` until the 30 Tier 1 operation gaps, two lower-tier API questions, and connected-company evidence are resolved.

- 24 capabilities and all 48 plan-required report rows are present.
- Candidate Tier 1 operations have a draft seven-entity receivables and five-entity payables matrix with 30 explicit operation unknowns.
- Twenty-three reports use published Reports API endpoints; 25 are honestly classified product/manual or conditional.
- Dataset coverage remains unknown unless separately observed. Static classification is not a coverage claim.

## Decision 2 — Flagship business profile

**Recommendation:** Approve Harbour & Pine Operations Inc. as the public-safe fixture identity and approve the three-line operating shape: Field & Advisory Services, Supply & Workshop, and Care Plans.

Still deliberately deferred: tax fixtures, exact chart of accounts, multicurrency activation, connected-company entitlements/preferences, and any live build.

## Decision 3 — Volume profiles

**Recommendation:** Approve Development and Flagship as planning targets; retain Scale as sandbox-only and provisional.

- Development: 6 months and about 420 historical transactions.
- Flagship: 36 months and about 9,360 historical transactions.
- Scale: provisional 5× Flagship, sandbox-only after a separate workload approval.
- Production scheduling stays off. Counts are not runtime authorization and may change from sandbox performance evidence.

## Decision 4 — Visual direction and six workflows

**Recommendation:** Approve the calm, dense, desktop-first operational direction and the six fixture workflows: Overview, Company Blueprint, Coverage, Calendar & Operations, Records, and Reconciliation & Close.

Rendered evidence is indexed in [`docs/design/rendered-review.md`](design/rendered-review.md). Manual NVDA, Windows forced-colours, and React component interaction acceptance are Phase 4 gates because real React route/focus behavior does not exist yet.

## How to decide

The lab owner can reply `Approve all four` or list changes by decision number. Partial approval is valid and will be recorded without treating the other decisions as accepted.
