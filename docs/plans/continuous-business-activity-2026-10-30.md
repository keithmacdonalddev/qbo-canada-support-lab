# Continuous business activity — plan, 2026-10-30

Owner direction (verbatim, 2026-10-30): "this is supposed to be a continual active business. the accountant should be simulating the real business in the qbo account all the time."

Status: plan only. No code, QuickBooks or database changes were made. Facts below come from source reading and read-only MongoDB queries on 2026-10-30 (Production company ending 2856).

## In plain English

The business is quiet for three reasons:

1. **The accountant only plans to work once an hour.** After a good review it waits the owner's 60-minute interval, day and night, even when work is overdue.
2. **Same-day work is locked until yesterday is closed.** The accountant can add today's sales and expenses only after the business calendar is marked verified through yesterday. The calendar has been stuck at Oct 28 since early Oct 30, so nothing could be added for Oct 30. Some of the accountant's reviews then fail on a timing check and retry every 5 minutes. On Oct 30 that meant 65 reviews and 0 new records for the day.
3. **Nothing says how busy a day should be.** The monthly schedule averages about 9.5 records per calendar day once fully running. Same-day batches have no daily target, so the accountant adds a few records per review, or none.

The fix has four parts:

- **Clock.** A cadence decides when the next review runs: right away while it is catching up, every 15 minutes during business hours, and slower overnight and on weekends.
- **Daily rhythm.** A target says roughly how many records of each kind a medium-sized business like this makes per weekday, spread across the day.
- **Catch-up first.** The calendar catches up through yesterday before any same-day work.
- **Visible progress.** A "Today" line shows planned, done and next slice.

All existing safety checks stay in place.

Terms used below:

- **Review (pass):** one bounded model session with tools.
- **Slice:** one same-day activity batch of at most 12 activities.
- **Calendar close:** the dated period operation that advances `verifiedThrough`.

## 1. Where cadence and volume are decided today

| Control | Where | Current value |
| --- | --- | --- |
| Owner decision interval | `backend/src/modules/business-agent-policy.js:4` (default), `:20` (allowed 5–1440 min) | 60 min (Production setting) |
| Next review after a pass | `business-agent-service.js:135` | complete → +`decisionIntervalMinutes`; incomplete → +5 min |
| Next review after an error | `business-agent-service.js:144` | +5 min |
| Owner actions that trigger an immediate review | `business-agent-policy.js:37-50` | run-now, resume, save instructions, configure, respond to decision |
| Worker scan / lease | `business-agent-service.js:36` | scans every 5 s; 240 s lease |
| Per-review bounds | `business-agent-service.js:128` | 120 s, 8 model rounds, 24 tool calls |
| Sync slice | `business-agent-service.js:111` | ≤12 QBO requests per tick; next tick in 30 s if current, else 5 s |
| Sync sources | `business-agent-sync.js:7,18,75` | 28 sources (TimeActivity every 5 min); a source counts as current for max(2×cadence, 120 s) |
| Writes require current sync **mid-pass** | `business-agent-service.js:99` (`guard(true)`) | any source older than its window fails the write → attention → 5-min retry |
| Same-day work requires yesterday closed | `business-governance-service.js:406` | `verifiedThrough === yesterday` and an idle writer |
| Calendar close bounds | `business-agent-tools.js:85` | next uninterrupted period, through yesterday, ≤31 days |
| Business day and time zone | `business-activity-preview.js:19` | America/Halifax |
| Prompt cadence | `business-agent-engine.js:18` | "repeated hourly passes" |
| Monthly schedule | `business-activity-preview.js:7,46,94` | flagship cohorts 30 field / 15 supply / 25 care, each **monthly** on day `1+(i·5)%28`; 278 (v2) or 288 (v3) records/month ≈ 9.5 per calendar day |
| Approved volume profile | `docs/discovery/volume-profiles.v1.json` | flagship: 120 customers, 45 vendors, 90 items, 260 txns/month; provisional 6 req/s, 300 req/min |
| Batch capacity | `business-activity-batch.js:7` (policy v7) | ≤12 activities, qty ≤8, unit ≤ $1,000, expense ≤ $10,000, settlement ≤ $50,000, batch ≤ $120,000 |
| Daily batch limit | none | No per-day count; the limits are the writer and the yesterday gate |
| Published blueprint | `BlueprintVersion 90a620e4…` v7 | `volumeProfile: flagship`, opening 2023-09-01, Halifax |

