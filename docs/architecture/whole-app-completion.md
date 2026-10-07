# Whole-app completion worklist

Opened 2026-10-06. Status: active, not complete.

The owner requests the whole product outcome, not only a Records screen or reproduction tool: a believable Canadian business maintained through the current business date with coherent records and direct report evidence. Current chat instructions extend the older product contract to include autonomous supported assistant workflows.

## Acceptance ledger

| Outcome | Required proof | Current state |
| --- | --- | --- |
| Published company business blueprint | Versioned scope, calendar, cadence, accounts, tax mappings and divisions tied to actual company | Partial: app now supports scoped immutable drafts and observed mapping choices; owner access/storage setup and activation remain unmet |
| Coherent historical records | Approved horizon and linked lifecycles, no unexplained gaps or duplicate managed records | Unverified: existing generation uses random rolling 30-day windows |
| Current business activity | Durable calendar cursor advanced only after saved records and checks; existing activity inspected before catch-up | Unmet: no durable business cursor yet. Timestamp-based currency claim removed; actual gaps and missing verification now shown |
| Reliable controlled operations | Immutable bounded preview, company/actor scope, durable step receipts, stop/resume, ambiguous-write recovery | Partial: generation and reproduction have reusable safeguards, not a complete business operation system |
| Honest coverage | Complete or explicitly bounded reads, date-correct scoring, manual and unavailable evidence kept distinct | Partial: paginated bounded reads, future-date exclusion and prerequisite uncertainty implemented; full business-period/report evidence still absent |
| Reports and reconciliation | Company-specific populated/plausible/reconciled assertions, evidence for manual-only checks | Partial: direct Company book checks now compare four accounting relationships; recurring close evidence and the full report catalog workflow remain absent |
| Full record inspection and administration | Pagination/filtering, field and relationship evidence, entity-specific controls | Partial: live inspection exists, known navigation/relationship gaps |
| Assistant completes supported goals | Representative full-goal tests, timing from submission to verified result, interruption recovery | Partial: PO case tests and screen reader verified; broad timing/goal suite absent |
| Desktop usability and administration | Real rendered flows, errors/recovery, permissions and audit, accurate status | Partial: current shell usable; major business operations surfaces absent |

## Work sequence

1. Correct company completion claims and strengthen the read evidence used for planning.
2. Establish a versioned activated blueprint and exact company mappings, then a deterministic bounded operation preview.
3. Reuse durable execution safeguards for business-calendar operations; add stop, recovery and outcome checks.
4. Complete record browsing and report/reconciliation evidence as direct verification tools.
5. Connect the assistant to these business operations and test representative complete goals and elapsed time.
6. Execute authorized company work, reconcile results, resolve remaining release evidence and record final acceptance.

Existing production company, prior records and concurrent edits are preserved. Implementation authorization does not itself activate a production schedule or authorize unbounded historical writes. Any required live approval is requested against the concrete reviewed operation, not a vague plan. No code or fixture result counts as a verified company outcome.

## Initial evidence slice — 2026-10-06

Implemented truthful Company readiness and explicit activity gaps, bounded paginated coverage, future-date exclusion, missing-source/prerequisite uncertainty, and scope-safe frontend reads. Independent implementation and safety reviewers found no remaining blockers after corrections. Twenty-six coverage/readiness tests, backend syntax, frontend build/lint and diff checks pass. Existing warnings remain. Desktop loading, ready and failed-count states were observed in the connected Production company; no QBO records were changed. Company-switch race behavior is source-reviewed but has not been exercised by switching the real connected company. This is a foundation, not completion of company catch-up or the whole product.

## Direct book evidence — 2026-10-06

The Company page ran a read-only check for the current month through October 6 in the connected Canadian Production company. All four named comparisons passed: trial-balance equality, balance-sheet equality, receivables versus aging, and payables versus aging. The report-reader required actual Canadian layout adjustments (untyped data rows, explicit dated aging with no reported basis, unique exact summary labels); these were tested rather than silently inferring missing metadata. See book-evidence.md.

The report totals also show unusually large existing balances and negative receivables. Agreement is not plausibility. Determine which existing records represent intentional support tests and which belong in the continuing business baseline before adopting balances or creating compensating entries. No correction or deletion is authorized merely by this observation. Company business continuity, realistic scale, report catalog completeness and bank reconciliation remain unmet or unverified.

Next implementation boundary: activate a validated versioned company blueprint with actual prerequisites, then a deterministic bounded business-calendar operation preview and durable execution/checkpoint contracts. Do not reuse the legacy random rolling-window planner or infer a historical baseline from run timestamps.

## Deterministic calendar foundation — 2026-10-06

