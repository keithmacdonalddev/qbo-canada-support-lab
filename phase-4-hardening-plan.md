# Phase 4 - Hardening, Polish, And Continuous Activity Plan

**Status:** Historical proposal — not implemented and superseded as the active roadmap
**Current product authority:** `continual-test-data-lab-rebuild-plan.md`
**Depends on:** Phase 1-3 source surfaces verified against a real intended sandbox/test setup
**Phase objective:** Make the QBO Support Lab reliable enough for repeated daily internal support use.

---

## 1. Purpose

Phase 4 is not a new feature expansion phase. It is the hardening phase that turns the existing foundation, inspection, issue-pack, and AI surfaces into a dependable day-to-day support tool.

The phase should start from real verification results, not assumptions. Phase 1-3 code exists, but the app still needs fresh runtime, QBO-connected, AI, lint, and dependency verification before Phase 4 scope should be locked.

---

## 2. Entry Criteria

Do not start Phase 4 implementation until these are true:

- Phase 1 setup flow verified: sign in -> connect QBO -> assess/profile -> seed -> dashboard -> audit.
- Phase 2 inspection flow verified: generate history -> create checkpoint -> run issue pack -> diff -> inspect entity/chain -> audit.
- Phase 3 AI flow verified: configure key -> chat/session -> propose plan -> approve/reject -> execute approved plan -> stream status -> generate support note -> audit.
- Frontend lint debt is either fixed or intentionally ticketed.
- Production dependency audit findings are triaged, with security fixes planned or applied.
- QBO mutation safety review has been completed for seed, generation, issue packs, checkpoints, and AI write tools.

---

## 3. In Scope

### 3.1 Must-Fix Hardening

Already underway on branch `fix/qbo-client-error-handling` (committed, not yet merged to main):

- QBO upstream error handling hardened. The QBO client captures the Intuit `intuit_tid` trace id (`getLastIntuitTid()`; attached to thrown errors) and uses status-based error handling: 429 is retried with exponential backoff (clamped to 60s/attempt, max 5 retries); other 4xx/5xx throw errors carrying `err.status`, `err.intuit_tid`, and the QBO Fault message.
- New `backend/src/modules/qbo-error.js` (`isQboError` / `respondQboError`) maps QBO upstream errors to HTTP 502, passing 429 through as 429, and returns `{ error, intuit_tid, qboStatus }`. It deliberately does not emit a QBO-side 401 as an app-level 401, because the frontend treats any 401 as session expiry and force-logs-out. Wired into the ai, checkpoint, company, and explore routes; seed, generate, and issuepacks were intentionally left unchanged because they run QBO in fire-and-forget background jobs surfaced via their own status/log endpoints.
- Frontend error surfacing hardened with new `components/ui/toast.jsx` and `alert.jsx`: silent load failures now show an inline Alert with retry, and plan approve/reject/execute failures raise a toast.
- Verified live (sandbox HTTP 200/400/401) plus offline unit checks; passed implementation review (a HIGH 5xx-status finding and a MEDIUM backoff finding were fixed).

Remaining must-fix hardening:

- Fix frontend lint errors and hook dependency warnings.
- Address production dependency audit findings, especially high-severity Axios advisories and the Anthropic SDK advisory.
- Verify backend startup side effects are intentional and documented.
- Confirm all mutating routes require auth and active company/realm scope.
- Confirm all mutations write audit entries.
- Confirm stored user AI keys, QBO tokens, JWTs, and OAuth payloads are never exposed in logs, frontend state, docs, or API responses.
- Decide whether BullMQ/Redis is truly part of the runtime strategy or should be removed/deferred.

### 3.2 UX Polish

- Clarify dashboard state: connection, seed status, generation status, active issue packs, last activity, and freshness.
- Improve empty/error/loading states across dashboard, explorer, checkpoints, issue packs, audit, settings, and AI command center. (Initial error surfacing — inline Alert with retry, toast on plan action failures — landed on the `fix/qbo-client-error-handling` branch; extend the same pattern to the remaining pages.)
- Make plan approval and issue-pack execution screens clear about what will mutate the connected company.
- Make checkpoint/diff workflows easier to scan.
- Tighten copy so support users understand what happened and what to do next.

### 3.3 Performance And Scale

- Test entity explorer, checkpoint creation, checkpoint diff, and audit/timeline views against larger entity sets.
- Add pagination or limits where large QBO responses can make screens slow.
- Reduce unnecessary refetching in frontend pages.
- Keep AI session history bounded so long conversations do not degrade the UI or model context.

### 3.4 Supervisor Features

- Define final agent vs supervisor permissions.
- Keep cross-user QBO company visibility out of MVP unless explicitly approved.
- Allow broader platform-level audit visibility only when it does not expose another user's QBO company data.
- Defer full custom issue-pack authoring unless early users clearly need it.
- Consider supervisor-managed settings for guarded AI auto-execution only after confirmed execution has earned trust.

### 3.5 Optional Continuous Activity

Continuous activity is optional and should be built only after the core manual flows are trusted.

If implemented, it must be:

