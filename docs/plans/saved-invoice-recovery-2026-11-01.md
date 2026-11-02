# Saved invoice and obsolete blocker recovery

Started 2026-11-01T20:16:33Z. Essential A01/A02 work: preserve accepted QuickBooks records, explain the live blockers, and prevent repeating a request that cannot retain its intended relationships. Smallest proof: original immutable request/receipt, current invoice and estimate links, and the actual obligation before any recovery. Next milestone: identify the missing relationship and choose a supported path without replacement creates.

## Direct observations

At 20:16 UTC the app still returned three blockers. Run 816e70a3fbcaf9a91974610d has Invoice 11331 and11332 classified mismatch. Runs c3060fe19c566ba8eb0f49a5 and 62aad9b69fe7db9612d3fea7 contain saved Payments 11330 and 11255/11256 despite a later linked-invoice drift refusal. These are mixed saved/remaining states; an older admission message saying nothing was sent does not describe the entire run.

The original invoice requests name Estimate 11217 and11218 in header LinkedTxn. The retained native responses have no such links. The current request matcher fails specifically on LinkedTxn; it is not merely object defaults or an added computed subtotal.

Four fresh scoped production GETs through the running app at 2026-11-01T20:18:07Z confirm:

| Record | Amount / state | Native links |
|---|---|---|
| Invoice 11331 | CAD285 total and balance | None |
| Invoice 11332 | CAD285 total and balance | None |
| Estimate 11217 | CAD285, Pending | None |
| Estimate 11218 | CAD285, Pending | None |

The synced Preferences observation dated 14:59:59 UTC has SalesFormsPrefs.UsingProgressInvoicing=true and AllowEstimates=true. This is retained settings evidence, not a fresh preference read. Intuit's [Invoice API reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice) documents ordinary estimate links but says progress invoicing is unsupported via the API. Combined with source's existing warning that QuickBooks may drop the estimate link, progress invoicing is a plausible explanation; do not report that inference as an independently reproduced provider cause.

## Required repair scope

1. Preserve both saved invoice IDs, amounts, tax, ownership and original receipts. Never create replacement invoices or label the links verified while they remain absent.
2. Prevent another API-only estimate conversion when the observed company configuration cannot retain the required link. Carry that restriction into executable guards and accountant/owner capability descriptions; route to a supported native procedure with exact evidence. Do not disable progress invoicing merely to make the API work.
3. Establish whether native QuickBooks can attach each existing invoice to its estimate without duplicating lines, amounts, tax or postings. Prepare that supported action and validate against unchanged native records before any authorized edit. No such native edit was performed in this investigation.
4. For A02, inspect all saved and remaining operations and original before-images. Payment 11330 already settled Invoice 11020; further payment is inappropriate. Replanning must represent only genuinely unsent work and retain earlier accepted effects.
5. Add focused actual-shape recovery regression evidence and distinct implementation/safety reviews before installing mutation/recovery changes. Keep UI/native proof separate from mocked checks.

## Work-value ledger

- 20:16–20:20 UTC: one approach; read-only source, database and four native records. Delivered exact missing-link diagnosis; no company writes, service changes or new infrastructure. Continue to supported pre-admission prevention and recovery design after the shared sign-in unit is closed.

At 20:21 UTC, original run/batch evidence showed the genuinely unsent work is Deposit grouped-deposit (linking saved Payments11255/11256) and Deposit bank-remittance (linking saved Payment11330). Both deposit batches have sends:0 and no receipt, while the earlier payment batches are answered with saved receipts. Admission diagnostics report mirrorHash:null for the invoice dependency; source guardBatch reloads the copy without the saved extras used during preparation. This narrows the next investigation to fresh dependency availability at deposit admission; it is not evidence that the payments failed or should be repeated.

## A02 implementation boundary — 20:35 UTC

The shared sign-in unit was committed and pushed to main/origin/main as6117cbc. Essential A02 milestone: offline replay of a Deposit after its already-saved Payment must pass the actual admission guard using the same fresh graph read by protected-period preflight, while stale/conflicting/unknown evidence still refuses. No live writes or service commands.

Modify only general-write-service/transport and focused tests. Keep all native preflight records private, cloned and bound to scope (including connection), run, batch, request and exact asserted graph hashes. Fill hardened-copy misses only; an available materially conflicting mirror must still refuse. Fresh records use a separate read-only channel, never extras (extras currently grants ownership). Leave observation-store invalidation, target SyncToken, history/currency/period/agent/count/writer checks unchanged. Capture new closure state for replay, reset it on every preflight and do not use it for admitted-request replay. Distinct implementation and safety plan reviews support this scope with these constraints.