Added a pure bounded calendar planner with stable company-scoped operation identities, real monthly/weekly dates, retained future obligations, prior-period dependency checks, changed/removed-activity comparisons, and interruption conflicts. Eighteen calendar tests and thirteen book-evidence tests pass. Implementation review is clear after fixes. See business-calendar.md. This is not yet wired to an activated blueprint, durable ledger or execution route; no business period is newly complete.

Next: immutable activated blueprint and company mappings, persisted previews/managed receipts, and business-cursor advancement after actual outcome verification. Whole-app status remains active and incomplete.

## Durable period-verification foundation — 2026-10-06

Added isolated BusinessCalendar/OperationRun models and an internal store for exact reservations, stop requests, fresh evidence validation, atomic Run/Calendar commit, and crash-safe pending-commit repair. The transaction adapter has no independent-write fallback. Twenty mocked persistence tests pass. No startup import, initialization, migration, route, executor or live verification was performed. See business-period-store.md for proof boundaries.

Next integration remains the activated blueprint, company mappings, persisted plan/steps/managed evidence, and complete execution flow. The active company still has no verified business calendar or realistic baseline. Whole-app completion remains unmet.

## Company business-plan draft workflow — 2026-10-06

Added the Company business-plan panel, bounded read-only setup options and an authenticated append-only draft save service with same-transaction audit/version allocation. Stale loaded connections, concurrent edits and lost-response retries have explicit handling. Independent implementation review is clear; safety review required the storage check to reject partial/sparse uniqueness. See blueprint-drafts.md.

Desktop evidence confirms proposal values and actual setup options are visible. Read-only storage inspection found transaction-capable topology but no new business collections and no explicit membership for the connection owner. An existing other member is preserved. No storage preparation, role assignment, live draft save or QBO write was performed. A reviewed explicit setup is required; these missing prerequisites do not constitute a complete business workflow.

## Existing-record inspection and setup preparation — 2026-10-06

Records now exposes paging beyond the first 50, transaction date filters and active/inactive list filters, with scoped/cancelled results and bounded relationship reads. Direct Canadian Production reads verified 93 invoice IDs over two non-overlapping pages, four September invoices, five inactive customers, validation recovery and linked invoice/payment details. See record-inspection.md. This improves baseline inspection; it does not classify, repair or complete the company's business records.

The explicit business-plan storage/membership setup is implemented and independently reviewed with isolated recovery tests. A read-only preview targets the connected company's existing owner and two blueprint collections only. One-time owner-access/database authorization has been requested and remains pending; no apply has run. See business-storage-setup.md. Work continues independently while that prerequisite is unresolved.

## Record-origin evidence — 2026-10-06

Records now searches saved app creation receipts, links scoped support sessions, and separates recorded environments from legacy history with missing environment. Seed and older assistant creation contracts are covered; no origin is inferred from names or prefixes. The original test PO's historical creation step and case link were observed in the connected company. See record-origin.md. This evidence supports future baseline decisions; existing records remain unclassified and no cleanup, baseline adoption or business catch-up has occurred.

## Dated business activity preview — 2026-10-06

The Company page now exposes a bounded deterministic activity proposal from the saved draft or current business proposal, with stable dependencies, prior-period prerequisites and later follow-ups. Direct app inspection verified the current-period calculation, paging and date-error recovery. See business-activity-preview.md. This connects the profile to a visible planning workflow; it does not establish missing company records, activate rules, compile transactions, run catch-up or complete the business calendar. The storage/owner setup authorization remains pending.

## Full assistant-case elapsed time — 2026-10-06

Added first-request-to-result timing that survives continuations, separate latest-run duration, truthful unavailable/estimated historical timestamps, and evidence-aware result labels. The original case directly displays 10h46m total to its latest result and 38s for its latest run. See case-timing.md. This supplies the measurement needed for speed acceptance; broad goal completion, latency targets and representative live performance tests remain unmet.


## Company mapping validation — 2026-10-06

The business-plan panel now checks exact saved choices against bounded fresh company observations, rejects changed plan/connection scope, distinguishes inactive/incompatible/unverified records, and treats Canadian tax treatment as unresolved even when rate references exist. Direct read-only desktop evidence confirms CAD home currency and nine unassigned mappings. Twenty-eight isolated mapping/draft tests pass; independent implementation and safety reviews are clear. See blueprint-mapping-check.md. Activation, baseline adoption, coherent history, ongoing operations and whole-app release acceptance remain unmet. Storage/owner setup approval is still pending and was not applied.


## Linked transaction-detail proposals — 2026-10-06

Activity previews now carry proposed line quantities, prices, intended party/product identities, cash directions and saved-originating-total settlement rules. They preserve the existing calendar integrity contract and have separate economic fingerprints. Fifty-one focused tests pass; independent reviews are clear after corrections; desktop October activity amounts and line details were inspected. See business-activity-details.md. These are unapproved fixture economics, not executed QBO records. Actual master mappings, tax policy, baseline and durable business execution remain unresolved; the full goal remains active.


