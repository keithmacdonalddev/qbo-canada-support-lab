# Phase 0 API Validation Spike

**Status:** Completed - historical API validation
**Duration:** 1-2 weeks  
**Source of truth:** `prd.md`

---

## Current Result

Phase 0 is complete. The repo contains Phase 0 scripts under `scripts/phase-0/` and local result artifacts under `artifacts/phase-0/`.

Summary from the completed spike:

- Decision: proceed to Phase 1.
- Tested 39 API hypotheses; 37 passed and 2 failed.
- OAuth, token refresh, realm targeting, master data volume, backdating, AR chains, AP chains, read-back fidelity, and rate-limit assumptions passed.
- Sustained mixed read/write throughput reached about 2.2 operations per second with zero 429 responses in the recorded test.
- Purchase orders failed through the tested API path and should not be part of MVP AP chains.
- Sales orders were not exposed as a QBO API entity in the tested environment; use estimates to invoices instead.
- Webhook delivery reliability and CDC polling were not tested in Phase 0 and remain follow-up validation items.

Important: `artifacts/` is gitignored in this repo, so tracked docs should preserve the essential Phase 0 conclusions.

Follow-up (2026-05-28): the rate-limit and backoff findings validated here are now implemented in the production backend QBO client — 429 responses are retried with exponential backoff (clamped to 60s/attempt, max 5 retries) on branch `fix/qbo-client-error-handling`. Separately, production API access has since been unlocked at the Intuit Developer portal (app "IN PRODUCTION"); Phase 0 itself ran against sandbox/test companies and its conclusions are unchanged.

---

## 1. Purpose

This spike is the hard go/no-go gate for the QBO Support Lab. Its job is to validate whether the Intuit developer surface can support the transaction creation, inspection, and change-tracking behavior that the product depends on.

This spike is not a prototype of the full product. It is a targeted technical validation exercise.

---

## 2. Spike outcome

At the end of Phase 0, the team must be able to answer:

- Can we build the core AR and AP transaction chains we need?
- Can we read those chains back with enough fidelity to support inspection tooling?
- Can we operate at the required volume without unacceptable throttling?
- Can we target and mutate internal support-owned QBO test companies safely?
- Are webhooks and/or CDC good enough for later checkpoint, diff, and timeline features?
- Which PRD assumptions must be removed or downgraded before Phase 1?

---

## 3. Scope

### In scope

- OAuth 2.0 connection and token refresh
- realm identification and per-company targeting
- entity creation and read-back
- linked transaction behavior
- date backdating behavior
- volume and rate-limit behavior
- change tracking behavior via webhooks and CDC
- sales-order validation
- gap documentation and recommendations

### Out of scope

- frontend application flows
- user auth beyond whatever is needed to run the spike
- final data model
- AI integration
- polished tooling
- long-term production observability

---

## 4. Test environment and prerequisites

### Required companies

- 2 internal support-owned QBO Advanced Canada test companies minimum
- 1 cleaner baseline company for deterministic setup tests
- 1 messier company with existing data for capability and coexistence tests

### Required access

- active Intuit app registration
- working redirect URI and OAuth setup
- API scopes required for the target entities
- webhook configuration endpoint
- access to CDC or equivalent read strategy if available

### Required local setup

- Node.js runtime
- script runner and env management
- secure local storage for test tokens and secrets
- logging directory for request, response, and result artifacts

---

## 5. Working assumptions to validate

| ID | Hypothesis | Why it matters |
|----|------------|----------------|
| H1 | AR chains can be created programmatically | Needed for realistic customer issue reproduction |
| H2 | AP chains can be created programmatically | Needed for purchasing and payables scenarios |
| H3 | Historical backdating is allowed enough for realism | Needed for seeded company maturity |
| H4 | Master data volume is practical | Needed for non-toy flagship companies |
| H5 | Read-back fidelity is strong enough for forensics | Needed for explorer, diff, and AI explanation |
| H6 | Webhooks and/or CDC can support change tracking | Needed for timelines and checkpoints |
| H7 | Rate limits are manageable with queueing | Needed for seeding and later generation |
| H8 | Sales-order assumptions are valid or removable | Needed to avoid false scope promises |

---

## 6. Validation matrix

### 6.1 OAuth, targeting, and token lifecycle

**Tests**

- AUTH-01: complete OAuth flow against each target company
- AUTH-02: store and reuse company context and realm ID
- AUTH-03: force token refresh path and verify recovery
- AUTH-04: verify that every request can be tied back to the intended company

**Success criteria**

- each company can be connected reliably
- realm targeting is explicit and stable
- refresh behavior works without manual token intervention

### 6.2 AR chain creation

**Tests**

- AR-01: create estimate
- AR-02: convert or recreate as invoice as supported
- AR-03: apply partial payment
- AR-04: create credit memo
- AR-05: apply remaining payment
- AR-06: read back full chain and confirm linked references

**Success criteria**

- chain can be created in a realistic order
- linked entities can be discovered through read-back
- line-level and tax details remain available after read-back

### 6.3 AP chain creation

**Tests**

- AP-01: create purchase order if supported
- AP-02: create bill
- AP-03: apply bill payment
- AP-04: create vendor credit
- AP-05: read back full chain and confirm linked references

**Success criteria**

- at least one realistic AP chain can be created end to end
- any missing API support is documented with a proposed MVP workaround

### 6.4 Historical backdating

**Tests**

