---
name: project-production-guard
description: The productionGuard middleware is the safety-critical control gating QBO write routes when environment is production
metadata:
  type: project
---

`backend/src/middleware/productionGuard.js` exports `requireProductionConfirm`. It is the safety-critical heart of the Dashboard/Lab-Tools split: it gates the three QBO write routes so that writes against a real company require explicit `confirmProduction: true` in the request body.

Contract:
- When `config.qbo.environment === 'production'` AND `req.body?.confirmProduction !== true` (strict boolean), respond HTTP 412 `{ error, environment:'production', requiresConfirmation:true }` and do NOT call next().
- In sandbox it is a no-op (calls next()).
- Must be applied BEFORE the handler on all three write routes: seed.js POST /start, generate.js POST /start, issuepacks.js POST /:slug/run.

**Why:** The Dashboard previously mixed read-only status with write actions (seed/generate/issue-pack run) that mutate the connected QBO company. The guard prevents accidental writes to a real production company.

**How to apply:** When reviewing any change touching these routes or the middleware, verify (1) the middleware runs before the handler, (2) the import isn't undefined (named vs default export mismatch silently skips it), (3) `confirmProduction` is checked with strict `=== true` so string "true" can't bypass, (4) express.json body parsing is mounted before the routers so req.body exists. Relates to [[feedback-401-passthrough]] and [[project-live-production-company]].