## Explicit master-record bindings — 2026-10-06

Business drafts now preserve explicit customer/vendor/item/worker choices, and a scoped read check verifies active status, currency, item type and account references without adopting records by name. Small-profile customer pooling now matches its 12-customer target. The first Flagship activity template requires 61 identities; the broader approved population and projects remain incomplete. Forty-nine focused tests and required source reviews pass. Desktop company reads, paging and read-only access were observed; no actual records were created or adopted. See business-master-data.md. Whole-app activation/execution and the pending storage/owner setup remain open.

## Scoped operation preparation — 2026-10-06

The dated activity proposal now resolves explicit record choices against fresh company observations and traces current and prior dependencies. The app shows blocked requirements instead of suggesting that the proposal can run. Direct read-only desktop inspection shows 55 planned October steps, 48 unresolved reference choices and 48 earlier transactions requiring evidence. Independent reviews are clear after malformed record-version validation was corrected; 28 focused rerun tests pass. See business-operation-preview.md. This remains preparation: activation, real baseline, transaction compilation, durable execution and complete business records are still unmet.

## Durable per-step receipts and recovery — 2026-10-06

Added an isolated operation-step model and transactional state boundary for claims, possibly-sent requests, saved receipts, read-back, unknown recovery and prior-operation evidence refresh. Failed re-verification invalidates old evidence; transitive dependencies and exact relationship versions are checked before dependent work. Forty-seven combined focused tests and 91-file backend syntax checks pass; independent implementation and safety reviews are clear after corrections. See business-step-store.md. This is not wired to a real writer/runner or live database and does not create company records. Full execution, deployment and direct business outcomes remain unmet.

## Concrete company writer coordination — 2026-10-06

Connected the step and period stores to one transactional writer adapter. It prevents competing ownership, retains possibly-sent request barriers, binds settlement to exact receipts, invalidates superseded completion proof and releases company/calendar ownership atomically after commit repair. Sixty isolated integrated tests pass; syntax passes 93 files and independent reviews are clear. See business-writer-fence.md. The readiness gate is mechanically closed because the existing QBO transport and other writing workflows do not yet participate. No live storage was prepared or company records changed. The next execution integration must cover those common write paths, not bypass the gate. Whole-app completion remains unmet.

## Common QuickBooks transport coordination — 2026-10-06

The shared backend client now binds writes to frozen request bytes and durably records transport admission, outcomes and audit for explicitly prepared companies. Concurrent permissions, uncertain outcomes, rejection, permission changes and response-storage failures have focused coverage. Business execution authority is rechecked at admission; read-only/default support roles do not gain it. All 103 focused tests pass, backend syntax covers 97 files, and required independent reviews are clear. See qbo-write-coordination.md.

No storage preparation, live QBO request or activation occurred. The existing unprepared path remains available, so explicit preparation/draining and exclusion of standalone writers are still required before the business integration gate can open. Exact transaction compilation, durable runner/recovery wiring, approved baseline and live business outcomes remain incomplete. The whole-app goal remains active.

## Exact business transaction compilation — 2026-10-06

Added an internal compiler for the current nine business activity types, with exact saved source totals, control accounts, Canadian tax-policy bindings, source line relationships, work-hour reconciliation and aggregated inventory availability. Explicit scoped deposit-availability proof is required. Compiled observations are bound to the current operation writer revision; durable dispatch and common transport reject changed or expired evidence. Time previews now include the required service item choice. See business-transaction-compiler.md.

All 129 distinct focused compiler/dispatch tests passed across the suite and targeted correction reruns; backend syntax covers 98 files. Independent implementation and safety reviews are clear after hours, financial-line, stock aggregation and freshness corrections. No QBO requests, storage preparation, activation or service restart were performed. Complete provider acceptance and read-back, server-owned evidence/policy adapters, saved operations, runner integration, baseline and live period/report outcomes remain unverified or incomplete. The whole-app goal remains active.

## Exact saved-record verification — 2026-10-06

Added a two-stage read-back boundary for the nine compiled activity types. It binds full compiled intent to dispatch, checks exact headers and lines, approved tax expectations, current related-record proofs, settlement balances and PO API consumption without confusing the API with screen-level evidence. It handles invoice/time proof ordering and preserves the shortest evidence lifetime. The step store rejects content-only or differently compiled evidence. See business-readback.md.

All 106 distinct focused tests passed across the suite and corrected-fixture rerun; backend syntax covers 99 files. Required independent reviews are clear. Durable artifact storage, runtime graph/tax adapters, live Canadian response acceptance, runner wiring, approved baseline and full business/report outcomes remain incomplete. No live writes, storage preparation or service restart occurred. The whole-app goal remains active.

## Original prepared transactions retained — 2026-10-06

