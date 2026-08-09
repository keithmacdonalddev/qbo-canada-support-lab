# Test Data Lab Design System

**Status:** Phase 2 fixture contract accepted 2026-08-09; not imported by the current React application
**Version:** 0.1.0
**Date:** 2026-08-08
**Owner:** Lab owner
**Implementation source:** `frontend/src/styles/rebuild-tokens.css`

## 1. Product design contract

Test Data Lab is an operational instrument for one continuing Canadian test business. It should help an operator answer five questions quickly:

1. Which company and environment am I looking at?
2. Is its business history ready, current, and believable?
3. What capability, report, or record needs attention?
4. What exactly will an action change, and can it be stopped or recovered?
5. What evidence proves the outcome?

The interface is calm, dense, direct, and conservative around consequential actions. It is desktop-first because large comparisons, previews, and records benefit from pointer-and-keyboard precision. Narrow layouts remain complete for review, monitoring, and safe approval, but they do not pretend every bulk-editing task is comfortable on a phone.

This document describes the target rebuild. The current production React routes remain legacy until a separately approved migration slice adopts these contracts.

## 2. Governing principles

### Scope before content

Company, environment, connection, business date, active work, and signed-in role remain visible above route content. Production is a scope classification, not a danger colour. Danger is reserved for irreversible or hard-to-recover consequences.

### Outcome before metrics

Each page begins with the decision it supports. Metrics explain that decision; they do not replace it. A readiness statement and attention queue are more useful than a wall of equal-weight cards.

### Preview before mutation

Consequential work uses explicit verbs and a stable lifecycle:

`Draft → Validate → Preview → Confirm → Run → Monitor → Complete / Stop / Recover`

Generic Save buttons do not initiate QBO writes. Production confirmation names the company, environment, period, operation count, and recovery boundary.

### Evidence beside claims

Coverage, report readiness, operation results, and close status show provenance, observation time, owner, and limitations. `Unknown`, `Manual only`, `Stale`, and `Completed with exceptions` are honest product states.

### Unified, not uniform

Semantic language and safety rules remain stable across viewports. Layout and input model adapt to context. Desktop can be compact; coarse-pointer and narrow views use at least 44px targets, prioritized fields, and routed detail instead of squeezed grids.

### Opaque data planes

Tables, forms, dialogs, diagnostics, and charts use opaque surfaces. Subtle translucency may be considered for nonessential chrome only after contrast and Windows rendering evidence.

## 3. Information architecture

Primary navigation is organized around the continuing-business lifecycle:

| Area | Operational question | Primary routes |
| --- | --- | --- |
| Overview | Is the company ready for support work today? | Readiness, attention, continuity, quick paths |
| Blueprint | What is this business supposed to contain? | Identity, operating lines, dimensions, accounting spine, versions |
| Coverage | Which capabilities and reports are represented and proven? | Capability registry, reports, gaps, evidence |
| Calendar | What business period is complete, due, planned, or running? | Schedule, operation preview, monitor, recovery |
| Records | What exists in QBO and in the application? | QBO records, app records, relationships, governed actions |
| Close | Are the period, reconciliations, reports, and sign-offs complete? | Reconciliation, close checklist, manual evidence |
| Administration | Who can act, how is the company connected, and what happened? | Users and roles, connection, settings, audit |

On desktop the primary areas use a persistent left rail. At narrow widths they move into a labelled menu sheet; the scope strip remains in the page flow.

## 4. Shell and layout

### Persistent shell

- Left rail: 240px desktop; compact icon mode may be considered only when every icon retains a tooltip and accessible name.
- Scope strip: environment, company, connection, business date, active operation, and role.
- Content: maximum 1600px, fluid inside 24–32px desktop gutters and 16px narrow gutters.
- Page header: breadcrumb, H1, one-sentence outcome, primary action, then secondary actions.
- Sticky regions: use only for scope, table headers, or operation controls whose loss would make the task unsafe.

### Responsive thresholds

| Width | Target behaviour |
| --- | --- |
| 1280px and above | Full rail, multi-column summaries, dense grids, side inspectors |
| 768–1279px | Collapsible rail, two-column content, reduced supporting columns |
| 480–767px | Menu sheet, stacked regions, row summaries, full-width action bar |
| 320–479px | Single column, priority metadata, routed detail, no page-level horizontal overflow |

A component may scroll horizontally only when the content is intrinsically tabular or diagnostic. The page itself must not overflow.

## 5. Semantic tokens

The machine-readable proposal lives in `frontend/src/styles/rebuild-tokens.css`. Names describe role, not a specific hex value.

