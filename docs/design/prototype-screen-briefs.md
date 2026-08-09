# Phase 2 Prototype Screen Briefs

**Status:** Fixture contract accepted by the lab owner on 2026-08-09
**Business fixture:** Harbour & Pine Operations Inc., Nova Scotia, CAD
**Data horizon:** September 2023 through August 2026; ready through July 2026
**Safety:** No prototype calls an API, saves application data, or starts a QBO operation.

## Shared frame

Every screen includes the same rail, public Test Data Lab identity, Production scope strip, company, connection state, business date, active work, and lab-owner role. The primary action is visible beside the page outcome; secondary detail follows. Narrow screens replace the persistent rail with an explicit menu sheet; it opens from the Menu button, moves focus into navigation, closes with Escape, and restores focus. All scope facts remain in a wrapping strip down to 320px.

## 1. Overview — support readiness

- **Question:** Is this company ready for a support agent today?
- **Primary action:** Review the ranked attention queue.
- **Fixture story:** A target-state readiness example—not current Phase 1 evidence—shows July ready, August planned, a bank-feed evidence check, and one stale profitability report needing attention.
- **States:** Ready, Stale, Manual only, active operation, no-operation quick path.
- **Narrow priority:** Readiness, Production/company, top attention item, active work; supporting metrics disclose below.

## 2. Company Blueprint — business definition

- **Question:** Does the approved business shape still match the data?
- **Primary action:** Review draft changes.
- **Fixture story:** Approved v3 contains three divisions; draft v4 proposes a seasonal inventory rule and one new care-plan segment.
- **States:** Approved, Draft, unsaved-neutral fixture, conflict explanation, disabled publish.
- **Narrow priority:** Version state and changes first; accounting-spine tables become grouped lists.

## 3. Capability Coverage — claims and gaps

- **Question:** Which product or report claim lacks current evidence?
- **Primary action:** Open the highest-priority gap.
- **Fixture story:** The 12 Tier 1 entities and all 48 report rows are inventoried; 30 exact Tier 1 operations, two lower-tier API questions, and all connected-company/dataset evidence remain open; reconciliation is Manual only.
- **States:** Covered, Partial, Manual only, Unknown, Stale, Permission denied.
- **Narrow priority:** Status, tier, capability, and gap action; API detail moves into disclosure.

## 4. Operation Lifecycle — preview, monitor, stop, recovery

- **Question:** Is a bounded August catch-up safe, and what happens after interruption?
- **Primary action:** Continue to Production confirmation (disabled in fixture).
- **Fixture story:** 142 planned work units across 12 steps; 4 QBO write families; 6 req/s provisional budget; one recoverable vendor-bill exception; stop is after the current safe step.
- **States:** Valid preview, Production confirmation, running, backoff, Stopped, Recoverable, Completed with exceptions, QBO upstream error.
- **Narrow priority:** Scope/consequence, durable progress, stop boundary, then event detail.

## 5. Records — QBO and application evidence

- **Question:** What is the selected invoice, how is it related, and what may this role do?
- **Primary action:** Review a proposed field change (fixture only).
- **Fixture story:** Invoice HPO-10482 links to a customer, project, payment, deposit, tax code, and managed-entity provenance.
- **States:** Loaded, Stale, relationship partial, permission denied, QBO upstream error, changed-field preview.
- **Narrow priority:** Identity, balance/status, provenance, relationships; result list becomes a routed summary.

## 6. Reconciliation and Close — period evidence

- **Question:** Can July 2026 be signed off?
- **Primary action:** Resolve three blockers.
- **Fixture story:** Statement difference is zero; two manual QBO reconciliation evidence steps and one stale profitability assertion block sign-off.
- **States:** Prepared, Manual only, Stale, blocked sign-off, Ready checklist item, reopened-history evidence.
- **Narrow priority:** Period/status/variance and blockers first; long ledger lists become local scrollers.

## Fixture review checklist

- Follow each screen from skip link to primary action with keyboard only.
- Confirm focus is visible in light and dark themes.
- Confirm all state meaning survives grayscale and forced colour.
- Review at 1440×1000, 1280×720, 768×1024, 390×844, and 320px width.
- Confirm `documentElement.scrollWidth <= innerWidth` at every viewport.
- Confirm tables either reflow or scroll only inside a labelled region.
- Confirm reduced-motion media rules remove nonessential duration.
- Confirm no action can reach a backend or external origin.

## Planned Phase 4 React slices

1. Tokens, shell, scope strip, page header, status, alert, button, and state primitives.
2. Read-only Overview with fixture-to-route adapter.
3. Read-only Coverage and report evidence.
4. Blueprint version viewer, then separately authorized draft editing.
5. Operation preview and durable monitor without a new mutation executor.
6. Records read path and governed action previews.
7. Reconciliation/close evidence with explicit manual-product boundaries.
