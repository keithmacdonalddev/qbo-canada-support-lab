1
--- Terra reply ---
The read-only map is complete for the screens visible without selecting a file or starting reconciliation. The existing QuickBooks tab is open on the [homepage](https://qbo.intuit.com/app/homepage). The homepage showed **My Business**, and its shortcuts panel confirmed Company ID **9130357222392856**. The subscription tier was not visible.

1. **Bank transactions** — [https://qbo.intuit.com/app/banking](https://qbo.intuit.com/app/banking)

   One connected account card appeared, selected, with one transaction to review. It displayed an error requiring bank security verification. The screen has **Review**, **Accepted**, and **Excluded** tabs; search, date and transaction-type filters; pagination; Print, Export to CSV, table settings, and Go to bank register. Top controls include Update, Requests, Link account and its menu.

   The table columns are selection, **Date**, **Bank description**, **Spent**, **Received**, attachment, conversation, **Tax**, **From/To**, **Match/Categorize**, and **Action**. The row exposes category, supplier, attachment, conversation and posting controls.

   Screenshot: [banking.jpg](/C:/Projects/qbo/artifacts/terra-live/qbo-banking-map-20261101-015242/banking.jpg)

2. **Upload from file** — [https://qbo.intuit.com/app/newfileupload](https://qbo.intuit.com/app/newfileupload)

   From Bank transactions, open the arrow beside **Link account**, then choose **Upload from file**. The **Import bank transactions → Upload your file** screen offers **Upload from this device** and lists PDF, JPG, PNG, HEIC, CSV, QFX, QBO, OFX and TXT. It also offers **Connect your bank** and says some statements are reviewed by a global team.

   No file was selected. Account selection and column mapping were not visible at this stage. The screen was closed.

   Screenshot: [upload.jpg](/C:/Projects/qbo/artifacts/terra-live/qbo-banking-map-20261101-015242/upload.jpg)

3. **Rules** — [https://qbo.intuit.com/app/olbrules?jobId=accounting](https://qbo.intuit.com/app/olbrules?jobId=accounting)

   **Bank rules** and **Integration rules** are separate views. The bank-rule list showed four active rules, with search, status filter, settings, selection, reorder handles, Edit and row menus. Columns are **Priority**, **Rule name**, **Applied to**, **Conditions**, **Settings**, **Auto-post**, **Status**, and **Actions**.

   **New rule** opens a drawer with rule name, money direction, accounts, all/any matching criteria, field/operator/value, **Add a condition**, **Test rule**, priority and preview. Actions include **Auto-post**, transaction type, category, product/service, split, payee, tax, customer, tags, class, location and memo options. **Auto-post was on by default** in the displayed form. The blank form was cancelled.

   Screenshots: [rules.jpg](/C:/Projects/qbo/artifacts/terra-live/qbo-banking-map-20261101-015242/rules.jpg), [new-rule.jpg](/C:/Projects/qbo/artifacts/terra-live/qbo-banking-map-20261101-015242/new-rule.jpg)

4. **Reconcile** — [https://qbo.intuit.com/app/reconcile](https://qbo.intuit.com/app/reconcile)

   The account dropdown contains bank accounts, credit cards and other account types. Selecting the named operating-bank account produced the URL `https://qbo.intuit.com/app/reconcile?accountId=123` and a CAD setup form. It shows **Beginning balance**, **Statement ending balance**, **Statement ending date**, optional service-charge and interest dates and amounts, expense and income account selectors, and **Start reconciling**. Header controls include **Chart of accounts**, **Register**, **Summary**, and **History by account**.

   No upload-statement or automatic/AI reconciliation option was visible on this setup screen. Reconciliation was not started. The dropdown included Canadian tax accounts and foreign-currency accounts; a foreign-currency selection displayed exchange-rate fields.

   Screenshot: [reconcile.jpg](/C:/Projects/qbo/artifacts/terra-live/qbo-banking-map-20261101-015242/reconcile.jpg)

**Automation risks:** The connected feed currently requires bank security verification. Account selection is distinct from the company ID and must be checked before an operation. The new-rule form defaults Auto-post on. The upload flow’s later account and mapping steps remain unverified without a file. No CAPTCHA appeared during this inspection; later steps may differ.

**Action ledger:** Opened and closed the company shortcuts panel, navigated the existing tab, opened and closed the upload screen, opened and cancelled a blank rule form, and selected an account in the reconciliation view. No files were uploaded, no form was submitted, and no bookkeeping record or rule was created or removed. Four screenshots were saved in the requested artifact directory.
--- effective settings (thread 01a19573-e4cb-77c3-b8cf-68463bcff0ba) ---

[exited with code 0]
