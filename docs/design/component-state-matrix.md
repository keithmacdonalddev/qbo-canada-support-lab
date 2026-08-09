# Component and State Matrix

**Status:** Phase 2 fixture contract accepted 2026-08-09
**Target:** Rebuild component contracts; not a claim about current legacy routes

Every component communicates state with text plus structure or icon. Colour is supporting evidence only.

## Foundational contracts

| Component | Purpose and non-purpose | Required states | Keyboard/focus contract | Narrow/touch contract | Verification |
| --- | --- | --- | --- | --- | --- |
| App shell | Keeps navigation and scope stable; not a route-specific dashboard | Default, rail collapsed, menu open, offline/stale scope | Skip link; landmarks; focus order rail → scope → page; collapse button named | Rail becomes labelled sheet; scope remains visible | Landmark, tab order, 320px reflow, desktop/narrow render |
| Scope strip | Shows company, environment, connection, business date, active work, user role; not a settings form | Production, sandbox, disconnected, stale, paused, running | All controls named; status text readable without icons | Compact two-line header; no essential item disappears | Contrast, wrapping, status semantics |
| Page header | States the route's operational question and primary action | Default, no action, blocked action, stale context | Heading precedes controls; disabled reason programmatically linked | Action remains reachable or moves to stable action row | Heading order, focus, 200% zoom |
| Button / icon button | Executes one explicit command; not a hidden menu unless labelled | Default, hover, focus, pressed, loading, disabled, destructive | Native button; visible focus; icon-only has accessible name | Primary touch actions at least 44×44 | Interaction, accessible name, visual states |
| Split button / menu | Separates default action from alternatives; not for destructive ambiguity | Closed, open, selected, disabled, loading | Arrow keys, Escape, focus return, current item announced | Full-width menu sheet if needed | Menu keyboard and focus restoration |
| Text input / textarea | Collects one labelled value | Empty, populated, focus, read-only, disabled, invalid, warning, saved | Label association; error/help references; no placeholder-only label | 44px control height; no viewport zoom trigger | Label/error relationships, reflow |
| Select / combobox | Chooses from known values; not a substitute for readable content | Empty, populated, open, filtered, no result, invalid, disabled | Arrow keys, typeahead, Escape, focus return | Sheet/listbox with reachable options | Keyboard, touch target, active descendant |
| Date/period picker | Selects business dates with scope; not a free-form ambiguous date | Empty, selected, invalid range, closed period, timezone note | Text entry fallback; grid keyboard where used | Month/period-first sheet; no tiny calendar cells | Date semantics, closed-period warning |
| Checkbox/radio/switch | Captures explicit boolean or one-of-many choice | Checked, mixed, focus, disabled, invalid | Native semantics and grouped labels | Label is part of 44px target | State announcement and hit target |
| Data grid | Finds and compares records; not an unbounded client-side dump | Loading, empty, populated, sorted, filtered, selected, stale, partial, error, permission | Caption/summary; header/sort state; row action names; focus not trapped | Priority row summaries and routed detail; diagnostic horizontal scroll only | Pagination contract, keyboard, 320px reflow |
| Card/section | Groups related content; not an equal-weight metric wall | Default, selected, stale, warning, disabled | Semantic heading; interactive card has one clear control | Stacks without excessive whitespace | Heading order and responsive layout |
| Badge/status marker | Provides compact classification; not the sole state signal | Success, info, warning, danger, unknown, production, manual | Text always present; tooltip only supplements | Wraps without truncating meaning | Contrast and non-colour cue |
| Alert/banner | Explains what happened and recovery; not a transient substitute for blocking errors | Info, success, warning, error, stale, permission, upstream | Alert/live role selected to avoid noise; actions keyboard reachable | Text/action stack; no horizontal overflow | Announcement policy, long-copy reflow |
| Toast | Confirms non-blocking outcomes; not the only record of an operation | Info, success, error; timed and persistent | Pause/dismiss reachable; critical error also inline | Fits viewport with 16px margins | Timing, dismiss, live-region noise |
| Dialog / confirmation | Holds a bounded decision; not a generic page container | Open, validation error, loading, success, destructive | Focus trap, initial focus, Escape rules, focus restore | Stable outer frame; internal scroll; full-width margins | Keyboard, focus restoration, 200% zoom |
| Drawer/inspector | Preserves list context while showing detail | Closed, open, loading, stale, unsaved | Named region; close control; focus return | Becomes routed detail or near-full sheet | Selection persistence and overflow |
| Empty/loading/stale/error state | Makes missing or uncertain data actionable | Empty, loading, stale, unavailable, partial, permission, upstream QBO, retrying | Status/alert semantics as appropriate; retry named | Message and action remain above fold when practical | State fixtures and screen-reader text |
| Progress/stepper | Explains known work; not an indeterminate spinner when units exist | Planned, running, paused, partial, failed, stopped, complete | Current step and value announced without noisy updates | Summary first; details disclose below | Durable-state fixture and live-region policy |
| Operation timeline/event log | Shows durable work and recovery evidence | Info, warning, error, QBO call, retry/backoff, redacted detail | Filters named; events are ordered list; copy controls named | Compact event summaries; details expand | Sanitization, timestamps, intuit_tid copy |
| Diff/change summary | Shows exact proposed or completed field changes | Added, changed, removed, unchanged, conflict | Before/after labels and semantic table/list | One field per row; no side-by-side squeeze | Long value wrap and non-colour diff cues |
| JSON/diagnostic viewer | Exposes sanitized structured details; not raw secret storage | Collapsed, expanded, copied, redacted, unavailable | Disclosure and copy keyboard accessible | Wrap/scroll inside bounded panel | Secret fixture checks and overflow |
| Chart + table | Shows trend with accessible source values; not decorative analytics | Loading, empty, populated, stale, partial | Text summary and data table always available | Summary first; chart optional below | Colour/pattern distinction and table parity |

## Workflow state coverage

| Critical workflow | Empty/loading | Populated | Stale/partial | Permission/upstream error | Consequential confirmation/recovery |
| --- | --- | --- | --- | --- | --- |
| Company readiness | No company, loading scope | Ready and needs-attention fixtures | Stale report, continuity gap | Connection/QBO error | Quick paths create previews only |
| Business blueprint | New draft, loading version | Approved version and editable draft | Conflict and old-version drift | Cannot publish | Side-by-side publish review; no QBO write |
| Coverage gap | Empty filter, loading registry | Covered/manual/unknown mix | Stale evidence, partial dataset | Cannot create task/plan | Gap action creates draft plan/manual task |
| Operation lifecycle | Loading preview | Valid preview and running monitor | Partial completion, paused/backoff | Prerequisite, permission, QBO error | Production confirmation, stop boundary, resume/retry/adopt/manual review |
| QBO record management | No result, loading detail | Record, relationships, policy actions | Stale record/concurrency conflict | Permission/QBO upstream | Changed-field review; void/delete separate |
| Reconciliation/close | No statement, loading period | Prepared zero-difference period | Outstanding items, stale evidence | Cannot sign off | Manual QBO boundary, sign-off, reopen audit |

## Global fixture states

The static prototypes must make these labels visible somewhere in the gate: `Loading`, `Empty`, `Ready`, `Partial`, `Stale`, `Manual only`, `Unknown`, `Permission denied`, `QBO upstream error`, `Production`, `Stopped`, `Recoverable`, and `Completed with exceptions`.

Automated fixture checks cover structure, labels, links, viewport overflow, and reduced-motion CSS. Manual NVDA, forced-colour, and final focus-management acceptance remain required after the React implementation exists.
