# RG2: retained decision evidence

Outcome: future write admission, dispatch settlement, general recovery, fixed graph read-back and fixed/general close decisions retain compact replay inputs. Historical gaps remain visible. No live storage preparation, QBO calls, MongoDB writes, service control, commits or pushes were performed by RG2.

## Storage profile

Use the existing governed additive routes with profile **replay-evidence** (definition version 7):

- POST /api/company/business-setup/storage/preview with {"profile":"replay-evidence"}.
- Review the returned target/changes, then POST /api/company/business-setup/storage/apply with that profile and its exact planHash.

These routes were not called. Capture skips unprepared storage, so this profile must be applied before durable evidence becomes available. Existing owner/connection scoping, continual-business setup prerequisites, reviewed plan hash and additive audit rules remain enforced. Existing records and business permissions are retained.

Collection: businessreplayevidences; model: BusinessReplayEvidence. TTL index on capturedAt expires rows after 2,592,000 seconds (30 days; Mongo's TTL sweep is asynchronous). The global ring contains at most 16,384 logical slots, each with at most 128 KiB of compressed body and 1 MiB before compression: at most 2 GiB of bodies, plus metadata/indexes. Slot replacement may evict evidence sooner than 30 days. This is an application-enforced logical cap, not a server disk quota.

No model auto-creation, index installation or command buffering is enabled. Detached persistence checks collection presence and the exact TTL before writing. Readiness is cached for 30 seconds: privileged concurrent removal of an already-prepared collection can race native upsert and recreate it without indexes. Storage removal while capture is running is outside this additive profile; the next readiness check skips unprepared storage. This retention limitation remains explicit.

## Capture and replay

The recorder retains arguments, exact consumed writer/calendar/list/reference versions and read-back/report bodies, query chains/cursor rows, adapter outcomes, clock calls, transaction attempts and asynchronous completion order. Transport captures additionally retain preflighted batch, replay proof and retained response state. Credential fields (including JSON bodies and common header/snake_case names) are redacted. Connection results are allowlisted to identity/status/fence fields. Dependency error messages are scrubbed before retention and only hashes reach CLI reports; if scrubbing changes an error input, that capture is omitted. No raw evidence is written by the CLI.

Capture uses a bounded 16-item asynchronous persistence queue. Serialization snapshots have shared node/byte budgets; gzip, storage inspection and persistence run after the decision returns. Capture errors/overflow are rate-limited fixed logs and never reject a business operation. Crashes, oversized decisions and queue saturation can lose evidence; they remain missing evidence.

Current hooks: business-transaction-compiler; qbo-write-gate begin/complete/failTransport/recoverGeneral/releaseUnsent; general-write-service guardBatch and correlated itemOutcomes; general-write-transport admission/period/classification/settlement; business-graph-readback; business-period-evidence; business-period-store finish; general-write-day-close. Hooks execute the same production functions during offline replay with recorded adapter results, never a provider send. Business decision boundaries such as guardBatch/transport are replayed independently as well as their outer gate.

The gate loads only captured rows associated with the selected operation IDs. It verifies compressed-body hashes, calls/arguments, query chains, consumed results, completion order and transcript exhaustion. An unchanged recorded refusal passes as the same refusal. Changed decisions or malformed evidence fail. Operations without evidence and absent boundaries are listed separately and do not fail. A passing gate is limited to retained decision coverage; fixed automatic unknown-outcome coverage searches and any uncaptured authority helper are not claimed as fully replayed.

## Direct evidence and work-value ledger

- 2026-11-01T03:43:29Z: essential replay-evidence implementation checkpoint; smallest proof: exact recorded decisions replay identically and a changed decision fails. All source was staged in scratch before one final backend batch.
- Read-only stored replay covered nine general-write batches, including unknown run 01b4f4b62cae18ccc27b617a. The live itemOutcomes function used the retained batch/response, with only scope/runId correlation metadata added. All nine matched on offline replay. The unknown run's body hash was 55c3b3bbec1759f98a664953a5d84d2e251e63fef79a8675bde18f6ddd111bb7.
- First current three-day dataset: 48 operations, no new durable captures. Advisory activity-choice check passed. Historical missing state was identified instead of guessed; the final gate result is recorded below.
- Independent implementation/safety review corrected boundary redaction, shared budgets, completion order, retry handling, full general admission capture, transport closure state, fixed close BSON access and partial coverage reporting.
- Verification: 13 focused new tests cover admission/settlement, unchanged refusals, changed/unused calls, full graph/cursors, real close, out-of-order reads, transaction retries, credential redaction, oversized/hung/failed capture and incomplete coverage. Existing affected suites and final CLI results are recorded below.

Live persistence, TTL expiry and generated future-company captures remain unverified because storage apply and live writes were not authorized.

Final pre-save verification: 277/277 affected tests passed across 14 files (20.72s). The last numeric MongoError replay refinement passed its focused conflict/refusal test. Staged real-data replay again matched all nine general batches; the three-day gate passed while listing 48 missing-evidence operations (capture hash e5a9bbfda214e737807060038311d6aa8c2266a6bb467b9bba8fc982b1721cc6).

## Saved-tree verification

- Backend source saved once in one locked batch at 2026-11-01T04:11:16Z; all locks released. Concurrent changes were preserved.
- From backend: node --test test/replay-evidence-rg2.test.js test/replay/replay-gate.test.cjs test/general-write-gate.test.js test/general-write-service.test.js test/general-write-recovery.test.js test/general-write-close-gate.test.js test/business-graph-readback.test.js test/business-transaction-compiler.test.js test/business-storage-setup.test.js test/business-setup-service.test.js test/business-setup-routes.test.js test/general-write-dated-sales-replay.test.js test/business-period-evidence.test.js test/business-period-store.test.js — 277 passed, 0 failed, exit 0 (26.44s), without the scratch overlay.
- node scripts/agent-harness/replay-gate.mjs --json — exit 0, passed true, 48 missing-evidence operations, 0 captured historical operations, 0 replay errors; sourceChanged false; 86.105s. No full historical replay claim.
- Code hash: 4cde65f348f8ecf52a63e5aef1c9ca1395cc9a29434c48b85de7b5d3cf5b629c; capture hash: 845e33dbdc69e87b1cd0263074ed3b7ec1793aa46df3eb016c46f8c634b45e6d.
- node --check on all 20 changed JS/CJS/MJS files and git diff --check passed. No live setup/TTL/persistence test was performed.
- 2026-11-01T04:13Z delivery checkpoint: code/evidence work complete within the authorized offline scope. Future durable capture waits for additive storage apply; historical gaps and uncaptured fixed automatic recovery remain explicit rather than consuming another investigation.

## Owned files

- backend/src/modules/business-replay-evidence.js
- backend/src/modules/qbo-write-gate.js
- backend/src/modules/business-graph-readback.js
- backend/src/modules/general-write-day-close.js
- backend/src/modules/general-write-recovery.js
- backend/src/models/BusinessReplayEvidence.js
- backend/src/modules/business-storage-setup.js
- backend/src/modules/general-write-guards.js
- backend/src/modules/general-write-service.js
- backend/src/modules/business-transaction-compiler.js
- backend/test/replay/loader.cjs
- backend/test/replay/captured.cjs
- backend/test/replay/harness.cjs
- scripts/agent-harness/replay-gate.mjs
- backend/test/replay-evidence-rg2.test.js
- backend/src/modules/general-write-transport.js
- backend/src/modules/business-setup-service.js
- backend/src/modules/business-period-store.js
- backend/src/modules/business-period-evidence.js
- backend/test/replay/runtime.cjs
- docs/agent-harness/REPLAY_GATE.md
- docs/plans/replay-evidence-job-rg2-2026-11-01.md
