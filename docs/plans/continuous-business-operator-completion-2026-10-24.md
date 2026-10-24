# Complete the continuous business operator

Prepared: 2026-10-24 (America/Halifax). Repository: Test Data Lab, C:/Projects/qbo. Planning baseline: main at 9f157d1, plus the concurrent uncommitted work inspected on this date.

Status: detailed delivery plan; implementation and live acceptance are unfinished. This document does not activate monitoring, autonomous accounting, provider calls, services, database migrations, or QBO writes.

## 1. What this plan includes, and why

This plan covers the complete intended outcome recovered from the owner's October 23 conversation, not merely the earlier recommendation to improve the accountant and remove its history dependency. It also includes the supporting engineering, safe transition, interface work and direct evidence necessary to deliver that outcome.

Include work for one of these reasons:

1. The owner explicitly requested the experience.
2. An existing accepted product requirement is necessary to make that experience useful.
3. Safety, correct accounting, continuity, QBO constraints or truthful verification require it.

Do not use this plan to absorb every finding from the original end-to-end review, modernize unrelated code, expand JE, add hypothetical customers/devices, or build every possible accounting feature before useful delivery. A new item must identify the owner outcome it advances and the smallest direct proof. Necessary dependencies belong here; unrelated improvements do not.

This is Test Data Lab's accountant and business operator. JE and its assistant Alfred are separate. No JE integration, shared memory, provider-policy transplant or cross-project access is implied. The shared principle is accountable coordination and verified follow-through; this plan implements it within Test Data Lab's own boundaries.

### The observable finish line

The owner can leave the server running, close the browser, return days or weeks later, and find a believable medium-sized Canadian business that has continued operating in QBO. The accountant understands the whole business, makes and executes appropriate decisions within saved authority, retains unfinished obligations, investigates problems, verifies accounting results, and explains what happened and what comes next. The owner can inspect, troubleshoot, teach from, direct and manually manage that business without reconstructing its state from scattered logs or coding-agent chats.

No fixed business end date or application-imposed lifetime transaction quota applies. Individual operations remain bounded. Browser closure must not stop enabled work. Server downtime means no execution while the server is down; a later restart must recover safely and show the actual gap, rather than claim continuous uptime.

This does not promise mathematical instantaneous synchronization, every QBO UI feature through one API, infallible AI judgment, or zero future owner decisions. These limits must be visible and handled, rather than used to redefine the promised business operator as a narrow generator.

## 2. Recovered intent and decisions that must survive implementation

Original evidence: Codex session 01a16920-67c6-7a60-b5bd-dcb2beb06341, started 2026-10-23 at 11:18 Halifax. Its owner messages were read directly. Keep the private transcript in its original local session storage; do not commit it or raw company records to the repository.

| ID | Owner requirement or decision | Consequence for delivery |
| --- | --- | --- |
| R01 | Maintain a test QBO account as a real business for Intuit troubleshooting, teaching and learning | Business coherence and support usefulness matter more than record count |
| R02 | A medium-sized business with continued hourly activity; very active all the time | Recurring decisions must produce appropriate meaningful business work; a heartbeat or review summary is insufficient |
| R03 | An in-app agent orchestrates the whole thing | The main accountant owns goals, dependencies, action, verification and follow-up |
| R04 | Head accountant, business manager, consultant and decision maker | Include financial analysis, operational choices, obligations and advice, not only scheduled transactions |
| R05 | All tools and expertise necessary for the app's intent | Build a responsibility-to-tool-and-knowledge map; do not treat a role prompt as demonstrated competence |
| R06 | The owner is also a decision maker | Retain instructions, overrides and answers; apply them to future decisions and pending work |
| R07 | Complete UI/UX tools for the owner to manage the same intent | The manual path must be useful and complete for supported responsibilities; links to unfinished pages do not satisfy it |
| R08 | Autonomous while the server runs for days/weeks | Persist work, scheduling, receipts, leases, authority and restart recovery independently of browser tabs |
| R09 | No end date or maximum total transactions | Batches and safety budgets limit a pass, not the lifetime business; continuation is explicit |
| R10 | Sync with QBO at all times and provide real-time monitoring, dashboards and data | Maintain current observations, detect external changes, show freshness and catch-up honestly |
| R11 | Show what happened, what is unfinished and where to continue | Present a coherent current operating picture with evidence and actionable recovery |
| R12 | Exceed the expected UI/UX and journeys | Prioritize useful desktop content, clear consequences, complete return paths and understandable states |
| R13 | Optional specialists only when benefit substantially outweighs implementation/management overhead | Main accountant must work without them; add or enable them only for a measured advantage |
| R14 | Specialists loop in their areas and report when necessary; main accountant accountable end to end | Persist recurring responsibilities, reports and follow-up without duplicate accounting writers |
| R15 | Implement the discussed intent, not the agent's whole original review list | Unrelated review findings stay separate unless they block one of these outcomes |
| R16 | Live approval at the end of the original chat enabled read-only monitoring only | It did not activate the accountant or authorize new live accounting writes |

The earlier historical business contract also contributes accepted foundations: one flagship QBO Advanced Canada company; service/project, inventory/wholesale and recurring-service divisions; broad useful feature/report coverage; governed data management; report and reconciliation evidence. The historical 36-month planning horizon is an initial history target, not an expiry date. Refresh what was accepted, what exists and what remains before scheduling any more history.

Newer owner direction supersedes old statements that make AI experimental, optional as an operator, or outside the core business loop. Preserve optional manual operation. Existing reproduction authority is distinct from business-operation authority; neither may silently inherit the other.

## 3. Evidence baseline: what exists and what remains unproved

Evidence labels used throughout this plan:

- **Source observed:** read in the current working tree. This proves wiring or a restriction, not live success.
- **Historical observation:** recorded direct outcome from an earlier session; refresh before a consequential present-state decision.
- **Proposed:** implementation or acceptance work described here.
- **Unverified:** direct proof is absent from this planning turn.

### Current source observations

| Area | Actual foundation | Gap or proof still required |
| --- | --- | --- |
| Company monitoring | 28 supported sources, persisted per-source synchronization, paged bootstrap, deletion reconciliation, catch-up and source freshness | Fresh live parity, deletion/external-change observation, API-consumption evidence and endurance |
| Background operator | Server-owned worker, saved controls, leases, main-accountant passes and optional specialist passes | Sustained useful work, restart/failure recovery and meaningful prioritization across all responsibilities |
| Model/tool loop | Scoped internal reads, reports, governed period preparation/execution, decisions and short operating memory | Full business context, durable obligations, coverage access, appropriate workflow tools and demonstrated expertise |
| Additional adaptive activity | Local uncommitted business-activity-batch implementation supports settled service sales and immediately paid non-stock expenses | Fresh tests/reviews/rendering; broader activity and cross-pass business lifecycles |
| Dated activity | Published templates include service, stock and recurring-service chains; later versions add partial/late collections and credits | Adaptive operation beyond a fixed monthly recipe; production acceptance of gated variants |
| Existing-history barrier | Agent preparation refuses population-owned, uncertain, stopped, retained-operation and uncommitted-history states | Safe evidence-backed transition from the actual existing company; no blanket guard removal |
| Owner workspace | Company overview, synchronization status, balances, accountant controls, directions, decisions, activity and management links | Complete task journeys, management breadth, meaningful current/next work and rendered live proof |
| Broader app tools | Coverage/change-summary and reproduction capabilities exist elsewhere | New accountant tools omit coverage/change-summary; linking a case does not execute it |
| Accounting engine | Native operation, compiler, receipt, writer-fence, report, stock, tax and recovery modules exist | Reuse and extend them; prove each new workflow through QBO records and financial evidence |

Important inspected paths:

