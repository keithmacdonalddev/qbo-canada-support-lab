# Rendered design review

**Status:** Accepted at the Phase 2 fixture-design gate; React-migration assistive-technology acceptance remains open
**Reviewed:** 2026-08-09
**Scope:** Standalone Phase 2 fixtures only. No application server, QBO request, OAuth flow, or database operation was used.

## Evidence set

`npm run verify:design:browser` uses Playwright Core with the installed local Chrome to regenerate every artifact through a short-lived, local-only fixture server. It captures each workflow and the design guide in both themes at exact desktop and narrow viewport sizes.

| Surface | Light 1440×1000 | Light 390×844 | Dark 1440×1000 | Dark 390×844 |
| --- | --- | --- | --- | --- |
| Overview | [render](../../artifacts/rebuild/design-evidence/overview-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/overview-390x844.png) | [render](../../artifacts/rebuild/design-evidence/overview-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/overview-dark-390x844.png) |
| Company Blueprint | [render](../../artifacts/rebuild/design-evidence/blueprint-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/blueprint-390x844.png) | [render](../../artifacts/rebuild/design-evidence/blueprint-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/blueprint-dark-390x844.png) |
| Coverage | [render](../../artifacts/rebuild/design-evidence/coverage-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/coverage-390x844.png) | [render](../../artifacts/rebuild/design-evidence/coverage-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/coverage-dark-390x844.png) |
| Operation lifecycle | [render](../../artifacts/rebuild/design-evidence/operation-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/operation-390x844.png) | [render](../../artifacts/rebuild/design-evidence/operation-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/operation-dark-390x844.png) |
| Records | [render](../../artifacts/rebuild/design-evidence/records-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/records-390x844.png) | [render](../../artifacts/rebuild/design-evidence/records-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/records-dark-390x844.png) |
| Reconciliation and Close | [render](../../artifacts/rebuild/design-evidence/close-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/close-390x844.png) | [render](../../artifacts/rebuild/design-evidence/close-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/close-dark-390x844.png) |
| Design guide | [render](../../artifacts/rebuild/design-evidence/design-guide-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/design-guide-390x844.png) | [render](../../artifacts/rebuild/design-evidence/design-guide-dark-1440x1000.png) | [render](../../artifacts/rebuild/design-evidence/design-guide-dark-390x844.png) |

[browser-review.json](../../artifacts/rebuild/design-evidence/browser-review.json) records the exact command, generation time, Node/Playwright/Chrome/platform versions, Git HEAD, complete fixture-source hashes, their tree hash, and every screenshot hash. `npm run validate:design` rejects missing source-hash entries, stale sources, stale screenshots, wrong dimensions, truncated PNG streams, or incomplete page/theme/viewport coverage.

## Automated browser review

The evidence manifest records 70 passing page/theme/viewport combinations:

- seven surfaces in light and dark at 1440×1000, 1280×720, 768×1024, 390×844, and 320×800 CSS pixels;
- one document language, one main landmark, one H1, unique IDs, sequential headings, valid skip target, labelled form fields, and named controls;
- no page-level horizontal overflow, external network request, console error, or uncaught page error;
- 24px minimum active targets on desktop/tablet and 44px on narrow viewports;
- the first Tab reveals the skip link;
- active work and role remain visible throughout each scoped workflow;
- at 390px and 320px, Menu opens the navigation sheet, focus moves inside it, Escape closes it, and focus returns to Menu;
- the requested light or dark theme is actually applied; and
- every disabled button uses effective opacity 1 and meets 4.5:1 computed contrast.

The fixture server sends a restrictive Content Security Policy, while Playwright independently aborts and records any request whose origin is not that one ephemeral local server. Static validation also scans the full fixture dependency graph—HTML, JavaScript, and CSS—for remote dependencies and network-capable calls.

This is a deterministic structural and interaction audit. It is not an axe, NVDA, Windows forced-colours, or live React acceptance run, and the evidence does not imply those checks occurred.

## Contrast, motion, and theme findings

`npm run validate:design:contrast` checks 26 semantic foreground/background pairs in light and dark themes against 4.5:1, including explicit disabled-control foreground and surface pairs. Disabled states no longer rely on parent opacity.

Static validation confirms reduced-motion and forced-colour contracts. Both themes are rendered across all seven surfaces. Manual Windows forced-colours and NVDA task walkthroughs remain required when the fixtures are migrated into React and real route/focus behaviour exists.

## Visual conclusions

- Scope stays visible before content: Production, company, connection, period/date, active context, and role.
- Each page leads with one operational question and one principal action.
- Status language distinguishes fixture evidence, manual-only work, unknowns, stale proof, stopped work, and recovery.
- Desktop remains compact and multi-column; narrow layouts prioritize scope, consequence, primary action, and summary while keeping navigation reachable.
- The operation frame keeps preview, monitor, safe stop, exception, and recovery language together without authorizing execution.
- The automated fixture checks contain no known critical visual, navigation-reachability, or structural accessibility blocker.

## Open acceptance work

- Manual NVDA and Windows forced-colours walkthroughs after React migration.
- Application component and route interaction tests after real components replace static fixtures.
- Live-route error, loading, permission, and focus-return checks without QBO mutation.

The lab owner accepted the visual direction and all six workflows on 2026-08-09. The remaining items are Phase 4 implementation gates; they do not reverse the Phase 2 fixture-design acceptance or imply that live React accessibility has already passed.
