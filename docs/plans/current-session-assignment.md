# Current implementation session assignment

Updated: 2026-11-02T05:33:37.024Z. Assignment: BANK-1. Status: DELIVERED. All five fixed acceptance conditions are directly verified; stop this session. BANK-2/BANK-3 remain separate, unstarted assignments.

## Current BANK-1 evidence

2026-11-02T05:33:37.024Z — **DELIVERED.** Actual1440×1000 account overview/history/transaction detail/return verified for bank123/Sep2023 (37 rows, CAD21,292.25) and card85/Apr2025 (3 rows, CAD300 owed). Four real CSV/PDF control downloads completed and match the retained hashes; downloaded contents/PDF pages, original row/event identity, balances and both normal authenticated reload/reopen paths passed. Loading, genuine empty month, unavailable period and recovery inspected. Main/origin/main code98ded95 (contrast fix) plus prior0281720/1d8d24f/2871cef; final evidence/docs closeout is this task’s final commit. Private proof: artifacts/bank-1/verified-20261102/verification-summary.json. [Full acceptance ledger](bank-1-evidence-2026-11-01.md). No owner action remains for BANK-1. Full SB01/SB02/D01 and BANK-2/BANK-3 remain OPEN beyond this bounded slice.

**Historical — superseded by S03 automatic app login:** the 23:16 UTC attempt could not attach the existing Chrome tab. That attachment is no longer required for BANK-1; use the verified private app helper below. Original attempt evidence remains in the dated BANK-1 record.

**Historical — superseded by S03 automatic app login:** the 23:10 UTC isolated browser reached /login without an app credential. The shared private credential now resolves that dependency; do not repeat the password, saved-profile, Chrome-sharing or CDP question.

2026-11-01T21:23:48.369Z: frontend `0281720` and backend `1d8d24f` / `2871cef` are committed/pushed on `main` to `origin/main`. The account workflow is at `/company/bank`. Historical source milestone only; the actual desktop/download/reload proof is now complete as recorded above. See [BANK-1 evidence](bank-1-evidence-2026-11-01.md).

Chosen acceptance scope (fixed once): production connected company ending 2856, existing CAD bank account **123**, **2023-09**, package `a86a4c4ff040c2ffed87384754e044446b8f8835433df3a5fd106a2c5a8abe65` revision 1; existing CAD credit-card account **85**, **2025-04**, package `87d08dcbc5ffd16ed2fce19f1aa15c206b4e711c067af9d53d79b48c32338a33` revision 1.

## Fixed delivery milestone: usable bank foundation

Deliver one existing CAD bank account and one existing CAD credit-card account through the actual application: persistent bank state -> working desktop account view -> downloadable CSV and statement PDF.

Choose representative accounts from the connected company's existing inventory with retained activity and evidenced openings; record the IDs and selection once. Do not create QBO accounts or choose empty accounts just to simplify proof. Reuse existing BankingEvent/BankingPackage, settlement, artifact and UI foundations. Select the smallest historical period with adequate retained evidence for each chosen account, without modifying accepted files or native records. These two accounts/periods define BANK-1 acceptance only; all accounts and historical periods remain in the full backlog.

### Required acceptance evidence

1. The retained bank state has explicit account identity, CAD currency, evidenced opening balance, posted transaction history and derived balance. Represent pending/posted status truthfully; unsupported or absent pending activity is explicit rather than invented. Keep separate stable bank event identity/lineage, and label historical QBO reconstruction as a baseline rather than independent bank confirmation.
2. The owner can open a bank-style overview, select either account and inspect its balance/as-of, retained transaction history and transaction detail, then return. Show meaningful loading, empty, failure and unavailable-evidence states. Use existing app authentication and a fictional bank identity.
3. For each selected account/period the owner can download a real CSV and simulated statement PDF through the normal application route. Use the existing generators/readers. Verify exact bank-native signs/amounts, opening + movements = closing, row/event identity and file hashes. Preserve accepted package revisions and native upload/reconciliation evidence.
4. Reload/reopen the page and read the same durable bank state and artifacts through normal application paths. Data must not exist only in component memory, hardcoded UI examples or a disposable test fixture. Use existing provisioned persistence where suitable; follow the actual authority boundary before provisioning/migrating/writing persistent storage. An unapproved required action is a precise blocked verification item, not permission to fabricate live proof.
5. Inspect the actual desktop workflow and downloaded artifacts, perform proportionate checks and required independent implementation/safety reviews, resolve concrete findings, commit/push owned changes and retain concise evidence. Isolated tests support acceptance; they do not substitute for the usable application flow. A blocked core acceptance item means BANK-1 is incomplete.

### Outside this session's required finish line

