# Continual Test Data Lab Rebuild Plan

> - **Status:** Draft for rigorous product, safety, and design review
> - **Decision state:** Pending approval; this document does not authorize implementation or live QBO changes
> - **Prepared:** 2026-08-08
> - **Target repository:** `C:\Projects\qbo` on `main`
> - **Product context:** One connected QuickBooks Online Advanced Canada company
> - **Public product name:** Test Data Lab (the public UI must not use protected brand names or abbreviations)
> - **Primary outcome:** Maintain a large, believable, continually evolving Canadian business dataset that exercises broad QBO feature and report coverage

## 1. Executive decision

The application will be rebuilt around one primary job:

> **Create, understand, maintain, and safely operate a flagship QBO Advanced Canada company whose data looks and behaves like an ongoing real business.**

The flagship company must contain much more than customers, vendors, items, and a handful of accounting chains. It must develop coherent operations over time: a deliberate chart of accounts, customers and vendors with recognizable behaviour, multiple product and service lines, Canadian taxes, banking activity, inventory where supported, projects or classes where supported, month-end adjustments, reconciliations, budgets, users and roles, and enough linked history to make the widest practical set of QBO reports useful.

Support agents will reproduce customer problems manually in that company. The app's near-term job is to make the company realistic, observable, navigable, maintainable, and safe to operate. It is not to automate support reasoning.

This corrects the current product emphasis:

| Capability | New priority | Decision |
|---|---:|---|
| Believable flagship business | P0 | The product foundation |
| Broad QBO feature coverage | P0 | Measured through a capability registry |
| Broad, meaningful report coverage | P0 | Measured through report prerequisites and assertions |
| Continual business activity | P0 | Durable calendar-driven operations, not one-time random generation |
| View and manage QBO data | P0 | Full catalog for supported entities; governed mutations |
| View and manage application data | P0 | First-class administration surfaces |
| Reconciliations and period-close work | P0 | A core recurring business cycle, including manual evidence where the API cannot perform the official QBO action |
| Users and roles | P0 | Both application authorization and tracked QBO-company role coverage |
| Manual support reproduction | P0 | The intended near-term support workflow |
| Checkpoints and diffs | Deferred | May return if they solve a demonstrated problem |
| Existing issue packs | Experimental/retired from primary navigation | The current five examples are not representative enough to drive the product |
| AI investigation and notes | Future | No core dependency; no new AI write authority |

The rebuild must be real product work, not a reskin. The UI/UX overhaul is part of the same delivery program and must expose the new operating model. A polished shell over the present narrow data model would fail this plan.

## 2. What this plan supersedes

Once approved, this plan becomes the product-priority source of truth for the rebuild. Existing PRD and phase documents remain useful historical material, but any statement that makes issue packs, checkpoints, diffs, or AI the near-term centre of the application is superseded.

Approval of this plan would authorize a later documentation-alignment change to:

- update `prd.md` and `roadmap.md`;
- revise the repository description and product-facing terminology;
- mark earlier phase plans as historical where they conflict;
- keep implementation details that remain technically useful without retaining their former priority.

Those documentation changes are not included in this draft-plan change.

## 3. Authority and safety boundary

This is a planning artifact. It does **not** authorize any of the following:

- starting or restarting the backend or frontend;
- connecting or reconnecting OAuth;
- calling a QBO mutation route;
- writing to the connected production company;
- creating, updating, or deleting MongoDB records;
- running seed, generation, issue-pack, checkpoint, or AI execution jobs;
- changing stored credentials, tokens, provider keys, or environment settings;
- deleting legacy QBO data or local application records;
- adopting an automatic production schedule before its separate approval gate.

Every future phase that mutates QBO must identify the exact realm, company display name, environment, operation budget, and rollback/recovery approach before execution. The currently connected company is production, so sandbox validation and explicit production confirmation are mandatory gates, not suggestions.

## 4. Evidence used to create this plan

### 4.1 Current source, not product claims

This plan is based on direct inspection of the current implementation. The most important evidence is:

| Current source | What it proves now | Product implication |
|---|---|---|
| `backend/src/routes/seed.js` | Fixed creation of 50 customers, 30 vendors, and 50 service items; it queries an existing income account and does not build a business-specific chart of accounts | Seeding is generic volume, not a business blueprint |
| `backend/src/modules/generation-engine.js` and `backend/src/routes/generate.js` | Random AR/AP chains and journal entries, capped at 12 months and 60 chains per month, launched manually | No persistent business clock, deterministic replay, forward schedule, or broad transaction lifecycle |
| `backend/src/routes/explore.js` | Read-only search across 13 hardcoded entity types with a 100-row request cap | Not a complete QBO data-management surface |
| `backend/src/modules/checkpoint.js` | Snapshot coverage is a fixed subset of QBO entities | Checkpoints cannot stand in for broad feature or report coverage |
| `backend/src/modules/issuepack-seeder.js` | Exactly five built-in packs with hardcoded actions | Current issue packs are examples, not a support-issue system |
| `backend/src/routes/company.js` and `frontend/src/pages/Dashboard.jsx` | The primary snapshot is a small set of counts and connection health | The UI cannot explain business realism, coverage, continuity, or report health |
| `backend/src/server.js` route registration | No report, reconciliation, capability-registry, business-calendar, or general app-data administration route exists | The core operational model is not implemented yet |
| `backend/src/models/User.js`, `backend/src/routes/auth.js`, and `backend/src/middleware/auth.js` | Local roles are only `agent` and `supervisor`; registration always creates `agent`; role middleware exists but is not broadly applied | Neither local authorization nor QBO-company user/role coverage is complete |
| `backend/src/server.js` | Startup seeds issue-pack definitions and marks interrupted jobs/plans failed | Startup currently performs database writes and long operations are not resumable |
| `frontend/src/App.jsx` and `frontend/src/components/Layout.jsx` | AI, checkpoints, and issue packs remain first-class routes; the shell is fixed desktop navigation | Information architecture still expresses the displaced product intent |
| `frontend/src/index.css` and `frontend/src/components/ui/` | Tailwind/shadcn-era tokens and basic primitives exist, but old and new token families coexist and the system lacks a comprehensive responsive/state/accessibility specification | Reuse the viable foundation, but consolidate it into a governed design system |

This is not a claim that the present code has no value. OAuth, QBO client handling, production confirmation, audit records, basic runs, protected routes, explorer queries, and UI primitives are useful foundations. The problem is that those foundations currently serve a much narrower product.

### 4.2 Apple design-systems research package

The complete research package under `C:\Projects\qbo-escalations\docs\research\apple-design-systems` was reviewed:

- `apple-design-systems-research.md`;
- `apple-design-systems-visual.html`;
- `build_research_artifacts.py`;
- `apple-design-systems.md`;
- `apple-design-systems.html`;
- `apple-design-systems.pdf` (all 30 rendered pages).

The plan transfers the research's method, not Apple's brand surface. It does not copy proprietary assets, SF Symbols, platform-only materials, or a phone-first interaction model into a dense web operations application.

The governing synthesis is:

> **Unified, not uniform.** Shared principles and semantic language should adapt to the user's context, input precision, task duration, information density, and cost of error.

For this product, that means a pointer-and-keyboard-first desktop workspace with responsive supervisory access on smaller screens. It does not mean oversized touch controls, hidden commands, glass on every card, or animation added for decoration.

## 5. Product definition

### 5.1 Product statement

Test Data Lab is a local control and visibility application for operating a flagship QBO Advanced Canada test company as a realistic, continual business.

It enables an authorized operator to:

1. define what the business is supposed to look like;
2. measure which QBO features and reports are represented;
3. create and maintain coherent master data;
4. backfill realistic historical activity;
5. keep the business moving forward on a controlled calendar;
6. inspect and safely manage supported QBO data;
7. manage the application's own data and permissions;
8. complete recurring close and reconciliation work;
9. manually reproduce support problems in a company whose surrounding data is credible.

### 5.2 Product mental model

```text
Business blueprint
      ↓
Coverage requirements ───→ QBO capability and report registry
      ↓                                  ↓
Business calendar ───────→ Previewed operation plan
      ↓                                  ↓
QBO records ←──────────── Governed execution and audit
      ↓                                  ↓
Reports and reconciliations ← Evidence and validation
      ↓
Manual support reproduction in the flagship company
```

### 5.3 Near-term user workflow

The normal support workflow remains intentionally manual:

1. A support agent receives a customer complaint.
2. The agent confirms the flagship company's current state and coverage.
3. The agent manually reproduces the condition in QBO using the same UI and controls a customer would use.
4. The agent uses Test Data Lab to inspect surrounding QBO records, application-created records, activity history, and report effects.
5. The agent records their own support result using existing team practices.

The app may make evidence easier to find. It must not force checkpoints, issue packs, diffs, or AI into this path.

### 5.4 Non-goals for the rebuild

- Replacing QBO's bookkeeping interface.
- Becoming a second general ledger or independent accounting source of truth.
- Cloning every QBO field into MongoDB.
- Automating customer support diagnosis.
- Generating artificial transaction volume without a coherent business narrative.
- Claiming feature coverage from the existence of an entity alone.
- Claiming report coverage because a report endpoint returns HTTP 200.
- Building a generic no-code automation platform.
- Running uncontrolled background mutations against production.
- Reproducing Apple's visual identity or using Apple-only conventions that conflict with web accessibility or Windows use.

## 6. Outcome definitions and measurable success

### 6.1 What “realistic” means

A dataset is realistic only when all of the following are true:

- entities belong to recognizable customer, vendor, product, employee, account, tax, and operational segments;
- transaction timing reflects business cadence, seasonality, terms, late payments, partial payments, deposits, returns, credits, purchases, inventory movement, payroll-derived journal activity where direct payroll data is unavailable, and month-end close;
- linked records reconcile to a coherent story rather than isolated random documents;
- opening balances and historical activity lead to explainable current balances;
- tax treatment is internally consistent with Canadian provinces and the configured company;
- balances, aged receivables/payables, cash, sales, expenses, inventory, and profitability move through credible ranges;
- the same business identity persists month to month;
- exceptional states exist in realistic proportions but do not overwhelm normal operations;
- data provenance distinguishes app-managed records, manually created records, imported fixtures, and unknown/external records.

### 6.2 What “continual” means

Continual does not mean an unbounded cron task. It means:

- the company has a persistent business date and generation cursor;
- completed activity advances that cursor without creating gaps or overlaps;
- the operator can see what period is complete, due, overdue, planned, running, blocked, or failed;
- work can resume safely after interruption;
- deterministic inputs allow a failed operation to be understood and replayed without blindly duplicating records;
- the company can be advanced daily, weekly, monthly, or through a controlled catch-up operation;
- optional automation is separately enabled, budgeted, observable, and stoppable;
- no automatic QBO mutation occurs merely because the backend starts.

### 6.3 What “feature coverage” means

Feature coverage is a maintained claim with evidence. Every relevant QBO Advanced Canada capability must be placed in exactly one state:

- **Covered:** represented by realistic data and verified evidence;
- **Partially covered:** some prerequisites or variants are absent;
- **Manual-only:** important to the lab but not safely available through the API; a manual operating procedure and evidence record exist;
- **Unavailable:** not supported in the connected product, region, entitlement, or API;
- **Deferred:** intentionally outside the approved release;
- **Unknown:** discovery incomplete; allowed during discovery, forbidden at release.

Existence of a route or object is not coverage. Coverage requires prerequisites, representative variants, a repeatable verification method, and an owner.

### 6.4 What “report coverage” means

A report is meaningful when:

- the company contains the accounts and transactions required to populate it;
- it contains at least two relevant periods so comparisons are meaningful where supported;
- applicable dimensions such as customer, vendor, product/service, class, location, project, tax code, and account have enough variation to exercise grouping and filtering;
- expected totals or relationships can be asserted within documented tolerances;
- zero, sparse, stale, permission-blocked, unsupported, and API-error results are distinguished;
- the operator can open the equivalent report in QBO and understand why its numbers exist.

