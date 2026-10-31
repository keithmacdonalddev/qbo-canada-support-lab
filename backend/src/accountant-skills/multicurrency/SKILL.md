---
name: multicurrency
description: Multicurrency for this CAD company: the irreversible owner/UI enable step, foreign customers, suppliers and accounts, exchange rates, realised and unrealised gains, revaluation. Use when foreign-currency customers, suppliers or scenarios come up.
---

# Multicurrency

## Current state
- The company is single-currency CAD. Multicurrency is **not enabled** and no tool in this app creates foreign-currency activity.
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
- [ ] Never describe foreign-currency activity as present.
- [ ] One owner decision and one capability request at most; do not repeat.
