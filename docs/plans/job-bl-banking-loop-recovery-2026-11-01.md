# JOB BL — banking loop stop and restart recovery (2026-11-01)

## Evidence and cause

Actual run bf7-4cf19462-a0a0-4351-be98-0d3c709c227f, package ce9526d1b285521991956b0fa27e4ae6b47701fd31b726ca45c350a172ff5f11, Chequing account60, April2020. Original evidence: artifacts/terra-live/bf7-4cf19462-a0a0-4351-be98-0d3c709c227f-20261101-014409/events.jsonl and preflight.png/rules.png/stop.png. There is no reply.txt. The final structured agent message says stopped because the UI did not expose a rule ID. Its retained action ledger is empty. The actual operator journal remains started (05:44:09.088Z), and both shared Terra and operator locks were present when inspected. The existing loop returned waiting on the Terra directory before reading that journal, so it neither recovered the stop nor wrote a pause.

The Rules screenshot shows the All rules filter, both Active and Disabled rows, visible names/applied-to/conditions/Auto-post columns, and 1–4 of4 items. Names/conditions are clipped, so a complete future inspection must expand details read-only; the screenshot alone is not claimed as a complete safe-rules inspection.

## Changes and decisions

- Preflight now requests full visible names, status, applied-to accounts, conditions and Auto-post; no internal rule ID. All rules, cleared search, every page and both statuses require coverage/counts and retained page screenshots. The coordinator hashes the full returned list and visible rule identities. Visible account names resolve uniquely against scoped synced account names/fully qualified names; unknown, clipped and ambiguous names fail closed. Any applicable active Auto-post rule blocks, including deliberate-scenario adapters.
- Structured stopped output is parsed before cleanup/model success admission so its exact reason is preserved. Missing reply.txt falls back to the final retained agent message in events.jsonl. A started journal's retained stop is visible read-only in operator.status and pauses the loop before lock inspection; a live or unreadable lock cannot mask a known stop. Loop pause is local durable storage, no MongoDB write.
- Dead locks can be reclaimed only after repeated successful Windows process enumeration proves old backend PID, all Terra-marked runs, sampled pids.txt helpers and their visible descendants absent, with unchanged owner bytes. No age-based unlock, process killing or recursive removal. The recovery mutex atomically encodes PID/UUID in its directory name, so a crash cannot leave missing owner metadata in this new mutex. Unknown native owner/sampling metadata retains the original lock for inspection.
- Journal recovery is serialized by the operator lease and independently checks retained process identities even when the wrapper lock has already disappeared. Interrupted read-only preflight without a known stop is retired and must run a complete fresh preflight. Interrupted upload/review/reconcile/attach always blocks pending read-only inspection of the account's bank transactions and exact accepted-action recovery. This job adds no automatic upload retry, Add/Match replay, undo or clearing of an existing pause.
- Journal completion uses unique temporary files, tolerating leftover crash temps. operatorLoop exposes durable lastTickAt, lastRunAt and lastOutcome, with authorized-package filtering. Heartbeat writes are atomic and serialized.

## Offline proof and limitations

Exact original Chequing manifest, CSV and statement bytes plus the actual stop message/journal are retained in test/fixtures/banking-bl-real-package.json and banking-bl-real-stop.json. These run through the same BF4 register/detail -> BF7 execute -> scheduled loop -> durable pause code used live, with only native runner/persistence adapters mocked. Additional tests recover the same stop from events without reply.txt, verify no retry after uncertain actions, retain live/sampled/unknown locks, recover dead mutex owners, preserve crash temp evidence, and filter heartbeat details. Complete safe-rules observations in tests are synthetic; no new QBO observation is claimed.

Read-only implementation and safety reviews completed against scratch; their concrete findings were fixed before source publication. No remaining material findings. Live Windows CIM enumeration from the coding sandbox returned Access denied; no live lock was removed. Tests use isolated temp locks and injected process lists. No QBO/API call, MongoDB connection/write, explicit service control, environment change or commit. Source publication can trigger the existing owner-controlled nodemon watcher as described in the task.

## Verification

Prepared in artifacts/job-bl-20261101/src, outside watched backend/src, then published as one source batch after review. Final-source commands/results and batch time recorded below after publication.

Affected commands from backend: node --test test/banking-operator.test.js (30), node --test test/banking-operator-recovery.test.js (6), node --test test/banking-integration.test.js (10), node --test test/banking-workspace.test.js (21). Six touched modules also require node --check; git diff --check covers whitespace. No live native banking execution is part of these checks.

## Work-value ledger (UTC)

- 06:57:50 — essential builder outcome: expose the real stop, safely recover killed-process state, and prevent duplicate uploads. Smallest proof: exact ce9526d1 package and bf7-4cf19462 stop through production execution path. Next milestone: reviewed offline replay, then one source batch. Main branch; Job3A compiler/graph changes left untouched.
- 07:02:34 — focused tests and scratch syntax passing; no live company progress claimed. Continue only direct recovery/visibility findings and required review, not unrelated business logic. Process enumeration denied in sandbox; do not retry through another launch route or touch live locks.
- Final checkpoint — retained-stop visibility now precedes lock checks, so the original incident becomes an honest durable pause even if lock recovery cannot proceed. Live completion remains unverified and a retained stop requires explicit resolved-state recovery before banking resumes.

Owned source: banking-operator.js, banking-operator-guards.js, banking-operator-loop.js, banking-terra-runner.js, banking-accountant-tools.js, new banking-operator-recovery.js. Owned tests: banking-operator.test.js, banking-integration.test.js (scratch overlay selection), new banking-operator-recovery.test.js and two BL fixtures. All changes remain local/uncommitted by explicit request.


## Published-source result — 07:04 UTC

Six backend source files published in one 4ms batch, 2026-11-01T07:03:44.073Z–07:03:44.077Z. Basename locks released; final bytes matched reviewed scratch. Final-source tests from backend/ all exit0: operator30, recovery6, integration10, workspace21 = **67 passed, zero failures/skips**. All six node --check commands and owned git diff --check exit0.

Direct runtime evidence after the batch: the existing backend itself wrote artifacts/banking/operator-loop-paused.json with the original ID-backed-rule stop reason and exact ce9526d1 package. Its operator-loop-state.json reports blocked, lastTickAt2026-11-01T07:03:47.937Z, lastRunAt2026-11-01T05:44:09.088Z and lastOutcome blocked with the original reason. Read-only production readBankingLoopStatus serialization confirms paused:true, enabled:true and the same authorized-package reason/heartbeat. Sanitized observation retained under artifacts/job-bl-20261101/observed-operator-loop.json.

Achieved live: honest durable pause and heartbeat, rather than scheduled/no-reason. Achieved offline: native visible-rule contract, stopped result recovery, and process-verified restart safeguards. Still unverified live: Windows lock reclamation, a new complete rules inspection, upload/review/reconciliation progress. The existing native locks and started journal were deliberately preserved while the known stop paused scheduling. This builder has not cleared the pause or performed native recovery; an authorized operator must resolve the recorded stop and inspect preserved state before resume. No native/accounting action was replayed.
