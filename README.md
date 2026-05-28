# QBO Canada Support Lab

Local web application for QuickBooks Online Canada support workflows.

The app lets a support user connect one QBO Advanced Canada company, seed realistic master data, generate business history, create checkpoints, run predefined issue packs, inspect QBO state, and use AI-assisted investigation/support-note workflows.

## Current Status

Updated: 2026-05-28

This project was revived after being on hold. The source code is ahead of several older planning docs.

| Area | Current state |
| --- | --- |
| Phase 0 API validation | Completed. Core QBO API assumptions passed; purchase orders and sales orders are not available through the API path tested. |
| Phase 1 foundation | Code present for auth, QBO connection, company profile, seeding, dashboard, and audit surfaces. Needs fresh end-to-end runtime verification. |
| Phase 2 reality and inspection | Code present for generation, checkpoints, diffs, entity explorer, issue packs, and run history. Needs fresh QBO-connected acceptance testing. |
| Phase 3 AI layer | Code present for Anthropic provider, AI tools, orchestration, sessions, plans, SSE, notes, and frontend AI command center. Needs acceptance testing and hardening. |
| Phase 4 hardening/polish/continuous activity | Not implemented. Documented in `phase-4-hardening-plan.md`. |

## Production Access

Production API access is now unlocked on the Intuit Developer portal: the app passed Intuit's full App Assessment.

Connecting a real production company is not yet wired up. `.env` still sets `QBO_ENVIRONMENT=sandbox`, and production OAuth additionally requires a public HTTPS redirect URI (Intuit production rejects `http`/`localhost` callbacks). The path to enabling production is:

1. Expose the local backend over a public HTTPS endpoint, either through an HTTPS tunnel (e.g. ngrok) or a deploy (e.g. Render).
2. Register that HTTPS redirect URI in the Intuit Developer portal.
3. Switch `QBO_ENVIRONMENT` to `production` and point the OAuth config at production credentials.

None of these steps are done yet; production remains pending.

## Verified On 2026-05-28

Non-mutating checks only:

- `npm run build --workspace=frontend` passes.
- Backend syntax check over `backend/src/**/*.js` passes.
- `npm run lint --workspace=frontend` fails with current AI UI lint debt.
- `npm audit --omit=dev --json` reports 14 production vulnerabilities: 2 high, 12 moderate.

No backend server was started and no QBO/database mutation was performed during this documentation update.

## Error Handling and Observability

Recent work on the `fix/qbo-client-error-handling` branch makes QBO upstream failures visible instead of silently swallowed:

- The QBO client captures Intuit's `intuit_tid` trace id from QBO responses (`backend/src/modules/qbo-client.js`) for support tracing.
- QBO upstream errors are mapped to HTTP `502` with an `intuit_tid` in the response body via the shared `backend/src/modules/qbo-error.js` helper; QBO `429` rate-limit responses are passed through as `429`.
- The frontend surfaces these failures with toast and inline-alert errors (`frontend/src/components/ui/toast.jsx`, `frontend/src/components/ui/alert.jsx`) and retry affordances on failed loads, including AI plan approve/reject/execute failures.

## Project Layout

```text
backend/                 Express/Mongoose backend
frontend/                Vite/React frontend
scripts/phase-0/         Historical QBO API validation scripts
prd.md                   Product contract
roadmap.md               Current phase roadmap/status
phase-*.md               Phase plans and implementation notes
AGENTS.md                OpenAI Codex project guidance
CLAUDE.md                Claude Code guidance, imports AGENTS.md
.agents/                 Codex repo rules and skills
.codex/                  Codex project config and memory
.claude/                 Claude memory, rules, skills, and subagents
```

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Create `.env` from `.env.example`.

3. Fill in local values for MongoDB, JWT, QBO OAuth, and optional Anthropic AI settings. Use placeholders here; do not paste real client IDs, client secrets, or API keys into tracked files.

QBO OAuth uses the official `intuit-oauth@4.2.2` (axios-based) SDK.

Do not commit `.env` or `.tokens.json`.

## Commands

Safe non-mutating checks:

```powershell
npm run build --workspace=frontend
npm run lint --workspace=frontend
Get-ChildItem backend\src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
npm audit --omit=dev
```

Long-running local servers:

```powershell
npm run dev
npm run dev --workspace=backend
npm run dev --workspace=frontend
```

QBO-facing scripts that can authenticate or mutate a company:

```powershell
npm run connect
npm run seed
npm run ar-chain
npm run ap-chain
npm run read-chains
npm run rate-limits
npm run sales-order
```

Only run QBO-facing scripts against an intended sandbox/test company.

## Documentation Map

- `roadmap.md` is the current status index.
- `phase-0-api-validation-spike.md` now records the completed API spike outcome.
- `phase-1-foundation-plan.md` records Phase 1 plan plus current implementation status.
- `phase-2-plan.md` is the current Phase 2 implementation note.
- `phase-2-reality-inspection-plan.md` is the older detailed Phase 2 design plan and is superseded by `phase-2-plan.md` for implementation status.
- `phase-3-ai-layer-plan.md` records Phase 3 plan plus current code-present and verification status.
- `phase-4-hardening-plan.md` defines the gated hardening/polish plan. It is not implemented.

## Legal and Branding

This is an independent application, not affiliated with or endorsed by Intuit. Its public name must not contain "QBO", "QuickBooks", "Intuit", or "QB"; the public name in use is "Test Data Lab".

- EULA: https://keithmacdonalddev.github.io/test-data-lab/eula.html
- Privacy Policy: https://keithmacdonalddev.github.io/test-data-lab/privacy.html

Local source for these documents lives in the untracked `legal/` folder. The privacy policy discloses that relevant QuickBooks data may be sent to the configured AI provider (Anthropic or OpenAI) when AI features are used.

## Safety Notes

Backend startup is not neutral: `backend/src/server.js` connects to MongoDB, seeds built-in issue packs, and marks stale jobs/plans failed.

Treat QBO calls as potentially mutating unless proven otherwise. Do not print secrets, OAuth tokens, QBO payloads containing company data, or stored user AI keys.