- backend/src/modules/business-agent-engine.js: role instructions, short memory context, bounded model/tool passes.
- backend/src/modules/business-agent-tools.js: six reused read tools, obligations reads, governed operations, decisions and case linking.
- backend/src/modules/business-agent-policy.js: monitoring/autonomy controls, grant and business blockers.
- backend/src/modules/business-agent-service.js and business-agent-store.js: worker scheduling, leases, context, events and current state.
- backend/src/modules/business-agent-sync.js: 28 sources, CDC/snapshot handling, source-specific freshness; TimeActivity has at least a five-minute refresh interval.
- backend/src/modules/business-activity-batch.js: two same-day workflows with immediate settlement; requires verified history through yesterday.
- backend/src/modules/business-activity-preview.js: recurring templates, dated business rules and gated credit variant.
- frontend/src/pages/BusinessWorkspace.jsx and components/BusinessActivityComposer.jsx: current operator and manual-activity surface.
- backend/src/modules/ai-tools.js: broader tools not automatically available to the accountant.

### Historical live observations: do not promote to current facts

The original October 23 work recorded 28/28 monitoring sources current and the accountant paused. The older full-goal evidence records populated and repaired history with 10,359 original core records, while explicitly withholding verified calendar/report/reconciliation completion. These are useful leads, not a fresh audit of today's company or permission to replay anything.

Earlier records also document a conflict between an owner statement about filed returns and observed QBO UI filing entries. The full-goal handoff subsequently records renewed creation-only authority; the older blanket hold must not be imposed again on that already granted scope. Later work must establish the actual current protection policy and source evidence, including later resolutions and the distinction between routine new creates and changes to existing/protected records. Do not reuse either a stale assertion of no protections or an old conflict as a new factual claim. Do not resume backdated writes merely because the account is called a test company.

### Concurrent work and evidence limits

At planning time, many operator and Coverage files were modified or untracked. The additional activity work is not certified by earlier foundation tests. Preserve all concurrent work. Do not commit another session's files or claim this plan's source review validated the whole uncommitted implementation.

This planning turn makes no live QBO reads/writes, database changes, provider calls, app-service changes or rendered-app acceptance claims. No app tests were run to infer readiness. Re-read Git and overlapping files before implementation.

## 4. Scope boundaries and decision register

### Required work

All R01-R16 outcomes, safe use of existing history, coherent continuing business activity, sufficient feature/report breadth, accountant tools and expertise, persisted obligations and owner decisions, monitoring, complete owner journeys, failure recovery and direct acceptance evidence.

### Explicitly separate or conditional work

- Specialists are conditional on benefit. The default successful system may use only the main accountant.
- Webhooks are an implementation option, not a condition for calling continuous synchronization implemented. Prove polling adequacy and costs first.
- Payroll, bank-feed matching, official reconciliation/tax filing and other restricted/native-only capabilities require a feature-specific access assessment. Do not impersonate official QBO completion with an app flag or a journal entry.
- Third-party messaging, real payments, invoice emailing, bank movement, tax submission, new paid subscriptions and access upgrades are outside routine fictional activity unless separately authorized.
- JE/Alfred integration, multi-company expansion, public SaaS packaging, mobile redesign, checkpoint expansion, unrelated Coverage redesign and generic framework replacement are outside this plan.

### Decisions: when they are actually needed

| ID | Decision | Working treatment until resolved | Dependent gate |
| --- | --- | --- | --- |
| D01 | Current company identity, environment, protection facts and live authority | Read saved evidence without assuming sandbox or accounting-write approval | Any live execution |
| D02 | Exact existing-history settlement/adoption disposition | Preserve IDs, receipts and original blocked/stopped work; prepare a reviewable reconciliation proposal | Calendar advancement and dependent new writes |
| D03 | Medium-business operating profile: activity range, divisions, seasonality, realistic exception mix | Reuse published/accepted blueprint; propose explicit missing ranges from it | Broad adaptive activity rollout |
| D04 | Routine standing-authority classes and boundaries | Draft understandable classes, bounded operation capacities and prohibited actions; do not enable them | Autonomous accounting activation |
| D05 | Which troubleshooting situations the owner needs first | Reuse saved cases/coverage requirements; build representative examples before requesting a broad interview | Scenario prioritization, not core recovery work |
| D06 | Applicable API tier/allowance and model operating budget | Measure current use; no paid upgrade or provider switch | Cadence/cost acceptance |
| D07 | Native-only responsibilities and acceptable owner handoff | Classify honestly; retain actionable manual steps and completion evidence | Claiming that responsibility covered |
| D08 | Specialist net benefit | Leave optional specialists off unless evidence justifies them | Optional specialist activation |
| D09 | New visible direction if required | Reuse accepted design; present smallest coherent changed journey before broad adoption | Expansion of a materially new UI direction |

Do not ask all these questions before doing useful work. Recover existing answers first. Ask only at the dependent decision or authority boundary with a concrete proposal. Missing live approval does not stop non-live implementation, analysis, fixtures or review.

## 5. Target operating design

The business operator needs one persistent model of responsibilities and evidence, accessible to both the accountant and owner UI. This is application operating state, not a replacement financial ledger.

### 5.1 Separate the clocks and meanings

Maintain distinct fields and labels for wall-clock time, the Canadian business date/time zone, intended historical coverage, saved-record coverage, verified calendar coverage, last observed QBO change, source freshness, current open day and planned next review. A transaction date does not prove that all prior business work is complete. A complete source scan does not prove reconciled books. A completed model response does not prove completed business work.

For existing history, support an evidence-backed adoption/verification transition. For ongoing work, support open-day activity and future obligations without requiring all records to be fully settled in one batch. Keep close/verification separate from the ability to recognize and prepare due work safely. Necessary unresolved-writer and protected-period restrictions remain strict.

### 5.2 Durable operating records

Reuse current models where they fit. Add a small focused model only when the existing model cannot express the required invariant. The following are conceptual contracts, not a mandate for one collection per row:

| Record | Minimum durable content |
| --- | --- |
| Business objective/policy | Version, published blueprint, priorities, operating ranges, allowed actions, effective dates, superseded policy |
| Work item/obligation | Stable key, reason, responsible area, originating records, due/next-action time, dependencies, status, evidence, retries and last outcome |
| Business decision | Trigger, options, factual inputs and freshness, rationale, selected action, authority, owner override, affected work and verification status |
| Operation lineage | Decision/work keys, exact immutable plan, request identity, receipts, accepted record IDs, verification and recovery state |
| Business memory | Searchable retained decisions/facts/sources with effective dates, plus a short summary; original evidence remains retrievable |
| Monitoring state | Per-source cursor, completeness, freshness, lag, errors, requested/observed state and external-change classification |
| Coverage/evidence | Responsibility, QBO/API/app support, prerequisites, current dataset evidence, report quality and next action |
| Operational health | Worker heartbeat, oldest due work, failures/backoff, queue age, actual API/model usage, storage and last successful verification |

Work status must distinguish at least proposed, waiting for prerequisite, waiting for owner, ready, running, saved-awaiting-verification, verified, recoverable failure and retired/superseded. Use current state names where possible. An unresolved accepted write remains visible and blocks unsafe conflicting execution.

### 5.3 One accountable decision cycle

1. Confirm company/access/grant and current owner directions.
2. Read due work, retained decisions, current operations, source freshness, recent external changes, financial health and coverage needs.
3. Prioritize protection/correctness, recovery and due obligations before discretionary activity.
4. Identify independent useful work when another branch is blocked.
5. Select concrete business choices, their rationale and expected accounting effect.
6. Prepare an exact governed operation using deterministic rules.
7. Dispatch only if current authority and preconditions still hold at admission.
8. Verify actual saved records, relationships, amounts, tax, accounts and relevant reports.
9. Update obligations, outcomes and next actions from evidence, not the model's summary.
10. Retain a clear owner-facing explanation; schedule the next meaningful action.

A pass can end because it has no due work, is waiting for an external event, reached its safe slice capacity or needs a genuine owner decision. Persist the reason and continuation. Repeated summaries with no progress must trigger diagnosis rather than count as healthy activity.

### 5.4 Accountant knowledge and business context

