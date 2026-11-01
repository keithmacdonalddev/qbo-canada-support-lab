# Simulated online bank, current feeds and reconciliation

Recorded: 2026-11-01T20:47:57.921Z. Owner clarification, 2026-11-01. Status: OPEN; this document records the required outcome, not an implemented bank or new live-action authority.

## Owner outcome

Provide the experience of opening a simulated online bank, like checking a business account in RBC online banking: account and card balances, pending and posted activity, transfers, transaction search/history, monthly statements and downloadable transaction files. RBC is an experience reference; use a clearly fictional bank identity and the app's existing access controls. No real-bank credentials or real money are involved.

This is part of the full Test Data Lab outcome, alongside ordinary trading, deliberate QBO situation coverage, the accountant's decision-making, owner controls and truthful visibility. It is not satisfied by exporting the QBO ledger to CSV/PDF. The owner and accountant both need usable, governed access to the simulated bank's responsibilities.

The intended flow is:

Business instructions and economic events -> simulated bank ledger and settlement -> bank CSVs/statements -> QBO import and matching/classification -> native QBO reconciliation evidence.

The bank retains its own durable account-native ledger and balance history. Business payment/deposit instructions can originate in the business workflow, but settlement outcomes and bank-origin activity have separate identities, posting dates and status. Observing or editing QBO must not silently rewrite bank history to make reconciliation pass.

## Existing evidence and limits

- Read-only artifact inspection in this conversation found 317 simulated statement packages for 317 account-months across 12 bank/card accounts, 75 CSVs and 317 statement PDFs, dated within April 2020–October 2026. All 392 referenced CSV/PDF files existed and matched their retained manifest hashes. These counts describe generated artifacts, not comprehensive historical coverage, accounting accuracy, registration, successful upload or reconciliation.
- The separately dated app observation at 18:22 UTC listed 208 registered periods, one with reconciliation evidence, 47 unconfirmed uploads, one confirmed upload and 160 requiring no upload. Earlier generation reported 109 deferred account-months and seven drafts. These denominators and times differ; refresh and explain them rather than adding them together or marking all periods done.
- Current modules already provide settlement reconstruction, explicit bank-origin scenarios, CSV/PDF generation, immutable banking event/package storage, artifact downloads, native task handling and recorded evidence. Reuse these foundations. Source inspection found no production caller scheduling new statement-package generation; the accountant's prepareBankingPackage tool registers already generated files.
- Historical reconstruction from QBO is a labelled setup baseline. It is not an independent bank witness proving the same QBO books correct. Existing accepted records, files and native import/reconciliation evidence must be preserved.

## Deliverables and acceptance

Task IDs SB01–SB07 live in the [maintained task list](app-completion-task-list-2026-11-01.md). D01–D04 remain the historical generation/catch-up work; S01/S02 remain shared browser access. Update those rows and this evidence record together at verified milestones.

1. **SB01 — Durable bank accounts and ledger.** Maintain fictional bank/card account identity, currency, mapped QBO account, opening basis, bank balances, pending/posted/reversed events and stable economic identities. Preserve exact native-currency amounts, card sign conventions, both transfer legs and documented FX allocations. Historical openings require retained evidence; expose gaps instead of inventing balancing entries. Keep cash-count evidence separate from bank/card feeds.
2. **SB02 — Bank-style desktop workspace.** Open the account overview, choose an account, inspect balances/as-of dates and pending/posted history, find transaction detail, view monthly statements and download CSV/PDF files. Include meaningful empty, loading, failure and recovery states and clear links back to QBO import/reconciliation progress. Owner and accountant act on the same scoped bank state; render and inspect a coherent desktop slice before broad adoption.
3. **SB03 — Continuing banking behavior.** Advance settlement on the governed business calendar, including weekends/posting delays, receipts/deposits, supplier payments, card activity, transfers, fees, interest, returns/NSF, reversals and deliberate matching edge cases. Record a bank event once and preserve its lineage to any bookkeeping counterpart. Schedule ordinary activity and deliberate coverage continuously without manufacturing volume or retroactively changing reconciled history. Unexplained items remain visible for investigation.
4. **SB04 — Automatic downloadable files.** Detect eligible accounts/periods and newly posted events; generate, retain and register CSV downloads and monthly PDF statements without a coding agent manually preparing each batch. Permit current-period feeds and final statements for closed cycles. Retain file hashes, source event IDs, export windows, revisions and cumulative/incremental semantics so a later download or retry cannot silently duplicate earlier imports. Zero-activity months still have statement/balance evidence. Complete carry-forward checks and preserve earlier exports when corrections require a reviewed revision.
5. **SB05 — Complete the QBO banking workflow.** Using the existing governed browser coordinator, import exact files, handle bank-rule preflight, inspect duplicates, Match/Add/Exclude appropriately, attach the appropriate simulated statement where supported, and complete reconciliation with retained native QBO evidence. Resolve genuinely uncertain earlier uploads before retrying. A returned model summary, app flag or downloaded PDF is not proof of native completion. Demonstrate actual statement attachment separately; if unavailable, expose the exact supported alternative and limitation. Reuse existing valid company/workflow authority; this plan does not authorize new live mutations or bypass unchanged-record/protected-period boundaries.
6. **SB06 — Explicit currentness and lag.** For every account show bank activity posted-through/as-of, feed generated-through, QBO imported-through, rows reviewed-through, statement available-through, native reconciled-through, and the next due action with blocker/age. Dates advance only from their own evidence, not another stage's success. Measure missing accounts and due periods against a complete scoped inventory, not only registered packages.
7. **SB07 — Restart-safe ongoing operation.** Prove catch-up and later period generation after restart, interrupted upload, lost acknowledgement, logout and a genuinely blocked account. Preserve accepted imports/matches/reconciliations and immutable bank history. Keep unrelated accounts and ordinary trading progressing wherever their actual dependencies permit. Demonstrate repeated unattended cycles with retained outcomes, measured lag and observed recovery; tests and timers alone do not prove endurance.

