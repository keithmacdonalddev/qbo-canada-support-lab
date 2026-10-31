# Accountant request economy — 2026-10-31

Status: source changes and isolated verification; live request-rate outcome unverified. Owner requested no commits, service controls, QBO calls or direct MongoDB writes. Those boundaries apply throughout. Concurrent work in the four excluded business modules is not part of this change.

## Delivered behavior

- QboRequestDay persists allowlisted caller/purpose counts beside the existing category totals. The existing meter summary exposes today.callers and month.callers, including pending counts. No endpoints, queries, stack traces, record bodies or arbitrary labels are retained by metering. Historical totals cannot be retroactively attributed.
- QboWriteReceipt privately retains bounded successful create/update response envelopes (select:false, minimize:false), outside observed facts, audit events and public transport results. Verification validates the original envelope hash, receipt identities and both actual audits before using it. Sparse, stale, modified, deleted or conflicting observations require an independent read. Original receipts, request identity and no-replay barriers are unchanged.
- Current CompanySyncRecord observations supply complete reference definitions and exact retained tax-source checks. Provenance distinguishes local observation time, actual sync completion, generation, coverage and expiry. Known later master writes invalidate definitions; linked financial balance changes alone do not change approved master definitions.
- Linked child writes invalidate older parent responses and mirror observations until CDC covers the write. Missing/changed parents use full ID queries, grouped by entity in pages of at most 100 exact IDs. Missing, duplicate, partial or oversized rows fail closed. Graph, content, ownership, tax, account and period checks still run.
- One bounded report set is retained privately beside CompanyInfo, independently of its raw record. Same-scope/period/day reuse needs complete current sources, matching full mirror record hashes, matching write receipts, no unresolved writer, and a subsequent conservative CDC coverage boundary. A complete live General Ledger probe must also agree: CDC omits some ledger-affecting QBO types. Changed probes are used in the one refreshed seven-report set. Retained reuse provenance includes the original source hash/times and the new change observation/probe; it is validated again by report evaluation.
- An unchanged omitted-account routing proof can be reused briefly inside one runtime, with exact compilation, receipt, full saved-record hash, approved account definition and current independent record observation. A bounded eight-entry cache cannot replace changed content or extend freshness.

## Explicit request costs retained

Protected-period preferences and linked original dates stay live at dispatch. Corrections retain independent current original-record reads. An omitted AR/AP account still needs an independent ledger proof and unchanged record bracket; a create response cannot serve as both observations. Deposit availability retains two complete scans because a payment's own links do not prove absence of a deposit. Stock close proof retains independent quantities, purchase lots and fiscal settings after graph observations. These paths have caller tags and explanatory source comments.

The current operation contract verifies opening and closing financial movements for every operation. A changed closing therefore still requires its seven reports and complete Account query. Moving all changed-operation proofs to day close would change that contract and is not claimed here. Incomplete/stale sync, large sources, old receipts or retries can exceed the estimate below. A minimally shaped unflagged successful response can fail content verification and require later complete readback; saved identity is preserved.

## Request estimate (code paths, not live measurement)

Example: approval through close for 40 unlinked operating Bills; four distinct references per Bill (supplier, payable account, expense account, tax code), two tax-policy source records, current complete mirror, responses retained within freshness, no stock, no retries. Preparation before approval is excluded equally from both columns.

| Purpose | Before | After |
| --- | ---: | ---: |
| Compilation references | 160 | 0 |
| Retained tax-source checks | 80 | 0 |
| Per-save and final saved-record observations | 80 | 0–1 full Bill query |
| Approval/opening/closing report sets and Account lists | 24 | 17–24 |
| Protected-period preferences | 40 | 40 |
| Writes | 40 | 40 |
| Total | 424 (10.6/record) | 97–105 (2.43–2.63/record) |

17 report requests assumes approval/opening reuse after unchanged CDC: 8 + 1 ledger probe + 8 changed-close requests. Without eligible reuse it is 24. Small linked operations can still exceed three per record. The owner's measured approximately 1,060 requests for five records is the live before observation, not a measured allocation across these purposes. No live after claim is made.

## Verification and work-value ledger

