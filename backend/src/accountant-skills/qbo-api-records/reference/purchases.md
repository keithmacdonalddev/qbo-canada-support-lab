# Purchase records

## PurchaseOrder
- Required: `VendorRef`, `APAccountRef` is set by QuickBooks, lines with `ItemBasedExpenseLineDetail: { ItemRef, Qty, UnitPrice, TaxCodeRef }` (or account-based lines).
- `POStatus`: Open or Closed. A PO is a non-posting record: it does not affect the books until a Bill receives it.
- Purchase orders are a company preference (Expenses → Use purchase orders).

## Bill
- Required: `VendorRef`, lines. Line kinds: `AccountBasedExpenseLineDetail: { AccountRef, TaxCodeRef, BillableStatus, CustomerRef }` and `ItemBasedExpenseLineDetail: { ItemRef, Qty, UnitPrice, TaxCodeRef }`.
- `DueDate` or `SalesTermRef` (bills use `SalesTermRef` for terms). `Balance` is what remains unpaid.
- **Receiving a PO:** each bill line that receives stock links the PO line: `LinkedTxn: [{ TxnId: <PO Id>, TxnType: "PurchaseOrder", TxnLineId: <PO line Id> }]`. Inventory items increase quantity on hand at the bill's cost (FIFO layers).
- **Partial receipt:** bill quantity below the PO line quantity leaves the PO open for the rest; QuickBooks closes the PO when every line is fully received or it is closed by hand (verify the API close behaviour). The app's `receive-purchase-order` receives whole orders only.
- Billable expenses: `BillableStatus: "Billable"` with `CustomerRef` lets the cost be invoiced later.

## BillPayment
- Required: `VendorRef`, `TotalAmt`, `PayType: "Check"` with `CheckPayment: { BankAccountRef }`, or `"CreditCard"` with `CreditCardPayment: { CCAccountRef }`.
- Apply: `Line: [{ Amount, LinkedTxn: [{ TxnId, TxnType: "Bill" }] }]`. Partial payment leaves the bill Balance open.
- Apply a supplier credit: add a line with `TxnType: "VendorCredit"`; `TotalAmt` is the cash paid (0 when the credit covers it).

## VendorCredit
- Same lines as a bill; reduces accounts payable. Stays open until a BillPayment applies it.

## Purchase (expense, cheque, card charge)
- Required: `PaymentType` (`Cash`, `Check`, `CreditCard`), `AccountRef` (the bank or card paying), lines (account- or item-based), `EntityRef` (the supplier) expected.
- `Credit: true` on a CreditCard purchase is a card refund.
- The app's `paid-cash-expense` creates `Cash` purchases from the operating bank only.

## Purchase tax
- Purchase lines carry `TaxCodeRef`; the GST/HST on them is an input tax credit (recoverable) posted to the tax payable/recoverable account. Provincial sales tax on purchases is a cost, not recoverable.
