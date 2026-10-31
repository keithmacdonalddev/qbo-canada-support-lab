# Continuous business activity — plan v2, 2026-10-30

Owner direction (verbatim, 2026-10-30): "this is supposed to be a continual active business. the accountant should be simulating the real business in the qbo account all the time."

Status: v2 revises v1 (commit 2fec6d0) after an independent review (see Review history). Phases 0 and 1 are implemented in source on 2026-10-30; their live proof waits for the next backend reload. Phases 2–4 are plan only. Facts come from source reading and read-only MongoDB queries on 2026-10-30 (Production company ending 2856).

## In plain English

The business is quiet for three reasons:

1. **The accountant reviews once an hour.** After a good review it waits the owner's 60-minute interval, day and night.
2. **Same-day work waits for yesterday to close.** The business calendar has been stuck at Oct 28, so nothing could be added for Oct 30. Some reviews also failed a timing check ("sources need to finish synchronizing") and retried every 5 minutes: 65 reviews and 0 new records on Oct 30.
3. **Nothing says how busy a day should be.** Same-day batches have no daily target.

The fix, in order:

- **Phase 0 — reviews can actually write (done in source).** A review now refreshes stale company data itself, within a fixed allowance, before it writes. If it cannot, it stops cleanly and tries again shortly. QuickBooks requests are counted per day.
- **Phase 1 — recovery and catch-up first.** Restart stuck work before anything else, then close the calendar through yesterday (including days with no scheduled activity), then add today's work in small slices with a daily ceiling and a hard review limit.
- **Phase 2 — a daily rhythm** using only the workflows that exist today.
- **Phase 3 — measured tuning** of sync and cadence before any acceleration. *Sync tuning and the request budget were pulled forward on 2026-10-31 (§3f).*
- **Phase 4 — new realism workflows** (invoices on terms, grouped deposits, transfers, accruals).

All existing safety checks stay: one writer, protected periods, exact plans, receipts and uncertain-write blocks.

Terms:

- **Review (attempt):** one bounded model session with tools. Each attempt now has an id shared by its usage row and its final event.
- **Slice:** one same-day activity batch (at most 12 activities, which can be up to 60 records — a field-service sale expands into five).
- **Calendar close:** the dated period operation that advances `verifiedThrough`.
- **Retained work:** an operation that still owns the one-writer slot.

## 1. Where cadence and volume are decided today

| Control | Where | Current value |
| --- | --- | --- |
| Owner decision interval | `business-agent-policy.js:4,20` | 60 min (allowed 5–1440) |
| Next review after a pass | `business-agent-service.js` worker | complete → +interval; incomplete → +5 min |
| Worker scan / lease | `business-agent-service.js` | 5 s scan; 240 s lease |
| Per-review bounds | `business-agent-service.js` | 120 s, 8 rounds, 24 tool calls |
| Sync slice | `business-agent-sync.js:7`, service | Before 2026-10-31: ≤12 requests/tick over 28 sources; 30 s when current, else 5 s; a source is current for max(2×cadence, 120 s). Since: see §3f sync tuning |
| Same-day gate | `business-governance-service.js:406`, enforced again in `business-activity-batch.js:485` | `verifiedThrough === yesterday` and idle writer |
| Calendar close bounds | `business-agent-tools.js:85` | next uninterrupted period through yesterday, ≤31 days |
| Monthly schedule | `business-activity-preview.js` | 278 (template v2) records/month ≈ 9.5/day; v3 (288) is rejected for Production at `:14` |
| Batch capacity | `business-activity-batch.js:7` (policy v7) | ≤12 activities; not a record cap or a daily limit |
| Business day | `business-activity-preview.js:19` | America/Halifax |

## 2. Review findings that change the design

