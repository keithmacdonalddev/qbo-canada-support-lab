# Banking and journal records

## Deposit
- Required: `DepositToAccountRef` (bank), `Line[]`.
- From Undeposited Funds: `Line: [{ Amount, LinkedTxn: [{ TxnId: <Payment or SalesReceipt Id>, TxnType: "Payment", TxnLineId: "0" }] }]`. `TxnLineId: "0"` is required for this link.
- Other money in: `DepositLineDetail: { AccountRef, Entity, PaymentMethodRef }` (for example an owner contribution or a loan advance).
- `CashBack` takes cash out of the deposit (rare; avoid).

## Transfer
- Required: `FromAccountRef`, `ToAccountRef` (bank, credit card or other asset/liability balance-sheet accounts), `Amount`.
- Credit-card payment from the bank is a Transfer from the bank to the card account.

## JournalEntry
- `Line[]` with `DetailType: "JournalEntryLineDetail"`, `JournalEntryLineDetail: { PostingType: "Debit"|"Credit", AccountRef, Entity?, ClassRef?, DepartmentRef? }`, `Amount` positive.
- Debits equal credits or the save fails.
- Accounts receivable lines need `Entity` = a customer; accounts payable lines need `Entity` = a supplier.
- Canada: lines can carry `TaxCodeRef` and `TaxApplicableOn` (Sales or Purchase) so the tax shows on the GST/HST report; use with care.
- `Adjustment: true` marks an adjusting entry. Automatic reversal is a UI feature; through the API, a reversal is a second entry with every line's PostingType swapped, dated the first day of the next period.
- The app's `journal-entry` activity posts only between published income and operating-expense roles (no bank, receivables, payables, undeposited funds or stock lines).

## Bank reconciliation, bank feeds, rules
- Not available through the API. Reconciliation, bank-feed matching and bank rules are done in the QuickBooks UI. The API can read cleared status only partially (verify); never claim an account is reconciled.

## Accounts
- `Account` create: `Name`, `AccountType` (Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense), optional `AccountSubType`. Accounts are deactivated, never deleted.
