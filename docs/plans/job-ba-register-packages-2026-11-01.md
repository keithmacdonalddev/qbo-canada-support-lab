# JOB BA — register retained banking packages (2026-11-01)

## Delivered scope and evidence

Registrar: scripts/banking/register-packages.mjs. No backend/src changes or reloads, commits, service controls, live API/QBO calls, MongoDB reads/writes or environment edits were performed by this job. Changes stay local on main.

The exact mounted route is **POST /api/company/banking-workspace/packages**, from app.js -> company.js -> banking-workspace.js. Imports, rows and reconciliation use /api/company/banking-workspace/packages/:id/{imports,rows,reconciliation}. The existing artifacts/luna/tmp/api.js prepends /api, so the registrar passes /company/banking-workspace only. It reuses that helper without editing it; tokens remain in helper memory, and only its HTTP status is parsed. Every request body/response is privately retained under artifacts/banking/registration-*/. Errors never automatically retry.

The real source is artifacts/goal-realization/job-ob-20261101/replay-result.json and packages/. There are **324 external account-months: 317 READY and 7 drafts**. All 317 READY manifests pass individual BF6 conversion and the real BF4 service registration validator, including artifact hashes, actual CSV dates/amounts, row crosswalks, scope, balances and event reservations. Offline adapters replace only authentication, account lookup and persistence; live account/storage validity is unverified.

**The requested full registration outcome remains unmet by the retained inputs.** With drafts omitted and an empty workspace, only **208 READY packages** can register oldest first; **109 READY descendants** fail BF4 carry-forward. Drafts contain movements, so skipping them leaves an opening balance unequal to the last registered closing. First blocked READY: account60, September2020, package 4853ea5aa6e7e1fd777ccf5e3ed62f2eb5dcbb075527ba9ebd42e09af054ae92. Draft gaps: account60 July/August/October2020 and January2021; account66 August2023 and February2024; account85 April2022. The 85 gap does not block later READY carry-forward in the current inputs. The script never changes balances, promotes drafts or weakens the service. Live inventory is reconsidered on every invocation; a separately resolved registered history bridge can unblock descendants. Full draft reasons and each deferred package are printed or retained in result.json.

Savings package **07375dd6f1efdd11d4ef11c99dda172c31010b3d040c674e5b1c983f6696bb56** binds account1150040007, CAD, October2026, opening0/closing100000 minor units, one row, existing **Transfer591**. Book date is **02/10/2026**; the generated CSV settlement date is **05/10/2026**. Those dates are deliberately preserved.

Retained Terra evidence:
- artifacts/terra-live/qbo-ops-20261101-010117/upload-result.png — completed import; Terra reported no visible native bank-feed id.
- artifacts/terra-live/qbo-ops-20261101-010805/rules-disabled.png — rule changes from the incident.
- artifacts/terra-live/qbo-ops-20261101-011242/register-matched.png and reply.txt — match to the existing transfer; Terra reports undo of auto-post Deposit11232.
- Same final folder: reconciled.png visibly confirms completion and zero difference; attachment.png shows the statement attached; register-final.png visibly shows Savings, ending1,000.00 and “Reconciled through 31/10/2026.” Terra reports R; the retained final screenshot clips the status column, so this job does not claim it independently saw R.

**No native reconciliation report was retained in those folders.** BF4 requires that report in addition to separate completion and attachment observations. Without it, the script records uploaded/reviewed/matched through the existing routes, retains the Terra-reported plus observed reconciliation facts in the match reason and result receipt, and leaves the workspace's strict reconciled flag false. It exits **2** for this remaining gap or any deferred READY packages. It does not pass a screenshot or simulated statement as a native report. The explicit local row observation key is labelled as such, never represented as a QBO id. Evidence observedAt uses the retained file modification time; it is not a fresh live observation.

## Orchestrator execution

1. Keep the native banking operator disabled while registering. The registrar requires GET /api/company/banking-workspace to explicitly return operatorLoop.enabled=false before its first POST. Unknown/enabled state fails closed. Do not race activation with registration. Required banking/close-checklist/replay-evidence storage profiles were reported already applied by the orchestrator; this job does not repeat them.
2. Inspect the offline plan from the repo root:

   node scripts/banking/register-packages.mjs --dry-run

   This makes no API/DB connections and stages no artifacts. It prints complete JSON bodies and paths for each eligible POST, all 7 draft reasons, 109 projected READY deferrals, and the four Savings evidence transitions. Existing hashes cannot be known offline; registration lines are conditional on absence from the authenticated workspace.
3. To complete the Savings reconciliation evidence, retain the actual native QBO reconciliation report PDF separately under artifacts/. Observe that it is for Savings, October2026, opening0/ending1,000 and zero difference; no new reconciliation, upload, Add or Match is needed. Create an artifact descriptor such as artifacts/banking/savings-native-report.json:

   {
     "path": "artifacts/terra-live/<authorized-report-run>/savings-native-report.pdf",
     "sha256": "<SHA-256 of exact PDF bytes>",
     "observedAt": "<actual report observation ISO time>",
     "accountId": "1150040007",
     "period": "2026-10",
     "note": "Native Savings reconciliation report for 31/10/2026, opening CAD0, ending CAD1000, difference0; retained by <operator/run>."
   }

   The operator supplies the factual report identity; a PDF signature/hash alone cannot prove its accounting content. The script rejects simulated statement hashes and evidence paths outside project artifacts. Recheck offline with:

   node scripts/banking/register-packages.mjs --dry-run --native-report artifacts/banking/savings-native-report.json
