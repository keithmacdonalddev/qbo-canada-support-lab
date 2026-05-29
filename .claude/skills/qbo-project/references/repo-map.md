# QBO Support Lab Repo Map

## Root

- `AGENTS.md`: Codex project guidance.
- `CLAUDE.md`: Claude Code guidance, imports `AGENTS.md`.
- `.codex/memory/`: Codex project memory and handoff notes.
- `.agents/rules/`: Codex-readable scoped rules, including `.agents/rules/git.md` for branch/worktree defaults.
- `.agents/skills/`: Codex repo skills.
- `.claude/`: Claude memory, rules, agents, and skills, including `.claude/rules/git.md`.
- `prd.md`: product intent and AI/QBO safety principles.
- `roadmap.md`: phase gates and sequencing.
- `phase-*.md`: phase-specific plans; verify against source before treating status as current.

## Backend

- `backend/src/server.js`: Express entry point; connects MongoDB, seeds issue packs, and recovers stale jobs/plans on startup.
- `backend/src/config/`: environment and database configuration.
- `backend/src/middleware/`: auth, audit logging, error handling.
- `backend/src/models/`: Mongoose models for users, QBO connections, company profiles, audits, checkpoints, issue packs, generation runs, AI sessions, and AI plans.
- `backend/src/routes/`: HTTP route surfaces.
- `backend/src/modules/`: shared QBO, generation, checkpoint, issue pack, and AI logic.

## Frontend

- `frontend/src/App.jsx`: route table.
- `frontend/src/api/client.js`: API client.
- `frontend/src/context/AuthContext.jsx`: auth state.
- `frontend/src/components/Layout.jsx`: main protected shell.
- `frontend/src/pages/`: dashboard, onboarding, explorer, checkpoints, issue packs, AI command center, settings, audit.
- `frontend/src/components/ai/`: AI command center subcomponents.
- `frontend/src/components/ui/`: local UI primitives.

## Mutating Commands

Do not run without explicit current user approval:

- `npm run dev`
- `npm run dev --workspace=backend`
- `npm run start --workspace=backend`
- `npm run connect`
- `npm run seed`
- `npm run ar-chain`
- `npm run ap-chain`
- `npm run read-chains`
- `npm run rate-limits`
- `npm run sales-order`

## Safer Commands

- `git status --short --branch`
- `git status --short`
- `git diff --check`
- `npm run build --workspace=frontend`
- `npm run lint --workspace=frontend`
- `node --check <backend-file>`
