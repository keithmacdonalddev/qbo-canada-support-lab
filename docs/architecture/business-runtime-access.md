# Current company access for business operations

Implemented 2026-10-06. This is a concrete internal authority/client adapter for the existing operation stores, reference readers and dispatcher. It does not add routes, grant membership, activate operations, prepare storage or change role permissions.

createBusinessRuntimeAccess binds actorId and ownerId from authenticated server context or a retained job. It ignores client-supplied roles and never uses a body/query scope override to select a workspace. Each authorize call reads current user identity, selected active owner connection and company membership. Shared actors are kept separate from workspace owners. If a shared actor gains its own active connection, the old shared workspace is rejected consistently with companyScope. The configured QBO environment and exact connection/realm must match.

## Existing permission mapping

| Internal action | Required existing permission |
| --- | --- |
| baseline.read | app_data.read, reports.read and blueprint.read |
| baseline.capture | reports.validate, blueprint.manage, qbo_data.read, app_data.read, reports.read and blueprint.read |
| operations.read | app_data.read and qbo_data.read |
| operations.preview | operations.preview and qbo_data.read |
| operations.execute, operations.record, operations.recover, operations.verify, operations.stop | operations.execute |

All actions except operations.read and baseline.read require explicit current company membership. Legacy owner roles retain only the existing read bridge. A suspended or retired membership denies access, including reads, rather than falling back to a legacy role. Shared access always requires active membership. Unknown roles/actions/permission overrides are rejected; omitted legacy override arrays remain compatible as empty arrays.

The adapter accepts an optional session and cancellation signal. Authorization queries are sequential within a transaction, bounded with maxTimeMS and projected to identity/access fields. The operation plan store passes its transaction in the common options envelope. These reads do not themselves lock authority against concurrent changes. The common write gate now fences both actor and owner User.connectionSwitchVersion in its business-admission transaction, using the same user documents as OAuth switching. It rejects a shared actor with a newly active own connection and requires the latest active owner connection to match. Membership is also fenced immediately before QBO admission. Activation approval still requires its current-state fence.

## Scoped QBO client

resolveClient first checks current read authority, then reads only the exact active connection document under its owner. Credentials go directly to the existing QBO client constructor and never enter authority results, errors or logs. Authority is reread after client construction, and the returned client must match connection, owner, realm, environment URL and active status. The constructor does not call QBO; later reads and writes retain their existing authorization and dispatch boundaries.

## Verification and limits

Focused tests cover owner and shared access, current role/override changes, revoked memberships, user removal, changed selected connections, environments, cancellation, transactional session propagation, token-read ordering and post-construction revocation. The dispatcher fixture also uses the actual membership adapter for its authorization boundary. The corrected gate/dispatch/access set passes 45 tests; operation-plan/access/dispatch checks passed 47 tests before the admission correction, and the existing permission/workspace regression set passes 15 tests. Backend syntax validation covers 107 files. These overlapping sets are isolated model fixtures, not live Mongo concurrency or QBO evidence.

Production composition still needs authenticated request/job actor binding, explicit prepared storage, active blueprint/baseline/policy, runtime observation and graph adapters, the operation runner and direct live acceptance. No membership or company records were changed by this implementation.


Verification composition (2026-10-06): [business-verification-runtime.md](business-verification-runtime.md) now connects this authority/client interface to full transaction reads and graph verification using original retained policy. Production activation and runner wiring remain separate unfinished work.

Baseline observations (2026-10-06): [business-baseline-observations.md](business-baseline-observations.md) adds separately authorized retained report capture. Its transaction fences actor/owner, connection and membership through businessObservationVersion. This does not widen operation verification or execution permissions.
