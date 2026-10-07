# Explicit business storage setup

Implemented 2026-10-06. Setup application never runs at startup or through a product route. Baseline capture uses the shared read-only completed-receipt validator. Applying it requires separate explicit approval of the concrete preview; a matching hash detects changes but is not authorization.

## Scope

scripts/rebuild/prepare-business-storage.cjs defaults to a read-only preview. It loads the existing local configuration without printing credentials. Required arguments are --environment, --realm-id, --connection-id and --owner-id. Application additionally requires --apply and --plan-hash. Invalid arguments fail before connecting; connections and sessions close on success or error.

The preview binds the actual database name and a replica deployment fingerprint, configured environment, exact active connection and owner, current legacy role and membership, collection/index definitions and permission change. The version-1 migration supports verified replica sets only. Ambiguous company ownership, existing non-owner roles, permission overrides, unsupported collection options, duplicates or conflicting indexes stop the migration without replacing anything.

The default `blueprint` profile retains the original version-1 contract and prepares only blueprintversions and blueprintsequences. Exact full realm/version uniqueness is required; partial, sparse, TTL, hidden and incompatible collation indexes do not qualify. Existing auditlogs and companymemberships with their full user/realm uniqueness must already exist.

An absent owner membership is explicitly proposed as lab-owner, including the exact permission list. Existing other members are untouched. Existing roles are never promoted, replaced or reactivated by this command. An already active owner may use the same preparation without a new grant.

## Complete initial operation storage

The explicit `--profile business-operations` option uses a separate version-2 reviewed hash. It adds the nine runtime collections to the two blueprint collections: companywritepolicies, companywriters, businesscalendars, operationruns, operationplans, operationintents, operationsteps, qbowritereceipts and operationevidences. Definitions are static and checked against actual model schemas in disconnected tests; preview never imports application models.

The preview identifies database-wide index scope, all exact definitions, the initial-empty requirement, existing legacy prerequisites, the owner membership grant if absent, scope-counter writes and audit writes. The legacy users, connections, companymemberships and auditlogs collections and their actual runtime indexes must already be compatible; this profile never repairs them. The physical operation record uniqueness index applies only to string qboId values. Its filter must match exactly and also scopes duplicate inspection.

This is an initial installation, not an upgrade of populated operation storage. All nine runtime collections must be empty across the database. Exact absence reads occur in preview, before audit intent, before every collection/index creation, after preparation and inside final completion. Any record or uncertain read stops further preparation. Existing blueprint drafts are permitted. There is no Policy/Writer/Calendar initializer in the current app, and the command creates no activation, calendar, operation, receipt or evidence rows. A completed receipt may subsequently be checked read-only after separately authorized operation initialization.

Do not run this initial setup concurrently with privileged initialization or deployment changes. Empty-state reads are not a database-wide lock. Populated-storage upgrades, and any future integration that can initialize runtime coordination, require a separately reviewed maintenance protocol before using this profile. The setup cannot be used to unblock existing pending work.

Old blueprint hashes/receipts never authorize the expanded profile. Profile/version/definition checks cover initial application, interrupted retries and both completed-receipt paths. Omitting the profile continues to mean blueprint only.

## Recovery and evidence

A deterministic, majority-written audit intent precedes additive DDL. It retains the bounded reviewed scope, definitions and permission change. An interrupted create/index step can be retried against the same plan when source authority remains unchanged. Exact completed additions are reused; nothing is dropped or weakened.

After preparation, the owner account, connection and any existing owner membership participate in transaction write conflicts through explicit scope counters. The owner account counter is shared with QBO connect/disconnect. Missing membership insertion and the completion audit commit together. A failed completion audit rolls back access and scope-counter changes; prepared empty storage and the intent remain as recovery evidence.

An already-completed retry verifies current storage and the exact created/existing owner membership before reporting current success. Changed authority or deployment requires a new review. No calendar cursor, business records, QBO requests, balance corrections, schedule or business activation is created.

If access must be withdrawn, review and retire only the membership identified in the completion receipt through an explicitly authorized administration action. Preserve audit history and inspect references before any separate storage removal. This command does not offer destructive rollback.

## Verification boundary

The setup/runtime-storage suites pass 26 disconnected tests, including actual model/schema parity and readiness after fixture preparation, profile approval isolation, exact partial indexes, legacy prerequisites, empty-state checks, interrupted recovery, source changes and completion drift. Both changed executable files pass syntax checks. Both independent implementation and safety source reviews are clear. A read-only preview against the configured My Busines production workspace found all 11 business collections missing, 17 indexes to add, compatible legacy prerequisites and an absent owner membership. It saved the concrete preview outside the repository; nothing was applied. Live preparation, transaction rollback and post-setup saving remain unverified until explicitly approved application and subsequent evidence checks run.

## Separate baseline observation storage — 2026-10-06

The explicit --profile baseline-observations option is version 3 and covers the two blueprint collections plus businessbaselines and its history index. It uses the same reviewed legacy prerequisites, explicit absent-owner membership grant, scope fences and audited additive setup. Initial setup requires only the added baseline collection to be empty database-wide; it does not create or inspect operation activation state. Default v1 and business-operations v2 definitions/hashes remain unchanged.

The baseline capture runtime additionally requires the exact completed v3 setup receipt, bound to target, deployment and definition. Index creation alone cannot start a capture during setup. Receipt checks do not create collections or grant access, and a missing receipt does not hide existing permitted observation history. The pending v2 preview/approval cannot authorize v3; no v3 live preview or application has run.

The expanded storage-setup suite passes 26 disconnected cases, including v3 schema parity, old-approval isolation, incomplete-setup capture prevention, additive retry and receipt tampering. See [business-baseline-observations.md](business-baseline-observations.md) for the combined evidence and remaining live limits.
