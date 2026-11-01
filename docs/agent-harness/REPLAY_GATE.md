# Stored-operation replay gate (RG)

Status: **fail-closed diagnostic delivered; full historical admission/verification coverage is not complete.** Existing stores do not retain the required as-of writer, sync-watermark, calendar and independent read-back snapshots. A hash cannot reconstruct those bodies. This gate refuses to turn that gap into a passing replay.

## Run it

From the canonical checkout, on main:

~~~powershell
npm run replay-gate --workspace=backend -- --json
npm run replay-gate --workspace=backend -- --since 2026-10-31 --json
npm run replay-gate --workspace=backend -- --days 3 --ops 34282b42ef7d9de9bc6c8e8c --json
npm run replay-gate --workspace=backend -- --prove-activity-choices --json
~~~

Default selection is the last 72 hours by creation time. --days accepts 1–31; --since accepts a UTC date or UTC timestamp. --ops is a comma-separated list of exact fixed/general run IDs, intersected with the date selection. Missing requested IDs and empty selections fail. Scoped dependency history is loaded separately from the selected operations.

Before every commit that changes preparation, compilation, write admission, transport recovery or verification, the orchestrator must run the default three-day command against the final working tree, then the affected node --test files. An --ops slice is for diagnosis and does not replace the default gate. Do not waive errored operations, use an empty selection, substitute today's records for missing history, or call a red gate a pass. This is a documented workflow, not an installed commit hook. The current RG instruction forbids commits; none were made.

The extra --prove-activity-choices option runs named in-memory source doubles of the 96fe35a bugs. It never modifies source, uses stash/worktrees, or calls QBO.

## What executes

The CLI freezes current backend module source in memory, hashes it, rechecks it after replay, and fails if it changed. This includes uncommitted changes on main; it is not proof of pristine committed HEAD. Modules have an operation-time Date clock; real timeout timers continue to run normally.

Fixed-operation stages call current production functions:

- Saved plan and intent reads through createBusinessOperationPlanStore.loadIntent, plus readApprovalReports using the referenced candidate and audit records.
- prepareBusinessOperation and bindPreparedOperationReferences using retained list observations; unresolved master choices cannot count as success.
- createBusinessCompilationRuntime and compileBusinessTransactionWithDefinitions. The newly compiled body must also match the stored successful response through the current entity-aware response matcher, so compiling the wrong amount cannot pass merely because the old compilation still verifies.
- assertWritePeriod on the exact retained receipt proof.
- createBusinessVerificationRuntime.loadGraphReadback with exact retained read-back bodies and report sources.

General-write stages use createGeneralWriteService.prepare, its guardBatch admission check, buildGeneralBatch, classifyGeneralResponse, the retained period proofs, matchesSavedRequest, and closeGeneralDay when the requisite independent bodies and GL report exist. Saved-to-rejected items are correlated by stable ref, including faults without a QBO ID.

These are offline checks, not execution of the entire live dispatcher or coordinated write gate. In particular, replay does not fabricate a free writer fence, resource claims, standing-grant state, unknown-outcome barriers or before-send receipts. Missing writer state produces REPLAY_WRITER_FENCE_SNAPSHOT_MISSING. The full coordinated-admission/recovery replay still needs historical state capture and its loader. Added-role/adopted/history-specific preparation also needs its original supporting inputs; absent or unsupported inputs fail rather than being silently skipped.

## Data and isolation

The loader uses a separate Mongoose connection with autoIndex and autoCreate disabled, only raw find cursors, primary reads, bounded cursor batches, query/socket timeouts, a 20,000-row limit per store and a 192 MiB incremental capture budget. It closes cursors and the connection. It never imports application models or starts the server.

Operational stores include runs, steps, plans/intents, evidence, general runs/receipts, company sync records, authorities, candidates, blueprints, calendars, policies, agent sync metadata, baselines and general closes. Only referenced operational audits are read. Agent projections exclude provider/key settings. Connections, users, tokens and private transcripts are not read.

Raw records stay in memory and cross only the disposable worker's private IPC channel. No raw snapshots, fixtures or reports are written to disk. Output contains IDs, hashes, fixed stage/status/code labels and source locations. errorDetail.messageHash identifies the underlying error without printing its private message. The script itself creates no output files.

The worker receives no inherited application credentials, Mongo URI or provider settings. It replaces QBO transport with an in-memory response reader, rejects unmatched calls, blocks sockets/fetch/child commands and filesystem writes, and binds default model imports to memory adapters. Only the isolated general preparation store can create a memory row. Queries preserve Mongoose's single-use thenable behavior.

The offline worker has the remaining portion of a nine-minute budget; the whole CLI has a 9.5-minute cutoff. Normal worker completion and tested timeout handling wait for child exit. These are accident barriers for trusted repository code, not a sandbox for malicious code.

## Honest comparisons

