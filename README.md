# Test Data Lab

Test Data Lab is a local control and visibility application for maintaining one flagship QuickBooks Online Advanced Canada company as a believable, continually evolving business.

The intended experience is an in-app accountant that continuously manages a believable medium-sized business for troubleshooting, teaching and learning, with complete owner controls. Manual support work and the separately approved autonomous reproduction workflow remain available.

## Current delivery

Updated: 2026-10-24. The continuous business-operator outcome is unfinished. Source includes company synchronization, a server-owned agent loop, scoped controls/tools and an owner workspace. Source presence and earlier monitoring evidence do not prove autonomous accounting or days/weeks of successful operation.

Start with:

- `prd.md` — current product contract;
- `docs/plans/continuous-business-operator-completion-2026-10-24.md` — full intended outcome, current gaps, ordered work and acceptance proof;
- `docs/architecture/business-agent.md` — implemented operator boundary and outstanding verification;
- `docs/agent-harness/FULL_GOAL_EXECUTION.md` — dated company execution evidence and existing authority;
- `docs/discovery/` — capability/report definitions;
- `roadmap.md` and `REBUILD_RELEASE_EVIDENCE.md` — historical August phase/evidence records, not current progress.

The old August rebuild plan was deleted at the owner’s request. Its AI restrictions and phase order do not govern current work.

## Production safety

Production API access is unlocked and a real QBO Advanced Canada company is connected. The local environment uses Production. An HTTPS tunnel is needed only when the OAuth connect/reconnect callback must be reachable; ordinary backend-to-Intuit API calls do not require it.

Treat every live QBO operation as a real-company operation. Do not run OAuth, seed, generation, issue-pack, checkpoint, AI-execution, or other mutating actions without explicit approval for the exact target and action. Automatic Production scheduling is not approved.

Backend startup is still not neutral because it connects to MongoDB. Legacy issue-pack seeding and stale job/plan rewrites are now off by default behind a server flag, but do not start, stop, or restart app services unless explicitly requested.

## Implementation evidence

Use the current completion plan for observed source and outstanding outcome proof, and `docs/architecture/business-agent.md` for the operator implementation boundary. Earlier August phase tables are historical; they do not describe today’s runtime.

## Project layout

```text
backend/                 Express/Mongoose backend
frontend/                Vite/React frontend
docs/discovery/          Versioned rebuild discovery artifacts
scripts/phase-0/         Historical QBO API validation scripts
prd.md                   Approved product contract
roadmap.md               Historical August phase record
docs/plans/              Current completion plan
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

3. Fill in local MongoDB, a private JWT signing secret generated from at least 32 random bytes, QBO OAuth, and optional AI-provider settings. Startup refuses a missing/public signing key. Existing tester accounts use the [private account recovery procedure](docs/account-access-recovery.md). Never commit `.env`, `.tokens.json`, credentials, tokens, or keys.

QBO OAuth currently uses `intuit-oauth@4.2.2`.

## Commands

Safe non-mutating checks:

```powershell
npm run validate:discovery
npm run test:backend
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