### 6.5 Proposed release metrics

These are proposed approval targets. Phase 1 discovery must replace estimates with a signed capability catalog.

| Measure | Minimum release gate |
|---|---:|
| Relevant QBO capabilities classified | 100%; no `Unknown` entries |
| Tier 1 support-critical capabilities covered or manual-only with evidence | 100% |
| In-scope API-addressable capabilities covered | At least 85%, with every exception approved |
| Critical report catalog covered | 100% |
| Remaining in-scope report catalog covered | At least 80%, with explicit exclusions |
| Continual operation gaps or overlapping business dates | 0 |
| Duplicate app-managed QBO records after idempotent replay tests | 0 |
| Mutations lacking realm/environment/operator/idempotency/audit attribution | 0 |
| Unrecoverable long-running operation states | 0 in tested failure matrix |
| Critical WCAG 2.2 AA violations in approved workflows | 0 |
| Keyboard-blocking workflow defects | 0 |
| Supported viewport workflow blockers | 0 |
| Tier 1 destructive action without preview and explicit confirmation | 0 |

Numeric data-volume goals must be set only after rate-limit, QBO performance, and report-performance experiments. “Large” must be a tested operating profile, not a vanity count.

## 7. People, responsibilities, and authorization

### 7.1 Primary personas

| Persona | Main job | Authority |
|---|---|---|
| Lab owner | Defines the flagship business, approves coverage, production operations, schedules, roles, and destructive changes | Full administrative authority |
| Lab operator | Previews and runs approved data operations, monitors continuity, manages permitted records, completes run evidence | Scoped create/update authority; no connection or policy administration |
| Support agent | Manually reproduces issues and inspects records/reports | Read access plus narrowly approved manual lab activity |
| Reviewer/auditor | Verifies coverage, reports, operations, and audit evidence | Read-only, including historical records |

### 7.2 Local roles versus QBO roles

The system must not conflate two different concerns:

- **Application roles** govern what a signed-in user may do through Test Data Lab.
- **QBO company users and roles** are features of the connected QBO company and part of the flagship company's coverage story.

Phase 1 must verify the current official API and product capabilities for QBO users and roles. If user/role administration is not available through the accounting API, Test Data Lab will track expected users, role assignments, verification dates, evidence, and a manual QBO procedure. It must not pretend it can manage an unsupported feature.

### 7.3 Proposed application permissions

Permissions should be capability-based and server-enforced rather than inferred from page visibility:

- `company.read`
- `blueprint.read`, `blueprint.manage`
- `coverage.read`, `coverage.approve`
- `qbo_data.read`, `qbo_data.create`, `qbo_data.update`, `qbo_data.void`, `qbo_data.delete`
- `operations.preview`, `operations.execute_sandbox`, `operations.execute_production`, `operations.stop`
- `schedule.read`, `schedule.manage`, `schedule.enable_production`
- `reports.read`, `reports.validate`
- `reconciliation.read`, `reconciliation.manage`
- `app_data.read`, `app_data.manage`
- `users.read`, `users.manage`
- `connections.read`, `connections.manage`
- `audit.read`
- future permissions for experimental issue scenarios and AI, disabled by default.

The frontend may hide unavailable controls for clarity, but every protected operation must be denied by the server when permission is absent.

## 8. Coverage architecture

### 8.1 QBO capability registry

Create a versioned registry that describes the exact support target rather than scattering entity names across routes.

Each capability entry should include:

- stable capability key;
- human name and plain-language purpose;
- domain: company, sales, expenses, banking, inventory, projects, tax, accounting, reporting, users, or administration;
- QBO Canada/Advanced applicability;
- API read/create/update/delete/void support as separately verified facts;
- UI-only/manual requirements;
- required preferences or entitlements;
- prerequisite master data and transactions;
- representative variants;
- linked reports;
- evidence method;
- coverage tier and current state;
- last verified date and source;
- known limitations and approved exclusions.

The registry must be data, not a hardcoded navigation list. The same record should drive coverage screens, blueprint validation, operation planning, and release evidence.

### 8.2 Initial discovery domains

Phase 1 must inventory at least these domains without assuming every item is API-writable:

- company settings, fiscal year, closing date, preferences, numbering, terms, and currencies;
- chart of accounts and account subtypes;
- customers, sub-customers, contacts, tax details, terms, projects/jobs, and opening states;
- vendors, contacts, terms, tax identifiers, expenses, bills, credits, and payments;
- products and services, categories, bundles where applicable, inventory items, quantities, valuation accounts, price rules, and purchasing details;
- estimates, delayed charges/credits if supported, invoices, sales receipts, refunds, credit memos, payments, deposits, and unapplied states;
- purchase orders, bills, expenses, cheques, credit-card activity, bill payments, and vendor credits;
- bank and credit-card accounts, transfers, deposits, cleared status, statements, and reconciliations;
- classes, locations, projects, departments or other Advanced dimensions actually enabled in the company;
- sales tax agencies, codes, rates, filings, and multi-province behaviour;
- journal entries, recurring transactions, budgets, retained earnings, and period close;
- time tracking, employees/contractors, payroll availability, and safe payroll-summary/manual coverage;
- multicurrency and exchange effects if enabled and safe;
- users, custom roles, and access boundaries;
- QBO reports exposed through the API and important UI-only reports;
- attachments, custom fields, tags, and other Advanced features where available.

The output is not a wish list. Each row must state what the connected company and current API can actually support.

### 8.3 Coverage tiers

- **Tier 1 — business spine:** without it the company is not credible or core reports fail.
- **Tier 2 — breadth:** expands support coverage across significant QBO features and variations.
- **Tier 3 — edge coverage:** useful uncommon cases, performance cases, and regional variations.
- **Manual-only critical:** required for real support work but cannot be safely automated.
- **Deferred:** explicitly outside the rebuild release.

Tier assignment requires a written rationale. It cannot be used to hide difficult foundational work.

## 9. Flagship business blueprint

### 9.1 Business concept

Use one coherent Canadian company with multiple operating lines instead of unrelated fake entities. The final profile is a user decision, but the recommended starting shape is:

- a service and project division for estimates, time/project tracking, invoicing, deposits, retainers, reimbursable expenses, and profitability;
- a small wholesale/inventory division for purchase orders, inventory receipt, sales, cost of goods sold, adjustments, returns, and stock reporting;
- a recurring-service line for scheduled invoices, deferred/periodic revenue patterns where supportable, late payments, credits, and customer statements;
- operations across more than one Canadian tax jurisdiction, introduced only after Canadian tax correctness is validated.

This gives the company a reason to use QBO Advanced breadth while remaining one understandable business.

### 9.2 Blueprint contents

The versioned blueprint should define:

- legal/display identity and public-safe naming;
- fiscal year, opening date, base currency, locale, and tax jurisdictions;
- business divisions and their revenue/cost models;
- chart-of-accounts template and intended report role for every account;
- customer segments, lifecycles, terms, credit behaviour, and regional distribution;
- vendor segments, purchasing cadence, terms, and tax treatment;
- products, services, inventory, categories, pricing, purchasing, and margin bands;
- classes, locations, projects, custom fields, and other dimensions;
- bank, credit-card, loan, tax, payroll-clearing, equity, and suspense accounts;
- staff personas and expected QBO access roles;
- month-end, quarter-end, year-end, tax, budget, and reconciliation calendar;
- normal transaction distributions and documented exception rates;
- report targets and their prerequisites;
- volume profile and rate-limit budget;
- deterministic generation seed and blueprint version.

### 9.3 Data profiles

The system should support named operating profiles rather than a free-form “transactions per month” slider:

| Profile | Purpose | Initial direction |
|---|---|---|
| Development | Fast sandbox verification and UI development | Small but complete entity graph |
| Flagship | Normal long-lived support company | Plan around 36 coherent historical months (two complete fiscal years plus the current year), then ongoing activity; confirm against measured limits |
| Scale | QBO/app performance validation | Volume determined by Phase 1 experiments and explicit approval |

The final entity and transaction counts remain undecided until measured. Every profile must preserve the same business rules; only volume and selected breadth may change.

### 9.4 Realism rules

Randomness must be seeded and constrained by the blueprint. Examples:

- customer demand follows segment, season, weekday, and division;
- prices come from products/services, not arbitrary amounts;
- line items, tax codes, classes, locations, projects, accounts, and customers are compatible;
- payment timing follows terms and customer behaviour;
- partial, late, over-, and unapplied payments occur at controlled rates;
- vendor purchase timing follows inventory or operating needs;
- inventory cannot be sold or adjusted without a coherent stock story;
- credits and refunds reference plausible original activity;
- deposits contain compatible payments and dates;
- bank and credit-card activity supports reconciliation statements;
- month-end journals have named reasons and reversals where appropriate;
- closing periods are not silently rewritten;
- exceptions are tagged as intentional or unexpected.

## 10. Managed-entity and provenance model

QBO remains the accounting source of truth. MongoDB should store operational control, provenance, coverage, and evidence rather than become a competing ledger.

Every record created or adopted by the app should have a local managed-entity entry containing:

- realm and environment;
- QBO entity type and ID;
- blueprint and operation versions;
- business persona/segment/dimension assignments;
- intended lifecycle state;
- creation operation and step;
- deterministic natural key or idempotency key;
- last observed `SyncToken`/update time where applicable;
- last validation result;
- whether the record is app-created, manually adopted, external, or unknown;
- safe operations allowed for this entity type;
- links to related managed entities and reports.

This registry enables the app to understand what it owns without inserting hidden marker text into every customer-visible QBO field. Any marker strategy must be field-safe, visible in preview, and documented.

The app must tolerate records created directly in QBO. Discovery should classify them; it must not automatically delete, rename, or absorb them.

## 11. Continual business engine

### 11.1 Business calendar

Introduce a `BusinessCalendar` or `SimulationClock` record per connected realm. It is not a replacement for wall-clock time. It records:

- the earliest complete business date;
- the latest complete business date;
- the next period/day due;
- open and closed accounting periods;
- the blueprint version used for each interval;
- required daily, weekly, monthly, quarterly, annual, tax, and reconciliation activities;
- skipped dates, blackout windows, and approved exceptions;
- continuity health and the reason for any gap.

The operator must be able to answer “How current is this company?” from the Overview without opening a job log.

### 11.2 Operation lifecycle

Replace separate seed/generation job concepts with one durable operation model:

```text
Draft → Validated → Previewed → Approved → Queued → Running
                                            ├→ Paused/blocked → Resumable
                                            ├→ Partially completed → Reconcile/retry
                                            ├→ Completed → Verified
                                            └→ Failed/stopped → Recovery decision
```

An operation contains ordered steps. Each step records its inputs, prerequisites, intended QBO calls, per-call idempotency key, attempts, QBO IDs created or changed, Intuit request IDs when available, result, error classification, and next safe action.

### 11.3 Operation types

- bootstrap master data;
- historical backfill by bounded period;
- advance one business day/week/month;
- run month-end close preparation;
- prepare reconciliation activity and evidence;
- fill a named capability/report gap;
- repair a known incomplete app-managed lifecycle;
- validate or refresh QBO/app records without mutation;
- carefully governed entity maintenance actions.

The operation engine is not a generic arbitrary-call executor. Operation types are server-owned, versioned contracts.

### 11.4 Preview and approval

Every mutating operation must produce a preview that states:

- exact company and environment;
- blueprint version and business period;
- entities/actions by type;
- estimated API-call count and rate-limit budget;
- expected report and balance effects;
- accounts, taxes, classes, locations, projects, customers, and vendors affected;
- records that will be created, updated, voided, or deleted;
- prerequisites that passed, failed, or are stale;
- whether the operation touches a closed or reconciled period;
- risks, irreversible effects, and recovery approach.