Work-value checkpoint20:35UTC: the initial diagnosis took about6 active minutes, with interruption while finalizing sign-in. Native four-record proof and exact saved/unsent identities are complete; actual posting repair remains unmet. Next checkpoint by20:50UTC is focused actual-shape admission proof or a documented smallest-safe alternative; no new framework or widened native execution.

## A02 installed proof — 20:46 UTC

The scoped admission repair is installed after337 affected tests passed (22 files) and distinct implementation/safety reviews found no remaining findings. Both changed modules and the focused gate file passed syntax checks;80 saved-source gate/service tests passed. The safety reviewer independently ran62 gate tests. Complete raw graph bodies can enter existing scoped compressed TTL replay evidence under its current redaction/size policy; they are not exposed in public status, receipts or audit bodies. No new retention collection or policy was added.

Tests use the real coordinated gate and cover preserved Payment IDs, no native reads inside admission, missing-copy fallback, unchanged ownership, available mirror drift, exact proof/scope/run/batch/request binding, sparse/missing/duplicate/changed evidence, and a second Payment run whose disjoint direct claim shares the Deposit graph Invoice. Earlier saved receipts and unrelated receipts remain allowed. A new or unresolved graph write refuses. Live posting of the two original deposits remains unverified; no new QBO/database action was launched for this check.

20:43–20:46 UTC live status still showed125 saved records and16 no-progress reviews. Direct GET /api/company/business-governance/activity/options reproduced HTTP400 BUSINESS_PLAN_UNVERIFIED: Exact connected company scope is required. The latest two accountant tool results report the same exact failure. This is a separate P0 discovery failure stopping ordinary business activity. Finish A02 Git closeout, then repair that read-only path first (A08); do not spend another cycle treating inactivity as healthy waiting.

## A08 discovery restored — 2026-11-01T20:49:46Z

Direct read-only service tracing found history -> assertRunApproval -> scopeFilter(run). MongoDB returns the stored run.connectionId as ObjectId, while scopeFilter intentionally requires external scope IDs as strings. The one-line fix normalizes the persisted run ID at that internal boundary, as other retained-run validation already does; it does not relax scopeFilter or owner/standing-authority checks. A regression uses a real mongoose ObjectId and rejects invalid caller scope, malformed stored scope and wrong owner.

Both independent reviews found no issues.69 period/history-store tests passed against the candidate and installed source; the safety reviewer independently ran27 period-store tests. Syntax passed. The same running-app GET that returned400 now returned200 with choicesAvailable:true,40 customer choices and4 service choices at20:49:46UTC. This directly verifies discovery recovery. Further saved transactions and sustained target volume remain to be observed; no new accounting action or service-control command was launched.

A02 admission repair is committed and pushed as10ceec4 on main/origin/main. A08 completed its direct read-only milestone within the20:46–21:01 checkpoint. Next measure the accountant's scheduled pass and continue truthful visibility/capability corrections; do not equate restored choices with completed daily output.

## Observed resumed company activity — 20:54 UTC

A08 is pushed asfa703fc. The live app rose from125 saved to132/220 by20:54:16UTC;10 reserved records remain unfinished and are not added to saved. Original create receipts since20:49:46 identify three TimeActivities1073742987–1073742989 and Invoices11341,11342,11344. Three fresh scoped native GETs at20:52:40 confirm Invoice11341 and11342 eachCAD427.50, due2026-12-01, linked respectively to1073742988 and1073742987. The latter TimeActivity has3 hours and BillableStatus HasBeenBilled. These are direct native outcomes after discovery recovery, not just test/commit evidence. The old two deposit runs and missing estimate links remain separate unresolved outcomes; full daily volume and endurance remain open.

## Recurrence fix — 2026-11-02T05:04:57Z

Owner requested implementation of the recurring-failure fix. Essential A01 outcome: reject known unsupported new API conversions across both write paths, preserve original saves, and make recovery progress from authenticated saved state. Smallest offline proof: exact dropped-link shape -> no duplicate create -> restart -> actual reciprocal repair/readback -> original request and day-close remain valid. No QBO/database writes, provider runs or service control are authorized by this coding request. Canonical main/origin/main was clean at start.

