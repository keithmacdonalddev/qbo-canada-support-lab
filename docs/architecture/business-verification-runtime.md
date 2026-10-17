# Business verification runtime

Implemented 2026-10-06. Internal composition for checking real saved transactions against retained business intent. This does not activate a company, prepare storage, start a runner or expose a new route.

## Concrete composition

createBusinessVerificationRuntime binds one exact company connection, operation ID and plan hash. It composes the existing graph reader with the existing writer snapshot transaction, the retained operation-plan loader and the original QBOClient full entity GET. It returns loadGraphReadback and graphSnapshot adapters for the step store, plus scoped readRecord, loadTaxPolicy and readFence helpers. Caller inputs cannot switch the bound scope or operation.

The shared full-record reader now supports a separate transaction mode for Estimate, TimeActivity, Invoice, Payment, Deposit, PurchaseOrder, Bill, SalesReceipt and BillPayment. That mode requires the original QBOClient read/apiCall methods, exact owner/connection/realm/environment, numeric saved ID and canonical version, a full non-sparse entity envelope, and a bounded plain JSON record. Authority is checked before and after the GET using operations.read. Existing master-reference reads continue to use operations.preview and their approved-definition validation.

Reader cancellation and its one-minute observation budget prevent late data from becoming accepted proof. The underlying SDK GET is not forcibly aborted by this wrapper and can finish later; existing client throttling/retries still apply. No mutation can be initiated through these readers.

## Independent tax expectations

Each graph transaction is resolved to its original OperationStep and original retained operation, including records from an earlier period. plans.loadIntent must be the immutable operation-plan store loader, which checks the saved manifest and policy hash. The runtime compares original intent, entity, fingerprint, plan and compilation/request hashes. It does not identify records from notes, amount or name.

The original approved policy can retain readbackTax with version 1, totalTaxCents and exact lines containing rateId, percent, taxableCents and amountCents. Those values must be independently prepared and approved with the policy. The runtime checks their shape and totals and binds them to the original policy hash and exact compilation. The compiled tax code/calculation must match the original policy. It never copies actual QBO tax values into expected values or guesses Canadian tax treatment.

Missing readbackTax on an item transaction returns unavailable tax evidence, causing graph verification to remain incomplete. Time and settlement transactions do not require item tax expectations. This adapter does not yet prepare or approve real Canadian tax expectations; that remains part of company policy preparation.

## Verification

After correcting a post-GET permission mismatch, the focused runtime/reference/dispatch suite passes 52 tests. The graph suite passes 19 tests, including concrete runtime GETs for a five-record sales chain and a four-record purchase chain. The dispatch integration uses actual step-store graph persistence and writer fencing: saved content passes, then a changed amount clears prior verification without issuing another POST. Existing step-store tests also passed in the initial five-suite run. Backend syntax covers 108 files. Required implementation and safety source reviews are clear after correction.

All provider responses and persistence adapters in these tests are isolated fixtures. Actual Canadian API response shapes, Mongo transaction concurrency, deployment and complete live business outcomes remain unverified. The production runner, compilation-observation composition, independently approved tax/baseline/blueprint and explicit storage preparation still need completion.

## Invoice receivables routing — 2026-10-17

Some QuickBooks Online Invoice GET responses omit ARAccountRef. The verification runtime accepts this omission only for an exact managed saved Invoice with its unchanged original compilation, receipt, approved account binding and policy. It reads the approved account definition, a same-day CAD/accrual General Ledger filtered to that account, and the exact Invoice again. The ledger must identify one exact Invoice ID and its full gross debit under the approved account; truncated reports, ambiguous rows, changed records, changed writers and stale sources fail closed.

The original Invoice and its record hash remain untouched. A separate versioned accountRouting proof retains the report, original compilation and receipt, approved account observation and writer snapshots. Content evidence hashes and durable step verification retain this proof, and freshness includes its oldest source. Downstream Payment compilation regenerates both current and persisted routing evidence and still submits the explicit approved AR account. Explicit wrong returned accounts remain mismatches. There is no inference from a sole active account and no general omitted-header exception; CreditMemo and other entity omissions require their own evidence contract.

The report wrapper bounds acceptance to one minute and handles cancellation; the SDK GET may settle later. Owned execution drivers must continue draining pending SDK and token work before disconnecting. Focused fixtures verify raw-record preservation, forged/stale/wrong routing rejection, exact runtime GETs, cancellation, durable proof persistence, native linked payments and calendar completion without replay. Live period completion is a separate outcome.