1. **Recovery must not be skipped.** v1 skipped the model whenever the writer was busy. But an operation can hold the writer while *stopped, blocked or awaiting evidence*, and only the accountant's `resumeBusinessOperation` releases it (`business-agent-tools.js:93`, `business-agent-work.js:89`). `currentOperationId` alone cannot tell "running" from "retained".
2. **Catch-up can block permanently.** Preparation rejects a period with nothing schedulable (`business-governance-service.js:285`); financial proof needs a period within one calendar month (`business-financial-movements.js:63`); plans cap at 500 creates / 1,000 entries / 8 MB (`business-operation-plan-store.js:9`); retirement refuses operations with receipts or saved effects (`business-operation-retirement.js:16`).
3. **One sync tick does not guarantee freshness**, and the old write check also ran before every model round and after the engine returned, so a finished model session could fail before its completion event.
4. **Counting `OperationRun` rows is wrong.** Previews create nothing; `recordCount` can include existing prerequisites; a new `decisionKey` creates new identities for the same intended work (`business-activity-batch.js:280`).
5. **QBO use is understated.** The sync envelope is up to ~34,560 requests/day at 30 s ticks and ~207,000/day at 5 s ticks. A fresh write-bearing operation can run five seven-report observations (35 report calls) plus queries, stock reads, writes and read-backs (`business-runtime.js:98,117`, `business-period-evidence.js:71`). Intuit's Builder allowance is 500,000 CorePlus calls per workspace per month. The client records a 60 s window only and has no shared rate limiter (`qbo-client.js:290`).
6. **Budgets arrive too late.** A current calendar with an unmet, unsupported target could invoke the model every 15 minutes forever. Specialists can pull the main review forward. A "budget" that only slows reviews does not bound them.
7. **Grant renewal was overstated.** Admission accepts governed batch policies known to the code under the existing grant (`business-agent-authority.js:30`).
8. **v1 targets exceed current workflows.** Same-day sales auto-collect and deposit individually; estimates and time entries ride on field sales; journal roles exclude balance-sheet accounts (`business-activity-batch.js:62`); stock-enabled preparation reads at most 100 verified same-day batches (`business-stock-history.js:28`).
9. **v1 proof could pass falsely** (imported/manual records counted; spread-across-hours proves distribution, not good accounting).

## 3. Design

### a. Scheduling order (Phase 1)

Each worker wake classifies the company, in this order:

1. **Active execution** (an operation is running a dispatch): poll it without a model, every 2 min. Native writer admission stays authoritative.
2. **Retained but inactive** (stopped, blocked, awaiting evidence, approved-not-queued): run a bounded recovery review whose only job is to resume, finish or report that operation.
3. **Calendar behind** (`verifiedThrough < yesterday`): catch-up review (§3b).
4. **Today's activity:** a slice review when the rhythm says work is due (§3c).
5. **Nothing actionable:** no model call; next check at the quiet interval.

A new pure module `business-agent-cadence.js` returns `{ kind, nextReviewAt, reason }` from saved state only. It replaces the fixed delays in the worker. Owner run-now keeps priority.

**No-progress backoff (durable):** progress means `verifiedThrough`, the calendar revision, today's verified creates, or a retained operation's status changed. A pass without progress backs off 5 → 15 → 30 → 60 min, stored on the agent row so restarts keep it, with the reason shown. A completed pass with progress resets it.

**Actionable-work filter:** permanent duties (for example, "use unused features") are not actionable by themselves. The model is called only for a recovery item, a calendar gap, a due slice the current workflows can fill, or an owner response.

**Hard review ceiling:** at most N model reviews per Halifax day across all roles and failure paths (default 80 since 2026-10-30, for ten daily slices plus recovery and catch-up; specialists and owner requests count). At the ceiling, due work is retained, the work list says so, and reviews resume automatically at the next Halifax midnight. Existing monthly caps and the plan-limit pause stay.

### b. Calendar catch-up (Phase 1)

