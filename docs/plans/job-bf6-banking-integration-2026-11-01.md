# BF6 banking integration — 2026-11-01

## Result and direct evidence

Prepared offline, reviewed independently, then published backend/src in one batch. No commits, service controls, QBO calls, storage-route calls or MongoDB writes. Changes remain local on main by owner instruction. The new native loop is disabled by default; the existing local BANKING_OPERATOR_ENABLED flag was checked as not true without printing environment contents.

Read-only Mongo inspection captured Savings account 1150040007 / October 2026: Transfer **591**, CAD 1,000, dated October 2, and additional Deposit **11232**, CAD 1,000, dated October 5. Deposit11232 was still present in that synced observation; this is not a claim about Terra's subsequent undo or current QBO state. Both Mongo connections used for evidence were closed. Sanitized failing record fields are retained in backend/test/fixtures/banking-savings-autopost.json. Rule names/settings (add sales, Google, amount > -1.00) came from the owner's incident report; real rule IDs were unavailable and test-local IDs are explicitly identified.

The actual BF1/BF2 builders, BF6 manifest registration, BF4 persistence and BF7 execute are replayed offline. Savings package **07375dd6f1efdd11d4ef11c99dda172c31010b3d040c674e5b1c983f6696bb56** is the real Transfer591 package. Payment26 package **6055d6c6d34e7f989362f7ef12c2269ad2fb380c17792269858997eddd08bd4d** retains CAD3,423.49 and all 12 rows. Browser actions/screenshots in tests are fakes; stored accounting identities/amounts are real retained inputs. Replays prove refusal before upload for the reported rules and account blocking when Deposit11232 appears after upload or Match. They do not prove live upload, matching or reconciliation.

## Integration and decisions

- Mounted the authenticated BF4 workspace at /api/company/banking-workspace and the existing desktop Banking component on Company. Package detail carries scoped BF7 status; list and deferred tools carry durable scheduled-loop pause status. Exact diagnostics are shown only when the package is in the authorized response.
- Deferred accountant tools: getBankingWorkspace, getBankingPackage, prepareBankingPackage, getBankingCloseSupport. Preparation registers an exact already-generated retained BF2 manifest and artifacts through BF4; generation stays outside the 220-record write loop. No native browser execution tool was added to model reviews.
- Period-close support exposes native report/completion/statement references, currency, balances and outstanding items. It does not invent manual confirmations, certify all bank/card/cash inventory, or advance protection. BK1's manual v2 period-close contract remains the authority for its review/apply path; no BK1 modules were changed.
- BF7 defaults to terra-live.sh --flow. The wrapper uses unique bf7 run/output IDs but agent-browser session qbo-ops, profile C:/Users/NewAdmin/.qbo-automation-profile, headless. It preserves that already signed-in persistent session and retains the all-Terra lock/process audit. No Chrome plugin or automatic desktop retry.
- Each upload automatically runs a separate read-only Banking > Rules pre-flight, including all pages/statuses and retained screenshot. Unknown completeness/status/account scope blocks. Any active Auto-post rule for all accounts or this account blocks regardless of predicates. The deliberate exception is an injected server-side ruleScenarioFor adapter bound to exact package, account, CSV file, rule IDs and complete rules hash; ordinary tools cannot supply an exception. It never suppresses the duplicate guard or authorizes unlisted records.
- Review now executes exactly one pending row per native run. Before the next row, the complete scoped mirror must show no new accounting record in that account except the exact declared Add result. Uploads get the same guard to catch Auto-post before matching. Existing matches must create no new records. Sync lag blocks durably and never retries Add/Match.
- Verification waits for the existing sync's conservative CDC covered-time cursor (source.since) beyond the coordinator timestamp captured AFTER Terra returns. A query timestamp or sync that finished during navigation is insufficient. The read-only adapter waits up to seven minutes for normal five-minute CDC plus overlap; it makes no QBO refresh request. Read-only Rules preflight skips mirror waits, and upload rechecks actual Rules observation age after waiting for its before-snapshot.
- The operator loop is separate from accountant record production: one step per tick, newest revision per account-month, globally oldest unfinished month first, shared Terra lock inspection and wrapper atomic lock, no concurrent tick execution. Any banking block pauses the loop in artifacts/banking/operator-loop-paused.json. Persistence failures also pause in memory and cannot crash the independent accountant. Recovery requires observing native state, preserving accepted actions, resolving the precise block, then explicitly clearing the pause; there is no automatic clearing/replay/undo.

## Storage preview/apply profiles (not called)

Use the authenticated existing **POST /api/company/business-setup/storage/preview** with {"profile":"banking"}, {"profile":"close-checklist"}, and {"profile":"replay-evidence"} separately. Inspect each returned missing-collection/index plan, then use **POST /api/company/business-setup/storage/apply** with the same profile and its exact returned planHash, under separate authorization. No routes were called by this job.

