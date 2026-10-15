# Application evidence review — 2026-10-15

## Plain-English summary

The app can prove the exact plan, actor, company, request and accepted record for coordinated business writes. It retains the source reports and record checks used to advance the managed calendar. New owner recovery decisions preserve previous plans, rejected attempts and tax expectations.

It cannot yet follow every button click through authentication, background jobs, QuickBooks and an AI provider using one shared label. A request ID is that shared label. Several errors and authentication events exist only while the server terminal is open. An audit trail is a saved record of who did what; a log is useful evidence only when it is actually retained.

Users currently look in Company → Business operations, Cases, Explorer and History. These surfaces do not yet provide one complete diagnostic view. The Company recovery surface now supports owner attribution of an exact saved record after a terminal unknown business request. It retains the unknown transport history and separately labels manual provenance. Requests with no terminal evidence remain blocked; absence of a response does not prove absence of a saved transaction.

This report reflects source inspection, a restricted source-only evidence scan and the implementation ledger. It does not claim live deployment, production activation, database migration, provider execution or whole-business acceptance. Private company observations remain outside Git.

## What logs exist today

| Area | Evidence and location | What it proves |
| --- | --- | --- |
| Shared-company actors | middleware/companyScope.js; modules/actor-context.js | Separates the acting member from the workspace owner. |
| Business decisions | BusinessAuthority, BusinessCandidate, OperationPlan, OperationIntent; business-governance-service.js | Exact retained opening acceptance, plan, policy sources and owner approvals. |
| Financial writes | QboWriteReceipt; qbo-write-gate.js | Mandatory admission and response classification with company scope, request hash, protected-period evidence and Intuit reference where returned. |
| Managed records | OperationStep; business-step-store.js | Original creation ownership, attempts, receipts, compilation and saved record checks. |
| Period completion | OperationEvidence, BusinessCalendar; business-period-evidence.js | Named fresh record/report checks and the exact calendar advance. Income comparison means pretax revenue, not net profit or COGS. |
| Cases | AISession.reproduction, AIPlan, AuditLog; reproduction-runner.js | Saved case actions, tool observations, owned changes, conclusions and limitations. |
| Operational status | GenerationRun and saved executionRequest fields | Some durable progress; not a universal worker heartbeat. |

Paths above refer to backend/src unless a model or UI name is given.

## What logs are only temporary terminal output

Many route catches call console.error. Provider retries, token refresh diagnostics, scanner errors and some audit-storage failures are also printed. The source does not make console output a durable event store. The Windows launcher may retain particular output files, but that is not a per-request persistence contract.

Evidence: middleware/errorHandler.js, middleware/auditLogger.js, routes/auth.js, modules/ai-provider.js, modules/qbo-client.js, modules/business-execution-service.js.

## What durable logs or audit records exist

AuditLog is queried by routes/audit.js and shown in History. Company writes also retain stricter transactional audits, transport receipts, immutable plans and frozen report sources. Those records survive an application process exit if their database transaction committed.

The generic createAuditEntry helper catches a storage error and returns null. Its comment promises append-only behavior, but the AuditLog model itself has no blanket update/delete middleware. Critical business modules do not rely on fire-and-forget auditing for permission to send; their required audits share the state transaction. These distinctions matter when explaining what can be proved.

## What auth events are tracked

OAuth connection actions have explicit audit paths. Login success/failure, registration, logout and personal AI-key changes do not currently have a complete durable auth-event trail. Logout is primarily client token removal. AuditLog requires a user and realm, so it cannot directly represent an unauthenticated failed login without inventing a company.

Evidence: routes/auth.js, routes/qbo.js, models/AuditLog.js, frontend/src/context/AuthContext.jsx.

## What model activity is tracked

AISession retains messages, tool calls/results, a model field and tokenUsage. Legacy orchestration updates usage in some paths. Reproduction state retains its chosen provider and tool-access check. The Codex adapter returns input/output usage, but this alone does not establish per-pass durable storage, retries, cost or one complete prompt/response trace. Provider failover/retry messages may only be terminal output. No current pricing table is treated as measured cost.