The agent needs governed access to the actual blueprint, chart/account mappings, tax policy and dates, customer/supplier behavior, inventory rules, business goals, obligations, coverage catalog, report definitions, retained owner answers, known QBO limitations and verified previous outcomes.

Maintain task-specific operating playbooks: prerequisite checks, suitable choices, accounting expectations, common failure patterns, verification and escalation. Ground dated tax behavior and QBO constraints in relevant official references. Do not add unrestricted web/shell access as a shortcut. Where current evidence is missing, provide a bounded research/read path or retain a precise missing-capability item.

Prose memory is an aid, not the sole source of truth. Pagination and targeted retrieval must keep older important decisions reachable beyond the current 20-decision, 40-event and short-memory views. Structured owner decisions must not disappear because newer events arrived.

### 5.5 Tools and authority

Both the UI and agent should use the same governed domain services. Tools accept business choices and stable role/record references; the server compiles QBO requests. No generic raw-QBO-body write tool.

Every responsibility needs discover, inspect, prepare, authorize/execute where granted, verify and recover paths. Inapplicable or native-only steps must be explicit. Owner-granted routine authority avoids repeated plan approvals. Policy changes, destructive actions, existing-record changes, protected periods and external side effects retain their exact existing boundaries.

A saved grant must not silently acquire new workflow classes. Version and display the added capability, then use the smallest necessary grant renewal. Preserve original operation authorship; adopting old work requires an explicit reviewed transition, not rewriting it as agent-owned.

## 6. The deleted older plan and the active documentation

Owner direction in this conversation: delete the old rebuild plan because old plans cause confusion and waste time. The August 8 plan is removed; Git retains its history. Its old AI restrictions, manual-only operating model, phase sequence and progress claims are not current authority. Current PRD, safety rules and actual implementation already retain most useful principles. Do not recreate the deleted plan or copy its full backlog into this one.

Carry forward only a still-relevant owner decision or requirement that supports R01-R16 and would otherwise be lost. Reassess fixed counts, percentage targets, historical horizons, optional features and screen layouts against current needs and evidence. The complete old document was read for this relevance assessment; no section-by-section duplicate is needed.

During implementation, correct active contradictions in the PRD and roadmap and link this current delivery plan. Keep historical evidence dated. Do not turn an updated document into a claim of runtime completion. Existing reproduction authority remains separate; proposed changes here do not expand it.

## 7. Ordered delivery work packages

Each package must identify its current code, owned change, direct proof and residual gaps. Reuse working code. Do not restart from an empty company or mechanically rebuild existing modules. Required independent scope challenge comes before new mutation-architecture source writes; distinct implementation and safety reviews follow sensitive changes. A package can finish as a named slice without completing the whole product.

### W00 — Establish a trustworthy current baseline

**Outcome:** implementation begins from the actual company, concurrent code and saved authority.

1. Re-read current Git status, branch/upstream, changed operator files and the active session's handoff. Identify owned and concurrent work before edits. Preserve Coverage changes.
2. Read original saved operation/population receipts and later superseding evidence. Build a private, sanitized summary of current calendar, writer ownership, uncertain requests, old operations, population completion, protected-date facts and owner decisions. Prefer existing records before requesting new reads.
3. Resolve the distinction between saved/content-checked history, repaired relationships, accepted reports and verified business calendar. Record each independently.
4. Inventory active routes and currently usable owner journeys. Identify fake/fixture-only, disabled, partially integrated and working paths.
5. Map R01-R16 to observed source, direct live evidence, remaining gap and acceptance scenario. Do not infer missing code solely from missing documentation.
6. Identify the running app/configuration read-only if live inspection is authorized. Never infer that a refused default port means the app is stopped; never start services as a review convenience.
7. Update the working ledger and choose the next smallest useful delivery slice. Do not make the owner repeat decisions already present.

**Likely inspection:** business-agent-*, business-population-*, business-period-*, business-writer-fence, business-runtime-access, current frontend journeys, FULL_GOAL_EXECUTION.md and dated private receipts.

**Proof:** a current source/authority/company ledger with every consequential fact sourced and every uncertainty visible. No new QBO record is required to complete the non-live baseline.

### W01 — Reconcile current direction and acceptance contracts

**Outcome:** agents and owner have one understandable current target.

1. Remove obsolete active pointers to the deleted August plan. Keep historical decisions as history, rather than a second governing backlog.
2. Correct the PRD's conflicting AI and autonomous-reproduction statements. Retain optional manual management while making the accountant a core operator. Do not broaden the already approved reproduction workflow.
3. Replace stale roadmap progress and sequence with requirement-based milestones from this plan, after checking what is actually implemented. Keep useful existing architecture/evidence references.
4. Define the first coherent vertical slice: inspect current state, identify one real due business need, make a grounded decision, prepare governed work, execute when authorized, verify and present a durable result. Include owner intervention and restart continuation.
5. Present the smallest rendered/testable changed direction if it materially changes the accepted experience. Reuse accepted design rather than reopening every screen.
6. Obtain an independent challenge of plan completeness, state transitions, accounting effects, safety and proof. Resolve material findings before source writes to a new mutation design.

**Files:** prd.md, roadmap.md, current plan and relevant architecture/evidence notes. Do not rewrite historical reports to claim new success.

**Proof:** no contradictory active authority; slice outcomes and exclusions are explicit. Owner acceptance applies to a new visible direction, not renewed approval of the already requested autonomous business mission.

### W02 — Safely settle existing history and establish forward continuity

**Outcome:** the existing populated company can become an ongoing business without rebuilding or discarding its records.

1. Reconcile the original job manifest, accepted creation receipts, repaired links, managed mappings, retained operations, writer state and calendar. Preserve original IDs and authorship.
2. Classify each retained operation as genuinely unfinished, saved awaiting verification, verified, superseded or safely retireable. Keep possibly-sent requests distinct from definitely unsent steps.
3. Define an audited adoption/settlement path for old population work that proves record identity, relevant content/relationships, financial/stock carry, dated policy, protected periods and report scope. Do not set verifiedThrough from counts or latest transaction date.
4. Distinguish retrospective completeness from safe present-day operation. Prefer evidence-backed adoption of existing history. If full historical acceptance cannot be established promptly, prepare a separate forward-cutover proposal with an explicit observed opening/carry, outstanding obligations, provenance and limited verification scope. Such a cutover requires a genuine owner decision if it changes accepted continuity expectations; it must not fabricate historical completion or erase unresolved old work.
5. A forward boundary may not bypass an unresolved company writer, uncertain write, conflicting active operation or prohibited date. Demonstrate independence before allowing a branch to proceed.
6. Settle ownership through the existing native writer/transaction boundaries. Do not remove population/history blockers wholesale, forge an agent origin, reset the calendar or invent a new grant for old work.
7. Verify continuity into the next open period and retain all future obligations from the adopted history. Settled history must not create duplicate collections, bills or stock orders later.
8. Show the owner what was adopted, what remains unverified, where future activity starts and exactly why.

**Likely files:** business-population-verification/service/proof, business-period-evidence/store, business-continuity-service, business-operation-recovery/retirement, business-recovery-ownership, business-writer-fence, business-agent-policy/tools, BusinessMaintenance and BusinessOperations. Select only the actual missing seam after W00.

**Proof:** original identities and receipts retained; no replay; genuine current writer state; approved continuity/cutover evidence; next safe activity can be prepared without pretending the company is empty. Native record/report proof requires its own authorized live checks.

### W03 — Make the business blueprint operational

**Outcome:** the accountant manages a recognizable medium-sized business rather than a fixed record recipe.

