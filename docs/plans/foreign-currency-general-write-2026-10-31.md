# Job F: foreign-currency general writes (2026-10-31)

Scope: governed accountant writes in already-enabled CAD-home multicurrency. No live
QBO calls, database writes, settings/currency creation, service control or commits.
Serving source is prepared and tested in a private temporary overlay before one batch save.

Direct read-only evidence: CompanySyncRecord Preferences 1, production, observed
2026-10-31T20:59:51.312Z: CurrencyPrefs.MultiCurrencyEnabled=true;
CurrencyPrefs.HomeCurrency.value=CAD. Native currency parties include Customer15 GBP,
Customer41 USD, Vendor16 EUR, Vendor69 USD. Active bank accounts:68 AUD,
1150040002 USD,1150040008 CNY; account73 is ExchangeGainOrLoss in CAD.
Private original records stay in the temporary replay export; tracked fixtures contain
only sanitized financial/reference fields and original record ids.

Work-value ledger:

| UTC checkpoint | Issue and direct proof | Decision |
|---|---|---|
| 23:00 | Essential: native currency fields exist but general preparation refuses non-CAD; replay real parties/transactions through service and close paths. | Build in scratch; next milestone is offline stored-record replay. |
| 23:19 | Independent review caught currency-null/line-account/EntityRef escapes, response field loss, restart warming and final partial cent allocation. | Fix before source save; keep settings and live data unchanged. |

This ledger records manually checked checkpoints, not an installed timer.

## Implemented contract

- Existing CAD-home currencies only; no CompanyCurrency, Exchangerate updates, foreign
  account creation or preference changes. Customer/Vendor CurrencyRef is immutable.
- Invoice, Bill, Payment, BillPayment, Deposit and Transfer accept ExchangeRate. On a
  foreign create, omission selects the observed dated Exchangerate. Explicit rates must
  match that observation. Source/target/date are checked; no inversion or historic
  transaction is substituted for an observed rate. Rate reads are scoped and tagged
  business-foreign-exchangerate, cached for five minutes within the service instance.
- A foreign record requires matching party, linked-record and AR/AP currency, existing
  currency-specific AR/AP accounts, and a home-currency or same-currency bank. Foreign
  Deposits require a destination in the same currency. Transfer Amount is positive,
  exact money expressed in CurrencyRef; banks may be CAD and that one foreign currency.
  Second foreign currencies and free Deposit lines bypassing AR/AP/bank workflows fail.
- Dollar limits and exposure are evaluated in CAD. Foreign inventory, foreign credit
  applications and foreign Payment/BillPayment/Deposit changes/removals remain held.
- Foreign settlement receipts retain the source's exact pre-send record, Balance and
  HomeBalance. Admission checks it again; final partial settlement consumes the residual
  home balance. Numeric/string ids share one identity, and duplicate target lines fail.
- Receipts, payload, requestid, bId and ExchangeRate stay unchanged on exact replay.
  Fresh unsent preflight warms rate evidence outside the Mongo admission transaction,
  including sparse updates after a restart. The admitted replay branch skips this step.
- Recovery rejects dropped/switched currency, rate or home-total fields and incomplete
  foreign amounts. Day close requires a CAD General Ledger and compares every saved
  record against postings derived from its own lines, ExchangeRate, HomeTotalAmt when
  returned, and linked sources' retained carrying values. Realized differences use the
  uniquely identified ExchangeGainOrLoss account. Wrong accounts or amounts still fail.
- Open foreign invoices/bills and foreign bank balances remain the inputs for a later
  home-currency revaluation. This change does not run revaluation or create its special
  journal; unrealized AR/AP revaluations are not ordinary GL movements.

## Intuit contracts and provenance

Checked 2026-10-31 using Intuit-published API and generated SDK field references.
The SPA pages for several entities returned a sign-in shell to web fetch; the separate
browser origin request was denied. The SDK links below supply their field contracts;
this is not a claim that the unavailable SPA field text or a native write was inspected.

| Shape | Fields/rule checked | Intuit reference |
|---|---|---|
| Customer | CurrencyRef is the currency for that customer's transactions | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer ; https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/6d104eab-4efe-2827-a17f-459b0c3edc0f.htm |
| Vendor | CurrencyRef sets transaction currency; existing currency is not changed | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor ; https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/cabfef12-4a0b-9f3d-3067-9893586545c3.htm |
| Invoice | CurrencyRef, ExchangeRate as home units per foreign unit; HomeTotalAmt and HomeBalance read-only | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice |
| Bill | CurrencyRef, ExchangeRate, HomeBalance; APAccountRef | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill ; https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/08b663fd-794a-fb45-eba9-642b5dc606c3.htm |
| Payment | CurrencyRef, ExchangeRate, TotalAmt, DepositToAccountRef and invoice links | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment |
| BillPayment | CurrencyRef, ExchangeRate, TotalAmt, CheckPayment.BankAccountRef, CreditCardPayment.CCAccountRef and bill links | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment |
| Deposit | CurrencyRef, ExchangeRate, HomeTotalAmt and bank destination | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit ; https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/c1584483-3540-f283-0aa0-4046e8daebe5.htm |
| Transfer | CurrencyRef denomination, ExchangeRate home-per-foreign, FromAccountRef, ToAccountRef, Amount | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/transfer ; https://static.developer.intuit.com/sdkdocs/qbv3doc/ippphpdevkitv3/entities/files/IPPTransfer.html |
| Exchangerate | GET exchangerate?sourcecurrencycode=XXX&asofdate=YYYY-MM-DD; ExchangeRate response has SourceCurrencyCode, TargetCurrencyCode, AsOfDate and Rate | https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/all-entities/exchangerate |
| Settlement/revaluation | Realized on collection/payment; unrealized AR/AP revaluation is not ordinary GL/TB activity | https://quickbooks.intuit.com/learn-support/en-ca/help-article/list-management/frequently-asked-questions-home-currency/L9wkSS2RA_CA_en_CA |