Production execution requires a fresh server-side preview fingerprint, typed confirmation that includes the company identity, and a permission check. A stale or changed plan fails closed.

### 11.5 Durability and recovery

The engine must support:

- a database-backed lease with expiry and heartbeat;
- one writer per realm unless a proven safe operation is explicitly concurrent;
- resume from the last confirmed step;
- step-level retries only when the failure is classified retryable;
- bounded backoff that respects existing QBO rate-limit handling;
- duplicate detection before retrying ambiguous network failures;
- explicit partially-completed state rather than labeling all interrupted work “failed” at startup;
- stop-after-current-safe-step semantics;
- recovery advice that distinguishes retry, adopt, compensate, skip, and manual review;
- append-only operation event history;
- progress calculated from known steps rather than optimistic counters.

Backend startup may detect interrupted leases, but must not mutate QBO or silently rewrite operation meaning. Recovery decisions belong in a durable recovery service and UI.

### 11.6 Optional scheduling

Scheduling is a later gate within the core rebuild, not part of the initial operation engine release.

When introduced it must have:

- default `disabled` state;
- separate sandbox and production enablement;
- allowed days/times and local timezone;
- maximum records, API calls, money values, and periods per run;
- pre-run read-only drift validation;
- a global kill switch and realm-specific pause;
- no overlapping run;
- visible next-run time and preview summary;
- missed-run policy: wait, catch up one period, or require approval;
- notifications and in-app attention items for blocked/partial runs;
- an automatic pause after repeated failures or material drift.

Automatic production execution should not ship until manually approved production operations have been stable through an agreed evidence period.

## 12. Transaction and lifecycle coverage

The generator must move from isolated random chains to business lifecycles. Each lifecycle has prerequisites, state transitions, expected accounting effects, reports affected, and safe cleanup/recovery guidance.

### 12.1 Sales and receivables

Candidate lifecycle families, subject to Phase 1 capability verification:

- estimate → accepted work → invoice → payment → deposit;
- project/customer job → time or reimbursable cost → invoice → profitability reporting;
- recurring service → scheduled invoice → statement → payment;
- sales receipt → deposit;
- invoice → partial payment → final payment;
- invoice → credit memo → applied credit/refund;
- deposit/prepayment → later application where supported;
- taxable and exempt sales across validated Canadian tax treatments;
- controlled overdue and unapplied states for aging/report coverage;
- multi-line sales across services, products, classes, locations, or projects.

### 12.2 Purchases and payables

- purchase order → item receipt/bill as supported → bill payment;
- operating expense/cheque/credit-card purchase;
- bill → partial payment → final payment;
- bill → vendor credit → application/refund;
- reimbursable/billable expense → customer/project invoice;
- inventory purchase → stock → sale → cost of goods sold;
- recurring vendor obligations;
- controlled overdue and open-credit states.

### 12.3 Banking and capital

- customer payments grouped into deposits;
- transfers among bank and credit-card accounts;
- owner contribution/draw or shareholder activity appropriate to the chosen entity type;
- loan advance, principal, interest, and repayment;
- bank fees, merchant fees, interest income, and FX effects if enabled;
- statement-period fixtures whose ending balances can be reconciled;
- cleared, uncleared, duplicate, and timing-difference states in controlled proportions.

### 12.4 Accounting, close, and tax

- depreciation and amortization;
- accruals and reversing entries;
- prepaid expense and deferred allocation where appropriate;
- payroll summary/clearing entries if payroll detail cannot be safely created through the API;
- inventory adjustments with reasons;
- bad-debt or write-off workflows after accounting review;
- month-end close checklist and closing-date evidence;
- sales-tax cycles and filing evidence where automation is unsupported;
- budget creation/import and budget-versus-actual coverage where supported.

No accounting rule should be encoded solely from intuition. Canadian tax and accounting behaviours require reviewed fixtures, citations to current authoritative sources during implementation, and golden expected results.

## 13. Reports as a first-class product

### 13.1 Report catalog

Create a report catalog linked to the capability registry. It must include both API-accessible reports and important QBO UI-only reports.

Each entry needs:

- stable key and display name;
- business question the report answers;
- availability in QBO Advanced Canada;
- API endpoint/support status and parameters where available;
- prerequisite accounts, dimensions, entities, and transactions;
- required date range and comparison periods;
- expected non-zero sections and material relationships;
- validation assertions and tolerances;
- QBO UI navigation instructions when manual-only;
- latest validation time, source period, status, and evidence;
- known discrepancies between API and UI presentation.

### 13.2 Initial report families

Phase 1 must enumerate exact names and availability. The intended families include:

- balance sheet, profit and loss, trial balance, general ledger, journal, and account lists;
- statement of cash flows and cash summaries;
- accounts receivable aging, customer balances, invoice lists, collections, sales by customer/product/class/location, and customer statements;
- accounts payable aging, vendor balances, unpaid bills, expenses, and purchases by vendor/product/class/location;
- inventory valuation, quantity on hand, sales, purchases, and adjustment reports;
- project profitability, time/cost, and unbilled activity where available;
- sales-tax liability/detail and other Canadian tax reports;
- budget versus actual and management comparisons;
- reconciliation, cleared/uncleared, and account-history evidence;
- audit and exception-oriented reports available in the product.

### 13.3 Validation levels

- **Availability:** report can be opened or retrieved.
- **Populated:** required sections contain data.
- **Plausible:** totals and distributions fall inside blueprint expectations.
- **Reconciled:** key totals agree to related reports/accounts/managed lifecycle records.
- **Manually verified:** a reviewer confirmed the QBO UI result and attached evidence.

The Overview should never collapse these into one misleading green check.

### 13.4 Report evidence

Store normalized assertions and metadata, not an uncontrolled warehouse of every report response. Raw snapshots may be retained for approved reports and periods with retention limits and sensitive-field review.

Evidence should capture:

- query parameters and report basis;
- QBO timestamp/request ID where available;
- normalized totals used in assertions;
- assertion outcomes and explanations;
- source operation/period/blueprint;
- manual reviewer and attachment references for UI-only reports;
- freshness and invalidation reason.

## 14. Reconciliation and period close

Reconciliation is a core operating cycle even if the QBO API cannot complete the official reconciliation action.

### 14.1 Reconciliation cycle record

For each bank or credit-card statement period, track:

- account, opening date/balance, closing date/balance;
- statement fixture source and expected transactions;
- QBO transactions expected to clear;
- timing differences and intentional exceptions;
- discrepancy amount and status;
- manual QBO reconciliation status;
- reviewer, completion time, and evidence;
- related operation and report validation results.

### 14.2 Supported operating modes

- **API-supported preparation:** create and observe eligible transactions, statements, and balances.
- **Manual QBO completion:** provide a precise checklist, then record completion and evidence.
- **Read-only verification:** compare QBO-observable data with the statement fixture without claiming the official QBO reconcile state.

Phase 1 must determine which fields and reports reliably expose reconciliation/cleared state. The UI must label inferred, app-tracked, and QBO-confirmed states separately.

### 14.3 Close workflow

The monthly close workspace should show:

- continuity completeness for the period;
- missing or partial operations;
- unreconciled bank/credit-card accounts;
- open AR/AP exceptions;
- inventory and tax checks;
- required adjustments and approvals;
- report validation status;
- closing-date/manual tasks;
- sign-off with evidence.

The app should guide and record this work. It must not silently post adjustments to make checks turn green.

## 15. QBO data catalog and management

### 15.1 Coverage objective

“View and manage all QBO data” will be implemented as:

- a catalog of every relevant QBO entity/report/feature;
- complete paginated read access for every verified API-readable in-scope entity;
- governed create/update/void/delete only where the API, accounting semantics, role policy, and recovery design are all approved;
- manual procedures and evidence for important unsupported capabilities;
- explicit unavailable/deferred labels rather than missing screens.

It does not mean a universal raw JSON editor.

### 15.2 Data workspace

The QBO Records workspace should provide:

- domain and entity navigation driven by the capability registry;
- server-side pagination, filters, sorting, and query bounds;
- searchable human identifiers and exact QBO IDs;
- column presets for common support questions;
- dense list and detail views;
- linked-record graph or ordered chain where it clarifies relationships;
- raw QBO payload view as read-only diagnostics with sensitive-field safeguards;
- provenance, operation, blueprint, and validation context when managed;
- sync token/update time/freshness and stale-state warnings;
- a direct route to the equivalent QBO screen when a stable supported link can be constructed;
- export only after data classification and privacy review.

### 15.3 Governed mutations

Every entity type needs its own mutation policy:

- supported actions and prohibited fields;
- required permissions and confirmation strength;
- validation and read-before-write rules;
- handling of `SyncToken` and concurrent changes;
- report/accounting impact preview;
- void versus delete policy;
- closed/reconciled-period rules;
- audit payload redaction;
- recovery or compensation approach.

Bulk actions must use the operation-plan lifecycle. The UI must never translate a table selection directly into unreviewed QBO calls.

## 16. Application-data administration

The app's own records are part of the product and need first-class management rather than hidden MongoDB intervention.

### 16.1 Administration domains

- application users, roles, permissions, status, and sessions;
- connected company identity and connection health (tokens never displayed);
- business blueprints and versions;
- capability/report catalogs and approvals;
- managed-entity mappings and adoption decisions;
- business calendar and schedule configuration;
- operation plans, runs, steps, events, and recovery decisions;
- report evidence and reconciliation cycles;
- audit events and retention policy;
- application settings and feature flags;
- legacy seed/generation/checkpoint/issue-pack/AI records as read-only or explicitly migrated data.

### 16.2 Management rules

- Administrative actions require server-side permissions.
- Secrets are represented only by presence/status and safe metadata.
- Historical operation and audit evidence is append-only; corrections create superseding records.
- Retention/deletion actions require exact scope, impact preview, and confirmation.
- QBO deletion is never implied by deleting local metadata.
- Referential integrity checks precede blueprint, capability, or managed-entity changes.
- Every admin screen defines empty, stale, unavailable, partial, error, and permission-denied states.

## 17. Disposition of checkpoints, issue packs, and AI

### 17.1 Checkpoints

Do not expand checkpoints during the core rebuild. Preserve existing records and a read-only legacy route until a later decision. Report evidence, managed-entity observations, and operation history should first prove whether full snapshots add unique value.

Checkpoint re-entry gate:

- a demonstrated support or recovery task cannot be solved by current evidence;
- snapshot scope, storage cost, freshness, and privacy are defined;
- comparisons are semantically meaningful, not large JSON diffs;
- QBO rate-limit and pagination impact is accepted.

### 17.2 Existing issue packs

Remove issue packs from primary navigation during UI cutover. Preserve existing definitions and runs as legacy/experimental data; do not advertise them as representative support problems.

A future issue-scenario system would require:

- an anonymized, governed taxonomy derived from actual recurring support cases;
- accounting and QBO feature prerequisites;
- multiple realistic variants and surrounding normal data;
- expected symptoms in records and reports;
- exact mutation plan and production safety classification;
- cleanup/containment strategy;
- evidence that the scenario improves support training or reproduction.

It should not return merely because the old engine already exists.

### 17.3 AI

Move AI out of the primary product architecture. Preserve existing code and data behind an off-by-default experimental feature flag until a separate AI proposal is approved.

Future AI may begin with read-only help such as explaining a selected app record or coverage state. It must not become necessary to operate the lab, and it receives no write authority without a fresh server-owned authorization, privacy, evaluation, and approval design.

## 18. UI/UX overhaul: design direction

### 18.1 Design objective

The new UI must feel like a trustworthy operational instrument: calm, precise, information-rich, and legible over long sessions. It should make the company, time period, environment, current operation, and risk visible without making every screen feel alarming.

The overhaul must deliver both:

