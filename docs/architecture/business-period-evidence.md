# Retained business period evidence

Implemented 2026-10-06 as internal runtime composition. No public route, startup hook, scheduler or production storage preparation is added.

## What completes a period

The collector reloads the original immutable manifest and checks its company, business, blueprint, baseline, dates, expected cursor/revision and named requirements against the saved Run. It requires every planned record to have completed and the exact current worker lease. It refreshes managed related-record graphs in groups of at most 100 roots, skipping roots covered by a returned graph. It then reads the complete planned record set in bounded storage batches. Saved graph proof must match original identity, fingerprint, compilation, relationships, receipt and audit, and be no more than five minutes old.

After those observations, the concrete report reader fetches TrialBalance, BalanceSheet, ProfitAndLoss, AgedReceivables and AgedPayables using fixed GET requests, plus a complete account query including inactive accounts. It uses the original QBOClient, exact connection/realm/environment/owner and current verification permission before and after reading. Two provider workers, a three-minute observation budget, 4,000-account limit and six-MB raw-source limit bound the read. Cancelled or late results are discarded; this does not promise cancellation of an already-running SDK GET.

The collector recomputes checks from retained raw reports rather than trusting a passed flag. Supported named requirements are records/record-readback, trial-balance, balance-sheet, receivables and payables. Ledger checks require Accrual and CAD; aging comparisons are explicitly dated open-balance evidence. Unknown and manual-confirmation requirements remain incomplete. ProfitAndLoss is retained for inspection but has no invented reconciliation assertion.

## Durable evidence and changed data

A final transaction rechecks authority, worker ownership, writer revision and all record evidence. It freezes the candidate hash/revision on Run and inserts an append-only OperationEvidence document together with its audit. Retained combined proof/sources are limited to 12 MB, with the existing eight-MB proof limit still enforced. The model disables automatic collection/index creation and requires explicit prepared storage. Ordinary updates, replacements and deletions are blocked, matching retained operation-plan models.

Period completion loads the exact retained candidate and verifies proof plus raw-source hashes, scope, dates and assertion references. Missing or damaged retained sources cannot authorize completion. Failed reports leave the period pending; retries refresh evidence without recreating records. A lost acknowledgement may retain an earlier valid evidence revision; another pass creates a new immutable revision.

The company writer protects against this application's coordinated changes. It cannot lock manual QBO edits or other integrations. Graphs and reports are fresh sequential observations, not an atomic provider snapshot. Balanced totals prove the named relationships, not business realism, bank reconciliation, or activity outside the managed manifest.

## Verification and remaining work

Focused fixtures compose the real runner, collector, writer and period store. A combined fixture uses the original QBOClient with simulated report/query responses. Additional checks cover all four report comparisons, tampered sources/proof, authority/company changes, unknown checks, cancellation/staleness, replaced workers, storage audit rollback, lost acknowledgement, empty periods and multiple graph batches. Independent source reviews corrected the date-helper import, malformed account acceptance and append-only/source-validation gaps.

Actual Mongo transactions and live Canadian report acceptance remain unverified. OperationEvidence storage deployment, production runtime composition, approved baseline/blueprint/tax setup and whole-company historical/current business outcomes remain open. No QBO requests, live database setup or services were started for this work.
