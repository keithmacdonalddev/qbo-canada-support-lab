# QBO Support Lab Roadmap

**Status:** Revival status tracker
**Source of truth:** `prd.md`

---

## Current Revival Snapshot

Updated: 2026-05-28

The source code is ahead of the original roadmap wording. Use this file as the current status index and the phase files for detail.

**Milestone (2026-05-28): Production API access unlocked.** The Intuit Developer app passed the full App Assessment (App details + Compliance) and now shows "IN PRODUCTION" on the developer portal. Previously the app was sandbox-only. This removes the production-access gate but does not by itself connect a real company.

Not yet done despite production access:

- No production QBO company is connected. `.env` still uses `QBO_ENVIRONMENT=sandbox`. Production OAuth needs a public HTTPS redirect URI (via tunnel or deploy) before a real company can be linked.
- Multicurrency support (foreign-currency accounts, revaluation, balance-sheet FX) is planned, not built.

The branch `fix/qbo-client-error-handling` (committed, not yet merged to main) hardens QBO upstream error handling: the QBO client captures the Intuit `intuit_tid` trace id and uses status-based error handling (429 retry with exponential backoff, errors carry status + tid + QBO Fault message). A new `backend/src/modules/qbo-error.js` maps QBO upstream errors to HTTP 502 (429 passed through), deliberately avoiding emitting a QBO-side 401 as an app-level 401. It is wired into the ai, checkpoint, company, and explore routes; seed/generate/issuepacks are intentionally unchanged because they run QBO in background jobs surfaced via status/log. Frontend error surfacing was hardened with new toast/alert UI. See `phase-4-hardening-plan.md` for hardening detail.

| Phase | Current status | Evidence | Remaining work |
|------|----------------|----------|----------------|
| Phase 0 | Completed | `scripts/phase-0/`; tracked summary in `phase-0-api-validation-spike.md`; local artifacts in `artifacts/phase-0/` | Webhook/CDC validation remains deferred |
| Phase 1 | Implemented in source | auth, QBO connection, company profile, seeding, dashboard, audit routes/pages are present | Fresh end-to-end QBO-connected verification |
| Phase 2 | Implemented in source | generation, checkpoints, explorer, issue packs, run models/routes/pages are present | Fresh QBO-connected acceptance testing; clarify BullMQ strategy |
| Phase 3 | Implemented in source | AI provider, orchestrator, tools, notes, sessions, plans, SSE route, AI command center are present | Acceptance testing, lint cleanup, dependency audit fixes, QBO safety review |
| Phase 4 | Not implemented | no continuous activity/polish phase implementation identified; plan now documented in `phase-4-hardening-plan.md` | Build hardening backlog after Phase 1-3 verification |

Current non-mutating checks:

- `npm run build --workspace=frontend` passes.
- Backend syntax check over `backend/src/**/*.js` passes.
- `npm run lint --workspace=frontend` fails on current AI UI lint debt.
- `npm audit --omit=dev --json` reports 14 production vulnerabilities: 2 high, 12 moderate.

No backend server start, QBO OAuth flow, seeding, generation, issue pack run, checkpoint creation, or AI plan execution was performed during this review.

---

## 1. Planning assumptions

- This product operates only on internal, support-owned QBO test companies.
- `prd.md` remains the product contract; this file translates it into execution sequencing.
- Phase 0 was the hard gate and has completed with a proceed decision plus scope changes.
- Phase 1-3 have source code present, but product-complete status depends on fresh runtime and QBO-connected acceptance testing.
- Phase 4 should remain a hardening backlog until the existing source surfaces are verified.
- If time gets tight, defer the items already called out in `prd.md`: continuous activity, replay, raw API view, custom issue pack authoring, and AI guarded auto-execution.

---

## 2. Program goals

- Give each support user one realistic QBO Canada flagship company they can use for reproduction work.
- Reduce manual setup time for support investigations.
- Make inspection, explanation, and evidence capture first-class workflows.
- Introduce AI only after deterministic internal tools and investigation surfaces are reliable.

---

## 3. Phase summary

| Phase | Duration | Primary goal | Current status |
|------|----------|--------------|----------------|
| Phase 0 | 1-2 weeks | Validate API feasibility | Completed |
| Phase 1 | 3-4 weeks | Ship the foundation | Implemented in source; needs fresh E2E verification |
| Phase 2 | 4-5 weeks | Make the company feel real and inspectable | Implemented in source; needs QBO-connected acceptance testing |
| Phase 3 | 3-4 weeks | Add controlled AI workflows | Implemented in source; needs acceptance testing and hardening |
| Phase 4 | 2-3 weeks | Harden for daily internal use | Not implemented |
| Future | Post-MVP | Expand breadth | Payroll, multi-company, training, sharing, packaging |

---

## 4. Phase gates

### Gate A: Phase 0 -> Phase 1

Phase 1 starts only if the team can prove:

- AR and AP transaction chains can be created and read back with enough fidelity.
- OAuth, realm targeting, and token refresh work reliably against internal test companies.
- Required entity volume is practical within rate limits.
- Sales-order and other Advanced-only assumptions are either validated or explicitly removed from MVP scope.
- Change tracking direction is decided: webhooks, CDC, or both.

**Required artifacts:**

- `phase-0-api-validation-spike.md` execution results
- capability matrix by entity/workflow
- gap report with recommended product scope changes
- demo scripts and sample logs

