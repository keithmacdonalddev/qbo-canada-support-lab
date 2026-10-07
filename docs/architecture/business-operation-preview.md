# Business operation preparation

Implemented 2026-10-06. Read-only preparation joins dated activity and proposed transaction details to fresh company setup and master-record observations. It neither persists an operation nor creates records.

The authenticated POST /api/company/business-plan/operation-preview accepts only the loaded connection, blueprint content hash and dates. It checks scope before reads and reloads the saved view afterwards. The limit is 31 days and 500 current steps. Account/tax and master reads use their existing bounded readers. Observations must be no more than five minutes old.

Each step carries its calendar fingerprint, separate detail hash, explicit observed references, current/prior dependencies and unresolved requirements. Canonical numeric record versions, including zero, are required for resolved references. Inactive, ambiguous, missing, incompatible or malformed records cannot pass. Canadian tax treatment remains review-required. Invoices and customer payments require the saved receivables account. Purchase orders, bills and bill payments require the saved payables account. Payment destinations and deposit sources require the saved undeposited-funds account where applicable. These are structurally checked exact choices and versions, not synthesized placeholder requirements. Blocked prerequisites propagate to dependent steps. Prior-period requirements contain only ancestors of current steps.

The operation fingerprint binds scope, saved blueprint, calendar, economics and exact observations. Preparation always reports readyToExecute=false and persisted=false. It does not establish record absence, baseline adoption, approved economics/tax, complete QBO payloads, line-level relationships, execution or business-period completion.

## Evidence

Forty-eight focused tests initially passed across the operation, draft, master and detail contracts; a malformed-version finding from both independent reviewers was then fixed. The focused operation/draft rerun passes 28 tests, backend syntax passes 89 files, and frontend build/lint pass with existing warnings. Both reviewers cleared the correction.

Read-only desktop inspection in the connected Canadian Production company for October 1–6 shows 55 planned steps, all unresolved, 48 distinct record choices needing resolution and 48 prior transactions needing evidence. Loading, expandable reasons and keyboard focus were observed. No plan was saved and no database or QBO record was changed.

Control-account follow-up (2026-10-06): 47 focused draft/mapping/operation/master tests pass, including old drafts, incorrect account types/detail types/currencies, missing versions and downstream blockers. Independent implementation and safety reviews found no blockers. The runtime operation remains read-only and requires separate full-record reference binding, approved policies and execution integration.

## Full reference definitions — 2026-10-06

The existing operation-preview route now binds complete QBO master definitions for users with current operations.preview and qbo_data.read authority. It uses the existing full GET reader and original QBO client, checks the authenticated actor/workspace through runtime access, and rechecks the saved blueprint after binding. Read-only viewers retain the structural preview. No operation approval, storage preparation or QBO write is added.

Resolved references retain definition version/hash from the full record; private master fields are not returned in the preview. Exact IDs and SyncTokens must still match the earlier structural observation. Duplicate entity/ID reads are shared across activities and aliases, with at most three concurrent reads, 250 distinct records, and a three-minute overall deadline. Disconnects before or during binding cancel further work. Late provider replies cannot produce an accepted preview. A provider GET already sent may finish after cancellation because the existing SDK transport does not expose cancellation.

Unresolved choices, Canadian tax review, baseline requirements and historical dependency blockers remain unchanged. The preview is still unapproved and unsaved. Historical dependencies must subsequently load their original saved intent/policy; regenerating past entries from current business settings is not acceptable.

Focused follow-up verification: 54 tests pass across full-definition preparation, existing operation previews, draft routes and runtime authority. Both changed backend modules pass syntax checks. Independent implementation and safety reviews are clear after correcting current workspace authorization, already-disconnected requests and the final version-check input. The route fixtures exercise the actual module/client composition with simulated provider responses; they do not establish live company readiness or Canadian provider acceptance.

## Saved-history integration — 2026-10-06

Preparation now checks current activity keys and direct prior dependencies through the original plan store before additional full reference reads. It follows the saved dependencies of earlier records, preserving their original fingerprints instead of substituting the current template. Full original intents/policies stay server-side; the public preview contains minimal provenance and hashes.

The preview distinguishes unavailable storage, no local history, incomplete earlier history, retained local evidence and work requiring resume/recovery. An existing current activity is a blocker even when its saved state says verified. Missing local history never proves a record absent from QBO; retained verification never proves its current contents. Baseline, policy, current readback and execution-readiness requirements remain. No route body can provide its own history, company, policy or approval.


Preparation also carries the exact saved blueprint ID, business key and opening date for [operation assembly](business-operation-candidate.md). These fields join the integrity hash; they do not activate the blueprint or change readiness.