1. Expose the published blueprint and its effective policy to the accountant with targeted retrieval. Include divisions, customers/suppliers, pricing, terms, stock, accounts, tax, reporting and existing obligations.
2. Define practical operating ranges from current accepted business choices: demand, transaction mix, revenue/expense scale, normal cash, margins, inventory buffers, late/partial payment rates and seasonality. Propose missing choices; do not treat the old 278-record monthly template as the business target.
3. Honor the requested continued hourly/very active behavior. Model appropriate ongoing work, including asynchronous activity where justified. Do not silently restrict activity to office hours. Do not manufacture pointless expenses, circular cash or duplicated obligations to fill a quota.
4. Add scenario variation through reproducible business choices: customer behavior, supplier timing, order size, service progression and exceptions. Persist the chosen inputs and seed/version where relevant so results remain explainable.
5. Make business-health thresholds specific enough to guide action: cash pressure, overdue debt, slow stock, margin changes, tax/report discrepancy and insufficient troubleshooting breadth.
6. Version policy changes and show their future effect. Never rewrite old posted history when a strategy changes.

**Likely files:** blueprint/definition services, business-activity-preview/details, business-policy-amendment, business-agent-store/tools and blueprint/management UI.

**Proof:** the accountant can explain the business, identify an appropriate next action from current facts and vary activity coherently across all three divisions. Sample choices have understandable economic causes and expected effects.

### W04 — Persist obligations, priorities and business decisions

**Outcome:** work remains known until it is genuinely settled, regardless of prompt size or restarts.

1. Add/reuse a durable work/obligation structure with stable business keys, originating records, due date, dependencies, next action, responsible area, authority and evidence.
2. Represent future collections, supplier payments, replenishment, recurring renewals, close/report checks, manual-only work and troubleshooting follow-ups as first-class work.
3. Paginate and prioritize work. Include overdue/blocked items outside the most recent 20 decisions or 40 events. A short prose memory must not be the only way to recover an older commitment.
4. Deduplicate by the underlying issue and business lineage. Reconsider an item when new evidence materially changes it; do not spam repeated owner questions or silently ignore a changed situation.
5. Apply authenticated owner overrides to affected planned work, invalidate stale preparations where necessary and retain what was superseded. Already-sent work keeps its actual receipt and outcome.
6. Separate routine decisions made under standing authority from owner-required factual/policy decisions. Present genuine choices with consequences and suggested actions.
7. Reconcile obligations with external QBO changes before execution. An invoice paid manually must not be collected again.
8. Persist enough state to continue after an incomplete model pass. Verify work progress independently of the model's declaration that its review is complete.

**Likely files:** BusinessAgent/Event and operation models, business-agent-store/service/tools/engine; focused work-item model/service only if required; owner decision and activity components.

**Proof:** old pending work remains retrievable; a direction changes future behavior; an external settlement closes the right obligation; an interrupted pass resumes the same work without duplicates.

### W05 — Supply the accountant's tools, knowledge and judgment checks

**Outcome:** the main accountant can discover and use the information and actions required for its responsibility.

1. Build the responsibility matrix in section 8 against the actual capability registry and current QBO Canada/Advanced access. Record supported, incomplete, native/manual-only and unavailable actions separately.
2. Give the accountant scoped access to coverage requirements, report definitions, observed changes, blueprint details, managed provenance, obligations and full saved decisions. Reuse getCoverage/getChangeSummary contracts only after reviewing their current authorization, pagination and freshness.
3. Provide concrete domain actions to prepare/execute/verify/recover approved business workflows. Do not attach all of ai-tools.js or give reproduction/corrective powers through a broad allowlist.
4. Add maintained accounting/business playbooks for cash, AR/AP, inventory, Canadian tax, report interpretation, period work and troubleshooting. Reference source dates and known limitations. Keep current facts separate from advice and assumptions.
5. Add targeted retrieval rather than placing every record/report in every prompt. Tool results must disclose completeness, source time, currency, accounting basis and limitations.
6. Test judgment through task scenarios: chooses useful work, detects problems, declines unsafe/inapplicable actions, retains missing evidence and makes a practical recommendation.
7. Preserve saved provider selection, credentials and access policy. Diagnose effective provider/tool behavior before proposing changes. No model/provider upgrades or parallel model calls as a default fix.
8. Treat company descriptions, imported records, report text and retrieved material as untrusted data. They cannot grant authority or request unrelated actions.

**Likely files:** business-agent-engine/tools/store, ai-tools and existing read services, current provider/tool bridge; focused knowledge assets as needed. Provider access changes require their own review.

**Proof:** a responsibility-to-tool/knowledge table has no unexplained required gap; representative accountant decisions cite actual business facts and reach verified outcomes. A title, prompt paragraph or schema list alone fails acceptance.

### W06 — Expand governed business lifecycles beyond immediate settlement

**Outcome:** all important divisions and obligations can evolve across repeated passes.

Deliver each workflow as a vertical slice with decision inputs, prerequisites, deterministic compilation, authority, durable execution, verification, recovery and owner UI. Reuse dated templates where appropriate, but do not require every adaptive choice to be the next fixed monthly occurrence.

1. Service work: estimate/accepted-work progression, time or billable cost, invoice, terms, staged collections and deposits.
2. Recurring services: renewal/due schedule, invoice, realistic late/partial payment behavior and follow-up. Persist the next occurrence.
3. Receivables: inspect actual unpaid balances, choose legitimate full/partial settlement, apply eligible credits where supported, retain remaining debt and investigate unapplied states. Do not overwrite pre-existing records without appropriate authority.
4. Purchases/payables: business need or stock demand leads to order/bill, realistic due dates, full/partial payment and remaining obligation. Support non-stock operating expenses without generating meaningless overhead.
5. Inventory/wholesale: stock availability, replenishment, receipt/bill, sale, returns/credits where in scope, valuation and cost checks. Add adaptive stock choices without bypassing native stock carry or allowing unexplained negative quantities.
6. Banking: coherent grouped deposits, transfers, fees and other business-relevant activity supported by access. Ledger transactions are not real payment-processor/bank actions; avoid contacting external services or sending real money.
7. Accounting period work: justified accruals/reversals, prepaids or other material adjustments and close preparation where the business needs them. Never generate balancing entries merely to hide a discrepancy.
8. Credits/refunds/corrections: introduce only with exact source ownership, policy, approval and evidence. Preserve the existing Production gate on the unaccepted credit-template variant until its required proof exists.
9. Master-data maintenance: create or adopt customers, suppliers, items and compatible dimensions when a genuine new business need exists. Reuse existing roles before creating new parties; govern changes to existing records.
10. Preserve future obligations when a day closes. Calendar verification means required work for that date is represented and checked; it must not mean every customer has paid or every future supplier bill is settled.

**Likely files:** business-activity-batch/preview/details, business-lifecycle-policy, transaction-compiler, readback/graph/stock/tax services, operation candidate/preview/runner/period store; tools and manual composer/management UI.

**Proof:** section 8's required workflow rows pass actual end-to-end record/report acceptance; open balances survive and are acted on later; no unsafe widening of existing-record or case authority. Non-live fixtures do not certify a Production workflow.

### W07 — Make continuous synchronization sustainable and actionable

**Outcome:** both owner and accountant share an honest, current understanding of QBO, including external activity.

1. Verify every currently required source's bootstrap, pagination, updates, deletions, inactive records, singleton refresh, old-cursor recovery and saturated-change handling.
2. Define freshness separately by source and decision. Revalidate critical records immediately before writes. Do not let a slow, irrelevant source freeze every useful read or safe independent investigation; explicitly prove any narrowed write dependencies.
3. Measure actual API request use over complete operating cycles: synchronization, reports, lookups, verification, UI requests and recovery. Include shared developer-workspace allowances where applicable.
4. Tune polling, rotation, backoff and caching from observed change rate, required freshness and budget. Cache owner dashboards rather than fetching full reports on every view/poll.
5. Decide whether webhooks materially improve latency or cost enough to justify a reachable endpoint, signatures, event deduplication and recovery. If adopted, use them as change signals with catch-up; do not replace completeness checks.
6. Persist external-change events that can invalidate work: paid invoices, changed terms, new bills, item updates, deleted records or changed settings. Update affected obligations and plan fingerprints.
7. Show last observed, oldest required source, current catch-up progress, lag and next retry. A stale cached balance must not be presented as live truth.
8. Enforce data minimization and bounded storage growth. Review the current normalized mirror against the PRD's no-full-clone intent; retain only what operations/retrieval/evidence need, with access checks.

