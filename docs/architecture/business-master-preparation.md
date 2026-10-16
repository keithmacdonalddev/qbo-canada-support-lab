# Business master preparation

Status: private planning, owner decisions, transport, worker, no-effect/accepted-ID recovery and atomic draft application implemented non-live, 2026-10-15; terminal-unknown owner attribution and authenticated public service/routes are implemented; the normal Company UI is implemented and verified in isolated desktop scenarios. This document records the reviewed boundary and non-live proof; it does not establish live records or whole-product completion.

The normal business setup requires exact accounts, customers, suppliers, products and a time-entry worker. It now offers explicit missing-record preparation alongside selection of existing records. The legacy seeder creates an unrelated population and cannot satisfy this outcome. The intended result is an owner action on Company: prepare the missing roles for the saved business, review the exact proposed creates, execute that approved plan, then explicitly use verified IDs in a new draft. Publication and financial baseline acceptance remain separate actions.

## Authority and prerequisites

Preparation derives from one exact saved contract-v2 draft and complete fresh CA/CAD company, setup and active/inactive master evidence. Invalid existing choices block; they are not silently replaced. Ordinary Bank/Income/Expense/Inventory-asset/COGS accounts may be prepared. AR/AP, Undeposited Funds, Canadian tax and system preferences need explicit compatible existing selections. No workflow silently enables inventory, changes preferences or protection, supplies opening balances, edits existing records or sends messages.

Inventory needs confirmed quantity tracking and a separately displayed elapsed Halifax InvStartDate compatible with the first planned stock activity and current protected dates. Opening quantity is exactly zero. A protected or unsupported date is a blocker before unrelated parties/accounts are created; it is never moved forward to obtain a passing check. Parent account IDs, active/type/currency fields and feature availability are reread before dependent creates. Accepted IDs alone do not establish compatibility.

## Storage and duplicate prevention

Use a dedicated typed MasterPreparationRun with a bounded immutable hashed plan, embedded ordinal/attempt history, exact scope/owner/draft, approval, worker lease/stop, per-record receipts and local apply/close decisions. A separate explicit additive master-preparation storage contract prepares its collection/indexes and audits its target. Existing continual-business v4 definitions, hashes, setup receipts and initial-empty installation rules retain their meaning. No startup migration, incidental DDL or live preparation is authorized by this code task.

Hashed master plans and their original business snapshots preserve empty objects during Mongoose serialization. An empty source masterBindings object is part of the immutable plan, so dropping it cannot be treated as an equivalent stored representation. Real Mongoose insert/BSON round-trip tests exercise this boundary and the normal unchanged-draft fence.

A unique open claim per environment/company covers proposed, active, partial and completed-but-unapplied work. Refreshing or changing a draft cannot create another role set. Existing created IDs stay discoverable. A changed draft stops further dispatch; the owner can review verified IDs against the current draft, apply a compatible exact subset into a new version, or retain created records unassigned and retire only the proved-unsent tail. Every saved ID and attempt remains in origin/audit evidence when the claim closes. Uncertain or possibly-sent attempts retain both the company barrier and the claim.

## Dispatch and recovery

Master setup has its own prepublication gate branch; it cannot borrow published financial-operation authority or the reproduction permission. Current owner/account/membership, active company write policy, protected dates, exact approved plan, latest draft, stop/lease, ordinal and parent IDs are checked at admission. A real BlueprintSequence increment fences concurrent draft saves in the same transaction as the mandatory receipt and master attempt binding. An already admitted request may finish after a new draft is saved; every subsequent create must stop. A postcommit callback acknowledges a binding, never creates its only durable correlation.

The bounded preparation owns the company writer while creating records. Each accepted ID is retained transactionally with its mandatory transport result, then read back against an entity-specific projection before any dependent create or draft application. This is independent of later audit/UI acknowledgement. No name lookup grants ownership.

Recovery distinguishes: exact no-receipt/proved-unsent attempts; known accepted IDs; definite reviewed ValidationFault refusals with fresh attempt identities; terminal unknown outcomes needing exact-ID owner attribution; and possibly-sent requests without terminal evidence. The last state remains blocked. Absence, name matches or lease age never grant replay. Unknown attribution checks immutable payload/parent IDs, preplan complete ID inventory and all-company/environment creation ownership. Account, Item, Customer, Vendor and Employee use their own minimal projections; transaction markers and financial readback cannot be assumed. Stop never clears an uncertain barrier or undoes an admitted accounting request.

## Planned owner transitions

The open claim is distinct from the company writer. Preparing a proposal saves a local reviewed role set and holds the unique claim without sending QBO requests. Approval is exact and permits the bounded creates; each dispatch still needs a current owner, live worker lease, original latest draft and fresh setup evidence. Completed verified creation may release the writer while retaining the open claim until IDs are applied or explicitly retained unassigned. No startup scan or GET request invents a new approval.

