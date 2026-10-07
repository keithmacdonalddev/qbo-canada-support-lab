# Proposed business transaction details

Implemented 2026-10-06 as a pure read-only planning layer. No transaction compiler, approved prices, QBO payloads, master-data adoption or execution authority is implied.

The existing activity preview now includes stable customer, supplier, worker and product identities; line quantities and integer-cent prices; intended account/tax mapping roles; and logical source dependencies for each proposed chain. These identities are not QBO IDs. Logical dependencies are not proof of saved QBO transaction or line-level links.

Field quotes, time and invoices share hours and the same service price. Stock POs and bills share quantity and cost; sales use the same quantity and product after the planned bill date. Care-plan invoices use stable subscription products and proposed monthly prices. All amounts are illustrative fixtures, visibly identified as unapproved; they are not a market-price recommendation.

Payments and bill payments refer to the saved originating invoice/bill total. Their preview cash amount is deliberately unresolved until actual tax and saved totals exist. Field collections flow to undeposited funds then the operating bank; care collections flow directly to the bank. Supplier payments are outflows funded by that bank. Deposits transfer collected funds internally. No tax rate is frozen into these details and no bank transfer is performed.

The calendar arrays and planHash retain their original integrity contract. Details live separately under detailProposal.byLogicalKey, with per-event detailsHash and a proposal fingerprint bound to the calendar hash. Any future operation compiler and approval must bind both fingerprints; calendar equality alone does not prove economic equality. The combined calendar/details preview retains an 8MB size bound. Unsupported templates, duplicate identities, missing or mixed-origin dependencies reject the preview.

Totals are grouped by record type and are before tax. There is no grand revenue/cash total that double-counts an estimate, invoice, payment and deposit. The preview still explicitly excludes the complete exception, retainer, returns, close and reconciliation policies needed by the full business.

## Evidence

- 51 isolated detail/calendar/preview/draft tests pass, including lifecycle quantity/amount equality, payment source identity, cash direction, repeatability across date windows, duplicate/missing dependencies and calendar comparison compatibility.
- Backend syntax (87 files), frontend build/lint and diff checks pass. Existing build chunk-size, three hook and line-ending warnings remain.
- Independent implementation and safety reviews found calendar-hash and supplier-payment-direction issues; both were corrected and re-reviewed clear.
- Existing desktop Chrome Company page displays October 1–6 proposal: 55 scheduled records, 78 future follow-ups and 81 prior prerequisites. It shows line quantities/rates, settlement rules, and separated totals (invoices CAD 5,019 before tax, sales receipts CAD 2,610, bills CAD 1,488). These are proposed amounts, not observed QBO financial results. Desktop expanded table and totals were inspected. No QBO records changed.

Next integration requires approved economic/tax policy, actual mapped master records, reviewed baseline and a durable bounded operation compiler/executor. Whole-app acceptance remains open.