**Likely files:** business-agent-sync/service/store, CompanySyncRecord model, qbo-client, change-summary/coverage services, workspace hook and monitoring UI.

**Proof:** an authorized external QBO change appears within the documented measured freshness target and changes the right pending work; source loss/deletion/large catch-up stays truthful and recovers; the chosen cadence fits actual allowance.

### W08 — Accounting verification, coverage and proactive management

**Outcome:** the accountant detects and explains real business problems and maintains useful company breadth.

1. Link every important workflow to expected accounts, tax, balances, stock and transaction relationships. Preserve exact original receipts and independent readbacks.
2. Build/complete the relevant report checks: P&L, Balance Sheet, Trial Balance/ledger, AR/AP aging, cash/bank activity, inventory valuation/quantity and Canadian tax evidence, with applicable dimensions and periods.
3. Record accounting basis, date scope, currency, source time and tolerances. Compare related reports and native records. A report endpoint returning data does not establish coverage or correctness.
4. Feed meaningful coverage gaps and aging evidence into the accountant's priorities. Create a bounded plan or manual task to close a needed gap; do not manufacture every catalog variant indiscriminately.
5. Proactively investigate cash pressure, overdue receivables, supplier risk, stock shortages, margin anomalies, stalled work and stale/mismatched evidence. Retain recommendations and verified follow-up.
6. Provide period close/reconciliation preparation and native/manual completion evidence where necessary. Clearly distinguish app-tracked, inferred, manually observed and QBO-confirmed state.
7. Invalidate relevant evidence when external changes, backdated writes or policy changes affect it. Keep prior evidence as dated history.
8. Validate that the owner can explain why balances and report trends exist using the linked business activity.

**Likely files:** coverage, report-evidence services/contracts, business-baseline/report/financial/stock evidence modules, agent tools/context and Reports/management views.

**Proof:** representative real discrepancies are found and followed through; reports agree within documented tolerances; a useful coverage gap becomes an evidence-backed outcome. Unexplained differences remain visible, never patched merely for a green status.

### W09 — Connect ongoing operations to troubleshooting and learning

**Outcome:** the operating business is directly useful at the owner's Intuit job.

1. Map representative owner support questions to actual surrounding records, variants and report symptoms. Start with existing cases/catalog priorities; ask only for missing prioritization.
2. Let the owner move from a record, business anomaly or report discrepancy into a relevant troubleshooting case with company/period/record context retained.
3. Let the main accountant inspect case state and relevant results and suggest or prepare appropriate existing reproduction journeys. Starting/executing case work must use the case's authority, not a business grant.
4. Preserve manual troubleshooting without requiring AI. Explain the transaction chain, expected result, actual result, tested conditions and what remains unverified.
5. Identify intentional scenarios separately from unexpected business failures. Coordinate case-created changes with the company writer and monitoring so cases do not silently corrupt normal obligations or repeat collections.
6. Retain scenario purpose, test-owned records, before/after evidence and safe disposition. Cleanup is a separately governed change; no promise that rollback erases accepted QBO records.
7. Support teaching with understandable examples and traceable evidence. Avoid copying real customer details into the fictional company or prompts.

**Likely files:** current reproduction engine/policy/runner/assessment services, case routes/pages, agent read/coordination tools and provenance/coverage links. Reuse the working reproduction architecture rather than build another case engine.

**Proof:** the owner can investigate a realistic issue in the active business, trace its records/reports, run the already authorized reproduction flow when requested and distinguish reproduced, not reproduced in tested actions and unverified.

### W10 — Complete the owner operating experience

**Outcome:** the owner can understand, direct and manage the full intent from a coherent desktop application.

1. Design and verify every journey in section 9. Put useful business content and obvious next actions first; avoid introductory chrome displacing work.
2. Show what the accountant knows, why it chose work, what it is doing, actual saved/verified effects, pending obligations, genuine blockers and next action. Explain stale or incomplete observations.
3. Make the supported manual path use the same domain operations: choose business work, inspect consequences, execute under the owner's authority, verify and recover. A two-option activity composer is an initial slice, not the complete manual operator.
4. Provide record search/browse and linked details with complete in-scope pagination and readable accounting context. Exact IDs and sanitized diagnostics are secondary aids.
5. Give instructions, answer decisions, change priorities and inspect when those changes take effect. Preserve unsaved drafts and show conflicts without silent overwrites.
6. Make pause, stop-monitoring and execution-stop meanings distinct and truthful. Already-sent work remains visible. Recheck state after controls before claiming they succeeded.
7. Add precise deep links from attention items to the affected work, evidence or decision. A generic link to /company/manage must not be the only recovery guidance.
8. Cover relevant empty, ready, partial, stale, loading, disconnected, permission, conflict, rate-limit, provider-error and saved-unverified states. Do not treat an error/fallback state as the requested successful outcome.
9. Reuse the accepted design system. Obtain rendered independent review for material journeys and owner acceptance only when expanding a genuinely new visible direction. Desktop is the current target; do not reinstate the old mobile matrix.
10. Keep engineering internals out of normal business decisions. Put sanitized technical diagnostics behind useful detail paths.

**Likely files:** BusinessWorkspace, BusinessActivityComposer, BusinessOperations/Maintenance, explorer, reports, reproduction, audit, app routes/navigation and domain API clients. Scope changes to the journeys actually needed.

**Proof:** complete owner tasks at the actual desktop viewport against integrated behavior, including recovery and return paths. Screenshots of fixtures, navigation links and a successful build are insufficient for whole-journey acceptance.

### W11 — Endurance, restart recovery and operating cost

**Outcome:** the business keeps working through days/weeks of ordinary operation and recoverable disruption.

1. Test lease expiry, double-worker contention, shutdown/drain, restart at each dispatch/receipt/verification boundary, stale owner revision, revoked permission and changed connection/grant.
2. Prove at-most-once admission/accepted-effect preservation under ambiguous timeouts and partial batches. Discover and verify possibly saved work before retry; never retry merely because the model timed out.
3. Exercise provider outage, malformed/truncated model output, QBO rate limiting, partial sync, database interruption and verification failure using isolated fault injection. Never deliberately break the owner's live services or company to simulate failures.
4. Persist fair scheduling and next-action times. Protect due work and specialists from starvation; one recurring failure must not consume all review slots.
5. Detect repeated no-progress passes, increasing overdue work, stuck leases, missing heartbeat, unresolved accepted writes, excessive API/model use and storage growth. Show concrete recovery without alert spam.
6. Measure actual model/provider runs and available usage information honestly. Do not invent billing visibility. Reduce no-change model calls with due-work/change checks while preserving hourly business activity.
7. Provide current health, readable incident history and a recovery runbook. Keep necessary scheduling/startup inventory synchronized only when those components change.
8. Run staged unattended acceptance: initial integrated cycle, 24 hours, 72 hours, seven days and a second week. These are proposed proof checkpoints, not a lifetime limit or an excuse to wait before delivering useful slices. Agree meaningful activity/quality measures before the long observation; record actual elapsed time.
9. Include a real authorized service interruption/restart only when the owner explicitly requests that lifecycle action, or use a short-lived isolated stack owned by the test runner for fault proof. Do not stop persistent services yourself.

**Proof:** retained operating evidence across elapsed days/weeks, diverse useful activity, correct accounting, no duplicate accepted effects, preserved directions/obligations and successful recovery. Accelerated clocks prove scheduling logic, not two weeks of real unattended operation.

### W12 — Optional specialists, only after demonstrating value

**Outcome:** focused help improves results without making the owner coordinate agents.

