# QBO Implementation Planning Checklist

## Scope Questions

- Is this docs-only, frontend-only, backend-only, or cross-stack?
- Does it touch QBO OAuth, QBO API calls, `.tokens.json`, `.env`, stored keys, auth, database models, or AI execution?
- Does it change user-visible workflow copy or route behavior?
- Does it update stale phase/roadmap status?

## File Selection

Start with the narrowest set:

- Root docs: `prd.md`, `roadmap.md`, relevant `phase-*.md`.
- Backend startup/config: `backend/src/server.js`, `backend/src/config/`.
- QBO: `backend/src/routes/qbo.js`, `backend/src/modules/qbo-client.js`, `scripts/phase-0/`.
- Simulation: `seed.js`, `generate.js`, `generation-engine.js`.
- Inspection: `explore.js`, `checkpoint.js`.
- Issue packs: `issuepacks.js`, `issuepack-engine.js`, `issuepack-seeder.js`.
- AI: `ai.js`, `ai-provider.js`, `ai-orchestrator.js`, `ai-tools.js`, `ai-notes.js`.
- Frontend: `App.jsx`, `api/client.js`, relevant page/component.

## Verification Planning

- Docs/agent files: inspect content and run `git diff --check`.
- Frontend: build and lint when practical.
- Backend: `node --check` touched files.
- QBO/database live checks: require explicit approval and a target environment.

## Deliverable Shape

Keep the final implementation small and repo-aligned. Include a short status note describing files changed, safe checks run, and skipped live checks.
