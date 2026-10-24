# Product Requirements — Test Data Lab

**Version:** 3.0
**Status:** Approved product contract; rebuild underway
**Approved:** 2026-08-08
**Current completion plan:** `docs/plans/continuous-business-operator-completion-2026-10-24.md`

## 1. Product statement

Test Data Lab is a local control and visibility application for maintaining one flagship QuickBooks Online Advanced Canada company as a believable, continually evolving business.

Owner direction, 2026-10-23: the in-app agent owns the fictional medium-sized business as head accountant, manager, consultant and decision maker. The owner has complete UI tools to inspect, manage, direct and override the business. While the server runs, continuous company monitoring and recurring hourly business decisions operate independently of browser tabs, with no end date or application-imposed lifetime transaction quota. This is an ongoing troubleshooting, teaching and learning company. Useful specialist agents may loop within their responsibilities and report to the main accountant, who remains accountable end to end; their benefit must substantially outweigh their coordination and maintenance cost.

The app must keep its company view synchronized with QBO, show data freshness and failures, retain decisions and unfinished obligations, and verify results. The owner can use both manual and agent-assisted troubleshooting. Individual work passes remain bounded for reliable execution and recovery; those bounds do not end the business or impose a lifetime activity ceiling.

The practical mental model is:

`business blueprint -> coverage requirements -> controlled operations -> QBO records -> report and reconciliation evidence`

## 2. Problem

A useful support company cannot be a pile of random transactions. It must have a stable identity, broad enough feature coverage, meaningful history, current activity, and balances that can be explained through records and reports.

The current application contains valuable foundations—OAuth, a QBO client, production confirmation, basic seeding and generation, inspection, audit records, protected routes, and UI primitives—but it is organized around a narrower workflow. Checkpoints, five sample issue packs, and AI currently receive more product prominence than continual business operations, coverage, reports, reconciliation, and governed data management.

The rebuild corrects that priority without deleting the existing code or data prematurely.

## 3. Primary outcomes

The rebuild must deliver:

1. A versioned business blueprint for a recognizable Canadian company with service/project, inventory/wholesale, and recurring-service lines.
2. A versioned capability registry that distinguishes product support, API support, manual-only work, prerequisites, coverage state, evidence, and known limitations.
3. A linked report catalog that proves reports are available, populated, plausible, and reconciled instead of treating an HTTP success as coverage.
4. Coherent historical lifecycles across an evidence-backed horizon, initially planned around 36 months.
5. A durable business calendar and operation system that can preview, authorize, execute, stop, recover, and resume bounded work without gaps or duplicates.
6. Fully paginated inspection for supported QBO data plus governed, entity-specific mutations.
7. First-class administration of application data, memberships, permissions, connection context, settings, and audit evidence.
8. Reconciliation and period-close workflows that clearly distinguish app-tracked, inferred, manually verified, and QBO-confirmed state.
9. A calm, dense, desktop-first interface with safe narrow layouts, keyboard access, visible scope and consequence, and complete operational states.
10. A normal manual support-reproduction workflow that does not require checkpoints, issue packs, or AI.

## 4. Users and authority

| Persona | Main job | Intended authority |
| --- | --- | --- |
| Lab owner | Defines the business, approves coverage, production operations, schedules, roles, and destructive policies | Full application administration |
| Lab operator | Previews and runs approved operations, monitors continuity, manages permitted records, and records evidence | Scoped create/update authority |
| Support agent | Reproduces issues manually and inspects records and reports | Read access plus narrowly approved manual lab activity |
| Reviewer/auditor | Verifies coverage, reports, operations, and audit history | Read-only |

Application permissions and QBO-company roles are different things. The server must enforce application permissions. QBO users and roles are part of the coverage catalog and may require a manual procedure if the current API cannot manage them.

## 5. Normal workflow

1. The operator confirms the active company, realm, and Production/Sandbox environment.
2. The operator reviews business-calendar freshness, coverage gaps, report health, and blocked work.
3. The operator previews a bounded operation against a specific blueprint version and business period.
4. The server re-checks realm, environment, permissions, prerequisites, source state, operation budget, and preview fingerprint.
5. Approved steps execute with idempotency and durable evidence; partial effects remain visible.
6. Reports and reconciliation evidence validate the resulting accounting story.
7. A support agent can then reproduce a customer condition manually in the surrounding realistic company.