1. Establish a main-accountant-only baseline first: results, missed issues, latency, cost and owner effort.
2. Evaluate existing receivables/payables/inventory roles against concrete failures or workload. Reuse them if useful; do not add more roles for appearance.
3. Give each role bounded relevant reads/tools, its own retained responsibility and recurring due work. Main accountant owns priorities and cross-domain tradeoffs.
4. Route material reports to main accounting work and track acknowledgement/follow-up. Do not rely on a small latest-report prompt window as the only report history.
5. Keep a single governed accounting writer. A specialist may investigate/propose; additional execution authority needs an explicit design and saved grant.
6. Compare with baseline and keep only demonstrably beneficial roles. Disabled/absent specialists must not remove the main accountant's required competence.

**Proof:** a measurable improvement in useful findings/outcomes or delay/cost, no duplicate work or owner routing burden, and complete reporting/follow-up. If benefit is not established, mark this optional package not needed; the full core outcome may pass without it.

### W13 — Direct release acceptance and maintainable closeout

**Outcome:** product claims match demonstrated behavior, and unfinished work cannot vanish in a handoff.

1. Run the section 10 acceptance scenarios and maintain the requirement/outcome ledger. Every required row needs direct evidence in the relevant environment.
2. Obtain distinct implementation and safety review of sensitive changes and rendered review of material UI. Resolve concrete findings and review the corrected result.
3. Retain sanitized release summary with source revision, test-run receipts, current company/environment, live authorizations, outcome evidence, elapsed endurance, remaining gaps and owner action.
4. Update current architecture, operator/recovery guidance and truthful roadmap status. Link detailed evidence rather than duplicate logs or private records.
5. Commit/push only owned checked work on canonical main to its configured upstream. Preserve concurrent work and do not absorb unrelated changes into a release.
6. If live authority, elapsed endurance or a genuine capability is missing, report that exact unmet outcome. Deliver named foundations/slices without calling the whole operator complete.

**Proof:** every required requirement row achieved; optional/deferred rows explicitly classified and justified; no unsupported broad completion statement.

## 8. Responsibility-to-capability delivery matrix

This is the completeness checklist for the accountant's role, not a claim that every row is already implemented. Mark exact API/app/authority status during W00/W05. Existing capability definitions remain the place for detailed support facts. Do not create a competing catalog.

| Responsibility | Required business decisions and actions | Required context/tools | Direct evidence |
| --- | --- | --- | --- |
| Understand the company | Explain business lines, current condition, priorities and commitments | Published blueprint, mappings, retained directions, current facts | Explanation agrees with the actual business and records |
| Choose hourly work | Prioritize useful operations and retain next action | Due work, demand, cash, stock, coverage, scheduler | Repeated meaningful activity with recorded cause and verified effects |
| Service sales | Progress work from quote/time/cost to invoice and collections | Customer terms, approved services, work lineage, governed compiler | Exact linked records, tax/accounts and open/settled balances |
| Recurring services | Maintain recurring obligations and renewals | Subscription/service schedule, customer behavior, existing occurrences | No missed/duplicate occurrence; future work retained |
| Receivables | Monitor aging, collect/apply permitted amounts, handle exceptions | Current invoices/payments/credits and authoritative balances | Correct allocation and remaining balance, no duplicate collection |
| Purchases/payables | Acquire needed stock/services and settle legitimate obligations | Vendors, terms, orders/bills, cash, ownership | Correct bill/order/payment links and payable/cash effects |
| Inventory | Plan replenishment/sales and detect stock/valuation issues | Item balances, reservations, receipts, costs, demand | Quantity/cost/COGS/report agreement and no unexplained stock change |
| Cash and banking | Understand cash needs, deposits, transfers, fees and timing | Bank ledger, undeposited funds, obligations, governed workflows | Traceable cash movement and financial/report checks; no real external payment implied |
| Accounting and tax | Choose correct dated treatments and investigate discrepancies | Published Canadian tax/account policy, protected dates, reports | Reviewed expectations and actual native record/report effects |
| Close/reconciliation | Prepare and track recurring period responsibilities | Period completeness, statements, exceptions, manual/native evidence | State labels match actual evidence; official status never invented |
| Business consulting | Explain trends, risks and practical options | Comparable periods, margins, cash/aging/stock, objectives | Specific evidence-backed advice and retained follow-through |
| Coverage maintenance | Maintain useful feature/report examples | Registry, representative variants, freshness, actual company evidence | Gap becomes a verified useful example or explicit manual/unavailable item |
| Master-data maintenance | Reuse/create/adopt compatible parties/items/dimensions | Existing role bindings, provenance, definitions, safe plans | No duplicate role/entity, correct mappings and downstream use |
| Monitor external activity | React to owner/manual QBO changes | Sync/change summaries, record versions, work dependencies | Affected plans/obligations update correctly within measured lag |
| Troubleshooting/learning | Coordinate a relevant case and explain tested results | Case state/authority, record chain, reports, known limitations | Useful reproduced/not-reproduced/unverified result with preserved context |
| Owner decisions | Ask only necessary questions and obey answers | Full retained decisions, effective instructions, pending plan versions | Answer survives restart and changes subsequent work |
| Recovery | Inspect partial effects, adopt saved results and continue safely | Original plan/receipt, exact record/readback, recovery tools | Same accepted IDs retained; no duplicate dispatch/effect |
| Explain outcomes | Show actual work, evidence, unfinished items and next action | Decision-operation-record-report links | Owner can understand and take control without log archaeology |

For every required responsibility, record the remaining missing tool, knowledge, authority, UI and proof separately. A manual-only feature can be covered honestly by a useful procedure and evidence, but a manual workaround cannot be counted as autonomous delivery of a responsibility that was promised to run autonomously.

## 9. Complete owner journeys

These journeys are acceptance tasks, not a mandate to add a new page for each. Prefer connected views and clear deep links.

| Journey | Arrival and decisions | Required result and return path |
| --- | --- | --- |
| Return after absence | Open Company; see business condition, period, freshness, agent state and important changes | Know what happened, what needs attention and what comes next; drill into evidence and return with context |
| Understand the business | Read actual blueprint and priorities, then supporting records/reports | Understand what the company does and why its balances/activity are plausible |
| Give direction | Enter a goal or priority, review consequence if it changes policy | Direction saved and effective; affected future work shows the change; owner can revise it |
| Resolve an owner decision | Open a specific evidence-backed question with options | Response retained, only dependent work resumes, no repeated question |
| Inspect accountant work | Open a decision and its prepared/running/completed operation | See business rationale, expected/actual effects, partial results and verification |
| Manage activity manually | Choose a supported business task, parties, terms and relevant quantities/amounts | Exact plan reviewed, executed under owner authority when requested, verified, linked to records |
| Manage customers/suppliers/items | Browse existing roles/data and permissible actions | Safely reuse/create/adopt/change only supported records; see why an action is unavailable |
| Follow AR/AP | Open unpaid/overdue obligations and related customer/vendor records | See correct remaining balance, follow-up, supported settlements and future work |
| Manage inventory/cash | Inspect current position, demand and upcoming obligations | Prepare appropriate governed work; understand actual stock/cash effect |
| Inspect records | Browse/filter/page and open human-readable details/relationships | Trace related activity, provenance and reports without raw JSON being mandatory |
| Inspect reports/coverage | Start from a business question or missing example | Read correct period/basis, assertions and evidence; prepare gap work or follow native/manual procedure |
| Troubleshoot/teach | Start a case or continue from a company problem/record | Retain business context, inspect tested actions/results and return to the source |
| Investigate stale monitoring | Open specific stale/failed source with retained observations | Understand impact, retry/catch-up and when decisions can safely continue |
| Recover partial work | Open exact retained operation with saved results | Inspect/adopt/verify/resume supported remaining work without recreating accepted records |
| Pause/resume/stop | See clear distinction among agent decisions, monitoring and accounting execution | Server-confirmed control state, known in-flight effects, clear recovery path |
| Review history and health | Read important events and pending work across time | Reach older decisions/evidence beyond recent UI limits; see actual worker/API/provider issues |
| Manage app settings/access | Inspect safe company, provider, permissions and operating configuration | Change only authorized settings; see effective time and required owner lifecycle action |

