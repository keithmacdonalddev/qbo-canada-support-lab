# Continuous business operator

Owner direction, 2026-10-23. Scope is the discussed product intent, not the remaining end-to-end review list.

## Required outcome

The in-app agent is the fictional company's accountant, manager, consultant and decision maker. The owner can direct and override it through a complete desktop workspace. While the server runs, monitoring and hourly business decisions continue without browser participation, an end date or a lifetime transaction quota. Work remains scoped to the selected company and existing accounting protections. One accountable agent is the default; specialist agents are justified only by a substantial net benefit.

## Implementation boundary

- Add a persistent company-scoped BusinessAgent control/lease document, CompanySyncRecord mirror, and append-only BusinessAgentEvent decisions/activity. Models default autoCreate/autoIndex off. Explicit monitoring setup prepares only these app collections; GET and importing modules do not initialize storage.
- Add a server worker which scans only previously enabled monitoring. A process owns a renewable durable lease; lost leases, changed owner/connection/membership, pause and shutdown prevent new tool dispatch. Server restart resumes persisted cursors and queued work. Individual passes have time/read/tool bounds; these are work slices, never lifetime limits.
- Synchronize supported accounting/list entities through paged initial queries followed by QBO change-data-capture. Persist per-entity cursors, refresh unsupported/singleton data separately, retain deletion state, detect CDC saturation and old cursors, and visibly require catch-up instead of claiming complete data. Never advance a cursor on failed persistence. A cycle is current only when every required source is complete and recent.
- Reuse current AI provider isolation and internal tool bridge. Give the agent a maintained business/accounting operating brief and current cached facts, saved owner instructions, decisions and unresolved work. Tools expose actual company reads, reports, current plans, exact governed operation preparation/approval/execution and requests for owner decisions. No shell/browser/raw network tools.
- Standing autonomy is an explicit owner-only, company-bound decision. It permits ongoing governed activity under the published business policy; it does not remove exact plan compilation, accounting period, original-record, receipt, audit, permission or ambiguous-write barriers. Agent tool dispatch rechecks this authority. Changes to protected policy or existing records retain existing review boundaries.
- Keep monitoring separate from autonomy: pausing decisions leaves monitoring available. Stop prevents new work and requests existing execution Stop; already sent work retains its receipt and cannot be replayed.
- The desktop Company workspace provides current company facts, sync freshness, agent status/current work/next wake, decisions and attention, durable owner instructions, safe pause/resume/run-now/sync-now controls, and direct journeys to business management, records, reports, history and reproduction. Read cached app data; do not run expensive full-company aggregation from dashboard polling.
- Preserve concurrent Coverage changes, existing saved QBO records and services. No external company mutation, migration, provider call, or persistent service restart is performed by coding agents for implementation.

## Reuse and files

New backend modules: business-agent-policy, business-agent-sync, business-agent-tools, business-agent-service, business-agent-store and associated focused tests/models/router. Reuse business-runtime-access, business-governance-service, business-execution-service, business-baseline, ai-tools read contracts, ai-provider, ai-tool-bridge and codex-cli. Wire a single dormant-until-enabled worker at explicit startup. New BusinessWorkspace and focused CSS/hook; route existing Company management separately and preserve all existing journeys.

## Verification and activation

Luna executes focused non-live tests for cursor/deletion/saturation/restart, lease/owner revocation/pause races, standing approval, malformed model replies and independent partial-source failures; backend syntax, frontend build/lint and diff check. Obtain independent implementation and safety review before and after sensitive source changes. Inspect the desktop workflow in an isolated fixture server, including empty, current, stale, failure, paused and decision states. Source checks and fixture rendering do not establish live activation. Activation requires owner authorization for server reload and explicit target/company monitoring/autonomy setup.

## Official synchronization reference

Intuit Developer: https://medium.com/intuitdev/building-smarter-with-intuit-stay-in-sync-with-cdc-171f8094dd37 (read 2026-10-23). CDC includes changes and deletions; its history window and response bounds require explicit catch-up/completeness handling.

## Implementation checkpoint — 2026-10-23

The foundation through commit 8d90698 implements persistent controls and restartable leases; 28 company sources with stable keyset reads, generation-based deletion reconciliation, CDC catch-up, source-specific freshness and observed home currency; scoped AI tools/provider execution; main accountant and optional receivables/payables/inventory loops; durable owner decisions/instructions; immutable standing-grant lineage and transaction fences through preparation, approval, recovery and actual QBO admission. The Company page is the operating workspace; detailed management is at /company/manage and troubleshooting remains at /reproduce. Focused checks and independent implementation/safety reviews passed for that foundation. A synthetic desktop preview verified useful content placement, owner decision submission, pause and instruction saving.