- **Split periods** at month-end and at plan capacity (500 creates / 1,000 entries). Never one operation across a month boundary.
- **Zero-activity day close.** When a period has nothing schedulable, close it with an evidence-backed empty operation: the same preparation, approval and seven-report observation, recording "no scheduled activity" with its evidence. The cursor never moves directly.
- **Preparation failure vs partial execution.** If preparation fails, nothing was sent; split smaller and retry. Once any receipt or saved effect exists, the same operation must continue (recovery, §3a step 2). Never retire or replace partially posted work.
- **Visible lag.** Record `behindDays` and `catchUpStartedAt`; the work list shows "Calendar closed through Oct 28 · closing Oct 29 · <exact blocker> · next try <time>".

### c. Same-day activity (Phases 1–2)

- **Count what QuickBooks received.** Daily done = unique native create receipts (`QboWriteReceipt`) for the business date, by entity, from accountant-owned operations, split into *saved* and *fully verified*. Previews and prerequisites do not count.
- **Reserve in-flight capacity.** A prepared or running slice reserves its planned creates against the day, so two reviews cannot both fill the same gap.
- **Durable server-owned slot identities.** The server names each due slice (`<business date>:<rhythm version>:<slot n>`) and derives the batch's `decisionKey` from it. The model chooses contents, not identity, so a repeated review reuses the same slot instead of creating duplicate logical work.
- **Frozen daily rhythm.** Each day's rhythm version is fixed at its first slot. A settings change applies from the next business day, so counts and admitted batches are not reset mid-day.
- **Daily ceiling (Phase 1, not Phase 2):** 2× the day's target, counting receipts plus reservations; shown when reached; resets each Halifax day.

### d. Achievable targets with current workflows (Phase 2)

Targets use only what policy v7 can do today: same-day settled sales (with their payment and deposit), field-service sales (with estimate and time), expenses, bills and bill payments, and list additions in their own batch. Owner direction 2026-10-30 ("that is not a medium sized business"): a weekday target of **150 records** (ceiling 300) in ten hourly slices 08:30–17:30 of about 15 records each, Saturday **30** in four hourly slices 10:30–13:30, Sunday 0 (obligations still allowed); `activityLevel` (0.5×/1×/2×) scales it. One slice is one same-day batch of up to 12 activities (a field sale expands to about five records), and the accountant grows its customers, suppliers and items with the existing list workflows as volume rises. The Phase 4 goal becomes ~250–300 records per weekday once independent sales, payments and deposits and the other new workflows exist.

### e. Time rules

- **Time zone:** America/Halifax, using real offsets (ADT −03:00 / AST −04:00). Slots are defined in local time; on the November fall-back day the repeated hour runs its slots once; on the March spring-forward day slots in the missing hour run at 03:00.
- **Business hours:** Mon–Fri 08:00–18:00; Saturday 10:00–14:00 takes precedence over the weekday table; Sunday has no slices.
- **Rounding:** per-area daily targets round half-up after scaling; a fraction below 1 becomes a weekly count placed on fixed weekdays (for example, 0.4/day → Tue and Fri).
- **Midnight rollover:** at 00:05 Halifax the cadence schedules a calendar-close review for the day just ended; quiet hours never suppress due obligations or recovery (consistent with `continuous-business-operator-completion-2026-10-24.md:257`).
- **Restart:** the cadence is computed from saved state, so a restart resumes the same slot, backoff and ceiling; missed slots are not replayed beyond the day's target.

### f. Resource controls

