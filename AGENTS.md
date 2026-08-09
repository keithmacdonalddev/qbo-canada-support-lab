# AGENTS.md

> FOR OPENAI CODEX ONLY. Claude Code sessions should read `CLAUDE.md`, which imports this file and adds Claude-specific guidance.

## Project Identity

This repository is `C:\Projects\qbo`, Test Data Lab (the internal checkout and integration code still use `qbo`).

The product is a local control and visibility application for maintaining one flagship QuickBooks Online Advanced Canada company as a believable, continually evolving business. It defines the intended business, measures feature and report coverage, prepares coherent history, advances activity on a governed business calendar, and supports inspection, administration, reconciliation evidence, and manual support reproduction.

The practical mental model is:

`business blueprint -> coverage requirements -> controlled operations -> QBO records -> report and reconciliation evidence`

## User Communication

- Lead with the practical answer in plain English.
- Define unfamiliar technical terms inline and explain what they mean in this project.
- Separate what exists now from what is missing or optional, and say whether the user needs to do anything.
- The user is a self-taught solo developer. Technical language is useful when it teaches; unexplained jargon and long abstract framing are not.

## Concurrent Sessions

Multiple coding-agent sessions may work in this checkout at the same time.

- Check `git status --short --branch` before editing.
- Re-read a file immediately before modifying it.
- Preserve unrelated changes and never revert or clean up work you did not create unless explicitly asked.
- If overlapping edits make the task ambiguous or risky, stop and ask before overwriting them.
- Base final code-state claims on fresh checks from the current turn.

## Current Implementation Snapshot

Treat docs as useful but potentially stale. Re-check source before making status claims.

- Rebuild authority: `prd.md`, `roadmap.md`, `continual-test-data-lab-rebuild-plan.md`, and `REBUILD_RELEASE_EVIDENCE.md`.
- Rebuild status (2026-08-09): Phase 0 is complete; Phase 1's catalog/profile/volume direction is owner-approved and all 48 report rows are statically classified, while 24 create/update cells, six void operations, two lower-tier API questions, and dataset evidence remain open; Phase 2's fixture-design gate is accepted, with React interaction/NVDA/forced-colours checks deferred to Phase 4; an initial non-live Phase 3 read-only server foundation exists. No new rebuild QBO mutation path exists.
- Phase 3 read-only foundation: `backend/src/routes/rebuild.js` serves server-owned `/api/context`, capability/report definitions, the operation matrix, and proposal reads. `CompanyMembership` and `BlueprintVersion` are additive models only; no migration has run. See `docs/architecture/rebuild-phase-3-foundation.md`.
- Server-owned flags default legacy AI plan execution, issue-pack execution, and legacy startup database maintenance off. Importing `backend/src/server.js` does not start the server. Explicit backend startup still connects MongoDB; do not run it without permission.
- Historical phase docs remain useful implementation evidence but no longer set product priority: `phase-0-api-validation-spike.md`, `phase-1-foundation-plan.md`, `phase-2-plan.md`, `phase-2-reality-inspection-plan.md`, `phase-3-ai-layer-plan.md`, and `phase-4-hardening-plan.md`.
- Phase 0 scripts exist under `scripts/phase-0/`.
- Backend code exists under `backend/src/` with Express, Mongoose, QBO OAuth/client modules, seeding, generation, checkpoints, issue packs, audit, and AI routes.
- Frontend code exists under `frontend/src/` with Vite, React, protected routes, dashboard, onboarding, explorer, checkpoints, issue packs, settings, audit, and AI command center pages.
- Checkpoints are deferred; current issue packs and AI are preserved as legacy/experimental during the rebuild. Their presence in source is not rebuild completion evidence.
- The old `CLAUDE.md` claimed Phase 1/Phase 2 status and should not be treated as current source of truth after this architecture update.
- QBO error handling is status-based. `backend/src/modules/qbo-client.js` `apiCall()` captures Intuit `intuit_tid` from response headers (`getLastIntuitTid()`), retries 429 with clamped exponential backoff (60s/attempt cap, max 5 attempts), and throws errors carrying `err.status`, `err.intuit_tid`, and the QBO Fault message on 4xx/5xx. Helper `backend/src/modules/qbo-error.js` (`isQboError`/`respondQboError`) maps QBO upstream errors to HTTP 502 (429 passthrough) with `{ error, intuit_tid, qboStatus }`. Routes must NOT surface a QBO-side 401 as an app-level 401: the frontend treats any 401 as session expiry and force-logs-out the user. Wired into `ai`, `checkpoint`, `company`, `explore` routes; `seed`/`generate`/`issuepacks` are intentionally unchanged (fire-and-forget background jobs surfaced via `/status` and `/log`).
- SDK gotcha: installed `intuit-oauth@4.2.2` is axios-based. `makeApiCall` RESOLVES on 2xx-4xx (`validateStatus < 500`) and THROWS an OAuthError on 5xx/network failures with the HTTP status in `err.code` (a string), not `err.status`/`.statusCode`/`.authResponse`.
- Frontend error-surfacing primitives: `frontend/src/components/ui/toast.jsx` (`ToastProvider` + `useToast`) and `frontend/src/components/ui/alert.jsx`, mounted in `frontend/src/App.jsx`. Prefer these over silent catches when surfacing errors.
- Production status (verified 2026-07-11): Intuit Developer production API access is unlocked and a real QBO Advanced Canada company is connected. The local `.env` uses `QBO_ENVIRONMENT=production`; an ngrok reserved-domain tunnel is needed only for connect/reconnect OAuth callbacks. Treat all live QBO actions as real-company operations. App identity is an independent personal application; public/app names must not contain "QBO"/"QuickBooks"/"Intuit"/"QB" (public name "Test Data Lab"; Intuit dashboard registration "Support Lab").