- 2026-10-31T06:11Z: essential request-budget work; smallest proof is mocked request counters plus original verification/receipt rejection cases. Next milestone: instrumentation and authenticated local observations. No live activity authorized.
- 2026-10-31T06:23Z checkpoint: private response/mirror/batch/report reuse implemented; 64 focused tests passed. Source and fixture proof only; the live daily average remains unverified. Continue required integration checks.
- 2026-10-31T06:29Z: the unbounded full test invocation timed out; shared SDK mocks needed ID-IN query support, now added without weakening assertions. The focused financial/runtime integration set passed 21/21. A fresh complete invocation runs with four test workers and captured process ownership. Windows process inventory via CIM was denied; no unrelated process was stopped.
- Independent implementation and safety reviewers found no remaining material/blocking findings after scope, audit, tombstone, master-write, cancellation and freshness corrections. They performed no operational actions.
- 2026-10-31T06:48:01.089Z final checkpoint: 363/363 core tests passed in a fresh current-source invocation (23 files, four workers). The three isolated stock/lifecycle regression files passed 4/4 after their SDK query mocks were made consistent with GET responses. All 279 backend JavaScript files passed the documented syntax checker. Git diff --check passed.
- The complete 131-file sweep did not finish within its allowance; it is incomplete, not passed. Its three observed stock/lifecycle failures were query-mock representation differences (internal fixture cost fields and deliberately omitted QBO fields); all were fixed in the shared mock and the affected cases rerun successfully. Earlier concrete graph/dispatch mocks were also updated for exact ID-IN queries. No assertions were weakened.
- Cleanup: the broad runner PID and its remaining worker PIDs were identified by parent process plus test filenames, then stopped with hidden PowerShell Stop-Process. Taskkill had been denied. No persistent service or unrelated process was controlled. Core and regression runner exit codes were zero.
- No commit command was issued in this task. Concurrent commit 6dbcd6d included the shared business-agent-sync.js recordSummary export. The other request-economy changes remain local/uncommitted; concurrent unrelated work was preserved.
- Live company request-rate outcome, actual persisted meter counts and live mirror/report integration remain unverified; no live QBO or MongoDB action was taken.

## Changed files

- backend/src/modules/qbo-request-meter.js
- backend/src/models/QboRequestDay.js
- backend/src/modules/business-observation-store.js
- backend/src/modules/business-agent-sync.js
- backend/src/models/QboWriteReceipt.js
- backend/src/modules/qbo-write-contract.js
- backend/src/modules/qbo-write-gate.js
- backend/src/modules/qbo-client.js
- backend/src/modules/business-reference.js
- backend/src/modules/business-transaction-batch-reader.js
- backend/src/modules/business-verification-runtime.js
- backend/src/modules/business-graph-readback.js
- backend/src/modules/business-tax-policy.js
- backend/src/modules/qbo-write-period.js
- backend/src/modules/business-report-cache.js
- backend/src/models/CompanySyncRecord.js
- backend/src/modules/business-report-evidence.js
- backend/src/modules/book-evidence.js
- backend/test/qbo-request-meter.test.js
- backend/test/qbo-write-gate.test.js
- backend/test/business-request-economy.test.js
- backend/test/helpers/business-governance-fixture.js
- backend/test/helpers/business-assembled-fixture.js
- backend/test/business-verification-runtime.test.js
- backend/src/modules/business-stock-source.js
- backend/src/modules/business-compilation-runtime.js
- docs/plans/request-economy-2026-10-31.md
- backend/test/business-dispatch.test.js
- backend/test/business-graph-readback.test.js

## Exact verification commands

```text
node --test --test-concurrency=4 backend/test/business-request-economy.test.js backend/test/business-approval-report-evidence.test.js backend/test/business-compilation-runtime.test.js backend/test/business-graph-readback.test.js backend/test/business-period-evidence.test.js backend/test/business-period-store.test.js backend/test/business-readback.test.js backend/test/business-reference.test.js backend/test/business-report-evidence.test.js backend/test/business-report-source.test.js backend/test/business-stock-cost.test.js backend/test/business-tax-policy.test.js backend/test/business-verification-runtime.test.js backend/test/business-runtime.test.js backend/test/business-financial-movement-runtime.test.js backend/test/business-nested-report-runtime.test.js backend/test/business-dispatch.test.js backend/test/business-credit-preferences.test.js backend/test/business-receivables-route.test.js backend/test/business-step-store.test.js backend/test/qbo-request-meter.test.js backend/test/qbo-write-gate.test.js backend/test/qbo-write-period.test.js
node --test --test-concurrency=3 backend/test/business-activity-batch-order-stock.test.js backend/test/business-activity-batch-receiving.test.js backend/test/business-activity-batch-v4.test.js
node scripts/agent-harness/check-backend-syntax.mjs
git diff --check
```

The broader attempt used node --test over every backend/test/business-*.test.js file plus the same three qbo meter/gate/period suites; it was stopped as recorded above. The unchanged report-capacity suite also printed all three case passes, including its actual 31-day fixture and 500-record stress case, before a combined invocation timed out; that invocation as a whole is not counted as passed.