- **QBO requests (Phase 0, done):** a daily per-company counter of actual transport attempts and HTTP 2xx successes by category — sync, report, query, read, write — recorded from the single client transport path (`qbo-client.js` `apiCall`). Counts batch in memory and flush every 15 s with `$inc` into `QboRequestDay` (UTC day). Token refreshes are not counted. Today's and the month's totals appear read-only in the business-agent status (`qboRequests`) and on one line of the AI usage panel.
- **Daily request budget (Phase 1, enforced since 2026-10-30; revised 2026-10-31):** the first version counted every attempt (12,000/UTC day). Measured on 2026-10-31 after about two hours: sync 1,845, read 212, report 38, query 27, write 3. Sync alone ran at about 1,000/hour (≈24,000/day, ≈720,000/month), over Intuit's 500,000-call Builder allowance by itself, and would have used the 12,000 budget by midday UTC and blocked every Saturday slice.
- **Request budget (since 2026-10-31, `business-agent-cadence.js` `requestBudget`):** Intuit meters only "CorePlus" calls (reads, queries, reports); "Core" data-in calls (creates, updates) are not metered, so writes never count. New discretionary slices stop at **10,000 non-sync metered attempts** (read + query + report) per UTC day, or when the month's **metered total including sync reaches 450,000** (50,000 under the free allowance). Background sync is outside the daily figure, so it can never starve the business. Unreadable counts stop new slices (fail closed); recovery, obligations, calendar closes and continuation always proceed. 31 × (10,000 + ~300 sync) ≈ 319,000/month, so the monthly guard is a backstop against runaway use. The AI usage panel shows today's and the month's metered totals against the 500,000 allowance and the daily activity figure.
- **Sync tuning (pulled forward from Phase 3, 2026-10-31, `business-agent-sync.js`):** the app makes almost every change itself, so sync is adaptive. (1) Every incremental change-tracked source (23 of the 28) is read in **one combined change-data-capture (CDC) call**, every 5 minutes in Halifax business hours and every 15 outside. (2) A write-bearing step needs every change-tracked source read within the last 2 minutes; if not, the bounded pre-write refresh makes that one combined call (charged as 2 of the 40-request allowance), and that call is what admits the write. (3) A combined response at the 1,000-object limit persists nothing and each source is read on its own (its own CDC call, then a full re-read if that is saturated too); a malformed or rejected combined response does the same, while a transient failure (429, 5xx, network) retries combined with per-source backoff (1, 2, 4… intervals, at most 30 minutes). (4) Snapshot sources: TimeActivity every 30 minutes in business hours and 2 hours outside; tax codes, tax rates, company info and preferences every 6 hours; pages are 1,000 rows. (5) From 02:00 Halifax a nightly sweep compares each change-tracked source's QuickBooks `COUNT(*)` with the mirror's undeleted records and fully re-reads (with tombstoning) any source that differs; a cursor older than 29 days is always fully re-read. Freshness stays truthful: a source is current for twice the cadence it was read under (at least 2 minutes), and a successful combined read makes every covered source current as of that response.
  - *Expected sync requests:* weekday — CDC 10 business hours × 12 + 14 h × 4 = 176; pre-write reads ≈ 40 (about 20 write-bearing reviews, most needing one call); TimeActivity 20 + 7 = 27; reference snapshots 4 × 4 = 16; nightly sweep 23 → **≈ 280/day**. Saturday ≈ 48 + 80 + 10 + 18 + 16 + 23 ≈ 195; Sunday ≈ 96 + 12 + 16 + 23 ≈ 147. About **7,700 a month**, versus ≈ 720,000 before. Snapshot pages grow by one per 1,000 records of a source.
  - *Still open:* a shared per-realm rate limiter (average rates do not prove instantaneous compliance), and a week of measured requests as the Phase 3 proof.
- **Model use:** the hard daily review ceiling (§3a). Cached-token totals are not converted into ChatGPT plan headroom; the plan-limit pause stays the authority.

### g. Authority

Phases 0–3 need no grant renewal. Adding a v8 workflow known to the code does not by itself require one either (`business-agent-authority.js:30`). Republishing the business (for example, to add a bank mapping for transfers) changes `authorityHash` and currently invalidates the grant, so Phase 4 should bundle any republish into one owner step. Exact unfinished operations stay tied to their original grant; do not reissue grants unnecessarily.

## 4. Build order and proof

**Phase 0 — reviews can write; usage is measurable (implemented 2026-10-30).**

