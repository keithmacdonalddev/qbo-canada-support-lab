# Test Data Lab Design Decision Record

**Decision:** Apply the research principles to Test Data Lab without imitating Apple products
**Status:** Accepted by the lab owner for Phase 2 on 2026-08-09
**Date:** 2026-08-08
**Sources:** rebuild plan section 18 and `C:\Projects\qbo-escalations\docs\research\apple-design-systems\apple-design-systems-research.md`

## Outcome

Test Data Lab uses the research's reasoning method—purpose, agency, responsibility, familiarity, flexibility, craft, and context—to design a calm operational instrument. It does not copy Apple styling, platform components, proprietary symbols, logos, materials, or product layouts.

The governing phrase is **unified, not uniform**: company scope, status semantics, action grammar, and evidence language remain stable; desktop and narrow layouts adapt to different input precision and task duration.

## Adopted

| Research idea | Test Data Lab decision | Observable result |
| --- | --- | --- |
| Purpose before features | Every route starts with the operational question it answers | Page brief and title state the decision, not the database object |
| Agency | Preview, approve, stop, resume, retry, and recover are explicit commands | No consequential mutation begins from a generic Save button |
| Responsibility | Environment, company, period, consequence, permissions, and evidence are visible | Persistent scope strip plus stronger confirmation at mutation points |
| Familiarity | Use labelled navigation, tables, forms, breadcrumbs, dialogs, and direct verbs | Keyboard/pointer workflows do not depend on hidden gestures |
| Hierarchy | One primary outcome precedes supporting metrics and detail | Overview begins with a readiness statement and attention queue |
| Semantic colour | Colour communicates role rather than decoration | Production, danger, unknown, warning, and accent are separate tokens and always have text/icon cues |
| Opaque content surfaces | Dense data remains stable and legible | Cards, forms, tables, diagnostics, and dialogs are opaque |
| Concentric geometry | Nested surfaces share deliberate radii | 8px inner, 10px controls, 14px panels, 16px elevated layers |
| Motion as causality | Motion explains expansion, ordering, or state change | 140ms direct feedback; 200–220ms panels/navigation; reduced-motion becomes immediate |
| Accessibility as a constraint | Keyboard, focus, reflow, contrast, target size, and assistive semantics are component contracts | State matrix and viewport evidence are required before route migration |

## Adapted

| Research idea | Adaptation for this product | Reason |
| --- | --- | --- |
| Cross-platform harmony | Desktop is dense and precise; narrow views prioritize monitoring, review, and safe approval | A 390px screen should not become a compressed bulk editor |
| Materials and translucency | Optional subtle translucency is limited to chrome; current prototypes use opaque chrome | Data legibility and Windows support matter more than material novelty |
| Direct manipulation | Filters, row selection, inspectors, and previews update visibly; mutation still needs explicit authorization | Immediate feedback must not bypass server-owned safety |
| Delight | Fast feedback, helpful empty states, preserved context, and graceful recovery | Decorative motion would compete with consequential work |
| Simplicity | Reduce ambiguity and memory burden, not useful density | Operators need breadth, but status and consequence need a clear order |

## Rejected

| Rejected direction | Why |
| --- | --- |
| Apple visual imitation | It would be derivative, platform-inappropriate on Windows/web, and unrelated to the product's operational identity |
| Apple logos, SF Symbols, proprietary materials, or unlicensed assets | Licensing and identity conflict; Lucide and CSS-native diagrams provide an open grammar |
| Glass-on-glass data panels | Stacked transparency reduces contrast and makes dense financial data unstable |
| Mobile as a scaled desktop | It creates unreachable controls and unsafe partial mutation forms |
| Metric-card wall as Overview | Equal visual weight hides the actual readiness decision and attention queue |
| Colour-only status | It fails accessibility and makes production/danger/unknown easy to confuse |
| Ambient animation, parallax, or success celebrations | Motion must not delay input or obscure interrupted/partial outcomes |
| A second UI framework or Storybook by default | The existing Vite, React, Tailwind, Base UI, shadcn-style primitives, and Lucide stack is adequate; the static showcase is the lighter Phase 2 gate |

## Evidence and follow-up

- `DESIGN.md` defines the target system and separates it from current legacy source.
- `DESIGN.HTML` teaches the system without a build step and is the canonical standalone visual-guide filename.
- `frontend/src/styles/rebuild-tokens.css` contains the proposed semantic tokens but is intentionally not imported by the current app.
- `prototypes/rebuild/` contains fixture-only workflow designs and component states.
- Desktop and narrow fixture evidence was rendered and accepted on 2026-08-09.
- React migration proceeds in bounded Phase 4 slices; this acceptance does not authorize Production operations.
- NVDA, forced-colour, and live-route review remain future acceptance steps; fixture rendering cannot substitute for them.
