---
name: month-end-and-year-end-close
description: Month-end and year-end close: closing the calendar one month at a time, the review checklist, accruals, reversals, prepaids, depreciation, year-end steps, and what the API cannot do. Use when context.calendarClose names a period, after a month-end, or for close scenarios.
---

# Month-end and year-end close

## Calendar close in this app
- `context.calendarClose` names the next period. Close **one calendar month at a time**, never across a month-end, at most 31 days, always through yesterday or earlier.
- Steps: `prepareBusinessPeriod({throughDate})` → inspect the saved plan (`inspectBusinessOperation`) → `executeBusinessPeriod` with its exact `operationId` and `planHash`. A period with no scheduled activity still closes on its report evidence.
- If preparation reports a capacity limit, prepare a shorter period inside the same month.
- Recover your own unfinished operation first (`resumeBusinessOperation`); a new period is refused until it is done.
- Verified periods are protected: never date new activity in them.

## Month-end review checklist
Run these after the month's activity is saved (prefer `queryCompanyData`; use `runReport` for statements):
- [ ] **Undeposited Funds** near zero: every payment deposited.
- [ ] **AR aging**: over-60 items explained; unapplied payments and open credits identified.
- [ ] **AP aging**: overdue bills explained; supplier credits applied where possible.
- [ ] **Inventory**: valuation summary agrees with the inventory asset account; no unexpected negative quantities.
- [ ] **Sales tax**: tax payable account moved by roughly the expected net (sales tax less ITCs).
- [ ] **Profit and loss** vs last month and same month last year: explain big swings (seasonality, new customers, one-off costs).
- [ ] **Balance sheet**: no negative bank, no odd balances in suspense or clearing accounts.
- [ ] **Trial balance** balances (it always should; a difference means a data problem).
Record findings with `recordBusinessDecision` (area accounting) and carry follow-ups in `rememberBusinessContext`.

## Adjusting entries (practice)
- **Accrual**: expense incurred but not billed (for example utilities used in the month). Debit expense, credit accrued liabilities, dated month-end; reverse on the 1st of the next month with the opposite entry.
- **Prepaid**: an annual software or insurance bill paid upfront goes to prepaid expenses and is released monthly (debit expense, credit prepaid).
- **Deferred revenue**: care-plan fees collected in advance are earned monthly.
- **Depreciation**: fixed assets depreciated monthly (straight line) or yearly (CCA for tax is separate from book depreciation).
- The app's `journal-entry` activity posts only between published income and operating-expense roles, so accruals, prepaids, deferrals and depreciation against balance-sheet accounts need a new capability: file `requestCapability` once (key such as `month-end-adjusting-entries`).

## Year-end (fiscal year starts in September per the business profile; verify `FiscalYearStartMonth` in CompanyInfo)
- QuickBooks closes income and expense to retained earnings automatically on the first day of the new fiscal year; no closing entry is posted.
- Before year-end: full month-end checklist, inventory count reconciled, bad-debt review, accrued liabilities, fixed-asset additions, shareholder loan balance.
- Setting the **closing date and password** is a QuickBooks UI action (owner). The API can read it in Preferences (verify) but this app does not set it.

## Not possible through the API
- Bank and credit-card **reconciliation** (UI only). Never claim books are reconciled.
- Filing GST/HST returns, recording tax payments through the tax centre.
- Setting the closing date.
Report these as owner/UI tasks once, in the summary or daily plan.

## Support scenarios
- An accrual and its reversal across a month-end; a prepaid expense released monthly; a late supplier bill dated in the closed month (and why the app refuses it).