- DATE-01: create transactions backdated 30 days
- DATE-02: create transactions backdated 90 days
- DATE-03: create transactions backdated 180+ days
- DATE-04: confirm report behavior and timestamps after read-back

**Success criteria**

- enough backdating flexibility exists to simulate a mature company
- any creation-date limits are documented clearly

### 6.5 Master data volume and baseline seeding

**Tests**

- VOL-01: create 50+ customers
- VOL-02: create 20-40 vendors
- VOL-03: create 40-80 items
- VOL-04: create 40-60 chart-of-account records as allowed
- VOL-05: re-run seed logic and confirm idempotent behavior design is feasible

**Success criteria**

- volume can be achieved without account instability
- the expected flagship-company baseline is practical
- duplicate avoidance strategy is credible

### 6.6 Read-back fidelity for forensics

**Tests**

- READ-01: fetch created entities with linked references
- READ-02: fetch line items, tax fields, and custom fields where applicable
- READ-03: confirm enough data exists to reconstruct transaction-chain views
- READ-04: confirm raw API responses are intelligible enough for troubleshooting surfaces

**Success criteria**

- the team can reconstruct relationships needed for explorer and diff tooling
- major blind spots are identified before Phase 1

### 6.7 Change tracking

**Tests**

- CHG-01: mutate known entities and observe webhook delivery
- CHG-02: test event delay and missed-event behavior
- CHG-03: evaluate CDC or polling fallback for recent changes
- CHG-04: compare webhook payload completeness to read-back requirements

**Success criteria**

- a recommended change-tracking strategy is selected
- known reliability gaps and compensating controls are documented

### 6.8 Rate limits and throughput

**Tests**

- RL-01: burst-create master data
- RL-02: sustained create/read mix over a realistic seeding window
- RL-03: measure backoff and retry behavior after throttling
- RL-04: identify user-visible wait times that later UI must account for

**Success criteria**

- the team understands practical throughput, not just published limits
- queueing and pacing recommendations exist for later phases

### 6.9 Sales orders and Advanced-only assumptions

**Tests**

- SO-01: determine whether sales orders can be created via API
- SO-02: determine whether sales orders can be read with useful fidelity
- SO-03: identify any similar Advanced-only features that are UI-only

**Success criteria**

- the product team can either keep or remove sales-order assumptions with confidence

---

## 7. Deliverables

At the end of the spike, the team should produce:

- a working script set for the validated scenarios
- request and response logs for key flows
- an API capability matrix by workflow and entity
- a gap report with product recommendations
- a short go/no-go decision memo

Suggested artifact set:

- `artifacts/phase-0/capability-matrix.md`
- `artifacts/phase-0/gap-report.md`
- `artifacts/phase-0/results-summary.md`
- `scripts/phase-0/` for repeatable validation scripts

---

## 8. Recommended script breakdown

- `connect-company` - obtain and validate OAuth connection
- `seed-master-data` - create baseline customers, vendors, items, and accounts
- `create-ar-chain` - run the core receivables scenario
- `create-ap-chain` - run the core payables scenario
- `read-transaction-chain` - fetch created data and print linked relationships
- `exercise-rate-limits` - run controlled throughput tests
- `exercise-change-tracking` - mutate records and capture webhook or CDC behavior
- `validate-sales-order` - prove or reject sales-order assumptions

Each script should:

- accept explicit target-company input
- log start and end timestamps
- record request intent and result status
- write findings to structured output
- fail loudly on partial or ambiguous results

---

## 9. Execution plan

### Day 1

- confirm access, companies, OAuth setup, and local env
- complete AUTH tests
- capture setup blockers immediately

### Day 2

- execute AR chain tests
- document missing links or unsupported transitions

### Day 3

- execute AP chain tests
- validate backdating behavior

### Day 4

- run master-data and rate-limit tests
- identify realistic throughput expectations

### Day 5

- run webhook and CDC tests
- validate sales-order assumptions
- draft capability matrix and gap report

### Buffer days

- repeat failed runs
- verify workarounds
- finalize go/no-go recommendation

---

## 10. Decision rules

### Proceed to Phase 1 if

- AR chain creation is viable
- at least one realistic AP chain is viable
- read-back fidelity supports future investigation tooling
- rate limits look manageable with background jobs and pacing
- major unsupported areas are narrow and easy to scope around

### Re-scope before Phase 1 if

- a target workflow is partially supported but still usable with narrower scenarios
- sales-order support is missing and needs to be removed from MVP language
- webhook reliability is weak and CDC must become the default path

### Stop or redesign if

- core AR or AP flows cannot be created reliably
- entities cannot be read back with enough relationship detail to support forensics
- company targeting is not dependable enough for safe mutation

---

## 11. Reporting format

For each test case, record:

- test ID
- target company
- request summary
- expected result
- actual result
- pass, fail, or partial
- notes and workaround if applicable
- product impact

Use a simple status scale:

- `Pass`
- `Partial`
- `Fail`
- `Blocked`

---

## 12. Exit artifacts required for approval

The spike is complete only when all of the following exist:

- capability matrix with pass/partial/fail across all hypotheses
- gap report with concrete scope recommendations
- documented throughput observations
- documented change-tracking recommendation
- final recommendation: proceed, proceed with re-scope, or do not proceed

---

## 13. Immediate handoff into Phase 1

If the spike passes, it must hand off:

- supported entity and workflow list
- unsupported or risky features to remove from Phase 1
- recommended seeding baseline sizes
- recommended change-tracking approach
- recommended queueing and backoff strategy
- known safety constraints for operating on internal support-owned companies
