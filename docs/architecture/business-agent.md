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