1. a governed design system and approved high-fidelity workflow prototypes; and
2. the production React UI, integrated incrementally with real backend contracts and verified at desktop and mobile sizes.

A standalone concept page is not completion. The final system must replace the current shell and primary workflows after acceptance gates pass.

### 18.2 Research-to-product translation

| Research principle | Rule for Test Data Lab | Verification evidence |
|---|---|---|
| Purpose | Every screen begins with the user's operational question, not the database model | Screen brief names its job and primary decision |
| Agency | Users preview, approve, stop, retry, and recover; the system does not surprise them | Mutation usability tests and failure-state walkthroughs |
| Responsibility | Production, privacy, permissions, rate limits, and irreversible effects are visible at the point of action | Safety-content review and server enforcement tests |
| Familiarity | Use stable web/desktop patterns, labels, breadcrumbs, tables, forms, and explicit commands | Navigation and keyboard task tests |
| Flexibility | Dense desktop controls adapt to narrower contexts without hiding essential state | Responsive screenshots and reflow tests |
| Simplicity | Reduce ambiguity and memory burden, not necessarily the number of visible controls | Expert task time and error-rate review |
| Craft | Typography, alignment, geometry, states, transitions, and data formatting are consistent | Design-system conformance and visual regression |
| Delight | Satisfaction comes from clarity, fast feedback, and graceful recovery; ornament is restrained | Qualitative review after core task acceptance |
| Hierarchy | One clear primary task; scope, status, and consequence precede secondary detail | Screen critique and attention-order test |
| Harmony | Density and control style fit long-running pointer/keyboard workflows | Desktop workflow review at 1280 and 1440 widths |
| Consistency | Semantic tokens and interaction contracts remain stable across domains | Component inventory and lint/test enforcement |
| Direct manipulation | Selection, filtering, expansion, and preview produce immediate visible effects | Interaction tests; no silent background state changes |
| Forgiveness | Risky operations provide preview, cancellation/stop boundaries, recovery, and clear outcomes | Failure matrix and recovery drills |
| Materials as hierarchy | Translucency may appear in the app chrome or floating control layer; data surfaces stay opaque | Visual review; no stacked glass or low-contrast tables |
| Motion as causality | Motion explains navigation, expansion, ordering, or state change; it is brief and optional | Reduced-motion test and transition inventory |
| Accessibility as a binding constraint | Keyboard, focus, contrast, text resizing, alternative cues, reduced motion/transparency, and assistive semantics shape components from the start | WCAG 2.2 AA audit plus manual keyboard/screen-reader checks |
| Unified, not uniform | Shared semantics adapt to desktop, tablet, and mobile tasks instead of shrinking one layout | Cross-viewport workflow evidence |

Every material design decision should use the research's reasoning chain:

```text
Human goal
  → physical and social context
  → platform responsibility and risk
  → interaction grammar
  → visual/system expression
  → feedback and recovery
  → acceptance evidence
```

This prevents surface styling from skipping the human, operational, or safety layers. The design review should be able to trace each major screen from user intent through delivered component behaviour and evidence.

### 18.3 Context model

The research's constraint model is applied explicitly:

| Constraint | Primary desktop context | Narrow/mobile context | Product response |
|---|---|---|---|
| Viewing distance | Near | Near | Compact but readable information density |
| Input precision | High: mouse/trackpad/keyboard | Lower: touch | Dense desktop controls; larger touch targets on narrow layouts |
| Session duration | Long | Shorter/check-in oriented | Persistent workspace context on desktop; focused summaries and approvals on mobile |
| Ambient control | Usually controlled | Variable | Strong contrast and no essential translucent content |
| Error consequence | High for production writes | High | Scope and consequence remain visible on every form factor |

The desktop application should not be inflated into a touch-first interface. The mobile experience should support monitoring, reading, filtering, reviewing previews, and deliberate approval where safe; complex bulk editing may explicitly direct the user to a wider workspace rather than compress into an unsafe control maze.

### 18.4 Visual character

- Neutral, quiet surfaces with one restrained brand accent.
- Semantic status colours for success, warning, danger, information, and unknown; colour is never the only signal.
- Opaque cards, tables, forms, code/data panels, and dialogs for legibility.
- Optional subtle translucency only in persistent chrome such as the top command bar or mobile bottom navigation, with an opaque fallback and reduced-transparency mode.
- Thin separators and tonal grouping before shadows.
- Concentric corner geometry: nested radii derive from outer radius minus spacing so panels feel intentionally constructed.
- Shadows reserved for real elevation: popovers, menus, drawers, and modal layers.
- Systematic type roles instead of ad hoc sizes. Use the existing web-safe Geist/system stack; do not require Apple system fonts on Windows.
- Lucide icons may provide a consistent open icon grammar; ambiguous icons require text labels and accessible names.
- No Apple logos, SF Symbols, proprietary materials, product imitation, or unlicensed assets.

### 18.5 Design-system deliverables

Before broad screen implementation, create and approve:

- `DESIGN.md`: source-of-truth principles, tokens, component contracts, patterns, content rules, accessibility, responsive behaviour, and governance;
- `DESIGN.html`: plain-English, standalone visual guide with live examples and desktop/mobile frames;
- semantic CSS/Tailwind tokens for colour, type, spacing, geometry, elevation, motion, density, and data visualization;
- a React component showcase route available only in development, or an equivalent zero-backend showcase if a route is unsuitable;
- an interaction/state matrix for every foundational component;
- high-fidelity prototypes for the six critical workflows listed below;
- a design-decision record explaining which research ideas were adopted, adapted, or rejected.

Do not add Storybook or another UI platform by default. Evaluate it against the lighter existing Vite stack and adopt it only if it materially improves state coverage and maintenance.

## 19. New information architecture

### 19.1 Primary navigation

| Area | Purpose | Key subareas |
|---|---|---|
| Overview | Is the flagship company healthy, current, and ready for support work? | Readiness, continuity, coverage, reports, close, active work |
| Company | What business are we maintaining and what should it cover? | Blueprint, Capability Coverage, Business Calendar |
| Data | What exists in QBO and in this application? | QBO Records, App Records, Managed Entities |
| Operations | What will change, what is running, and what happened? | Plans, Running, History, Recovery |
| Reports | Which reports are meaningful and how were they verified? | Catalog, Validation, Evidence |
| Reconciliation | Are bank/credit-card periods and close tasks complete? | Cycles, Statements, Close Workspace |
| Administration | Who can do what and how is the lab configured? | Users & Roles, Connection, Settings, Audit |
| Experimental | Non-core preserved work | Legacy Checkpoints, Issue Scenarios, AI; hidden unless enabled |

### 19.2 Global scope strip

Every authenticated screen must show a stable, compact scope strip containing:

- company display name;
- environment, with persistent `PRODUCTION` text and icon when applicable;
- connection health and last verified time;
- business date/continuity state;
- active operation or schedule pause state;
- current user's role or an accessible account menu.

This information must not disappear inside a Settings page. Production should be unmistakable without painting the entire interface red. Use a restrained persistent badge and stronger confirmation at mutation points.

### 19.3 Desktop shell

Recommended structure:

- skip link at the beginning of the document;
- collapsible left navigation rail with labelled destinations and grouped experimental content;
- top command/scope bar with company, environment, global search/command entry, active-work indicator, and user menu;
- breadcrumb plus page title/action row;
- stable content frame with optional contextual inspector on the right;
- drawers/dialogs that maintain a stable outer frame and scroll internally;
- keyboard route and command access without making shortcuts the only discoverable path.

The rail may collapse to icons only when every icon has a tooltip and accessible label. The user-controlled preference must persist.

### 19.4 Narrow shell

At narrow widths:

- replace the left rail with a labelled menu sheet or bottom-level navigation for the highest-frequency areas;
- keep company/environment context in a compact header;
- convert secondary tabs into an accessible select/disclosure only when necessary;
- transform dense tables into prioritized row summaries with drill-in details, not horizontal data loss;
- retain filters through a sheet with an active-filter count;
- keep the primary action reachable without covering content;
- never require a hover interaction;
- do not expose an unsafe subset of a mutation form: either adapt the whole decision or require desktop.

## 20. Critical workflows and screen specifications

These six workflows must receive high-fidelity prototypes and usability review before broad implementation:

1. understand company readiness;
2. define or revise the business blueprint;
3. find and close a feature/report coverage gap;
4. preview, approve, monitor, stop, and recover an operation;
5. inspect and safely manage a QBO record and its relationships;
6. complete a reconciliation/month-end close cycle.

### 20.1 Overview

**Question:** Is the flagship company ready for support work today?

Layout, in attention order:

1. **Readiness statement:** plain-language overall state such as “Ready through July 31” or “Not ready: two continuity gaps and one unreconciled account.”
2. **Scope:** company, production/sandbox, business date, blueprint version, and last QBO verification.
3. **Needs attention:** blocked/partial operation, coverage regression, stale report evidence, overdue reconciliation, expiring connection, or schedule pause. Each item has owner, age, impact, and next action.
4. **Operating health:** continuity, Tier 1 coverage, critical reports, current close, and managed-data integrity.
5. **Business pulse:** selected sales, expenses, AR, AP, cash, inventory, and transaction-volume trends with period context.
6. **Recent operations and manual activity:** source, operator, outcome, and affected period.
7. **Quick paths:** preview next period, browse data, open close workspace, or review coverage.

Avoid a wall of equal-weight metric cards. Use one outcome statement, a short attention queue, and progressive detail.

### 20.2 Company Blueprint

**Question:** What business are we claiming this company represents?

- version selector and approval state;
- readable business summary before editable details;
- sections for identity/calendar, divisions, accounts, parties, products/services/inventory, dimensions, tax, staff/roles, cadence, reports, and volume;
- completeness and conflict indicators tied to capability prerequisites;
- side-by-side change review before publishing a new version;
- draft autosave locally/server-side as appropriate, but explicit publish/activate;
- no direct QBO mutation from editing the blueprint;
- “Generate operation plan” is a separate action after validation.

### 20.3 Capability Coverage

**Question:** What QBO functionality is represented, and what is missing?

- domain summary with Covered/Partial/Manual-only/Unavailable/Deferred/Unknown counts;
- sortable, filterable registry table on desktop;
- coverage detail with prerequisites, variants, report links, evidence, limitations, owner, and last verification;
- a gap action that creates a draft plan or manual task, never an immediate mutation;
- release-target views for Tier 1 and critical reports;
- evidence freshness and blueprint-version drift warnings;
- explicit distinction among app support, QBO API support, and QBO product support.

### 20.4 Business Calendar

**Question:** What business period is complete and what must happen next?

- timeline by day/month with complete, due, planned, running, partial, blocked, closed, and manually completed states;
- current QBO date context versus simulation/business date;
- expandable period checklist;
- next-operation preview entry;
- schedule status, next run, budgets, and pause control for authorized users;
- gaps and overlaps made visually obvious with labels/patterns, not colour alone.

### 20.5 Operation Preview

**Question:** Exactly what will this do to which company?

- immutable scope header with company, environment, operation type, period, blueprint version, and preview freshness;
- prerequisite summary;
- grouped action counts with expandable exact samples;
- API-call and volume budgets;
- accounting/report effect summary;
- closed/reconciled-period and high-risk warnings;
- validation failures separated from warnings;
- downloadable/copyable plan identifier, excluding secrets;
- production typed confirmation only after review sections have been presented;
- disabled approve action with an explanation when prerequisites fail.

### 20.6 Operation Monitor and Recovery

**Question:** What is happening, what completed, and what needs me?

- phase and step progress based on durable work units;
- throughput, rate-limit/backoff state, elapsed time, and realistic remaining-work description;
- event timeline with filter by info/warning/error/QBO call class;
- expandable sanitized request/result diagnostics and `intuit_tid` where available;
- stop semantics explained before use;
- partial-completion summary by entity and period;
- recovery options with consequences: resume, retry step, adopt discovered record, compensate, skip with approved exception, or manual review;
- completed operation links to managed records, report checks, and audit events.

