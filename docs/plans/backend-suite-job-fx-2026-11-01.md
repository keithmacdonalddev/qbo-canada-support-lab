# JOB FX: backend suite green (2026-11-01)

Final command: **npm run test --workspace=backend**, exit **0**.

**2,715 tests: 2,708 passed, 0 failed, 0 cancelled, 7 skipped, 0 todo.** Runtime 778,992.5419 ms (about 13 minutes); started04:15:41.342Z, ended04:28:42.843Z. All FX test hashes and production module hashes stayed unchanged throughout this final run. Module hash:61e802899a7c41a04c635811adcb4db3df37c8117086a51aaed6577bc8f355cd.

FX changed tests and this note only. No backend/src save, service control, QBO API call, MongoDB write, Git commit or push was performed by FX. All 21 tracked test edits below remain local on main. The minimal shared AU fallback was included by the concurrent integration commit c7e86a8; FX did not make that commit. Other concurrent V2 tests/docs and tmp artifacts remain untouched.

## What caused the failures

The initial focused reproduction of the four reported files returned40 tests:33 pass/7 fail. The full baseline exposed a wider stale-test inventory:2674 tests,2629 pass/40 fail/1 cancelled/4 skip,exit1. That run overlapped test-only edits; the focused pre-edit run is the immutable proof of the original seven failures. A second in-progress-tree run had2633pass/37 fail/0 cancelled/4 skip,exit1. No production fix was needed.

Git log -L and blame established the causes:

- **2b00a89 (W):** writes retain durable decision events keyed by the server-issued pass. Older mocks lacked passId/store.event; repair the mocks and retain budget/authorization assertions.
- **71b72f4 (Stage1A):** complete current company references replace historical definition witnesses for ordinary reuse. Preserve old hashes for audit; enforce current identity/provenance/active status and the compiler's accounting purpose. Original affected tests came from473f55e,81af99a,900a5a79,ac17891d,6d594553,c9b0942f and2f48c45.
- **cdb7317 (Stage1B, building on0777850 Q):** tax validation uses current dated components. Complete TaxCode/TaxRate fixtures are required; taxDefinition itself originated in81af99a. Metadata drift is allowed; real tax economics/destinations still refuse. Native PO11216 no longer mismatches solely because QBO omits DueDate.
- **8e57821 (Stage1C):** master readback checks current accounting purpose. Service name/price can change; inventory economics/dates remain exact. Tax-default/version assertions must exercise an Item ordinal rather than Account ordinal0.
- **473f55e cancellation-test deadline:** the existing5s test deadline exceeded5.324s under broad parallel load but passed isolated. Only this test deadline became30s; abort, connection cleanup and zero-dispatch assertions remain.
- **Concurrent AU fallback:** the sanitized foreign-currency fixture predates card85. Adding it only to the test-local fallback repairs three assertions without changing private replay data or weakening any assertion.

No generic hash/canonical behavior, admitted bytes, receipts, duplicate safeguards, postings, allocation rules, stock-cost evidence or company scope was changed by FX.

## Files

Tracked test files changed by FX:

- backend/test/business-activity-choice-economy.test.js
- backend/test/general-write-daily-count.test.js
- backend/test/business-error-detail.test.js
- backend/test/qbo-semantic-compare.test.js
- backend/test/general-write-quote-tax-replay.test.js
- backend/test/business-compilation-runtime.test.js
- backend/test/business-activity-batch-lists.test.js
- backend/test/general-write-capabilities.test.js
- backend/test/general-write-billable-links.test.js
- backend/test/general-write-inventory.test.js
- backend/test/reproduction-business.test.js
- backend/test/business-definition-defaults.test.js
- backend/test/business-reference-runtime-r3.test.js
- backend/test/business-request-economy.test.js
- backend/test/business-dispatch.test.js
- backend/test/business-transaction-compiler.test.js
- backend/test/business-master-preparation-recovery.test.js
- backend/test/business-master-preparation-transport.test.js
- backend/test/business-preparation-references.test.js
- backend/test/business-dated-tax.test.js
- backend/test/general-write-lost-reply-replay.test.js

Shared hunk: backend/test/account-utilization-au.test.js adds only the missing synthetic CAD Credit Card Account85 when !stored and absent. Surrounding AU work is not FX-owned. Private QBO_AU_REPLAY inputs remain unchanged.

## Focused verification

All commands below ran from backend/ as node --test followed by the listed files. Their final focused results are shown; earlier diagnostic failures are retained in private Temp logs.

