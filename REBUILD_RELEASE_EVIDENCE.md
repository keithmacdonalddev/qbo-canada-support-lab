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
| 1. Capability/report discovery | In progress; static gaps and owner/live evidence pending | Lab owner | Tier 1 classification, report catalog, sources, dependency map, volume proposal, recorded live spikes if any | Draft 2020 schema-valid catalog: 41 sources, 24 capabilities, a 12-entity draft operation matrix, and 48 statically classified reports; 30 exact Tier 1 operations, connected-company evidence, and owner approval pending |
| 2. Design system/prototypes | Fixture verified | Lab owner | `DESIGN.md`, `DESIGN.HTML`, six workflows, light/dark desktop/narrow renders, accessibility and reachability review | Six workflows; 28 renders; 70 responsive browser checks; 26 contrast pairs; owner visual approval pending; React/NVDA/forced-colours checks are Phase 4 |
| 3. Server foundation | Static verified; in progress | Lab owner | Authorization/context contracts, invariant tests, migration dry run, startup decision | Read-only context/definition routes; additive membership/blueprint models; default-off experimental mutations/startup writes; ten backend contract tests; migration/encryption/audit gate open |
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
- [ ] Every candidate Tier 1 operation is statically classified. The seven-entity receivables and five-entity payables draft matrix is schema valid, but 24 create/update cells and six void operations remain explicitly unknown.
- [x] Every critical report is statically classified with prerequisites, assertions, source, and manual navigation where no endpoint exists.

### Official-source research

- [x] Initial official Intuit source pass recorded.
- [x] API Explorer is recorded as the per-entity operation authority.
- [x] Query pagination and published rate limits are recorded.
- [x] Reports API and initial endpoint names are recorded.
- [x] Project API product and partner-tier conditions are separated.
- [x] Users/roles surface classified as manual-only in the reviewed API surface.
- [x] Reconciliation surface classified as manual-only in the reviewed API surface.
- [x] Canadian tax create/read/update boundaries classified without claiming unsupported automation.
- [x] Budget and recurring-transaction boundaries classified; unresolved lower-tier operations remain explicit unknowns.
- [x] All 48 plan section 13.2 report rows are represented and validated against the required-report manifest.
- [x] Current official pass records 23 documented report endpoints and 25 exact product/manual or conditional classifications.
- [x] All 21 formerly unresolved plan-required rows now have exact product/API/manual classification and discrepancies.

### Live evidence

- [ ] Read/query pagination benchmark — requires an explicit target and approval.
- [ ] Rate/latency benchmark — requires an explicit target and approval.
- [ ] Sandbox-only uncertain-write spikes — require separate approval per spike.
- [x] Production mutation remains disabled for discovery.

### Static discovery result

- [x] `npm run render:discovery`
- [x] `npm run validate:discovery` compiles both Draft 2020 schemas with Ajv and validates the complete catalog, draft entity-operation matrix, required-report manifest, and dataset-evidence guardrails.
- [ ] Candidate Tier 1 static operation classification has no unknown; 30 exact create/update/void operation references are still open.
- [x] Required report static classification has no unknown.
- [ ] Company-specific dataset evidence and freshness remain release blockers until separately approved observation.
- [ ] Lab-owner approval of the catalog, flagship profile, and volume proposal remains open.

## Phase 2 design evidence

### Design contract and fixtures

- [x] `DESIGN.md` and standalone `DESIGN.HTML` exist.
- [x] Semantic token proposal and light/dark theme contract exist.
- [x] Component/state matrix, screen briefs, route/migration map, content rules, and research decision record exist.
- [x] Six critical fixture workflows exist: Overview, Blueprint, Coverage, Operation, Records, and Reconciliation/Close.
- [x] Fixtures contain no external runtime dependency or network-capable code.
- [x] Production execution and saved changes remain disabled or explicitly unavailable in fixtures.

### Rendered and accessibility evidence

- [x] Twenty-eight exact-size PNGs: seven surfaces in light and dark themes at 1440×1000 and 390×844.
- [x] Seventy responsive browser checks pass across two themes and five CSS viewports from 1440×1000 through 320×800.
- [x] No page-level horizontal overflow or undersized active target in the tested target-size contract.
- [x] First Tab reaches a visible skip link on all seven surfaces.
- [x] Narrow navigation opens from the Menu button, moves focus into the rail, closes with Escape, and returns focus; role and active-work scope remain visible at 390px and 320px.
- [x] Twenty-six light/dark semantic text pairs, including disabled controls, pass 4.5:1.
- [x] Reduced-motion and forced-colour CSS contracts pass static validation.
- [x] `npm run verify:design:browser` deterministically regenerates evidence using a local-only fixture server, rejects external requests, and records source/screenshot hashes plus tool and environment versions in `browser-review.json`.
- [x] Evidence and limitations are recorded in `docs/design/rendered-review.md` and `artifacts/rebuild/design-evidence/browser-review.json`.
- [ ] Manual NVDA and Windows forced-colours workflow acceptance — Phase 4 gate after React focus/interaction behaviour exists.
- [ ] React component interaction tests — Phase 4 gate after fixtures become real components.
- [ ] Lab-owner visual approval of the six workflows and design direction.

### Static verification

- [x] `npm run validate:design`
- [x] `npm run validate:design:contrast`
- [x] `npm run build --workspace=frontend`
- [x] `npm run lint --workspace=frontend` (zero errors; three pre-existing React hook dependency warnings in `AICommandCenter.jsx`)

Phase 2 remains `Fixture verified`, not `Accepted`. The package is ready for owner review. The user's 2026-08-09 instruction separately authorizes the non-live Phase 3 foundation now recorded below; it does not authorize app runtime startup, QBO calls, database writes, or Production scheduling.

## Phase 3 initial foundation evidence

### Implemented static contracts

- [x] `GET /api/context` resolves realm/company from the authenticated user's server-side active connection and returns safe metadata only.
- [x] Client-supplied realm/company/environment overrides are rejected across the new route family.
- [x] Authenticated, permission-checked capability, operation-matrix, report, blueprint-proposal, and volume-profile read endpoints exist.
- [x] Additive `CompanyMembership` and `BlueprintVersion` models plus a pure blueprint validator exist; no migration/write route ran.
- [x] Legacy-role compatibility grants read permissions only until explicit memberships exist.
- [x] Request IDs and the new validation/error envelope are covered by contract tests.
- [x] Legacy AI plan execution and issue-pack execution are off by default before the QBO handler boundary.
- [x] Importing `server.js` does not start it; legacy startup seeding and stale-run rewrites are default-off.
- [x] `npm run test:backend` passes ten non-live tests, including public health reachability, route-level denial checks, sanitized failures, derived blueprint validation, and read-only legacy-role migration behavior.
- [x] Connection/membership/encryption/startup decisions and remaining Phase 3 gates are documented in `docs/architecture/rebuild-phase-3-foundation.md`.

### Open Phase 3 gate work

- [ ] Membership migration dry run and owner review.
- [ ] Realm-owned encrypted connection model and reversible migration.
- [ ] Authorization matrix tests for every mutation route.
- [ ] Full sanitized audit/correlation and consistent legacy-route validation contracts.
- [ ] Blueprint write/version workflow with permission and audit evidence.
- [ ] Owner acceptance of migration, encryption, and startup decisions.

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