Independent implementation and safety plan challenges confirm the historical native operator cannot safely accept GeneralWriteRun items: its original managed Step/time/consumed-repair authorities are absent. Keep that contract intact. First coherent unit: shared API admission policy (reuse fresh Preferences period evidence; preserve authenticated lost-reply replay and native period checks), preparation/tool guidance, and scoped saved-Invoice recovery assessment/reconciliation. A genuinely automatic general-native operator remains a distinct required outcome; do not describe the handoff or offline proof as native execution.

Work-value ledger: 05:04–05:11 UTC, source tracing plus two independent plan challenges, zero failed implementation approaches and zero company writes. The exact missing integration and reusable shared period evidence are identified. Continue to the bounded prevention/recovery milestone; no new generic mutation framework.

## Verified prevention and read-only recovery unit — 2026-11-02T05:42UTC

The shared SDK admission gate now requires observed Progress Invoicing Off for a new Invoice→Estimate conversion. It uses the existing fresh Preferences read, applies to direct and batch writes, and refuses missing/unknown capability evidence. General preparation, managed preparation/approval and the first source dispatch of an unstarted managed plan share that restriction. Native protected-period checking and exact already-admitted lost-response replay retain their separate contracts. Saved plans/receipts are not rewritten; no preference toggle is introduced. Accountant schemas, choices and capability descriptions expose the actual native requirement.

Known saved general Invoice mismatches now retain an authenticated native recovery packet. Repeated unresolved reviews use the scoped mirror only and make zero QBO requests. Reconciliation requires both original Invoice and original general-Estimate creation receipts, actual reciprocal links/Closed state, stable fresh reads, unchanged accounting/tax/customer/currency/document number, valid timestamps, and the narrowly evidenced full single-line native identity/link replacement. Original response bodies/receipts remain. The original Estimate's derived closure is independently reconstructed for day close; original quote request/status remains immutable. Completion commits under current operations.verify permission, selected-workspace/membership/agent fences, unchanged company writer, relevant uncertain-receipt checks and original-run revision. Missing proof/adapters retain the mismatch. An unsent sibling remains unsent during reconciliation and returns prepared for a separate guarded continuation.

Bounded read-only production database inspection directly authenticated both original Invoice receipts and both original Estimate general-create receipts:11331→11217 and11332→11218, company ending2856. Both Invoice outcomes remain mismatch. Zero QBO calls, zero DB writes, database closed. Raw records/secrets were not printed or committed.

Verification:333 focused backend tests across API admission, recovery, ledger/day-close, authority, original native correction and replay pass; four representative managed service tests pass, including refusal before source writes and a pre-guard-approved plan. All343 backend JavaScript files pass syntax. Distinct implementation and safety reviews have no remaining findings. Native fixtures explicitly establish API-compatible settings for historical SDK setup and Progress Invoicing On for the native workflow. A full managed-service run exceeded the check budget and was stopped; it is not a passed check. Its owned process tree was terminated; focused checks replaced that broad run. No app service was started/restarted and no live accounting action ran.

Work-value ledger:05:11–05:22 UTC implemented shared gate and retained recovery, then changed approach to address independent-review source-close and writer/permission races.05:22–05:42 UTC delivered authentic exact-pair provenance, native-shape recovery→source-close proof and focused regressions. Whole managed-suite attempts were deferred after timeouts; no optional test-run expansion remains. Code is an offline prevention/reconciliation unit, not company record delivery.

### Remaining native action and acceptance

A01 remains IN PROGRESS. Automatic general-native creation/repair execution is not installed; it is explicitly false in capability/recovery output. The historical managed native operator remains unchanged and cannot accept fabricated GeneralWriteRun-to-Step lineage. Do not describe a guard, recovery packet, passing fixture or code commit as a working unattended native conversion or as repair of the actual invoices.

Concrete live target, requiring target-specific authority under AGENTS.md: Production company ending2856; attach Estimate11217 to existing Invoice11331 and Estimate11218 to existing Invoice11332. Preserve the original two Invoice IDs and all accounting/customer/currency/tax/payment content and document numbers (retained originals are CAD285 each). Fresh preflight must authenticate current selected company, original receipts, unchanged records, current protected dates and exact company writer/browser lease before action. Allow only the native whole-estimate attachment/replacement with no duplicate financial line. At most one Save attempt per existing invoice; uncertain Save stays held, with no automatic second Save or replacement create. No new invoices, payments, credits, deletions, preference changes or service control. Verify reciprocal links, actual estimate closure, unchanged accounting/report evidence and retained provenance before reconciliation. No such live authority or execution is claimed in this coding unit.