| Files (under test/) | Result |
|---|---|
| business-activity-choice-economy, business-error-detail, general-write-daily-count, qbo-semantic-compare, general-write-quote-tax-replay, general-write-dated-sales-replay, business-reference, business-master-preparation-plan, business-tax-policy (all .test.js) |115 pass/0 fail,exit0|
| business-compilation-runtime.test.js |27 pass/0 fail,exit0|
| business-activity-batch-lists.test.js |9 pass/0 fail,exit0|
| business-definition-defaults.test.js, business-reference-runtime-r3.test.js |19 pass/0 fail,exit0|
| business-reference-runtime-r3.test.js after review correction |9 pass/0 fail,exit0|
| business-request-economy.test.js, business-dispatch.test.js, business-transaction-compiler.test.js |69 pass/0 fail/2 existing skips,exit0|
| general-write-capabilities.test.js, general-write-billable-links.test.js, general-write-inventory.test.js, reproduction-business.test.js |67 pass/0 fail,exit0|
| business-master-preparation-recovery.test.js, business-master-preparation-transport.test.js, business-preparation-references.test.js, business-dated-tax.test.js, general-write-lost-reply-replay.test.js |84 pass/0 fail,exit0|
| account-utilization-au.test.js |11 pass/0 fail/2 private-input skips,exit0|
| business-situation-coverage.test.js (current integration cross-check; no FX edit) |24 pass/0 fail/1 private-input skip,exit0|

The paired AU/RG2 diagnostic initially reported21pass/3 AU failures/2 skips,exit1; all13 RG2 subtests passed. The AU fallback fixed those3failures. The final full suite includes both files and all parallel BK1 changes.

The7 full-suite skips are5 opt-in private-data replays and2 existing request-economy tests superseded by the fresh-read design. FX introduced no skips.

Distinct read-only implementation and safety reviews found one diagnostic test that accidentally passed on the historical resolver error. It was corrected to use foreign current provenance, require BUSINESS_REFERENCE_UNVERIFIED, and prove zero historical resolver calls. No review findings remain in FX changes. The AU shared fallback also received distinct safety review.

## Real stored-data evidence and limits

Stored PO **11216** now passes the production wake/recovery path with **zero resends**: original requestid, sends=1, dispatch key, saved receipt, QBO ID, owned identity and answered batch are preserved; writer barriers clear. Tampered body/request/receipt identity/duplicate-item and unknown-outcome tests continue to refuse. Native stored Invoice401/405 and Bill350/351/382 fixtures also replay through real response/recovery paths with their scope, amount and duplicate-billing assertions intact.

Initial read-only command: node scripts/agent-harness/replay-gate.mjs --since 2026-10-28 --json. It returned exit1:48 errored operations,253 passing individual stages and331failed stages; captured module source stayed unchanged. Missing historical sync/writer/calendar/readback bodies prevented complete replay. Two accepted-baseline admission stages also refused: d398c91da69a5274a51bd011 and14bc98000f3c4b0a48a9d3b3, message hash9f4bad446b7087d49b77ec68f8d12345e0aeb163e05fe745f2c632c0b6862d0d. Their after-save readback/ledger stages passed. Initial capture hash002acb11128713a6e5a038eedb8c015162b54daaecdba0b6169f41010e50027d; code hash638c7ec85d339c8566bb9403ed1182604470fa196077a06146ae7f69c6064bba.

After concurrent RG2 integration, the default command node scripts/agent-harness/replay-gate.mjs --json returned **exit0** in84,086 ms under the new classification: **47 operations missing evidence; 0 complete captured operations**. It passed222individual stages and the activity-choice preflight;299 stages still lack complete proof. This is **not complete historical replay acceptance**. Unknown run01b4f4b62cae18ccc27b617a remains missing historical evidence; nothing was sent to QBO. Current capture hashdf16d2c232a28b91f131a6afd9f7a0b9370e3bd2d642178d1098a69304074885; replay code hash8be2cca66593d54a6f27b3bc4f7b99c431fb905377b9783bdf1cd2630ea4ddef; sourceChanged=false.

Private logs/JSON stay in C:/Users/NewAdmin/AppData/Local/Temp/qbo-fx-20261101. Final complete suite log:final-integrated-suite.log. No raw company records or secrets are in this note. Live accountant/company behavior was not verified.

## Per-failure cause and decision

