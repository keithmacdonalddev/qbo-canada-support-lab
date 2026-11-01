# General inventory writes — 2026-10-31

Status: local code and offline fixtures; master flag remains default-off. JOB IR adds bounded returns and native valuation; Canadian report-shape acceptance and mixed-cost layers remain unverified. No commits, service commands, QBO calls or database writes were made. MongoDB diagnosis was read-only and the connection was closed.

## Delivered

- Restored the saved inventory WIP. GENERAL_WRITE_INVENTORY_ENABLED defaults false, with separate entity gates. Current-day Invoice, SalesReceipt, Bill and Purchase creates can move accepted stock; PurchaseOrder/Estimate create no movement. Stock Item edits, adjustments, historical changes and removals stay held.
- FIFO retains original purchase layers and exact-cent cost allocations, supports quantities to six decimals, and refuses negative stock at each ordered plan prefix. Ambiguous same-day ordering and sub-cent allocations remain explicit refusals. Legacy calculations retain their original ordering and result shape; general ordering is explicitly versioned.
- Partial PO Bills require an open CAD PO with exact supplier/item/line allocation. Remaining quantities subtract prior Bill/Purchase receipts discovered through both forward header/line links and PO backlinks, plus siblings in the proposed plan. Ambiguous/header-only prior allocations fail closed. Only the received quantity enters stock.
- Purchases debit inventory asset; sales debit COGS and credit inventory asset, separately from revenue, tax and receivable/bank postings. Costs never come from selling price or Item.PurchaseCost.
- General stock rows are reconstructed from the original resolved request, successful per-item native response, deterministic gate receipt and original dispatch/result audits. They join priorActivityRows in the existing immutable period proof. Its combined closing state carries into the next period. Typed purchase sources support Bill/Purchase identifiers without collisions and independent native source readback. Admission flags do not erase accepted history.
- Source completeness, current versions, source generation/freshness, pending app writes, item identity/account routing and replayed quantity are checked. This does not prove the absence of offsetting native adjustments that change layers without net quantity. Production enablement remains unverified and is not recommended by these fixtures.

## JOB IR: returns and valuation (2026-11-01)

The inventory master still defaults off. CreditMemo, RefundReceipt and VendorCredit inventory cells each default off and have explicit switches. No environment setting was changed. Customer returns restore quantity and reverse COGS; supplier returns reduce purchase value and quantity without posting the removal to COGS. Admission checks every ordered plan prefix. Returns with existing stock require a single evidenced FIFO cost per item; supplier credit amounts must equal that cost. Sold-out customer returns may restore quantity, but further stock work for that item waits for native cost. Mixed-cost return layers and stock history edits remain held.

Accepted returns obtain per-transaction/item cost from a scoped, server-owned InventoryValuationDetail GET report, independently of the General Ledger. Native rows must have the correct physical item, transaction, day, quantity direction and one cost; offsetting/mixed layers are rejected. The model cannot provide valuation evidence. Transactional admission consumes an exact-record cache warmed during preflight, including resumed batches. The report schema is fixture-tested, not observed against this Canadian company.

Day close requires InventoryValuationSummary to match each managed item's FIFO quantity and asset value. Offsetting item-value differences cannot pass merely because the asset account balances. The close retains bounded raw report JSON and exact return content; immutable stock history reparses it alongside the original gate receipt and audits. Settlement balances, links and version changes do not invalidate unchanged stock content. GeneralDayClose kind "inventory" supplies return cost before fixed-workflow stock previews; it does not certify the ledger or advance the calendar. Full period proof remains separate. Admission flags do not prevent verification of previously saved stock.

The stored replay exposed a reader inconsistency: legacy inventory on account 57 was rejected despite being separate from managed stock on account 128. The reader now isolates unrelated stock on separate asset and COGS accounts, matching root preparation. Shared managed asset/COGS accounts and writes to unmanaged items still refuse.

### Quantity adjustments: explicit gap

Intuit's own [CreateInventoryAdjustment collection](https://www.postman.com/intuit-developer/intuit-developer-quickbooks-online-accounting-api/request/4884662-fec545c4-dc8f-47c5-886b-34eaa1f7446a) publishes /inventoryadjustment?minorversion=75. This establishes an endpoint, but does not establish its Canadian request shape, eligibility, quantity/layer ordering or postings. The developer reference did not expose a verifiable Canadian contract during this job. InventoryAdjustment remains unavailable in the governed schema and disabled in config; direct Item.QtyOnHand edits and asset journals are not substitutes. No claim that Canada is unsupported is made. An official Canadian contract and authentic response replay are needed before adding that write cell.

### Enablement checklist (no enablement performed)

