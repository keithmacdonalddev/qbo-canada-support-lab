# BF7 banking operator — 2026-11-01

Delivered a backend-only, explicitly invoked banking operator. It is unmounted:
no company route, accountant scheduler, service, browser or QBO execution was enabled.
No commits were made during this job.

## Scope and evidence

The operator consumes the exact retained BF2 manifest plus BF4 package detail.
Readiness requires readyForNativeWork=true, matching immutable events/files/balances,
current account identity/name/currency, no revised-history/native blockers, and no
unfinished earlier account period or operator step. Target is production Company ID
9130357222392856, displayed name My Business (observed screen map and current
terra-live.sh override the stale Harbour & Pine company-name guidance in terra.md).

Offline real-history replay used fixtures/bank-settlement-history.json and
fixtures/bank-opening-history-evidence.json through their actual BF1/BF2 builders,
then actual BF4 register/detail/evidence methods and BF7 execute. The historical
builder produced 324 external periods, 317 ready and seven explicitly blocked.
The selected account 60 / August 2023 package is
6055d6c6d34e7f989362f7ef12c2269ad2fb380c17792269858997eddd08bd4d:
12 rows including Payment 26 = CAD 3,423.49. All Terra results/screens/report
observations in this replay are recorded fakes. This proves the offline path,
not a completed live upload or reconciliation. No stored BF7 failure existed;
tests replay stopped/unknown outcomes against this real package rather than
inventing a historical BF7 incident.

## Calling contract for the integration job

Import createDefaultBankingOperator from banking-terra-runner.js. Construction
and import do not execute anything. Supply an authorized BF4 workspace service,
getAccount(scope, accountId), and readVerification(request). Invoke execute(user,
{packageId, step, rules?, desktopFallback?}) for exactly one step. Step shapes:

- {type:'preflight'}: read-only current account screen, refreshable after five minutes.
- {type:'upload', fileId}: one exact CSV. Requires fresh preflight; persists BF4 start
  with its actual screenshot before launching the UI. Interrupted upload is never retried.
- {type:'rules'}: explicit create/adjust specs (name, accountId, period, conditions,
  categoryId, taxTreatment, deliberate autoPost boolean; adjust also ruleId/before).
- {type:'review'}: exact remaining Match/Add/Exclude rows, references and BF3 decisions.
- {type:'reconcile'}: exact ending date/balances, zero difference, outstanding items,
  distinct native report and completion screenshots. Does not yet mark BF4 reconciled.
- {type:'attach'}: exact statement PDF ID/hash attached to the completed reconciliation;
  only then does BF4 receive reconciled evidence. PDF never uses Upload from file.

status(user, packageId) exposes persisted account-level blocked reasons and this
package's step evidence. No route has been mounted for these methods.

The default write authorizer calls existing periods.manage access before UI work.
readVerification must be a scoped, read-only complete mirror/report reader, never
an implicit QBO refresh: before returns {scope, complete:true, observedAt, records,
settlementEvents}; after returns {scope, observedAt, records, marks?, reconciliation?}.
Records are CompanySyncRecord-shaped, including scoped identity, raw record and
lastObservedAt. Native Add must be new since preflight/current run and pass BF4's
account/native amount/date/currency/creation-time verification. Sync lag blocks
without repeating Add.

For BankOrigin review rows, supply resolveRows({scope,pkg,before}) to re-run BF3
against this exact fresh complete mirror and persisted creator reservations.
Results must carry mirrorHash for that same snapshot. The integration adapter
must explicitly prove API-created bank-origin records before preparing a Match;
an old accounting-draft is not an executable native task. Native transfers are
blocked before UI unless supportsNativeTransfer=true, which the integration job
may supply only with paired-reservation coordination and BF4's specialized
verifyAddedRecord settlement verifier. BF4's default Add verifier does not support
Transfer; do not enable the capability with only a generic record-presence check.

A mark is observed only when it supplies scope, rowId, exact qboRefs, accountId,
accountCurrency, amountMinor, date, mark C/R, fresh observedAt and a retained hashed
artifact below hash(scope)/accountId/. Reconciliation report observations also
need exact period/opening/closing/outstanding items/completed/zero difference.
The default report-artifact reader verifies retained bytes. Otherwise verification
stays Terra-reported only. Old C/R feature marks never prove current reconciliation.

## Runner and recovery

The default runner uses hidden Git Bash with explicit arguments and the existing
terra-live.sh --chrome core (codex exec, gpt-6.1-terra, medium effort, fixed stop list).
Chrome claims the existing QuickBooks tab; there is no automatic desktop retry.
A desktopFallback must name this exact step and explain the browser limitation.
The connected-feed security error card is explicitly ignored; connections are forbidden.

The wrapper now owns an atomic shared temp qbo-terra-live.lock for ALL Terra modes,
checks for pre-lock-version Terra processes and checks final marker-process cleanup
even if sampling was empty. BF7 also serializes its complete journal/BF4 transition
with qbo-banking-operator.lock. Neither lock is stolen on age or PID guesses.
A 20-minute wrapper timeout plus bounded outer cleanup stops only the owned process
tree; missing cleanup proof retains locks. No claim is made that process sampling
can detect every detached helper. UI stop lists remain instructions, not a sandbox.

Successful acceptance requires effective-model evidence from the runner settings
section and zero shell/flagged command-audit entries. Native-result JSON/action
ledger, exact file hashes and retained screenshot bytes must agree. Evidence is
copied to namespaced banking artifacts; tasks/journals and original reply/command
ledgers remain local artifacts. A stopped/unknown/failed verification run leaves a
durable blocked reason. No automatic recovery, journal reset, import retry, undo,
reconciliation adjustment or deletion is implemented. A later recovery job must
observe native state and preserve accepted actions before clearing any block.

## Verification and outcome ledger

- Achieved: exact tasks, runner invocation, global serialization, blocked status,
  BF4 transitions and evidence grading through offline production paths.
- Achieved: 20 focused BF7 tests, including real package replay, real BF3 resolver
  plus BF4 Native Add verification, missing sync, wrong PDF, wrong rule settings,
  old/future/cross-company report marks, model spoof and failed-kill timeout.
- Required review: distinct read-only implementation and safety reviews completed
  on scratch, including status(). No remaining findings; live behavior unverified.
- Unverified: actual Chrome/desktop access, upload/matching/rules/reconciliation,
  production reader adapters and live process cleanup. No Terra/QBO calls, MongoDB
  queries/writes or service controls were performed. No route mounting.

Tests run one file at a time from backend: node --test test/banking-operator.test.js
and node --test test/banking-workspace.test.js. Also node --check for the two new
modules, bash -n for terra-live.sh, and git diff --check. Published-source results: BF7 20 passed; BF4 21 passed; zero failures/skips.
Both module syntax checks, shell syntax, and git diff --check exited 0.
Final source/test/script bytes matched reviewed scratch; source batch at
2026-11-01T05:03:19.370Z. All six owned files remain local, uncommitted, by request.

## Work-value ledger (UTC)

- 04:56:04: essential BF7 offline delivery; smallest proof is the real Payment26
  package through production execute with recorded fake Terra; prepared in scratch.
- 05:00:46: replay passed; continued only direct review findings (authorization,
  uncertain-run blocking, report evidence, timeout/cleanup). No optional detours.
- Final batch: publish only the two new modules; preserve concurrent OB work and
  current services. Live company outcome is explicitly unverified by this job.
