# Phase 1 Foundation Plan

**Status:** Planned  
**Duration:** 3-4 weeks  
**Phase objective:** Ship the first end-to-end internal product slice after the API spike passes.

---

## 1. Phase outcome

At the end of Phase 1, one internal user should be able to:

- sign in to the application
- connect one internal support-owned QBO test company
- complete capability assessment
- seed the company with deterministic master data
- view flagship-company status on a dashboard
- review audit events for setup actions

This phase proves the foundation. It does not attempt to make the flagship company fully realistic yet.

---

## 2. Entry criteria

Phase 1 starts only after Phase 0 provides:

- validated OAuth and token-refresh behavior
- validated company targeting and realm handling
- a supported entity list for baseline seeding
- recommended baseline data volumes
- a documented rate-limit and retry approach
- documented removals or downgrades for unsupported PRD assumptions

---

## 3. Scope

### In scope

- application bootstrap and project structure
- auth and role framework
- QBO connection flow
- company profile and capability assessment
- master data seeding v1
- onboarding flow
- dashboard v1
- audit-log foundation
- operational logging and error handling

### Explicitly out of scope

- realistic historical generation beyond smoke validation
- checkpoints and diff
- issue injection engine
- scenario library authoring
- AI orchestration and natural-language planning
- continuous activity engine
- replay and reset workflows
- raw API explorer UI

---

## 4. Product slice for this phase

### User journey

1. User signs in.
2. User connects one QBO company through OAuth.
3. App validates the company and stores connection state.
4. App runs capability assessment and shows the result.
5. User confirms flagship setup.
6. App seeds baseline master data in the background.
7. User sees seeding progress and final status on the dashboard.
8. User can review what was created and what actions were logged.

### Required UX surfaces

- login
- onboarding
- company setup summary
- seeding progress view
- dashboard
- audit-log view
- settings or connection-management view

---

## 5. Architecture slice

### Frontend

- React application shell
- authenticated routing
- onboarding and dashboard views
- mutation confirmation patterns for setup actions
- background job status polling

### Backend

- auth module
- QBO integration module
- company profile module
- seed orchestration module
- audit module
- job runner for long-running setup tasks

### Data model

Minimum collections expected in this phase:

- `users`
- `connections`
- `companyProfiles`
- `auditLog`
- `seedRuns` or equivalent job-history collection

### Infrastructure

- MongoDB for application records
- Redis plus queue layer if seeding is long-running
- encrypted secret handling for tokens
- structured application logging

---

## 6. Epics and acceptance criteria

### Epic 1: project bootstrap

**Deliverables**

- frontend and backend app skeletons
- environment configuration
- local developer setup
- deployment target for internal testing

**Acceptance criteria**

- app runs locally with documented setup
- environment secrets are not hard-coded
- baseline lint and test commands exist

### Epic 2: auth and roles

**Deliverables**

- login flow
- session handling
- role model for `agent` and `supervisor`

**Acceptance criteria**

- authenticated and unauthenticated routes are separated
- roles are enforced server-side
- app can distinguish current user and active company context

### Epic 3: QBO connection and token lifecycle

**Deliverables**

- OAuth initiation and callback flow
- token storage and refresh
- connection health checks

**Acceptance criteria**

- user can connect exactly one flagship company
- expired tokens can be refreshed automatically where supported
- revoked or invalid connections surface actionable errors
- every connection is tied to a specific realm ID

### Epic 4: company profile and capability assessment

**Deliverables**

- per-company profile record
- capability assessment job
- readiness summary in UI

**Acceptance criteria**

- app records subscription tier, feature flags, and known limitations
- app records seeding readiness and current status
- user can see why a company is or is not eligible for setup

### Epic 5: master data seeding v1

**Deliverables**

- deterministic seed orchestration
- baseline customers, vendors, items, and accounts
- idempotency strategy

**Acceptance criteria**

- seed run creates the approved baseline dataset
- repeated seed run does not blindly create duplicates
- seed progress and failure states are visible in the UI
- all seed mutations are logged

### Epic 6: dashboard and audit foundation

**Deliverables**

- flagship dashboard
- recent activity and setup status
- audit-log viewer for setup actions

**Acceptance criteria**

- dashboard shows connection status, seeding status, and last successful activity
- audit log captures actor, company, action type, result, and timestamp
- user can review setup history without leaving the app

---

## 7. Functional checklist

By the end of Phase 1, the product must support:

- one company per user
- secure token storage
- explicit active-company targeting
- capability assessment before seeding
- baseline seeding for an internal support-owned company
- progress reporting for long-running setup work
- queryable audit records for all setup mutations

---

## 8. Non-functional expectations

### Security

- token storage must be encrypted
- role checks must be enforced in the backend
- users must not access other users' company data

### Reliability

- retries must be bounded and logged
- failed setup runs must surface clear remediation steps
- partial seeding runs must be identifiable

### Performance

- login and dashboard interactions should feel responsive
- long-running seed work should not block the UI thread

### Maintainability

- modules should reflect the boundaries expected in later phases
- seed logic should be composed of smaller deterministic operations

---

## 9. Suggested milestone breakdown

### Week 1

- bootstrap repo structure
- implement auth skeleton
- implement OAuth connection flow

### Week 2

- company profile model
- capability assessment
- onboarding and setup summary UI

### Week 3

- master data seeding orchestration
- audit logging
- dashboard status views

### Week 4

- hardening
- defect fixes
- internal demo and acceptance pass

If the team finishes early, use the time for hardening, not Phase 2 creep.

---

## 10. Risks specific to Phase 1

- The spike may validate creation paths but still reveal edge cases during repeated seeding.
- Idempotency may be harder than initial create-path validation suggests.
- Connection and token issues may dominate support effort if error states are weak.
- Dashboard requirements can sprawl if the team tries to preview Phase 2 investigation features too early.

---

## 11. Done definition

Phase 1 is done only when:

- an internal user can complete the full setup flow without manual DB edits
- at least one internal support-owned company can be seeded successfully end to end
- a repeated seed run has a documented and acceptable idempotent outcome
- audit records exist for every setup mutation
- the team has a short carry-forward list for Phase 2 rather than unresolved Phase 1 ambiguity

---

## 12. Handoff into Phase 2

Phase 1 should hand off:

- a stable connection layer
- a stable company profile and capability model
- a deterministic seeding engine base
- audit events that later checkpoint and timeline features can build on
- a concrete list of Phase 2 priorities validated by the first internal demo