- *Bounded freshness:* write-bearing steps (`guard(true)`) re-evaluate source freshness and, if stale, run sync slices of ≤12 requests from one per-attempt allowance of 40 requests and 60 s, never replenished by later checks. Each slice may use only the time left in the allowance, and the allowance is rechecked before the write is admitted. A slice that makes no progress, or an exhausted allowance, yields: the step does not start, the attempt ends `yielded` (event `review-yielded`, not an attention alarm), sync runs immediately, and the next review waits 1, 2, 5, then 15 minutes for consecutive yields (`reviewYields`, reset by a completed review). Model rounds and review finalization check authority only, not freshness.
- *Truthful outcomes:* one shared function decides each attempt's terminal outcome — completed, incomplete, yielded, failed, cancelled, plan-limit or cap-reached. The usage row stores it (its id is the attempt id, plus `passId`); the attempt's event (`review-completed`, `specialist-report`, `review-yielded`, `attention`, `review-paused`, `review-cancelled`) carries the same `outcome`, `attemptId` and `usageId`. One idempotent per-attempt finalizer writes the terminal event first, then the usage outcome, then the scheduling state; if the terminal event cannot be saved the attempt is `failed`, and a later state-save failure never adds a second terminal event. On the Codex path the first fatal tool error (for example a freshness yield) is retained, later tool calls are refused, and it is rethrown once the tool bridge drains.
- *Request measurement:* §3f.
- *Proof after reload (read-only):* over one Halifax business day, (a) every `BusinessAgentUsage` row has an event with the same `attemptId` and `outcome`; (b) "need to finish synchronizing" attention events fall from 15 to 0, with any freshness stops recorded as `review-yielded` and followed by a completed review; (c) `QboRequestDay` totals for the day are non-zero by category and roughly match the sum of sync ticks plus operation reads.

**Phase 1 — recovery, catch-up and bounded same-day slices.**

- `business-agent-cadence.js` (pure, tests for every §3a row and §3e rule), wired into the worker.
- Recovery-aware scheduling, month/capacity-aware catch-up with the zero-activity close, receipt-based daily counting with reservations, server-owned slot identities, frozen daily rhythm, daily ceiling, actionable-work filter, durable backoff, hard review ceiling, `context.today` and the Right-now "Today" line.
- No new accounting workflows and no grant change.
- *Proof (read-only, after reload):* within one business day `verifiedThrough` reaches yesterday with no gap; any empty day closed with recorded evidence; no logical slot executed twice; reviews ≤ ceiling; QBO requests and plan use recorded for the day.
- *Implemented in source (2026-10-30):* `business-agent-cadence.js` (pure; precedence, Halifax DST rules, rhythm v2: 150/weekday in ten hourly slots 08:30–17:30 and 30/Saturday in four, a day already frozen under v1 keeps it; 80-review hard ceiling; receipt counting, reservations with a 30-minute hold for prepared batches, slot identities `slot-YYYYMMDD-r1-sN[-bK]`, 2× ceiling, 5/15/30/60 backoff, review ceiling (now 80), stalled-execution recovery after 20 min); worker wiring and post-review scheduling in `business-agent-service.js`; `todayActivity` in the store; slot identity, ceiling and month-end checks in the accountant tools; the zero-activity close (`business-governance-service.js`, adopted-history path); `today`/`calendarClose`/`cadence` in the accountant context, work list and Right-now line. After GPT-6.1 Sol's code review (`artifacts/luna/tmp/sol-code-phase1-result.md`): approved own work that holds no calendar slot is found and recovered before any calendar close, and new periods or batches are refused while it exists; slice admission reads fresh counts under the agent's exclusive lease and drops cached counts after preparing or queueing; progress between reviews clears the backoff; the review ceiling is hard for every kind, owner requests included (settings changes are not review requests); nothing actionable never calls the model; the target and ceiling limit only discretionary slices, never obligations, corrections, list additions or recovery. Round-2 review: unfinished own work is classified from saved records (active, continue, stranded with saved effects, unsent); unsent work stopped outside the calendar slot is retired automatically through the governed retirement (which refuses any receipt or saved effect), stranded work holds visibly with no model call, and only continuable or stranded work blocks new periods and batches; the unfinished-work query filters the current grant before its limit; preparation and approval fence the worker's exact unexpired lease inside their transactions (`fenceAgentAuthority` `lease`); adopted invoices and bills due today or earlier (saved records only) make a business-hours review actionable, spaced 15 minutes and backed off. Open purchase orders are not a trigger yet (their receivable state is not in the local copy). Final review: approval refuses a same-day slice whose saved plan creates more than its slot allowance (twice the slot share: 30 on weekdays, 16 on Saturday), and an oversized prepared slice no longer occupies its slot; an **enforced daily QuickBooks request budget** of 12,000 attempts (Phase 0 meter, UTC day, unsaved counts included; about 360,000 a month, under Intuit's 500,000 Builder allowance) stops scheduling and admitting new discretionary slices when reached, while recovery, obligations, calendar closes and continuation proceed; the reason appears in Right now and the work list. Not yet: automatic capacity splitting (the accountant retries a shorter period when preparation reports capacity), `catchUpStartedAt`, `activityLevel` setting, Phase 2 per-area targets. The zero-activity close is covered by the existing runner test for empty periods but has no end-to-end preparation test; its first live use is the proof.