The step store now atomically saves the bounded original compiler artifact with dispatch and audit, verifies exact dependency identities/versions, and offers a scoped internal recovery read. Lost commit replies, audit rollback, changed artifacts, later-operation ownership and unrelated-context exclusion have focused coverage. All 109 tests in the current five-suite set pass, plus the 26-test correction rerun. Both required reviews are clear.

This removes the compiled-artifact persistence gap in code, not the real deployment/integration gap. Runtime graph/tax/plan loaders, the business runner, approved company setup and baseline, live Canadian acceptance and complete records/report outcomes remain incomplete. No live writes, database preparation, service restarts, commits or pushes occurred. The whole-app goal remains active.

## Complete related-record read-back — 2026-10-06

Connected retained artifacts and current observations into two-pass verification of full sales and purchasing chains. The read-only loader discovers both source and saved downstream activities, rejects unresolved/foreign/missing evidence, streams bounded storage reads, uses up to three provider workers, and enforces cancellation, deadline and writer-change checks. It explicitly returns unpersisted proof; no period or step is falsely marked complete. See business-graph-readback.md.

63 focused graph/read-back/step tests pass across the suite and targeted expiry correction; syntax covers 100 backend files and independent reviews are clear. Real adapter and Mongo cursor behavior, atomic graph-proof persistence, the operation runner, approved setup/tax/baseline and complete live records/report outcomes remain incomplete. No live requests, database preparation, service changes, commits or pushes occurred. The whole-app goal remains active.

## Atomic related-record verification — 2026-10-06

The step store now joins graph preparation, exact company writer snapshots, full-chain invalidation, external read-back and atomic proof/audit persistence. It rejects changed records or writer state, incomplete/expired proof and cancellation without partial verified chains. Lost commit acknowledgements remain safe to re-read without transaction recreation. See business-graph-readback.md and business-step-store.md.

115 integrated focused tests and 100-file backend syntax checks pass; implementation and safety source reviews are clear. No live company records, storage, services or Git history changed. Practical Mongo transaction capacity, runtime evidence/tax/plan adapters, business runner, approved baseline/setup and full live records/report outcomes remain incomplete. The whole-app goal remains active.


## Original operation plans and exact execution approval — 2026-10-06

Added append-only operation manifests and separately paged compiler intents, bound to exact company, economic policy, dependency closure and period expectations. Retries reuse the complete retained plan without regenerating candidates. Missing creation disposition is rejected; earlier activities require their original saved receipts. Exact durable approval is now enforced at reservation, company writer fencing and common QuickBooks transport admission. See business-operation-plan-store.md.

142 focused persistence/execution-admission tests pass, syntax covers 103 backend files, and required implementation and safety source reviews are clear. No company records, database setup, services or Git history changed. Runtime candidate/activation/baseline/policy adapters, reference-version revalidation, storage deployment, the durable runner, direct Canadian provider/report evidence and the whole business outcome remain incomplete. The whole-app goal remains active.


## Approved definitions through normal record updates — 2026-10-06

Saved intents and compilation now bind complete master definitions while allowing newer record versions with explicitly permitted current balances or stock observations. The original approved intent remains unchanged, current inventory is still checked, and all other definition changes reject execution. A fixed scoped full-entity GET reader supplies required provenance; matching query projections are not accepted. See business-reference.md.

107 focused reference/compiler/plan/read-back/graph tests pass; syntax covers 104 backend files and required implementation/safety source reviews are clear. Actual client resolver wiring, cancellation of the underlying QBO request, live Canadian acceptance, activation/baseline/policy adapters, durable runner and complete company/report outcomes remain incomplete. No live requests, database setup, service changes or company writes occurred. The whole-app goal remains active.


## Complete core account choices — 2026-10-06

Added explicit receivables, payables and undeposited-funds mappings across business drafts, structural checks, dated operation preparation and the Company chooser. The chooser and backend use matching account type/detail-type/currency requirements; older drafts preserve their choices and expose missing control accounts as unassigned. Steps now carry exact relevant control-account requirements matching the compiler.

47 focused draft/mapping/operation/master tests pass, backend syntax covers 104 files, and frontend build/lint plus required independent reviews are clear apart from existing warnings. Read-only desktop inspection in the connected Canadian Production company verified all 12 roles and the compatible control-account options. No mappings were saved, storage prepared, permissions changed or QBO records written. Approved setup/baseline/policy, runtime adapters, durable runner and complete live business/report outcomes remain incomplete. The whole-app goal remains active.


## Exact dispatch and durable response recovery — 2026-10-06

Connected the original operation intent, compiler, step receipts, writer fence, existing QBO transport and exact persisted response/audit reader into an internal dispatcher. A successful response or a lost acknowledgement resumes through stored evidence without another creation request. Settled records undergo graph reconciliation on every resume; recent timestamps cannot hide later linked-record changes. See business-dispatch.md.

