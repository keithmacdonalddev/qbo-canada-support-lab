# TODO: overhaul the landing page (`/company`)

Status: **open, not started.** Owner asked on 2026-10-31 to record this so future agents know the landing page needs an overhaul. Build a polished, rendered slice and get the owner's acceptance before broad adoption (see `AGENTS.md`, "User experience comes first").

The landing page is the Business page: `/` redirects to `/company`, which renders `frontend/src/pages/BusinessWorkspace.jsx`. Its data comes almost entirely from `GET /api/company/business-agent` (fields under `data`).

## What the owner needs from the first page

From `prd.md` and `docs/plans/continuous-business-operator-completion-2026-10-24.md` (R01–R16):

1. Does the company look like a real, medium-sized business that runs continuously?
2. Is the accountant working, and on what?
3. Which QuickBooks features are used, and which are missing?
4. What is blocked, and what is the accountant doing about it?

## Review of the current page (2026-10-31)

Always shown, at the top:

| Section | What it does | Verdict |
|---|---|---|
| Company name, sync dot, warnings | Connection health; warnings only when something is wrong | Keep |
| **Live** (`BusinessLive.jsx`) | Current work, today's progress, model messages, reasoning, tool calls and saved records | Keep the top line and progress. Collapse the transcript. |
| **Today's plan** + **Build list** (`BusinessTodayPlan.jsx`) | Daily review findings per goal, today's changes, records vs target, missing tools | Keep the plan. Move the build list to a details page. |
| **The accountant's work** (`BusinessWork.jsx`) | Standing duties, blocked items, owner-only items | Merge with "problems" |
| Four tiles | Customer balances, supplier balances, customer/supplier counts, records through | Replace with business-health measures |

Below, three tabs:

- **Overview** (default): Main accountant (status, last/next review, books verified through) with **AI usage & limits**; Recent company activity (12 records); Decisions & direction; Accountant's activity (5 events); links.
- **Activity & monitoring**: full event list, per-type sync status, specialists.
- **Directions & controls**: owner instructions, specialists, add a sale or expense manually, capability list, start/stop, review frequency.

## Problems found

- **Status repeated four times.** Live, The accountant's work, Main accountant and Accountant's activity all describe the accountant's state.
- **Developer-facing detail on the first page:** AI usage and token cost, per-entity sync sources, raw tool-call transcript, capability list.
- **Missing: whether the business looks real** (goal 1):
  - no sales/expenses trend;
  - no cash, and no AR/AP aging;
  - no records today by type against the 220/day target.
- **Missing: coverage** (goal 3). It lives on `/coverage` and `/company/manage`.
- **Leftover sessions/slots language** in places, although the accountant now works continuously (commit 4d1bbdc).

## Pages deliberately not on the landing page

| Page | Purpose | Why separate |
|---|---|---|
| `/company/manage` (`Company.jsx`) | Business plan, publication and calendar, saved-plan approvals, bulk history, report observations, connection, "What's in the books", coverage | Built for the setup era when the owner approved and published. Now mostly one-time setup or recovery. Audit it for obsolete panels. |
| `/company/setup` (`CompanySetup.jsx`) | Access, storage, write preparation | One-time setup; duplicates a Manage panel |
| `/company/accountant/tools` (`AccountantTools.jsx`) | Tool and skill catalog, QuickBooks reach | Reference |
| `/company/reports` (`BookChecks.jsx`) | Seven-report book checks for a date range | Evidence, on demand |
| `/company/period-close` (`Reconciliation.jsx`) | Closing and reconciliation cutoffs, reopen | Monthly, manual |

## Proposed direction (needs owner acceptance of a rendered slice)

1. **Top:** one live status line ("Working continuously", or the exact reason it is paused), today's records vs target, and records by type.
2. **Business health:**
   - sales and expenses month to date vs last month;
   - cash;
   - AR/AP aging.

   Source: `queryCompanyData` / the management review measures, computed from the synced copy with no QuickBooks calls.
3. **Coverage:** QuickBooks features used vs missing, from the management review's coverage snapshot.
4. **Problems:** what is blocked and what the accountant is doing about each, plus anything only the owner can decide.
5. **Moved to one "Accountant details" page:**
   - transcript;
   - AI usage;
   - per-type sync;
   - capability list;
   - build list;
   - specialist and frequency controls.
6. **Audit `/company/manage`** and remove panels made obsolete by autonomous operation.

Full section-by-section inventory, with data sources and actions, was produced by GPT-6.1 Sol on 2026-10-31. Regenerate it from the source files above rather than trusting this summary if the page has changed.