## Evidence and remaining limits

Original-source replay of CompanySyncRecord Customer15/41 and Vendor16/69 through
createGeneralWriteService.prepare returned Only CAD records are supported, with zero
in-memory creates. The modified service prepares all four through the actual context
and guard path. Native transaction responses Invoice22, Bill24, Payment26,
BillPayment27 and Deposit21 replay through response recovery with no transport send.

Independent arithmetic from stored fields gives GBP Payment26 CAD3423.49 cash against
CAD3428.53 original AR, a CAD5.04 realized loss; EUR BillPayment27 CAD1632.59 cash
against CAD1560.55 original AP, a CAD72.04 realized loss. These are offline expectations,
not a native GL observation. Deposit21 converts AUD5000 at0.873115 to CAD4365.58.

Dedicated tests cover actual service preparation/context, observed rate proof, dependency
chains, exact replay, sparse-update restart preflight/admission, source snapshots,
partial/final-cent allocation, history movement, response-field preservation, currency
substitution, credit holds, duplicate identities, transfer limits and CAD day close.

Reachable catalogue requirements through the governed tool:
Customer.foreign-currency, Vendor.foreign-currency, Invoice.foreign-currency,
Bill.foreign-currency, Payment.foreign-currency, BillPayment.foreign-currency,
Deposit.foreign-currency and Transfer.foreign-currency. Preferences.multicurrency was
already observed. Realized gain/loss and revaluation inputs do not have separate
foreign-currency requirement keys in the current catalogue. No coverage row is marked
satisfied by code or tests; native records remain its evidence source. Catalogue/toolbox
files owned by job X are unchanged.

Outcome ledger:

| Outcome | Evidence | State |
|---|---|---|
| Existing multicurrency settings and foreign-bank availability | Read-only mirror ids above | Observed |
| Governed foreign preparation, recovery and CAD posting proof | 195 affected tests; 18 dedicated tests replay original private stored data | Verified offline |
| Independent implementation and safety review | Distinct read-only reviewers; concrete findings corrected and re-reviewed | Reviewed |
| New foreign records, native realized-FX ledger attribution, cross-currency transfer/report behavior, nightly close | No live QBO calls or writes authorized for job F | Unverified |

All changes remain local and uncommitted by instruction. No service command, QBO call
or MongoDB write was run. The final source save can trigger the owner's existing
nodemon watcher; no service restart command is issued.

## Files and final verification

Owned source files:
- backend/src/modules/general-write-currency.js
- backend/src/modules/general-write-guards.js
- backend/src/modules/general-write-service.js
- backend/src/modules/general-write-transport.js
- backend/src/modules/general-write-postings.js
- backend/src/modules/general-write-merge.js
- backend/src/modules/general-write-recovery.js
- backend/src/modules/general-write-close.js
- backend/src/modules/general-write-day-close.js
- backend/src/modules/general-write-close-gate.js
- backend/src/modules/qbo-entity-schema.js

Dedicated test/fixture: backend/test/general-write-currency.test.js and
backend/test/fixtures/foreign-currency-native.json. Source saved in one locked batch at
2026-10-31T23:28:28.944Z; all11 locks released. Saved files match the reviewed overlay.

From backend/, node --test with these affected files passed195/195:
- test/business-observation-general-write.test.js
- test/general-write-billable-links.test.js
- test/general-write-capabilities.test.js
- test/general-write-close-gate.test.js
- test/general-write-daily-count.test.js
- test/general-write-dated-sales-replay.test.js
- test/general-write-fixtures.test.js
- test/general-write-gate.test.js
- test/general-write-guards.test.js
- test/general-write-inventory-carry.test.js
- test/general-write-inventory.test.js
- test/general-write-recovery.test.js
- test/general-write-service.test.js
- test/general-write-settlements.test.js
- test/general-write-currency.test.js

The dedicated test file also passed18/18 against the exact private CompanySyncRecord
export with no source overlay. node scripts/agent-harness/check-backend-syntax.mjs
passed all304 backend JavaScript files. Owned git diff --check passed. Implementation
and safety reviewers found no remaining concrete blocker after corrections. These
checks prove offline behavior only. Concurrent E2/X edits remain outside this job.
