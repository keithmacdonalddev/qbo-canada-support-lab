# Job Q: quote tax validation and semantic comparison

Prepared 2026-11-01T02:32:02.669Z; main, local changes only. No commits, service commands, QBO calls or MongoDB writes. Read-only MongoDB retrieval completed and disconnected.

## Direct failing evidence

- BusinessAgentTranscript attempt f5a2af2d-859e-4cf3-a248-f09b9636e1c9, call 6ae69fde167d06194e3d8a9e, result 6ae69fe0167d06194e3d8ba1 at 2026-11-01T02:11:44.135Z. Decision winter-quotes-20261031-chester-tantallon, refs chester-quote and tantallon-quote: Estimate, business date 2026-10-31, customer IDs150/151, item53, quantities2/1, unit price125, amounts250/125, tax16. Both refused before saving.
- Exact stored problem: “Line[0].SalesItemLineDetail.TaxCodeRef 16 is not a TaxCode in the synced company copy.” The original tool result contains problems but **no errorDetail**; none was invented.
- Failing check before edits: general-write-guards.js:244. Production composition general-write-service.js:352/359 reads with transactions:true; business-observation-store.js:61 treats an unknown unrelated batch as invalidating tax snapshots.
- Synced TaxCode16 and TaxRate34 were present, active, dated14% from2025-04-01. Tax snapshots completed Oct31 20:59; unrelated batch receipt 14b5eb39a75528b126efd40988d90d3db8b2874fc1533762798525468d163018 became unknown at Nov1 02:07:07.116Z. Its transaction uncertainty incorrectly hid tax definitions, which the general batch cannot edit.
- A read-only current-day sales aggregation found44 taxed lines using code16 (and44 subtotal lines without tax).

The exact private inputs, mirror rows/source status/publication and receipt snapshot are retained outside tracked files in C:/Users/NewAdmin/AppData/Local/Temp/qbo-job-q/private-replay.json. Private replay: artifacts/job-q/private-replay.test.cjs. It invokes createDefaultGeneralWrite and the real observation/context/guard implementations with database/transport adapters replaced by in-memory data. The unchanged source reproduced both exact problems; staged source prepares both quotes. This proves offline admission only, not a live save.

## Findings and corrections

| Site | Failure class and correction |
| --- | --- |
| Observation store transaction invalidation | Restrict the unrelated transaction-batch exception to TaxCode/TaxRate. Explicit tax writes, freshness, source generation, reconciliation and session-scoped reads still invalidate/guard tax observations. |
| General service sales-code selection | All sales entities, including Estimate, CreditMemo, RefundReceipt and sparse updates, collect codes from effective records; determine published NS choice and effective rates on each record date. |
| General recovery/request matching | Native Line and LinkedTxn arrays use one-to-one unordered matching; duplicate multiplicity, amounts, account/item/tax IDs and line links remain bound. Provider labels, known false defaults and validated computed subtotals are tolerated. General fractional unit prices remain exact; fixed-workflow money retains its cent contract. |
| Reference definitions | Native tax-detail/rate-history collections compare independent of ordering; validated midnight timestamps and native zero tax-order defaults normalize. Known false flags and ref display labels normalize; unknown fields and unknown nested collections remain strict. Original binding hashes/witness authentication stay exact. |
| Tax policy source recheck | Compare applicable rates and unknown selected-row settings over every boundary in the reviewed period. New rates outside the period do not refuse unchanged economics. Active status, destination/agency refs, raw retained hashes and monotonic versions remain bound. |
| Fixed readback subset | Shares the strict request comparer; retains existing independent tax, monetary, dimension, link, ledger and graph checks. Existing fixed tax-line matching was already unordered and strict. |
| Fixed master preparation readback | An omitted native false default can match requested false, while identity/version, projects, account destinations, amounts and zero opening balances remain checked. |
| General close classification/own settlements | Authenticate retained raw proof before semantic equivalence; permit provider metadata/label/order/default drift with nonregressing string versions. Economic/unknown field changes remain external changes. Own settlements retain their exact ownership/link requirements. |
| General day-close settlement trust | Uses the same authenticated semantic record comparison before trusting an owned settlement. |
| Transport, reproduction and stock-history request checks | Pass the known entity into the shared matcher so only entity-specific defaults apply; existing authority, receipt and exact replay gates stay intact. |