The initial integrated six-suite set passed 126 tests; the safety-review correction passes all 12 dispatcher tests. Backend syntax covers 106 files and both required source reviews are clear after correction. Fixtures cover real module composition through dispatch and settlement but substitute the final root-record graph adapter. No live database/QBO writes, service changes or Git commits occurred. Full graph/runner/authority/observation adapters, prepared storage, active blueprint/baseline/tax policy, live Canadian acceptance, complete historical/current records and report evidence remain incomplete. The whole-app goal remains active.


## Current runtime authority and workspace admission — 2026-10-06

Added the concrete operation authority/client adapter using existing current membership permissions, exact actor/owner identity, selected company and environment. It rejects suspended membership without legacy fallback and rechecks authority after constructing a scoped client. The operation plan store now passes transaction sessions using the shared adapter contract. See [business-runtime-access.md](business-runtime-access.md).

Independent safety review identified a workspace-selection race; the correction fences both owner and actor connection-switch documents inside durable business transport admission and repeats workspace selection there. Both implementation and safety reviews are clear after correction. The corrected gate/dispatch/access set passes 45 tests, the earlier plan/access/dispatch set passed 47 tests, and existing permission/workspace regressions pass 15 tests (overlapping sets, not a distinct combined count). Backend syntax covers 107 files; diff checks pass.

This is internal composition support, not activated business execution. Real Mongo conflict behavior, production runtime observation/graph composition, runner integration, storage deployment, approved blueprint/baseline/tax policy, complete real records and live report acceptance remain incomplete. No QBO requests, database setup, service restart, commit or push occurred. The pending one-time storage/owner setup permission was not applied. The whole-app goal remains active.


## Concrete saved-record verification runtime — 2026-10-06

The graph reader now has a company/operation-bound runtime adapter using original QBOClient transaction GETs, actual writer snapshot fencing and original immutable plan/policy retrieval. Missing independent tax expectations remain unverified. Current-operation policies cannot replace original historical transaction policy. See [business-verification-runtime.md](business-verification-runtime.md).

The corrected runtime/reference/dispatch set passes 52 tests, and the graph set passes 19 tests including complete sales/purchase chain reads through the concrete runtime. The actual dispatch/step-store integration persists graph proof and clears it after a changed observed amount without repeating creation. Backend syntax covers 108 files; both required independent source reviews are clear after fixing the read/preview permission mismatch. These are fixtures, not live Mongo or Canadian API acceptance.

Production runner composition, fresh compilation-observation adapters, independent tax expectation preparation, explicit storage/owner setup, approved baseline and full records/report outcomes remain unfinished. No live company request, database setup, service restart, commit or push occurred. The whole-app goal remains active.


## Concrete pre-creation observations — 2026-10-06

Added an operation-bound compilation runtime that reloads exact retained intent, refreshes source graph proof, reads current master/source records with at most three provider workers, rejects changed observed hashes and requires a stable company writer revision. Missing independent tax expectations prevent creation. Deposit availability requires complete matching scans and an unchanged source payment, with explicit bounds and no claim of an atomic provider snapshot. See [business-compilation-runtime.md](business-compilation-runtime.md).

The initial three-suite set passes 67 tests; the corrected runtime/plan/dispatch set passes 55 tests (overlapping suites). The integrated dispatcher uses both concrete compilation and verification runtimes. Source reviews identified and resolved malformed deposit-line acceptance and dependency metadata incompatibility; both reviews are now clear. Backend syntax covers 109 files. No live QBO or database changes, service restarts, commit or push occurred.

The full product remains incomplete: operation runner composition/activation, explicit storage preparation, approved company tax/baseline/blueprint and actual complete records/report proof are still pending. The whole-app goal remains active.


## Durable operation progress and recovery — 2026-10-06

Added a scoped internal operation runner and transactional audited worker/progress state. It pages the original saved plan, verifies each activity before progress, resumes evidence-only work without recreating records, settles outstanding receipts on cancellation/stop, and repairs ambiguous completion from durable calendar receipts. Worker leases now bind step claim/dispatch, provider admission, progress and final period completion. See [business-operation-runner.md](business-operation-runner.md).

The first eight-suite focused set passes 150 tests. Independent implementation/safety reviews identified and resolved end-of-plan retry and replaced-worker boundary gaps; both source reviews are clear. The corrected four-suite set passes 87 tests (overlapping the initial set); backend syntax validation passes all 111 files. These fixtures do not establish real Mongo concurrency, Canadian provider acceptance or report collector integration.

No live QBO writes, database setup, services or Git history changed. Production collector/runtime composition, approved storage/owner setup, blueprint/tax/baseline and complete historical/current records with direct report proof remain incomplete. The whole-app goal remains active.


## Retained record and report verification — 2026-10-06