The owner then explicitly authorized continuous read-only monitoring for the connected Production company ending 2856. Monitoring storage was initialized through the app's scoped consent flow. The live workspace subsequently showed 28 of 28 sources current, current company observations and retained source progress across application reloads. This is direct monitoring evidence, not evidence of autonomous accounting. The accountant remains paused; no live accounting request or external AI review was submitted.

### Additional same-day activity, awaiting fresh verification

The next implementation extends the existing Plan/Run/Intent/Step/compiler/writer pipeline with additional activity batches. Each immutable batch retains a business purpose, stable decision identifier, exact economic choices and a separate activity-policy hash. Supported choices are settled service sales (including relevant estimate/time, invoice, collection and deposit) and paid non-stock overhead (bill and bill payment). The agent discovers observed published role choices; the owner can prepare the same choices from Directions & controls, then review the exact saved plan through existing business management.

History must be verified through yesterday. The current day stays open for repeated hourly batches. A batch increments the calendar revision and records its own completion receipt without advancing verifiedThrough or replacing the original committed stock carry. Original native permission, pause/grant, tax, period, receipt, seven-report and stock-cost checks still apply. A later calendar operation can close the day independently. Batch capacities limit an individual operation; there is no end date or lifetime transaction quota.

Existing standing grants cannot silently acquire this policy. New autonomous grants explicitly record it; the native write-admission transaction requires that policy hash for a batch. Preparation accepts structured business choices, never a raw QBO body, existing-record edit, inventory adjustment, deletion or support-case authorization.

This additional code has authored pure, accounting-flow, interrupted-completion, stock-preservation and native grant tests. Fresh execution, independent implementation/safety review and the complete rendered owner preparation/review journey remain pending after the owner's 1pm delegation cutoff. Earlier passing foundation checks do not certify these later changes. No additional activity has been run against the live company.

The full requested outcome remains incomplete. Existing populated-but-uncommitted history and its retained blocked operation must be inspected and settled from their original evidence; an empty verified cursor must never trigger rebuilding. Live autonomous accounting acceptance and days/weeks operation remain unverified. Delegated work ended before the owner's cutoff; further verification delegation requires the pending owner decision. No persistent service was manually started, stopped or restarted.

## Operating model — owner direction, 2026-10-28

The app's job is to run the QuickBooks company like a real business, 24/7, through the API, using QuickBooks features as a normal part of that business. Issues are reproduced in QuickBooks itself, not in this app. The owner should not have to manage the accountant.

- **The accountant owns the work.** One server-computed work list (`business-agent-work.js`) holds everything the business needs. Recovery of its own interrupted work, catching up with QuickBooks, adopting imported history, uncertain-write/completion/coordination recovery and putting unused QuickBooks features to use are accountant work. The agent reads the same list (`context.work`, `getBusinessWork`) and is instructed never to hand accountant work to the owner.
- **The owner sees only genuinely human work:** monitoring consent, the one-time autonomy grant for this company (and a renewal when new kinds of work are added), the owner's own pause or stop, publishing the business, fixing the AI connection, and features QuickBooks only allows in its own screens (optional). There is no routine "resume" or "review this problem" for the owner.
- **Honest status.** Accountant items are Working, Up next or Blocked. Blocked means the accountant lacks a capability; the item names it rather than asking the owner to act.
- **The Business page leads with this list**, then the existing company figures and accountant details.

### Current state (read 2026-10-28, Production company ending 2856)

Monitoring is on; the accountant has never been granted authority. The three saved blockers all come from the earlier bulk import: population job `53807d1c…` saved and content-checked 10,359 records through 2026-10-17; the writer is still delegated to that job; the original September 2023 operation `2dbe87a5…` is blocked at step 32 of 198; the calendar has no verified date. Coverage reports 67 of 81 measured features in use.

### Next capability: history adoption (design reviewed 2026-10-28)

Until the accountant can adopt the imported history, it cannot prepare any new period or same-day activity. An independent design challenge rejected the first draft. The reviewed design:

**Why simply clearing the blockers fails.** Future work that settles pre-adoption records (for example, collecting a 2026-10-10 invoice) resolves earlier dependencies only through `OperationStep` (`business-operation-plan-store.js` history, `business-operation-candidate.js`, runner `verifyGraph`). Population records live in `BusinessPopulationRecord`, so that work would fail with missing earlier activity. Carried stock is a list of FIFO lots traced to verified Bills (`business-stock-cost.js`, `business-stock-evidence.js`). Observed quantity on hand cannot stand in for it.

**Cursor.** Set `verifiedThrough` to the import date and add an immutable `calendar.adoption` marker `{version, kind:'adopted-history', jobId, adoptionId, evidenceHash, auditId, through}`, leaving `lastVerifiedOperationId` null. About ten safety checks (writer fence, run state, write gate, authority, policy amendment, period store) compare that cursor exactly, so a separate field would mean changing all of them. A shared `calendarCursor(calendar)` returns `{through, basis:'verified'|'adopted'}`. Period close (which currently fails open) and every owner or agent label must say "adopted, not verified". This tension with plan W02.3 is deliberate and evidence-backed.

