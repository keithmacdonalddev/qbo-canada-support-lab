# Orchestrator handoff, 2026-10-31

From the Claude orchestrator of session `1f8ad8d6` (Oct 29–31) to the next Claude orchestrator.

You will run the work in this document. Read it end to end before acting. It covers:
- the owner's intent and their exact words;
- what was built and why;
- the live state at hand-off;
- the open work, in priority order;
- how to operate the Sol workers;
- the mistakes that cost the most time, and the rules that prevent them.

Supersedes nothing in `AGENTS.md`, `CLAUDE.md` or `AGENT_WORKFLOW.md`, which still apply.

---

## 0. First 15 minutes (do this before anything else)

1. `git status --short --branch`.
   - Expect `main...origin/main` and only `.claude/agent-memory/qbo-safety-reviewer/MEMORY.md` modified. That file is not ours; never stage it.
   - **Another session is also committing in this repo.** `9f7b101` and `969042d` are not from this session. Re-read files before editing.
2. Read the live state (read-only; the helper mints an owner token in memory and never prints it):
   ```bash
   cd C:/Projects/qbo/artifacts/luna/tmp
   MSYS_NO_PATHCONV=1 API_OUT=$CLAUDE_JOB_DIR/tmp/s.json node api.js GET /company/business-agent
   MSYS_NO_PATHCONV=1 API_OUT=$CLAUDE_JOB_DIR/tmp/b.json node api.js GET /company/business-agent/blockers
   ```
   Fields to check:
   - `data.rightNow.today.line`: records in QuickBooks today vs the 220 target;
   - `data.rightNow.cadence`: what the scheduler is doing and why;
   - `data.agent.summary`: the accountant's last summary;
   - `data.management.capabilityRequests`: the accountant's **build list**;
   - `blockers`: structured errors, grouped.
3. Check the Sol jobs still running at hand-off (section 6). Fetch their results and commit them (section 5).
4. Report the live count and blockers to the owner in a few plain sentences.

---

## 1. Who the owner is and how to work with them

- **About the owner:**
  - a self-taught solo developer;
  - wants **short, plain-English answers**: lead with the result, no jargon, no tool narration;
  - uses the app **on desktop only**; no mobile or 390px checks.
- **Judge work by outcomes in the live company, not by tests or reviews.** Owner, verbatim: "who cares about tests and reviews". Report records in QuickBooks today against target, blockers and features used. Keep tests and reviews quiet and in the background.
- **Full autonomy** (2026-10-29): "do any thing you need to ... i want you to do everything until fullly complete without my input from here". Don't ask permission for routine work. Ask only for genuinely owner-only, irreversible decisions; multicurrency is one.
- **It's a test company, so no real money moves.** The QBO realm 9130357222392856 (Production, QBO Advanced Canada) is a simulated business. Don't re-prompt the owner for approvals of new workflows.
- **Not this chat's Sol-only rule.** It was for session `1f8ad8d6` only. Your own rules are set out in the next bullet.
- **The owner's orders for the next session**, verbatim:
  - "the sol only subagents will pass to the next chat session only. with claude as the orchestrator."

  **You (Claude) orchestrate. All building, fixing, reviewing and testing goes to GPT-6.1 Sol at extra-high effort through the Codex companion.**
  - Don't spawn Claude subagents.
  - Keep your own token use low: short messages, few tool calls.
  - Use read-only checks yourself only when a quick look is cheaper than a Sol round-trip.
- **Don't overcompensate.** After a mistake, fix the cause, say so plainly once, and move on.

---

## 2. What the app is for (the owner's intent)

The complete intent is in the **"Owner intent" section of `AGENTS.md`** (single source; loaded by every session). Do not restate it here. Formal requirements: R01–R16 in `docs/plans/continuous-business-operator-completion-2026-10-24.md` §2.

**Owner directions given in this session** (verbatim, and binding):
- **On activity and scale:**
  - "this is supposed to be a continual active business. the accountant should be simulating the real business in the qbo account all the time."
  - "that is not a mediunm sized business, why is this so lazy". The target is now **220 records/day**, which is a medium business.
  - "business run 24/7 365. more over, ai and systems dont need limitiations like that". No business hours, no closed days.
  - "why are theree accountant sessions?" / "you worked for that long and didnt do what i asked?" **Continuous means back to back while work exists**, never a timer or slot schedule.
