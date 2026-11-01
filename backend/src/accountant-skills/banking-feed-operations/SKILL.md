---
name: banking-feed-operations
description: Prepare explicit simulated bank/card advice, exclusive API-or-native creator ownership, feed exceptions, duplicate exclusions and evidenced owner-browser upload/match/reconciliation tasks. Use when handling fees, interest, NSF returns, merchant settlements, card fees or bank-initiated transfers.
---

# Bank feeds and simulated advice

A generated feed or statement is simulated evidence, not an independent bank confirmation. Source-checked against the BF0/BF1/BF4 contracts on 2026-11-01; no native banking completion is established by this skill. The owner chose browser automation logged in as the owner for UI-only banking work.

## Start from the company and the actual money

Use queryCompanyData to inspect active accounts, currency, linked receipts/deposits and existing accounting records. Use the current scoped mirror rather than a QBO read per row. The settlement contract uses integer hundredths in the account currency. Bank inflows are positive; outflows negative. Card charges are negative feed amounts but increase statement debt; payments/credits reduce debt. CashOnHand needs a cashbook/count, never a bank upload.

Prepare explicit dated simulated advice with a stable reference per economic movement, actual account/currency, amount, reason, tax treatment and an identified unreconciled period. Never quietly insert years of fees into historical packages. Interest needs documented simulated terms, balances, dates and calculation; do not guess a rate or describe invented interest as bank-observed. Quiet months do not need fabricated transactions.

The BF3 foundation prepares events and drafts only. BF6 must expose the banking tools, supply a fresh complete mirror and decision history, and persist BF4 reservations before execution. If those tools are unavailable, file the exact missing capability. Do not call module names as invented tools or bypass the governed write path.

## One creator for each movement

Choose api-accountant or native-add before anyone creates bookkeeping. Persist the immutable creator reservation; both transfer legs need the same creator. A changed scenario label must not create a new identity: bank advice references identify movements; a returned payment principal can be corrected once. Never switch creator after a send, interrupted Add or uncertain result. Recover the existing decision instead.

Check the mirror and prior decision immediately before acting. A matching saved marker, existing/uncertain decision or plausible same-money record means investigate or recover, never create another. An API draft must pass the existing manageQboRecord guards and prove its exact bank-native amount, including dated tax. Use the same stable decisionKey on retries. Native Add must not race an API create. A prepared draft is not execution authority or completed banking evidence.

## Resolve each advice deliberately

- Fees and borrowing interest: use a real active fee/interest expense account. Out-of-scope advice may produce a balanced JournalEntry; taxable fees use Purchase with the dated published purchase tax code and exact net/gross arithmetic. Native Add tasks carry category, tax treatment, tax code and net amount, with a gross-amount preview check.
- Savings interest: debit the bank and credit the actual interest-income account, using the documented calculation. Unsupported currency shapes stay investigatory; do not force a CAD journal for foreign money.
- NSF/returned payment: link to the settled customer Payment and reverse only its proven principal to receivables with the customer allocation. Never expense returned principal. Record an actual separate NSF bank fee as a distinct advice item. FX, grouped-deposit or missing receivable-allocation evidence must be investigated before correction. Do not void a historical Payment, reopen an invoice by guessing, or repeat a principal correction.
- Merchant fee: inspect the full linked Deposit breakdown first. If the fee already reduces the deposit, create no second fee or withdrawal. Full undeposited receipt links plus a negative expense DepositLineDetail are supported by current app guards only with a positive net deposit and no tax override on that fee. Taxable fees need the supported separate tax-coded treatment. Native matching of that net payout remains unverified until screen evidence is retained. Preserve gross receipt, fee and net bank amounts.
- Card annual/foreign-transaction fee: use the actual card account and currency, with charges increasing debt. Retain the advice and correct tax policy.
- Bank-initiated transfer: reserve both legs and create one accounting Transfer, or perform native transfer handling once and Match the opposite leg to the same record. Do not Add two expenses or two transfers. FX needs governed currency proof; never guess a conversion.
- Unknown item: retain advice and investigate. Small value is not a category. No Add, expense, forced match or balancing plug until the financial meaning is established.
- Duplicate import test: use separately labelled duplicate-test files and Exclude only. Do not include those rows in canonical statements or create bookkeeping. BF4 stores their creator as none.

## Native checklist and recovery

1. Assert company/environment, account, currency, exact package revision/file hash and current native queue/reconciliation state.
2. Upload each exact CSV once. Verify preview dates, signs, counts and gross amounts. A timeout or unknown import outcome requires inspecting the queue before retrying.
3. Match existing records; Add only exclusively native-owned advice; Exclude duplicates. Ambiguous matches stop only the affected banking work. Retain screen evidence and linked QBO identities; sync new records before claiming they exist.
4. Reconcile against the simulated statement with outstanding cheques/deposits in transit retained. Finish only at zero difference, attach the statement and retain the native reconciliation report. Never force an adjustment.
5. Record generated, uploaded, reviewed, matched, added, excluded and reconciled as separate evidence stages. Generated files, a balanced ledger or a saved Deposit cannot prove a native Match or completed reconciliation. Existing R feature-test marks require native inspection, not a claim that history is reconciled.

All UI work uses visible browser actions, not undocumented private banking endpoints. Session expiry, account ambiguity and interrupted imports require evidence-led recovery of the same reserved work. Banking failures must not stop independent daily business activity.