4. The orchestrator, under its own live authority, runs:

   node scripts/banking/register-packages.mjs --native-report artifacts/banking/savings-native-report.json

   Without a report descriptor it can register the independent packages and record uploaded/matched Savings, but exits2 with the report gap. Non-dry runs copy only hash-verified READY CSV/PDF/manifests and evidence into the service's dedicated artifacts/banking/<scope-hash>/<account>/ namespace, preserving existing bytes. Registration order is month, numeric account id, revision. Existing package id plus contentHash is skipped; a hash collision blocks before POSTs. Interrupted runs re-read immutable hashes/history and resume accepted evidence without a second native action. A pre-existing later account-month blocks backfill before POSTs because BF4 would mark that later statement needs-review. Reconcile differing imported/revised/superseded history explicitly rather than replacing it.
5. Inspect registration-*/result.json and nonzero exit status. Exit0 means no deferred packages and Savings workspace reconciliation evidence is complete; exit2 means independent registration completed but explicit work remains; exit1 means execution stopped. In current empty-workspace inputs, 109 READY deferrals remain even with the native report. Resolve the seven draft inspection gaps through the package-generation/revision workflow, then run the offline validator again. Do not activate based only on files present or passing tests.

## Exact activation and reload behavior (orchestrator only)

After registration/evidence gaps and any banking pause have been inspected and resolved, the orchestrator can append this exact line to .env **without reading or printing .env**:

BANKING_OPERATOR_ENABLED=true

A Node example for the orchestrator is require('node:fs').appendFileSync('C:/Projects/qbo/.env', '\nBANKING_OPERATOR_ENABLED=true\n'). This document does not execute it. Do not append repeatedly, print configuration, or change the application's provider settings.

.env is not watched by nodemon. The flag takes effect on the **next owner-authorized backend reload/start**, which reloads environment configuration. This job neither triggers nor requests a service restart or dummy backend/src edit.

On normal business-agent service start, BANKING_OPERATOR_ENABLED==='true' creates and starts the independent banking loop: an immediate tick, then a 60-second interval. Each tick rereads saved workspace state; it selects the highest revision per account-month and the globally oldest unfinished month, then performs **one** upload/review/reconcile/attach step. It does not resume a Node registrar process or regenerate packages. A completed Savings workspace package is skipped. Production agent eligibility still requires monitoring=true, autonomous=true, a standing grant and an owner user in the target company.

The signed-in qbo-ops Terra session, current covered sync, exact retained files and disabled applicable Auto-post rules are prerequisites. Shared Terra locks defer work. Any uncertain import, needs-review history, package blocker, sync/rule/duplicate failure or durable pause stops scheduled banking; independent 220-record/day accountant production continues. Read artifacts/banking/operator-loop-paused.json and the authenticated workspace operatorLoop diagnostics. Resolve the exact condition and preserve accepted native actions before explicitly clearing a pause under separate orchestrator authority. Never replay an uncertain upload, Add or Match.

## Verification and outcome ledger

Run from backend/: node --test test/banking-register-packages.test.js, node --test test/banking-workspace.test.js, node --test test/banking-integration.test.js. Syntax: node --check scripts/banking/register-packages.mjs from root. Whitespace: git diff --check. Final results are recorded below after the focused run.

The test for the final reconciliation command uses an explicitly synthetic native-report adapter, together with the real Savings manifest and real retained completion/attachment bytes. It proves validator acceptance with a correctly classified report, not that a real native report currently exists.

Work-value decisions (UTC):
- 05:24 baseline: essential registrar milestone; canonical main clean; smallest proof is real manifests through production service, without touching backend/src.
- First offline replay: sourceReader exact-envelope mismatch corrected. Second replay exposed true draft carry-forward incompatibility; do not change service or generated balances.
- Focused replay: 317 individual valid, 208 sequentially eligible, 109 deferred; Savings upload/match valid, reconciliation report missing. Continue independent registration tooling; full live outcome remains unverified.
- Required independent implementation/safety reviews requested. Findings addressed: disabled-loop preflight, path/junction containment, exact completed Transfer591 outcome, needs-review/superseded rejection and existing-later backfill preservation. No supporting test/commit is counted as live dataset delivery.

Owned files: scripts/banking/register-packages.mjs; backend/test/banking-register-packages.test.js; this document. No shared files edited; no locks required for these disjoint owned paths.

## Final verification — 2026-11-01T05:29 UTC

- From backend/: node --test test/banking-register-packages.test.js — 13 passed, zero failures/skips (includes actual 324-manifest index and real Savings evidence replay).
- From backend/: node --test test/banking-workspace.test.js — 21 passed, zero failures/skips.
- From backend/: node --test test/banking-integration.test.js — 10 passed, zero failures/skips.
- node --check scripts/banking/register-packages.mjs — exit0.
- git diff --check — exit0. All three untracked owned files also had zero whitespace diagnostics (git no-index returns1 for added-file differences; manual trailing-whitespace scan returned zero).
- Distinct read-only implementation and safety reviewers reported no remaining findings after corrections. They did not authorize or execute live work.
- Fresh status: main tracking origin/main, only the three owned files untracked. No commit/push by explicit instruction; no backend/src save, service operation, environment edit or live API/DB/QBO call. Live registration and completed native report remain unverified.
- 05:29 value checkpoint: offline registrar/recovery delivered; no live dataset writes claimed. End bounded builder work and hand the concrete runbook/input gaps to the orchestrator.