For relevant states, test initial, ready, empty, loading with retained data, partial, stale, permissions, disconnected, upstream/provider failure, rate limit, revision conflict and saved-awaiting-verification. Preserve useful drafts and return context. Use current desktop target and accepted visual standards. Keep required existing accessibility checks tied to actual affected journeys; do not revive the old mobile redesign or broad obsolete screenshot matrix.

## 10. Verification and direct acceptance scenarios

### 10.1 Verification layers and executor

- Source/contract inspection proves the code's intended boundary.
- Existing focused unit/contract tests prove the exercised non-live behavior.
- Component/fixture and rendered checks prove their actual UI layer.
- Authorized native QBO reads/writes and report checks prove the actual company result.
- Elapsed unattended observation proves the duration observed, not an infinite future.

Only gpt-6-luna executes deterministic tests, builds, lint, syntax and validators under this repository's execution contract. Verify effective model/effort and retain exact command, cwd, exit code, concise results and cleanup. Builders diagnose/fix; they do not substitute a more expensive deterministic runner if Luna is unavailable. Manual source inspection, browser observation and independent judgment remain with their usual owners.

Windows commands use the hidden general Node REPL route with node:child_process execFile/spawn, windowsHide:true and explicit arguments; never a shell wrapper. Do not use routine exec_command/write_stdin or the browser REPL for commands. Preserve timeouts, exit codes and exact task-owned cleanup. Apply the project's approved bridge exception only when actually inside that bridge.

Current command inventory, verified from package/profile files during planning:

- Backend tests: npm run test --workspace=backend. Prefer focused existing Node test files first when a bounded change allows it.
- Backend syntax: node scripts/agent-harness/check-backend-syntax.mjs.
- Frontend: npm run build --workspace=frontend and npm run lint --workspace=frontend.
- Frontend package currently has no test script. Choose a proportionate maintained interaction-test route for changed business journeys; do not invent a command or add a framework solely for harmless copy changes.
- Documentation-only edits: owned diff, references and instruction consistency; no application suites or live services merely for Markdown.

Re-read manifests before running. No tests may contact real QBO, paid providers or the owner's database by default. Short-lived isolated test services must own and verify cleanup. Browser verification must follow the applicable QBO project browser/skill rules and preserve the owner's review tab.

### 10.2 Acceptance matrix

| ID | Scenario and setup | Required observed result | Evidence layer |
| --- | --- | --- | --- |
| A01 | Existing populated company with absent/unaccepted calendar cursor | Original history retained and reconciled/adopted through a reviewed path; no empty-company regeneration | Native identity/receipt/report evidence plus source/state proof |
| A02 | Older operation predates current agent grant | Original authorship preserved; reviewed settlement/continuation uses appropriate authority | State/authorization tests and exact authorized operation evidence |
| A03 | Routine due business need under standing authority | Accountant identifies need, prepares, executes and verifies without repetitive per-plan questions | Live integrated business result |
| A04 | Repeated hourly reviews over a useful operating window | Diverse justified activity and due-work progress; no synthetic overhead or summary-only success | Actual decisions/records/reports across elapsed time |
| A05 | Invoice due later, partial payment then remainder | Correct open balance and future obligation persist across passes; no duplicate payment | Native invoice/payment/deposit plus AR/report evidence |
| A06 | Supplier bill and future payment | Terms, outstanding balance, cash effect and later settlement correct | Native bill/payment and AP/cash evidence |
| A07 | Stock below threshold, later purchase and sale | Coherent replenishment, available stock, sale and COGS/valuation | Native stock chain and report/quantity checks |
| A08 | Recurring service crosses period boundary | Correct next occurrence, no duplicate renewal and retained late/partial states | Schedule tests and authorized actual occurrences |
| A09 | Owner changes business priority | Later choices follow saved direction; conflicting queued work invalidated appropriately | UI-to-saved-policy-to-next-decision proof |
| A10 | Important decision falls outside recent prompt/UI window | Full original decision/answer still retrieved and obeyed | Retrieval/pagination and integrated behavior |
| A11 | Owner settles/edits a relevant record directly in QBO | Monitoring catches it; obligation/plan changes; agent does not repeat obsolete action | Authorized external-change observation and follow-up |
| A12 | Source stale, CDC saturated/expired, deleted record | Truthful incompleteness/catch-up; no skipped changes or false current state | Focused fault/contract tests and relevant read-only parity |
| A13 | Model reply truncated, tool capacity reached or provider unavailable | No partial invalid action; same work retained and resumes when possible | Isolated provider/tool tests and retained state |
| A14 | Timeout after QBO may have saved a request | Hold, inspect/discover and verify exact saved result; no blind replay | Isolated ambiguous-outcome tests plus authorized recovery proof |
| A15 | Restart at dispatch, receipt and verification boundaries | Saved identities preserved; worker resumes only still-authorized work | Owned isolated restart tests and authorized runtime continuity |
| A16 | Pause/revoke/change grant during a pass | No new prohibited dispatch; already-sent outcomes retained; monitoring behavior matches chosen control | Race tests and integrated control observation |
| A17 | Two workers or competing manual/case activity | One governed writer; no duplicate admission or starvation; work remains traceable | Concurrency tests and operation audit |
| A18 | Financial/report discrepancy | Accountant detects actual mismatch, explains evidence and follows through; no cosmetic balancing entry | Record/report discrepancy and retained resolution |
| A19 | Missing useful coverage example | Appropriate plan/manual task, realistic surrounding activity and verified result | Registry-to-operation-to-record/report evidence |
| A20 | Troubleshooting case from business context | Context retained; correct case authority; useful tested outcome; ongoing business protected | Full owner case journey and native case/business evidence |
| A21 | Owner manually manages a supported workflow | Complete discover/prepare/review/execute/verify/recover journey | Integrated desktop observation plus native outcome |
| A22 | Return after multiple unattended days | Understandable business state, actual progress, pending work, next action and controllable operation | Owner return journey and elapsed operating evidence |
| A23 | API/model use approaches allowance or repeated failures | Bounded backoff/attention, retained obligations, no hidden cost commitment or abandoned work | Measured usage/health and isolated budget tests |
| A24 | Optional specialist enabled/disabled | Main remains accountable and competent; useful findings acted on, no duplicate work | Comparative outcomes and coordination evidence |
| A25 | Native-only reconciliation/tax/product feature | Precise manual procedure and actual evidence state; no fabricated official completion | Authorized native/manual observation |
| A26 | Longer history/data/event volume | Complete required pagination, older work discoverable, useful desktop performance and bounded storage | Measured practical dataset and retrieval evidence |

For each new QBO mutation workflow, preserve the sandbox-integration-before-bounded-Production-canary gate unless an explicit target-specific owner decision approved a different validation path. Reuse valid existing acceptance evidence; this new plan does not require restarting already passed validation. Neither sandbox nor Production execution is authorized by the plan itself.

Every new workflow also needs entity-specific amount/date/tax/account/relationship expectations, malformed input denial, changed policy denial, protected-period denial, record-ownership enforcement and failure/recovery behavior. Select focused existing tests; add tests for material new invariants, not textual mirrors.

### 10.3 Accountant judgment assessment

A model-loop test must assess more than whether it called a valid tool. For each representative scenario, retain the factual setup, available tools/authority, expected safe decisions, actual selected work, unsupported claims, verification and final business outcome. Include normal work, a competing-priority decision, an external change, missing evidence, a misleading record description and an owner override.

Pass requires grounded useful choices, correct authority, appropriate tool use, retained follow-up and truthful claims. A model that repeatedly reports status instead of handling due supported work fails. A model that creates volume without economic purpose fails. A model that escalates every routine choice to the owner also fails.

## 11. API, cost and operating constraints