Continuous monitoring and autonomous business management are core product requirements. They begin through explicit company-scoped owner controls; standing owner authority covers routine work within the published business policy. Exact execution, accounting-period, current-access, audit and uncertain-write protections remain mandatory. Implementation does not itself activate Production monitoring or accounting writes. The current implementation boundary and remaining adaptive-activity work are recorded in docs/architecture/business-agent.md.

## 6. Product requirements

### 6.1 Business blueprint

- Published blueprint versions are immutable.
- The blueprint defines business identity, chart of accounts, segments, Canadian tax assumptions, master-data populations, lifecycle cadence, seasonality, exception rates, close policy, report targets, and scale profile.
- Draft, review, publish, replace, and retire are explicit states.
- A change to a published blueprint creates a new version; it does not silently rewrite history.

### 6.2 Capability and report coverage

- Every relevant capability is exactly one of `covered`, `partially-covered`, `manual-only`, `unavailable`, `deferred`, or `unknown`.
- `unknown` is allowed during discovery and forbidden at release.
- Product availability, API operations, current-app implementation, dataset coverage, and evidence are separate facts.
- Tier 1 is the business spine. Tier 2 adds meaningful breadth. Tier 3 covers uncommon and scale cases.
- Every report lists prerequisites, periods, dimensions, expected sections, assertions, tolerances, and manual UI instructions where needed.
- Report validation levels remain distinct: availability, populated, plausible, reconciled, and manually verified.

### 6.3 Managed data and provenance

- App-managed, manually created, imported, adopted, and unknown/external records are distinguishable.
- Stable logical keys and deterministic operation inputs prevent blind duplication.
- Observation data is minimized; Test Data Lab does not clone QBO into MongoDB.
- Existing legacy records remain preserved until a separate retention or migration decision.

### 6.4 Continual operations

- The company has a persistent business date and generation cursor.
- Completed work cannot create an unexplained period gap or overlap.
- Every mutating run has a preview, immutable fingerprint, operation budget, durable steps, lease/heartbeat, stop state, and recovery path.
- Ambiguous timeouts trigger discovery and adoption checks before retry.
- Backend startup does not automatically schedule or execute QBO mutations.

### 6.5 QBO and application-data management

- Supported QBO entity lists are fully paginated and expose freshness, source, sync status, and supported actions.
- Mutation policy is entity-specific; there is no generic delete or generic raw-object editor.
- Application records, memberships, permissions, settings, connection health, feature flags, operation history, and audit history have governed administration surfaces.
- Raw tokens, provider keys, secrets, and authorization headers never appear in responses, logs, fixtures, or exports.

### 6.6 Reports, reconciliation, and close

- Critical financial and operational reports are populated by deliberate prerequisites, not incidental volume.
- Assertions compare related reports, accounts, lifecycle records, and expected tolerances.
- Reconciliation status identifies whether it is app-tracked, inferred from API data, manually evidenced, or confirmed in QBO.
- Closed or reconciled periods reject prohibited operations server-side.

### 6.7 Interface and accessibility

- The primary navigation becomes Overview, Plan, Operate, Data, Reports, and Admin.
- The global scope strip keeps company, realm, environment, business date, connection, and active-work state visible where consequences matter.
- Desktop layouts prioritize precision and information density; narrow layouts preserve scope, consequence, reachability, and recovery.
- All primary workflows cover empty, ready, partial, stale, loading, permission, connection, rate-limit, upstream-error, network-error, and partial-success states.
- Approved workflows meet WCAG 2.2 AA, keyboard, focus, zoom/reflow, reduced-motion, and forced-colour expectations.

## 7. Safety contract

Every QBO mutation must be server-authorized, visibly company-scoped, environment-scoped, previewed, bounded, idempotent, and audited. Production work additionally requires explicit production permission and confirmation. The app must never imply that rollback can erase an already accepted QBO write; recovery means stop, inspect, adopt, compensate where safe, and resume deliberately.

Live QBO or database verification is never assumed by implementation work. Each live check must state its objective, exact company/realm/environment, expected calls and records, budget, cleanup or compensation plan, stop condition, and evidence before approval.

## 8. Release measures

The percentage targets below are retained August rebuild benchmarks, not the completion definition for the current business-operator work. Use the current completion plan’s requirement-level responsibilities, journeys and direct proof as the finish line. Reassess historical catalog counts and percentages only where they serve that outcome; they must not silently expand or narrow it.