Each stage carries its own baseline. A persisted plan proves preparation, a compiled/sent receipt proves its corresponding admission stage, and a completed verification proves verification. A blocked operation does not downgrade a previously saved step to “refused.”

Operation outcomes are same outcome, newly refused, newly accepted or errored. Any missing/unsupported evidence or unknown baseline makes the operation errored, even if another stage independently identifies a refusal. A newly refused stage has a fixed error code and private-message hash. Newly accepted requires a proven earlier refusal at that same stage, not merely a blocked run. Empty and incomplete results cannot pass. Any newly refused/errored operation or failed advisory preflight exits 1.

CompanySyncRecord has one mutable row per entity/ID, not a version history. The loader cannot load historical snapshots that never existed. A later mirror is never substituted for a pre-send observation. Earlier rows must be within the existing five-minute observation budget. Approved tax sources are never installed as “current” records. A create response only substitutes for an independent fixed read-back when its full body hash is authenticated by the retained read-back proof; an invoice changed by a later payment cannot use its create body.

## Evidence from this job

Read-only command on today's selection:

~~~text
node scripts/agent-harness/replay-gate.mjs --since 2026-10-31 --prove-activity-choices --json
~~~

The earlier full today run finished in 32,308 ms, exited 1, and reported 37 errored operations. Current activity choices passed. Its capture hash was 6225cb63de5742222590c1934de1c952c43e79fa9d7c34d7acc65415ab3bfe37.

After dependency-history and review fixes, the default three-day run finished in 26,150 ms, exited 1, and selected 43 operations. It passed 245 individual stages, but all 43 operations had incomplete replay evidence; none was reported as a whole-operation success.

- Capture hash: 2eea44573363157904c572ac2e731be1672cbd44ff5b67b0e7f705781a03de88.
- Production module hash: 09a889a0f3cdd6ac353887f634fd805567629a6ce38d5f2acda1dfeb726fd0e9.
- Source changed during that run: false.
- Example run: 34282b42ef7d9de9bc6c8e8c. Its saved plan/approval and all six retained period proofs passed; preparation lacked the historical sync watermark, compilation lacked as-of records/writer state, and verification lacked its exact body.
- Other example IDs: 731dd3387b02d6dfa849dd98 and e63f77a12b97798381ce2116.
- Real-data activity-choices preflight passed. Restoring the single-use query bug from 96fe35a in memory made the same stored data fail with REPLAY_ACTIVITY_CHOICES_UNAVAILABLE. regressionProof.proved was true.
- The separate non-JSON Date bug double did not fail on this real capture; its selected payloads did not reproduce that shape. The synthetic Date-bearing test does fail with that bug and passes with current code. These are distinct proofs.

The current gate therefore **does not satisfy the full historical replay acceptance requirement yet**. Its successful parts and its missing inputs are observable. Broad commit gating remains red until a separately scoped production capture change retains per-stage reference/list versions and sync watermarks, writer/calendar/authority state, exact read/query/report responses, and stage-specific success/refusal outcomes. Historical gaps cannot be recovered through hashes, guessed state, or fresh QBO calls. RG owns no production source or database writes, so that capture change was not made here.

## Verification and review

From backend:

~~~text
node --test test/replay/replay-gate.test.cjs test/general-write-dated-sales-replay.test.js
~~~

23/23 passed (22 new replay tests plus the existing dated-sales replay). Coverage includes single-use queries, BSON/date boundaries, both regression doubles, stale/later snapshot rejection, changed financial output, saved-to-rejected correlation, unresolved preparation, per-stage baselines, redacted errors, empty selection, child completion and timeout cleanup.

An additional run included test/business-activity-choice-economy.test.js: its standalone general-tool mock failed with “store.event is not a function” in concurrently edited business-agent-tools.js. RG did not edit that suite or production file. This failure is separate from the replay tests; it has not been repaired or waived here.

Distinct implementation and safety reviews found and drove fixes for query execution, source decoding, stale-data substitution, baseline attribution, wrong-payload verification, response correlation, readback ordering, write blocking and memory budgets. Remaining review limitations are the explicitly missing full historical capture/admission coverage above.

Work-value decisions: essential outcome is a trustworthy regression signal; smallest proof is current stored activity passing and its historical bug double failing. The historical-snapshot investigation established overwritten/missing bodies rather than a repairable loader query. The chosen safe delivery is a red diagnostic gate plus exact missing-input codes; no production capture framework, service restart, QBO read/write, Mongo write, branch/worktree, commit or push was introduced.

### Work-value ledger

- 2026-11-01T02:37:10.160Z: essential historical-input audit; capture read only. Original as-of bodies were missing, so no claim of full replay. Continued with explicit gap detection rather than inventing state.
- 2026-11-01T02:43:31.945Z: final delivery checkpoint. Default capture replay finished in 26.15 seconds, reproduced the query regression, and remained red for missing history. Focused tests 23/23 and all seven syntax checks passed. Deferred production capture/complete coordinated-admission work because it requires files and database behavior outside RG ownership.
