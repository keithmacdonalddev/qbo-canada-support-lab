# Job K: month-end close checklist

Prepared 2026-10-31. Local code only; no commits, storage preparation, service commands, QBO calls or live database writes.

## Result contract

The checklist keeps one append-only history for each connected-company, owner, month, account and check. New decisions retain the previous decision identifier, revision, evidence references and hashes, actor, timestamp, explanation, exceptions and an atomic audit record. Reopening or resolving an exception creates a new row. It does not edit the old one.

Read and mutation methods are exported from the governance service instance and from business-close-checklist.js:

- getCloseChecklist(user, { period: '2026-10' }) returns server scope, contextHash, month boundaries, items, available evidence, source limits, storage readiness and explicit assurance limits.
- recordCloseChecklistEvidence(user, input) records an accountant decision. Exact input keys: contextHash (from the read), period, accountId (company or the enumerated bank/card ID), checkKey, expectedRevision, requestKey (16–100 letters/digits/underscore/hyphen), disposition, evidenceReferences, note (20–4000 characters), attestation (null for tools).
- Each reference is exactly { kind, id, hash }; supported kinds are operation-evidence, business-baseline (an existing company-survey/opening observation) and business-event. Use the references returned by the read. No raw reports, caller-supplied pass flags, company overrides or external URLs are fetched.
- Dispositions: evidence, review, exception, reopen. Manual-attestation is forbidden by default for tool callers. Only the authenticated HTTP handler passes a trusted third option, { manualAttestation: true }; the current connected-company owner must also be the actor. It requires { confirmed: true, asOfDate: monthEnd, reference: explicitSupportingReference } plus the explanation. Future month-end attestations are refused. The app records the owner's statement, not independent verification.
- The trusted caller option also sets audit provenance: automated calls are ai_executed / aiDriven; HTTP form entries are manual. Request bodies cannot override this.

HTTP: GET /api/company/business-governance/close-checklist/:period and POST /api/company/business-governance/close-checklist/evidence. Authentication, active company authority, no-store responses, body/query override rejection and transactional access fencing reuse existing governance boundaries. contextHash prevents an old company form from writing into a newly selected company. No accountant tools were wired in Job X's files.

## Evidence meaning

Report checks are supported only by a hash- and audit-verified source covering the exact entire calendar month and recomputed report checks. Daily or shorter observations remain partial. One operation's complete planned record set does not establish company-wide record completeness; record outcomes and unresolved work require an explicit review. Other reviews retain the reviewer's assessment and full-month evidence. No automatic state claims company-wide completion.

Bank/card reconciliation is per account; tax filing/remittance, closing-date protection and physical count are manual items. Ledger arithmetic, report presence, a successful operation and calendar advancement never satisfy these items. Attaching evidence leaves manual work open until the owner's explicit attestation. Original records and report bodies remain in their existing stores; the checklist keeps references only. Saved source links and checklist audit hashes are checked again on read. Missing links cannot remain report-supported.

Evidence discovery is bounded: up to ten monthly operation observations, ten exact-month company surveys, ten recent period snapshots and twenty management decisions. Existing company surveys provide a monthly report path even when the business calendar advances daily. Limits are returned explicitly. This is not a complete evidence inventory. Bank/card rows come from retained account observations; unavailable account coverage is shown explicitly. Repeated references are evaluated once per read. Mutations inspect only the submitted references and, if needed, one account observation rather than scanning unrelated report history.

## Storage and deployment boundary

BusinessCloseChecklistEvidence has autoCreate:false and autoIndex:false; its unique index binds environment, realmId, connectionId, ownerId, period, accountId, checkKey and revision. New record and audit creation share the existing majority/snapshot Mongo transaction. There is no independent-write fallback. Model hooks reject updates and deletes.

Its write-readiness inspection is isolated from existing operation storage: loading this feature does not block the accountant's normal runtime. GET reads existing source evidence and any retained checklist history even if write indexes need preparation, with a visible storage warning. POST remains fail-closed until this collection and its declared index are explicitly prepared. No storage profile or collection/index was prepared or applied by this job. A later authorized deployment must prepare this additive model before durable checklist decisions are enabled.

## Outcome evidence

- Offline replay: four actual retained October 31 OperationEvidence rows and their audit records, captured read-only into ignored artifacts/job-k-close-checklist/october-private-replay.json. Source IDs: bff1f60d8a46f7bea646bbb2, 5224568516a3839bfec8df1c, 007cfec1dd2b9181412ac0a3, df009c0ae9332e33c48d88bc. Each covers October 31 only. Database grouping showed no full October 1–31 operation observation. The calendar snapshot was verified through October 30, which did not change any manual state.
- Same-path replay invokes production getCloseChecklist and recordCloseChecklistEvidence with read-only-captured source/audit documents and in-memory transactional write adapters. All four real sources validate; monthly support remains partial and bank/tax/closing-date checks remain open. No live write adapter or QBO client is used.
- Final saved-source run from backend/: node --require ../artifacts/job-k-close-checklist/final-replay-preload.cjs --test test/business-close-checklist.test.js (preload path is absolute in execution): 14 passed, zero failures/skips, process exit 0. The private preload enables the stored-data replay; normal test runs skip only that optional private replay if its input is absent.
- Dedicated tests cover exact periods/scope, company switch, evidence/audit tampering, broken links, revision conflicts, idempotency, exceptions/reopening, rollback, write-readiness/history, owner attestations, automated-call refusal, source attribution, authenticated routes and append-only schema hooks.
- Distinct implementation and safety source reviews completed; all concrete findings were corrected and re-reviewed.
- Backend candidate syntax checks passed. Frontend build passed. Lint passed with existing AICommandCenter hook warnings; the checklist's new warning was corrected before final checks.
- The broader three-file governance run did not return a complete result within its bounded invocation; it is not counted passed. Its test-process cleanup could not be confirmed because Windows denied process ancestry inspection. No unrelated process or service was stopped, and no further broad rerun was launched.
- Browser approval rejected opening the isolated localhost preview. Rendered desktop interaction, live persistence and the live user workflow remain unverified. No alternative browser route was attempted.

The durable history foundation and offline evidence semantics are delivered locally. Actual monthly close, native reconciliation/filing/protection and enabled live checklist storage remain unverified and are not claimed.
