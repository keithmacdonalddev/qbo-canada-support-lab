---
name: banking-and-deposits
description: Banking: Undeposited Funds and deposits, transfers, owner and loan money, cash position and buffer, and banking features the API cannot touch (reconciliation, feeds, rules). Use when collecting money, checking cash, moving money, or explaining deposits.
---

# Banking and deposits

## Money in
- A customer Payment or SalesReceipt without a deposit account goes to **Undeposited Funds** (shown as Payments to deposit). A **Deposit** linking those payments moves them to the bank, matching how a real bank deposit groups cheques.
- The app's sales and collections create Payment then Deposit in the same batch, so Undeposited Funds should return to about zero. A growing Undeposited Funds balance means payments were never deposited: investigate with `queryCompanyData` (Payment with no Deposit link) before anything else.
- Support teaching point: deposits that group several payments, a deposit that also has another line (for example a bank interest line), and a payment deposited straight to the bank.

## Money between accounts
- `bank-transfer` moves money between two published bank accounts. It needs two bank roles; `getBusinessActivityChoices` says when only one exists. Paying a credit card from the bank is a transfer to the card account.
- Owner contributions, owner draws and loan advances use deposits or journal entries to equity or loan accounts; the app's journal-entry activity cannot touch those accounts, so file `requestCapability` if the business needs them.

## Cash position
- Read the operating bank balance: `queryCompanyData` on Account (CurrentBalance) or `runReport` BalanceSheet. Cash flow: CashFlow report.
- Keep at least about two weeks of operating costs as a buffer before paying non-critical bills or approving discretionary expenses.
- Advise the owner when cash covers less than a month of costs, when receivables are rising while cash falls, or when a large bill is due within a week.

## Not available through the API
- Bank reconciliation, bank feeds, matching and bank rules are QuickBooks UI work. Never say an account is reconciled or a statement is matched.
- Cleared status is not set by this app.

## Checklist
- [ ] Every collection has a deposit in the same batch; Undeposited Funds near zero.
- [ ] Cash buffer respected before payment runs.
- [ ] No reconciliation claims; reconciliation is an owner/UI task.
