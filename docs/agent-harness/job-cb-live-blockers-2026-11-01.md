# CB live blockers — 2026-11-01

Scope: source/test correction on main; no commits, service commands, QBO calls, or MongoDB writes. Database inspection was read-only. Six backend source files were saved together at 2026-11-01T10:07:08.497Z, after the isolated complete suite passed at 10:06:50 UTC.

## Direct evidence

- General run 70232034689a65d4353384fd: Payment against Invoice11020; 26 identical admission refusals. Replay captures1198 (local guard) and1197 (fresh period proof), 09:43:27 UTC. Removing only FreeFormAddress:false from the captured mirror exactly reproduces the retained fresh recordHash. Balance remains CAD226.86. The original service.guardBatch reproduces the failure; the candidate uses the same guards and protected-period code and accepts the equivalent default while refusing changed balance, customer, accounting date, or unknown fields.
- General run e3ce4f4f532bc73509ed150e: Vendor31 update; 29 identical refusals, captures1201/1200 at09:43:28UTC. The fresh raw Vendor response was not retained; its exact differing field is unknown. No new equivalence for an unknown field was introduced. The retained run replays safely to audited unsent retirement.
- Neither run has a QboWriteReceipt. Both retained sending batches have sends:0 and no transport. The private offline replay retires both without reaching transport; this is not a production database change.
- Nightly A/R: QBO81362.86 vs known mirror80458.29. Purchases354/385 debit A/R by500+1000. Payments383/455/543 apply500+75.65+19.78 against Purchase385. Residual904.57 exactly explains the gap. Current replay is85637.86; five new invoices11237–11241 after the nightly report add4275.00, bringing its prior snapshot back to81362.86.
- Nightly A/P: QBO11098.46 vs known mirror11018.81. Deposits446/452 add300+44. BillPayment561 has USD195.06 unapplied (1100 less904.94) at stored ExchangeRate1.3552454 = CAD264.35. Net difference79.65. BillPayment445's Deposit381 and Purchase379/380 applications cancel their original1250 debit/credit effects. RefundReceipts319/330/544 and item-based purchases are ordinary cash postings, proven through native account roles, with zero A/R/A/P effect.

## Change

Bound a semantic fingerprint (existing qbo-semantic-compare rules) into protected-period evidence. It normalizes known presentation defaults and metadata while retaining balance, identity, dates, lines and unknown fields. Real drift requests re-planning. Exact target version and unknown-outcome replay gates stay enforced.

Retire a definitely-unsent run after three identical existing diagnostic fingerprints, or immediately on fresh linked-record drift. Admission receipts/writer claims/unknown outcomes prevent retirement. Mixed runs retain accepted records and receipt identities and audit only the unsent remainder; explicit replan-remaining instructions prevent recreating accepted records. Retired work releases the accountant's daily reservations.

Compare aging against remaining native direct postings and explicit applications, native cash/refund account roles, and exact foreign unapplied conversion. Missing/ambiguous/reversed-credit evidence remains unverified. Read exactly the required mirror dependencies/fields, including Payment for payable linked deposits, and invalidate the previous nightly comparison basis for a fresh automatic comparison.

## Verification

Private stored replay:27 pass,0 fail, using actual service.guardBatch/readWritePeriodEvidence/assertWritePeriod and agingEntities/readAmountMirror/agingMirrorTotal with strict projection. Raw stored inputs stay in the private Temp scratch directory, outside tracked repository files. Focused predecessor:136 pass,0 fail. Complete candidate suite: 2,972 pass, 7 skipped, 0 fail (2,979 total), exit 0; 238 explicit test files from backend/, with the scratch overlay. The initial run inherited the read-only inspection dotenv settings and had 55 configuration-related failures; all affected files passed after child-only environment isolation (121 pass, 2 skipped), then the entire suite passed. No application configuration was changed.

After the single source batch, the saved-source affected run passed 170/170 with exit 0 and no overlay; the private real-data replay run passed 27/27 with exit 0 and no overlay. Saved file bytes were checked against the full-suite candidate. All six source files passed node --check, and git diff --check passed.

Commands (from backend/, launched through hidden Node child processes):
- Full: node --require <private-scratch>/clean-env.cjs --require <private-scratch>/overlay.cjs --test <all 238 test/*.test.js files>.
- Saved source: node --require <private-scratch>/clean-env.cjs --test test/business-agent-sync.test.js test/general-write-gate.test.js test/general-write-service.test.js test/job-cb-live-blockers.test.js test/business-agent-store.test.js.
- Stored replay: node --require <private-scratch>/clean-env.cjs --test <private-scratch>/private-replay.test.cjs.

The clean-env preload only removes variables loaded by the read-only inspection from isolated test children. Persistent services and their configuration were untouched.

Independent implementation and safety reviews: no remaining findings after fixing linked Payment dependency, Purchase.Credit projection, exact fingerprint cap, mixed saved/unsent preservation, and dispatch-toggle reopening. Live QBO collection, production retirement, and tonight's comparison remain unverified; no live checks were authorized.

## Owned files (all intentionally uncommitted)

- backend/src/modules/general-write-service.js
- backend/src/modules/general-write-unsent.js
- backend/src/modules/qbo-write-period.js
- backend/src/modules/business-agent-reconciliation.js
- backend/src/modules/business-agent-sync.js
- backend/src/modules/business-agent-store.js
- backend/test/general-write-gate.test.js
- backend/test/business-agent-sync.test.js
- backend/test/job-cb-live-blockers.test.js (new)
- docs/agent-harness/job-cb-live-blockers-2026-11-01.md (this evidence note)

Private evidence/logs: C:/Users/NewAdmin/AppData/Local/Temp/qbo-cb-20261101/. No raw company records were added to tracked files. Locks were released. No commit or push was performed, per the current job instruction.