Do not use an indeterminate spinner when known work units exist. Do not display “Failed” without saying whether any QBO writes succeeded.

### 20.7 QBO Records

**Question:** Find the QBO record and understand or manage it safely.

- entity/domain picker driven by the registry;
- server-side search/filter/sort/pagination with result count or bounded-result explanation;
- customizable columns with sensible support-oriented presets;
- split-view detail on wide screens, routed detail page on narrow screens;
- human summary before raw fields;
- linked transactions, balances, audit/provenance, report relationships, and last refresh;
- source badges: App managed, Manual, External, Unknown;
- allowed actions generated from server mutation policy and current record state;
- update form with changed-field summary and fresh concurrency validation;
- void/delete separated and explained; not hidden in a generic “Save” action.

### 20.8 App Records

**Question:** What does the application know and control?

- data domains listed in section 16;
- consistent tables, detail views, references, status, retention, and permissions;
- safe JSON diagnostics for structured internal records;
- explicit source of truth and links to related QBO objects;
- administrative mutations with referential-impact previews.

### 20.9 Reports

**Question:** Which reports are useful, current, and trustworthy?

- critical-report readiness at the top;
- catalog filters by business question, family, API/manual, tier, state, and freshness;
- report detail with prerequisites, latest assertions, source period, evidence, and QBO-open instructions;
- trend of validation results by blueprint/period;
- “Validate” creates a read-only or clearly scoped operation, not an invisible fetch storm;
- report failures distinguish empty data, invalid prerequisites, permission, unsupported parameters, QBO error, and assertion mismatch.

### 20.10 Reconciliation and Close

**Question:** Can this period be responsibly considered complete?

- account/period list with statement ending balance, discrepancy, official/manual status, and evidence freshness;
- guided checklist with clear separation between app preparation and actions that must occur in QBO;
- matching/cleared evidence where observable;
- discrepancy breakdown and intentional timing differences;
- close dependencies across continuity, reports, tax, AR/AP, inventory, and adjustments;
- explicit sign-off and reopen flow with audit history.

### 20.11 Users and Roles

**Question:** Who can do what here, and does the QBO company have the expected access structure?

- application members, role, status, last activity, and effective permissions;
- invitations or account creation only after the local-user model is redesigned and approved;
- QBO expected-user/role coverage in a separate panel labelled API-observed, manual, or unavailable;
- permission diff before role changes;
- self-lockout and last-owner protections;
- session and credential status without secret disclosure.

### 20.12 Connection and Settings

**Question:** Is the integration configured safely?

- company identity, realm suffix only where useful, environment, scopes, token health, last refresh/verification, and known limitations;
- connect/reconnect/disconnect actions isolated by consequence;
- no raw tokens or secrets;
- settings grouped by company, operations, schedule, data retention, accessibility/display, and experimental flags;
- changes show immediate effect, restart requirement, or next-operation effect.

### 20.13 Audit

**Question:** Who or what changed what, when, where, and with what result?

- filters by actor, realm, environment, capability, action, object, operation, outcome, and period;
- request/operation correlation IDs and QBO `intuit_tid` where applicable;
- before/after summaries only for fields safe and meaningful to retain;
- secret redaction and sensitive-payload policy;
- direct links to operation, QBO/app record, and approval evidence;
- an explicit statement when the app cannot prove a fact.

## 21. Interaction and component system

### 21.1 Foundational components

Build or consolidate these before migrating feature screens:

- App shell, scope strip, navigation rail, mobile navigation, breadcrumb, page header;
- button, icon button, split button, link, menu, command/search field;
- input, textarea, select, combobox, date/period picker, checkbox, radio, switch, field help, validation summary;
- table/data grid foundation with server pagination, sorting, filtering, selection, density, sticky headers, keyboard access, and responsive row summaries;
- card, section, disclosure, tabs, definition list, metric, trend, badge, status marker;
- alert, inline message, toast, banner, attention item;
- dialog, confirmation dialog, drawer, popover, tooltip;
- empty, loading, stale, unavailable, partial, permission-denied, and error states;
- progress, stepper, operation timeline, event log, diff/change summary;
- structured JSON viewer, copy control, masked value, diagnostic detail;
- chart primitives with accessible data tables or summaries;
- skeletons only when they improve perceived structure and do not hide a known actionable error.

Reuse the existing Base UI/shadcn/Tailwind/Lucide foundation where its behaviour and accessibility meet the new contract. Consolidate rather than layering a second component system beside it.

### 21.2 Component contract

Every foundational component must define:

- purpose and non-purpose;
- variants and density modes;
- keyboard behaviour and focus management;
- screen-reader name/state/relationship;
- loading, disabled, read-only, invalid, warning, success, stale, and permission states as applicable;
- responsive behaviour;
- reduced-motion/transparency behaviour;
- content limits and truncation/expansion rules;
- analytics/diagnostic hooks only if privacy-approved;
- unit/interaction/accessibility/visual test coverage.

### 21.3 Semantic tokens

Replace duplicate legacy and generated token families with a documented semantic layer. Minimum token groups:

- canvas, surface, elevated surface, inset surface, chrome, scrim;
- text primary/secondary/tertiary/inverse/link;
- border subtle/default/strong/focus;
- accent, info, success, warning, danger, unknown, production;
- typography roles for display, page title, section title, body, label, metadata, tabular numeric, and code;
- 4px-based spacing scale with named layout gaps;
- control heights for compact desktop, default desktop, and touch contexts;
- inner/outer radii and concentric container formulas;
- elevation levels tied to actual layering;
- duration/easing for feedback, expansion, navigation, and progress;
- chart/data-series colours with non-colour encodings.

Production status is a semantic state, not the brand accent. Danger is reserved for a problem or destructive consequence, not all production context.

### 21.4 Content design

- Use direct labels: “Preview next month,” “Run in production,” “Stop after current step.”
- State consequence before confirmation: “This will create up to 240 QBO records in Test Data Lab — Production.”
- Replace unexplained jargon with a short inline definition or help text.
- Use consistent verbs: View, Preview, Approve, Run, Stop, Resume, Retry, Adopt, Void, Delete, Archive.
- Never use “Sync” when the action actually creates or overwrites data.
- Never claim “safe,” “complete,” “reconciled,” or “verified” without the associated evidence state.
- Errors answer: what happened, what may already have changed, what the user can do, and what identifier helps diagnose it.

## 22. Accessibility requirements

WCAG 2.2 AA is the minimum release target. Accessibility is designed into the system, not run once at the end.

### 22.1 Required behaviour

- a visible skip link;
- logical landmarks and heading order;
- complete keyboard operation with visible focus;
- no keyboard traps; dialogs restore focus to the invoking control;
- accessible names and descriptions for controls and icon buttons;
- table headers, captions/summaries, sort state, selection state, and row actions announced correctly;
- error summary linked to invalid fields, with errors not communicated by colour alone;
- live-region announcements for operation state changes that are important but not excessively noisy;
- sufficient contrast in light and dark modes, including disabled and status states;
- text zoom/reflow at 200% and browser zoom evaluation through 400% for critical paths;
- target sizes appropriate to input context, with at least 44×44 CSS pixels for primary touch actions on touch layouts;
- no hover-only content or actions;
- reduced motion and reduced transparency support;
- charts with text summaries and accessible tabular values;
- timestamps, currency, negative values, and status text understandable without visual formatting alone;
- session timeout/re-authentication that preserves safe draft context and explains what happened.

### 22.2 Manual acceptance

Automated checks are necessary but insufficient. Critical workflows require:

- keyboard-only completion;
- NVDA on Windows with current Chrome or Edge;
- 200% zoom and narrow reflow;
- high contrast/forced colours where practical;
- reduced-motion and dark-mode inspection;
- touch-target and focus-order review on the narrow layout.

## 23. Responsive, density, and layout requirements

### 23.1 Supported evidence viewports

Capture and review every critical workflow at minimum at:

- 1440×1000: primary desktop evidence used by the research artifacts;
- 1280×720: constrained desktop/laptop;
- 768×1024: intermediate/tablet portrait behaviour;
- 390×844: primary narrow/mobile evidence used by the research artifacts;
- 320 CSS-pixel reflow checks for critical reading and operation-review paths.

Viewport acceptance is based on task completion and reachability, not screenshot aesthetics alone.

### 23.2 Density

- Default desktop density should support long data-management sessions.
- Comfortable density may be offered as a user preference.
- Touch layouts increase row and control targets without increasing decorative whitespace everywhere.
- Numeric columns align and use tabular figures.
- Long identifiers truncate only with a reliable reveal/copy action.
- Sticky headers/columns must not obscure focus or content.
- Horizontal table scrolling is allowed for diagnostic breadth only when priority columns stay identifiable and a narrow summary alternative exists.

### 23.3 Stable frames

- Drawers and dialogs use stable outer dimensions within the viewport and internal scrolling.
- Loading data should not move primary controls unexpectedly.
- Tab switches and validation messages preserve nearby context.
- Navigation collapse, inspector open/close, and responsive transitions preserve the selected record and scroll position where feasible.

## 24. Motion and feedback

Motion exists to explain causality and state:

- 120–180 ms for direct control feedback;
- 180–240 ms for panels, disclosures, and route-adjacent context;
- progress animations only while actual work continues;
- no looped ambient decoration in operational screens;
- no layout-wide parallax, bouncing success celebrations, or motion that delays input;
- interrupted/failed states settle immediately and clearly;
- reduced-motion mode removes non-essential transforms and uses opacity or immediate state change.

Exact token values must be visually tested and may be adjusted; semantic roles are more important than copying a platform timing number.

## 25. UI implementation architecture

### 25.1 Keep the current stack unless evidence requires change

The current React 19, Vite, React Router, Tailwind, Base UI, shadcn-style components, Lucide, and Axios stack can support this rebuild. No framework rewrite is justified by the current evidence.

Recommended frontend structure:

```text
frontend/src/
  app/                 route definitions, providers, feature flags
  shell/               navigation, scope, page frame, responsive chrome
  components/
    ui/                 governed low-level components
    patterns/           data grid, operation timeline, attention queue, inspector
  features/
    overview/
    blueprint/
    coverage/
    calendar/
    data/
    operations/
    reports/
    reconciliation/
    administration/
    experimental/
  api/                  typed-by-convention domain clients and response normalization
  styles/               tokens, themes, density, print/forced-colour support
  test/                 fixtures, accessibility helpers, render utilities
```

This is a target organization, not permission for a mechanical big-bang move. Migrate by vertical slice and preserve working routes until their replacements pass.

### 25.2 Data fetching and state

- Keep server state separate from local form/UI state.
- Standardize request cancellation, loading, stale, partial, retryable, permission, QBO upstream, and validation outcomes.
- Evaluate a query-cache library only after defining required caching/invalidation behaviour. Do not add one because it is fashionable.
- Mutations invalidate or update only the affected scopes and display confirmation tied to the operation/audit record.
- Long-running operations use durable polling or server events with reconnect and full-state recovery; the UI is never the authority for whether a run continues.
- URL state should preserve meaningful filters, selected entity, tab, and period when safe to share locally.

### 25.3 Feature flags and migration

Introduce server-owned feature flags for new workspaces and experimental legacy features. The new shell may launch around legacy pages, but the navigation must not falsely promote deprecated features.

Suggested rollout:

1. new tokens and component showcase;
2. new shell with existing pages mounted behind their current routes;
3. Overview and read-only Coverage;
4. Data catalog and operation history;
5. blueprint and preview flows;
6. operation execution/monitoring;
7. reports and reconciliation;
8. administration;
9. legacy routes moved under Experimental or removed after data retention approval.

## 26. Visual and interaction acceptance evidence

Each migrated workflow must include:

