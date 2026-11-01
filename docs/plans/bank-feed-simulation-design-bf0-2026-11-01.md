**Test Data Lab can generate the complete banking history from the real QBO records, then keep producing realistic feeds and statements. The public Accounting API cannot complete the native bank-feed workflow.** Uploading, matching, excluding, bank rules, and finishing reconciliation require QuickBooks’ screens.

The implementation should therefore combine a simulated bank ledger, the accountant’s existing governed tools, and an evidenced QBO screen workflow.

**1. API capability matrix**

Checked against Intuit sources on November 1, 2026. “Verified” means supported by official documentation or Intuit’s maintained SDK; it does not mean live-tested here. Several developer-reference pages returned only a loading screen, so the specific gaps below remain marked unverified.

| Capability | Public API status | What this means for this app |
|---|---|---|
| Upload bank/card transactions into **For Review** | **Not supported** | Creating accounting records does not populate For Review. Current Intuit developer support explicitly says pending bank-feed items are outside the Accounting API. [Intuit confirmation](https://help.developer.intuit.com/s/question/0D5TR00001ZdteX0AR/matching-capital-on-tap-receipts-to-pending-bank-feed-transactions) |
| Import **CSV, QBO, OFX** bank files | **Not supported through Accounting API; verified through UI** | Generate files locally, then use Bank transactions → Upload from file. Canadian instructions explicitly include CSV, QBO and OFX. [Canadian upload instructions](https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_CA_en_CA) |
| List pending For Review items | **Not supported** | The Mongo mirror cannot represent the native pending queue using Accounting API records alone. [Intuit confirmation](https://help.developer.intuit.com/s/question/0D5TR00001ZdteX0AR/matching-capital-on-tap-receipts-to-pending-bank-feed-transactions) |
| Accept/Add, match, undo matches, exclude feed items | **Not supported through Accounting API; verified through UI** | These need native screen actions and evidence. Matching an existing record avoids creating another accounting entry. [Canadian matching workflow](https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-feeds/match-online-bank-transactions-quickbooks-online/L6qyw0PvP_CA_en_CA) |
| Read/create/update native bank rules | **Not supported** | App rules can prepare recommendations, but cannot be presented as native QBO bank rules. [Intuit developer answer](https://help.developer.intuit.com/s/question/0D54R000077Wx1iSAC/is-there-api-access-to-the-banking-feed-functionality-specifically-the-ability-to-manage-categorization-rules-and-manually-categorize-line-items-from-the-banking-feeds) |
| Reconcile an account; finish or undo reconciliation | **Not supported through public API** | The app can calculate differences and prepare evidence; native completion stays in QBO. [Developer answer](https://help.developer.intuit.com/s/question/0D54R000074DKlvSAG/is-there-an-internal-api-used-by-intuit-not-available-for-public-use-that-can-connect-with-the-reconciliation-functions), [Canadian reconciliation workflow](https://quickbooks.intuit.com/learn-support/en-ca/help-article/reconciliation-reports/learn-reconcile-workflow-quickbooks/L8ZibUuVE_CA_en_CA) |
| Read cleared/reconciled transaction marks | **Verified, limited to report evidence** | The prior company audit actually received C/R marks from reports. Intuit’s current SDK exposes a `cleared` report filter. This is different from a reconciliation-session API. Exact report-column availability remains report-specific. [Official ReportService](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/ReportService/ReportService.php) |
| Write cleared/reconciled marks | **Not supported through a documented public Accounting API operation** | `setCleared()` in the SDK sets a **report query filter**; it does not update transactions. Do not use it as a reconciliation writer. [Official ReportService](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/ReportService/ReportService.php), [developer reconciliation answer](https://help.developer.intuit.com/s/question/0D54R000074DKlvSAG/is-there-an-internal-api-used-by-intuit-not-available-for-public-use-that-can-connect-with-the-reconciliation-functions) |
| Retrieve completed native reconciliation reports | **Unverified API support; no documented supported endpoint established** | Treat this as UI-only in the design. QBO creates a static report when reconciliation finishes; save that report through its screen. [Canadian report instructions](https://quickbooks.intuit.com/learn-support/en-ca/help-article/export-reports/view-print-export-reconciliation-report/L1yNaVaOG_CA_en_CA) |
| Attach files to supported posted transactions | **Verified** | Use multipart `/upload` with Attachable metadata and an entity reference. The app currently supports attachment notes, but its schema says binary upload is not enabled. [Official upload sample](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/_Samples/UploadAttachment.php) |
| Attach files directly to Account records | **Unverified** | A generic `EntityRef` or inherited SDK property does not prove Account attachment support. Keep account-month files in app storage unless the exact supported reference is established. [Official reference structure](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Data/IPPAttachableRef.php) |
| Attach a statement to a reconciliation | **Verified through Canadian UI; API association unverified** | Finish or pause reconciliation, then attach the statement. An ordinary transaction attachment is not proof of this association. [Canadian statement instructions](https://quickbooks.intuit.com/learn-support/en-ca/help-article/statement-reconciliation/get-bank-statements-directly-bank-reconcile/L6n7CYm9Z_CA_en_CA) |
| Deposit with multiple lines and receipt links | **Verified** | Represents actual movement from Undeposited Funds into a bank. Export the resulting bank deposit once. [Official Deposit schema](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Data/IPPDeposit.php) |
| Deposit net of negative fee lines | **Unverified against accessible current API documentation** | Current app guards explicitly implement negative expense fee lines. Require an exact offline replay and later authorized native proof before claiming this creates a matchable net settlement. |
| Purchase: cash, cheque, credit card | **Verified** | `PaymentType` selects Cash, Check or CreditCard; `AccountRef` identifies the paying account. These are bookkeeping records. [Official Purchase schema](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Data/IPPPurchase.php) |
| Dedicated CreditCardPayment | **Verified** | The official SDK uses `CreditCardPaymentTxn`, mapped to `/creditcardpayment`. It identifies both bank and card accounts. Do not confuse it with customer card processing or `BillPayment.CreditCardPayment`. [Official create sample](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/_Samples/CreditCardPaymentCreate.php) |
| Transfer | **Verified** | One accounting transfer produces settlement legs for both affected accounts. [Official Transfer schema](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Data/IPPTransfer.php) |
| Customer Payment deposited to bank | **Verified** | `DepositToAccountRef` can identify the bank; omission ordinarily uses Undeposited Funds. [Payment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment) |
| BillPayment from bank/card | **Verified** | Uses `CheckPayment.BankAccountRef` or `CreditCardPayment.CCAccountRef`. Recording payment does not itself move real funds. [BillPayment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) |
| RefundReceipt | **Verified** | Records a customer refund; settlement must follow the account actually used. [Official RefundReceipt schema](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Data/IPPRefundReceipt.php) |
| JournalEntry for interest/fees | **Verified** | Balanced bank/expense or bank/interest-income entries are possible. Only genuine native-currency cash movements become statement lines. [Official JournalEntry implementation](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Facades/JournalEntry.php) |
| CreditCardCredit | **Verified as Purchase with `Credit:true`** | This is not a separate creation endpoint. The Purchase schema defines a credit-card refund using that flag. [Official Purchase schema](https://raw.githubusercontent.com/intuit/QuickBooks-V3-PHP-SDK/master/src/Data/IPPPurchase.php) |

**Canadian formats and newer features**

| Item | Finding |
|---|---|
| Three-column CSV | **Verified:** `Date,Description,Amount`. |
| Four-column CSV | **Verified:** `Date,Description,Credit,Debit`. Intuit’s example puts withdrawals under Credit and deposits under Debit; do not infer signs from ordinary accounting terminology. |
| Upload limits | **Verified:** up to 1,000 transaction lines and 350 KB per transaction-list file. Use a conservative byte limit and split automatically. |
| Dates and encoding | Canadian guidance recommends consistent `dd/mm/yyyy` dates and Windows CSV formatting. |
| PDF/image statement → bank transactions | **Documented**, including a link from the Canadian CSV-format article; the exact experience in this company is **unverified**. The detailed current upload instructions are visible in Intuit’s US article. |
| AI-assisted reconciliation in Canada | **Verified as a documented UI workflow:** the Canadian “Reconcile Companion” extracts statement data and compares it with QBO. Availability in this particular company remains **unverified**. It is not an Accounting API capability. |

Sources: [Canadian CSV formats](https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-transactions/format-csv-files-excel-bank-transactions-quickbooks/L4BjLWckq_CA_en_CA), [Canadian upload limits](https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_CA_en_CA), [PDF extraction workflow](https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_US_en_US), [Canadian Reconcile Companion](https://quickbooks.intuit.com/learn-support/en-ca/help-article/reconciliation-reports/learn-reconcile-workflow-quickbooks/L8ZibUuVE_CA_en_CA).

**Bank-feed partner programs are a separate route.** Intuit offers financial-institution connectivity and a third-party-provider contact path. That means a non-bank organization can approach Intuit; it does not establish eligibility for this simulated-bank app, Canadian coverage, or permission to inject arbitrary feeds. Treat Test Data Lab’s access as **unverified**, and keep partnership out of the critical implementation path. [OFX program](https://www.intuit.com/partners/fdp/implementation-support/ofx/), [Financial Data Platform](https://www.intuit.com/partners/fdp/implementation-support/).

**2. What the actual company requires**

I inspected the [retained banking audit](/C:/Projects/qbo/artifacts/goal-realization/banking-research-20261101.json), the requested prior-session final answers, current source, and scoped read-only Mongo queries.

At **2026-11-01 04:07 UTC**, the mirror contained **11,493 records across 130 accounts**. It still contained **zero CreditCardPayment and TaxPayment records**; BK1 was preparing that work.

The historical inventory through October 2026 is:

| Account | ID | Currency | Ledger rows | Provisional statements |
|---|---|---:|---:|---:|
| Operating bank | 123 | CAD | 3,533 | 38 |
| Chequing | 60 | CAD | 235 | 79 |
| Chequing XYZ | 66 | CAD | 8 | 73 |
| Chequing USD | 1150040002 | USD | 2 | 35 |
| Savings | 1150040007 | CAD | 1 | 5 |
| Test Credit Union | 1150040006 | CAD | 1 | 6 |
| Credit Card | 85 | CAD | 5 | 55 |
| Amex 1234 | 1150040005 | CAD | 2 | 6 |
| capital one | 1150040000 | CAD | 0 | 19 |
| checking | 1150040008 | CNY | 0 | 5 |
| money | 1150040011 | CAD | 0 | 1 |
| Square deposit account | 121 | CAD | 0 | 2 |
| **Total external bank/card coverage** | | | **3,787** | **324** |

There are also **116 provisional cash-account months** across four CashOnHand accounts. Those require cashbooks/count evidence, rather than imported bank feeds.

The 324 count uses the earliest retained posting or, where necessary, QBO creation month as a provisional opening convention. Account creation timestamps are not proof of economic opening dates.

The generator must preserve these specific cases:

- **1,385 payment-to-deposit links:** rechecked in Mongo; no duplicates, missing payments, or linked-amount mismatches.
- **Seven nonzero undeposited receipts, CAD 8,527.03:** no bank line until deposited.
- **Invoice 486:** bank movement is **CAD 50**, not its CAD 94.56 invoice total.
- **Payment 26:** GBP 2,000 settles into account 60 as **CAD 3,423.49**.
- **Chequing USD:** native movements are **−USD 1,100 and +USD 1,130**, leaving USD 30.
- **CreditCardPayment 483:** CAD 100 links bank 1150040006 and card 1150040005.
- **Transfers 343 and 345:** CAD 100 and CAD 300 from account 60 to card 85; both account sides are required.
- **JournalEntry 200:** CAD 86.84 exchange adjustment with **zero AUD cash movement**; exclude it from cash activity.
- **Sales Tax Adjustments 91, 93, 94, 97 and 98:** bank-ledger postings need explicit classification. Adding TaxPayment sync alone does not resolve these report-only cases.
- **Three voided payments and one zero tax payment:** retain audit evidence without manufacturing settlement lines.
- **13 R and 20 C marks:** the owner identified these as feature tests. They do not complete historical business reconciliation.

**3. Settlement-event design**

A settlement event records when money reaches or leaves a simulated bank or card account. It must be distinct from the QBO transaction and retain:

```text
Company scope: environment, realmId, connectionId
Identity: stable eventId, accountId, settlementGroupId, pairedEventId
Money: accountCurrency, exact native amount, movement direction
Timing: bookDate, expectedPostingDate, actualPostingDate, statementPeriod
Source: QBO entity/id/line, source hash, sync observation, report evidence
Resolution: expected Match / Add / Exclude / investigate, linked QBO ids
History: policy version, revision, supersededBy, generated-file references
```

Use integer minor units or exact decimal arithmetic. A source hash records change; it must not become a new event identity whenever QBO increments SyncToken.

The conversion rules should be:

| QBO activity | Bank-side result |
|---|---|
| Direct-to-bank Payment/SalesReceipt | One settlement, subject to posting lag. |
| Payment/SalesReceipt linked to Deposit | Suppress its separate bank settlement; use the Deposit. QBO can change receipt account references after deposit, so inspect links. |
| Grouped Deposit | One net bank line; retain its full receipt/fee breakdown separately. |
| Purchase or bank BillPayment | One withdrawal. Cheques can clear days or weeks after issue. |
| Card Purchase / BillPayment paid by card | One card charge; do not also debit a bank until the card is paid. |
| Transfer / CreditCardPayment | Paired account legs, potentially posting on different dates. |
| RefundReceipt / card credit | Movement on the actual refund account, with the appropriate direction. |
| Invoice with Deposit | Export only its explicit bank deposit. |
| JournalEntry / tax adjustment | Inspect account-level native movement and economic meaning; never export the transaction total blindly. |
| Invoice, Bill, Estimate, PurchaseOrder without settlement | No bank line. |

Proposed timing policies should be deterministic and saved with each event: electronic payments commonly same/next banking day, processor payouts after a short settlement interval, cheques later, and card charges after posting. Banking calendars can delay settlement while the simulated company continues operating 24/7.

For currency:

- Use the **account’s currency**, not automatically the transaction currency or CAD report amount.
- Retain both foreign and home-currency evidence.
- Prefer proved account-native movements over a fresh conversion.
- Paired FX transfers retain both amounts and the conversion basis.
- Revaluation-only entries produce no native settlement.
- Unknown currency allocation blocks that event’s package, with an exact reason.

For cards, keep **amount owed** separate from the import sign convention. Proposed CSV signs are charges negative and payments/refunds positive, with a mandatory import-preview check in this company. Statements show charges increasing debt and payments reducing it.

**Historical statements are reconstructed simulated evidence.** Their agreement with QBO proves internal consistency, not independent bank confirmation. Future bank-origin events should be stored before bookkeeping so they can expose missing entries.

**4. Additional data and the Match/Add balance**

The feed needs information not supplied by bookkeeping: posting dates, merchant descriptors, settlement references, cheque identifiers, statement cycles, fee schedules and bank-origin events.

Recommended operating mix: **roughly 90–95% existing-record Match work and 5–10% genuine bank-origin exceptions**, adjusted by measured coverage. This is a design target, not an observed ratio.

| Additional event | Recommended treatment |
|---|---|
| Routine monthly bank fees | Leave selected examples for native **Add**; accountant pre-records the remainder through governed Purchase/JournalEntry operations, then Match. |
| Savings interest / borrowing interest | Mostly accountant-posted from statement advice; retain some Add examples. Calculate from the simulated account’s actual terms and balances. |
| NSF/returned customer payment | Store a linked return event. Accountant prepares the proper receivable correction plus separate bank fee. **Never classify the returned principal as an ordinary expense.** Match after the correction. |
| Square/merchant fees | Usually pre-record gross receipts, fees and net payout correctly, then Match the net settlement. Retain processor settlement advice. Do not subtract fees again if already included. |
| Card annual/foreign-transaction fees | Mix pre-recorded Match and a small number of native Add examples. |
| Bank-initiated transfer | Leave selected examples for native transfer handling; connect both feed legs to **one** resulting accounting transfer. Pre-record other transfers. |
| Small unknown items | Leave pending for investigation with a supporting advice/receipt scenario; resolve before reconciliation. Small value alone is not a categorization rule. |
| Duplicate imports | **Exclude**, without creating bookkeeping. Keep deliberate duplicate tests in separately labelled files; do not double-count them in canonical statements. |

Every event needs one designated creator: **API accountant or native Add**. Reserve that choice and check the mirror before acting so an API create cannot race a UI Add.

Do not silently inject years of invented fees into already reconstructed history. Prepare all historical base packages; introduce additional scenarios in identified unreconciled periods, and re-prove any accounting changes before those packages are finalized.

**5. CSVs, statements, and full-history delivery**

Use one canonical settlement dataset to produce both outputs.

- Default CSV: `Date,Description,Amount`; `dd/mm/yyyy`; English; two decimal places; no currency symbols, thousands separators, totals, opening-balance rows or zero movements.
- Keep descriptions compatible with Intuit’s guidance; retain detailed numeric references in the sidecar manifest.
- Split conservatively at **999 data rows or 340,000 bytes**. Never split a row.
- Preserve a row-to-event-to-QBO crosswalk outside the import CSV.
- Produce text-based, clearly labelled **“Simulated statement — Test Data Lab”** PDFs with account/currency, period, opening balance, dated transactions, totals and closing balance.
- Include card payment/charge totals, due dates and settlement-advice details where applicable.

Required arithmetic:

```text
Bank closing balance = opening balance + settled inflows − settled outflows
Card closing amount owed = opening owed + charges/fees − payments/credits
Next opening balance = previous closing balance
```

Outstanding cheques and deposits in transit explain differences from book balances. They are not fabricated balancing entries.

Execution should cover **all 324 provisional external periods**, earliest to latest within each account:

1. Freeze and fingerprint the historical source snapshot.
2. Incorporate BK1’s missing sources and classify report-only exceptions.
3. Build opening balances, outstanding items and settlement policies.
4. Generate every applicable package; quiet months receive statements with carried balances and **no empty upload requirement**.
5. Process native uploads and reconciliations chronologically.
6. Publish daily incremental CSVs for active accounts; offer weekly bundles where practical.
7. Finalize monthly statements after the posting cutoff, retaining unsettled items into the next period.

The historical busiest month has only **114 ledger rows**, so present monthly files fit the row limit before additional settlement scenarios. Future volume must still be split automatically.

After upload, packages are immutable. Late edits create a revision and mark affected later periods for review; they never silently replace uploaded evidence.

**6. Tracking and the app experience**

Use a Banking workspace with account rows, month coverage, blockers and a clear next action. The owner should immediately see which account-month needs attention.

Track these separately:

| State | Required evidence |
|---|---|
| Generated | Source snapshot, policy version, event/row counts, balances and CSV/PDF hashes. |
| Uploaded | Exact file hash, target account/currency, operator/time, observed import count and native confirmation. |
| Reviewed | Every imported row has a recorded decision or explicit pending exception. |
| Matched | Native match evidence and resulting QBO references; distinguish multi-record matches. |
| Added | Resulting QBO record observed in sync and linked to its bank-origin event. |
| Excluded | Native exclusion evidence and reason, especially duplicates. |
| Reconciled | Native completed reconciliation report, account/period/balances, zero-difference completion evidence, statement attachment and explained outstanding items. |

Use explicit evidence labels: **operator attested**, **screen observed**, **synced record observed**, or **native report retained**. A checked box, C/R mark, balanced trial balance or successful file generation must not automatically become “reconciled.”

The current [PeriodClose component](/C:/Projects/qbo/frontend/src/components/PeriodClose.jsx:56) explicitly retains references rather than source files and checks entered arithmetic. BK1 addresses its currency/cash limitations. This banking workspace should consume that work and provide stronger evidence without claiming to finish native reconciliation.

**7. What must happen in QuickBooks**

For each account and period:

1. Confirm company, account, currency, opening balance and existing feed/reconciliation state.
2. Upload each exact CSV once; verify preview signs, dates and counts.
3. Match existing records; Add designated bank-origin items; exclude duplicates.
4. Resolve unexplained items and paired transfers.
5. Reconcile against the generated statement.
6. Finish only at zero difference, retaining outstanding items rather than forcing an adjustment.
7. Attach the statement and save the native reconciliation report.
8. Record evidence and verify newly created accounting records through sync.

Existing feature-test R marks require native inspection first. Intuit says already-reconciled records cannot be matched; simply excluding all affected historical rows would leave the requested matching coverage incomplete. Preserve the old evidence before any separately authorized repair. [Canadian matching restrictions](https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-feeds/match-online-bank-transactions-quickbooks-online/L6qyw0PvP_CA_en_CA).

| Option | Benefit | Main risk and control |
|---|---|---|
| Owner/support operates a generated checklist | Easier to establish correct native behavior and resolve unusual records. | Hundreds of periods create repetition and inconsistent evidence. Provide ordered packages, counts, exact expected actions and resumable checklists. |
| Browser automation operates QBO | Can remove most repetitive upload/match/reconcile work. | UI changes, session expiry, ambiguous matches and interrupted imports can duplicate or misclassify activity. Use visible screen actions, account assertions, durable checkpoints, evidence after each action and stop on ambiguity. |

Both options should use the same packages and evidence contract. Browser automation must not substitute undocumented private banking endpoints. **The native queues and company-specific AI upload experience were not inspected in this job.**

**8. Builder jobs, ready to paste**

These are proposed jobs; none was launched. Apply this common preamble to each:

```text
Repo C:/Projects/qbo, main. Read AGENT_WORKFLOW.md, applicable rules and
handoff sections 3,5,7,8. No commits, service control, QBO calls or Mongo writes.
Read-only scoped Mongo queries allowed; never print secrets or raw customer data.

You are not alone in the checkout. Own only listed files; preserve others.
Use the general Node REPL and child_process execFile/spawn with windowsHide:true,
explicit argument arrays and no shell. Never use exec_command/write_stdin.

Prepare and test outside backend/src, then save production source in one final
batch. Replay real stored data through the actual production entry point before
delivery. Run the listed node --test commands from backend/. No startup wiring
or live execution. Report decisions, replay ids, files, test results and limits.
```

**BF1 — Settlement contract and conversion**

```text
Own:
backend/src/modules/bank-settlement-contract.js
backend/src/modules/bank-settlement-engine.js
backend/test/bank-settlement.test.js
backend/test/fixtures/bank-settlement-history.json

Implement pure conversion from scoped mirror + retained native ledger evidence
to stable account-native settlement events and outstanding-item schedules.
Cover direct receipts, deposit links, Invoice.Deposit, purchases, refunds,
transfers, CreditCardPayment, TaxPayment, report-only adjustments and FX.
Never infer complete coverage from the entity mirror alone.

Replay all 3,789 retained ledger rows. Preserve 486=$50, Payment 26=CAD3423.49,
483's two legs, Transfers343/345, zero-native-cash JE200, and all 1,385 links.
Unknown financial meaning returns an exact unresolved event, never a plug.
Export a versioned plain-data contract for downstream jobs.

Test: node --test test/bank-settlement.test.js
```

**BF2 — CSV and statement packages**

```text
Own:
backend/src/modules/bank-feed-csv.js
backend/src/modules/bank-statement-pdf.js
backend/src/modules/bank-statement-package.js
backend/test/bank-statement-package.test.js

Consume BF1 events. Generate deterministic CSVs, simulated monthly PDFs and
sidecar manifests for all 324 provisional external periods; identify the
separate 116 cash periods. Enforce byte/row limits, date/sign profiles, exact
balances, quiet months, paired settlements and immutable package revisions.
Use installed dependencies where suitable; follow the PDF skill for rendering.
No database persistence or upload execution.

Replay actual historical events; visually inspect representative CAD, USD,
card, quiet-month and multi-page PDFs. Test CSV/PDF balance agreement.
Test: node --test test/bank-statement-package.test.js
```

**BF3 — Bank-origin events and accountant resolution**

```text
Own:
backend/src/modules/bank-origin-events.js
backend/src/modules/bank-origin-resolution.js
backend/src/accountant-skills/banking-feed-operations/SKILL.md
backend/src/accountant-skills/banking-and-deposits/SKILL.md
backend/test/bank-origin-events.test.js

Implement explicit simulated fees, interest, NSF, merchant fees, card fees,
bank-initiated transfers, unknown items and separate duplicate-test scenarios.
Consume BF1's contract. Produce governed accounting-operation drafts or native
UI tasks, with exclusive creator ownership and duplicate prevention.
Do not add raw QBO calls or broaden the general write surface.

Correct stale negative-deposit-fee guidance against current guards, retaining
the distinction between supported app behavior and unverified native matching.
Exercise existing real account/currency shapes and gross/net deposit links.
Test: node --test test/bank-origin-events.test.js
```

**BF4 — Persistence, evidence and backend workspace**

```text
Own:
backend/src/models/BankingEvent.js
backend/src/models/BankingPackage.js
backend/src/modules/banking-workspace-service.js
backend/src/routes/banking-workspace.js
backend/test/banking-workspace.test.js

Build injected/testable persistence and authenticated company-scoped routes
for BF1/BF2 packages and evidence transitions. No migration or database writes
during this job. No company.js mounting yet.

Track generated/uploaded/reviewed/matched/added/excluded/reconciled separately,
with row-level evidence, hashes, revisions, interrupted-import recovery and
explicit evidence strength. Enforce company/account/currency boundaries.
Native reconciliation completion requires retained native evidence.
Test: node --test test/banking-workspace.test.js
```

**BF5 — Desktop Banking workspace**

```text
Own:
frontend/src/components/banking/BankingWorkspace.jsx
frontend/src/components/banking/BankingAccountPeriod.jsx
frontend/src/api/banking.js
frontend/src/components/banking/banking.css

Build against BF4's agreed response contract. Show useful account/month content,
next actions, package downloads, statement preview, exception details and native
execution checklists immediately. Include loading, empty, stale, error and
interrupted-work recovery states. Distinguish attestation from observed proof.
No Company.jsx mounting or PeriodClose edits. Desktop rendered inspection is
required when a separately authorized running review surface is available.
Run frontend build/lint; report rendering unavailable if it cannot be inspected.
```

**BF6 — Integration, after BF1–BF5 and BK1/AU settle**

```text
Own:
backend/src/modules/banking-accountant-tools.js
backend/src/routes/company.js
backend/src/modules/business-agent-toolbox.js
backend/src/modules/business-agent-tools.js
frontend/src/pages/Company.jsx
backend/test/banking-integration.test.js

Mount the workspace, expose deferred accountant tools and connect evidence to
BK1's final period-close contract. Re-read current files before touching them;
take required basename locks for shared files. Do not modify BK1-owned period
modules without a separately assigned ownership transfer.

Keep settlement generation outside the 220-record write loop's critical path.
Use sync instead of per-row QBO reads; failures block only affected banking work.
Prepare offline and make one final backend/src batch. No service operations.
Test: node --test test/banking-integration.test.js
Obtain independent implementation/safety reviews before authorized execution.
```

Native execution should be a separate job once built, explicitly authorized for the target company and chosen operator/browser route.

**Verification and changes**

- **Changed files: none.** No locks, commits, service changes, QBO calls or Mongo writes.
- Rechecked 324 external periods, 116 cash periods, 1,385 deposit links and the targeted historical amounts with seven passing evidence assertions.
- Replayed real stored **Payment 26 and Transfers 343/345** through production `postingsOf`; expected bank postings matched.
- Real **JournalEntry 200** returns `GENERAL_CURRENCY_UNVERIFIED` through that production path. The settlement generator therefore needs a native-ledger adapter for historical exceptions; blindly reusing that posting calculator is insufficient.
- Ran `node --test test/general-write-currency.test.js` from `backend/`: **18 passed, 0 failed**, exit 0.
- Closed the read-only Mongo connection.
- Fresh Git status remained **main...origin/main**; concurrent uncommitted work was preserved.

Codex session ID: 01a19547-7a06-7020-b16e-1b1382ab88d2
Resume in Codex: codex resume 01a19547-7a06-7020-b16e-1b1382ab88d2
