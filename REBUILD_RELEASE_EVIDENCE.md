# Test Data Lab Rebuild Evidence

**Status:** Active checklist
**Opened:** 2026-08-08
**Authority:** `continual-test-data-lab-rebuild-plan.md`
**Rule:** A phase passes only when its evidence is linked here and the stated reviewer accepts it. Source presence or a successful build is not a substitute for missing runtime, rendered, accounting, accessibility, or live-path evidence.

## Status vocabulary

- **Not started:** no current implementation evidence.
- **In progress:** implementation or evidence collection has begun; the gate has not passed.
- **Static verified:** non-mutating source/schema/build checks pass.
- **Fixture verified:** mocked or fixture-driven behaviour passes without a live QBO/database target.
- **Sandbox verified:** an explicitly approved sandbox observation or mutation has recorded evidence.
- **Production canary verified:** one exact, separately approved Production operation has recorded evidence.
- **Accepted:** the named decision owner approved the phase gate.
- **Blocked:** a documented decision or external capability prevents meaningful progress.

## Program gate summary

| Phase | Status | Owner | Required acceptance evidence | Current evidence |
| --- | --- | --- | --- | --- |
| 0. Product reset | Accepted | Lab owner | Approved mission, name, priorities, owners, non-goals, roadmap, evidence contract | `prd.md`; `roadmap.md`; plan section 35; historical phase status notes; public app name |
| 1. Capability/report discovery | In progress | Lab owner | Tier 1 classification, report catalog, sources, dependency map, volume proposal, recorded live spikes if any | `docs/discovery/` starter artifacts; no live spikes |
| 2. Design system/prototypes | Not started | Lab owner | `DESIGN.md`, `DESIGN.html`, six workflows, desktop/narrow renders, accessibility and reachability review | None |
| 3. Server foundation | Not started | Lab owner | Authorization/context contracts, invariant tests, migration dry run, startup decision | None |
| 4. Shell/read-only coverage | Not started | Lab owner | New shell and Overview/Coverage states, fixture and browser evidence | None |
| 5. Blueprint/master data | Not started | Lab owner | Published blueprint, sandbox idempotency, accounting fixtures, preview/audit evidence | None |
| 6. Historical lifecycles | Not started | Lab owner | Approved horizon, linked lifecycle fixtures, no gaps/duplicates, critical report plausibility | None |
| 7. Continual operations | Not started | Lab owner | Calendar/recovery/failure matrix, scheduling controls, explicit Production scheduling decision | None |
| 8. Reports/reconciliation/close | Not started | Lab owner | Critical report assertions and honest reconciliation/close evidence | None |
| 9. Data management | Not started | Lab owner | Full pagination, freshness/provenance, server-owned entity action policies | None |
| 10. Cutover/hardening | Not started | Lab owner | Full definition of done, operator docs, canaries, no P0/P1 defects | None |

## Phase 0 evidence

### Product truth

- [x] Public product name is Test Data Lab.
- [x] Product mission is continual realistic flagship-company operation.
- [x] P0 outcomes and non-goals are recorded in `prd.md`.
- [x] Checkpoints are deferred.
- [x] Existing issue packs and AI are classified as legacy/experimental.
- [x] Detailed accepted and deferred decisions are recorded in plan section 35.
- [x] The roadmap uses the rebuild's Phase 0–10 sequence.
- [x] Earlier phase documents are labeled historical and retained.

### Safety boundary

- [x] Documentation work does not authorize runtime startup, OAuth, QBO calls, database writes, or Production scheduling.
- [x] The README states that the connected company is Production.
- [x] Rollback is described as application rollback/recovery, not reversal of accepted QBO effects.
- [x] No legacy data or code was deleted during Phase 0.

### Static verification

- [x] `npm run validate:discovery`
- [x] `npm run build --workspace=frontend`
- [x] `npm run lint --workspace=frontend` (passes with three pre-existing React hook dependency warnings in `AICommandCenter.jsx`)
- [x] `git diff --check`
- [x] Final changed-file inspection

## Phase 1 discovery evidence

### Registry contract

- [x] Versioned JSON Schema exists.
- [x] Versioned starter catalog exists.
- [x] Human-reviewable catalog summary exists.
- [x] Product applicability, API operations, app implementation, dataset coverage, and evidence are separate fields.
- [x] `unknown` is a valid discovery state and a release failure.
- [x] Stable capability/report keys and link validation exist.
- [ ] Every candidate Tier 1 capability is classified.
- [ ] Every critical report is classified with prerequisites and assertions.

### Official-source research

- [x] Initial official Intuit source pass recorded.
- [x] API Explorer is recorded as the per-entity operation authority.
- [x] Query pagination and published rate limits are recorded.
- [x] Reports API and initial endpoint names are recorded.
- [x] Project API product and partner-tier conditions are separated.
- [ ] Users/roles surface classified.
- [ ] Reconciliation surface classified.
- [ ] Canadian tax create/read/update boundaries classified.
- [ ] Budget and recurring-transaction boundaries classified.
- [ ] Full report endpoint/manual-only inventory completed.

### Live evidence

- [ ] Read/query pagination benchmark — requires an explicit target and approval.
- [ ] Rate/latency benchmark — requires an explicit target and approval.
- [ ] Sandbox-only uncertain-write spikes — require separate approval per spike.
- [x] Production mutation remains disabled for discovery.

## Evidence record template

Copy this block for every sandbox observation, Production canary, or consequential manual acceptance:

```markdown
### Evidence: <short name>

- Date/time and operator:
- Objective:
- Why static/fixture evidence was insufficient:
- Company display name:
- Realm identifier (redacted in public artifacts if required):
- Environment: Sandbox | Production
- Read-only or mutating:
- Exact operation/calls:
- Expected records, amounts, dates, and call budget:
- Preconditions and preview fingerprint:
- Stop condition:
- Cleanup or compensation plan:
- Result: passed | failed | partial | blocked
- QBO trace IDs / audit / operation IDs (redacted as needed):
- Retained artifacts:
- Reviewer and decision:
```

## Final release evidence families

The Phase 10 gate must link current evidence for:

- product truth and approved exclusions;
- static, unit, property, contract, migration, component, accessibility, visual, and fixture end-to-end checks;
- accounting golden fixtures and report relationships;
- authorization, realm/environment, idempotency, lease, stop, retry, and partial-success invariants;
- desktop, constrained desktop, tablet, mobile, zoom, dark, reduced-motion, and forced-colour workflows;
- keyboard and assistive-technology review;
- approved sandbox operations and exact Production canaries;
- operator, recovery, privacy, retention, and known-limitation documentation;
- zero unresolved P0/P1 defects and zero unexplained accounting discrepancies.