- approved screen brief and state matrix;
- screenshots at the required desktop and mobile evidence sizes;
- light and dark mode for the shell and at least one dense/error state;
- empty, loading, populated, stale, partial, permission-denied, upstream-QBO-error, and destructive-confirmation states as relevant;
- keyboard tab-order and focus evidence;
- reduced-motion and responsive overflow checks;
- comparison against the previous implementation for navigation clarity, visible scope, task steps, and error recovery;
- reviewer sign-off that the screen follows the research-derived rules.

No screen passes because it is visually polished while its controls are unreachable, its state is ambiguous, or its backend action remains unsafe.

## 27. Proposed backend and data architecture

Names are provisional; Phase 1 confirms contracts before implementation.

### 27.1 Core records

| Record | Purpose | Key invariants |
|---|---|---|
| `CompanyMembership` | Application user access to a realm | Unique user/realm; effective permission set; status and audit |
| `CapabilityDefinition` | Versioned QBO feature fact and coverage requirement | Stable key; verified support facts; no release `Unknown` |
| `ReportDefinition` | Versioned report prerequisites and assertions | Stable key; explicit API/manual status |
| `BusinessBlueprint` | Desired flagship-company model | Immutable published versions; one active version per realm |
| `BusinessCalendar` | Continuity cursor and period state | No unexplained overlap/gap; realm-scoped concurrency control |
| `ManagedEntity` | Provenance and intended state for QBO objects | Unique realm/type/QBO ID and natural-key safeguards |
| `OperationPlan` | Validated preview of intended work | Immutable fingerprint after approval; expires on drift |
| `OperationRun` | Durable execution authority and summary | One active mutating lease per realm; explicit partial state |
| `OperationStep` | Ordered, retryable unit of work | Idempotency key; attempt/result/effect attribution |
| `OperationEvent` | Append-only operational timeline | Sanitized, correlated, immutable |
| `ReportEvidence` | Assertion results and approved snapshots | Period/parameters/blueprint provenance and freshness |
| `ReconciliationCycle` | Statement and close evidence | Distinguishes QBO-confirmed, manual, inferred, and app-tracked state |
| `FeatureFlag` | Server-owned staged rollout | Realm/environment/role scope; audit on change |

Do not embed unbounded created-transaction arrays in one run document. Operation steps/events and managed entities should be separately paginated collections with indexes designed from access patterns.

### 27.2 Domain services

- `capability-registry-service`: catalog versions, prerequisites, coverage evaluation;
- `blueprint-service`: validation, versioning, activation, drift analysis;
- `business-calendar-service`: due work, continuity, period rules;
- `operation-planner`: deterministic plans and preview fingerprints;
- `operation-runner`: lease, steps, rate limits, stop/resume/recovery;
- `managed-entity-service`: ownership, adoption, drift, idempotency;
- lifecycle modules grouped by domain rather than one large generation engine;
- `report-service`: catalog execution, normalization, assertions, evidence;
- `reconciliation-service`: statement fixtures, observation, manual evidence;
- `qbo-data-service`: registry-driven reads and entity-specific governed mutations;
- `authorization-service`: membership and permission evaluation;
- `audit-service`: one sanitized, correlated audit contract across routes.

The existing `qbo-client.js` remains the single low-level QBO client boundary unless Phase 1 finds a concrete reason to change it. New domain services must use it and the existing QBO error contract rather than call Intuit independently.

### 27.3 Proposed route families

```text
/api/context                 company, environment, business date, user capability summary
/api/overview                readiness and attention aggregation
/api/capabilities            registry, coverage, evidence, gap planning
/api/reports                 catalog, validation requests, evidence
/api/blueprints              drafts, validation, versions, activation
/api/calendar                periods, due work, schedule state
/api/operations              plans, previews, approvals, runs, steps, stop/recovery
/api/data/qbo                catalog, query, detail, governed action planning
/api/data/app                authorized local-data administration
/api/reconciliations         cycles, statement evidence, close sign-off
/api/admin/users             memberships, roles, permissions
/api/admin/connection        safe connection metadata/actions
/api/admin/settings          realm-scoped settings and feature flags
/api/audit                   expanded correlated audit queries
/api/experimental            explicitly gated legacy/future features
```

Route names do not imply a generic CRUD surface. Each endpoint needs an authorization policy, realm resolution rule, validation schema, audit class, and QBO/database mutation classification.

### 27.4 Realm and connection model

The current `Connection` model is user/realm scoped while the practical mental model is one shared flagship company. Phase 3 must resolve this deliberately:

- choose a realm-owned connection plus memberships, or document why per-user connections remain required;
- prevent two records from implying different authority over the same flagship realm;
- define who may refresh, reconnect, or disconnect;
- separate safe connection metadata from encrypted credentials;
- design credential encryption/key management before calling stored plaintext acceptable;
- retire, explicitly preserve, or securely migrate legacy user-supplied AI keys; do not silently carry plaintext provider-key storage into the new administration model;
- migrate without logging or exposing tokens.

This is a security and product decision, not a cosmetic schema rename.

### 27.5 Input and output contracts

- Validate all query/body/path inputs with explicit schemas before service calls.
- Normalize paginated responses: `items`, `page`, `pageSize`, `hasMore`, and bounded/estimated total semantics.
- Return structured error classes: validation, permission, conflict/drift, QBO upstream, rate limited, partial operation, unsupported capability, and internal.
- Preserve the existing rule that QBO-side 401 does not become app-level 401.
- Include request/correlation IDs without returning sensitive internals.
- Expose operation/evidence state as server truth; the frontend does not infer completion from HTTP success alone.

## 28. Mutation safety architecture

### 28.1 Mandatory controls

Every QBO write requires:

1. authenticated application user;
2. current server-side membership/permission evaluation;
3. exact realm resolution from server-trusted context;
4. explicit environment and company identity in preview and confirmation;
5. an approved, unexpired operation plan or entity-specific mutation plan;
6. idempotency and current-record/drift checks;
7. per-operation call, record, amount, and date budgets;
8. closed/reconciled-period rules;
9. audit start, outcome, and any partial effects;
10. QBO error classification and `intuit_tid` capture where available.

The existing `requireProductionConfirm` protection must remain effective during migration and should be centralized beneath the new plan/approval checks rather than weakened or replaced by a client-only dialog.

The client cannot choose raw tool/action names, QBO endpoints, realm IDs, arbitrary fields, or bypass confirmation through a crafted request.

### 28.2 Action risk classes

| Class | Examples | Minimum control |
|---|---|---|
| Read | Browse entities, validate reports, inspect operations | Auth, realm scope, rate/query bounds, audit where sensitive |
| Low write | Create approved draft blueprint or local note/evidence | Permission, validation, audit |
| QBO additive | Create new master/transaction data in open periods | Fresh preview, production confirmation, budgets, idempotency, audit |
| QBO corrective | Update, void, compensate, adopt after partial failure | Record-specific impact review, concurrency check, elevated permission |
| Destructive | Delete QBO/local data, disconnect, retire evidence, alter closing/reconciled history | Strong confirmation, exact target, dependency analysis, owner authority, recovery/retention plan |
| Automatic | Any scheduled QBO mutation | All additive controls plus separate production enablement, lease, budgets, pause/kill switch, failure cutoff |

### 28.3 Audit minimum

For a mutating action, record:

- actor and effective role/permission;
- realm, company-safe identifier, and environment;
- request and operation IDs;
- action class and server-owned handler version;
- blueprint/capability/report/period context;
- plan fingerprint and confirmation evidence;
- intended versus actual entity counts;
- QBO IDs and safe summaries of changed fields;
- start/end time, result, partial state, retries, and recovery status;
- QBO status and `intuit_tid` where present;
- sanitized error; never secrets or raw authorization.

### 28.4 Privacy and retention

- Collect only data required to operate and validate the lab.
- Do not retain full QBO payloads by default when normalized evidence suffices.
- Classify and redact personal/contact/tax/financial fields in logs, exports, screenshots, and support evidence.
- Ask for export/attachment access at the point of use and explain the benefit.
- Define retention per collection before general app-data deletion exists.
- Deletion of local evidence must not imply deletion of its QBO source.
- AI remains unable to receive QBO data unless a future privacy proposal explicitly defines scope, provider, retention, and redaction.

## 29. Migration and compatibility strategy

### 29.1 Preserve before transforming

- Existing QBO records are never deleted as part of the rebuild.
- Existing `SeedRun`, `GenerationRun`, `IssuePackRun`, `Checkpoint`, `AIPlan`, and `AISession` data remains readable until a retention/migration decision is approved.
- Legacy runs may be projected into read-only operation-history summaries, but they are not retroactively claimed to satisfy new idempotency or evidence requirements.
- Existing audit entries remain immutable.
- Existing users are mapped to the new membership model through an explicit migration and owner review.

### 29.2 Parallel product cutover

- Use feature flags and additive schemas.
- Introduce the new shell around working pages without removing access.
- Ship read-only registry/overview surfaces before write execution.
- Run new operation planning against fixtures and sandbox before production.
- Keep legacy routes available under Experimental or a temporary compatibility area until replacement acceptance and data retention approval.
- Remove or disable a legacy mutation route only after confirming no approved workflow depends on it.

### 29.3 Rollback

Application rollback means returning traffic/navigation to the previous compatible code and stopping new operation approval. It does **not** erase QBO records already created.

Every mutating release needs:

- backward-compatible schema expectations or a proven migration rollback;
- feature flag to stop new use;
- operation-level record/effect inventory;
- compensation guidance where accounting-safe;
- explicit acknowledgement when an effect must be corrected manually in QBO.

## 30. Phased delivery plan

Each phase has a passing gate. Later phases do not start simply because code exists.

### Phase 0 — Product reset and approval

**Goal:** Establish the corrected mission and stop adding displaced core scope.

**Deliverables**

- approve this plan and record decisions in section 35;
- align `prd.md`, `roadmap.md`, repository description, and phase-document status;
- define public-safe product naming (`Test Data Lab`) and internal QBO terminology rules;
- classify checkpoints, issue packs, and AI as legacy/experimental;
- create a release-evidence checklist for the rebuild.

**Passing gate**

- one approved product statement;
- P0 outcomes and non-goals accepted;
- decision owners named;
- no implementation ambiguity about AI/issue-pack priority.

**Live impact:** none.

### Phase 1 — QBO capability, report, and data-volume discovery

**Goal:** Replace assumptions with a verified QBO Advanced Canada coverage catalog.

**Deliverables**

- current official documentation research for entity, report, users/roles, tax, inventory, projects, budgets, and reconciliation capabilities;
- capability and report registry schema/seed artifacts;
- QBO product versus API versus manual-only classification;
- feature prerequisites and report dependency map;
- read/query pagination and rate-limit benchmarks;
- safe sandbox-only spikes for uncertain write support after separate authorization;
- initial Development/Flagship/Scale volume proposals;
- unsupported/ambiguous capability decisions.

**Passing gate**

- 100% of candidate Tier 1 capabilities classified;
- no plan statement claims unsupported automation;
- report catalog and evidence definitions approved;
- production volume remains disabled;
- every live spike has recorded target and result.

**Verification**

- source/doc citations;
- static schemas and fixtures;
- mocked contract tests;
- separately approved sandbox observations.

**Live impact:** read-only by default; sandbox mutation only with explicit per-spike approval; no production mutations.

### Phase 2 — Design system and critical workflow prototypes

**Goal:** Turn the Apple research synthesis and product model into an approved, buildable UI system.

**Deliverables**

- `DESIGN.md` and `DESIGN.html`;
- consolidated semantic tokens and component contracts;
- accessible component showcase;
- route map, screen briefs, content rules, and full state matrix;
- high-fidelity React/static prototypes for all six critical workflows;
- desktop/narrow screenshots at required evidence sizes;
- keyboard, focus, contrast, reflow, reduced-motion, and responsive review;
- design decision record showing adopted/adapted/rejected research ideas;
- frontend implementation slices and migration map.

