# Current implementation session assignment

Updated: 2026-11-01T21:23:48.369Z. Assignment: BANK-1. Status: IMPLEMENTED / DIRECT APPLICATION PROOF OPEN. This is the authoritative next-session boundary; it supersedes the earlier chat prompt that bundled the full first bank release and automatic issuance into one session. It does not supersede the full app/bank outcome or change live authorization.

## Current BANK-1 evidence

2026-11-01T21:23:48.369Z: frontend `0281720` and backend `1d8d24f` / `2871cef` are committed/pushed on `main` to `origin/main`. The account workflow is at `/company/bank`. Acceptance is **not complete** while actual desktop/download/reload evidence remains open. See [BANK-1 evidence](bank-1-evidence-2026-11-01.md).

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

## Browser route and early verification

For BANK-1 the remaining outcome is inspection of the already running local app, download clicks and reload. The established desktop-free route is the isolated agent-browser workflow used by Claude Code through Terra `--flow`; Terra is the coordinating model, not a desktop-browser dependency. Use a separate owned BANK-1 app-verification session, never the persistent qbo-ops session solely for localhost. The [readiness command](../agent-harness/BROWSER_READINESS.md) is a separately verified isolated-browser check; it does not repair or prove the app-managed cua_repl plugin. Follow current hidden launch/authentication rules without minting sessions or retrieving credentials absent authority.

Before material UI implementation, confirm one allowed browser route can reach the intended running app, capture its real desktop state and exercise the planned download mechanism. If a route fails, record the exact error once and select another already authorized route; do not make the owner diagnose routine tool selection. If active tool instructions require explicit permission for alternative automation, ask once with the exact local origin, actions and exclusions. Reuse that approval for the same scope; documentation alone is not approval. Continue independent work while a necessary answer is pending and keep rendered acceptance OPEN.

The original cua_repl API also worked overnight: Terra rollout 01a19573-e4cb-77c3-b8cf-68463bcff0ba records successful getState/getBrowser/getTab at04:52 UTC. Do not dismiss that evidence as unsupported CLI. The current startup has a concrete mismatch: the official desktop app regenerated the shared unified plugin at21:33 with a bootstrap that requires its signed browser-access host, while this terminal process lacks its pipe/verifier/executor binding. The native desktop pipe is separately absent. Both independent source reviewers confirmed the host lifecycle is app-owned and no supported standalone host starter was established. Removing the bootstrap or inventing/copying host identity would bypass the current check and is not a repair. Original-tool restoration requires genuine host/session wiring and remains UNMET; simply opening an app is not proven to repair this terminal process. The unified manifest contains the environment-variable pass-through names, but the inspected CLI parent has no values to supply. Do not invent values or bypass access checks. A platform-tool repair remains separate and unverified. First identify the actual tool used by the successful session before diagnosing a regression.

Historical evidence: Claude session 5c0ba517-1424-42c8-818a-42acc6d80f63 invoked Terra `--flow qbo-ops` at 2026-11-01T05:01:17Z and recorded at 05:19:53Z that Chrome-plugin upload confirmation was the reason for switching. The retained qbo-ops-20261101-013249 run rendered the native report and saved screenshots. Its requested PDF was separately refused by Terra’s screenshots-only instruction. Before using Terra for BANK-1 downloads, resolve that task/runner restriction against the owner’s exact named download scope; do not mistake it for a broken browser or retry an unchanged forbidden task. The already authorized direct isolated automation route remains available for the named BANK-1 files.

For actual QBO banking use the existing shared qbo-session coordinator and qbo-ops flow per the Terra reference, exact company/account/period authority and native barriers. The earlier decision rejected unattended financial-file uploads through the owner's Codex Chrome extension; changing tools does not remove financial, upload or authorization rules.

## Lead and handoff responsibilities

The implementation lead owns BANK-1. It may delegate independent bank-state/download and desktop-view work with concise briefs and disjoint file ownership, then obtain the required distinct reviews. Follow the shared queue, Windows hidden-command, commit/push and work-value rules. After the existing fifteen-minute essential checkpoint, change an unproductive approach or continue independent BANK-1 work; preserve safety and any uncertain in-flight outcome. Do not expand BANK-1 to solve unrelated historical repairs or build a new general banking framework.

Stop after all five acceptance conditions pass. Update this file to DELIVERED with chosen account/period IDs, exact observed evidence, commit/upstream and limitations; update the shared task rows and handoff. The managing/review session checks that result before issuing BANK-2. Do not stop at a plan, source-only foundation or test-only proof; do not silently enlarge the assignment. If essential external authority or evidence is missing, record exact incomplete conditions and continue independent scoped work before reporting a blocked result.

## Prompt to start the implementation session

Copy the following text into the next session. The linked assignment controls scope if an older chat prompt differs.

~~~text
Work in C:\Projects\qbo. Implement BANK-1 exactly as defined in docs/plans/current-session-assignment.md. Read AGENTS.md, AGENT_WORKFLOW.md, the current handoff and the shared task list, then the applicable rules/skills and only the source needed for BANK-1.

Deliver the fixed milestone: one representative existing CAD bank account and one existing CAD credit-card account with durable bank balances/history, a usable rendered desktop account workflow, and working CSV/PDF downloads. All five acceptance conditions in the assignment must be satisfied. Reuse the existing banking foundations and retained evidence. This is a bounded first delivery; the full app, all accounts/history, future automation and QBO reconciliation remain required in later milestones.

For the BANK-1 local app inspection, use the repository’s existing isolated headless/agent-browser automation at desktop size against the already running app. Verify page interaction, the two accounts’ CSV/PDF download clicks and reload. This requests that alternative browser technology for this scope; do not use the owner’s Chrome extension, native desktop control, QBO writes, service restarts or browser/security settings changes. Run npm run verify:browser -- --origin http://localhost:5173 before substantial implementation and follow all active tool policies. Exit 2 leaves normal app sign-in and authenticated BANK-1 acceptance open; never mint a session or count the synthetic probe as banking proof.

You are the lead. Use subagents only for useful independent deliverables, with concise self-contained briefs, disjoint file ownership, exact proof and checkpoints. Relay the current Windows command-launch rules. Keep normal business running and independent historical work moving where already authorized, without letting repairs consume the feature assignment. Follow the documented stop-loss rules, proportionate verification and required independent reviews. Preserve accepted records/files, concurrent work, company scope and existing service/database/QBO authorization boundaries.

Do the implementation and verification; do not return only a plan. Stop when BANK-1 is usable, directly verified, committed and pushed, with the assignment, task list and handoff updated. Report the five acceptance results, real evidence, commit/upstream and remaining gaps. If a core condition cannot be verified, state it explicitly and do not claim completion. Do not broaden this session to BANK-2 or BANK-3.
~~~
