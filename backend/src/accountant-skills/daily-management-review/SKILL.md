---
name: daily-management-review
description: The first review of each day: findings per requirement (R01, R02, R04, R05, R06, R11) from context.management, today's changes, capability requests, and recordDailyPlan once. Use when context.cadence.kind is management or no plan exists for today.
---

# Daily management review

Runs once a day at 00:10 Halifax, after the previous day's close and before the 00:30 slice (`context.cadence.kind` is `management`). The day's saved plan ends it; a repeated call returns the saved plan. Later reviews follow `context.todaysPlan`.

## Procedure
Copy and tick:
```
- [ ] 1. Recover or note unfinished work and the next calendar close
- [ ] 2. Read the measures (context.management) and freshness
- [ ] 3. One finding per requirement
- [ ] 4. Decide today's changes
- [ ] 5. File capability requests for confirmed gaps
- [ ] 6. recordDailyPlan (once)
- [ ] 7. Optional: list additions now, in their own batch
```

`recordDailyPlan` and `requestCapability` are deferred tools: load both once with `searchTools({query:"select:recordDailyPlan,requestCapability"})`, then call them with `useTool({name, input})`.

Outside the management review, `getBusinessState` carries `management` (today's plan and the open build-request keys), and the deferred `getManagementReview` returns the full measures, gaps, tool map and build list. Read it before any `requestCapability` so a known gap reuses its key. When an earlier preview expired unsent (an earlier day, no saved records), prepare today’s work under a new `decisionKey`: that is correct, not a bypass.

1. **Unfinished work first.** If `context.unfinishedOperations` is not empty, resume it before planning anything new; note `context.calendarClose`.
When an operation is blocked or needs-check, call inspectBlocker({operationId}) and requestCapability with the exact cause: the recorded error/diagnostic, stopped step, differing approved/current fields and record/version mismatch. Load the deferred tools with searchTools({query:"select:inspectBlocker,requestCapability"}) and call them through useTool. Reuse an existing build-request key for the same gap; disclose unavailable historical values, preserve saved receipts, and continue independent permitted work.

2. **Measures.** `context.management` holds measures from the local company copy: activity versus target, coverage gaps, problems, owner answers, the responsibility-to-tool map and open build requests. Confirm anything surprising with one `queryCompanyData` aggregate (see business-analysis-and-advice).
3. **Findings** (status `on-track`, `attention` or `gap`), one per requirement:
   - **R01** support usefulness and feature coverage: which scenarios and features exist, which are missing.
   - **R02** volume and growth: yesterday's records versus target; customers, suppliers and items growing with volume.
   - **R04** management and advice: cash, margins, AR and AP aging, stock, pricing, seasonality.
   - **R05** tools: gaps between responsibilities and tools.
   - **R06** owner direction: owner instructions and answers applied.
   - **R11** explanation: what happened yesterday, what is unfinished.
4. **Changes** (at most ten, each with an `area` and optional `count`): for example `customers` "add 3 new regional business clients" (count 3), `sales-mix` "a third of field-service sales on 30-day terms", `scenario` "one partial payment from the late-payer cohort", `collections` "chase two invoices over 45 days", `stock` "receive the two overdue purchase orders", `close` "close October once the 31st is verified".
5. **Capability requests**: for each gap no tool can close, `requestCapability` with a stable `key` (reuse the open one if listed), requirement, missing, feature, why, priority.
6. **recordDailyPlan** with `findings`, `changes` and a short plain `ownerNote` (3-5 sentences: yesterday in numbers, today's focus, anything the owner must decide or do in the QuickBooks UI).
7. List additions planned for today may run now in their own batch (add-customer, add-supplier, add-item only).

## Good versus weak findings
- Good: "R02 attention: 14 active customers took 70% of yesterday’s sales; add customers and suppliers as volume grows."
- Weak: "Volume is fine." (no number, no action)

## Do not
- Record a second plan for the same day.
- Ask the owner to do accountant work or to build tools.
- Claim coverage, reconciliation or filing that records do not show.

## Per-account coverage is a daily management measure

Load banking-and-deposits and page through getWeeklyCoverage/getCoverageSituations. Review every active bank/card/cash Account ID, currency, last-seven/30-day transaction counts, transaction types and missing applicable situations. A healthy operating bank does not mean other accounts are used. Record under R01/R04 the unused account IDs and the deliberate plan for each this week: card spend/credit/payment, savings sweep/interest, foreign suppliers, Square net deposits, petty cash and tips payout. Fit these inside the ten plan changes by grouping related accounts with named IDs; keep the actual schedule in the plan detail. Check completion against saved IDs on the next review, with retained recurring due dates for monthly interest/card payments. Do not retry a saved action merely because a coverage source is stale. File precise tool gaps; reconciliation checklists stay needs owner in QuickBooks UI and are feature tests, not assertions of a real bank statement match.