1. Prove a clean general-write day from actual records and close evidence. Keep GENERAL_WRITE_INVENTORY_ENABLED off until established.
2. Capture authentic Canadian InventoryValuationDetail and InventoryValuationSummary responses under separately authorized read access. Replay exact modernized JSON columns, item/transaction IDs, zero-item rows and totals through business-stock-valuation. Synthetic parser fixtures do not prove native compatibility.
3. Obtain authorized native examples for CreditMemo, RefundReceipt and VendorCredit, including settlement, sold-out stock and next-day consumption. Prove quantity, per-item value, postings, cost and retained carry. Mixed-cost cases remain refused until native layer-order evidence is implemented.
4. Verify complete source freshness, pending-write barriers, root accounts and relevant item identities. Preserve exact receipt/audit provenance and reconciliation controls.
5. Enable the master and only proven cells: GENERAL_WRITE_INVENTORY_CREDIT_MEMO_ENABLED, GENERAL_WRITE_INVENTORY_REFUND_RECEIPT_ENABLED and GENERAL_WRITE_INVENTORY_VENDOR_CREDIT_ENABLED. Purchase/sale cells remain independent. InventoryAdjustment and Item quantity edits stay off.
6. Observe an authorized native return chain and day close, then the next day's carry and metered call economy. Report reads use a short exact-record cache; measure actual usage before claiming the ≤3-call target.

### Verification of the saved JOB IR result

From the canonical backend directory, the affected node --test suites passed 128 tests, zero failed or skipped. The isolated broader suite passed 130 tests; final focused checks passed 70 and provenance checks passed 34. All 335 backend JavaScript files passed syntax checks; final changed shared modules were checked again. git diff --check passed. Distinct read-only implementation and safety reviewers found no unresolved blocking findings in the saved-equivalent scratch slice. Full commands, file hashes and sanitized test/replay receipts are in artifacts/inventory-returns-job-ir-2026-11-01. Backend source was saved in one batch, with no commit or service-control commands.

### Direct offline evidence

Accepted opening proof d5e4c5f3b2307b1fa038a1e7 (October 30), October 31 Bill 11225 and SalesReceipt 11224, and stock observation fd19f3dd9f1bc1f9b7242310 were read from MongoDB without writes. Exact records replayed through readGeneralStockContext: purchases CAD 690.00, cost of sales CAD 369.00. Items 48–52 close at quantities 18/48/18/30/18 and values CAD 369/1,104/459/840/549. Stored native content and accepted opening are real; clocks, source-current envelopes and pending-write queries are mocked. Return/report fixtures are synthetic because no stored stock returns/native valuation reports were found. This proves offline compatibility, not live return completion. Raw records remain in the private temporary directory; repository evidence is sanitized.

## Collection diagnosis

Read-only saved data showed six eligible overdue imported invoices totaling CAD 1,591.44. The old October 29 preview is retired with no approval, steps, intents or receipts and no writer/calendar reservation. Retained management notes still asserted the obsolete identifier-repair hold. business-collection-readiness now supplies current factual evidence in business state, lists eligible invoices and keys proved reusable from all same-key runs, and explicitly marks the old hold notes stale. It preserves native balance, writer and calendar checks. A separate partially saved current operation remained blocked on receivables verification; this change does not bypass or replay it. No retained memory or company data was rewritten.

## Verification and limits

Fixtures cover FIFO layers, fractional exact-cent costing, negative prefixes, partial receipts including missing/header-only backlinks, inventory/COGS postings, typed purchase source readback, native receipt/audit/content tampering, next-day carry and stale collection notes. Before the final source batch, the requested suites passed 128 tests; focused regressions passed 51 tests and accountant-service compatibility passed 41 tests. All 18 changed JavaScript files passed syntax checks. The final composition bridge plus collection/store/tool/service fixtures passed 70 tests. See artifacts/inventory-completion-2026-10-31 for sanitized results and the timestamped work-value ledger. Independent implementation and safety reviews cover the supported create subset; no live outcome is claimed.

## Primary sources

- [Intuit: add partial purchase orders to bills or expenses](https://quickbooks.intuit.com/learn-support/en-us/help-article/purchase-orders/add-purchase-orders-expenses-bills-checks-online/L9pRK49uC_US_en_US)
- [Intuit: customer refunds restore returned inventory](https://quickbooks.intuit.com/learn-support/en-global/help-article/customer-refunds-credits/record-customer-refund-quickbooks-online/L5PbCkJk8_ROW_en) — quantity restoration does not establish a general native return valuation rule.

User action: none for this local patch. Production enablement remains held behind the checklist; no live return or adjustment outcome is claimed.

## JOB IR2: full-suite regression repair (2026-11-01)

All five reported failures also reproduce on the clean current source without IR. Commit 709b773 removed immutable selected-account definition comparisons, changed settlement ownership results to include current bodies, discarded FreeFormAddress for posting records, and allowed an in-report settlement change to retry as ordinary copy drift. IR2 restores original definition binding; retains the entity-specific address distinction; keeps the public settlement target list stable while requiring separately retained, arithmetically valid current bodies at runtime; and refuses a settlement snapshot that changes during the ledger read. All five original test assertions remain unchanged. Two added regressions prove target metadata alone, invalid supplier-payment types, and inconsistent totals cannot authorize a balance explanation.

Bill 11225 / SalesReceipt 11224 replay through readGeneralStockContext using the original stored opening/records: purchases CAD 690.00; cost of sales CAD 369.00; item quantities 18/48/18/30/18. Source freshness, observation storage and pending-write reads are mocked; this is offline accounting evidence, not a native return-schema acceptance test. Inventory and return flags remain default-off. Final full-suite and source fingerprints are recorded under artifacts/inventory-returns-job-ir2-2026-11-01.