### Colour roles

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#f4f6f8` | `#0c121c` | Page background |
| Surface | `#ffffff` | `#121b28` | Cards, forms, grids |
| Primary text | `#172033` | `#f3f6fa` | Headings and body |
| Secondary text | `#526078` | `#c5cfdb` | Supporting detail |
| Accent | `#2563eb` | `#6ea8fe` | Primary action and selection |
| On accent | `#ffffff` | `#0c121c` | Text and icons on filled accent controls |
| Success | `#15803d` | `#61c784` | Completed or verified |
| Warning | `#a84f08` | `#f4b45f` | Attention and recoverable risk |
| Danger | `#b42318` | `#ff8c82` | Destructive or failed consequence |
| Unknown | `#596579` | `#b0bac8` | Evidence not established |
| Production | `#8b1e3f` | `#ff9cbd` | Environment classification only |

All status uses text plus colour and, when compact, a symbol. Charts pair colour with labels, values, points, or line patterns.

### Type

The stack is `Geist Variable`, then the Windows-native `Segoe UI Variable`, `Segoe UI`, and system sans-serif. No webfont is required. Dense data remains at 14px/20px. Form labels are 13px/18px. Metadata is 12px/16px. Page titles are 22px/28px and the largest display statement is 28px/34px. Monospace values use Cascadia Mono or Consolas.

### Space, shape, elevation

- Four-pixel spacing rhythm: 4, 8, 12, 16, 20, 24, 32, 40, 48.
- Controls: 32px compact, 36px default, 44px touch/narrow.
- Radius: 8px inner, 10px controls, 14px panels, 16px elevated layers.
- Shadows indicate layering, never category or status.
- One-pixel borders define dense groups more reliably than large shadows.

### Motion

- Direct feedback: 140ms.
- Expansion: 200ms.
- Navigation/context change: 220ms.
- Use motion to explain causality, ordering, or focus movement.
- Under `prefers-reduced-motion: reduce`, transitions become effectively immediate and no content depends on animation.

## 6. Action hierarchy

| Level | Treatment | Examples |
| --- | --- | --- |
| Primary | Filled accent, normally one per page region | Review preview, Continue to confirmation |
| Secondary | Opaque surface with border | Export evidence, Compare version |
| Tertiary | Text or quiet button | Reset filters, View source |
| Destructive | Danger treatment; never the page default | Delete draft, abandon unstarted plan |
| Stop | Warning treatment, not danger by default | Stop after current safe step |
| Disabled | Native disabled state plus nearby reason | Production run unavailable until approval |

Buttons use direct verbs. `Run` is insufficient; prefer `Run July close preview`, `Start approved backfill`, or `Stop after current safe step`.

## 7. Status language

| State | Meaning | Required next-step language |
| --- | --- | --- |
| Ready | Prerequisites and current evidence support the task | Name the available action |
| Partial | Some work succeeded or evidence is incomplete | Name completed and remaining units |
| Stale | Evidence may no longer describe current state | Show observation time and refresh path |
| Manual only | The official product action is outside approved API automation | Link or describe the manual procedure |
| Unknown | Discovery or observation is incomplete | Assign owner and resolution path |
| Permission denied | The current role cannot perform the action | State required permission without exposing policy internals |
| QBO upstream error | The connected service rejected or could not complete a request | Show safe message, retry guidance, and `intuit_tid` when available |
| Stopped | The operator requested a bounded stop | Name the last completed safe unit and resumability |
| Recoverable | A defined resume, retry, adopt, or manual-review path exists | Present only valid recovery actions |
| Completed with exceptions | The operation ended but not every intended unit succeeded | Summarize exceptions and evidence |

## 8. Component contracts

The full state matrix is in `docs/design/component-state-matrix.md`. These rules apply globally:

- Inputs have persistent labels; placeholder text is never the only label.
- Icon-only controls have accessible names and visible focus.
- Data grids have captions or adjacent summaries, sortable headers expose sort state, and row actions name their record.
- Empty, loading, partial, stale, permission, upstream, and retry states are designed before the happy path is considered complete.
- Dialogs keep a stable outer frame, scroll internally, restore focus, and do not hide consequence below a viewport edge.
- Inspectors preserve list context on desktop and become routed detail or near-full sheets on narrow screens.
- Operation progress uses durable work units; animation is supplemental.
- Diagnostics are sanitized and bounded. Secrets, tokens, raw authorization headers, and user-provided keys never appear.

## 9. Data presentation

### Tables and records

Tables prioritize the fields needed for a decision. Low-priority columns can be disclosed in a row inspector; they must not disappear without another reachable presentation. Monetary values align by decimal, negative values use a minus sign, and currency is explicit when it could be ambiguous. Dates use `8 Aug 2026` in prose and `2026-08-08` in diagnostics.

### Charts

Every chart includes a plain-language summary and an accessible value table or equivalent list. Axes and units are labelled. Empty and partial data are not silently plotted as zero. Tooltips supplement visible information rather than being the only way to retrieve values.

### Evidence

Evidence cards show claim, method, observed time, source, owner, status, and limitation. Manual evidence distinguishes app-tracked completion from an official QBO-confirmed state.