### What limits volume to 2–9 records per day

- **Calendar periods:** Oct 21–28 was one operation with 30 records over 8 days (3.75 per day). This is below the steady-state 9.5 per day. One possible cause, unverified: cohorts that began in the adopted import do not continue in the calendar.
- **Same-day batches for Oct 29:** batches of 5, 2 and 2 records were verified, and one batch of 4 is still `previewed`. There were none on Oct 30, because Oct 29 is not closed.
- **Review timing:** reviews ran 65 times on Oct 30. The 15 `attention` events all read "Company sources need to finish synchronizing before autonomous work". The cause is a timing mismatch: a review takes about 56 s and sync does not run during it, so sources go stale under the 120 s window before the write check.

## 2. Design for a continually active business

### a. Adaptive cadence

Add a pure function `nextReviewAt(state)` in a new `business-agent-cadence.js`. It replaces the fixed delays at `business-agent-service.js:135` and `:144`. Inputs:

- the clock in Halifax time;
- the owner's settings;
- calendar lag (`verifiedThrough` vs yesterday);
- today's planned vs done (from §2b);
- whether the writer is busy;
- whether the last pass made progress. Progress means the calendar revision, `verifiedThrough` or today's done count changed.

| Situation | Next review |
| --- | --- |
| Calendar behind and last pass made progress | 2 min |
| Calendar behind, no progress | back off 5 → 15 → 30 → 60 min, with the reason shown (§2c) |
| Writer busy (operation running) | re-check in 2 min **without a model call** |
| Business hours and done < planned-by-now | `activeIntervalMinutes` (default 15) |
| Business hours, on or ahead of plan | `decisionIntervalMinutes` (owner's 60) |
| Quiet hours or weekend | `decisionIntervalMinutes`, and the model is skipped when the work list has no actionable accountant item. The first slot after 00:05 closes yesterday. |
| Plan limit or usage cap | unchanged: pause until reset |

New owner settings, added to the `configure` command in `business-agent-policy.js:20`. Validation follows the existing pattern.

- `activeIntervalMinutes`: 5–60, default 15.
- `businessHours`: default Mon–Fri 08:00–18:00 and Sat 10:00–14:00, Halifax.
- `activityLevel`: 0.5×, 1× or 2×, default 1×.

The owner's 60-minute interval stays the quiet interval and the ceiling between business-hour slices. Run-now keeps priority.

Change the prompt at `business-agent-engine.js:18` from "hourly" to "small slices across the business day". Add a `context.today` block containing the target, done, due now and next slice. The model picks concrete activities. The server picks timing.

### b. Realistic daily volume

These are proposed defaults for a medium-sized Canadian service, project, wholesale and recurring-care business. They assume the flagship scale: 120 customers, 45 suppliers, about 25 staff with time entries. The figures are QBO records per weekday at 1×. Calendar records dated today count toward the target, so same-day slices fill only the remainder.

| Area | Records/weekday | Shape across the day |
| --- | --- | --- |
| Sales (invoices on terms, settled sales, stock sales) | 10 | 09–17, evenly |
| Customer payments | 7 | morning mail, midday online |
| Deposits | 3 | 10:00, 13:00, 16:30, grouping that day's receipts |
| Estimates | 3 | mornings |
| Time activities | 6 | end of day (16–18) |
| Purchase orders / receiving (bill from PO) | 2 / 2 | mornings / afternoons |
| Supplier bills / bill payments | 3 / 3 | bills daily; payments heavier on Tue/Fri payment runs |
| Cash expenses (Purchase) | 3 | any hour |
| Credits, refunds, supplier credits | ~0.5 | about 2–3 a week |
| Transfers | ~0.2 | weekly. A second bank role is still needed (accountant-full-tooling, Workflows 3 and 6) |
| Journal entries | ~0.3 | mostly the last two business days of the month (accruals, depreciation): 3–5 |
| List additions (customer, supplier, item) | ~0.5 | about 3 a week, in their own batch |
| **Total** | **≈45** | Saturday ≈8; Sunday 0–2; month-end +5 |

That is about 950 records per month, roughly 3.3 times the current schedule's 288 and in line with the import's density.

Configure the targets in a new `business-activity-rhythm.js`. It holds a table keyed by the published `volumeProfile` (flagship ≈45 per weekday, development ≈12), with weekday, month-end and seasonal weights, scaled by `activityLevel`. It has three outputs:

- `todayPlan(day)`: per-area targets and time windows.
- `plannedByNow(at)`: cumulative due counts.
- `doneToday`: counted from `OperationRun` rows with `activityBatch.day === today`, plus calendar events dated today.

Keep the targets out of the published blueprint in the first slice. Changing the blueprint changes `authorityHash` and forces grant renewal. Moving them into a blueprint `operatingRhythm` field later is optional.

Add a server-enforced **daily** ceiling at 2× the target. It is a runaway guard that resets each business day, not a lifetime quota (R09), and it is shown when reached.

Realism gaps to fill in later phases (§3):

- Same-day stock sales and same-day purchase orders.
- Invoices on terms that the calendar collects later, without double collection.
- Deposits that group several payments.
- A second bank account so transfers can be prepared.

### c. Calendar catch-up first

- Gate rule: while `verifiedThrough < yesterday`, the accountant's only job is closing the calendar. The governance gate already blocks same-day work (`business-governance-service.js:406`).
- Speed: cadence runs reviews 2 min apart while each pass makes progress. A period may cover up to 31 days (`business-agent-tools.js:85`). Close in one operation when the plan is unblocked. If a multi-day plan fails, fall back to day-by-day.
- No progress: the work list gets a blocking item, "Calendar closed through Oct 28 — Oct 29 not closed: <exact reason>". It names the operation or blocker and the next retry, and the cadence backs off. Owner work is still limited to genuinely human items.
- Measure: record `behindDays` and `catchUpStartedAt` so lag is visible and measurable.

### d. Safety and limits that stay

- **Exact checks:** every slice keeps preview, fingerprint, the exact plan hash, approval under the standing grant with `activityPolicyHash`, and the period, tax, receipt, seven-report and stock-cost checks. A slice is still at most 12 activities, under the batch-cent caps.
- **One writer:** slices run in sequence. The cadence never prepares while `currentOperationId` is set. Ambiguous or possibly sent writes still block.
- **Write freshness — fix first.** The mid-pass freshness check must stay. Run a bounded sync tick (the existing `sync.tick`) inside `guard(true)` before writes, or check freshness only for the sources the write depends on (W07.2). This stops the 5-minute retry loop.
- **QBO API.** Sync dominates. At ≤12 requests per 30 s tick (5 s ticks while not current), sync alone can make up to about 34,500 requests per day, roughly 1.0M per month. This is an upper bound, not a measurement.
  - **Writes:** a slice is estimated at about 40 calls (writes, read-backs, about 14 report reads, lookups). This is also not measured. About 35 slices a day would be about 1,400 calls.
  - **Rate:** the per-minute rate is far below Intuit's 500 per minute per realm and 10 per second.
  - **Monthly allowance:** if this app is on a Builder allowance of 500k CorePlus calls per month and these reads are metered, **sync alone could exceed it**.
  - **Measurement:** `qbo-client.js:570` keeps only an in-memory 60 s window, and no daily per-category count exists. Persist daily counts by category before any cadence change goes live (D06, W07.3), then tune sync to 60–120 s for slow-moving lists and singletons.
- **Codex plan quota (measured Oct 30):**
  - **Reviews:** 65 completed, averaging 241k tokens each, about 15.7M tokens for the day, with no plan-limit outcome.
  - **Cache:** cached input is about 78–89% on rows that record the split (`cacheSplit: true`).
  - **Weekday estimate:** 40 business-hour slices plus about 6 overnight reviews (the model is skipped when nothing is actionable) ≈ 46 reviews ≈ 11M tokens.
  - **Weekend estimate:** about 3M tokens per day.
  - **Weekly estimate:** about 60M tokens per week, below today's observed rate.
  - **Existing guards stay:** the plan-limit pause, monthly caps and usage records.
  - **New guard:** a daily review budget, defaulting to 80. When it is reached, cadence falls back to the owner interval.

### e. Visibility

The `rightNow` function (`business-agent-work.js:130`) gains a server-computed `today` block, not text written by the model:

- In plan: "Today (Fri Oct 30): 45 planned · 17 in QuickBooks · next slice 2:15 PM".
- Behind: "Catching up: calendar closed through Oct 28 · closing Oct 29 · next try 2:02 PM", or the exact blocker.
- Quiet: "Quiet hours · next slice 8:00 AM Mon · 44 of 45 done Friday".
- Ceiling: "Daily ceiling reached (90) · resumes tomorrow".

The work list gains a "Today's business" item with per-area done and planned counts (Sales 6/10, Collections 4/7, …) and a link to that day's records. The Right-now line already shows `nextReviewAt`. Add a "why this time" label: catching up, slice, on plan or quiet.

## 3. Build order

**Phase 0 — make reviews able to write (prerequisite, small).**

- Run a bounded sync refresh inside `guard(true)` before mutating tools.
- Persist a daily count of QBO requests by category (sync, preparation, write, read-back, reports, UI).
- Proof: on one day, the "need to finish synchronizing" attention count falls from 15 to near 0. Every review in `BusinessAgentUsage` has a matching `review-completed` event.

**Phase 1 — smallest slice that makes the day visibly continuous.**

- Add `business-agent-cadence.js`, a pure module with tests for every row of the §2a table, wired at `business-agent-service.js:135/144`.
- Add `activeIntervalMinutes` and `businessHours` settings.
- Add catch-up 2-minute chaining with backoff and a visible blocker.
- Add a flat weekday target from `business-activity-rhythm.js` (one total, not yet per area) feeding `context.today` and the Right-now line.
- Update the prompt wording.
- No new accounting workflows and no change to grants or policy hashes.
- Proof, read-only, after the owner authorizes the backend reload:
  - Within one business day, `verifiedThrough` reaches yesterday.
  - QBO records dated today grow to at least 25 by 18:00 Halifax.
  - Their QuickBooks `MetaData.CreateTime` falls in at least 8 distinct hours. Count from `CompanySyncRecord` grouped by entity and hour; spot-check a few records directly in QBO.
  - API requests and tokens for the day fall within §2d.

**Phase 2 — rhythm by area.**

- Per-area targets and time windows, Tue/Fri payment runs, month-end journal entries, the 2× daily ceiling, and the "Today's business" work item.
- Proof: one week of daily per-area counts within ±30% of target, with month-end journal entries present.

**Phase 3 — budgets.**

- A daily review budget and skipping the model when nothing is actionable.
- Sync cadence tuned from the Phase 0 measurements to fit the confirmed Intuit allowance (D06).
- Proof: measured requests and tokens per day against limits for a full week.

**Phase 4 — realism workflows (activity policy v8, needs renewed owner grant).**

- Same-day stock sales and purchase orders, invoices on terms, multi-payment deposits, and a second bank role for transfers.
- Proof: each workflow verified in QBO and through the seven-report evidence.

**Risks.**

- **Allowance:** the API allowance is unknown (D06). Sync may already exceed a Builder allowance; measure before scaling.
- **Plan quota:** the weekly Codex limit is unpublished. Today's 15.7M tokens did not trip it, but a weekly limit may.
- **Rework:** more slices mean more seven-report checks per day. If one slice fails it holds the writer until recovered, and the cadence must back off rather than loop.
- **Calendar ramp:** the post-adoption calendar may stay below 9.5 per day for about 45 days. Same-day targets must fill the gap without duplicating calendar obligations.
- **Realism:** settled same-day sales (quote → invoice → payment → deposit all in one day) are unrealistic at volume. Shift the mix toward invoices on terms in Phase 4.
- **Unchanged rules:** server startup still never schedules QBO mutations. Activation needs the owner's reload authorization.