Evidence: models/AISession.js; modules/ai-orchestrator.js, ai-provider.js, codex-cli.js, reproduction-runner.js and reproduction-engine.js. Provider prompts and responses can contain company data; diagnostic exports must be scoped and redacted.

## What health checks exist

GET /api/health names the app and reports database connectivity. Company health distinguishes a saved connection from a fresh read-only QuickBooks probe. Codex has a tool-availability check keyed to its binary/model; this is not proof of a later case's accounting result. Business execution diagnostics report active workers and scanner error in memory. No complete durable queue heartbeat or cross-provider service health history exists.

Evidence: app.js; routes/company.js; modules/codex-cli.js and business-execution-service.js.

## What client-side errors are captured

The API client handles session expiry. Toasts, alerts and individual panels show many errors. Business operation panels retain saved progress and require refresh after unconfirmed responses. Recovery results now preserve bounded, controlled BUSINESS_* explanations.

There is no universal durable browser-error store or error-boundary incident record. A screenshot or console message alone does not survive as an in-app diagnostic event.

Evidence: frontend/src/api/client.js, components/BusinessOperations.jsx, BusinessMaintenance.jsx, BusinessRecoveryReviews.jsx, components/ui/toast.jsx and alert.jsx.

## What server-side errors are captured

The error middleware returns a request reference, logs a bounded category and may print a redacted stack. Many routes handle their own errors before that middleware. Consequently not every exception creates the same durable record or includes the same reference. Raw route error messages and development response stacks require a separate exposure review.

Evidence: middleware/errorHandler.js and route-local catches. No sensitive local configuration was scanned or copied into this report.

## What request IDs or trace IDs exist

middleware/requestContext.js validates or generates X-Request-Id and returns it in the response. The browser API client does not yet deliberately retain a request ID for each action. Generic AuditLog has no consistent requestId field, and actor AsyncLocalStorage does not carry the HTTP request reference. Business request/dispatch/plan hashes provide stronger local correlation, but they do not automatically join authentication, provider calls and unrelated route errors.

## What questions the app can answer now

| Question | Saved evidence | User path |
| --- | --- | --- |
| Which owner approved this business and these opening records? | Immutable authority, selected baseline/inventory hashes and audit | Company; History |
| What exactly was this operation permitted to create? | Immutable plan/intents, company/environment and approval | Company → saved plan review |
| Was a QuickBooks request admitted or definitely refused? | Mandatory receipt plus start/result audits | Company → Business operations; History |
| What tax expectation governed this particular saved transaction? | Dispatch-bound policy head/hash and retained original policy | Operation history and owner tax review |
| Which record/report checks advanced the date? | OperationEvidence and exact calendar completion receipt | Company → Business operations |
| Does an arithmetic check mean bank reconciliation? | Explicitly no; those states remain separate | Company → evidence panels |

## What questions the app cannot answer now

Each gap below has a matching fix plan. These are remaining engineering items, not permission to run live tests.