Added a concrete scoped report reader and period collector that refreshes the complete managed record graph, fetches bounded full report/account sources, derives exact named checks, and saves append-only proof/source evidence with audit and the Run candidate in one transaction. Completion rereads and validates the retained sources; missing reports, unsupported checks, changed records or worker ownership cannot silently complete a period. See [business-period-evidence.md](business-period-evidence.md).

Initial five-suite verification passes 53 tests. Independent implementation and safety reviews are clear after correcting the date helper, malformed Account values, and retained-source mutation/load validation. The final five-suite set passes 59 tests, including concrete client-to-collector composition; backend syntax validation passes all 114 files. These remain fixtures; no live Mongo or Canadian company acceptance is claimed.

No QBO writes, database preparation, service restarts, commits or pushes occurred. Production runtime/route composition, explicitly prepared evidence/operation storage, approved blueprint/tax/baseline, real historical/current records and direct report proof remain incomplete. The whole-app goal remains active.


## Assembled saved-operation runtime — 2026-10-06

Added one company/operation-bound server runtime composing concrete authority, saved plans, execution/recovery, QBO transport, graph verification, reports and retained period proof. Added production storage inspection and a shared transactional/idempotent audit adapter. The runtime creates no storage, performs no construction-time reads/writes, and has no activation or public execution route. See [business-runtime.md](business-runtime.md).

The initial five-suite runtime set passes 101 tests, including a complete approved Estimate through actual module composition and simulated provider responses. Independent reviews found and resolved legacy model-registration side effects and preparing-state dispatch barriers. Both source reviews are clear. The final seven-suite set passes 111 tests; syntax validation passes all 117 backend files.

Actual app route/background execution, operation preparation/activation, approved blueprint/mappings/tax/baseline, explicit storage setup and direct Canadian records/report acceptance remain incomplete. No live company/database actions, service changes, commits or pushes occurred. The whole-app goal remains active.


## Durable execution routes and background recovery — 2026-10-06

Added authenticated saved-operation list/inspect/execute/stop routes and a durable background request service. Execution returns before provider work. Explicit server startup resumes saved pending work through the existing runtime and leases; it does not prepare storage or approve/create plans. Stop handles queued and previously blocked work, records the actual stopper, and retains superseded-request history. Fair scanning prevents damaged old requests from starving later valid work. See [business-execution-service.md](business-execution-service.md).

Focused verification passes 14 execution-service tests, 3 route contracts and 24 shared runtime/dispatch tests across the final reruns (41 distinct cases). The full backend syntax check passed 119 files, with changed-module syntax rechecked afterward. Fixtures include actual runtime composition with simulated provider responses, interrupted-service recovery, post-enqueue revocation, atomic settlement failure, no-duplicate recovery and stopped saved-record recovery. Independent review found and resolved request-hash, stop-continuation, queue-starvation, audit-actor and completion/stop race issues; both required source reviews are clear.

The live app has not been restarted and no real database or company writes were made. The new run index needs explicit storage preparation beyond the earlier blueprint-only preview. App operation preparation/approval integration, desktop workflow, approved company blueprint/mappings/tax/baseline, and complete real historical/current records with Canadian report proof remain unfinished. No commit or push occurred. The whole-app goal remains active.


## Desktop saved-operation workflow — 2026-10-06

The Company page now lists and inspects saved business operations with bounded pagination, automatic scoped progress reads, explicit Run/Continue/Stop controls, current server permissions, stale-read protection and truthful completion evidence. Lost acknowledgements retain their key; a confirmed old settled request can lead to one fresh continuation after checking current scope/plan/permissions. See [business-operations-desktop.md](business-operations-desktop.md).

The service/view tests pass 19 cases, route contracts pass 3 cases (22 distinct final cases), changed backend syntax checks pass, frontend build/lint pass, and diff checks pass. Existing warnings remain: three AICommandCenter hook dependencies, a build chunk above 500 kB and LF/CRLF notices. Both independent source reviews are clear. A distinct desktop review found no visual blockers in the isolated actual-component fixture and confirmed Inspect/Close focus behavior.

The actual existing Chrome Company page rendered the new panel and reached the backend; it reports that operation storage needs explicit preparation. Fixture interaction covered loading/empty/error, current completion proof, paginated records, scope mismatch, read-only access, Run/Stop, failed refresh, unknown acknowledgement and one-click settled retry. No real-company operation, database setup, service restart, commit or push was performed. Preparing approved retained operations from the business plan, accepted baseline/tax rules, required storage/owner setup and actual complete records/report acceptance remain unfinished. The whole-app goal remains active.


## Full record definitions in operation preparation — 2026-10-06

The existing preparation route now obtains complete master-record definitions for authorized operators, retaining exact hashes in the proposed activity without returning private record fields. It shares repeated reads, bounds concurrency/time, rejects changed versions and rechecks current actor/workspace authority and the saved blueprint. Disconnected requests cannot start the additional read phase. See [business-operation-preview.md](business-operation-preview.md).