- **On the accountant's reach and setup:**
  - "why doesnt the accountant know all that... its a fronteir model". **Don't hand-code fixed transaction shapes**; give the model general governed API reach.
  - "give the accountant all the tools, all the api skills, the ability to fully search all of the synced data in this app, be able to write /read do anything else in qbo, why is it so narrow"
  - "the accountant needs to be setup like you, you have skills, tools ... progressive disclousure for tools, and tool search, also with skills"
  - "if this app syncs automatically and its proven to be in line with all the qbo data, why waste qbo reads". Use the synced copy, and prove it matches.
- **On the daily review and stalls:**
  - "why doesnt it review the busienss data, look for ways to improve the intent of the app within the scope ive discussed every day" (the daily management review).
  - "why would it stop though". **A check failing on an already-saved record must never stop the business.**
  - "why can there only be single batch writes". Multiple batches must run in parallel.
- **On the live view:**
  - "and why cant i see what the accountant is doing live on the first page of this app". The Live panel shows reasoning, tool calls, sends and receives.
- **On how the orchestrator works:**
  - "you need to manage them properly". Keep every Sol slot busy, track jobs, commit promptly, and verify live.
  - "why didnt you know this alraedy and why didnt the accountant agent know this", followed by "fix why it was overlooked, why error surfacing with proper error data didnt get to where it needs to go". This produced the structured errors, the blockers feed, stuck detection, and the rule that the build list is acted on.
- **On the landing page:**
  - "archive it as a todo ... the page needs an overhaul and your review". See `docs/plans/landing-page-overhaul-todo-2026-10-31.md`.

---

## 3. What exists now (architecture, by area, with commits)

The flow is: model → tools → governed write pipeline → QuickBooks → read-back and verification → day close → calendar.

### 3.1 Accountant runtime
- **The model:**
  - runs as Codex CLI (`gpt-6.1-sol`) on the owner's ChatGPT subscription;
  - falls back to Anthropic only when the Codex login is not ready, and only before a run starts (`ed7ad03`, fixed by `82d2cde`).
- **Engine and service:** `business-agent-engine.js`, `business-agent-service.js`.
  - Each "review" is one model run, up to 10 minutes and 60 tool calls (`REVIEW_LIMITS`; a hidden 24-call cap was removed in `e56f54d`).
- **Continuous cadence:** `business-agent-cadence.js`, rhythm v3 (`4d1bbdc`, `6f319c1`).
  - Runs 24/7/365, 220 records/day, weighted heavier during the day and never zero at night.
  - Reviews run back to back about 1 minute apart while anything is due. The day's expected count rises minute by minute.
  - Caps: 60 records per batch, 60 per rolling hour, a daily ceiling of 2× target, and 400 reviews/day.
  - Backoff of 5, 15 then 30 minutes, only for consecutive failures. It is capped at 5 minutes while the day is behind.
  - Up to 3 operations can be in flight at once. New work runs alongside recovery.
  - The daily management review runs at 00:10 Halifax.
- **Tools and skills** (`6dbcd6d`):
  - Progressive disclosure through `business-agent-toolbox.js`: a small core set, `searchTools` and `useTool` for deferred tools, and `listSkills`/`loadSkill`/`readSkillReference`.
  - The skills are in `backend/src/accountant-skills/*/SKILL.md`. They are read on demand and changing them needs no restart. Latest content is `3301c67`: recurring billing, month-end, support scenarios, and the 24-hour mix.
- **Daily management review:**
  - module `business-management-review.js`;
  - tools `recordDailyPlan`, `requestCapability` (the **build list**) and `getManagementReview`;
  - the UI card `BusinessTodayPlan.jsx`.
- **Search over synced data:**
  - `queryCompanyData` (`business-company-query.js`) supports find, aggregate and link-following across the local mirror (`CompanySyncRecord`, about 11k records), with no QBO calls;
  - the lookups `searchEntities`, `getEntityDetail` and similar answer from the mirror when it is current (`business-local-reads.js`).
- **Diagnostics:**
  - `inspectBlocker` (`business-blocker-inspection.js`) gives a field-by-field reason for any blocked operation;
  - structured errors come from `business-error-detail.js`.

### 3.2 Writes
- **Fixed workflows:** activity policy v8 in `business-activity-batch.js`, and earlier ones.
  - Terms invoices and bills, collecting your own invoices and paying your own bills in full or part, estimate → invoice, and order-stock (`6dbcd6d`, `8619270`).
  - These still exist and are still used.