| Measure | Release gate |
| --- | ---: |
| Relevant capabilities classified | 100%; no `unknown` entries |
| Tier 1 capabilities covered or manual-only with evidence | 100% |
| In-scope API-addressable capabilities covered | At least 85%, with approved exceptions |
| Critical reports covered | 100% |
| Remaining in-scope reports covered | At least 80%, with approved exclusions |
| Calendar gaps or overlapping business dates | 0 |
| Duplicate app-managed records after replay tests | 0 |
| Mutations missing realm, environment, operator, idempotency, or audit attribution | 0 |
| Unrecoverable run states in the tested failure matrix | 0 |
| Critical accessibility or keyboard-blocking defects | 0 |
| Tier 1 destructive actions without preview and explicit confirmation | 0 |

Scale counts are set only after sandbox rate, latency, storage, and report-performance evidence. Large means a tested operating profile, not a vanity record count.

## 9. Explicit non-goals

- Replacing the QBO bookkeeping interface or becoming a second ledger.
- Cloning every QBO field into the application database.
- Requiring AI for manual inspection or supported owner management. Autonomous business operation is core; autonomous case reproduction follows section 10. Broader support-diagnosis capabilities are not implied.
- Generating arbitrary volume without an explainable business narrative.
- Claiming capability from an entity's existence or report coverage from HTTP 200.
- Generic destructive management, uncontrolled background writes, or default production automation.
- Payroll-detail automation without an approved API/privacy design.
- Copying Apple's brand, proprietary assets, or phone-first conventions.

## 10. Legacy and experimental features

- **Checkpoints and diffs:** deferred. Preserve existing records and code; do not expand them during the core rebuild.
- **Existing issue packs:** legacy/experimental. Preserve definitions and runs, but do not present the five examples as representative support coverage.
- **Legacy AI investigation and notes:** preserve their code/data and existing boundaries. This legacy classification does not apply to the core business accountant or the separately approved autonomous reproduction workflow.
- **Historical owner direction, 2026-10-02 (approval behaviour superseded below):** AI-driven issue reproduction is now the app's primary workflow. The operator describes a customer issue; the assistant reads the company and queues the creates, sparse updates and voids needed to recreate it (no deletes). Every change still runs only after the operator approves the plan, with production confirmation and audit. The assistant can use the owner's Codex CLI (ChatGPT subscription) or an Anthropic key. See `docs/design/ux-overhaul-2026-10.md`.

- **Owner direction, 2026-10-05:** A connected company is authorized for the app's reproduction purpose. Submitting a case starts autonomous setup, case-owned transaction changes (including deletion when needed for the experiment), readback and evidence checks without repeated approval. The app must distinguish reproduced, not reproduced in the tested actions, and unverified. Legacy plan execution retains its approval rules. See [the implementation and verification boundary](docs/architecture/autonomous-reproduction.md).

These routes remain an implementation baseline during migration. Their presence in source does not make them rebuild priorities or release evidence.

## 11. Approved direction and deferred decisions

Approved direction includes the Test Data Lab public name, continual flagship-company mission, service/project plus inventory/wholesale plus recurring-service business shape, an initial 36-month planning horizon, the coverage gates above, manual-only classification for unsupported features, the dense adaptive UI direction, realm memberships with server-enforced permissions, one realm-owned flagship connection, production scheduling off by default, and entity-specific destructive policies.

The following remain evidence-gated: exact scale counts, the precise writable feature/report list, connection encryption design, new frontend dependencies, final checkpoint disposition, and new issue-scenario or AI capabilities beyond the already requested business accountant and approved reproduction workflow.

## 12. Delivery and launch boundary

The current completion sequence and requirement-level acceptance evidence are in `docs/plans/continuous-business-operator-completion-2026-10-24.md`. The old August phase sequence is historical. Existing authorization, independent review, new-direction acceptance and live-company safety gates remain in force. For new QBO mutation workflows, sandbox integration precedes a bounded Production canary unless an explicit target-specific owner decision approves a different validation path. Reuse valid prior evidence rather than repeat a passed gate solely because the plan changed. This plan does not activate accounting writes. Product completion requires direct evidence of the intended owner outcomes.

The product launches as a local, internal operational tool for the approved flagship company. Expansion to other companies, public packaging, payroll automation, or support automation beyond the already approved reproduction workflow requires a separate proposal.