### Gate B: Phase 1 -> Phase 2

Phase 2 starts only if the team can prove:

- A user can sign in, connect one company, assess it, seed it, and view status end to end.
- Master data seeding is idempotent.
- Audit events are recorded for all mutations.
- The team can reliably target the right realm on every operation.

**Required artifacts:**

- working internal demo
- seeded company examples
- Phase 1 defect list and carryover decisions

### Gate C: Phase 2 -> Phase 3

Phase 3 starts only if the team can prove:

- Investigation tools are already useful without AI.
- At least 3 issue packs are stable and reproducible.
- Checkpoints and diffs are trustworthy enough to support evidence-based explanations.

### Gate D: Phase 3 -> Phase 4

Phase 4 starts only if the team can prove:

- AI plans map cleanly to deterministic tool contracts.
- Confirmed execution is auditable and safe.
- Support notes produced by the system are useful in real internal workflows.

---

## 5. Phase details

### Phase 0: API validation spike

**Objective**

Validate the Intuit API assumptions that the product depends on before committing to full implementation.

**In scope**

- OAuth and realm targeting proof
- transaction-chain creation and read-back
- date backdating behavior
- master data volume and throttling behavior
- webhook and CDC validation
- sales-order coverage validation

**Out of scope**

- production UI
- full application auth
- polished architecture
- AI workflows

**Exit criteria**

- documented pass/fail result for every spike hypothesis
- clear recommendation to proceed, re-scope, or stop

### Phase 1: foundation

**Objective**

Ship the minimum end-to-end product slice that lets one internal user connect and prepare a flagship company.

**In scope**

- auth and role framework
- per-user QBO connection
- company profile and capability assessment
- master data seeding
- dashboard and onboarding basics
- audit-log foundation

**Out of scope**

- realistic history generation beyond smoke coverage
- checkpoints and diff
- issue injection
- AI orchestration
- continuous activity

**Exit criteria**

- user can sign in, connect one internal support-owned company, seed baseline data, and see results

### Phase 2: reality and inspection

**Objective**

Turn the seeded flagship company into a realistic and inspectable support lab.

**In scope**

- historical activity generation
- checkpoint creation and diff
- entity explorer
- transaction-chain inspection
- timeline view
- initial issue packs and run history

**Exit criteria**

- user can generate realistic history, inject a known issue, and inspect the resulting discrepancy

### Phase 3: AI layer

**Objective**

Add controlled AI assistance on top of deterministic tools.

**In scope**

- natural-language planning
- confirmed execution flow
- discrepancy explanation
- support note generation
- AI session logging

**Exit criteria**

- user can request a scenario in natural language, approve the plan, execute it, and receive evidence-based notes

### Phase 4: polish and continuous activity

**Objective**

Make the product usable for repeated day-to-day internal support work.

Detailed plan: `phase-4-hardening-plan.md`.

**In scope**

- UX refinements from user feedback
- performance tuning
- supervisor-focused features
- optional continuous activity engine

**Exit criteria**

- early internal users can rely on the tool without frequent engineering intervention

### Future phases

**Candidates**

- payroll workflows
- multi-company-per-user support
- scenario sharing
- training or challenge mode
- QBOA-oriented workflows
- commercial packaging

---

## 6. Cross-phase dependency map

- OAuth, token handling, and company targeting are foundational for every phase.
- The capability matrix from Phase 0 shapes seeding, issue packs, and investigation tooling.
- Audit logging starts in Phase 1 and expands in every later phase.
- Checkpoints and diff from Phase 2 are prerequisites for strong AI explanations in Phase 3.
- Continuous activity should not ship until the team trusts seeding, inspection, and audit visibility.

---

## 7. Scope control rules

- Do not expand beyond internal support-owned QBO test companies in MVP.
- Do not build payroll in parallel with the core support-lab flows.
- Do not let AI bypass deterministic internal tools.
- Do not treat replay as true restore.
- Do not add multi-company breadth before the single-company workflow is clearly useful.

---

## 8. Recommended planning artifacts

- `prd.md` - product contract
- `roadmap.md` - phase sequencing and gates
- `phase-0-api-validation-spike.md` - execution plan for the hard gate
- `phase-1-foundation-plan.md` - first implementation phase plan
- `phase-4-hardening-plan.md` - gated hardening/polish plan for daily internal use

Optional later:

- `phase-2-reality-and-inspection-plan.md`
- `ai-tool-contracts.md`
- `issue-pack-catalog.md`

---

## 9. Near-term next steps

1. Fix current frontend lint errors and warnings in the AI UI.
2. Address production dependency audit findings, especially Axios and Anthropic SDK advisories.
3. Run Phase 1 end-to-end verification against the intended sandbox/test company.
4. Run Phase 2 acceptance tests: generation, checkpoint create/list/diff, explorer, issue packs, audit.
5. Run Phase 3 acceptance tests: AI config, chat/session flow, plan approval/execution, SSE, support notes, audit.
6. Build the Phase 4 hardening backlog from the verified defects rather than adding new scope first.
7. With production API access now unlocked, decide the path to connecting a real company: set up a public HTTPS redirect URI (tunnel or deploy), then switch `QBO_ENVIRONMENT` to production for that connection. Sandbox remains the default until then.
