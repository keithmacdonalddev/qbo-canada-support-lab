# Business operations in the Company page

Implemented 2026-10-06. The Company page contains a scoped, paginated list of saved operations with current progress and a separate detail read. The server returns exact company/connection scope and current execution permissions. The panel rejects mismatched scope, clears state on actor/company changes and disables actions while progress is unavailable.

Only retained approved operations can use Run or Continue. Stop is offered only for queued or owned runnable work. These controls call the durable execution routes; the browser does not create provider payloads, invent approval, prepare storage or select a different company. Existing permissions and receipts remain authoritative on every server call. A recorded verified status is distinguished from a detail read containing current completion evidence.

Page reads use 20-row cursor pages and a ten-second refresh; open details refresh every five seconds. Initial reads work in background tabs, subsequent polling pauses while hidden. Reads have bounded timeouts, cancel on replacement/unmount and cannot overwrite a newer action with stale progress. Inspect focuses its detail heading; Close returns focus to the originating button. Reduced-motion users receive a static loading icon.

Actions prevent simultaneous submissions. An uncertain execution acknowledgement retains its request key. If Continue confirms an old request that already settled, the helper reads current scoped operation/plan/permissions and can send one fresh-key continuation in the same click. It cannot repeatedly loop through new requests. Failed refreshes disable controls and preserve earlier visible list evidence. Response uncertainty is distinct from business completion.

## Direct evidence and limits

The actual existing Chrome Company page rendered the panel and its unavailable-storage state. It read the new backend route and reported unprepared operation storage; no operation was executed in the real company.

The development-only entry frontend/test/business-operations.html imports the real component with an injected mock API. Desktop inspection covered initial/empty/error/loading, read-only role, company mismatch, paginated records, Inspect/Close focus, Run/Stop, pending progress, stale refresh, lost acknowledgement and one-click continuation after a settled blocked request, plus current completion proof. Dark and light renders were inspected without horizontal document overflow at the current desktop width. This is fixture interaction evidence, not a production operation or live database restart test.

The fixture is a separate Vite development entry, excluded from the application's production build entry. It performs no authenticated backend or QuickBooks calls. It is not an acceptance shortcut for missing production storage, operation preparation/approval binding, company baseline/tax policy or real records/report outcomes.