**Passing gate**

- user approves the visual direction and six workflow designs;
- critical content and action hierarchy is stable;
- no known critical accessibility or reachability blocker;
- dense desktop and narrow layouts both preserve scope and consequence;
- the design can be implemented with the existing stack or an approved dependency decision.

**Verification**

- static frontend build/lint;
- component interaction tests;
- automated accessibility scan plus manual keyboard/NVDA checks;
- rendered screenshot comparison.

**Live impact:** none; use fixtures, not a running production backend.

### Phase 3 — Server foundation, authorization, and safe context

**Goal:** Build the server-owned structures the new UI and mutations depend on.

**Deliverables**

- membership/permission model and migration plan;
- realm/company context endpoint;
- capability/report definition storage and read endpoints;
- blueprint draft/version models and validation foundation;
- feature flags;
- server-side, off-by-default gates for legacy AI and issue-pack mutation routes;
- expanded audit/correlation contract;
- consistent input validation/error contracts;
- decision and migration for connection ownership/encryption;
- remove business-data writes from incidental startup where feasible.

**Passing gate**

- server authorization tests deny every unauthorized mutation;
- realm cannot be selected or overridden by an untrusted client field;
- secrets remain redacted;
- migrations are reversible or have an approved recovery path;
- existing auth/QBO error handling is not regressed.

**Verification**

- backend unit/contract tests and syntax checks;
- migration dry run on sanitized fixtures;
- frontend contract fixtures;
- no live QBO mutation.

### Phase 4 — New shell, Overview, and read-only coverage UI

**Goal:** Ship the new information architecture around safe read-only product truth.

**Deliverables**

- new responsive shell, scope strip, navigation, attention pattern, and page framework;
- Overview using registry/connection/legacy-run data;
- read-only Blueprint, Coverage, Reports catalog, and Business Calendar surfaces backed by the available definitions/data, with honest incomplete states;
- Experimental area for preserved legacy routes;
- display/accessibility preferences;
- removal of public protected-brand naming.

**Passing gate**

- all existing non-mutating routes remain reachable;
- company/environment/connection context is visible and accurate;
- AI/checkpoints/issue packs no longer appear as primary destinations;
- required visual/accessibility evidence passes;
- no false “ready” or “covered” states.

**Verification**

- frontend build/lint/unit/accessibility/visual tests;
- mocked/server-fixture integration;
- browser verification only if the user authorizes app startup or it is already running.

### Phase 5 — Blueprint and realistic master-data operations

**Goal:** Define and safely establish the flagship business foundation.

**Deliverables**

- approved flagship blueprint version;
- chart of accounts, parties, products/services/inventory, dimensions, taxes, accounts, and staff-role coverage planners;
- managed-entity registry and deterministic natural keys;
- operation-plan/preview foundation for master data;
- QBO drift/adoption workflow;
- matching UI for blueprint validation, gap selection, preview, run monitoring, and recovery.

**Passing gate**

- deterministic fixture plans are stable across repeated generation;
- existing records are detected/adopted or flagged, not blindly duplicated;
- every QBO action appears in preview and audit;
- sandbox execution meets idempotency and partial-failure tests;
- production execution remains a separate user-approved canary.

**Verification**

- unit/property/contract tests;
- sandbox canary after explicit approval;
- production canary only after explicit approval with exact target and budget.

### Phase 6 — Historical lifecycle backfill

**Goal:** Create a coherent multi-period business history that supports critical features and reports.

**Deliverables**

- domain lifecycle modules for sales, purchases, banking, inventory, projects, tax, and close as supported;
- deterministic 36-month Flagship proposal, with the exact horizon approved after Phase 1;
- period-bounded plans, dependencies, and recovery;
- balance/report-effect assertions;
- operation monitoring and record inspection UI;
- documented manual-only work required inside QBO.

**Passing gate**

- Tier 1 lifecycle coverage passes in sandbox;
- no unexplained duplicate/gap after retry and interruption tests;
- critical report prerequisites populate coherently;
- accounting/tax fixtures are reviewed;
- volume stays within measured QBO/app performance limits;
- production backfill is separately staged and approved in bounded periods.

### Phase 7 — Continual operations and business calendar

**Goal:** Keep the flagship company moving forward reliably.

**Deliverables**

- durable leases, heartbeats, resumable steps, stop/recovery, and attention states;
- daily/weekly/monthly/quarterly/yearly planners;
- business calendar and continuity health;
- manual “advance next period” workflow;
- optional scheduler behind a separate off-by-default flag;
- budgets, blackout windows, catch-up policy, and kill switch;
- complete monitor/recovery UI.

**Passing gate**

- crash/restart/network/rate-limit/partial-response failure matrix passes;
- same plan cannot double-create records;
- no startup-triggered QBO mutation;
- manual production operations remain stable for the agreed evidence period;
- scheduled production mode receives separate approval.

### Phase 8 — Report validation, reconciliation, and close

**Goal:** Prove that the business history makes QBO reporting and recurring accounting work meaningful.

**Deliverables**

- report execution/normalization/assertion service;
- critical report evidence and coverage UI;
- UI-only report procedures and manual evidence;
- statement fixtures and reconciliation cycles;
- close workspace and sign-off;
- drift/freshness invalidation rules.

**Passing gate**

- all critical reports meet the approved validation level;
- manual/API/inferred states are never conflated;
- reconciliation discrepancies are explainable;
- no adjustment is posted solely to satisfy an assertion;
- report and reconciliation screens pass accessibility/responsive review.

### Phase 9 — Complete QBO and application data management

**Goal:** Provide governed visibility and management across all classified in-scope data.

**Deliverables**

- registry-driven QBO data catalog with complete pagination;
- linked detail/provenance/report context;
- entity-specific create/update/void/delete policies and plan flows;
- app-data administration;
- users/roles, connection, settings, audit, retention, and feature-flag screens;
- exports only where privacy-approved.

**Passing gate**

- every in-scope capability links to a working data surface or explicit manual/unavailable explanation;
- permission and mutation-policy matrices pass;
- concurrency/closed-period/destructive-action tests pass;
- no generic arbitrary QBO editor exists;
- desktop and narrow critical management paths pass.

### Phase 10 — Cutover, evidence, and hardening

**Goal:** Make the new product the default without losing history or safety.

**Deliverables**

- legacy feature disposition and retention decisions;
- new navigation/route cutover;
- performance and large-data tuning;
- full accessibility and responsive regression;
- QBO sandbox and approved production canary evidence;
- operator handbook, recovery runbook, manual QBO procedures, and known limitations;
- release evidence package and signed definition of done.

**Passing gate**

- section 36 definition of done passes;
- no P0/P1 defects or unexplained accounting/report discrepancies;
- production automation remains disabled unless separately approved;
- rollback and stop procedures are tested;
- product claims match what the application can prove.

### Future phase — Evidence-led support scenarios and AI

This phase is outside the rebuild release. It can be proposed only after the core lab has stable continual operations, broad coverage, report evidence, real support-case input, and a separate safety/privacy design.

## 31. Delivery dependencies and critical path

```text
Product approval
  ├─→ Capability/report discovery ─→ Blueprint and backend contracts
  │                                  ├─→ Master data ─→ Historical lifecycles ─→ Continual operations
  │                                  └─→ Reports/reconciliation ────────────────┘
  └─→ Design system/prototypes ─────→ New shell ─→ Vertical-slice UI migration

Authorization + realm context ─────→ Any new QBO write
Managed-entity + operation model ──→ Safe retries, recovery, scheduling, and management
Report prerequisites ──────────────→ Credible “coverage complete” claims
Manual production evidence ────────→ Optional production scheduling
```

The UI design work can proceed alongside capability discovery using approved fixtures. Production screens must not hardcode assumptions that discovery has not confirmed.

This is a multi-quarter rebuild for a solo developer, not a single feature sprint. Calendar estimates made before Phase 1 would be false precision. After Phase 1, each capability can be estimated from its API support, accounting complexity, operation steps, UI states, and verification burden. The release can still deliver value incrementally through read-only coverage, the new shell, and bounded vertical slices.

## 32. Expected file impact

This inventory identifies likely ownership; it is not permission to create every file immediately.

### 32.1 Existing files likely to change

- root: `package.json`, `prd.md`, `roadmap.md`, phase-plan status notes, product naming documentation;
- backend entry/config: `backend/src/server.js`, configuration, database startup, middleware, error handling;
- QBO boundary: `backend/src/modules/qbo-client.js`, `backend/src/modules/qbo-error.js`, QBO routes only as necessary;
- current run paths: seed, generate, company, explore, checkpoint, issue-pack, audit, auth, and AI routes/modules;
- current models: `User`, `Connection`, `SeedRun`, `GenerationRun`, legacy models, and model export/index files;
- frontend shell: `frontend/src/App.jsx`, `frontend/src/components/Layout.jsx`, route/protected-route/auth context;
- frontend styling: `frontend/src/index.css`, Tailwind/theme configuration, existing UI primitives;
- existing pages moved, wrapped, or retired through feature flags;
- API client and frontend error-surfacing primitives.

### 32.2 Likely new backend areas

```text
backend/src/models/
  CompanyMembership.js
  CapabilityDefinition.js
  ReportDefinition.js
  BusinessBlueprint.js
  BusinessCalendar.js
  ManagedEntity.js
  OperationPlan.js
  OperationRun.js
  OperationStep.js
  OperationEvent.js
  ReportEvidence.js
  ReconciliationCycle.js
  FeatureFlag.js

backend/src/modules/
  authorization/
  capabilities/
  blueprints/
  calendar/
  operations/
  lifecycles/
  reports/
  reconciliation/
  managed-data/
  audit/

backend/src/routes/
  context.js
  overview.js
  capabilities.js
  reports.js
  blueprints.js
  calendar.js
  operations.js
  data-qbo.js
  data-app.js
  reconciliations.js
  admin-*.js
```

Final grouping should follow actual module cohesion and existing CommonJS conventions. Avoid empty architecture folders or index-file indirection without a concrete use.

### 32.3 Likely new frontend areas

Use the target organization in section 25.1, plus:

- test fixtures representing every state before live APIs exist;
- accessibility test helpers;
- visual-evidence scripts/configuration;
- feature-specific API adapters;
- design-system source documents and showcase.

### 32.4 Tests and tooling

The backend currently has no defined test script. Phase 3 should add the smallest maintained test stack that supports CommonJS unit tests, HTTP contract tests, fixtures, and deterministic fake timers/random seeds. The frontend should add component and browser testing only with a clear maintenance plan.

Dependencies are approved one at a time. Every added package needs a purpose, current maintenance/security check, bundle/runtime impact review, and removal of superseded code where safe.

## 33. Verification strategy

### 33.1 Verification layers

| Layer | Purpose | Mutates live systems? |
|---|---|---:|
| Static checks | Syntax, lint, types-by-contract where adopted, schemas, dead imports | No |
| Unit tests | Business dates, deterministic selection, accounting rules, permissions, transitions | No |
| Property tests | Idempotency, invariants across generated combinations, no invalid date/account/tax pairings | No |
| Contract tests | Route shapes, QBO adapter responses/errors, pagination, 401 mapping, validation | No; mocked/recorded sanitized fixtures |
| Migration tests | Forward/backward schema behaviour and legacy compatibility | Local disposable database only |
| Component tests | States, keyboard interaction, focus, content, responsive transforms | No |
| Accessibility tests | Automated rules plus manual assistive-technology checks | No |
| Visual tests | Approved desktop/mobile states and regression | No |
| End-to-end fixture tests | Complete UI workflows against a fake/local test API | Local only |
| Sandbox integration | Actual QBO reads and bounded mutations | Yes; separate explicit approval |
| Production canary | Exact approved operation in flagship company | Yes; separate explicit approval and budget |

### 33.2 Backend invariant tests

