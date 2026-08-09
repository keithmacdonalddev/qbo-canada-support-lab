# Rebuild Phase 3 foundation

**Status:** Initial read-only foundation implemented; Phase 3 gate remains open
**As of:** 2026-08-09
**Live impact:** None. No server, OAuth flow, QBO request, or database migration was run.

## What exists now

The first Phase 3 slice establishes server-owned context and definition contracts without creating a QBO write path:

- `GET /api/context` derives the active realm and company from the authenticated user's server-side connection. Client-supplied realm, company, or environment fields are rejected.
- `GET /api/capabilities`, `GET /api/capabilities/operation-matrix`, and `GET /api/reports` expose the validated static catalog with bounded filters and pagination.
- `GET /api/blueprints/proposal` and `GET /api/volume-profiles` expose the owner-approved direction/planning targets together with their unresolved proposal limits; neither endpoint saves, publishes, schedules, or activates anything.
- `CompanyMembership` is an additive realm-membership model with four proposed roles and known permission names.
- `BlueprintVersion` is an additive draft/version model with a pure validation foundation. There is no blueprint write route yet.
- Every new endpoint requires authentication and a server-evaluated read permission. Legacy `agent` and `supervisor` users receive read-only compatibility permissions until an explicit membership exists.
- Request IDs are validated or generated server-side, returned in `X-Request-Id`, and included in new error contracts.
- Legacy AI plan execution and issue-pack execution are denied by default before their handlers can reach QBO.
- Importing `server.js` no longer starts the backend. Legacy issue-pack seeding and stale-run rewrites are also off by default when the backend is explicitly started.

The static definition service reads only committed files under `docs/discovery/`. Its response contract contains catalog data and hashes, not tokens, provider keys, authorization headers, or connection credentials.

## Server-owned feature flags

| Environment variable | Default | Effect |
| --- | --- | --- |
| `REBUILD_READ_ONLY_ENABLED` | `true` | Enables authenticated read-only rebuild context/definition routes |
| `LEGACY_AI_MUTATIONS_ENABLED` | `false` | Allows the legacy AI plan-execution route to proceed to its existing Production confirmation and handler |
| `LEGACY_ISSUEPACK_MUTATIONS_ENABLED` | `false` | Allows legacy issue-pack execution to proceed to its existing Production confirmation and handler |
| `LEGACY_STARTUP_MAINTENANCE_ENABLED` | `false` | Re-enables built-in issue-pack seeding and stale legacy run/plan rewrites during explicit backend startup |

These flags are server configuration, not client authority. Enabling a legacy mutation flag does not bypass authentication, Production confirmation, QBO error handling, or the user's requirement for explicit live-operation approval.

## Membership migration plan

The migration is additive and has not been executed:

1. Create no records automatically at startup.
2. Produce a dry-run projection from each legacy user's active connection and role: `supervisor` proposes `lab-owner`; `agent` proposes `support-agent`.
3. Detect and stop on duplicate or conflicting user/realm authority. Do not choose a winner automatically.
4. Present the proposed membership set and exact realm/company to the lab owner.
5. After separate database authorization, insert memberships in a bounded migration with an export of proposed records and created IDs.
6. Verify read permissions, then remove the read-only legacy-role bridge only after every active user has an accepted membership.
7. Rollback by retiring only the created membership records. Existing users, connections, QBO records, audit entries, and legacy runs remain untouched.

Until that migration is approved, the compatibility bridge grants read permissions only. It cannot authorize a new mutation.

## Connection ownership and encryption decision

The target remains one realm-owned flagship connection plus memberships. The existing `Connection` records are still user/realm scoped and contain legacy plaintext token fields, so this slice deliberately does not copy or rename them.

Before a realm-owned credential model is created, Phase 3 still must approve:

- an encryption-at-rest mechanism and key-rotation/recovery owner;
- a token migration that never logs plaintext and can detect conflicting connections for one realm;
- who may refresh, reconnect, disconnect, or view safe connection metadata;
- how a failed migration returns to the existing connection without losing access;
- retirement or secure migration of legacy user-supplied AI keys.

The read-only context query selects only `realmId`, company name, status, refresh time, and update time. It never selects or returns access or refresh tokens.

## Startup decision

Backend startup still connects to MongoDB because the current application requires it, but it no longer performs legacy business-data maintenance by default. The old issue-pack seed and stale-status rewrite block is retained behind `LEGACY_STARTUP_MAINTENANCE_ENABLED=true` for compatibility and recovery review. This avoids silently deleting legacy behavior while stopping incidental database writes in the normal default.

## What remains before Phase 3 can pass

- dry-run and owner review of the membership migration;
- the realm-owned encrypted connection design and reversible migration;
- authorization tests covering every existing and new mutation, not just the two experimental gates;
- blueprint draft/write/version routes with validation, audit, and permission rules;
- a complete sanitized audit/correlation contract across legacy routes;
- consistent validation/error envelopes across the older route families;
- explicit recovery semantics for legacy stale runs instead of rewriting all interrupted work as failed;
- owner acceptance of the startup and migration decisions.

No item in this document authorizes a QBO call, database migration, server start, or Production operation.