## 10. Content rules

- Use the public name **Test Data Lab** in navigation and public surfaces.
- Use **QuickBooks Online** only where the official product relationship must be clear; do not abbreviate it in public product naming.
- Say what happened before why it might have happened.
- State Production, company, period, record count, and consequence before confirmation.
- Avoid false certainty: `Not observed`, `Manual only`, and `Unknown` are acceptable.
- Do not expose raw provider exceptions to users. Preserve sanitized diagnostics and request IDs for evidence.
- Empty states explain why the area is empty and offer one valid next step.
- Error recovery is a product path, not a terminal log instruction.

## 11. Accessibility contract

WCAG 2.2 AA is the release target.

- One H1 per page; headings follow content order.
- Skip link, navigation landmark, scope region, main landmark, and named complementary regions.
- Entire critical workflow is keyboard reachable with visible focus and logical order.
- Pointer targets are at least 24×24 CSS pixels with spacing on desktop and 44×44 on coarse-pointer/narrow layouts.
- Text contrast targets 4.5:1; large text and non-text UI target 3:1.
- Status is never colour-only.
- Live regions are reserved for material asynchronous changes and do not announce every progress tick.
- Tables reflow to prioritized row summaries or remain inside a clearly labelled local scroller.
- At 200% zoom and 320px width, consequence and recovery controls remain reachable.
- Forced-colour and reduced-motion modes preserve meaning.

Fixture prototypes prove structure, reflow, initial keyboard entry, and token contrast. Complete workflow keyboard, NVDA, forced-colour, and live focus-management acceptance remain required during React migration.

## 12. Critical workflow briefs

### Overview

Decision: is Harbour & Pine ready for support work? Show scope, one readiness statement, current business date, active work, continuity, report health, and a ranked attention queue. Quick paths create previews or navigate; no mutation begins here.

### Company Blueprint

Decision: does the approved business definition still match the dataset? Show version state, three operating lines, dimensions, accounting spine, realism rules, and an explicit draft-versus-approved comparison. Publishing a blueprint is an app-data decision, not a QBO write.

### Capability Coverage

Decision: which feature or report claim lacks evidence? Support product/API/manual classification, tier, state, prerequisites, evidence age, owner, and gap action. Filters must expose `Manual only` and `Unknown`, not hide them.

### Operation lifecycle

Decision: is this exact operation safe to start, and what should happen if it stops? One stable frame covers preview, confirmation, running progress, safe stop, backoff, partial completion, retry, resume, adoption, and manual review. Production execution remains disabled in fixtures.

### Records

Decision: what record exists, how is it related, who manages it, and which actions are permitted? Search results, record detail, links, provenance, stale state, permission error, and changed-field review coexist without presenting the app as a second ledger.

### Reconciliation and Close

Decision: can the period be signed off, and which steps require official-product evidence? Show bank statement facts, variance, outstanding items, report assertions, manual reconciliation boundary, sign-offs, reopen history, and evidence age.

## 13. Migration map

The owner accepted the fixture gate on 2026-08-09. React migration now proceeds in bounded Phase 4 slices, with real interaction and assistive-technology evidence retained as release gates.

1. Extract semantic tokens into the existing CSS pipeline; add token contrast and reduced-motion tests.
2. Build shell, scope strip, page header, status, alert, button, and state primitives behind a rebuild feature flag.
3. Migrate a read-only Overview vertical slice using fixture/API adapters; preserve current routes as rollback.
4. Add read-only Coverage and Reports; validate keyboard, NVDA, reflow, and error states against live route contracts without QBO mutation.
5. Add Blueprint drafts and app-data permissions only after server-owned authorization is approved.
6. Add operation preview/monitor before any new executor; execution remains a later safety-reviewed phase.
7. Migrate Records and Close as bounded vertical slices with feature-level rollback.
8. Retire legacy navigation only after parity, audit, and owner acceptance.

## 14. Governance and evidence

A component or route is not accepted because it looks polished. Each migrated slice records:

- approved workflow brief and fixture states;
- token and component conformance;
- build, lint, unit/interaction, accessibility, and responsive results;
- light and dark desktop and narrow screenshots;
- keyboard and NVDA notes;
- route/API state matrix;
- Production/QBO mutation checks explicitly skipped or separately authorized;
- rollback path and unresolved limitations.

Changes to safety semantics, Production treatment, confirmation grammar, or core tokens require design-owner and safety review. Run `npm run verify:design:browser` to regenerate the 28 exact-viewport screenshots and 70 structural/interaction checks from local-only fixtures. The evidence manifest records browser/tool versions plus source and screenshot hashes under `artifacts/rebuild/design-evidence/`; conclusions live in `docs/design/rendered-review.md`, and the release checklist is `REBUILD_RELEASE_EVIDENCE.md`.
