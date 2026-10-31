---
name: inventory-and-purchasing
description: Inventory: FIFO cost in QuickBooks, purchase orders and receiving into bills, partial receipts, reorder points, stock-outs and negative stock, valuation reports. Use when receiving orders, deciding to reorder, checking stock or COGS, or building a stock scenario.
---

# Inventory and purchasing

## How QuickBooks Online handles stock
- Inventory items (`Type: "Inventory"`, `TrackQtyOnHand: true`) carry three accounts: income, cost of goods sold (`ExpenseAccountRef`) and inventory asset (`AssetAccountRef`).
- **FIFO only.** Each purchase adds a cost layer; each sale uses the oldest layer first and posts COGS at that cost (debit COGS, credit inventory asset).
- **Overselling is allowed** (negative quantity on hand). QuickBooks posts COGS at the latest known cost and recalculates when stock arrives; backdated purchases change COGS for later sales. This is a classic support question; avoid it unless it is a deliberate scenario.
- Quantity changes only through transactions: Bill or Purchase (in), Invoice or SalesReceipt (out), CreditMemo or RefundReceipt (back in), VendorCredit (out), and inventory quantity adjustments (UI; API support varies, verify).
- A purchase order is non-posting; stock and AP change when a Bill receives it.

## Tools this app gives you
- `getBusinessActivityChoices.receivablePurchaseOrders`: wholly unreceived purchase orders with original lines.
- `receive-purchase-order`: creates an unpaid inventory Bill dated today, linked line by line to the PO, at the PO's cost with purchase tax and FIFO evidence. **Whole orders only**; copy ids, source and lines exactly.
- Scheduled periods create purchase orders and stock sales under the published policy. New purchase orders today, partial receipts, adjustments and new stocked items are not tools yet: file `requestCapability` once each when the business needs them.
- Read stock: `queryCompanyData` on Item (`QtyOnHand`, `PurchaseCost`), `runReport` InventoryValuationSummary / InventoryValuationDetail.

## Reorder rule of thumb
- Reorder point = average daily units sold × supplier lead time (days) + safety stock (about one week of sales).
- Reorder quantity: enough for 4-6 weeks of sales, rounded to the supplier's pack size.
- Receive open purchase orders promptly when they are due; a PO open far beyond its lead time needs a reason (backorder, dispute).

## Partial receipts (when a tool supports them)
- The Bill receives only the delivered quantity on each PO line, linked by `TxnLineId`; the PO stays open for the rest. Close the remainder by hand only when the supplier cancels it.
- Support value: open-PO reports, a PO that stays partly open, and a second bill completing it.

## Checklist before receiving or selling stock
- [ ] Quantity on hand will not go negative unless that is the intended scenario.
- [ ] The receiving bill matches the PO cost; the gross margin on stock sales stays believable (wholesale about 25-40%).
- [ ] Inventory valuation (asset account on BalanceSheet) moves with receipts and COGS.
- [ ] Requests for missing purchasing tools are filed once with `requestCapability`.
