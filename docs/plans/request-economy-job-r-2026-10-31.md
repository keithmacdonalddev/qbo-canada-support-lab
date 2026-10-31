# Job R — verification regression repair, 2026-10-31

Status: applied locally in one backend/src batch at 2026-10-31T23:49:47.768Z. No commits, service controls, QBO calls, MongoDB queries or writes. Saved source exactly matches the independently reviewed scratch candidate. Live company behavior remains unverified.

## Findings and decisions

- Baseline requested five-file run reproduced exactly three failures: 68 passed, 3 failed. The feature-coverage skill description omitted its usage trigger; it now begins "Use when" with the same coverage/planning meaning and passes existing size limits.
- Both runtime safety expectations remain required. No original test assertion was changed. E2's async loadGraphReadback wrapper converted immediate bound-company rejection into a rejected promise, creating unhandled asynchronous test activity. The outer scope check is synchronous again; graph work remains asynchronous. Transaction, current actor/owner and exact operation/plan checks are retained.
- Shared ledger reports were keyed by endpoint and writer fence, allowing a changed full record to borrow an old report despite missing its per-record cache. A bounded map now tracks full record hash, original compilation, receipt and account binding. Observed changes clear retained report evidence, including a change back to old content. Unchanged records retain E2 sharing.
- Independent safety review also identified a first-time record observed after a shared report started. It now requires a new report. Prepared graph records observed before report start still share the endpoint/fence report. The independent post-report full GET, original observation times, actor/owner checks, before/after writer fence, exact ledger identity and gross posting checks remain intact.

## Original stored-data proof

The ignored original E2 snapshot is reused without a database connection; no fresh company data was fetched. The original SDK adapter permits GET only and the offline preload denies HTTP/HTTPS, sockets and fetch.

Stored Invoice 11021, operation 86c4c09ef5b8768c1ebf7d91, traverses the same createBusinessVerificationRuntime.readRecord -> accountRead -> accountPostingEvidence path used by live graph verification. Controlled in-memory Balance changes preserve SyncToken and then restore original content. Original code fetched report counts 1/1/1/1 across initial/unchanged/changed/restored reads and failed the safety expectation; saved fixed code fetched 1/1/2/3 and passed. The same stored scope input proves immediate wrong-company rejection is restored. Changes affect only replay memory, not the stored snapshot or company.

The complete original createBusinessStepStore.verifyGraph -> verification runtime -> graph/readback path also passes all nine stored operations (85 records). First verification remains 70 calls, including nine ledger reports; repeat remains 14 calls. These are identical to E2's recorded savings. This does not prove the live whole-day calls/record target.

Representative replay operation 3359607d8aee4df04a3d88da verifies all 36 records with 21 initial calls and nine repeat calls. All nine exact operation results are retained in artifacts/job-r-verification/current-replay-result.json.

## Verification and review

From backend, saved-source command (exit 0, 75 passed, zero failures/skips):

~~~text
node --require ../artifacts/job-e2-call-economy/offline-only.cjs --test --test-reporter=spec test/business-agent-skills.test.js test/business-verification-runtime.test.js test/business-call-economy-v2.test.js test/business-operation-freshness.test.js test/business-graph-readback.test.js
~~~

Four added regressions cover actor/owner changes inside the transaction; same-SyncToken content changes and old-content return; fresh ledger rejection of incorrect gross postings; and a late first-time record whose current ledger lacks its approved posting.

Saved-source offline replays (both exit 0):

~~~text
node --require ../artifacts/job-e2-call-economy/offline-only.cjs ../artifacts/job-r-verification/replay.cjs current
node --require ../artifacts/job-e2-call-economy/offline-only.cjs ../artifacts/job-r-verification/stored-cache-replay.cjs current
~~~

Root command node scripts/agent-harness/check-backend-syntax.mjs: exit 0, all 304 backend JavaScript files pass. Focused scratch tests and replay passed before saving. Distinct read-only implementation and safety reviewers inspected current candidate and test/replay evidence; no remaining concrete findings after the late-participant correction. Final source equality was checked locally.

Raw snapshot stays at its original ignored location. Job R scripts, frozen original runtime, before/after logs, check-summary.json, applied.json and work-value.json remain ignored under artifacts/job-r-verification. Source locks were acquired before comparing originals, held through the single final batch and released. Branch/upstream: main -> origin/main. No commit/push by explicit instruction. Full backend suite and live checks were not run.

## Owned files

- backend/src/modules/business-verification-runtime.js
- backend/src/accountant-skills/feature-coverage/SKILL.md
- backend/test/business-verification-runtime.test.js
- docs/plans/request-economy-job-r-2026-10-31.md

Work-value checkpoint: essential accountant-verification repair; original regression and stored-data proof completed before one source batch. No optional detour or new runtime framework. Current milestone: saved-source focused tests, both replays and backend syntax pass; finish with owned-diff/whitespace verification.