## What up to date means

- **Bank activity current:** the simulated ledger has processed all settlement/bank-origin events due through the displayed business cutoff, with pending items and any overdue work explicitly shown.
- **Bank feed current:** every eligible posted event through that cutoff is represented in retained downloadable files and its QBO import/review state is known. Publishing files alone does not mean imported or matched.
- **Reconciliation current:** every bank/card account is natively reconciled through its latest completed statement cycle due at the displayed cutoff, with the statement, ending balance, outstanding items and native completion evidence retained. Do not claim the open current month is a completed monthly reconciliation; keep its feed/review current and show its next reconciliation due date.
- **Company current:** all required accounts and historical periods through those cutoffs satisfy their applicable stages. A single completed account-month, a current QBO mirror or bookkeeping calendar close cannot stand in for this result. Historical statements must carry from each account's evidenced opening/earliest retained period through the latest due cycle; quiet months count, unsupported/unknown periods remain explicit.

## Execution order and value checkpoints

Session delivery is staged under [the current BANK-1 assignment](current-session-assignment.md): BANK-1 delivers persistent state, desktop views and downloads for one existing CAD bank and one CAD card; BANK-2 adds ongoing settlement/file automation and all-account/currency expansion; BANK-3 completes historical and future native QBO banking/reconciliation. BANK-1 does not require the full event-to-QBO chain below to finish in the same session. The full inventory/history scope and SB01–SB07 acceptance above remain unchanged; each session marks only its actual bounded scope delivered.

1. Resume ready historical D02 packages with existing valid authority and safe recovery, oldest-first within each account. Resolve D03 carry-forward/deferred evidence in its dependent branch. Refresh registration completeness against the actual artifacts; do not regenerate accepted files or replay uncertain uploads.
2. Begin SB01/SB03/SB04 implementation as an independent work stream using the existing bank modules. Deliver one complete proof of the bank-event-to-QBO chain, then expand across the complete account/history inventory. The first proof is a verification slice, not permission to limit the requested history to one month or one account.
3. Deliver SB02 and SB06 so both owner and accountant can use and inspect the workflow; preserve normal trading and other app outcomes alongside catch-up.
4. Complete SB05/SB07 and prove company-wide catch-up plus continued generation/import/reconciliation as subsequent cycles become due. The finish line has no fixed end date.

A01/A02 invoice/deposit repairs block only bank actions that actually depend on those records or balances. They do not automatically block bank UI, independent account/period work, ledger design or file automation. Reuse shared browser leases and company writer/account fences; independent progress does not authorize overlapping conflicting writes.

Keep implementation bounded: prefer existing modules, focused actual-chain regression checks and the required implementation/safety reviews for sensitive code; inspect the rendered desktop workflow. Use direct bank/QBO/file/native evidence for outcome claims. Apply the existing five-minute optional and fifteen-minute essential investigation checkpoints; document the smallest safe alternative and continue independent delivery rather than expanding a framework.

## Planning work-value record

- 2026-11-01T20:47:57.921Z — Essential owner-intent/task-list update. Smallest proof: explicit SB/D tasks, measurable currentness and a discoverable current handoff. Documentation only; no QBO/database mutation, service control or banking execution. Existing artifact/source observations are recorded with their limits. Next delivery milestone: implementation session starts the independent simulated-bank/file-automation branch and resumes safely ready historical banking work.