- opt-in per connected company
- easy to pause and disable
- visibly scoped to the active sandbox/test company
- rate-limited and scheduled
- checkpoint-visible before/after meaningful activity
- fully auditable
- conservative in volume
- transparent about what it created or changed

---

## 4. Out Of Scope

- Payroll workflows
- Multi-company-per-user support
- Commercial packaging
- QBOA-specific workflows
- Scenario marketplace/sharing
- Training or challenge mode
- True restore/rollback of QBO company state
- Unrestricted autonomous AI writes

---

## 5. Safety Constraints

- QBO deletion/destructive behavior remains out of scope unless separately approved.
- AI must not call raw QBO APIs directly.
- AI write tools must stay behind plan review and explicit approval.
- Continuous activity must never run by default.
- Every background or scheduled mutation must be visible in audit history.
- Any live verification must name the target environment/company before it runs.
- `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, Anthropic keys, OpenAI keys, raw Authorization headers, and stored user keys must never be printed or committed.

---

## 6. Workstreams

### Workstream A - Verification Baseline

- Re-run non-mutating checks.
- Run Phase 1 acceptance test.
- Run Phase 2 acceptance test.
- Run Phase 3 acceptance test.
- Record defects and evidence in this file or a dedicated verification report.

### Workstream B - Reliability And Security

- Fix lint.
- Upgrade vulnerable dependencies.
- Review auth and route guards.
- Review audit coverage.
- Review secret/key handling.
- Review backend startup behavior.

### Workstream C - Product Polish

- Improve UI states and copy.
- Make mutation warnings clear.
- Improve support-note usefulness.
- Improve diff/entity scanning.
- Refine settings and key-configuration UX.

### Workstream D - Supervisor And Operations

- Define supervisor boundaries.
- Decide audit visibility rules.
- Decide whether custom issue packs stay deferred.
- Decide whether guarded AI auto-execution remains out of MVP.

### Workstream E - Continuous Activity Decision

- Decide whether early users need automatic freshness.
- If yes, design a minimal opt-in scheduler.
- If no, keep manual generation and issue packs as the freshness path.

---

## 7. Suggested Backlog Order

1. Fix lint and dependency audit findings.
2. Verify Phase 1-3 acceptance flows and record defects.
3. Patch blockers from acceptance testing.
4. Tighten QBO mutation warnings and audit visibility.
5. Improve dashboard and AI command center clarity.
6. Add performance limits/pagination where needed.
7. Define supervisor permissions.
8. Decide whether continuous activity is needed for MVP.
9. If approved, build continuous activity as a small opt-in feature behind clear settings and audit logs.

---

## 8. Exit Criteria

Phase 4 is complete only when:

- Early internal users can use the app repeatedly without engineering help.
- Phase 1-3 acceptance tests pass against the intended sandbox/test setup.
- Known high-priority lint, dependency, auth, secret, and QBO mutation risks are resolved or explicitly accepted.
- Dashboard status is understandable without reading terminal logs.
- Support notes and AI explanations cite concrete evidence from the app.
- Every manual, AI-driven, or scheduled mutation is auditable.
- Continuous activity, if shipped, is opt-in, scoped, observable, and easy to stop.

---

## 9. Current Known Inputs

Current non-mutating verification from 2026-05-28:

- Frontend build passes.
- Backend syntax check passes.
- Frontend lint fails on AI UI lint debt.
- Production dependency audit reports 14 vulnerabilities: 2 high and 12 moderate.

Milestones and in-flight work as of 2026-05-28:

- Production API access is unlocked AND a REAL production QBO Advanced Canada company is now CONNECTED (2026-05-28). `.env` is `QBO_ENVIRONMENT=production`; the production OAuth redirect URI is an ngrok reserved domain fronting the local backend (port 3001) for the callback only — frontend stays on localhost:5173, no code change. Tunnel only needed during connect/reconnect.
- QBO upstream error-handling hardening is MERGED to `main` via PR #1 (2026-05-28) — see section 3.1.
- Dashboard split (2026-05-28, uncommitted): the do-everything Dashboard is now read-only "awareness" (identity + PRODUCTION/SANDBOX badge, live read-only snapshot counts via `GET /company/snapshot`, lab footprint, jump-offs). Write actions (seed/generate/issue-pack run) moved to a new `/lab` "Lab Tools" page. A production guard (`backend/src/middleware/productionGuard.js` `requireProductionConfirm`) sits before those three write handlers and returns HTTP 412 unless the request body carries `confirmProduction: true`; the frontend `ProductionGuardDialog` collects that intent (checkbox + typed "PRODUCTION") only when `environment === 'production'`. Guard is a no-op in sandbox. Reviewed by both safety + implementation reviewers. Known follow-ups: the guard is NOT applied to AI plan-execution writes (they have their own approval flow — consider extending), and it fails open if `QBO_ENVIRONMENT` is misconfigured to non-production while a real company is connected.
- Multicurrency support (foreign-currency accounts, revaluation, balance-sheet FX) is planned, not built. It remains a candidate for a future phase, not Phase 4 scope.
