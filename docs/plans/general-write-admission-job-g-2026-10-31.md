# Job G: general-write admission restored

Scope: local changes only; no commits, manual service controls, QBO calls or MongoDB writes. Database observations were read-only. The running accountant performed its own natural retries.

## Root cause and introducing commits

The actual stored Vendor batch for general run `14bc98000f3c4b0a48a9d3b3` fails through `admit -> guardBatch -> createGeneralWriteContext -> readCurrencyPolicy` with:

`MongoServerError`, code **2**: `cannot set maxTimeMS on getMore command for a non-awaitData cursor`.

The currency policy query reads **131 Account/Preferences records**. MongoDB's default first batch is 101; continuation uses getMore. The live admission transaction uses `withTransaction({ timeoutMS: 15000, ... })`, and the installed driver's transaction timeout handling adds an invalid maxTimeMS to that non-awaitData getMore. A plain startTransaction or an offline model returning all rows at once does not reproduce this behavior. Matching the live transaction timeout was essential.

`git blame` attributes the currency query at general-write-currency.js:91–93 to **24ab2945** (October 31, 20:31:37 -03:00). The same risk exists later in transactional daily counts (143 saved receipts observed): those session-bound reads were introduced in **22912ec6**. That commit also introduced the transport catch that discarded the underlying exception and replaced it with a generic denial.

Captured source stack: `readCurrencyPolicy` at general-write-currency.js:93, general-write-service.js:342, `guard` at :82, `guardBatch` at :242, then transport `admit`. The driver throws from mongodb/lib/cmap/connection.js:306 through FindCursor.getMore/toArray. Original full stack and query snapshots remain private.

## Stored-data replay and direct outcome

- Vendor run `14bc98000f3c4b0a48a9d3b3`: original generic group began `2026-11-01T00:47:54.476Z`.
- Quote run `90f1e797dc0c6890ce978ae6`: same group began `2026-11-01T00:47:55.543Z`.
- With the original transport loaded from scratch, the stored Vendor replay produces the original generic denial while an instrumentation wrapper captures code2 and its full stack. Recorded read results/errors then reproduce the exact exception with Mongo disconnected (14/14 calls consumed).
- After the cursor fix, the same real guard/admit path succeeds under the live timeout policy, and its disconnected replay succeeds (18/18 calls consumed). All database updates in the replay are simulated locally as reads; no QBO method is allowed.
- Natural retries after the root batch completed Vendor run at **2026-11-01T02:04:49.440Z**, saved **Vendor149**, and quote run at **02:04:51.758Z**, saved **Estimate11209**. Read-only Mongo inspection shows status complete, saved item outcomes, and errorDetail null for both. These are stored runtime/receipt observations, not an additional independent QBO API read.

## Changes

- `general-write-currency.js`: request batchSize501, matching its existing501-row enumeration limit.
- `business-agent-store.js`: only four todayActivity queries changed, with batch sizes matching existing limits200/200/5000/5001. This shared Job X file was locked and re-read; no unrelated lines were changed.
- `general-write-transport.js`: retain scrubbed, bounded cause code/message/source location/stackTrace through failureFields and JSON. Existing admission code/check/details remain intact; oversized original detail is explicitly marked truncated. Original MongoError identity/labels survive so the driver can retry transient transaction conflicts. Failures escaping admission stay definitely unsent.
- `general-write-admission-errors.test.js`: nine regressions, including exact131-record failure, >101 rows in all four daily-count reads, persistence/redaction/byte bounds, driver-only file/line, and actual driver transaction retries.

Existing filters, scopes, projections, enumeration limits, timeouts, authority, period protections, exact identities and dispatch gates remain unchanged. Oversized BSON batches can still require continuation and fail closed; this change does not claim to eliminate every possible pagination case.

## Verification and review

From backend/, node --test with every general-write*.test.js match passed explicitly, plus business-error-detail.test.js, business-observation-general-write.test.js, business-agent-store.test.js and business-agent-cadence.test.js: **270 passed, 0 failed, 0 skipped**. Exact currency/count regressions fail before the cursor patch and pass afterward. Node syntax checks passed for all three source files; git diff --check passed.

Distinct read-only implementation and safety reviews found no remaining findings after reviewing the root fix, original stored replay, exact regressions and cause-location fallback.

## Execution note

Diagnostics were saved prematurely before matching the live transaction timeout. The root discovery required one additional minimal source batch at **2026-11-01T02:04:37.335Z**. This deviated from the requested one-batch rule; each root source file was prepared/tested first, locked, re-read and saved together. No service was manually started, stopped or restarted.

Private scripts, stored snapshots, original/fixed replay output, work-value ledger and test logs: `%TEMP%/qbo-job-g`. No raw company records or secrets were added to the repo. All five owned files remain local and uncommitted as requested.
