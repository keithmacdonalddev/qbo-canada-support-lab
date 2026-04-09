# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-Driven QBO Canada Support Lab — a web application where QBO Canada support agents each connect one QBO Advanced Canada company and the platform turns it into a realistic, continuously maintained support lab for reproducing customer issues, inspecting state, and generating support notes with AI assistance.

**Status:** Phase 1 (Foundation) complete. Phase 0 API spike complete — all critical API assumptions validated. Phase 2 planning next.

**Core mental model:** One user → one flagship QBO Advanced Canada company → generate, break, inspect, explain.

## Commands

```bash
npm run dev          # Start both backend (3001) and frontend (5173) via concurrently
npm run connect      # Phase 0: OAuth flow (standalone, port 3000)
npm run seed         # Phase 0: Seed master data script
npm run ar-chain     # Phase 0: AR chain validation
npm run ap-chain     # Phase 0: AP chain validation
npm run read-chains  # Phase 0: Read-back validation
npm run rate-limits  # Phase 0: Rate limit exercise
npm run sales-order  # Phase 0: Sales order validation
```

Backend: `cd backend && npm run dev` (nodemon on port 3001)
Frontend: `cd frontend && npm run dev` (Vite on port 5173, proxies /api to 3001)

## Project Structure

```
QBO/
  prd.md                          # Single merged PRD (v2.0, source of truth)
  phase-0-api-validation-spike.md # Phase 0 execution plan
  phase-1-foundation-plan.md      # Phase 1 plan
  roadmap.md                      # Phase sequencing and gates
  artifacts/phase-0/              # Gap report, capability matrix, results summary
  scripts/phase-0/                # Spike validation scripts (standalone, use .tokens.json)
    lib/                          # Shared config, logger, QBO client for scripts
    01-connect-company.js         # OAuth flow → saves .tokens.json
    02-seed-master-data.js        # Seed customers/vendors/items
    03-create-ar-chain.js         # AR chain + backdating tests
    04-create-ap-chain.js         # AP chain tests
    05-read-transaction-chain.js  # Read-back fidelity
    06-exercise-rate-limits.js    # Throughput testing
    07-validate-sales-order.js    # Sales order + entity queryability
  backend/
    src/
      server.js                   # Express entry point
      config/                     # Env config + MongoDB connection (Atlas with DNS override)
      middleware/                  # auth.js (JWT + role), auditLogger.js, errorHandler.js
      models/                     # User, Connection, CompanyProfile, AuditLog, SeedRun
      routes/                     # auth, qbo, company, seed, audit
      modules/qbo-client.js       # QBOClient class — per-connection OAuth, rate-limit retry
  frontend/
    src/
      main.jsx                    # App entry, BrowserRouter
      App.jsx                     # Routes: /, /login, /onboarding, /settings, /audit
      api/client.js               # Axios with JWT interceptor, proxied to backend
      context/AuthContext.jsx      # Auth state, token in localStorage
      components/                 # Layout (sidebar + topbar), ProtectedRoute
      pages/                      # Login, Dashboard, Onboarding, Settings, AuditLog
```

## Tech Stack

- **Frontend:** Vite + React 19, react-router-dom, axios, shadcn/ui + Tailwind CSS
- **Backend:** Node.js + Express, CommonJS modules
- **Database:** MongoDB Atlas (cluster0.x8esl2a.mongodb.net) — requires DNS override (8.8.8.8)
- **Auth:** JWT (jsonwebtoken + bcryptjs), two roles: agent, supervisor
- **QBO integration:** intuit-oauth library, OAuth 2.0 per user/company
- **Job queue:** BullMQ + Redis (planned, not yet implemented)

## Key Technical Details

### MongoDB Atlas DNS
This project uses MongoDB Atlas. Atlas SRV DNS resolution fails on this machine without overriding DNS servers. The fix is in `backend/src/config/database.js` — reads `MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1` from .env and calls `dns.setServers()`.

### QBO API Client
Two versions exist:
1. **Phase 0 scripts:** `scripts/phase-0/lib/qbo-client.js` — uses file-based `.tokens.json`, standalone
2. **Backend module:** `backend/src/modules/qbo-client.js` — `QBOClient` class, per-connection, tokens from MongoDB Connection document, auto-refresh with persistence

Both use the same response parsing: `response.getJson()` → `response.json` → `JSON.parse(response.body)` fallback chain. This was discovered during Phase 0 when `response.text()` didn't work.

### OAuth Callback Flow
The OAuth callback (`GET /api/qbo/callback`) returns an HTML page with `window.opener.postMessage()` to signal the parent window, then `window.close()`. The onboarding page listens for this message and also polls for popup closure as fallback.

### SeedRun Model
The `SeedRun` model uses `seedErrors` (not `errors`) as the field name because Mongoose reserves `errors` as a schema pathname.

## Phase 0 Results (Complete)

All critical API assumptions validated. Two gaps found:
- **Purchase Orders:** API returns Fault — not available (UI-only or tier-restricted)
- **Sales Orders:** No SalesOrder entity in API — confirmed UI-only

Everything else passed: OAuth, token refresh, realm targeting, backdating (200+ days), AR chains (estimate→invoice→payment→credit memo, all linked), AP chains (bill→bill payment→vendor credit), master data volume (130+ entities), idempotency, rate limits (2.2 ops/sec, zero 429s, ~250ms latency), read-back fidelity (linked refs, line items, tax detail).

Full results in `artifacts/phase-0/`.

## Phase 1 Status (In Progress)

Scaffolded:
- Backend: Express server, config, database, all models, all routes, middleware, QBO client module
- Frontend: Vite+React app, routing, auth context, 5 pages, layout

Working:
- User registration and login (JWT)
- OAuth connection flow (popup → postMessage → onboarding advance)
- Dashboard shows connection status, seeding status, freshness score
- Onboarding wizard (5 steps: connect → company info → assess → readiness → begin)

Known issues being fixed:
- Settings page needs endpoint fixes (uses stale `/company/current` endpoint)
- Company name shows N/A until assess step is run
- Need to handle token expiration gracefully in the UI

## Design Constraints

- **AI assists, doesn't drive.** AI proposes plans; user confirms before writes execute.
- **AI calls only internal approved tools**, never raw QBO API endpoints. All AI actions auditable.
- **Audit-first.** Every mutation logged with user, company, action type, tool, params, outcome.
- **Seeding must be idempotent** — query-before-create pattern, skip existing.
- **Rate-limit aware.** 429 retry with exponential backoff in QBOClient.
- **One flagship company per user in v1.**
- **QBO reset limitation.** No mass deletion — "reset" means replay from checkpoints.

## Phasing

| Phase | Focus | Status |
|-------|-------|--------|
| 0 | API validation spike | **Complete** — proceed with 2 scope reductions (no POs, no SalesOrders) |
| 1 | Foundation (auth, OAuth, company profile, seeding, dashboard, audit) | **In progress** |
| 2 | Reality + inspection (historical generation, checkpoints, diffs, entity explorer, issue packs) | Planned |
| 3 | AI layer (orchestration, NL planning, confirmed execution, investigation, note generation) | Planned |
| 4 | Polish + continuous activity | Planned |