| ID / question | Why / missing evidence | Minimum fix | Better fix | Likely source | Verification |
| --- | --- | --- | --- | --- | --- |
| O1: Did an uncertain business POST actually create this record? | Matching content cannot prove request identity or exclude duplicates; unfinished requests deliberately stay blocked. | Implemented terminal-only exact-ID owner attribution tied to original request/policy, exclusion scans, immutable decision and retained uncertainty. Never infer absence or replay. | Correlation carried into supported created records, plus a complete owner reconciliation surface. | business-dispatch-receipt.js; business-operation-recovery.js; BusinessRecoveryReviews.jsx | Lost SDK response after fake create; wrong ID/content/scope, stale record, denied owner and audit rollback tests; no second POST. |
| O2: Which request produced this error and its audit/provider calls? | HTTP IDs are not consistently carried into jobs/audits/providers/client errors. | Request AsyncLocalStorage, safe audit requestId, retained job origin and client reference. | Searchable trace grouped by request, operation and provider reference. | requestContext.js; actor-context.js; auditLogger.js; AuditLog.js; api/client.js; provider adapters | One controlled action joins HTTP, durable audit, job and mocked provider without secrets. |
| O3: Who signed in, failed to sign in, changed or cleared a key? | No durable realm-independent auth-event record. | Bounded redacted auth/security event store; never save passwords, keys or raw Authorization. | Current-account diagnostics and scoped security history with retention. | routes/auth.js; middleware/auth.js; models/User.js; Settings | Success/failure/key-change fixtures; events survive reopen; cross-user access and redaction denial tests. |
| O4: Which provider/model handled each pass and what resources did it use? | Session totals and adapter return values are incomplete per-call evidence. | Retain pass/run IDs, provider/model, outcome, duration, retry count and available usage. | Scoped Model Activity with prompt/response retention policy and explicit unknown cost. | ai-provider.js; codex-cli.js; reproduction-runner.js; AISession.js; case UI | Mock provider success/failure/retry/timeout; unavailable usage stays unknown; no live provider call. |
| O5: Is a saved worker alive, interrupted or unable to scan? | Worker maps/last scanner error are process memory. | Durable last-start/last-progress/result evidence tied to saved execution request. | Runtime panel combining queue, leases, storage readiness and last successful scan. | business-execution-service.js; generation-engine.js; server.js | Isolated process/lease expiry and scanner failure; no persistent-service restart. |
| O6: What failed in the browser or an unhandled server path? | Toasts and console output do not form a durable incident trail. | Safe bounded incident records with request reference and error category. | Diagnostics UI, filters and sanitized export. | errorHandler.js; app.js; frontend error boundary/API client; diagnostic modules | Controlled client/server errors; no stack, body or credential leakage; repeated failures bounded. |
| O7: Is all history believable, profitable and reconciled? | Record presence, four arithmetic checks and pretax revenue equality do not establish those broader outcomes. | Independent business expectation checks and explicit manual reconciliation evidence. | Linked period-quality and critical report acceptance covering opening state, COGS, cash, tax and dimensions. | business-period-evidence.js; financial-summary; coverage; Company | Deliberate false-positive reports and unmatched balances fail; manual vs API evidence remains distinct. |

## Recommended client-visible paths

Keep Company → Business operations as the authoritative progress/recovery surface, with a link from each operation to its plan, receipts and report proof. History should support request and operation references. Settings → Diagnostics should show storage/worker/provider readiness and sanitized recent failures; Model Activity should show per-pass provider evidence. Reports and reconciliation should show named checks and manual evidence separately from feature presence.

## Prioritized fix plan

1. Retain O1 terminal-only attribution and receipt/barrier guarantees; add supported request correlation for future operations without retroactively asserting identity for older failures.
2. Join request IDs and controlled recovery explanations across the app (O2/O6).
3. Close auth/key accountability and exposure gaps (O3), then retain worker and provider evidence (O4/O5).
4. Complete original-business acceptance rather than interpreting narrow accounting checks as realism (O7).

## Verification checklist

- [x] Source-only scan restricted to backend/src and frontend/src code/resources; private .env, token files, artifacts and tool history excluded by wrapper.
- [x] Inspect original source around high-signal matches; do not use scanner counts as product completion evidence.
- [x] Use isolated transport/storage fixtures for source → saved records → reports → calendar and recovery paths.
- [x] Confirm current final backend/build/lint/desktop results in the implementation ledger (1009/1009 backend, syntax 147 files, build/lint and both desktop workflows; artifacts/luna/intent-governance-final-2.json).
- [x] Verify terminal-only exact-ID owner attribution, rollback, scope/ownership denial, later graph/tax continuation and rendered desktop review: full backend 1024/1024; focused 115/115; syntax/build/lint/two desktop workflows passed.
- [ ] Add request trace, auth/key event and durable incident checks as each remaining gap is implemented.
- [ ] Verify provider evidence through mocks before any separately approved provider check.
- [ ] Verify approved production records/reports only under a concrete target/budget/stop-condition approval. No live mutation or service control is authorized by this document.
