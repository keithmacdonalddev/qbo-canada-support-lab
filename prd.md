# PRD — AI-Driven QBO Canada Support Lab

**Version:** 2.0
**Status:** Draft

---

## 1. Overview

AI-Driven QBO Canada Support Lab is a web application for QuickBooks Online Canada support work. Each support user connects their own QBO Advanced Canada company, and the platform turns it into a realistic, continuously maintained support lab where they can reproduce customer issues, generate fresh business activity, inspect system state, and use AI to accelerate troubleshooting.

The MVP supports multiple named users. Each user connects one primary flagship QBO Advanced Canada company. The product is intentionally optimized around one flagship account per user in v1 rather than multi-company sprawl. Platform assumptions are grounded in the current Intuit developer surface: OAuth 2.0, scopes, webhooks, and published API limits that require throttling-aware design.

---

## 2. Problem

QBO Canada support agents often lose time because their test accounts are too clean, too small, too old, too incomplete, or too unlike real customer files.

The result:

- Reproduction takes too long or doesn't happen at all.
- Agents build throwaway setups manually, then abandon them.
- Not enough historical data, volume, or feature coverage.
- Stale accounts with no ongoing activity.
- Troubleshooting quality varies agent to agent.
- Escalation notes lack evidence because there's no inspectable trail.
- Nobody has a test company that actually feels like a real business.

In practice, many support users do not need dozens of active test accounts on day one. They need one strong, realistic, continuously fresh flagship account that is actually useful.

---

## 3. Vision

Create an AI-assisted QBO Canada support lab that gives each support user one realistic flagship QBO Advanced Canada company, keeps it alive over time, lets the user generate or mutate scenarios safely, and provides forensic tools to inspect, explain, and validate complex customer issues.

The platform does three things:

1. **Builds reality** — seeds and sustains a believable Canadian business inside the connected QBO company.
2. **Breaks things on purpose** — injects known issue scenarios so agents can reproduce customer problems.
3. **Helps you figure out what happened** — provides inspection, diffing, and AI-assisted investigation tools.

---

## 4. Goals

**Primary:**

- Reduce time to reproduce customer issues.
- Reduce manual effort required to prepare realistic test conditions.
- Improve troubleshooting confidence and consistency.
- Give each user one always-ready flagship QBO Advanced Canada company.
- Improve escalation readiness and support note quality.
- Make AI a core working partner for generation, inspection, and explanation.

**Secondary:**

- Create a strong base for later payroll support.
- Create a strong base for later multi-company-per-user support.
- Create a strong base for future commercial packaging.
- Accumulate reusable scenario templates over time.

---

## 5. Non-goals for MVP

- Payroll support.
- Many active companies per user.
- Public self-serve subscriptions or billing.
- Broad QBOA-specific workflows.
- Unrestricted autonomous AI writes.
- Mobile-first workflows.
- Full coverage of every QBO feature on launch.

---

## 6. Target users

**Frontline support agent** — needs a realistic company they can use immediately when a customer calls, without spending 30 minutes building test data first. Needs to reproduce issues, inspect state, produce notes, and get AI help without losing control.

**Supervisor / escalation agent** — same needs, plus deeper forensics, the ability to build more complex scenarios, higher confidence in root-cause findings before escalating further, reusable advanced scenarios, and better handoff-quality notes.

---

## 7. Jobs to be done

When a support user gets a customer issue, they want to:

- Recreate similar conditions quickly.
- Test the issue inside a realistic QBO Canada company.
- Inspect what changed and what is linked.
- Validate likely causes safely.
- Produce notes or escalation-ready findings.

When a supervisor handles a harder case, they want to:

- Reproduce more complex states faster.
- Inspect relationships and historical changes.
- Compare before and after states.
- Turn high-value scenarios into repeatable support exercises later.

---

## 8. Design principles