Focused verification passes 54 tests across preparation bindings, authenticated route behavior, existing previews/drafts and runtime access. Changed-module syntax checks and diff checks pass. Independent implementation and safety source reviews are clear. These are non-live fixtures, including the original client with a simulated provider boundary; no production operation or complete business record set was verified.

This closes the full-reference binding gap, not the full preparation/activation gap. Historical dependencies still need their original saved intents/policies; approval/activation, explicit storage/owner setup, accepted baseline/economics/Canadian tax rules, and complete actual historical/current records with report proof remain unfinished. No live QBO/database writes, service changes, commit or push occurred. The whole-app goal remains active.


## Original saved dependencies in preparation — 2026-10-06

Preparation now reads local operation history through the existing indexed step ownership and original approved plans. It follows the original saved dependency closure and policies instead of recreating past intent from current settings. Existing current-period activity produces an original-operation resume/recovery blocker and skips unnecessary master GETs. Public responses retain provenance only; missing local receipts never establish QBO absence, and saved verification still requires current readback. See [business-operation-plan-store.md](business-operation-plan-store.md) and [business-operation-preview.md](business-operation-preview.md).

The five-suite focused set passed 76 cases initially. Deadline/cancellation review findings were corrected and new stalled-adapter/read regressions passed in a 47-case rerun. The final local-error-classification correction passed 41 plan/preparation cases plus syntax. Across those final checks there are 79 distinct focused cases. Both independent source reviews are clear; database/provider behavior was simulated and no real history or company outcome is claimed.

No new collections/indexes, live database or QBO writes, service changes, commits or pushes occurred. The complete goal remains active: approved candidate/activation integration, explicit storage and ownership setup, accepted baseline/economics/Canadian tax policy, the broader intended feature coverage and actual complete historical/current company records with report evidence are still unfinished.


## Complete initial operation storage setup — 2026-10-06

The explicit setup script now supports a separately hashed business-operations profile covering the two blueprint and nine runtime collections with exact indexes, including physical-record partial uniqueness. It verifies legacy prerequisites without repairing them, lists owner-access and scope-counter changes, and refuses initial setup when any runtime collection has records across the database. It creates no activation or operation rows. Default blueprint setup and its original approval contract remain unchanged. See [business-storage-setup.md](business-storage-setup.md).

The setup/runtime-storage suites pass 26 tests, including actual schema parity and fixture readiness; both executable syntax checks pass. Independent implementation and safety source reviews are clear. This is initial setup only and requires no concurrent privileged initialization/deployment; a future initializer or populated-storage upgrade needs a maintenance protocol.

A read-only preview of the configured production workspace passed its legacy prerequisites and found all 11 business collections missing, requiring 17 indexes and an explicit absent-owner membership grant. The concrete expanded preview is saved outside the repository. The earlier blueprint-only preview does not cover this profile. No setup was applied; real DDL/transactions and subsequent saving remain unverified.

The whole-app goal remains active and incomplete. Candidate/activation integration, accepted baseline/economics/Canadian tax policy, full intended feature coverage, actual historical/current records and direct report evidence are still required. No QBO writes, service changes, commits or pushes occurred.


## Exact preparation-to-plan assembly — 2026-10-06

Added a pure server-owned assembler connecting real operation previews and original retained history to existing immutable Plan/Intent persistence. It binds exact blueprint/business/opening identity, resolves dependency fingerprints before policy review, preserves original earlier steps/policies and physical ownership, rejects existing current activity, and accepts only independently supplied policies already matching finalized steps. Unresolved operation-wide requirements cannot disappear: known deferred requirements remain explicit and currency/unknown blockers reject assembly. See [business-operation-candidate.md](business-operation-candidate.md).

The initial four-suite set passed 64 tests. Implementation review identified and corrected lost operation-wide blockers; the final candidate/plan-store set passes 49 tests, including actual generated first-period chains, retained transitive ancestry, saved-plan persistence and compiler use. All changed modules pass syntax checks. Both independent implementation and safety source reviews are clear. These are fixtures, with no real baseline approval or Canadian policy acceptance.

Production candidate loading, retained baseline/economics/tax review, activation and maintenance fencing, approval/UI integration and actual complete records/report outcomes remain unmet. Both assembly phases explicitly remain unpersisted and not ready to execute. Database setup approval remains pending; no live reads or writes, service changes, commits or pushes occurred this turn. The whole-app goal stays active.


## Durable report observations and desktop history — 2026-10-06

Added authenticated, separately authorized report capture tied to the exact saved business-plan version. Original bounded QBO report/account sources, recalculated checks and compact audit are retained atomically in append-only observations; retries return original evidence. Current authority and completed setup are required, and opening-date observations remain distinct from later surveys. Nothing is accepted, activated or marked complete by report agreement. See [business-baseline-observations.md](business-baseline-observations.md).

