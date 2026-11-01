# JOB AR — accountant review recovery, 2026-11-01

Status: offline replay passed and natural live lease recovery observed; completed live review and resumed record production remain unverified. Changes stay uncommitted at the owner's direction. Canonical checkout: main, tracking origin/main.

## Scope and plan

Essential outcome: keep the accountant reviewing and producing under its existing governed authority after restarts or incomplete nightly evidence. Smallest proof: replay the actual stored stalled review through the worker, tool execution and source-refresh guard, using fake transport/storage only. Prepare all five source modules outside backend/src, run affected tests and independent implementation/safety reviews, then save source once in a short locked batch. No service commands, QBO calls or MongoDB writes by this job. Read-only queries used a separate connection, now closed. Banking, general-write-* and business-stock-* are excluded.

## Findings and direct evidence

- Agent 8e9975355edae16ffc71b7c7 last completed at 04:40:04 UTC. Completed attempt bd0dcc8b-b1e0-4dc6-a065-cc0485923c33 ended 04:40:03.908 UTC.
- The interval to 07:00 is explained by the configured overnight five-record batching threshold and Halifax's clock rollback. Replaying the frozen live rhythm with six saved records gives expected=6 at 04:40, expected=10 and behind=4 at 06:59, and expected=11 / due=true at 07:00. No cadence policy change was made. Historical scheduler decisions were not retained; this is a direct replay of the decision inputs, not a claim of historical process uptime.
- Seven yielded attempts ran from 07:00 through 07:39, all with BUSINESS_FRESHNESS_YIELD: f9041f80-f5da-4b85-97db-6a77d8d740f7, ed28561f-f532-4f0b-8748-dbc897196c81, 6a5a7981-c7b3-4b5e-a046-c55c5a188da1, 4e1453e8-369f-46b9-bbd1-a9b6efc06846, 513102eb-b005-4a27-b5c8-a2497202989e, 76f1141d-b904-442a-be7c-2943ff1a12d0, bac661ef-0835-4a45-8f7b-44dcf05a286f.
- Attempts fd0bcbd5-034e-4030-a08d-44d025c3f3ee (07:05:32) and 0cc4ec5b-1052-45c2-a76c-44f4a12ffc50 (07:33:51) remain running with no finish timestamp despite later attempts. This proves orphaned stored attempts; restart attribution is consistent with the owner's runtime evidence. No runtime log file was available in root logs (only phase-0).
- At 07:45, active pass 27d216ca-857b-4587-ae07-20e35206e0c2 still claimed a 07:00 start, but its current attempt 6a063245-08c8-4b47-be85-247beb919588 started at 07:44:21 and had recent tool progress. The current review was not itself a three-hour orphan.
- All 30 published sources were current (the owner's initial count was 31). CDC success was 07:42:56. The nightly receivables check was unverified: QBO 8,136,286 cents; known mirror components 8,045,829; full mirror total and proven difference both null. RefundReceipt effects and Deposit/Purchase posting accounts were unsupported by the comparison. Payables also unverified; account balance comparison matched.
- sourceFreshness incorrectly treated unverified/error amount evidence as a source-freshness failure, so refreshing CDC never removed it. A similar count-read error could hold current CDC until the next night.

## Changes

- business-agent-sync.js: incomplete/failed amount and count comparisons are attention evidence; genuine amount mismatch/resync and missing/stale/error sources retain holds. Aggregate attention does not override individually current required sources.
- business-agent-store.js: five-second scheduler watchdog detects expired leases independently of nextWakeAt, and old lease-free reviewing states. Recovery atomically compares company scope, owner revision, exact lease token and expiration before clearing review state and scheduling an immediate review. Saved operations, receipts, authority and cursors remain untouched. Appends an interruption event.
- business-agent-service.js: two-minute lease with existing twenty-second heartbeat, watchdog before due scan, new pass identity for every attempt, and active-pass cleanup on terminal outcomes. Newly claimed workers reconcile orphaned usage metadata.
- business-agent-usage.js: bounded, company-scoped cancellation of unfinished running/usage-unknown attempts older than two minutes, preserving totals and completed evidence.
- business-error-detail.js: read-only /blockers diagnostics for orphaned/recovered reviews and incomplete nightly amount/count evidence; these diagnostics do not grant write authority or become global book holds.

## Verification and limits

Sanitized fixture: backend/test/fixtures/accountant-review-stall-2026-11-01.json. Includes exact relevant source, cadence and aggregate comparison inputs and attempt IDs, excluding credentials, company selection/owner identifiers, raw company records and account-balance rows.

The worker replay fails against original source (no governed approval) and passes against the prepared modules after one fake CDC refresh. Stored interrupted attempts settle without changing finished attempts or token totals. Existing genuine source/mismatch and authority/lease tests remain passing.

Affected command from backend/: node --test test/business-agent-service.test.js test/business-agent-store.test.js test/business-agent-sync.test.js test/business-agent-usage.test.js test/business-agent-review-health.test.js test/business-error-detail.test.js. Pre-save run used a temporary CommonJS loader to substitute only the five prepared module contents at their real module paths: 174 passed, zero failed/skipped. Prepared-file node --check: all five passed. Distinct read-only implementation and safety reviews resolved two edge cases (unfinished usage-unknown and bounded cleanup; current-CDC count-read uncertainty), with no remaining material findings.

Live self-healing is lease-heartbeat based, not direct OS child-process polling. Existing old four-minute leases must expire once; subsequently lost heartbeats recover after about two minutes plus scan/database time. An in-flight live model review and QBO output were not executed/claimed as proof. No commits or pushes.

## Work-value ledger

- 07:44 UTC: AR essential stall investigation began. Outcome: restore governed reviews; next milestone: real stored-state worker replay, not additional provider work.
- 07:45 UTC: captured current state and attempt history read-only; identified unverified-amount freshness loop and orphaned attempt metadata. Continue within the bounded review/sync modules.
- 07:50 UTC: 174 focused tests and five prepared syntax checks passed; independent reviews clear. No optional detours. Next milestone: one locked backend/src write batch, fresh offline checks and handoff; live company outcome remains unverified.

## Saved-source verification

All five source files were saved in one locked batch at 07:51:01.474 UTC (5 ms); byte equality with reviewed prepared files and removal of all five locks verified. The direct affected node --test command above passed all 174 tests against saved source (zero failed/skipped). node scripts/agent-harness/check-backend-syntax.mjs and git diff --check both exited 0.

At 07:53:14 UTC, read-only Mongo still showed the pre-save attempt b4043e04-1119-4511-a9bd-d4627e5419d4 and its old four-minute lease expiring at 07:54:50.410 UTC. Its last stored update was 07:51:05.124 UTC. This is the initial old-lease expiry window, not evidence that the new two-minute heartbeat has run yet.

## Natural runtime recovery observed (read-only Mongo)

At 07:55:13.257 UTC, the new watchdog had naturally recovered the old lease at 07:54:53.262 UTC, 2.852 seconds after its 07:54:50.410 expiry. Append-only recovery event: 1072a645ca3c77b52a69a889 at 07:54:53.320 UTC. Fresh pass: 59e41282-ef01-4b67-b024-977d81f0d8d9; fresh attempt: 4df9c3ae-3df0-4e64-9147-7ab83dbf0221, started 07:54:53.911 UTC, two-minute lease to 07:56:53.386 UTC, recent progress through 07:55:07.834 UTC.

All three orphaned attempts fd0bcbd5-034e-4030-a08d-44d025c3f3ee, 0cc4ec5b-1052-45c2-a76c-44f4a12ffc50 and b4043e04-1119-4511-a9bd-d4627e5419d4 were marked cancelled by the application at 07:54:53.440 UTC. The observing job issued only find queries and closed its connections; no routes, service controls, QBO requests or Mongo writes were used to cause recovery.

The new review was still in progress at this observation. Last completed review remained 04:40:04.159 UTC. Its activity-choice tool failed once, so review completion and resumed saved records are still unverified; these are not inferred from the watchdog event.