1. **Validate the integration before building the product.** The Intuit API surface is the single biggest risk. Nothing else matters if we can't reliably create the transaction chains we need.
2. **Useful at one issue pack, not just at twenty.** The MVP should deliver value the first time someone reproduces one AR discrepancy.
3. **Realism over volume.** A small number of well-linked, believable transactions beats thousands of random ones.
4. **Continuity over one-time seeding.** The flagship company should stay fresh, not just get seeded once.
5. **Forensics is the product.** Data generation is a means to an end. The actual value is the ability to inspect, explain, and produce evidence.
6. **AI assists — it doesn't drive.** AI proposes, the user confirms. No uncontrolled writes. Every AI action is auditable. AI orchestrates approved tools, not raw API calls.
7. **One flagship company, done well.** Resist multi-company sprawl until the single-company experience is genuinely useful day to day.
8. **Reproducibility, auditability, and resetability are core.** Not afterthoughts.

---

## 9. Product model

Each user has:

- One app identity.
- One connected flagship QBO Advanced Canada company.
- One company profile.
- One activity timeline.
- One set of checkpoints.
- One scenario library.
- One audit history tied to that company.

**Mental model:** One user → one flagship company → many reproducible scenarios.

This is not a shared-company model where every user works against the same QBO file.

### Flagship company archetype

Each user's flagship company should feel like a mature, active Canadian business, not a demo file:

- Hybrid distributor + light field-services business.
- Inventory and non-inventory workflows.
- Service work.
- Customer and vendor complexity.
- Active receivables and payables.
- Tax-related variety (GST/HST/PST).
- Enough messiness to resemble real support cases.

QBO Advanced Canada is the starting point because it supports enhanced custom fields and sales-order workflows, though live API coverage still needs validation during Phase 0.

---

## 10. Pre-build gate: API validation spike

Before committing to architecture or UI work, the team must complete a focused spike that confirms:

1. **Transaction chain creation.** Can we programmatically create a realistic linked chain: estimate → invoice → partial payment → credit memo → remaining payment? What about: PO → bill → bill payment → vendor credit?
2. **Date-backdated creation.** Can we create transactions with past dates to simulate historical activity, or does QBO enforce creation-date constraints?
3. **Master data volume.** Can we seed 50+ customers, 50+ vendors, 100+ items, and a full chart of accounts without hitting rate limits or triggering account flags?
4. **Read-back fidelity.** After creating data, can we read it back with enough detail (linked refs, line items, tax info, custom fields) to power inspection tools?
5. **Webhook reliability.** Do webhooks fire consistently enough to support change tracking, or do we need CDC polling as a fallback?
6. **Rate limit boundaries.** What are the practical throughput ceilings for batch creation, and how does throttling behave under sustained load?
7. **Sales order access.** QBO Advanced Canada supports sales orders in the UI. Can we create/read them via API, or is this a UI-only feature?

**Exit criteria:** A working script that creates a full AR chain and a full AP chain against a test company, reads them back with linked references intact, and documents any gaps or workarounds needed.

If this spike reveals blocking gaps, the product scope adjusts before engineering begins — not after.

---

## 11. Core user flows

### A. Connect and set up flagship company

1. User signs in.
2. User initiates QBO connection (OAuth 2.0 flow).
3. App validates the connection, captures realm ID, and reads company metadata.
4. App runs a capability assessment: subscription tier, enabled features, existing data density.
5. App presents a setup summary and the user confirms flagship activation.
6. App seeds master data (accounts, customers, vendors, items).
7. App generates an initial window of historical activity.
8. Flagship is ready.

### B. Generate realistic company state

1. User chooses a time window or activity mode.
2. AI proposes a plan or the user selects a preset.
3. User confirms.
4. App executes approved generation tools.
5. App updates snapshots, timelines, and audit records.

### C. Reproduce a customer issue

1. User selects an issue pack or describes a problem in natural language.
2. AI proposes a structured reproduction plan: what entities to create or modify, in what order, with what expected outcome.
3. User reviews and confirms (or edits) the plan.
4. App executes the approved steps against the connected company.
5. User inspects the result using entity explorer, timeline, and diff tools.
6. User captures findings as support notes.

