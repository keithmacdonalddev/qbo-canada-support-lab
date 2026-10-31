# Sales records

## Estimate
- Required: `CustomerRef`, `Line[]` (`DetailType: "SalesItemLineDetail"`, `SalesItemLineDetail: { ItemRef, Qty, UnitPrice, TaxCodeRef }`, `Amount`).
- `TxnStatus`: Pending, Accepted, Closed, Rejected. `ExpirationDate` optional.
- Converting: create an Invoice with `LinkedTxn: [{ TxnId: <estimate Id>, TxnType: "Estimate" }]`. The estimate closes. Progress invoicing (several invoices from one estimate) is a company preference (verify it is on before planning it).

## Invoice
- Required: `CustomerRef`, at least one line. Useful: `TxnDate`, `DueDate` or `SalesTermRef`, `DocNumber`, `BillEmail`, `CustomerMemo`, `PrivateNote`.
- Line kinds: `SalesItemLineDetail`, `SubTotalLineDetail`, `DiscountLineDetail` (`PercentBased`, `DiscountPercent` or amount), `DescriptionOnly`.
- Read-only results: `TotalAmt`, `Balance`, `TxnTaxDetail` (QuickBooks computes tax from the codes), `LinkedTxn` (payments, credit memos).
- Time and costs: a billable `TimeActivity` linked as the invoice's charge; `LinkedTxn` with `TxnType: "TimeActivity"` (the app's field-service sale does this).
- Void: `POST /invoice?operation=void` with `Id`, `SyncToken`. A voided invoice keeps its number with zero amount.

## SalesReceipt
- A sale paid at once. `CustomerRef` optional but expected here, `PaymentMethodRef`, `DepositToAccountRef` (omit for Undeposited Funds).

## Payment (ReceivePayment)
- Required: `CustomerRef`, `TotalAmt`.
- Apply: `Line: [{ Amount, LinkedTxn: [{ TxnId, TxnType: "Invoice" }] }]`. Several lines pay several invoices.
- Partial: line `Amount` less than the invoice Balance.
- Unapplied: `TotalAmt` above the sum of lines gives `UnappliedAmt` (a customer credit).
- Apply a credit memo: one line for the invoice, one for the `CreditMemo`; `TotalAmt` is the cash actually received (0 when the credit covers it).
- `DepositToAccountRef` omitted: Undeposited Funds. `PaymentMethodRef`, `PaymentRefNum` (cheque number) optional.

## CreditMemo
- Same line shape as an invoice; reduces what the customer owes. Open until applied by a Payment or refunded.
- `RemainingCredit` shows what is unused.

## RefundReceipt
- Money paid back to a customer. Required: `DepositToAccountRef` (the bank paying out), lines, `CustomerRef` expected. With tax codes, the refund reverses the tax.
- Refunding an open credit memo is done in the UI by linking; through the API, create the RefundReceipt and apply the credit memo with a zero Payment if needed (verify for this company).

## Customer-side tax notes
- Each line carries `TaxCodeRef`. `GlobalTaxCalculation: "TaxExcluded"` means prices are before tax.
- A customer may be tax-exempt in practice (exempt or zero-rated code on its lines); there is no US-style exemption certificate field in Canada.