## First Files To Read

Read only the files needed for the task. Use this routing before broad scanning.

- Project orientation: `prd.md`, `roadmap.md`, `continual-test-data-lab-rebuild-plan.md`, `REBUILD_RELEASE_EVIDENCE.md`, `package.json`, `backend/package.json`, `frontend/package.json`.
- Capability/report discovery: `docs/discovery/README.md`, `docs/discovery/registry.schema.v1.json`, `docs/discovery/catalog.v1.json`, `docs/discovery/catalog.v1.md`.
- Backend startup and side effects: `backend/src/server.js`, `backend/src/app.js`, `backend/src/config/index.js`, `backend/src/config/database.js`.
- Rebuild context/definitions: `backend/src/routes/rebuild.js`, `backend/src/modules/rebuild-context.js`, `backend/src/modules/rebuild-definitions.js`, `backend/src/modules/rebuild-permissions.js`, `backend/src/models/CompanyMembership.js`, `backend/src/models/BlueprintVersion.js`.
- QBO auth/client work: `backend/src/routes/qbo.js`, `backend/src/modules/qbo-client.js`, `backend/src/modules/qbo-error.js`, `scripts/phase-0/lib/qbo-client.js`.
- Seeding/generation: `backend/src/routes/seed.js`, `backend/src/routes/generate.js`, `backend/src/modules/generation-engine.js`.
- Inspection/checkpoints: `backend/src/routes/explore.js`, `backend/src/routes/checkpoint.js`, `backend/src/modules/checkpoint.js`.
- Issue packs: `backend/src/routes/issuepacks.js`, `backend/src/modules/issuepack-engine.js`, `backend/src/modules/issuepack-seeder.js`, `backend/src/models/IssuePack.js`, `backend/src/models/IssuePackRun.js`.
- AI layer: `phase-3-ai-layer-plan.md`, `backend/src/routes/ai.js`, `backend/src/modules/ai-provider.js`, `backend/src/modules/ai-orchestrator.js`, `backend/src/modules/ai-tools.js`, `backend/src/modules/ai-notes.js`, `frontend/src/pages/AICommandCenter.jsx`, `frontend/src/components/ai/`.
- Frontend shell/routes: `frontend/src/App.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/api/client.js`, `frontend/src/context/AuthContext.jsx`, `frontend/src/index.css`.
- Error surfacing (frontend): `frontend/src/components/ui/toast.jsx`, `frontend/src/components/ui/alert.jsx`.
- Agent architecture: `CLAUDE.md`, `.codex/memory/PROJECT_MEMORY.md`, `.codex/memory/AGENT_HANDOFF.md`, `.agents/rules/`, `.agents/skills/`, `.claude/rules/`, `.claude/agents/`, `.claude/skills/`.
- Harness architecture and memory boundaries: `AGENT_HARNESS.md`.

## Provider Architecture

This repo uses both OpenAI Codex and Claude Code.

- Codex persistent guidance lives in this file.
- Codex repo skills live in `.agents/skills/`.
- Codex project memory/handoff notes live in `.codex/memory/`.
- Codex scoped rules live in `.agents/rules/` and are referenced by skills and this file.
- Claude persistent guidance lives in `CLAUDE.md`.
- Claude memory lives in `.claude/memory/`.
- Claude path rules live in `.claude/rules/`.
- Claude subagents live in `.claude/agents/`.
- Claude project skills live in `.claude/skills/`.

Do not put provider login, API keys, base URLs, telemetry keys, or personal account settings in repo files. Keep those in user-level tool config or local environment.

## Git And Branch Workflow

This rule applies to Codex, Claude Code, Claude subagents, and any worker/reviewer agent invoked from this repo.

- Default workspace is the canonical checkout at `C:\Projects\qbo`. Do not create, use, or continue work inside Git worktrees, `.claude/worktrees/`, alternate clones, temp checkouts, or detached worktrees unless the user explicitly asks for that in the current conversation.
- Default branch target is this repo's normal default branch: `main` for this checkout, or `master` only if a future checkout is configured that way. Do not create, switch to, commit on, or push from feature branches without explicit user instruction.
- Before committing or pushing, run `git status --short --branch` and confirm the current branch is `main` or `master`. If it is any other branch, a detached HEAD, or a worktree path, stop and ask the user before changing branch state.
- When the user asks to commit or push without naming a branch, commit on the current `main`/`master` checkout and push to the matching upstream (`origin/main` or `origin/master`). Do not invent a PR branch, worktree branch, or alternate remote target.
- If the user explicitly asks for a worktree or non-default branch, treat that permission as scoped to that task only; document the branch/worktree in the handoff and return future work to `main`/`master` unless instructed again.