The Company page supports capture, scoped saved history, inspection and exact-request recovery. The actual Chrome page showed unprepared storage. Isolated desktop interaction proved pagination, empty/loading/error, read-only and changed-company states, lost-response recovery, correction after pre-save rejection, opening-date selection and focused saved results. This is fixture evidence, not a live retained baseline.

Eighty-six focused cases pass across the final combined run and corrected storage-fixture rerun. Backend syntax, frontend build/lint pass with existing warnings. Both independent source reviews are clear after addressing the setup/capture race and invalid-date retry trap. Real MongoDB concurrency, live setup/capture and independent rendered acceptance remain unverified.

A separate baseline-observations v3 setup profile is implemented but not applied or previewed live. The earlier pending operation-storage v2 approval does not expand to it. No QBO/database mutation, service restart, commit or push occurred. The goal remains active: accepted baseline and record ownership, economic/Canadian tax rules, approved activation, full record coverage and actual historical/current business records with direct report/reconciliation evidence still require completion.


## Business-operation provenance in Records — 2026-10-06

Fixed the gap between the new controlled operation workflow and existing Records inspection. Business creations now use exact scoped transport receipts and their original start/response audits, sharing validation with dispatch recovery. The record panel shows the original operation identity without asserting baseline adoption or current verification. Missing, conflicting or incomplete evidence remains explicit. See [record-origin.md](record-origin.md).

The original origin/query/dispatch set passes 43 tests; after correcting a lookup-variable bug found by independent review, the 14-case origin suite and syntax check pass again. Frontend build/lint pass with existing warnings; both source reviews are clear. Tests exercise original dispatch composition with simulated provider data, not live Mongo aggregation or QBO writes.

This connects creation evidence to Records but does not finish business ownership classification. Complete retained existing-record inventory, reviewed opening position, accepted baseline/economics/Canadian tax rules, activation, actual complete historical/current activity and direct report/reconciliation proof remain unmet. No live writes, service changes, commits or pushes occurred. The whole-app goal remains active.

Read-only desktop follow-up: the connected Production Records page loaded its invoice list and Invoice 592 detail. The creation-history panel displayed the existing historical assistant receipt, alongside the explicit unclassified-baseline statement, without obscuring record details. This confirms existing history rendering after the change; it does not validate a new business-operation receipt or its Mongo lookup against live data.


## Retained supported-record inventory — 2026-10-06

Connected current-record inventory to the existing saved report observation workflow. New captures read all pages for the 19 types supported by Records, including inactive list entries, then repeat the full scan and require matching identities, versions and content fingerprints. Compact private evidence is saved atomically with report sources and audit. The visible summary shows counts, inactive records and transaction date ranges; older observations remain readable. See [baseline observations](business-baseline-observations.md#current-supported-record-inventory--2026-10-06).

Fifty-one distinct focused cases pass across the original combined run and the final affected-suite rerun. Actual production-service composition is tested with the original readers and simulated transport. Backend syntax, frontend build/lint and whitespace checks pass with existing warnings; independent implementation/safety source reviews are clear. Desktop fixture interaction confirms full inventory rendering, old observations and uncertain-save recovery. This does not prove live 19-type Canadian API compatibility, real retained capture or Mongo transaction behavior.

The inventory is a current bounded observation, not an atomic or historical snapshot, ownership classification, accepted baseline or proof of complete business activity. Types outside the named set and companies beyond the retained document budget need additional evidence/storage support. Reviewed opening position, record adoption/ownership, realistic economics and Canadian policies, activation and actual historical/current business records with report/reconciliation proof remain outstanding. Existing storage-setup approval is still pending; no live QBO/database changes, service changes, commits or pushes occurred. The whole-app goal stays active.


## Review of captured records — 2026-10-06

Connected retained inventory to exact record-by-record evidence review. The app now pages captured identities, compares a selected captured record with a fresh scoped QBO query, and shows creation history separately. Mismatched content/version, absent query rows and incomplete origin have distinct outcomes. Audited evidence, current read permissions, original company scope and selected record are checked before a comparison. No adoption or record mutation is authorized by a match. See [baseline observations](business-baseline-observations.md#captured-record-review--2026-10-06).

Sixty-two focused tests, six backend syntax checks, frontend build/lint and whitespace checks passed; both independent source reviews are clear. Desktop fixtures proved record pagination, comparisons, errors, empty types, company mismatch rejection, pending request cancellation and focus. The source/runtime composition uses simulated transport; actual captured production records and all Canadian query shapes remain unverified.

This completes an evidence-review path needed for classification, not classification itself. Persisted inclusion/exclusion/adoption decisions, accepted realistic opening position, Canadian/economic rules, business activation and complete historical/current QBO records with report/reconciliation evidence remain outstanding. The pending setup boundary remains unchanged. No live writes, persistent service changes, commit or push occurred. The whole-app goal remains active.
