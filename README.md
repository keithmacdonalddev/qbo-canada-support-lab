# Test Data Lab

Test Data Lab is a local control and visibility application for maintaining one flagship QuickBooks Online Advanced Canada company as a believable, continually evolving business.

The app is being rebuilt around business definition, capability and report coverage, controlled historical and forward operations, complete data inspection, reconciliation evidence, and governed administration. Support agents reproduce customer problems manually in the resulting company.

## Rebuild status

Updated: 2026-08-08

- Phase 0 product reset is complete.
- Phase 1 capability/report discovery is in progress using static artifacts and official-source research.
- No new rebuild mutation path, scheduler, database model, or live operation has been implemented yet.
- Existing seeding, generation, explorer, checkpoints, issue packs, audit, and AI surfaces remain in source during migration.
- Checkpoints are deferred; current issue packs and AI are legacy/experimental, not core rebuild requirements.

Start with:

- `prd.md` — approved product contract;
- `roadmap.md` — current phase status and next gate;
- `continual-test-data-lab-rebuild-plan.md` — detailed architecture, UI, safety, and delivery plan;
- `REBUILD_RELEASE_EVIDENCE.md` — evidence required to pass each rebuild gate;
- `docs/discovery/` — versioned capability/report discovery artifacts.

## Production safety

Production API access is unlocked and a real QBO Advanced Canada company is connected. The local environment uses Production. An HTTPS tunnel is needed only when the OAuth connect/reconnect callback must be reachable; ordinary backend-to-Intuit API calls do not require it.

Treat every live QBO operation as a real-company operation. Do not run OAuth, seed, generation, issue-pack, checkpoint, AI-execution, or other mutating actions without explicit approval for the exact target and action. Automatic Production scheduling is not approved.

Backend startup is also not neutral: it connects to MongoDB, seeds built-in issue-pack definitions, and marks stale jobs and AI plans failed. Do not start, stop, or restart app services unless explicitly requested.

## Current implementation baseline

| Area | Present now | Rebuild status |
| --- | --- | --- |
| Authentication and connection | Email/password auth, protected routes, QBO OAuth and token handling | Will move to realm memberships and server-enforced capability permissions in Phase 3 |
| QBO client | Status-based errors, `intuit_tid`, 429 backoff, Production guard on selected write routes | Preserved foundation; new writes wait for the operation-safety gates |
| Data preparation | Fixed seeding and randomized historical generation | Legacy implementation; replaced later by blueprint-driven lifecycle operations |
| Inspection | Dashboard snapshot and 13-type explorer with bounded results | Preserved; Phase 4/9 add truthful overview and fully paginated catalog |
| Checkpoints and issue packs | Existing routes, models, and pages | Deferred or legacy/experimental |
| AI | Existing provider, sessions, plans, tools, SSE, notes, and command center | Experimental; no new core dependency or write authority |
| UI | React/Vite shell and local primitives | Phase 2 designs the new system before broad shell migration |

## Project layout

```text
backend/                 Express/Mongoose backend
frontend/                Vite/React frontend
docs/discovery/          Versioned rebuild discovery artifacts
scripts/phase-0/         Historical QBO API validation scripts
prd.md                   Approved product contract
roadmap.md               Current rebuild status and gates
continual-*.md           Detailed rebuild plan
REBUILD_RELEASE_EVIDENCE.md
phase-*.md               Historical implementation plans and notes
AGENTS.md                OpenAI Codex project guidance
CLAUDE.md                Claude Code guidance
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

3. Fill in local MongoDB, JWT, QBO OAuth, and optional AI-provider settings. Never commit `.env`, `.tokens.json`, credentials, tokens, or keys.

QBO OAuth currently uses `intuit-oauth@4.2.2`.

## Commands

Safe non-mutating checks:

```powershell
npm run validate:discovery
npm run build --workspace=frontend
npm run lint --workspace=frontend
Get-ChildItem backend\src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Long-running servers—explicit request required:

```powershell
npm run dev
npm run dev --workspace=backend
npm run dev --workspace=frontend
```

QBO-facing historical scripts—explicit target/action approval required:

```powershell
npm run connect
npm run seed
npm run ar-chain
npm run ap-chain
npm run read-chains
npm run rate-limits
npm run sales-order
```

## Git workflow

The canonical checkout is `C:\Projects\qbo` on `main`. Agents do not create or use worktrees, alternate clones, detached checkouts, or non-default branches unless explicitly requested. Unqualified commit and push requests target `main` and `origin/main`.

## Branding and legal

The public product name is **Test Data Lab**. QBO and QuickBooks may be used only as descriptive integration terms, not as the application name. This independent application is not affiliated with or endorsed by Intuit.

- EULA: https://keithmacdonalddev.github.io/test-data-lab/eula.html
- Privacy policy: https://keithmacdonalddev.github.io/test-data-lab/privacy.html