- **General governed write tool** `manageQboRecord`, plus `getQboEntitySchema`:
  - **Contract:** `docs/plans/general-governed-write-tool-2026-10-31.md`, rev 3, approved after two Sol design reviews.
  - **Modules:** `general-write-*.js`.
  - **Sending:** `GENERAL_WRITE_DISPATCH_ENABLED=true`, set in `.env`.
  - **What it can do:**
    - create, update and delete non-inventory records;
    - unapplied payments and overpayments;
    - mixed tax codes per line;
    - deposits net of fees;
    - voids of its own Invoice, Payment, SalesReceipt and BillPayment (`73dddf2`).
  - **Inventory** is built but off: `GENERAL_WRITE_INVENTORY_ENABLED` defaults off (`91df204`). Returns are unfinished.
  - **Safety:**
    - batch transport through `qbo-write-gate.js` with a receipt saved before every send;
    - exact replay after a lost response;
    - a day-close gate that checks each general record's GL rows against its own lines (`general-write-close-gate.js`);
    - a durable dirty-history marker before history edits; edits to verified history are partly supported (`ac17891`, job H);
    - 11 Sol review findings fixed (`22912ec`, `0540813`).
  - **First live record:** 2026-10-31 at about 22:05 UTC, Anna Katz's $1,000 credit application.
- **Owner UI:** the "Record something" panel (`OwnerRecordComposer.jsx`, `54197e9`) goes through the same governed path. **It has not yet been inspected rendered.**
- **Concurrency:**
  - resource-scoped claims replace the single company writer (`d80f312`);
  - at most 4 QBO requests at a time per company;
  - day close and history edits are exclusive.

### 3.3 Verification and recovery (where today's stalls came from)
- **Fresh reads:** verification always reads transactions fresh from QuickBooks (`50868c8`). One fixture per business chain lives in `business-operation-freshness.test.js`.
- **A failed check never stops everything:**
  - a failed check on a saved record re-reads it once;
  - if it still fails, only that step is marked `needs-check` and independent steps continue;
  - the day close still waits for it (`b37ecdd`);
  - re-checks run every minute (job H).
- **Lost replies settle themselves:** a lost response is resolved automatically under the standing grant, by attribution or proved-not-created, then the work continues (`07aeb27`, `714d8b8`).
- **Definition checks:** list and tax definitions compare canonically (`81af99a`, `c9b0942`, `2f48c45`, `ac17891`).
  - **The root cause of the care-plan stall:** QuickBooks added `Item.DeferredRevenue=false` to live reads. Absent and default-empty values now compare as equal.
- **An earlier day's close doesn't block today's work** (job G, `ac17891`).
- **Structured errors and stuck detection** (`ac17891`, job S, plus `fbd8e82`):
  - every refusal carries its code, the failing check's file:line, the record, and field differences;
  - this reaches runs, steps, the accountant's context, transcripts, the Live panel ("Blocked: …", no spinner), the work list and the build list;
  - anything stuck for more than 15 minutes becomes an attention item and a build-list entry;
  - `GET /api/company/business-agent/blockers` returns the current list.