- Automatic recurring settlement and file issuance, all-account/currency expansion and complete independent future bank behavior: BANK-2, mapped to SB01/SB03/SB04/SB06.
- Completing all historical QBO uploads/matching/reconciliations and restart-safe ongoing native banking: BANK-3, mapped to D02/D03/SB05/SB07.
- Every bank edge case and every remaining app task. Keep them explicitly OPEN; do not mark full SB01/SB02/D01 complete from the bounded BANK-1 slice.

Keep existing business operation running. Already authorized, independent historical work may continue if it has an execution owner and does not steal the feature's only implementation capacity or violate shared browser/accounting locks. It is not a prerequisite for BANK-1. No new live authority, service control or QBO mutation is granted here.

## Browser route and app sign-in

2026-11-02T00:20:44.353Z: the former app-authentication/browser-attachment dependency is resolved for the established isolated agent-browser route. Follow [automatic local agent sign-in](../agent-harness/APP_AGENT_LOGIN.md). The owner explicitly authorizes reuse of the private app credential by local coding chats/agents, without repeated password, Chrome-sharing or CDP questions.

Run `node scripts/security/app-agent-login.cjs login --actor codex-cli` with the hidden Node launch method in AGENTS.md (Claude: actor claude-code). It returns a unique owned browser session and verified existing account/company, opening /company/bank. Continue all BANK-1 browser commands in that returned session and close only it afterward. Do not use qbo-ops for localhost.

Direct evidence: two independent fresh sessions reached the normal authenticated bank page and repeat login reused its session. This is real app login proof, not the synthetic readiness download. Remaining BANK-1 proof is the selected account/period journeys, four actual feature download clicks and authenticated reload/reopen. Preserve prior artifact/state evidence and do not mark these acceptance items complete from login alone.

The separate OpenAI CUA browser-host error has not been repaired by this work. It does not block this proven agent-browser route. Actual QBO banking keeps its existing qbo-session coordinator, company/action authority and native recovery barriers; app credentials do not grant QBO login or bookkeeping actions.

## Lead and handoff responsibilities

The implementation lead owns BANK-1. It may delegate independent bank-state/download and desktop-view work with concise briefs and disjoint file ownership, then obtain the required distinct reviews. Follow the shared queue, Windows hidden-command, commit/push and work-value rules. After the existing fifteen-minute essential checkpoint, change an unproductive approach or continue independent BANK-1 work; preserve safety and any uncertain in-flight outcome. Do not expand BANK-1 to solve unrelated historical repairs or build a new general banking framework.

Stop after all five acceptance conditions pass. Update this file to DELIVERED with chosen account/period IDs, exact observed evidence, commit/upstream and limitations; update the shared task rows and handoff. The managing/review session checks that result before issuing BANK-2. Do not stop at a plan, source-only foundation or test-only proof; do not silently enlarge the assignment. If essential external authority or evidence is missing, record exact incomplete conditions and continue independent scoped work before reporting a blocked result.

## Prompt to start the implementation session

Copy the following text into the next session. The linked assignment controls scope if an older chat prompt differs.

~~~text
Work in C:\Projects\qbo. Implement BANK-1 exactly as defined in docs/plans/current-session-assignment.md. Read AGENTS.md, AGENT_WORKFLOW.md, the current handoff and the shared task list, then the applicable rules/skills and only the source needed for BANK-1.

Deliver the fixed milestone: one representative existing CAD bank account and one existing CAD credit-card account with durable bank balances/history, a usable rendered desktop account workflow, and working CSV/PDF downloads. All five acceptance conditions in the assignment must be satisfied. Reuse the existing banking foundations and retained evidence. This is a bounded first delivery; the full app, all accounts/history, future automation and QBO reconciliation remain required in later milestones.

For BANK-1 local app inspection, use the shared automatic app login helper in docs/agent-harness/APP_AGENT_LOGIN.md and continue in its returned isolated agent-browser session at desktop size. This authorizes the named local screen/download/reload verification. Do not ask for a password, Chrome sharing or a CDP port. Do not count the synthetic readiness probe or successful sign-in alone as BANK-1 acceptance.

You are the lead. Use subagents only for useful independent deliverables, with concise self-contained briefs, disjoint file ownership, exact proof and checkpoints. Relay the current Windows command-launch rules. Keep normal business running and independent historical work moving where already authorized, without letting repairs consume the feature assignment. Follow the documented stop-loss rules, proportionate verification and required independent reviews. Preserve accepted records/files, concurrent work, company scope and existing service/database/QBO authorization boundaries.

Do the implementation and verification; do not return only a plan. Stop when BANK-1 is usable, directly verified, committed and pushed, with the assignment, task list and handoff updated. Report the five acceptance results, real evidence, commit/upstream and remaining gaps. If a core condition cannot be verified, state it explicitly and do not claim completion. Do not broaden this session to BANK-2 or BANK-3.
~~~