**Phase 2 — daily rhythm with current workflows.** Per-area targets from §3d, time windows, Tue/Fri payment runs, "Today's business" work item. *Proof:* one week within ±30% of the §3d targets.

**Phase 3 — measured tuning.** Sync intervals, per-realm rate limiter and monthly request budget from Phase 0 data. *Proof:* a full week of measured requests within the budget and plan-limit-free model use.

**Phase 4 — realism workflows (activity policy v8).** Invoices on terms collected later, grouped deposits, same-day stock sales and purchase orders, transfers (second bank role; needs a republish), month-end accruals and depreciation (balance-sheet journal roles). Each lands with its own targets. *Proof:* each workflow verified in QuickBooks and through seven-report evidence.

**Direct proof for Phases 1–2 (all read-only).**

1. Record a baseline before activation: native counts by entity and the latest receipt per company.
2. Over the **first full business day** after activation, join each new native identity (`CompanySyncRecord` by entity/`qboId`) to an accountant create receipt and a completed (verified) operation. Records without a receipt — imported or manual — are excluded and reported.
3. Convert `MetaData.CreateTime` to Halifax time and show distinct due slots across the day, each with its slot identity.
4. Show calendar continuity (no gaps), no duplicate logical work, seven-report results for each operation, and the day's actual QBO requests and review usage.

## 5. Risks

- **API allowance:** the Builder tier allows 500,000 metered calls a month (D06). Polling sync alone exceeded it until the 2026-10-31 sync tuning (§3f); the budget now counts only metered calls and keeps a monthly guard. A week of measured requests is still the proof before any acceleration.
- **Plan quota:** weekly ChatGPT limits are unpublished; the review ceiling bounds use but cannot prove sustainability.
- **Rework:** more slices mean more seven-report checks. A failed slice holds the writer until recovered; recovery runs first and backs off rather than loops.
- **Calendar ramp:** post-adoption months may stay below 9.5 records/day; same-day targets fill the gap without duplicating calendar obligations.
- **Unchanged rules:** server startup never schedules QBO mutations. Activation needs the owner's reload.

## Review history

- 2026-10-30, v1 (commit 2fec6d0): initial plan.
- 2026-10-30, GPT-6.1 Sol read-only review (`artifacts/luna/tmp/sol-plan-continuous-result.md`, Codex session `01a18f37-30a8-7102-9d8f-a3ff66569d49`): nine findings — recovery skipped while the writer is retained; catch-up blockers (empty periods, month boundaries, plan capacity, partial execution); one sync tick is not a freshness guarantee; unsafe daily counting; understated QBO use; late and incomplete budgets; stale grant-renewal claim; targets beyond current workflows and undefined time rules; a proof that could pass falsely. The lead accepted all nine; v2 incorporates each (§2 lists them, §3–4 the changes) and Phase 0 was implemented the same day.