At minimum:

- a published blueprint cannot be mutated in place;
- an approved plan cannot execute after its fingerprint, realm, environment, permission, prerequisite, or source state changes;
- only one mutating lease exists per realm;
- replaying a successful step cannot create a duplicate;
- ambiguous QBO timeouts trigger discovery before retry;
- a stopped/failed operation accurately reports completed effects;
- closed/reconciled periods reject prohibited operations;
- every QBO action produces audit and operation evidence;
- QBO upstream 401 never causes app-session logout semantics;
- missing permissions fail server-side;
- raw secrets never enter response or log fixtures;
- calendar advancement cannot skip or overlap a required period without an approved exception;
- report assertions are invalidated by relevant blueprint/data-period drift.

### 33.3 Accounting fixture tests

Create reviewed golden fixtures for each lifecycle:

- expected debit/credit and account-category effects where observable;
- expected open balance after each state;
- expected tax treatment;
- linked-transaction expectations;
- expected impact on critical reports;
- expected reconciliation statement balance;
- exact behaviour for partial, voided, credited, refunded, and failed states.

Implementation must distinguish “we sent the intended QBO payload” from “QBO produced the expected accounting/report result.” Both need evidence.

### 33.4 UI state coverage

For every primary screen, test:

- empty first use;
- fully healthy/ready;
- partially configured;
- stale data;
- loading with prior data available;
- permission denied;
- disconnected/expired connection;
- QBO rate-limited;
- QBO upstream error with `intuit_tid`;
- local server/network error;
- partial operation with successful writes;
- long values, large counts, and maximum practical table density;
- desktop, constrained desktop, tablet, mobile, zoom, dark, reduced-motion, and forced-colour behaviour where applicable.

### 33.5 Live test discipline

Before any live call, record:

- test objective and why a mock/fixture is insufficient;
- read-only or mutating classification;
- exact realm/company/environment;
- expected calls, records, amounts, and dates;
- cleanup or compensation plan;
- stop condition;
- evidence to retain;
- explicit authorization when mutation or service startup is involved.

No automated test suite should point at production by default.

## 34. Risk register

| Risk | Severity | Mitigation | Gate/owner |
|---|---:|---|---|
| QBO API cannot automate important users/roles, reconciliation, report, tax, or Advanced features | High | Phase 1 official-doc and safe spike classification; manual-only procedures; honest UI states | Phase 1, product owner |
| Production company is accidentally polluted or duplicated | Critical | Sandbox-first, preview fingerprint, typed production confirmation, budgets, idempotency, single realm lease, canaries | Every mutating phase, lab owner |
| Ambiguous network failure causes duplicate QBO writes | Critical | Deterministic keys, post-failure lookup/adoption, step state, no blind retry | Operation engine gate |
| Random generation produces accounting nonsense | Critical | Versioned blueprint, seeded constraints, reviewed golden fixtures, report/reconciliation assertions | Phases 5–8 |
| Scope expands toward every possible QBO feature without a coherent release | High | Tiered registry, explicit exclusions, vertical slices, phase gates | Product owner |
| Report API and QBO UI disagree or expose different detail | High | Record both support modes, normalized assertions, manual evidence, documented limitations | Phase 8 |
| Reconciliation is claimed without official QBO state | High | Label app-tracked/inferred/manual/QBO-confirmed separately | Phase 8 |
| Long-running jobs become stranded after restart | High | Lease/heartbeat, durable steps, partial state, recovery UI, failure matrix | Phase 7 |
| Stored credentials or financial data leak through logs/UI/exports | Critical | Encryption decision, redaction, least data, privacy/retention review, secret tests | Phase 3 onward |
| Role visibility is mistaken for authorization | Critical | Server-owned permission checks and route matrix tests | Phase 3 |
| One large run overwhelms QBO rate limits or app storage | High | Measured profiles, API/record/amount budgets, bounded periods, backoff, separate step collections | Phases 1, 6, 7 |
| UI reskin ships before truthful backend state | High | Fixture labels, read-only initial surfaces, vertical-slice gates, no false green states | Phases 2–4 |
| Apple-inspired styling reduces data legibility | High | Transfer principles not surface; opaque data planes; contrast/reduced-transparency tests | Phase 2 |
| Desktop density is lost to touch-first patterns | Medium | Context model, compact density, expert workflow tests | Phase 2 |
| Mobile layout hides critical consequence or creates unsafe partial forms | High | Adaptive workflow specs; desktop-required boundary where necessary | Phase 2 onward |
| Accessibility is deferred and becomes expensive to retrofit | High | Component contracts and manual checks before screen migration | Every UI phase |
| Legacy issue/AI routes continue to imply core status | Medium | Experimental flags/navigation, product docs, eventual disposition | Phases 0, 4, 10 |
| Existing local records cannot map cleanly to new models | Medium | Additive schemas, legacy projections, migration dry runs, no destructive cleanup | Phase 3 |
| Company drifts through manual QBO activity | High | Managed-entity observation, blueprint drift, freshness, adoption/review flows | Phases 5–9 |
| Canadian tax/business assumptions are wrong or stale | Critical | Current authoritative research during implementation and reviewed fixtures | Phases 1, 5, 6, 8 |
| Visual polish hides poor task performance | Medium | Workflow timing/errors, state walkthroughs, reachability/overflow evidence | Phase 2 onward |

## 35. Decisions required before implementation

### 35.1 Approval decisions

| Decision | Recommendation | Needed by |
|---|---|---|
| Product mission | Approve continual realistic flagship-company operations as P0 | Phase 0 |
| Public product name | Use “Test Data Lab”; reserve QBO terminology for descriptive integration text | Phase 0 |
| Legacy priorities | Move checkpoints, current issue packs, and AI under Experimental; no core expansion | Phase 0 |
| Flagship business shape | Approve one company with service/project, inventory/wholesale, and recurring-service lines, then refine in blueprint workshops | Phase 1/5 |
| Historical horizon | Start planning around 36 coherent months; change only from rate/performance/report evidence | Phase 1 |
| Coverage gate | Approve 100% Tier 1 and critical reports, 85% API-addressable, 80% remaining in-scope reports with reviewed exceptions | Phase 1 |
| Unsupported features | Track as manual-only with evidence rather than fabricate automation | Phase 1 |
| UI direction | Approve calm, dense, desktop-first operational UI with adaptive narrow workflows and restrained materials | Phase 2 |
| Design approval | Require `DESIGN.md`, `DESIGN.html`, six prototypes, desktop/mobile evidence, and accessibility review before broad build | Phase 2 |
| Application authorization | Replace two coarse roles with realm memberships and server-enforced permissions | Phase 3 |
| Connection ownership | Prefer one realm-owned flagship connection with members, subject to security/migration design | Phase 3 |
| Automatic production schedule | Keep off by default; separate approval only after stable manual evidence | Phase 7 |
| Destructive QBO management | Entity-specific policies only; no generic delete/editor | Phase 9 |

### 35.2 Decisions deliberately deferred

- exact scale-profile counts;
- precise list of API-writable features and reports;
- connection encryption mechanism;
- whether a query-cache or component-workbench dependency is justified;
- whether any checkpoint function survives the final cutover;
- whether a future issue-scenario or AI phase is ever built.

These are deferred because Phase 1, Phase 2, or Phase 3 evidence is necessary. Deferral is not permission to choose silently during implementation.

## 36. Rebuild definition of done

The rebuild is complete only when all statements below are supported by current evidence.

### Product truth

- The primary UI and documentation describe continual realistic data, coverage, reports, reconciliation, and management.
- AI, issue scenarios, and checkpoints are not required for a normal workflow.
- The flagship company has an approved business blueprint and explainable identity.

### Data and continuity

- The approved historical horizon is populated with coherent lifecycles.
- The business calendar has no unexplained gaps or overlaps.
- Forward operations are resumable, idempotent, bounded, and auditable.
- App-managed and manual/external records are distinguishable.

### Feature and reports

- The capability and report registry contains no release `Unknown` states.
- Tier 1 and critical-report gates pass.
- Manual-only and unavailable capabilities have honest procedures/explanations.
- Reconciliation and close status do not overclaim what QBO confirms.

### Management and safety

- In-scope QBO data is fully paginated and inspectable.
- Approved mutations follow entity policy and operation preview.
- App records, users, permissions, connection, settings, and audit have governed administration.
- Realm/environment/permission/preview/idempotency/audit controls are server-enforced.
- Secrets and sensitive payloads are protected.
- Production automation is either explicitly approved with evidence or remains disabled.

### UI/UX

- New information architecture and shell are the default.
- The design system is documented and compiled into shared tokens/components/tests.
- Six critical workflows and all P0 screens pass desktop/narrow, keyboard, accessibility, state, and visual evidence gates.
- Information remains precise and dense on desktop without becoming unusable on touch/narrow screens.
- Materials, motion, and delight reinforce hierarchy and recovery rather than decorate data.
- The public UI uses approved product naming.

### Engineering and operations

- Relevant static, unit, property, contract, migration, component, accessibility, visual, and end-to-end tests pass.
- Approved sandbox and production canaries have recorded evidence.
- Failure/restart/rate-limit/partial-operation recovery tests pass.
- Operator and recovery documentation is current.
- Known limitations and exclusions are visible and approved.
- No P0/P1 unresolved defect, unexplained accounting discrepancy, or false coverage claim remains.

## 37. Plan scrutiny rubric

Reviewers should fail this plan or a later phase if any answer is “no.”

### Mission

- Does the work primarily improve continual realistic data, QBO breadth, reports, reconciliation, or governed management?
- Can a support agent still reproduce problems manually without learning an automation ritual?
- Are future experiments prevented from quietly reclaiming core priority?

### Evidence

- Is the claim based on current source, current official capability research, or recorded live evidence?
- Are unknown, unsupported, manual-only, partial, and verified states separated?
- Is a successful API call distinguished from a meaningful accounting/report outcome?

### Safety

- Is the exact realm/environment visible and server-trusted?
- Is every mutation previewed, permission-checked, bounded, idempotent, and audited?
- Can partial success and recovery be explained without guessing?
- Does the work avoid secrets, uncontrolled startup writes, and default production automation?

### UI/UX

- Does the design follow the user's task and context rather than imitate Apple aesthetics?
- Is the desktop workflow dense and precise while narrow layouts remain safe and usable?
- Are all states, keyboard use, focus, contrast, resizing, reduced motion, and error recovery designed?
- Is visual approval based on rendered evidence and control reachability?

### Delivery

- Are dependencies and phase gates explicit?
- Is legacy data preserved until a retention decision?
- Is rollback defined in application terms without pretending QBO writes disappear?
- Are tests proportional to accounting, authorization, and production risk?

## 38. First implementation slice after approval

The shortest safe first slice is documentation and discovery, not generation code:

1. approve or revise the decisions in section 35;
2. update `prd.md`, `roadmap.md`, product naming, and legacy-feature status;
3. create a versioned capability/report inventory schema and a human-reviewable catalog artifact;
4. verify the current official QBO Advanced Canada API/report/user/reconciliation surface;
5. decide the flagship business profile and Tier 1 list;
6. create `DESIGN.md`, `DESIGN.html`, the component/state matrix, and critical workflow prototypes using fixtures;
7. return with Phase 1 evidence and Phase 2 rendered designs for approval before any new QBO mutation path is built.

This sequence answers the two biggest unknowns first: **what QBO can actually cover** and **what operating experience the rebuilt app should provide**.

## 39. Final recommendation

Approve the product reset in principle, but do not approve a production data build yet. First pass the capability/report discovery and design-system prototype gates. Those two gates are what prevent this from becoming either another shallow generator or an attractive interface over the wrong product.

The correct target is ambitious but coherent: a flagship company that behaves like a continuing Canadian business, an application that can prove what that company covers, and an interface that makes consequential operations understandable and recoverable.