A changed draft blocks subsequent creates. An owner can review an exact compatible subset of already verified IDs against the current draft. Applying that subset and its disposition writes one new immutable draft plus the run's apply receipt in the same transaction. Exact retries return the original saved version even if another later draft exists. Existing choices with different IDs are not silently overwritten. Unselected created IDs remain discoverable; closing retires only proved-unsent tails and preserves every accepted ID. A later plan must disclose previously retained IDs for unassigned roles and cannot automatically create a second set.

Stopping records intent immediately; it does not claim an admitted request has stopped. Metadata recovery and retaining records must remain possible while account automation is paused. A settled accepted ID may be retained unassigned even when fresh compatibility fails; it cannot be applied as a verified role. Unknown or possibly-sent work cannot be closed, reissued or released merely because a worker lease expired. Repeated attempts require an owner decision tied to the exact old no-effect evidence and a fresh identity; admission independently checks the old mandatory receipt or its company-wide reverse absence.

## Apply, visibility and proof

Using created IDs writes a new immutable draft and the exact preparation apply receipt in one transaction against the current base hash/sequence. Exact retries return that same version. Existing drafts, accepted baselines and published authorities are preserved. Changed mappings require fresh compatibility checks; saved records remain available for explicit selection instead of recreation.

Integrate this workflow explicitly into write-coordination quiescence, Explorer origin, cross-workflow ownership exclusions, retained automation review and Company recovery/status. Legacy SeedRun routes and startup rewrites keep their original domain. The UI must distinguish prepared, approved, saved, verified, uncertain and applied, and recover lost acknowledgements through current-state reads.

Safe proof: actual authenticated routes and transport gate with isolated storage and simulated SDK/readback; missing prerequisite, current owner/account, changed draft, duplicate submission, stop, restart/lease, lost acknowledgement, per-record persistence, rejection, unknown attribution and rollback cases. Demonstrate that newly prepared IDs pass the normal mapping/master validators and publication fixture. Run checks through verified gpt-6-luna/low and obtain distinct implementation/safety reviews; inspect rendered desktop decisions. Commit/push coherent owned changes on main → origin/main.

Live QBO creates, database preparation, paid providers, credential changes and persistent service control still require explicit target-specific approval. Non-live fixtures cannot establish live API capability or business realism.

## Primary API references

Intuit's [basic billing implementation](https://developer.intuit.com/app/developer/qbo/docs/develop/basic-implementations/basic-billing-implementation) requires referenced entities to exist before transactions. Its [official concepts sample](https://github.com/IntuitDeveloper/QBOConceptsTutorial-PHP/blob/master/LandingTheJob.php) demonstrates account references and inventory-item fields. The [Item API reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item) and [Employee schema reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippphpdevkitv3/entities/files/IPPEmployee.html) inform field validation; older SDK references do not certify current Canadian live capability. Direct entity documentation was partly unavailable through the text browser during research. Canadian behavior remains a live acceptance question until an explicitly approved run returns independent record/report evidence.

## Origin visibility

Account, Customer, Vendor and Item creation history in Records and captured-inventory comparison now includes minimal master-preparation evidence. Confirmed response, independent readback and owner identification of an original unknown outcome remain distinct. Missing mandatory audits/receipts or conflicting creation evidence stay incomplete. Retaining or applying IDs never erases this history or classifies the records as part of the business. Employee inspection remains outside the general Explorer and immutable inventory contracts; the time-entry worker’s minimal ID and receipt stay available in preparation history.


## Complete receipt snapshots (2026-10-16)

Actual Production preparation created and independently verified 51 master records before the next admission failed. Its 102 original transport audits crossed the default initial cursor batch. The installed MongoDB 6.20 driver inherited the native transaction deadline but sent an invalid maxTimeMS on non-awaitData getMore; the original caught error was retained privately rather than classified from the generic UI refusal.

The two bounded proof queries now request their complete count bounds in the initial batch. Their filters, 1,001-receipt overflow sentinel, three-second query limit, original transaction options and every receipt/audit assertion remain unchanged. This count choice does not guarantee arbitrary data fits MongoDB’s byte limit: lean() still consumes the whole cursor, and continuation failures propagate before admission. No partial snapshot or weaker fallback is accepted.

A scoped read-only integration used the original native transaction and full validator against the retained company state: all 51 receipts and 102 transport audits passed, totaling 204,156 BSON bytes, with zero QuickBooks calls or application writes. Private receipt: artifacts/goal-realization/company-native-master-snapshot-read-proof-result-20261016.json. New real-Mongoose query tests cover 100 records and 200 audits, late audit tampering/missing evidence, duplicate workflow receipts beyond record 100, the 1,001-history refusal and cursor failure propagation.

Verified gpt-6-luna/low focused checks passed 74/74 across snapshot, transport, store, recovery and runner tests, plus touched-test/source and company-wrapper syntax. The first new fixture used a plain session object that Mongoose cloned; using a real disconnected driver session preserves the strict identity assertion without any socket. Original failure and corrected receipts remain at artifacts/luna/goal-native-master-snapshot{,-corrected}-20261016.json. Distinct implementation/safety reviews found no remaining source blocker.
