# Job 1B — current dated tax meaning and PO optional readback

Recorded 2026-11-01T03:03:15.124Z. Main checkout, local changes only. No commits/pushes, service control, QBO calls or MongoDB writes. MongoDB capture was read-only and disconnected. Concurrent 1A/1C changes preserved. Private records remain outside the repository in C:/Users/NewAdmin/AppData/Local/Temp/qbo-job-1b.

## Observable result and limits

Exact stored operation **01b4f4b62cae18ccc27b617a**, PO **11216**, replays offline through createGeneralWriteService.execute from needs-correction to complete. generalRecordsFor then gathers the saved PO without the unresolved-item refusal. **Zero sends**. Original requestid **c1793dea9f59daa0fdb3ed90731e564e**, receipt **14b5eb39a75528b126efd40988d90d3db8b2874fc1533762798525468d163018**, admitted batch bytes, ownership, IDs and dirty markers are unchanged. This is offline verification, not a live fix/day-close success claim.

The shared matcher permits an omitted/null PurchaseOrder DueDate only when vendor, TxnDate and nonempty lines are requested and still match. Different returned due dates remain strict; Invoice/Bill due dates, posting dates, amounts, tax, accounts and parties remain checked. Completeness uses the same bounded omission. Existing saved mismatches are reclassified only with the scoped saved receipt, original request hash/identity, exact native response hashes and matching saved item/request. Unanswered batches or unknown items cannot become complete. No receipt/barrier is cleared by this recheck.

General tax admission now derives the transaction direction and dated components from current TaxCode/TaxRate records instead of published ID allowlists. Both sales and purchase directions are supported. Taxable codes without the requested direction, inactive/incomplete rates, ambiguous/compound rules and inconsistent quantity/price/amounts still refuse. Exposure groups taxable bases by rate and uses decimal half-up rounding. Explicit native non-tax codes retain zero-tax behavior.

Historical source hashes remain unchanged and authenticate retained evidence. Current versions, provider extensions, unused opposite-direction components and copied transition contexts do not gate ordinary reference use. Tax destinations and effective rates remain meaningful checks. Fixed Nova Scotia transition intent still requires 15% before April 1, 2025 and14% afterward; a single current code with dated history can establish both. Original-tax reversals and exact retained policy integrity remain strict. Pre-send rebuild/retry and record-local continuation outside these owned entry points remain later-stage integration work.

## Files and ownership decisions

All six backend/src files were prepared/tested in scratch and written once together at **2026-11-01T03:01:18.504Z**:

- backend/src/modules/business-tax-policy.js
- backend/src/modules/business-dated-tax.js
- backend/src/modules/general-write-guards.js
- backend/src/modules/general-write-service.js
- backend/src/modules/qbo-semantic-compare.js
- backend/src/modules/general-write-recovery.js

Q's completed handoff and the owner's successor assignment were used for comparer ownership transfer. The additional shared recovery edit is the smallest selection change needed for an existing saved PO mismatch to reach the service recheck. Unknown/sending recovery retains priority; remaining slots select answered/saved PO mismatches under the same scoped active grant. Unchanged checks save the same evidence with an incremented revision, allowing normal Mongoose timestamps to rotate that bounded queue. Comparer/recovery edits used basename locks; all source/test locks were removed after the batch.

Named tests changed: business-tax-policy.test.js, business-dated-tax.test.js, general-write-guards.test.js, general-write-dated-sales-replay.test.js, general-write-service.test.js (all under backend/test). No shared fixture helper or 1A/1C-owned file was edited by this job. This handoff uses its own basename lock.

## Replay evidence

RG loader/runtime/worker adapters captured **46 selected stored operations**. Stored business-date coverage includes Oct28 (7 intents/6 compiled steps), Oct29 (16/12), Oct30 (2/2), Oct31 (163/154 and9 general runs). Code was frozen for a paired before/after replay through the same preparation, compilation, admission/readback and verification modules.

- **Zero differences** in stage status, error code or successful result hash.
- Both versions: **249 passed stages,325 failed stages,46 errored operations**. Gate remains **failed**, not accepted. Failures include missing historical sync/writer/readback/calendar/period snapshots and unsupported retained queries. The evidence cannot prove all earlier writes still admit/verify; integrated stage acceptance remains unmet.
- Exact private two-quote proposal from Q's handoff also prepares through createDefaultGeneralWrite and the real observation/context/guard modules, using private in-memory database adapters. Stored call **6ae69fde167d06194e3d8a9e**, result **6ae69fe0167d06194e3d8ba1**, code16, decision winter-quotes-20261031-chester-tantallon. No send.
- The retained three-estimate refusal shape tests code12/16 against current dated history. Published ID drift now admits; incomplete/direction/rate-history risk still refuses. March31/April1 boundaries, copied-context drift, single-code transition and original-tax reversal counterexamples are covered by focused historical tests.

## Actual checks

Commands below run from backend/ unless noted. Saved source matched the reviewed scratch source byte-for-byte.

- node --test --test-reporter=tap --test-concurrency=4 test/business-tax-policy.test.js test/general-write-guards.test.js test/general-write-dated-sales-replay.test.js test/general-write-service.test.js C:/Projects/qbo/artifacts/job-q/private-replay.test.cjs — **exit0,37 passed** (scratch and saved source).
- node --test --test-reporter=tap --test-name-pattern="absent option|complete fixed transition|March source converts|unscheduled conversions|wrong or inactive|bank-paid expenses|same-day customer credit|dated policy keeps|one current code" test/business-dated-tax.test.js — **exit0,10 passed** (scratch and saved source).
- Seven existing lost-reply tamper/partial-reply negative cases selected from general-write-lost-reply-replay.test.js — **exit0,7 passed** in scratch overlay. The old positive assertion expecting this PO to remain mismatch is superseded by the new service test; that separately owned file was preserved.
- Exact stored PO via RG runtime and service.execute, then live close-input gathering — **exit0**, both scratch and saved source.
- node --check each of six changed source files — **all exit0**.
- git diff --check on owned source/tests — **exit0**.
- Paired RG replay — staged wrapper **exit1**, gate failed from retained-evidence gaps; before/after stages unchanged. Original baseline wrapper returned0 while reporting passed:false, so its process exit is not treated as a gate pass.
- Full business-dated-tax.test.js and an additional broader master subset exceeded isolated process deadlines — **exit1, timedOut:true, SIGTERM** with the corrected timeout recorder. No full-suite pass. Earlier timeout recorder mapped a null error code to0; those labels were discarded and the full-file timeout rerun with explicit killed/signal reporting.
- Parent test processes were terminated by their timeouts. Hidden Win32 process-inventory query returned access denied (**exit1**), so descendant cleanup is unverified. No unrelated process was terminated.

Distinct read-only implementation and safety reviews completed on scratch source; their concrete findings (decimal rounding, tax-order validation, queue priority, all-batch completion and routing comparison) were resolved before the source batch. No remaining source findings were reported. Both reviewers explicitly marked the multi-day replay acceptance unproved.

## Work-value decision

Essential outcome: verify the already saved PO safely and remove reference-shape tax refusals. Direct proof is its original stored receipt plus zero-send service replay. Scratch first focused run exposed obsolete exact-ID assertions; they now test current tax meaning and real-risk counterexamples. The monthly SDK simulation and unavailable historical replay bodies were bounded and disclosed rather than expanded into an unrelated framework. Continue/defer decision: deliver reviewed local source and targeted evidence; defer full replay acceptance until RG has the missing historical source evidence. No owner action or live permission was requested.