**Preconditions, from saved evidence only:**
- The job is populated with no coverage gaps on any adopted dependency. Gapped records are excluded and listed.
- Identities recomputed from Steps match both `job.importedHash` and `delegation.importedHash`.
- No uncertain write, and no possibly-sent or unknown receipt anywhere.
- No job batch or lease, and no recheck queued or running.
- `job.fromDate` equals the opening date, and `job.authorityHash` equals the calendar's.
- The protected-period cutoff and the QuickBooks closing date are before the day after adoption.
- No QuickBooks transaction is dated after the import date.

**Read-only QuickBooks evidence, using existing readers:**
- The preparation report reader with `evaluateReportSources`: trial balance, balance sheet, AR/AP ledger vs aging.
- The record inventory reader, to prove every population ID still exists.
- The stock reader, compared against a FIFO replay of population Bills and sales from the zero root. The replay becomes the `adopted-history` stock carry.
- Open invoices and bills mapped to population keys and saved as obligations.

**Transaction (no QuickBooks writes):**
- Uses review → reviewHash → apply, following `business-operation-retirement.js`, with the governance fence, `fenceAgentAuthority` and the coordination touch.
- Conditionally updates the run, writer, calendar and job.
- Retires the original operation as `retired` with `retirement.kind:'superseded-by-population'`. Its receipts are retained, and its steps are excluded from period close.
- Writes a `BusinessHistoryAdoption` document and an audit row whose ids derive from the review hash, so a retry reuses them.

**Authority.** Adoption changes continuity expectations, so the standing grant alone is not enough (PRD; plan W02.4). The first grant records the adoption terms, the same way it records `activityPolicyHash`: the job, `importedHash`, the original plan hash, and the limitation types with their counts. The accountant re-checks the evidence when it applies adoption. Any new or larger limitation needs the owner again.

**Order of work:**
1. `calendarCursor`, the period-close refusal for adopted dates, and labels.
2. Model and calendar field.
3. Read-only review of saved-evidence preconditions.
4. QuickBooks evidence.
5. FIFO replay and the `adopted-history` stock carry.
6. Population-record history origins in preparation, assembly and the runner.
7. The adopt transaction and audit.
8. Grant terms, the agent tool, blockers and the work item.
9. Docs.

**Progress (2026-10-29):**
- **Step 1 is done** (`36106e7`).
- **Step 2:** the calendar field exists; the adoption document model is still pending.
- **Steps 3 and 4 are done** in `business-history-adoption.js`: `review` checks saved evidence and `observe` reads QuickBooks evidence. Both are read-only.
- **A read-only run of `review` against the Production company's saved state was ready:** 10,359 records through 2026-10-17, no limitations, and an original operation with 177 saved records.
- **`observe` has not been run live.**
- **Next: step 5.** Replay FIFO lots from population Bills and sales into an `adopted-history` stock carry, following `business-stock-history.js`.

**Live progress (2026-10-29, Production):**
- **History adopted through 2026-10-20** (adoption `4330067b…`, commit 4892eb9). No QuickBooks writes. The four manual expenses dated Oct 19–20 are included. The replayed FIFO stock (102 units, $2,631.00) matched QuickBooks.
- **First accountant catch-up:** the accountant prepared, approved and ran operation `86c4c09e…` for Oct 21–28 under its standing grant. It holds 30 records: 4 POs, 8 estimates, 8 invoices, 6 time activities, 2 bills and 2 sales receipts. All 30 were saved in QuickBooks and 27 verified.
- **Blocker:** the operation stopped at 29/30 because one estimate→invoice conversion cannot be verified.
  - The company has Progress Invoicing on (`SalesFormsPrefs.UsingProgressInvoicing`). With it on, QuickBooks ignores the invoice's whole-estimate `LinkedTxn`, so the estimate stays Pending and unlinked.
  - Operation readback (`verifyBusinessContent`, `verifyWholeEstimateCreation`) requires the link and a Closed estimate.
  - The same limitation is why the imported history recorded estimate-conversion gaps and why the original September 2023 operation blocked.
- **Choices to unblock future periods:**
  - (a) Turn off Progress Invoicing, then repair the saved invoice's estimate link through the existing owned link-repair contract.
  - (b) Accept an unlinked whole-estimate conversion as a recorded limitation when the economics match exactly.
  - (c) Stop the dated template from linking invoices to estimates.
- **Other gaps:**
  - `inspectBusinessOperation` reports the retained seven-report approval evidence as unavailable for this operation (not yet investigated).
  - The adopted open invoices and bills still need a settlement workflow.