### 3.4 Sync and QBO usage
- **Change-data-capture sync** (`a98df80`) keeps the mirror current. A nightly amount reconciliation against the AR/AP aging reports and bank balances proves it matches (`ffd92b8`).
- **Fewer calls per record:** about 2.5 metered calls per saved record in principle (`6d59455`). Fresh reads in verification (`50868c8`) add back about 7–39 GETs per operation chain, offset by report reuse (`6f319c1`).
  - Calls per purpose show in `qboRequests.today.callers`.
  - The budget is 10,000 metered non-sync calls/day and 450,000/month (Intuit's free tier is 500,000).

### 3.5 Other
- **Reproduction:** cases search existing records first and write through the governed path (`ac17891`, job M).
- **Codex subscription deployment:** `docs/deployment.md`, plus `ed7ad03`.
- **nodemon:** `backend/nodemon.json` watches `src` only, with a 3-second delay (`efb208e`). This took effect after the owner restarted at about 18:50 UTC.
- **Skills and the "lock" protocol for parallel builders:** section 6.

---

## 4. Live state at hand-off (update this section at the pause point)

These numbers are the latest when written. Re-read them live first (section 0).

- **Records:** Saturday 2026-10-31 (Halifax). 73 records in QuickBooks today, 72 verified, against a target of 220. The day lost about 10 hours to the stalls described in section 8.
- **Calendar:** verified through 2026-10-30. Tonight's 00:05 Halifax (03:05 UTC) close of Oct 31 is the first close that includes a general-write record.
  - The `generaldaycloses` collection and its index were added at about 22:20 UTC through the new governed additive setup (`1568826`):
    - preview: `POST /api/company/business-setup/storage/preview {"profile":"general-writes"}`;
    - apply: `POST .../storage/apply {"profile":"general-writes","planHash":...}`, which returned `complete`;
    - index confirmed.

    Use the same route for any future missing collection or index.
- **First general-write record:** Anna Katz's $1,000 credit application. The accountant still needs to verify the related balances.
- **Six overdue imported invoices, CAD 1,591.44,** are still unsettled. The old key blocker is fixed. The accountant now needs to actually collect them.
- **Blocking sales at hand-off** (job W is fixing both):
  - the three regional customers the accountant added are refused as "changed after creation" (`business-added-roles.js` ~170, same class as the DeferredRevenue issue);
  - the general tool refuses current-day taxable sales with tax code 16 (NS HST 14% from 2025-04-01).
- **The full backend suite** was 2427 tests: 2425 pass and 2 are intentionally skipped, as of `ac17891`.

---

## 5. How to operate (procedures that work)

### Sol workers (the only builders)

```bash
cd C:/Projects/qbo
S=.claude/skills/qbo-team-delivery/scripts/codex.sh
bash $S task --background --write --model gpt-6.1-sol --effort xhigh "<prompt>"   # builder
bash $S task --background --model gpt-6.1-sol --effort xhigh "<prompt>"           # read-only reviewer
bash $S status <task-id>      # running/completed/failed
bash $S result <task-id>      # final answer
```

Arm a Monitor on `bash .claude/skills/qbo-team-delivery/scripts/codex-watch.sh <task-id>` in the same step as starting the job. Codex jobs don't notify Claude by themselves.

**Shared prompt preamble** (copy from `$CLAUDE_JOB_DIR/tmp/common.txt` if it still exists; otherwise reuse this):
- no commits, services, QBO calls or MongoDB writes; read-only queries are allowed (dotenv from `C:/Projects/qbo/.env`, mongoose from `backend/node_modules`; never print secrets);
- each job owns its listed files;
- other files need a lock: `mkdir C:/Users/NewAdmin/AppData/Local/Temp/qbo-locks/<basename>.lock`, a minimal edit, then `rmdir`. This folder is writable by Sol's sandbox. The helper script `.../jobs/1f8ad8d6/tmp/lock.sh` will vanish with this job;
- **prepare and test first, then write `backend/src` files in one final batch**, because every save restarts the live backend and kills the accountant's run in flight;
- run the affected `node --test` files;
- "Do not stop to ask; record decisions";
- the final answer lists what changed, files and tests.

**Rules that made Sol jobs work:**
- **Give it the live evidence:** the error text, `errorDetail`, ids, stack.
- **Require an offline replay of the real stored data before saving.** Three blind fixes failed today because the replays didn't follow the live path.
- **Disjoint file ownership** per parallel job.
- **`codex.sh cancel` is unreliable on Windows.** It often leaves the job running. Prefer letting a job finish.
- **Sol's sandbox can't open `localhost:5173`.** Rendered UI checks must be done by you, minimal and only when needed.

### Committing
- After each job: `git status`; stage that job's files only. Check for hunks from other jobs in shared files such as `business-agent-tools.js` and `business-agent-service.js`.
- Commit with a plain-English subject and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, then `git push`.
- When jobs are interleaved, commit them together after one full run of `npm run test --workspace=backend` (about 10 minutes; run it in the background).

### Live checks (cheap)
- **The accountant's runs:** a watcher script polls `/company/business-agent/transcripts` and prints each finished attempt.
- **Why a run is blocked:** read `operationruns.executionRequest.result.errorDetail` read-only, or `/blockers`.
- **Codex login:** `node -e "require('./src/modules/codex-cli').getStatus({refresh:true})..."` from `backend/`. Expect `status: 'ready'`.

### Runtime ownership
- The owner owns starting and stopping services. Never kill a port owner.
- nodemon reloads on every `backend/src` save. The `.env` file is not watched, but any `src` save reloads it.
- Turning a flag on in `.env` is allowed when it's needed for the owner's goal. Append it without reading or printing the file.

---

## 6. In flight at hand-off

| Job | Task id | What | When it finishes |
|---|---|---|---|
| V | task-mvwy98pl-d2a54w | Governed additive storage preparation | **DONE.** Committed `1568826` and applied live (section 4). |
| W | task-mvwyf9c4-bnefef | Added-customer fingerprint and tax code 16 | **DONE.** Committed with this document; confirm live sales to the 3 regional customers. |

---

## 7. Open work, in priority order

Every item needs live proof: records in QuickBooks, a day closing, or a blocker gone.

1. **Keep the business producing.**
   - The target is 220/day across 24 hours, with several batches in parallel.
   - After V and W, watch `/blockers`, `today.line` and `agent.summary` on every check. Send every new blocker straight to Sol with its `errorDetail`.
   - **The build list is the work queue.** Read `management.capabilityRequests` at every check.
   - At hand-off it held 20 items, about half already fixed by today's commits. Have Sol triage it: mark resolved items with evidence, and fix the rest.
   - Open items include:
     - existing-payment deposits and a second bank role;
     - legacy credit and payment application;
     - legacy corrections, including HST and equity journals;
     - inventory quantity adjustments;
     - a close checklist with evidence;
     - billable expense invoicing;
     - credit card and cheque workflows;
     - master-data maintenance;
     - classes, locations and custom fields on activity;
     - foreign-currency bills (needs multicurrency, which is owner-only and irreversible).
2. **Tonight's close of Oct 31 (03:05 UTC), the first close with general-write records.** Watch it. If it fails, `errorDetail` says why.
3. **Collect the six overdue imported invoices (CAD 1,591.44),** and verify the Anna Katz credit application's balances.
4. **QuickBooks call economy.** Check `qboRequests.today.callers` and keep the average at 3 or fewer metered calls per saved record. Fresh reads in verification raised it. Find any remaining waste.
5. **Turn inventory on in the general tool** once general writes have had a clean day:
   - finish returns (`docs/plans/general-inventory-write-implementation-2026-10-31.md`);
   - then set `GENERAL_WRITE_INVENTORY_ENABLED`.
6. **History re-verification for fixed-workflow and adopted records.** Job H covered general records only (`docs/plans/history-reverification-job-h-2026-10-31.md`).
7. **Inspect the "Record something" panel rendered** on desktop (`/company`, Directions & controls tab), and fix any problems.
8. **Landing page overhaul.** This is a TODO with a full review in `docs/plans/landing-page-overhaul-todo-2026-10-31.md`. Build a polished rendered slice and get the owner's acceptance before rolling it out.
9. **Multicurrency is already enabled** in the live company (synced Preferences 1, found by job C on 2026-10-31). No owner decision needed; foreign-currency writing is being built (job F).
10. **Specialists (R13/R14)** only if they would measurably help.
11. **Deployment on the Codex subscription:** `docs/deployment.md` is written but untested on a server.

Full blocker audit, ranked by impact: `artifacts/blocker-audit-2026-10-31.md`. Most of its top items are now fixed; re-check it.

### 7a. What "done" means (success measures, judged live)

- **Volume and continuity:**
  - about **220 records a day**, every day, spread across 24 hours;
  - the calendar closes nightly without manual help;
  - a stalled calendar or an idle accountant is a top defect.
- **Breadth:** every major QBO record type, class and location appears every week:
  - terms;
  - partial, late and unapplied payments;
  - credits;
  - refunds;
  - estimates → invoices;
  - POs → receipts → bills;
  - deposits;
  - transfers;
  - journals;
  - month-end work;
  - recurring billing.
- **Coverage gaps are measured** (`/coverage` and the management review) and shrink over time.
- **No stuck work:** `/blockers` is empty or each entry is actively being fixed. Nothing is blocked for more than 15 minutes unnoticed.
- **Economy:** 3 or fewer metered QBO calls per saved record on average. Stay within 10,000 metered non-sync calls a day and 450,000 a month.
- **Autonomy:** the accountant fixes problems itself and files exact build-list items. The owner is never asked for routine approvals.
- **Visibility:** the first page shows honestly what is happening, live (R11, R12).

### 7b. Known issues, bugs, limits and bottlenecks at hand-off

Each item is a known current fact; verify it before relying on it.

| Area | Issue | Status / next step |
|---|---|---|
| Sales | Accountant-added customers refused as "changed after creation" | Fixed by job W; confirm live sales to the 3 regional customers |
| Tax | Code 16 sales refusal | Already fixed by `81af99a` (replay confirmed); confirm live |
| Accountant memory | Retained notes go stale and contradict live state (it believed the six collections and the care-plan item were still blocked after they were fixed) | Current state now overrides some notes (`6f319c1`). Watch for it, and have Sol make retained "blocked" notes expire when the blocker clears. |
| QBO economy | Fresh reads in verification (`50868c8`) added about 7–39 GETs per operation chain | Measure with `qboRequests.today.callers`, then have Sol trim it |
| Inventory | General-tool inventory is off; returns unfinished | §7 item 5 |
| History | Edits to verified history are allowed only for general-tool records; fixed-workflow and adopted records are refused | §7 item 6 |
| Unsupported | Foreign-currency transactions (needs multicurrency, the owner's switch) | Owner decision |
| UI | The "Record something" panel has not been inspected rendered; the landing page needs its overhaul (duplicate status panels, technical detail, no business-health or coverage view) | §7 items 7–8 |
| UI | The Live panel shows completed items, not word-by-word streaming of the model's output | Not started (owner asked earlier for live streaming of reasoning and chat) |
| Manage page | `/company/manage` still has panels from the owner-approval era (publication, saved-plan approvals, bulk history) that may be obsolete | Audit it with the landing-page work |
| Legacy data | FOUNDEVER deposit 11004 (an owner contribution needing a supported correction); about 55 old open imported invoices; legacy credits and payments not applied | Build list: `legacy-record-corrections`, `legacy-credit-payment-application` |
| Review limits | 400 reviews a day (failures count toward it); monthly AI caps; ChatGPT plan quota; an unreadable usage history halts reviews | See the blocker audit; size the limits so they never stop normal operation |
| Runtime | Each `backend/src` save restarts the backend and kills the accountant's run in flight; `codex.sh cancel` is unreliable on Windows | Write once per job; let jobs finish |
| Skills | Some QBO API facts in the skills are marked "verify" (batch size limits, void calls for some entities, fault codes) | Confirm against Intuit's docs as each is used |
| Specialists | None enabled (R13/R14) | Only if measurably useful |
| Deployment | `docs/deployment.md` is untested on a real server | Before deploying |
| Tests | 2 request-economy tests are skipped as superseded by `50868c8` | Rewrite them for the fresh-read design when convenient |
| Concurrency | Another session commits in this repo | Re-read files before editing, and stage only your own hunks |

### 7c. Items carried over from Oct 29–30 still open

- Six overdue imported invoices (CAD 1,591.44) need collecting. The six collections are free of the old key blocker.
- The FOUNDEVER deposit 11004 correction and the old imported open invoices.
- Multicurrency, specialists and deployment.
- Proving tonight's close of Oct 31, and then the first full-volume day.

---

## 8. Lessons from this session (what cost the most, and the rule that prevents it)

| What happened | Rule |
|---|---|
| The accountant was built around 15 hand-coded transaction shapes, giving 2–9 records/day. | Give the model general governed reach. Don't hand-code shapes. |
| "Continuous" was built as hourly slots, and the owner found out. | Continuous means back to back while work exists. Read the owner's literal words. |
| An efficiency change (verify from saved responses and the mirror) broke verification whenever a later step changed an earlier record. That caused 3+ separate stalls. | A change to the write or verify pipeline needs a single-operation fixture per business chain, with stale copies present (`business-operation-freshness.test.js`). |
| A failed check on an already-saved record stopped the whole business for hours. | Stop the business only for real book risk: a rejected write, a proven wrong posting, or an unknown outcome that could duplicate. Everything else marks needs-check and continues. |
| Three blind fixes for one error (care-plan Item). The cause was a new QBO field, `DeferredRevenue`. | Instrument first: `errorDetail` with stack, source and field differences. Never ship a fix without replaying the real failing data. |
| The accountant's build list diagnosed the problem at 20:03 and nobody acted on it. | Read the build list and `/blockers` at every check. They are the work queue. |
| Builder file saves restarted the backend and killed live runs and replies. | Sol writes `src` once at the end of a job. `nodemon.json` watches `src` with a delay. |
| A deployment change (`--ignore-user-config` on `codex login status`) silently switched the accountant to Anthropic, and every run failed. | After any provider or runtime change, check `codex-cli getStatus()` returns `ready` and that the next run's provider is `codex`. |
| I reported "this should unblock it" before seeing live proof. | Report only what the live company shows. |
| Status messages were long and repeated. | Keep messages short. Don't re-explain background events that changed nothing. |

---

## 8a. Every issue that came up in this session (chronological): cause, fix, status

| # | Issue observed | Cause | Fix (commit) | Status |
|---|---|---|---|---|
| 1 | Calendar stuck at Oct 28 for about 20 hours | Re-issuing the agent grant changed the "immutable agent origin" | `af5ab28` (`sameAgentLineage`) | Fixed |
| 2 | Accountant chased an operation id that didn't exist (it was an event id) | Unclear tool error | `51ff130` | Fixed |
| 3 | 2–9 records a day; "lazy", "not medium-sized" | Hourly reviews, low targets, 15 hand-coded workflow shapes | Cadence `bc2acd5` → `4d1bbdc`; general tool `1865beb`…`73dddf2` | Fixed in design. Volume not yet proven live. |
| 4 | Sync used about 1,000 QBO requests an hour | Full polling | CDC `a98df80`; reconciliation `ffd92b8` | Fixed |
| 5 | Owner couldn't see what the accountant was doing | No live view | `5cb327b`, `43fe361`, later `R3` | Fixed. Word-by-word streaming not done. |
| 6 | Six overdue collections blocked all day | Expired Oct 29 preview kept its decisionKey; accountant also kept a stale "blocked" note | `6dbcd6d`, `8619270` (repeat-decision guard), `91df204` (readiness) | Key fixed; collections still not done |
| 7 | v8 review: partial payment could repeat on day 3; terms work bypassed slice limits | Day-scoped key logic; missing `SLICE_TYPES` | `8619270` | Fixed |
| 8 | About 100 QBO calls per saved record | Re-reads, 7 reports per change, live lookups | `6d59455`, `6f319c1` | Improved. Fresh reads (`50868c8`) added some back; re-measure. |
| 9 | Business stalled about 6 hours (receivables bracket) | Saved create response compared after a same-operation payment changed the invoice | `c5b1c27`, `12e5be8`, `07cacfb`, `50868c8` | Fixed |
| 10 | Business stalled: lost time-entry reply needed an owner decision | Unknown-outcome recovery required the owner | `07aeb27`, `714d8b8` (automatic attribution or not-created, then continue) | Fixed, proven live (TimeActivity 1073742965) |
| 11 | Builder file saves killed live runs and replies | nodemon restarted on every save | `efb208e`; Sol writes once per job | Mitigated |
| 12 | "Sessions": hourly slots with 15–60 minute waits | Timer design | `4d1bbdc` (continuous) | Fixed |
| 13 | One failed check stopped the whole business | All failures treated as book risk | `b37ecdd` (needs-check), H re-checks | Fixed |
| 14 | Only one batch could write at a time | Single company writer | `d80f312`, `6f319c1` | Fixed in code. Several batches running together not yet seen live. |
| 15 | A review stopped after 24 tool calls | Hidden cap of 24 despite the configured 60 | `e56f54d` | Fixed |
| 16 | Estimate → time → invoice chain never verified | Time entry observed "Billable" after it was billed | `11e334f`, `50868c8` | Fixed |
| 17 | Care-plan Item 44 refused about 2 hours; 3 blind fixes failed | QBO added `Item.DeferredRevenue=false` to live reads | Diagnostics R3; fix `ac17891` (absent ≡ default) | Fixed, proven live |
| 18 | New quotes refused: tax-policy mismatch | General guard allowed only the old tax code 12 | `81af99a` | Fixed; the 20:00 refusal predated the fix (job W confirmed by replay) |
| 19 | Every run failed and switched to Anthropic | `--ignore-user-config` passed to `codex login status` (`ed7ad03`) | `82d2cde`, `318d99d` | Fixed |
| 20 | Live panel showed "Sending to QuickBooks…" with a spinner for an hour on a blocked step | No blocked state in the feed | R3 (`ac17891`) | Fixed |
| 21 | The accountant's build list had diagnosed the item problem; nobody acted | Build list not read by the orchestrator | Process rule + stuck detection + `/blockers` (`ac17891`) | Fixed (process) |
| 22 | Errors were one line with no location or fields | Errors flattened when recorded | Job S `business-error-detail.js` (`ac17891`), `fbd8e82` keeps denial messages | Fixed |
| 23 | First general-write plan (credit application) refused 6 times | Retries left the run "prepared" instead of "sending" | `fbd8e82` | Fixed; the record saved live |
| 24 | General close table and index missing in MongoDB | v6 storage profile never applied; no route for populated storage | `1568826` + live preview and apply | Fixed |
| 25 | Added regional customers refused as "changed after creation" | QBO adds `ClientEntityId: "0"` and `V4IDPseudonym` to live Customer reads; no authenticated canonical baseline | Job W (`business-added-roles.js:161`), commit after this table | Fixed; live use not yet seen |
| 26 | Several Sol jobs: lock folder not writable by Sol; Sol mistook its own earlier edits for another session's; `codex.sh cancel` unreliable | Sandbox and Windows limits | Locks moved to `%TEMP%/qbo-locks`; prompts say leftover edits are the job's own | Known; see §5 |
| 27 | Claude usage limits reached twice | Four parallel Claude builders | Owner: Sol-only builders, Claude orchestrates | Rule for the next session |
| 28 | Orchestrator over-claimed ("this should unblock it") and wrote long status messages | Reporting before live proof | Rules in §1 and §8 | Ongoing discipline |

## 8b. What the previous orchestrator did wrong, and what to avoid

Plainly, so you don't repeat it.

1. **Built the wrong thing and called it done.**
   - "Continuous" was built as hourly slots.
   - "Fully tooled" was built as 15 fixed forms.
   - Both were reported complete.

   **Avoid:** before building, restate the owner's literal words and check the design against them. Before reporting done, prove it in the live company.
2. **Reported intentions as results.** "This should unblock it" was said three times, and it didn't. **Avoid:** report only what the live company shows: records, blockers, closes.
3. **Fixed blind.** Three fixes for one error went out before anyone knew which field or code path failed. **Avoid:** instrument first (`errorDetail`, stack, field differences), and replay the real failing data before shipping.
4. **Ignored the accountant's own build list.** It had the right diagnosis hours earlier. **Avoid:** read `/blockers` and the build list at every check, and act on high-priority items immediately.
5. **Optimized before it worked.** The request-economy change replaced live reads in a strict verification pipeline and caused several outages. **Avoid:** correctness and flow first, economy second, and only with a fixture per business chain.
6. **Treated every doubt as "stop the business".** **Avoid:** stop only for real book risk. Everything else marks needs-check, carries on, and retries.
7. **Ran four Claude builders at once.** That hit usage limits twice. They also edited the same files, and their saves restarted the live backend. **Avoid:**
   - Sol builders only;
   - disjoint file ownership;
   - one write batch per job;
   - commit per job;
   - keep a job board.
8. **Left Sol slots idle, then over-launched.** **Avoid:** keep a steady queue. Start the next job when one finishes; don't launch five at once without a plan for overlapping files.
9. **Changed runtime-critical code without a live check afterwards.** The Codex login regression made every run fail and fall back to Anthropic. **Avoid:** after any provider, runtime or config change, confirm the next live run immediately.
10. **Didn't look at the UI.** The Live panel showed a spinner on a blocked step for over an hour. **Avoid:** look at the rendered first page after UI-affecting changes, and whenever the owner sends a screenshot.
11. **Long, repetitive messages; over-apologizing; re-explaining background noise.** **Avoid:**
    - a few plain sentences: the result, then the next step;
    - say nothing about background notices that changed nothing;
    - own mistakes once, without overcompensating.
12. **Asked or hedged when the owner had already decided.** **Avoid:** act within the standing autonomy grant. Ask only for genuinely owner-only, irreversible choices such as multicurrency.
13. **Committed mixed trees late.** **Avoid:** commit each job's own files as soon as it lands, and run the full suite in the background after combined commits.
14. **Let watchers expire or duplicate.** **Avoid:** one attempts watcher at a time, re-armed every 30 minutes, plus one watcher per Sol job.

## 9. Key documents

- Owner contract and requirements:
  - `prd.md`
  - `docs/plans/continuous-business-operator-completion-2026-10-24.md`
- Continuous activity plan: `docs/plans/continuous-business-activity-2026-10-30.md`
- General write tool contract: `docs/plans/general-governed-write-tool-2026-10-31.md`
- Capabilities and decisions:
  - `docs/plans/general-write-capabilities-2026-10-31.md`
  - `docs/plans/general-inventory-write-implementation-2026-10-31.md`
  - `docs/plans/history-reverification-job-h-2026-10-31.md`
  - `docs/plans/business-error-surfacing-job-s-2026-10-31.md`
  - `docs/plans/request-economy-2026-10-31.md`
  - `docs/architecture/business-observation-freshness.md`
  - `docs/architecture/business-agent-sync-reconciliation.md`
- Full tooling history: `docs/plans/accountant-full-tooling-2026-10-29.md`
- Landing page TODO: `docs/plans/landing-page-overhaul-todo-2026-10-31.md`
- Deployment: `docs/deployment.md`
- Blocker audit: `artifacts/blocker-audit-2026-10-31.md`
- Handoff log (newest first): `docs/agent-harness/FULL_GOAL_EXECUTION.md`
