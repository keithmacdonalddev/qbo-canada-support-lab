# General inventory writes — 2026-10-31

Status: local code and offline fixtures; master flag remains default-off. Returns remain an unmet part of the requested completion. No commits, service commands, QBO calls or database writes were made. MongoDB diagnosis was read-only and the connection was closed.

## Delivered

- Restored the saved inventory WIP. GENERAL_WRITE_INVENTORY_ENABLED defaults false, with separate entity gates. Current-day Invoice, SalesReceipt, Bill and Purchase creates can move accepted stock; PurchaseOrder/Estimate create no movement. Stock Item edits, adjustments, historical changes and removals stay held.
- FIFO retains original purchase layers and exact-cent cost allocations, supports quantities to six decimals, and refuses negative stock at each ordered plan prefix. Ambiguous same-day ordering and sub-cent allocations remain explicit refusals. Legacy calculations retain their original ordering and result shape; general ordering is explicitly versioned.
- Partial PO Bills require an open CAD PO with exact supplier/item/line allocation. Remaining quantities subtract prior Bill/Purchase receipts discovered through both forward header/line links and PO backlinks, plus siblings in the proposed plan. Ambiguous/header-only prior allocations fail closed. Only the received quantity enters stock.
- Purchases debit inventory asset; sales debit COGS and credit inventory asset, separately from revenue, tax and receivable/bank postings. Costs never come from selling price or Item.PurchaseCost.
- General stock rows are reconstructed from the original resolved request, successful per-item native response, deterministic gate receipt and original dispatch/result audits. They join priorActivityRows in the existing immutable period proof. Its combined closing state carries into the next period. Typed purchase sources support Bill/Purchase identifiers without collisions and independent native source readback. Admission flags do not erase accepted history.
- Source completeness, current versions, source generation/freshness, pending app writes, item identity/account routing and replayed quantity are checked. This does not prove the absence of offsetting native adjustments that change layers without net quantity. Production enablement remains unverified and is not recommended by these fixtures.

## Returns: remaining dependency

CreditMemo/RefundReceipt reversal math and inventory/COGS postings have fixtures using independent exact-record valuation evidence. Generic native return-cost/layer behavior is not established by the available evidence, and there is no authenticated production valuation loader. Both return dispatch cells remain disabled. The model cannot supply a cost proof in its payload. Do not claim returns or the whole inventory request finished, or enable those cells by substituting sales price, Item.PurchaseCost, an arbitrary hash, or the same ledger being tested for independent cost evidence.

## Collection diagnosis

Read-only saved data showed six eligible overdue imported invoices totaling CAD 1,591.44. The old October 29 preview is retired with no approval, steps, intents or receipts and no writer/calendar reservation. Retained management notes still asserted the obsolete identifier-repair hold. business-collection-readiness now supplies current factual evidence in business state, lists eligible invoices and keys proved reusable from all same-key runs, and explicitly marks the old hold notes stale. It preserves native balance, writer and calendar checks. A separate partially saved current operation remained blocked on receivables verification; this change does not bypass or replay it. No retained memory or company data was rewritten.

## Verification and limits

Fixtures cover FIFO layers, fractional exact-cent costing, negative prefixes, partial receipts including missing/header-only backlinks, inventory/COGS postings, typed purchase source readback, native receipt/audit/content tampering, next-day carry and stale collection notes. Before the final source batch, the requested suites passed 128 tests; focused regressions passed 51 tests and accountant-service compatibility passed 41 tests. All 18 changed JavaScript files passed syntax checks. The final composition bridge plus collection/store/tool/service fixtures passed 70 tests. See artifacts/inventory-completion-2026-10-31 for sanitized results and the timestamped work-value ledger. Independent implementation and safety reviews cover the supported create subset; no live outcome is claimed.

## Primary sources

- [Intuit: add partial purchase orders to bills or expenses](https://quickbooks.intuit.com/learn-support/en-us/help-article/purchase-orders/add-purchase-orders-expenses-bills-checks-online/L9pRK49uC_US_en_US)
- [Intuit: customer refunds restore returned inventory](https://quickbooks.intuit.com/learn-support/en-global/help-article/customer-refunds-credits/record-customer-refund-quickbooks-online/L5PbCkJk8_ROW_en) — quantity restoration does not establish a general native return valuation rule.

User action: none to apply this local patch. The inventory master remains off; generic returns need authenticated native valuation evidence before further implementation can safely admit them.
