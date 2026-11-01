---
name: multicurrency
description: Multicurrency for this CAD company: the irreversible owner/UI enable step, foreign customers, suppliers and accounts, exchange rates, realised and unrealised gains, revaluation. Use when foreign-currency customers, suppliers or scenarios come up.
---

# Multicurrency

## Current state
- Synced Preferences 1 already has MultiCurrencyEnabled:true with CAD home currency (replayed 2026-11-01). Re-read current preferences; never ask to enable it again while enabled. Foreign Invoice/Bill/Payment/BillPayment/Deposit/Transfer and non-inventory Purchase are supported through manageQboRecord with governed currency and posting checks.
- **Turning multicurrency on is irreversible** and changes many screens and reports. It is an owner decision made in the QuickBooks UI (Account and settings → Advanced → Currency); this app never does it and never asks repeatedly. If the business needs it, record one owner decision (`recordBusinessDecision` with `requiresOwner`) explaining the business reason, and file `requestCapability` for the tools.

## How it works once enabled
- Home currency stays CAD forever. Each customer, supplier and bank/credit-card/AR/AP account has one currency, chosen at creation and not changeable after transactions exist.
- Transactions carry `CurrencyRef` and `ExchangeRate` (units of CAD per foreign unit). QuickBooks keeps a daily rate list (`Exchangerate` entity, readable and updatable).
- AR and AP get one account per currency (for example Accounts Receivable USD).
- **Realised gain or loss**: posted when a foreign invoice or bill is paid at a different rate from its booking rate.
- **Unrealised gain or loss**: home currency revaluation of open foreign balances at period-end (UI action; API support is limited, verify).
- Reports show amounts in CAD with foreign amounts available in detail reports.

## Support scenarios it would enable
- A US client invoiced in USD and paid later at a different rate (realised gain/loss).
- A USD supplier bill paid from a USD bank account; a transfer from the CAD to the USD account.
- Month-end revaluation of open USD receivables.

## Checklist
- [ ] Measure actual foreign activity from the synced copy; names and enabled settings do not prove activity.
- [ ] One owner decision and one capability request at most; do not repeat.

## Existing foreign accounts

Plan weekly activity for Chequing USD (USD), checking (CNY) and Cash on hand AUD (AUD); use IDs from the synced copy and coverage. USD supplier BillPayment needs a same-currency vendor/bill and proven USD AP account. Transfer home -> foreign or foreign -> home is supported with Amount in CurrencyRef; never use a second foreign currency. Deposit destination must share CurrencyRef. Purchase PaymentType Cash/Check/CreditCard uses a payment account in the transaction currency and non-inventory lines. Omit ExchangeRate on a new transaction to let the server supply a freshly observed dated Exchangerate; an explicit rate must match. Never invent or reuse an old rate as current evidence. Currency/account/party mismatches and unsupported foreign inventory remain held.