| Original failing location/test | Cause commit | Correction |
|---|---|---|
| business-activity-batch-lists.test.js:86:1 — a role created in this batch, or changed in QuickBooks after creation, cannot be used | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-activity-choice-economy.test.js:74:1 — the general tool admits exact obligations at the cap and holds new sales and overpayments | 2b00a89 | Provide server pass and durable decision-event fixture; preserve budget/authorization checks. |
| business-compilation-runtime.test.js:61:1 — changed approved master definitions and absent tax expectations prevent compilation | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-compilation-runtime.test.js:99:1 — stock compilation reads Item quantity after a prior receipt instead of its definition mirror | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-compilation-runtime.test.js:113:1 — execution compilation carries historical Item and TaxCode witnesses when current mirror is unavailable | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-compilation-runtime.test.js:164:43 — compilation recovers exact legacy Item evidence after a cached shape mismatch | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-compilation-runtime.test.js:164:43 — compilation recovers exact legacy TaxCode evidence after a cached shape mismatch | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-compilation-runtime.test.js:173:1 — legacy witness recovery still rejects missing, tampered, foreign and changed definitions | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-compilation-runtime.test.js:196:1 — shared physical references recover a legacy witness even when the last binding uses v2 | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-dated-tax.test.js:72:1 — actual frozen current Item tax IDs need current direction, active status and versions before any dispatch | 8e57821 | Check current master purpose; Item-only dated defaults; preserve inventory dates and exact IDs. |
| business-dated-tax.test.js:82:1 — original SDK creates, verifies and applies dated Item defaults while changed tax contexts refuse the prepared IDs | 8e57821 | Check current master purpose; Item-only dated defaults; preserve inventory dates and exact IDs. |
| business-definition-defaults.test.js:27:1 — v2 default drift refuses missing, altered, foreign, future or regressed evidence | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-definition-defaults.test.js:33:1 — runtime compiler resolves v2 Item and v1 Customer default drift without rewriting approved hashes | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-definition-defaults.test.js:50:1 — added-role witness comparisons accept default-only changes under either retained hash version | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-definition-defaults.test.js:60:1 — tax source verifier accepts known default-only flags and rejects real tax differences | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-dispatch.test.js:165:1 — dispatch recompile resolves a missing legacy Item witness instead of refusing the live-shaped record | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-error-detail.test.js:70:1 — definition mismatch identifies differing approved/current fields without changing approval | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-error-detail.test.js:102:1 — mismatch detail never labels an unrelated supplied witness as the approved baseline | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-master-preparation-recovery.test.js:103:1 — confirmation rereads the real accepted ID and refuses remote changes after preview | 8e57821 | Check current master purpose; Item-only dated defaults; preserve inventory dates and exact IDs. |
| business-master-preparation-transport.test.js:65:1 — fresh preflight refuses drift in inventory, protection, taxability and Canadian prerequisites | 8e57821 | Check current master purpose; Item-only dated defaults; preserve inventory dates and exact IDs. |
| business-preparation-references.test.js:126:1 — disconnect during initial master reads prevents the later full-definition reads | 473f55e | Existing5s test deadline is load-sensitive; isolated disconnect passes; extend test deadline only. |
| business-reference-runtime-r3.test.js:19:1 — every runtime compile resolves missing retained evidence centrally without changing its inputs or hashes | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-reference-runtime-r3.test.js:28:1 — missing, tampered, foreign, wrong-ID or genuinely changed definitions still refuse centrally | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-reference-runtime-r3.test.js:39:1 — central resolver observes cancellation and rechecks freshness after lookup | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-reference-runtime-r3.test.js:59:1 — resolver rejection preserves reference diagnostic context | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-reference-runtime-r3.test.js:69:1 — cached reference reauthorizes after its retained-definition lookup | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-request-economy.test.js:43:1 — current complete mirror supplies references and still enforces every approved definition field | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-request-economy.test.js:150:1 — legacy Item 44 approval uses an old exact-hash mirror witness with a fresh live GET when sync is stale | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| business-transaction-compiler.test.js:112:1 — same or newer version cannot conceal changed master definitions or a removed approval binding | 71b72f4 (tax semantics cdb7317) | Current full scoped references replace old definition witnesses; retain typed purpose, provenance, identity, active status and stock checks. |
| general-write-billable-links.test.js:103:1 — supported billable expense creation still prepares; customer scope and completed billing cannot be fabricated | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-billable-links.test.js:117:1 — billable source supports an earlier customer create and keeps currency/tax restrictions | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-capabilities.test.js:53:1 — mixed Canadian sales codes stay on their own invoice and receipt lines; posting keeps tax agency accounts distinct | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-capabilities.test.js:160:1 — live context admits explicitly referenced mixed sales codes with complete dated rates, including non-taxable codes | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-capabilities.test.js:179:1 — service passes proposed invoice line codes into the guarded tax context | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-inventory.test.js:49:1 — master default off, per-entity flags, missing FIFO basis and negative-stock plan prefixes refuse | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-inventory.test.js:61:1 — partial PO receipts retain received quantity only, validate supplier/item/line and reserve siblings | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-lost-reply-replay.test.js:65:1 — stored PO11216 reply is automatically attributed on the existing wake with zero resends | cdb7317 | Omitted native PO DueDate now matches; bounded recovery also rechecks saved PO-only rows. Preserve zero resends/receipts/request identity. |
| general-write-lost-reply-replay.test.js:104:1 — wake filters answered, owner and revoked-grant rows before applying its bounded limit | cdb7317 | Omitted native PO DueDate now matches; bounded recovery also rechecks saved PO-only rows. Preserve zero resends/receipts/request identity. |
| reproduction-business.test.js:152:78 — case create -> updateRecord leaves the latest governed close version | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| reproduction-business.test.js:152:78 — case create -> voidTransaction leaves the latest governed close version | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| reproduction-business.test.js:152:78 — case create -> deleteRecord leaves the latest governed close version | cdb7317 (taxDefinition originated81af99a) | Supply complete current TaxCode/TaxRate/version/direction/history fixtures; keep original economics and all accounting assertions. |
| general-write-daily-count.test.js:29 — new general plans and saved same-key retries cannot bypass the request budget or execute permission | 2b00a89 | Add server pass/event fixture; retain every budget, revoked-permission and zero-send assertion. |
| general-write-daily-count.test.js:48 — general tool checks the full proposed record count against remaining daily capacity | 2b00a89 | Add pass/event fixture; retain full proposed count and own-reservation exclusion. |
| qbo-semantic-compare.test.js:34 — dated source verification rejects an unknown provider setting | cdb7317 | Accept irrelevant provider metadata; retain effective-rate, agency, expiry, active/version and tampered-evidence refusals. |
| qbo-semantic-compare.test.js:47 — fixed master readback rejects changed service price | 8e57821 | Allow current service name/price; add explicit inventory price/cost/quantity/routing refusals. |
| general-write-quote-tax-replay.test.js:48 — quote tax preparation expects throws and frozen published code/rate | cdb7317 (fixture0777850) | Assert refused status and zero saved plans; validate current dated rates and line arithmetic. |
| account-utilization-au.test.js:47 — real account IDs prepare Cash/Check/card/refund and foreign transfers/deposits | concurrent AU integrationc7e86a8 | Supply missing card85 only in local fallback fixture; keep private stored replay exact. |
| account-utilization-au.test.js:87 — foreign Purchase cannot bypass AR/AP settlement or bank/card transfer protections | concurrent AU integrationc7e86a8 | Same missing-card fixture; all account-type bypass refusals remain unchanged. |
| account-utilization-au.test.js:93 — native card payment prepares, classifies and recovers with no send | concurrent AU integrationc7e86a8 | Same fixture; retain native wrapper, exact amounts/postings, ownership and zero-send checks. |

## Work-value ledger

- 03:41Z: essential task start; proof target = full green backend suite with unchanged book safeguards. No live company delivery claimed.
- 03:45Z: original7failures repaired;115 focused checks pass. Full runs continue to reveal the complete baseline inventory.
- 03:57Z: first broad run finishes;40 failures/1load-sensitive cancellation. Continue with scoped test-only corrections, preserving source ownership.
- 04:03Z: all 21 owned affected testfiles pass; remaining full verification depends on parallel RG2/AU saves.
- 04:08Z: use the readiness wait to run the broad suite. It records AU's missing-module failure and a transient mixed-state reachability mismatch. Current focused checks prove both resolved.
- 04:15Z: both modules present; AU fallback corrected under lock; final integrated full run starts with frozen FX test and module hashes.
- 04:28Z: final goal achieved at the test layer:2715 tests,2708 pass,0 fail,0 cancelled,7 skip. No further source or live investigation is needed for FX.

The first two full runs overlapped and added load. Windows denied attempted cleanup of only the superseded owned test tree; no permissions were changed or cleanup retry made. All test processes subsequently exited normally. No persistent service was controlled.