### D. Investigate a discrepancy

1. User selects an entity, report area, or flagged anomaly.
2. App shows linked records, recent changes, and related transactions.
3. AI explains the likely cause based on the visible evidence.
4. User drills into specific records and compares against checkpoints.
5. User exports findings as copy-ready support notes or escalation summaries.

### E. Checkpoint and compare

1. User creates a named checkpoint (snapshot of current company state).
2. User performs mutations (issue injection, generation, manual changes).
3. User compares current state against any previous checkpoint.
4. Diff view highlights what changed: new records, modified fields, deleted entities.

---

## 12. Functional requirements

### 12.1 Authentication and roles

- Email/password login (or SSO if infrastructure supports it).
- Two roles: **agent** and **supervisor**.
- Agents can: connect a company, seed data, run issue packs, inspect, use AI in suggestion mode, create checkpoints.
- Supervisors can: everything agents can, plus approve guarded AI execution, access broader scenario tools, create custom issue packs, view audit logs across users (platform activity only — not other users' QBO data).

### 12.2 QBO connection

- OAuth 2.0 authorization per user, per company.
- Secure token storage with automatic refresh.
- Every API call scoped to the authenticated user's realm.
- Connection health monitoring with clear error surfacing (expired tokens, revoked access, scope issues).
- Graceful handling of Intuit rate limits with backoff and retry.

### 12.3 Company profile

Per-company record that tracks:

- Realm ID, company name, subscription tier.
- Enabled feature flags (inventory, sales orders, custom fields, multi-currency, etc.).
- Supported simulation modules and known API limitations relevant to this company's tier.
- Seeding status and last seed date.
- Last activity timestamp and freshness score.
- Active issue packs.
- Checkpoint history.

### 12.4 Master data seeding

Deterministic setup of foundational records. Recommended baseline:

- **Chart of accounts:** ~40-60 accounts covering income, COGS, expenses, assets, liabilities, equity. Canadian tax accounts (GST/HST collected, GST/HST paid, etc.).
- **Customers:** 30-50, mix of active/inactive, varying payment terms, some with overdue patterns.
- **Vendors:** 20-40, mix of active/inactive, varying payment terms.
- **Products/services:** 40-80, mix of inventory items, non-inventory items, and service items. Varying tax codes.
- **Tax codes:** Canadian tax profile — GST, HST, PST, exempt, zero-rated, out-of-scope.
- **Custom fields:** where QBO Advanced supports them via API.
- **Projects/jobs:** where useful for scenario realism.

Seeding must be idempotent — running it twice must not create duplicates.

### 12.5 Historical activity generation

Generate transactions backdated across a configurable window (e.g., past 6-12 months). Activity should include:

- Sales flow: estimates → invoices → payments (full and partial) → credit memos → refunds.
- Purchasing flow: POs (if API supports) → bills → bill payments → vendor credits.
- Banking: deposits, transfers, bank-feed-style categorized expenses.
- Journal entries: period-end adjustments, accruals, corrections.
- Linked chains: transactions should reference each other where QBO supports linking, not exist as isolated records.

Volume should feel like a small-to-mid-sized business: roughly 20-40 transactions per month across all types, not thousands.

### 12.6 Continuous activity engine (opt-in)

Scheduled background activity to keep the flagship company from going stale. Opt-in, not automatic.

When enabled:

- **Daily:** 1-3 new transactions (invoices, bills, payments).
- **Weekly:** a small batch of mixed activity.
- **Monthly:** closing-style entries, reconciliation-ready state.
- **Occasional:** anomaly injection (a duplicate payment, a misapplied credit, a stale open invoice).

The user can pause, resume, or adjust frequency. Every scheduled action is logged.

### 12.7 Issue injection engine

Named, replayable issue packs. Each pack defines:

- A description of the issue it simulates.
- The prerequisite state (what must exist before injection).
- The mutations it performs.
- The expected symptoms an agent should observe.
- Suggested investigation steps.

**MVP issue packs (minimum 3-5 at launch):**

1. **AR mismatch** — invoice marked paid but open balance remains due to misapplied payment.
2. **Duplicate payment** — same bill paid twice, one via bill payment, one via expense/check.
3. **Tax code inconsistency** — items sold with wrong tax code, causing reporting discrepancy.
4. **Unapplied credit** — customer credit memo exists but wasn't applied against the outstanding invoice.
5. **Orphaned transaction** — payment or deposit that isn't linked to any invoice or bill.

Broader issue families to expand into: AP issues, item/account mapping issues, workflow chain issues, reporting expectation issues, data hygiene issues.

Supervisors can create custom packs.

### 12.8 Snapshots and diffs

- **Checkpoint:** captures the state of key entity sets (customers, invoices, payments, bills, bill payments, items, accounts, journal entries) at a point in time. Stored in MongoDB.
- **Diff:** compares two checkpoints and shows created, modified, and deleted records with field-level changes.
- **Replay:** re-applies an issue pack from a known checkpoint state. Not a full "restore" — QBO doesn't support mass deletion — but a fresh injection against a known baseline.

### 12.9 Investigation tools

- **Entity explorer:** search and browse any QBO entity. View full record detail, linked transactions, and edit history.
- **Transaction chain view:** given any transaction, show what it's linked to (invoice → payment → deposit, or PO → bill → bill payment).
- **Timeline view:** chronological list of changes to a specific entity or entity family, built from audit log and/or webhook/CDC data.
- **Change summary:** "what changed since checkpoint X" or "what changed in the last 24 hours."
- **Raw API view:** optional panel showing the actual QBO API response for a selected record, useful for diagnosing API-level behavior.

### 12.10 AI assistant

The AI layer operates in three modes:

1. **Suggest:** AI analyzes the situation and proposes a plan. No writes. Default mode for agents.
2. **Confirmed execution:** AI proposes a plan, user approves, app executes the approved steps. Available to all users.
3. **Guarded auto:** for low-risk read-only operations (lookups, summaries, note generation), AI can act without per-action confirmation. Supervisor-configurable.

**Capabilities:**

- Natural language scenario planning ("create an AR discrepancy involving partial payments").
- Activity generation planning.
- Issue injection planning.
- Investigation assistance ("why does this customer's balance not match their payment history?").
- Discrepancy explanation with evidence references.
- Support note generation (structured, copy-ready).
- Suggested next steps during investigation.

**Constraints:**

- AI calls only internal platform tools — never raw QBO API endpoints directly.
- All AI actions logged with the same audit trail as manual actions.
- AI must identify the target company before any mutation.
- AI cannot delete QBO records.
- Meaningful mutations require confirmation unless policy allows them.
- AI responses include confidence indicators where appropriate.
- Supervisors may have broader execution authority than frontline agents.

**Company targeting requirement:** All AI actions must be visibly scoped to the user's currently active connected company before execution.

### 12.11 Audit log

Every mutation — manual or AI-driven — is logged:

- Timestamp.
- User who initiated.
- Company/realm targeted.
- Action type (seed, generate, inject, manual edit, AI-executed).
- Whether the action was manual or AI-driven.
- Tool or endpoint used.
- Input parameters.
- Outcome (success, failure, partial).
- Before/after values where available.
- Approval event if confirmation was required.
- Errors and retries.

Audit logs are queryable and exportable.

---

## 13. Technical architecture

### 13.1 Stack

- **Frontend:** Vite + React, desktop-optimized.
- **Backend:** Node.js + Express.
- **Database:** MongoDB.
- **Job queue:** BullMQ (or similar) backed by Redis, for long-running generation and scheduled activity.
- **AI provider:** abstracted behind a provider interface. Start with one provider, design for swappability.

### 13.2 Backend modules

The backend should be organized into clearly separated domains:

- **Auth module** — user management, sessions, role enforcement.
- **QBO integration module** — OAuth flow, token management, API client with rate-limit handling, webhook receiver.
- **Company profile module** — capability assessment, profile CRUD, freshness tracking.
- **Simulation engine** — seeding, historical generation, issue injection. Composed of deterministic "tools" that each do one thing (create an invoice, apply a payment, etc.).
- **Snapshot module** — checkpoint creation, storage, diff computation.
- **Investigation module** — entity queries, chain resolution, timeline construction, change summaries.
- **AI orchestration module** — prompt construction, plan parsing, tool dispatch, confirmation flow, response formatting.
- **Audit module** — event logging, query interface.
- **Job scheduler** — continuous activity scheduling, background task management, status reporting.

### 13.3 Key MongoDB collections

- `users` — credentials, role, preferences.
- `connections` — per-user QBO OAuth tokens, realm ID, connection status, scopes.
- `companyProfiles` — per-company capability matrix, seeding status, freshness, feature flags.
- `checkpoints` — named snapshots with serialized entity state.
- `issuePacks` — issue pack definitions (built-in and user-created).
- `issuePackRuns` — history of issue pack executions with parameters and outcomes.
- `auditLog` — append-only log of all actions.
- `aiSessions` — AI conversation context, plans, approvals, execution results.
- `scheduledJobs` — continuous activity configuration and run history.

### 13.4 AI tool contracts

AI interacts with the system through a defined set of internal tools. Each tool has:

- A name and description (for the AI model's tool-use interface).
- Input schema (what parameters it accepts).
- Output schema (what it returns).
- Permission level (which roles can invoke it).
- Confirmation requirement (auto-approved, requires confirmation, supervisor-only).

Example tools:

| Tool | Description | Confirmation |
|------|-------------|--------------|
| `lookupCustomer` | Find a customer by name or ID | Auto |
| `lookupInvoice` | Find an invoice by number or customer | Auto |
| `getTransactionChain` | Trace linked transactions from a starting record | Auto |
| `getChangeSummary` | Summarize changes since a checkpoint or time | Auto |
| `createInvoice` | Create a new invoice | Requires confirmation |
| `applyPayment` | Apply a payment to an invoice | Requires confirmation |
| `runIssuePack` | Execute a named issue pack | Requires confirmation |
| `createCheckpoint` | Snapshot current state | Auto |
| `generateSupportNote` | Produce a structured support note | Auto |
| `explainDiscrepancy` | Analyze and explain an observed discrepancy | Auto |

### 13.5 Rate limit strategy

Intuit enforces per-app and per-company rate limits. The platform must:

- Track request counts per realm per time window.
- Queue and throttle during generation bursts.
- Surface rate limit status to the user during long-running operations.
- Prioritize interactive (user-initiated) requests over background generation.
- Log throttling events for operational visibility.

---

## 14. UX structure

### Core screens

1. **Login** — email/password, role assignment.
2. **Onboarding** — connect QBO, capability assessment, confirm flagship setup, initial seeding progress.
3. **Dashboard** — flagship company health: connection status, freshness score, last activity, active issue packs, recent actions. Entry points to generate, inspect, and investigate.
4. **Scenario library** — browse and launch issue packs. View past runs. Create custom scenarios (supervisor).
5. **Entity explorer** — search, browse, and drill into any QBO entity. Linked transaction chains. Raw API view toggle.
6. **Timeline / diff view** — chronological change history. Side-by-side checkpoint comparison with field-level diffs.
7. **AI command center** — natural language input, plan display, confirmation flow, execution log, generated notes.
8. **Audit log** — filterable, searchable log of all platform actions.
9. **Settings** — connection management, continuous activity toggle, preferences.

### UX principles

- Always show which company is active before any mutation.
- Make the distinction between "app user" and "QBO company" unambiguous everywhere.
- Optimize for keyboard-driven workflows — support agents work fast.
- All text outputs (support notes, summaries, explanations) should be one-click copyable.
- Long-running operations show progress indicators with estimated completion.
- Error states should be specific and actionable, not generic.
- Enough data density for serious support work without making the interface chaotic.
- Fast movement between generate, inspect, and explain modes.

---

## 15. Non-functional requirements

### Performance

- Dashboard interactions should feel responsive.
- Long-running generation tasks should run in background jobs with visible status.
- Investigation flows should prioritize fast drill-down.

### Reliability

- Failed writes must be surfaced clearly.
- Retries must be controlled and logged.
- Checkpoints must be durable.
- Scheduled activity must be observable and recoverable.

### Security

- Secure token storage per user/company connection.
- Encrypted secrets.
- Role-based access control.
- Tenant-style isolation between user/company contexts.
- Audit trails for all mutations and AI actions.

### Maintainability

- Modular simulation engine.
- Clean separation between QBO integration, scenario logic, AI orchestration, and UI.
- Later payroll support should be additive, not a rewrite.

---

## 16. Success metrics

**Primary:**

1. A support agent can reproduce a common customer issue in under 5 minutes using their flagship company, where it previously took 20-30 minutes of manual setup.
2. At least 3 issue packs are actively used by agents for real support cases.
3. AI-generated support notes are used in actual escalations.
4. Users trust their flagship company enough to use it as their default test environment instead of creating throwaway files.
5. Supervisors can investigate and explain a complex discrepancy faster with the tool than without it.

**Secondary:**

- Freshness frequency per flagship company.
- Number of reusable scenarios created.
- Number of AI-assisted investigations completed successfully.
- Supervisor satisfaction with escalation readiness.
- Reduction in repeated manual setup effort.

---

## 17. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| QBO API doesn't support backdated transactions | Historical generation is impossible or limited | Phase 0 spike validates this before any build work |
| API surface gaps for sales orders or other Advanced features | Some scenarios can't be fully reproduced | Document gaps, design scenarios around what's available, flag workarounds |
| Rate limiting during heavy generation | Seeding takes too long or fails | Throttle-aware queue, background jobs, progress UI, prioritize interactive requests |
| Webhook delivery is unreliable | Change tracking misses events | Use CDC polling as fallback, reconcile periodically |
| Continuous activity pollutes the flagship account | Users lose trust in their test environment | Make continuous activity opt-in, log everything, provide easy checkpoint/diff to see what was auto-generated |
| AI generates bad plans or hallucinated tool calls | User executes harmful mutations | Confirmation flow for all writes, tool-contract enforcement, clear plan review UI |
| Scope creep before core is proven | Team builds too much before validating usefulness | Strict phase gates with exit criteria, user feedback loops at each phase |
| MongoDB insufficient for audit/timeline queries at scale | Performance degrades over time | Design audit schema for queryability from day one, plan for secondary store if needed post-MVP |
| Trying to cover too much of QBO too early | Thin coverage, nothing works well | Focus on AR/AP depth before breadth |
| Overbuilding AI before core tools are reliable | AI layer has nothing solid to orchestrate | Phase AI after investigation and generation tools are proven |

---

## 18. Dependencies

- Access for each early user to a flagship QBO Advanced Canada company.
- Stable Intuit app registration. (Status, 2026-05-28: the Intuit Developer app passed the full App Assessment and is "IN PRODUCTION", so production API access is unlocked. No production company is connected yet — the app still runs against sandbox, and production OAuth needs a public HTTPS redirect URI via tunnel or deploy.)
- OAuth and redirect setup.
- Confirmed scope model.
- Selected AI provider strategy.
- Agreed MVP issue families.
- Domain validation from real support users.

---

## 19. Phasing

### Phase 0 — API validation spike (1-2 weeks)

Confirm the integration assumptions documented in Section 10. Produce a working proof-of-concept script and a gap report. This gates all subsequent work.

### Phase 1 — Foundation (3-4 weeks)

- Auth, roles, user management.
- QBO OAuth connection flow.
- Company profile and capability assessment.
- Master data seeding.
- Basic dashboard (connection status, seeding status).
- Audit log infrastructure.

**Exit criteria:** A user can sign in, connect a QBO company, seed it with master data, and see the results on a dashboard.

### Phase 2 — Reality + inspection (4-5 weeks)

- Historical activity generation (AR and AP chains).
- Checkpoint creation and diff.
- Entity explorer with linked transaction view.
- Timeline view.
- 3-5 issue packs.
- Issue pack execution and run history.

**Exit criteria:** A user can generate 6 months of realistic history, create a checkpoint, inject an AR issue pack, and inspect the resulting discrepancy using the entity explorer and diff view.

### Phase 3 — AI layer (3-4 weeks)

- AI orchestration module with tool contracts.
- Natural language scenario planning.
- Confirmed execution flow.
- Investigation assistance (discrepancy explanation).
- Support note generation.
- AI session logging.

**Exit criteria:** A user can describe an issue in natural language, review an AI-proposed plan, approve execution, and receive a generated support note with evidence references.

### Phase 4 — Polish and continuous activity (2-3 weeks)

Detailed current planning note: `phase-4-hardening-plan.md`.

- Continuous activity engine (opt-in).
- Supervisor-specific features (custom issue packs, broader audit visibility).
- UX refinements based on early user feedback.
- Performance optimization for large entity sets.

**Exit criteria:** The product is usable for daily support work by early adopter users.

### Future phases (post-MVP)

- Payroll module.
- Multiple companies per user.
- Training/challenge mode.
- Scenario sharing between users.
- QBOA-oriented workflows.
- Commercial packaging.
- Multicurrency support (foreign-currency accounts, revaluation, balance-sheet FX). Planned, not built. The `multi-currency` feature flag in Section 12.3 is recorded for capability assessment only; no multicurrency generation, inspection, or issue-pack scenarios exist yet.

---

## 20. Open questions

1. **AI provider selection.** Which model(s) to use at launch? Recommendation: start with one, abstract the interface for later swaps.
2. **Agent vs. supervisor permission boundaries.** Specific list of operations that require supervisor role. Recommendation: default to same access except custom issue pack creation and guarded auto-execution settings.
3. **Reset strategy.** Full checkpoint restore isn't feasible (QBO doesn't support mass deletion). Recommendation: lean on replay from known checkpoints rather than true restore, and be transparent with users about this limitation.
4. **Tax scenario depth.** How deep does v1 go on tax-specific issue packs? Recommendation: start with GST/HST misapplication (the most common support scenario) and expand based on user requests.
5. **Cross-user visibility.** Can supervisors see other users' company summaries? Recommendation: no in MVP. Each user's QBO data stays isolated. Supervisors get broader audit visibility only for platform-level activity.
6. **Sales order abstraction.** How should sales-order workflows be abstracted if the public API surface is incomplete?
7. **Audit storage.** Will MongoDB alone be enough for long-term audit/timeline querying, or will an additional event/cache layer be needed later?

---

## 21. Scope management — what to cut if time is tight

In priority order of what to defer:

1. **Continuous activity engine** — valuable but not essential for initial usefulness. Seeding + issue packs are enough to start.
2. **Scenario replay** — checkpoints and diffs are sufficient. Full replay adds complexity.
3. **Raw API view in entity explorer** — nice for power users, not critical for daily support work.
4. **Custom issue pack creation** — ship with 3-5 built-in packs. Let supervisors request new ones rather than building an authoring UI.
5. **AI guarded auto-execution** — start with suggestion + confirmed execution only. Add auto-execution later based on trust.

---

## 22. Launch recommendation

Launch as an internal-first product where multiple named users each connect one flagship QBO Advanced Canada company.

Do not expand to payroll or broader multi-company-per-user workflows until:

- Flagship realism is genuinely useful in day-to-day support work.
- Continuous activity keeps accounts fresh.
- AI-assisted investigation is reliable.
- Issue reproduction is materially faster than the current manual process.