## Safety Rules

This project can mutate a real or sandbox QBO company and a local/Atlas MongoDB database. Default to read-only inspection unless the user explicitly asks for a mutating action.

- Never print `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, API keys, raw Authorization headers, or user-supplied AI keys.
- Do not run Phase 0 QBO scripts unless explicitly asked in the current conversation: `npm run connect`, `npm run seed`, `npm run ar-chain`, `npm run ap-chain`, `npm run read-chains`, `npm run rate-limits`, `npm run sales-order`.
- Do not call backend routes that mutate QBO or database state unless explicitly requested. This includes seeding, generation, issue pack execution, plan execution, QBO OAuth flows, checkpoint creation/deletion, and settings changes that save keys.
- Do not start, stop, restart, or replace long-running backend/frontend servers unless explicitly asked. Backend startup connects to MongoDB. Legacy issue-pack seeding and stale job/plan rewrites are default-off, but may be re-enabled by local server configuration.
- It is OK to inspect code, read logs, check `git status`, run static checks, and explain what command the user should run.
- If live verification requires a running app or QBO-connected company, say so and ask before starting or mutating anything.

## Commands

Root:

- `npm run dev` - starts backend and frontend together. Do not run without explicit user request.
- `npm run connect` - Phase 0 OAuth flow. Mutating/auth flow; explicit request only.
- `npm run seed` - Phase 0 master-data seeding. Mutates QBO; explicit request only.
- `npm run ar-chain`, `npm run ap-chain`, `npm run read-chains`, `npm run rate-limits`, `npm run sales-order` - Phase 0 validation scripts. Explicit request only.

Backend:

- `npm run dev --workspace=backend` - starts nodemon. Explicit request only.
- `npm run start --workspace=backend` - starts server. Explicit request only.
- `npm run test --workspace=backend` - safe non-live backend unit/contract tests.
- Safe default syntax check: `Get-ChildItem backend/src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`

Frontend:

- `npm run dev --workspace=frontend` - starts Vite. Explicit request only.
- `npm run build --workspace=frontend` - safe static build.
- `npm run lint --workspace=frontend` - safe lint.
- `npm run preview --workspace=frontend` - starts preview server. Explicit request only.

## Implementation Rules

- Keep backend code CommonJS unless a file already uses another module system.
- Keep frontend code ESM/React JSX.
- Keep QBO mutations behind explicit user intent, visible company scope, audit logging, and existing route/module boundaries.
- Use existing modules before adding new abstractions.
- Keep AI writes behind plan/approval flows. AI should use internal tool contracts, not raw QBO API calls.
- Update docs or memory when a durable project fact changes.
- Infer the complete practical outcome when the request omits obvious supporting work. Deliver a polished result without inventing unrelated scope or making materially different product decisions without approval.
- Write or run tests in proportion to risk. Do not forbid testing, and do not use broad live tests where a focused non-mutating check is enough.
- When changing provider/model names or recommendations, verify current official provider documentation. Prefer the newest supported model unless the repo records a tested compatibility reason not to.
- Follow the Git And Branch Workflow above for all work, commits, and pushes.
- Use project skills when their trigger matches:
  - `.agents/skills/qbo-project` for repo orientation and general changes.
  - `.agents/skills/qbo-safety-review` for QBO/API/database/secret risk review.
  - `.agents/skills/qbo-implementation-plan` for scoped planning before larger changes.

## Verification

Prefer the smallest useful verification step.

- Documentation or agent-architecture changes: inspect files, validate skill frontmatter, and run `git diff --check`.
- Frontend code changes: run `npm run build --workspace=frontend` and `npm run lint --workspace=frontend` when practical.
- Backend code changes: run Node syntax checks against touched backend files; broaden to all `backend/src/**/*.js` for shared changes.
- QBO mutation paths: do not live-test without explicit user approval and a stated target company/environment.
- Browser testing: use the available browser tool only if the app is already running or the user asks to start/open it.

## Review Standard

For reviews, lead with findings ordered by severity and include file/line references. Focus on bugs, regressions, missing safety checks, missing tests, stale docs, and places where the implementation violates QBO safety or AI approval boundaries.

## Done Criteria

Before reporting completion:

- Re-check the files changed in the current turn.
- Run the relevant non-mutating verification.
- For commit/push tasks, report the branch/upstream verified before the commit or push.
- Report commands run and any commands skipped because they would start services or mutate QBO/database state.
- Mention any repo state that remains local-only or intentionally untracked.
- Commit and push completed requested changes unless the user explicitly says not to or the branch/safety checks prevent it.
