# UX overhaul: issue-first direction (2026-10-02)

**Status:** Built for owner review. Supersedes the earlier "Today dashboard" attempt from the same day, which the owner rejected.

## The owner's answers that drive it

The owner wants the app to do three things:

1. **Reproduce customer issues.** Describe the issue to an AI, and the AI creates or edits whatever QuickBooks data is needed to replicate it.
2. **Keep the company realistic.** This should take one "catch up" decision, not a form.
3. **Check the data.** The owner looks at records both inside this app and in QuickBooks itself.

## Structure

| Nav | Route | Job |
| --- | --- | --- |
| Reproduce | `/` | Describe the issue → case |
| (case) | `/cases/:id` | Conversation · proposed changes · run · links into QuickBooks · case note |
| Company | `/company` | Days behind + "Catch up to today", connection, counts, coverage |
| Records | `/explorer` | Browse data in-app |
| History | `/audit` | What the lab did |

**Settings** sits at the bottom of the rail. The old AI console, issue packs and checkpoints are under a collapsed **Legacy tools** menu.

**A case moves through four stages, shown as a stepper:** Describe → Review changes → Run → Check in QuickBooks. Nothing is written until the operator approves. In production, the existing typed-confirmation dialog also applies.

When QuickBooks is unusable, one bar under the scope strip explains the problem and offers the fix on every page (`ConnectionContext` + `Layout`).

## AI provider and write tools (2026-10-02)

- **Codex CLI:** the assistant uses the signed-in Codex CLI (owner's ChatGPT subscription) when `AI_PROVIDER=auto` and Codex is available. This pattern comes from the Alfred app.
- **Codex isolation:** Codex runs isolated. It has no shell, file, web or plugin tools, gets a minimal environment with no backend secrets, and is stopped if it emits any unexpected event type. The app's tools reach Codex over a per-run MCP endpoint at `/api/ai-tools/mcp`, protected by a random in-memory token and capped at 40 calls per run.
- **Write tools:** `createRecord`, `updateRecord` (a sparse update) and `voidTransaction` cover the main QBO entities. Every write is queued for approval, and there is no delete. A plan step can use values from an earlier step with `{{stepN.id}}`.
- **Running a plan:** this still requires `LEGACY_AI_MUTATIONS_ENABLED=true`, plan approval and, in production, the typed confirmation.
- **Catch up to today:** this links to `/lab`. That page's generation API is being reworked in a parallel session.

## Visual system

The owner requested Alfred-style dark mode on 2026-10-02. The default theme uses Alfred’s Black Glass palette: black canvas, charcoal panels, soft white text and cyan actions, while preserving status colours and a distinct Production marker. Geist and the existing layout remain. Dark tokens and legacy colour compatibility live in `frontend/src/styles/dark-mode.css`; shared aliases and the light fallback remain in `frontend/src/index.css`. The HTML root enables dark mode before React renders.
