---
name: canadian-sales-tax
description: GST/HST/PST/QST for this Nova Scotia company: rates by province and date (NS HST 15% to 14% on 2025-04-01), place of supply, zero-rated and exempt supplies, input tax credits, QuickBooks tax codes, no API filing. Use when choosing or checking tax or building a tax scenario.
---

# Canadian sales tax

## This company
- Harbour & Pine Operations Inc., Halifax, Nova Scotia; home currency CAD; GST/HST registrant.
- Nova Scotia is an HST province. **HST NS is 15% for supplies on or before 2025-03-31 and 14% from 2025-04-01.**
- Prices are before tax (`TaxExcluded`). QuickBooks computes tax from each line's tax code and the record's date; the app independently recomputes it from the dated tax-rate history and refuses a plan whose rate is ambiguous (`business-tax-policy.js`).
- A correction repeats the original record's tax exactly. If the original code no longer produces that rate today (for example a 15% sale corrected after April 2025), the correction is refused; that is correct behaviour, not a fault to work around.

## Rates by province (verify each year before relying on a rate)

| Province | Tax | Rate |
| --- | --- | --- |
| Nova Scotia | HST | 14% (15% before 2025-04-01) |
| New Brunswick, Newfoundland and Labrador, Prince Edward Island | HST | 15% |
| Ontario | HST | 13% |
| Alberta, Yukon, NWT, Nunavut | GST | 5% |
| British Columbia | GST + PST | 5% + 7% |
| Saskatchewan | GST + PST | 5% + 6% |
| Manitoba | GST + RST | 5% + 7% |
| Quebec | GST + QST | 5% + 9.975% |

## Which tax applies (place of supply, simplified)
- **Goods**: the province where the goods are delivered or made available.
- **Services**: generally the province of the customer's business address the supplier obtains (with special rules for real property, events and passenger transport). A Halifax supplier serving an Ontario customer charges HST 13%; serving an Alberta customer charges GST 5%.
- **PST/QST** are charged by a supplier only if registered in that province (or required to be). This company is not assumed to be PST/QST registered: charge GST only to BC, SK, MB and QC customers unless the company's tax setup shows that province's agency (read TaxAgency/TaxCode first).
- **Zero-rated** (0%, input tax credits still claimable): exports, basic groceries, prescription drugs, many medical devices. **Exempt** (no tax, no input tax credits): most financial services, residential rent, health and education services, many charity supplies. **Out of scope**: wages, owner contributions, transfers, loan principal.

## Purchases
- GST/HST paid on business purchases is an **input tax credit (ITC)**: QuickBooks posts it against the GST/HST payable account, so the net is what is remitted.
- PST paid on purchases is a cost (not recoverable). Meals and entertainment ITCs are limited to 50% in a return; QuickBooks does not do this automatically.
- A supplier credit or refund reverses the ITC on the original supply.

## In QuickBooks Canada
- Tax codes come from the company's sales tax setup (for example HST NS, HST ON, GST, Zero-rated, Exempt, Out of Scope). Each code has separate sales and purchase rate lists. Read them with `searchEntities` (TaxCode, TaxRate, TaxAgency); never assume an id.
- Every sales and purchase line needs a tax code. Missing tax gives fault 6000 "Make sure all your transactions have a GST/HST rate".
- Rates are effective-dated: the same TaxRate id can carry 15% to 2025-03-31 and 14% from 2025-04-01. The record's `TxnDate` selects the rate.
- Journal entries can carry tax (`TaxCodeRef`, `TaxApplicableOn`); use only to correct tax, and prefer a credit memo or supplier credit so the document trail matches the return.
- Reports: GST/HST return and Tax Liability are product/UI reports (no Reports API endpoint). Through the API, evidence comes from `TxnTaxDetail` on records, the tax payable account in TrialBalance/GeneralLedger, and `queryCompanyData` totals.
- **Filing and payments**: preparing and filing a GST/HST return, recording the tax payment or refund, and changing tax setup are QuickBooks UI actions (owner). The API does not file returns. Never claim a return was filed.
- Filing frequency: annual for revenue up to $1.5M, quarterly to $6M, monthly above $6M (CRA thresholds). Small-supplier registration threshold: $30,000 in four quarters.

## Support scenarios worth having (create with available tools)
- A sale dated before and one after 2025-04-01 to the same customer (15% vs 14%); compare tax on the GST/HST report.
- A mixed-tax invoice (taxable service plus a zero-rated or exempt line) when the tools allow multi-code lines; otherwise file `requestCapability`.
- An out-of-province customer (GST-only) once customer addresses and codes allow it; otherwise `requestCapability`.
- Credit memo or refund that reverses tax at the original rate (the correction workflow does this).

## Checklist
- [ ] Rate matches the record date and the place of supply.
- [ ] Tax shown on the saved record (`TxnTaxDetail.TotalTax`) equals the planned tax.
- [ ] No claim of filing, remittance or reconciliation.
- [ ] Unsupported tax needs (PST registration, new codes, return filing) go to `requestCapability` or are reported as owner/UI actions, not asked repeatedly.