Raw authority/publication/compilation/request hashes, decision identities, concurrency fences and proof record hashes without authenticated raw witnesses remain exact. These authenticate retained evidence rather than compare provider representations. Compound tax remains outside the existing simple-rate contract; none was observed in current-day sales. EndDate interpretation was preserved.

## Files

- backend/src/modules/qbo-semantic-compare.js
- backend/src/modules/business-observation-store.js
- backend/src/modules/general-write-service.js
- backend/src/modules/business-reference.js
- backend/src/modules/general-write-recovery.js
- backend/src/modules/general-write-guards.js
- backend/src/modules/general-write-close.js
- backend/src/modules/business-readback.js
- backend/src/modules/business-tax-policy.js
- backend/src/modules/general-write-day-close.js
- backend/src/modules/general-write-transport.js
- backend/src/modules/business-master-preparation-plan.js
- backend/src/modules/reproduction-business.js
- backend/src/modules/business-stock-general-history.js
- backend/test/general-write-quote-tax-replay.test.js
- backend/test/qbo-semantic-compare.test.js
- backend/test/fixtures/job-q-quotes.json
- backend/test/business-tax-policy.test.js
- backend/test/fixtures/foreign-currency-native.json (adds actual zero-rate21/22 dependencies for sparse Invoice568 replay; no weakened assertions)

## Verification and limits

Independent implementation and safety reviews found no remaining findings in staged code. Source remained untouched until the final batch. Scratch Node syntax passed all14 modules. New regressions cover30 prepares across five sales entities and six native codes, stale/inactive/wrong/date cases, scoped session reads, explicit tax writes, unknown fields, duplicates, monetary precision and authenticated close evidence.

Focused dated-tax checks passed10 tests. The complete dated-tax suite exceeded the offline time limit on both unchanged and staged source; its monthly SDK simulation was not claimed passed. Initial wider run found two daily-count failures in Job W-owned business-agent-tools.js:154 (Blueprint values must be plain JSON); both reproduced against unchanged source, so those files were preserved. The main broad run was time-limited and is not counted as a completed pass. Final focused results are appended below.

No live quote save, dispatch or day-close outcome is claimed. Other jobs' edits remain untouched.

### Final saved-source results

All14 source files written in one locked batch at2026-11-01T02:32:34.451Z (33ms). Final checks use saved source with no overlay:

- From backend/: node --test --test-concurrency=4 test/business-definition-defaults.test.js test/business-observation-general-write.test.js test/business-readback.test.js test/business-reference.test.js test/business-tax-policy.test.js test/business-transaction-compiler.test.js test/general-write-admission-errors.test.js test/general-write-billable-links.test.js test/general-write-capabilities.test.js test/general-write-close-gate.test.js test/general-write-currency.test.js test/general-write-dated-sales-replay.test.js test/general-write-fixtures.test.js test/general-write-gate.test.js test/general-write-guards.test.js test/general-write-inventory-carry.test.js test/general-write-inventory.test.js test/general-write-quote-tax-replay.test.js test/general-write-recovery.test.js test/general-write-service.test.js test/general-write-settlements.test.js test/qbo-semantic-compare.test.js test/business-master-preparation-plan.test.js test/reproduction-business.test.js C:/Projects/qbo/artifacts/job-q/private-replay.test.cjs — exit0,358 passed,0 failed,0 skipped.
- From backend/: node --test --test-name-pattern=<focused date-boundary/master-default cases> test/business-dated-tax.test.js — exit0,10 passed. Exact pattern: absent option|complete fixed transition|March source converts|unscheduled conversions|wrong or inactive|Item defaults are explicit|frozen current Item tax IDs|same-day customer credit|bank-paid expenses.
- node --check on each of the14 touched source modules — all exit0.
- Implementation and safety review complete; final native zero tax-order default delta also safety-reviewed.
- Full dated-tax integration timed out in unchanged and staged runs; no pass claimed. Timed-out parent processes were terminated by the subprocess timeout; descendant cleanup inspection via Win32 process inventory was denied by this runtime, so descendant cleanup is unverified. No unrelated process was terminated.

Unrelated concurrent Job W/source/frontend and replay-harness changes are preserved. No commits or pushes.