- banking (v8): bankingevents / BankingEvent and bankingpackages / BankingPackage, with their exact named unique revision indexes.
- close-checklist (v9): businessclosechecklistevidences / BusinessCloseChecklistEvidence with its exact unique scope/owner/period/account/check/revision index.
- replay-evidence (existing v7, retained unchanged): businessreplayevidences / BusinessReplayEvidence, existing 30-day TTL and scoped operation index.

These are additive preparation profiles: populated business records and v4/v6 setup receipts stay intact. Banking/close-checklist refuse the initial-install API. Existing general-writes remains its own v6 profile. No storage or runtime feature was activated.

Future authorized activation requires prepared storage, retained package registration, current sync, the existing signed-in qbo-ops browser and BANKING_OPERATOR_ENABLED=true on owner-controlled startup. Source publication alone does not enable it. The scheduled loop's first blocked historical month pauses all scheduled banking until inspected; independent accountant production continues.

## Validation and limits

Tests were run sequentially, one node --test file at a time from backend/, first against a scratch source overlay and then affected final-source checks. Commands and final counts are recorded below at closeout. Node syntax, shell bash -n, staged desktop build, changed-UI ESLint, and git diff --check are required. The UI build retains the pre-existing large-chunk warning.

Distinct read-only implementation and safety reviewers inspected scratch and fixes. Findings addressed: post-action covered-sync boundary, selecting the row before validation, Rules-screen age rather than journal completion time, persistent-profile arguments/run-name validation, pause-write failure containment, authenticated pause visibility. No remaining findings on final reviewed source.

Live browser/session behavior, completed reconciliation and desktop rendered acceptance remain **unverified**. The live Company screen triggers a QBO health probe; opening it for rendered verification would violate this job's no-QBO-call restriction. Offline build/serialization is not rendered live acceptance.

## Work-value ledger (UTC)

- 05:12:35 — Essential BF6 scratch preparation started. Outcome: prevent the observed duplicate while connecting retained banking work. Smallest proof: Transfer591/Deposit11232 through the actual execute path. Next milestone: reviewed offline replay, then one source batch.
- 05:19:09 — Real failure replay and integration checks passed; current main checkout remained clean and all owned baselines unchanged. No live banking outcome delivered. Continue only required review corrections and publication; no optional investigations.

## Published-source verification

Backend source batch: **2026-11-01T05:20:11.752Z–05:20:11.759Z**. All 21 published files matched the reviewed scratch bytes immediately afterward; all basename locks were released.

From backend/, each command ran separately: `node --test <file>`. **216 passed, zero failures/skips** across:

- test/banking-operator.test.js — 25 passed; exit 0.
- test/banking-integration.test.js — 10 passed; exit 0.
- test/banking-workspace.test.js — 21 passed; exit 0.
- test/banking-workspace-ui.test.js — 7 passed; exit 0.
- test/business-storage-setup.test.js — 44 passed; exit 0.
- test/business-setup-service.test.js — 13 passed; exit 0.
- test/business-setup-routes.test.js — 4 passed; exit 0.
- test/business-agent-tools.test.js — 22 passed; exit 0.
- test/business-agent-toolbox.test.js — 6 passed; exit 0.
- test/business-agent-service.test.js — 60 passed; exit 0.
- test/company-permission.test.js — 4 passed; exit 0.

Other final commands: `node scripts/agent-harness/check-backend-syntax.mjs` (332 files, zero failures); `node ../node_modules/vite/bin/vite.js build --outDir <owned-temp-output>` from frontend/ (exit 0); `node ../node_modules/eslint/bin/eslint.js .` from frontend/ (exit 0, three pre-existing AICommandCenter hook warnings); `bash -n .claude/skills/qbo-team-delivery/scripts/terra-live.sh` (exit 0); `git diff --check` (exit 0). Build output remained in the owned temporary scratch folder, with the existing large-chunk warning and the expected external-output-directory notice.

## Owned files

- backend/src/modules/banking-operator.js
- backend/src/modules/banking-operator-guards.js
- backend/src/modules/banking-terra-runner.js
- .claude/skills/qbo-team-delivery/scripts/terra-live.sh
- backend/src/modules/business-storage-setup.js
- backend/src/modules/business-setup-service.js
- backend/src/modules/banking-operator-loop.js
- backend/src/modules/banking-accountant-tools.js
- backend/src/modules/business-agent-tools.js
- backend/src/modules/business-agent-toolbox.js
- backend/src/modules/business-agent-service.js
- backend/src/routes/banking-workspace.js
- backend/src/routes/company.js
- frontend/src/pages/Company.jsx
- frontend/src/components/banking/BankingAccountPeriod.jsx
- backend/test/banking-operator.test.js
- backend/test/fixtures/banking-savings-autopost.json
- backend/test/banking-integration.test.js
- frontend/src/components/banking/BankingWorkspace.jsx
- backend/test/business-storage-setup.test.js
- docs/plans/job-bf6-banking-integration-2026-11-01.md

All owned changes remain uncommitted/untracked on main as requested. No persistent service was started/stopped, no native operator was executed, no QBO or storage-setup route was called, and no MongoDB writes were made. Read-only evidence connections were closed.
