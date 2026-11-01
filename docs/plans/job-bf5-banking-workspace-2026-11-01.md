# BF5 desktop banking workspace — 2026-11-01

## Result and limits

Implemented the standalone BF5 desktop workspace. It is intentionally **not mounted** in Company.jsx; backend routes remain unchanged. No backend/src saves, commits, service control, QBO calls or MongoDB access/writes were performed by this job. Concurrent BF7 files were read for their status contract and not edited.

The account-month table shows Generated / Uploaded / Reviewed / Reconciled separately. Detail includes files with authenticated, hash-checked downloads, a simulated-statement PDF preview, exact blocked reasons, row decisions and QBO references, outstanding timing items, interrupted-import recovery instructions and native-work checklists. Loading, empty, failed refresh, stale revision and truncated-list states are explicit. New company scope cancels pending loads and clears the displayed company data and filters.

BF4 evidence cards retain strength labels, timestamps, run/step/outcome, screenshot paths and SHA-256. A screen-observed label supplied by Terra remains **Terra-reported**, without inferred independent verification. BF7 status can separately show **Observed** versus **Terra-reported only**, its checks, blocked reasons and screenshot/report references.

**Screenshot image preview remains unavailable:** BF4 serves package CSV/PDF/manifest artifacts, but has no endpoint for native evidence images. This UI shows retained screenshot references and hashes, not fabricated image URLs. Simulated statement PDF preview uses the existing authenticated package-file endpoint.

**Rendered desktop acceptance is unverified.** Computer-use inventory returned no browser surfaces and reported: “Computer Use native pipe is unavailable … The system cannot find the file specified. (os error 2)”. No services were launched. Offline React serialization and builds are verified, not visual acceptance or browser interaction.

## BF6 connection contract

- Mount the existing BF4 router beneath the company scope middleware at **/api/company/banking-workspace** (the frontend client already has /api as its base).
- Mount BankingWorkspace with a scopeKey that changes with the connected company/environment/connection. Supply accounts as [{id,name}] when available; the fallback is Account #id.
- BF4 GET list/detail/files responses are consumed unchanged. This frontend adds no evidence-write or native-execution calls.
- Optional operatorStatusByPackage is a dictionary keyed by package id containing BF7 status() output: {packageId,accountId,period,blocked,reasons,steps}. Package/account/period and every run's company scope are checked before display. BF6 must fetch this through its authenticated company-scoped integration; BF5 does not invent an operator endpoint.
- The api prop can inject an alternative read adapter with list({signal}), detail(id,{signal}), file(id,file). An injected file adapter must preserve authenticated scope and byte-hash verification.
- Until operator status is supplied, independent run verification is explicitly unavailable. Successful generation, a reviewed pending exception, C/R marks or a screenshot reference do not become reconciliation completion.

## Direct offline evidence

Source fixtures: backend/test/fixtures/bank-settlement-history.json and bank-opening-history-evidence.json, retained from the banking audit with SHA-256 80d14fb4b16ca4107e73abcce40a675227dbfeb8ebc032429613864bf6daecc5. No fresh company state is claimed.

The new test replays the actual production path: buildBankStatementEvidence / buildSettlementEvents → generateBankStatementPackages → injected-memory BF4 register/detail/list → actual BF5 components and status code. All **324 external account-months** were admitted and serialized into the UI; **317 ready**, **7 blocked**; **1,385 deposit links** preserved. Ready means eligible for native work, not uploaded/reconciled. The replay confirms Invoice 486 = CAD 50.00, Payment 26 = CAD 3,423.49, two account legs for CreditCardPayment 483 and Transfers 343/345, and no native cash event for JournalEntry 200.

Seven blocked account-months retain their exact reasons:

| Account | Month | Reason |
|---|---|---|
| 60 | 2020-07, 2020-08 | Existing reconciled marks require native inspection |
| 60 | 2020-10, 2021-01 | Report-only adjustments require native inspection |
| 66 | 2023-08, 2024-02 | Existing reconciled marks require native inspection |
| 85 | 2022-04 | Existing reconciled marks require native inspection |

Terra/interrupted-import, native-report, synced-record and operator-journal examples in the UI tests are **synthetic evidence overlays on real packages**, not claims of actual completed native runs. No live upload, review or reconciliation was performed or asserted.

## Verification

All commands ran with the general Node REPL and explicit child_process execFile arguments, windowsHide:true, no shell wrapper. Tests ran one file at a time from backend/.

- node --test test/banking-workspace-ui.test.js — **7 passed**, exit 0. Real stored replay; stage separation, quiet months, revisions, blocked reasons, evidence distinctions, BF7 journal scope, unavailable/stale/empty states, wrong response and altered file rejection.
- node --test test/banking-workspace.test.js — **21 passed**, exit 0. Existing BF4 contracts and its real-history replay.
- Frontend script equivalent: node ../node_modules/vite/bin/vite.js build from frontend/ — exit 0; existing >500 kB chunk warning. Since BF5 is unmounted, a separate Vite library build explicitly compiled BankingWorkspace.jsx and its imports/CSS into an owned temporary output directory — exit 0.
- node ../node_modules/eslint/bin/eslint.js . from frontend/ — exit 0, no errors; three pre-existing hook warnings in AICommandCenter.jsx.
- git diff --check and owned untracked-file whitespace checks — verified at closeout.

No sensitive backend, route, auth, database or execution implementation was changed; independent implementation/safety reviews were not required for this read-only frontend slice. Visual review remains unavailable as stated above. No mobile checks were performed.

## Owned files

- frontend/src/components/banking/BankingWorkspace.jsx
- frontend/src/components/banking/BankingAccountPeriod.jsx
- frontend/src/components/banking/banking.css
- frontend/src/api/banking.js
- backend/test/banking-workspace-ui.test.js
- docs/plans/job-bf5-banking-workspace-2026-11-01.md (this record)

No shared-file edits or locks were needed. Changes remain uncommitted on main under the explicit job instruction.

## Work-value ledger

- 2026-11-01T05:04:48.117Z — First BF5 source creation (orientation preceded this timestamp). Essential outcome: make account-month banking work and evidence inspectable. Smallest proof: replay retained packages through the actual display code. Delivery milestone: standalone workspace plus offline replay.
- 2026-11-01T05:09:54.616Z — Replay passed for 324 account-months; standalone build/lint passed. No live company records or completed business periods delivered by this frontend job. Native rendered review unavailable; stopped that branch after inventory evidence rather than attempting service changes. Required BF6 mounting and evidence-image serving remain explicit integration work, not hidden completion claims.
