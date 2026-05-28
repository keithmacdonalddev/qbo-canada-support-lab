# QBO Safety Checklist

## Secrets

- Do not print or commit `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, Anthropic keys, OpenAI keys, raw Authorization headers, or stored user AI keys.
- Do not add secrets to docs, memory, examples, tests, screenshots, logs, or agent files.
- Use `.env.example` only for placeholder names.

## QBO And Database Mutations

- Mutating operations require explicit current user approval before live execution.
- Mutation code should identify `userId`, `realmId`, and active `Connection`.
- QBO writes should go through existing client/module boundaries.
- Avoid adding delete/destructive QBO behavior unless explicitly requested.
- Every mutation should create or preserve an audit trail.

## AI Execution

- AI should call internal tool contracts, not raw QBO APIs.
- Read-only AI tools can run automatically only when scoped to the active user/company.
- Write tools require plan creation, visible approval, and execution only after approval.
- Plan execution should be auditable and tied to session/plan IDs.

## Startup

- `backend/src/server.js` is side-effecting: database connect, issue pack seeding, stale job recovery.
- Do not start/restart backend as routine verification.

## Live Verification

Safe by default:

- source inspection
- `git diff --check`
- frontend build/lint
- backend `node --check`

Requires explicit approval:

- OAuth connect flow
- Phase 0 scripts
- seed/generate/issue pack/checkpoint creation routes
- AI plan execution
- server start/restart when connected to local/Atlas database