Continuous means a durable service with a measured freshness target, not infinite calls or literal zero-latency observations. Intuit documents missed/out-of-order webhook events and recommends CDC recovery. If webhooks are used, preserve catch-up and completeness. [Official webhook best practices](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/best-practices.html).

Current published REST limits include 500 requests/minute per realm and 10/second per realm/app; Builder workspaces have an included allowance of 500,000 CorePlus calls/month. These are platform constraints, not proof of this application's actual tier/usage. Query pagination, batch limits, timeouts and throttling must be incorporated from current applicable documentation. [Official API limits](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html), checked 2026-10-24.

Illustration only: ten metered calls every minute for 30 days is 432,000 calls, before reports, verification, manual browsing or recovery. This is not a measured description of current usage. Measure actual request categories/cadence and relevant shared workspace use before promising indefinite continuous operation within an allowance.

Required operating acceptance:

- A documented measured target for source freshness, next-action delay and hourly useful business activity.
- Sustainable allocation across synchronization, critical verification, reports, owner browsing, recovery and models.
- Bounded backoff and preserved continuation when limited; no silent permanent shutdown after a pass cap.
- No implicit spending commitment or developer-tier upgrade.
- No invented model cost/billing metrics when the provider does not expose them.
- Storage, pagination and retained evidence that remain usable as the company grows.
- Actual unsupported/API-restricted responsibilities classified and addressed through appropriate access or honest manual procedures.

Research exact Canadian tax/accounting rules and current API support from authoritative sources when implementing the relevant workflow. This plan does not certify those detailed rules in advance.

## 12. Dependency order and useful delivery slices

| Milestone | Packages and dependency | Smallest useful delivery | What it does not yet prove |
| --- | --- | --- | --- |
| M0: trustworthy target | W00/W01 | Current requirement/state/authority map, coherent plan and no obsolete governing pointer | Accounting operation |
| M1: safe continuity | W02 with W03/W04 foundations | Existing records preserved, reviewed history/forward boundary and retained obligations | Broad adaptive competence |
| M2: first accountable business slice | W03-W06, relevant W07/W08/W10 | One meaningful cross-pass workflow with owner controls and actual verification | Complete medium-business coverage |
| M3: full business spine | Remaining required W06/W08 workflows plus W04/W05 | Service, recurring, purchasing, stock, AR/AP and cash responsibilities working together | Days/weeks endurance or complete owner journeys |
| M4: complete operating experience | W07-W10, required administration and recovery | Current monitoring, advice, troubleshooting, evidence and manual management | Extended unattended reliability |
| M5: sustained operation | W11 and optional justified W12 | Measured unattended days/weeks with recovery and useful activity | Infinite future reliability |
| M6: whole-outcome acceptance | W13 | Requirement ledger, direct proof, independent review, truthful docs and checked source | Anything explicitly still unverified |

W02's live boundary may be blocked while non-live W03-W10 work proceeds. Monitoring/cost analysis, owner journeys, tools/knowledge and focused tests can progress independently. Do not use optional specialists, a broad design rewrite or an obscure feature gap to postpone the essential business spine. Do not use a completed easy branch to claim the blocked core achieved.

No fixed calendar estimate is justified by this planning review. Estimate each slice after current-code ownership, missing contracts and live-proof availability are known. Track actual outcome progress, not only files/tests/commits. Follow the repository's existing work-value checkpoints and stop-loss rules; do not create another competing ledger or timer.

## 13. Authority and release checklist

### Authorized by the present planning/deletion request

- Read relevant local source, original session and current instructions.
- Create this detailed plan and remove the specifically identified obsolete plan.
- Repair necessary active documentation references and contradictory direction.
- Perform focused non-live document verification and required bounded review.
- Commit/push only these owned changes under the repository's normal Git rules.

### Not authorized merely by this plan

- Starting/stopping/restarting persistent JE or Test Data Lab services, databases or tunnels.
- Enabling the accountant, expanding saved grants, changing provider settings or calling live models for acceptance.
- New QBO reads/writes, live database preparation/migration, OAuth or credential changes beyond applicable already documented target-specific authority.
- Destruction, adoption, repair or replay of company records without its exact applicable authority.
- Real payment movement, customer/vendor messages, tax filing, new paid access or publishing.

For each proposed live check, prepare objective, exact company/environment, approved action class, expected calls/records/amounts/dates, budget, stop condition, retained evidence and recovery/disposition. Recover valid existing authorization before asking again. Coding-agent authority and the application's own standing business/case grants remain distinct.

The current conversation authorizes planning and the old-plan deletion. It does not order implementation of all packages or activate autonomous accounting. A fresh implementation session must follow the owner's next instruction and this plan's evidence boundaries.

### Whole-product release checklist

- All required R01-R16 outcomes have direct evidence; conditional specialist benefit is resolved explicitly.
- All required responsibility rows have adequate tools, knowledge, UI and actual result proof, or an explicit owner-accepted scope decision. Do not reclassify a promised autonomous responsibility as manual merely to pass.
- Existing history and original write evidence are preserved; no accepted effects replayed.
- Continuous useful activity, owner direction, external changes and verified accounting work together.
- Complete owner journeys are demonstrated in the integrated desktop app.
- Relevant financial/report/stock/tax checks agree; remaining discrepancies are not hidden.
- Restart/partial/uncertain/rate/provider failures recover within authority.
- Elapsed unattended proof matches days/weeks claims; duration not yet observed remains unverified.
- Applicable independent implementation, safety and rendered reviews have passed after corrections.
- API/model/storage use is sustainable for the actual account/configuration without unapproved cost.
- Current instructions, architecture, operator guidance and release claims agree with evidence.

## 14. Initial implementation-session checklist

1. Read current AGENTS.md, AGENT_WORKFLOW.md, this plan and applicable scoped rules. Inspect Git before touching files.
2. Recheck W00 against original records and current source; do not assume the planning baseline remains unchanged.
3. Identify which additional same-day code is still local, which session owns it and which checks/reviews actually ran. Preserve others' work.
4. Complete the current authority/state map. Recover the old population/current operation rather than calling a fresh generator.
5. Prepare W02's smallest safe reconciliation/forward-continuity proposal and independently challenge it. Do non-live W03-W05 foundation work while any genuine live decision waits.
6. Deliver M2 as an actual cross-pass business responsibility, with a working owner journey and direct accounting proof when authorized.
7. Continue through required packages under explicit implementation authority. Keep all unmet whole-outcome rows visible at every closeout.

Do not start by adding more specialist roles, increasing template counts, deleting safety checks, changing saved models, recreating the company or moving every frontend file into a new architecture.

## 15. Outcome ledger for this planning task

| Outcome requested in this conversation | Direct proof | Status |
| --- | --- | --- |
| Recover full current owner intent | Original October 23 owner messages read; R01-R16 and current clarifications mapped in sections 1-2 | Achieved as planning evidence |
| Review old plan for relevance | All 39 sections read; relevance assessed; owner then explicitly requested deletion | Achieved; old plan not retained as active backlog |
| Delete the specifically identified old plan | File absence and active-reference updates observed; focused document checks passed | Achieved |
| Create a heavily detailed delivery plan | Sections 1-14; independent read-only challenge found no remaining material planning gaps after corrections | Achieved as a plan; implementation remains unfinished |
| Implement the full business operator | No implementation authorized or performed by this planning task | Unmet; future implementation |
| Demonstrate autonomous accounting and days/weeks operation | No live acceptance or elapsed endurance run performed by this planning task | Unverified; future authorized proof |

Independent plan challenge: completed 2026-10-24. The reviewer checked full intent, existing-history safety, sequencing, authority and acceptance. Findings about the sandbox/Production gate, legacy-AI wording and current/historical authority were corrected and re-reviewed; no remaining material planning gaps were found within that scope. This is plan review, not implementation or live acceptance.

Focused documentation checks are run by the Luna runner; no application tests, builds, live calls or service actions are required for this documentation-only task. The last two ledger rows must not become achieved because this document exists.
