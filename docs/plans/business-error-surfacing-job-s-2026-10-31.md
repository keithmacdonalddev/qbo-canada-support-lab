# Business error surfacing — Job S (2026-10-31)

Delivered: one bounded, redacted errorDetail record with code, message, failing check/function/source location, operation/step/entity/record identity and explicitly supplied business detail. Preserved R3 reference-witness resolution, safe execution diagnostics and blocked/waiting Live states.

The same diagnostic travels through executionRequest.result, run state, step evidence, deferred verification, tool results, transcript outcomes, Live feed items, accountant context, work lists and build lists. Definition comparisons show authenticated approved/current field values when the original record is available; a hash alone is explicitly insufficient. Tax and verification refusals retain rates, dates and expected/observed versions.

Saved progress, independent of lease renewal, is checked against a strict greater-than-15-minute threshold. Failures group by diagnostic fingerprint with count and first/last times. One execution request is one occurrence across release and settlement. The existing monitored-agent worker creates one scoped attention event and one high-priority build request per overdue group, refreshing their evidence. No additional timer/service was installed. Resolved blockers leave the current synthetic build list; attention events remain historical evidence.

GET /api/company/business-agent/blockers is authenticated, company/connection scoped, bounded, read-only, and marks unavailable/truncated reads. Diagnostic failures do not interrupt accounting monitoring. Historical steps of retired/stopped runs are excluded except unresolved dispatched/unknown requests.

## Changed files

- backend/src/modules/business-error-detail.js
- backend/src/modules/business-run-state.js
- backend/src/modules/business-operation-runner.js
- backend/src/modules/business-execution-service.js
- backend/src/modules/business-dispatch.js
- backend/src/models/OperationRun.js
- backend/src/models/OperationStep.js
- backend/src/models/GeneralWriteRun.js
- backend/src/modules/business-step-store.js
- backend/src/modules/business-agent-engine.js
- backend/src/modules/business-governance-service.js
- backend/src/modules/business-compilation-runtime.js
- backend/src/modules/business-tax-policy.js
- backend/src/modules/business-reference.js
- backend/src/modules/business-readback.js
- backend/src/modules/business-graph-readback.js
- backend/src/modules/business-verification-runtime.js
- backend/src/modules/general-write-service.js
- backend/src/modules/business-agent-service.js
- backend/src/modules/business-agent-work.js
- backend/src/routes/business-agent.js
- backend/src/models/BusinessAgent.js
- backend/src/modules/business-management-review.js
- backend/src/modules/business-agent-live.js
- backend/src/modules/business-agent-tools.js
- backend/src/modules/business-blocker-inspection.js
- backend/test/business-error-detail.test.js
- docs/plans/business-error-surfacing-job-s-2026-10-31.md

## Verification and limits

- 449 affected tests passed in 22 files: 436 on actual saved source in 21 files; 13 governance service tests passed against byte-identical staged source (144.6 seconds). Unchanged governance source was compared after save; the long test was not repeated.
- 19 new regressions cover redaction/bounds, locations, authenticated definition diffs, tax evidence, unchanged propagation, deferred checks, settlement, recurrence/occurrences, stalled progress, scoped reads, alert/build grouping, build context, Live state, route, Q inspectBlocker propagation and 20 near-limit inspection errors. The inspector preserves primary errors unchanged and explicitly reports omitted later step details if its 85KB response budget is reached.
- Command per file: node --test --test-isolation=none --test-force-exit backend/test/<affected-file>.test.js. Staged runs added a Temp-only require loader substituting prepared source text. All final checks exited 0, with no cancellation. Force-exit closes retained test-only handles after completion; no app service was managed.
- All 26 changed source files passed node --check. The main 25-file locked save burst was 21:41:28.416Z–21:41:28.454Z (once per file). Q inspection landed late and received an additive projection, followed by a reviewed 85KB response-budget correction (two further locked saves of that file). Actual source matched tested drafts after verification.
- Earlier broad runs timed out and were not counted as passes. An intermediate graph assertion caught an altered legacy error code, which was reverted. Sandbox taskkill denied cleanup of the exact tracked test process; no unrelated process was targeted. That tracked run subsequently closed normally. Final per-file checks all exited normally.
- Distinct read-only implementation/safety reviews found no remaining blockers after corrections, including authenticating approved values before showing differences.
- No live QBO/provider calls, MongoDB reads/writes, services, commits or pushes. No frontend changes; frontend build/lint and rendered UI checks do not apply to this slice. Live production behavior/rendering remains unverified.

## Work-value ledger

- 21:18:16Z coordination checkpoint: essential error visibility work. Smallest proof: synthetic mismatch retained through run/step/tool/feed, overdue grouping, scoped endpoint. Next milestone: tested drafts before source saves.
- Review checkpoint: corrected trust/bounds, per-root identity, deferred propagation, active-operation filtering, nonfatal diagnostics, build projection and duplicate occurrences. Continued essential work; no optional scope.
- Concurrent integration: preserved R3 source and added regression for wrong supplied witness followed by authenticated retained baseline.
- 21:41:28Z delivery: all affected files passed; 25 source saves in 38 ms. Final actual-source tests/equality passed. Live outcome remains unverified within the no-live-action boundary.

Final integration checkpoint: Q/R3 integration and new diagnostic regressions pass 39/39 against actual source. Primary run/first-step diagnostics survive inspection response trimming. Implementation review of the budget correction is clear. Total source saves 27 across 26 source files; all locks released. Changes intentionally remain local/untracked as requested.

Formatting note: a manual check found a trailing space in the new helper. It is nonfunctional and was left to avoid another live backend reload; tracked-file git diff --check passed.
