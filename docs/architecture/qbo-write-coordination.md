# Common QuickBooks write coordination

Implemented 2026-10-06. Internal execution integration; not activated or live-verified.

## Boundary

The backend's shared QBOClient freezes the exact POST endpoint, query, serialized body and company connection before awaiting token refresh. Business dispatch permissions are consumed once in their asynchronous call context and again durably at transport admission. Prepared companies use CompanyWritePolicy, CompanyWriter and QboWriteReceipt. The admission transaction records the possibly-sent receipt, writer barrier and audit before the SDK call.

Business admission requires the current operations.execute permission, including explicit overrides, even for the connection owner. The lab-owner role has that permission by default; other roles do not. A membership update in the same transaction conflicts with concurrent permission changes. Existing route-level authorization still applies to all callers. Receipt settlement can complete after permission loss or a stop because it records an already-sent outcome, not another request.

## Outcomes

- A supported success must identify exactly the expected entity, target ID for changes, and canonical saved version. Deletes require the expected deleted ID/status.
- A narrow HTTP 400 ValidationFault envelope with numeric fault codes is recorded as rejected. A rejected business step becomes terminal rejected, its operation becomes blocked (or remains stopped), and no saved record is invented.
- Missing status, incomplete responses, wrong IDs, system faults and transport failures remain uncertain. They retain the company barrier. Receipt or audit storage failure cannot release that barrier.
- Coordinated writes do not automatically retry, including throttling responses. Coordinated batches remain disabled until per-item recovery exists. Existing unprepared legacy retry behavior and GET handling remain separate.
- Receipt storage contains bounded response metadata, hashes, IDs and versions, not transaction bodies or credentials.

Local admission conflicts return 409. Uncertain response/receipt errors return 503 with outcomeUnknown; network/upstream failures preserve their existing gateway mapping and also expose outcomeUnknown. Upstream 401 still never becomes an application-session 401.

## Deployment remains closed

The business writer integration readiness gate remains false. A missing policy and writer currently selects the existing unprepared legacy path. An independent policy marker prevents a prepared company with a missing or mismatched writer from falling through to that path. A preparing marker blocks new coordinated writes.

Before activation, an explicit bootstrap must establish unique indexes and transaction support, stop/drain every previously admitted unprepared request, and prove all writers participate. The marker alone cannot drain a request admitted before preparation. The standalone Phase 0 client is outside this backend transport and needs its own exclusion/integration policy. No bootstrap, database migration, scheduler activation, server restart or QBO mutation was performed for this change.

The current operation runner, exact payload compilation, request-correlated recovery adapters, report verification and full company outcomes remain separate unfinished work. This transport foundation is not whole-app completion.

## Verification

Focused fixtures cover concurrent admission, lost admission replies, storage/audit rollback, malformed responses, permission changes, business rejection, immutable request bytes, inherited asynchronous calls, no coordinated retry and HTTP error distinctions. Actual MongoDB concurrency and live Intuit behavior remain unverified. Final command results are recorded in whole-app-completion.md.

Compiler integration (2026-10-06): dispatch now requires exact compiled intent/request evidence bound to the operation writer revision and a fresh observation timestamp. The writer transition compares that revision; transport rechecks the resulting revision and evidence freshness. See business-transaction-compiler.md. This does not open the activation gate.


Operation-plan integration (2026-10-06): see [business-operation-plan-store.md](business-operation-plan-store.md). Original scoped intents are now retained separately. Step creation requires explicit create disposition; earlier-record intents cannot authorize recreation. Reservation, writer fencing and coordinated business transport require the exact durable plan approval. Runtime activation and storage deployment remain closed/unperformed.


Workspace admission (2026-10-06): business permits now transactionally increment the owner and actual actor connection-switch guards, recheck shared-workspace selection, and require the latest active owner connection. This conflicts with concurrent OAuth switches on the same users. Failed admission rolls back guards with receipt/audit changes. See [business-runtime-access.md](business-runtime-access.md). Unprepared legacy admission remains unchanged; no company was activated.
