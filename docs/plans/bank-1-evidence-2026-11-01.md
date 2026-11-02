# BANK-1 delivery evidence — 2026-11-01

Updated: 2026-11-02T05:33:37.024Z. Status: **DELIVERED — all five BANK-1 acceptance conditions directly verified**. BANK-2/BANK-3 and full SB/D outcomes remain OPEN.

The canonical checkout is C:\Projects\qbo on main, configured upstream origin/main. Frontend commit0281720, backend commits1d8d24f/2871cef and the observed desktop contrast correction98ded95 are pushed. Normal business services were left running. No service control, QBO mutation, financial-data write, storage preparation, accepted-package revision or native reconciliation action was performed. Normal shared-agent login exchanges and their audit records are authorized separately.

## Fixed acceptance selection

Production connected company ending 2856; existing CAD accounts selected from real provisioned inventory, with retained activity rather than empty convenience examples:

| Account | Period | Retained package revision | Opening | Movement affecting balance | Closing | Rows |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Bank 123, Operating bank | 2023-09 | a86a4c4ff040c2ffed87384754e044446b8f8835433df3a5fd106a2c5a8abe65 / 1 | CAD 0.00 | CAD +21,292.25 | CAD 21,292.25 | 37 |
| Credit Card 85 | 2025-04 | 87d08dcbc5ffd16ed2fce19f1aa15c206b4e711c067af9d53d79b48c32338a33 / 1 | CAD 200.00 owed | CAD +100.00 owed | CAD 300.00 owed | 3 |

This is explicitly a **historical QBO reconstruction baseline**, not an independent bank witness. Pending activity is unobserved, with no fabricated pending count. Existing statement timing items are separately labelled reconstructed. Bank inflows/outflows are +/−; card charges are negative CSV amounts and payments/credits positive, with the opposite effect on amount owed.

## Acceptance ledger

| Condition | Direct observed proof | Result |
| --- | --- | --- |
| 1. Durable identity, evidenced opening, CAD history/balance and lineage | Actual authenticated account reads return the original package IDs/content hashes, bank123/Sep2023 opening0/closing2129225 with37 rows, and card85/Apr2025 opening20000/closing30000 owed with3 rows. All40 downloaded CSV rows match the original event/revision/row identities and exact native amounts. The card opening anchor and selected carry are visible separately. Historical baseline and unobserved pending activity are explicit. | VERIFIED for the fixed two-account/period slice. |
| 2. Usable desktop overview, account/history/detail/return and states | Actual1440×1000 app overview -> account123 -> month2023-09 and overview -> card85 -> month2025-04; all37 bank rows paginated, all3 card rows inspected. Transaction clicks expose original event/CSV/source identities; Close detail restores row focus for both. Screenshots show loading with retained balance/downloads disabled, genuine quiet card2025-03 empty history, unavailable1999-01 error and return to accounts, then recovery to the selected periods. No horizontal overflow. | VERIFIED. |
| 3. Four real CSV/PDF control downloads | The actual on-screen CSV and statement-PDF controls produced four completed browser downloads: bank1303-byte CSV/13444-byte PDF, card120-byte CSV/2904-byte PDF. Every byte hash matches the retained package table below. All40 CSV rows, signs, event crosswalks and opening+movement=closing pass. Both downloaded PDFs were extracted/rendered and all3 pages visually inspected. | VERIFIED. No service-only or synthetic readiness download substituted. |
| 4. Normal authenticated reload/reopen persistence | Both selected views reloaded and reopened through the running app. Supporting same-origin authenticated GETs returned200 and the exact original package IDs/content hashes, histories, balances and files across two bank/two card observations. Private normal-api-reads.json and financial-and-persistence-checks.json retain the comparisons. | VERIFIED. No component-only state or fixture. |
| 5. Rendered inspection, checks/reviews and Git closeout | Existing backend24/integration10, syntax and independent implementation/safety reviews remain valid: relevant route/account/API source is unchanged. CSS-only contrast correction98ded95 passed frontend build/lint and independent source/final rendered review. Final desktop/card/error/empty/PDF screenshots inspected. Owned browser/controller is inactive/no PID and temporary authenticated profile removed; unrelated sessions preserved. Code is pushed on main/origin/main; this evidence/assignment/task/handoff closeout is committed/pushed at task completion. | VERIFIED. |

## Final actual application evidence — 2026-11-02T05:33:37.024Z

Use the shared app-agent-login helper; no owner password/token, Chrome sharing or CUA restoration was needed. All feature actions ran in owned helper-authenticated agent-browser sessions. Initial native download capture canceled files; the bounded alternative reused the existing check-app-browser.mjs hidden launcher (not its synthetic probe), attached an owned agent-browser session and used the same private helper. Setting the owned temporary download destination through the existing browser connection with native Windows backslashes produced completed real control downloads. No download generator, reader, retained bytes or application download code changed.

Actual bank123 September2023: CAD0 + CAD24,340.90 inflows − CAD3,048.65 outflows = **CAD21,292.25**,37 rows. Actual card85 April2025: CAD200 opening owed + CAD500 charges − CAD400 payments = **CAD300 owed**,3 rows; CSV signs are +300,−500,+100. The Purchase detail shows −CAD500 native amount and +CAD500 debt movement, tied to its original event/row identity.

The complete private evidence is under **artifacts/bank-1/verified-20261102/**: verification-summary.json, download-receipts.json, downloads/, normal-api-reads.json, financial-and-persistence-checks.json, actions-final.json, bank-all-visible-history.json, both transaction-detail records, state-checks.json, screenshots01–11, PDF-content checks and the three rendered downloaded-statement pages. Screenshot/file hashes are retained in the summary. These contain private local evidence and remain Git-ignored; tracked docs contain only the scoped IDs/amounts/hashes required for acceptance.

Only three text/status-color rules changed for actual dark-theme readability; full bank/company future operation was not expanded. The previously retained bank PDF opening-basis sentence is still truncated; its full basis is visible in the app/manifest and all financial rows/totals remain legible. Accepted revision1 files and all native import/reconciliation evidence remain unchanged.

A temporary browser-only delayed-read callback failed after the loading screenshot was captured; its requests had been released and no business data changed. The owned page was restored through the shared helper. Final empty/failure/recovery checks used real retained quiet/missing periods without fabricated persistent data. Earlier canceled-download and callback records remain supporting diagnostic evidence, not successful feature-download claims. Investigation stopped once the four real completed downloads and final states passed; no general browser framework, platform repair or broad test rerun was added.

## Retained opening proof

The opening manifests reference the original retained audit SHA-256 80d14fb4b16ca4107e73abcce40a675227dbfeb8ebc032429613864bf6daecc5. That file was re-hashed and inspected directly. The bank opening derives as zero from its retained closing anchor minus all native book movements, with no pre-September2023 ledger activity. The manifest records that its later mirror cross-check differs; this is not concealed as independent confirmation or current book parity.

For card85, the original April2022 anchor is zero; April2022 has CAD200 of retained card debt movement. The following 35 quiet months carry CAD200 unchanged through March2025, giving the selected April2025 opening CAD200. All 36 preceding monthly opening + movement = closing and adjacent carry-forward comparisons pass. The UI separately shows original anchor month/amount and selected statement opening.

The bank PDF's retained opening-basis sentence is truncated by the existing generator; the full basis is available in the unchanged manifest and the account page. All statement totals, rows, balances and simulation labels remain legible. Accepted revisions were preserved.

## File hashes

| Account/period | CSV SHA-256 | PDF SHA-256 |
| --- | --- | --- |
| 123 / 2023-09 | ccdc95d115bc27b3bb017697e66cea5e82a6968ef2881dc70db01384f27351f9 | c76fecc8b69275cc0f2571bfae7d25459ffaf363bbdd0e3fd85bf29e14316785 |
| 85 / 2025-04 | 217805209f7b8a6f4973ccf0310e274ca8608af4cfcb804c36093003e977325d | 00fec196d1f8faf2c66ba6c1475b159f48cf60fc538a49dd8c3c20fd68dffa54 |

Private local evidence: artifacts/bank-1/selected-files.json, arithmetic-and-lineage.json, durable-service-reads.json, reopen-and-service-downloads.json, PDF page PNGs/text and work-value.json. These are ignored local evidence, not substitute app fixtures. Raw company records and credentials do not enter this tracked record.

## Earlier foundation checks and historical work-value checkpoint

Workers ran node --test test/banking-workspace.test.js and node --test test/banking-integration.test.js from backend/ (24 and10 passes), touched-file node --check, Vite build and ESLint from frontend/ (exit0). An initial integration invocation from repository root failed its cwd-dependent module lookup; correct backend cwd passed. Existing frontend chunk-size and three AICommandCenter hook warnings remain. Hidden Node REPL/child-process execution was used throughout. No persistent service command or live mutation check was run. Two local REPL reopen attempts stopped on a missing binding and cross-realm object-prototype comparison; the final canonical JSON content comparison passed with fresh connections closed after every attempt.

The essential outcome and smallest direct proof are in artifacts/bank-1/work-value.json. That earlier milestone delivered source, durable reads and retained-file evidence while application proof was still pending. The final actual control-download, journey/reload and rendered proof above now completes that missing BANK-1 evidence. Keep full SB01/SB02/D01 OPEN beyond this bounded slice; SB03–SB07 and BANK-2/BANK-3 remain OPEN.

Historical browser capability boundary (superseded for this task by the owner’s explicit isolated-agent-browser authorization): the first-party computer-use tool reports both native pipe and browser host unavailable. Its instruction requires explicit user permission before another UI automation technology is used. The pending question requests the existing headless browser solely for the running app; no fallback automation, app-session minting, credential recovery or new service was used. The exact remaining owner action is to answer that request (or restore the browser tool). Acceptance2 and normal-route portions of3/4/5 remain unverified.

## Historical resumed actual-application attempt — 2026-11-01T23:10:29.629Z

The owner explicitly authorized direct isolated headless agent-browser for localhost:5173, account journeys, four real file downloads and reload/reopen. No Terra task, synthetic readiness check, CUA-host probe, QuickBooks page, owner Chrome profile or desktop-app launch was used.

The direct installed CLI opened a uniquely owned `bank1-verify-20261101-*` session and set desktop1440×1000. Its actual app URL became `http://localhost:5173/login`, showing empty Email/Password fields and Sign in. Before opening the session, `session list` returned no active sessions; `auth list` returned an empty profiles array. No suitable app-state file was found in the repository’s retained artifacts. No credential was read, guessed or submitted, no token was fabricated, and no security/credential setting changed. An auth-profile name or exact app-only saved-state path was requested from the owner; authentication is required before dependent actions.

The running API returned200 with identity test-data-lab and database connected. An anonymous normal-origin account GET returned401 Authentication required. Six selected originals (two CSVs, two statements, two manifests) still match all retained hashes; this is supporting integrity evidence, not download-control proof. BANK-1 account overview/history/detail/return, four actual download clicks and both reload/reopen journeys remain **unverified**.

Private evidence: `artifacts/bank-1/desktop-resume/attempt.json` and `authentication-required.png`. The screenshot was visually inspected and proves only the authentication barrier, never BANK-1 acceptance. No source fix was justified by the sign-in barrier. Existing source reviews and focused checks remain applicable; no broad suites were repeated. Normal business services, data, accepted revisions and native evidence were preserved.

Work-value checkpoint: the existing browser-route uncertainty is resolved for this task; stop tool investigation. The sole dependent step is normal existing Test Data Lab authentication in the owned isolated session (an appropriate saved auth profile or app-only supported state). Keep the four downloads and account proof OPEN until that step is supplied.

Owned-browser cleanup: `close` confirmed closed; supported `session info` then returned active:false and pid:null. The session list retained a stale name, so absence from that list is not claimed. Other sessions were untouched.

## Historical existing authenticated Chrome authorization — 2026-11-01T23:16:40.963Z

The owner reports Test Data Lab is already signed in on Chrome and explicitly authorizes that existing app tab for BANK-1. The earlier isolated-session authentication gap is not a request to sign in again. Current dependency: this session must be able to control that existing tab.

One named owned agent-browser controller attempted supported `--auto-connect --pin-tab tab list`; it returned `No running Chrome instance found. Launch Chrome with --remote-debugging-port or use --cdp.` No Chrome launch, restart, remote-debugging setting, credential access or token transfer was attempted. A direct browser-access inventory exposed no browsers and reported `The browser access host is unavailable`. This was an attachment check, with no host-repair investigation. Read-only existing-session inventory found one reachable default session with no localhost:5173 app tabs; another session metadata read timed out and was not adopted or changed. The failed owned controller was closed; owner/concurrent browsers were preserved.

No account screen, feature download click or authenticated reload was reached. All BANK-1 account-journey/download/reload requirements remain OPEN. Exact next step: expose/share the existing authenticated app tab through a reachable browser connection, or provide an already-enabled CDP port. No further login was requested. Private direct receipt: `artifacts/bank-1/chrome-attach/attempt.json`. Stop attachment investigation at this concrete external dependency; no new framework or security-setting workaround. Existing implementation/checks/reviews remain unchanged.

A final bounded read-only Chrome process-metadata check confirmed running Chrome: one main process has no debugging port/pipe; a separate process has automatic ephemeral debugging port0. The supported inventory still exposed no authenticated Test Data Lab tab. No command lines, profile data or credentials were printed, and no debugging setting or browser process was changed. Attachment discovery stops here; the existing Chrome sign-in is not the requested owner action.

## Shared app sign-in restored — 2026-11-02T00:20:44.353Z

The owner requested permanent local agent app credentials. The same existing account/company now supports automatic private sign-in through [the shared helper](../agent-harness/APP_AGENT_LOGIN.md), documented in AGENTS.md for Codex and Claude. Two fresh independent browsers and one repeated session verified account/company and opened the real bank page. The desktop overview was inspected. No password/token or manual Chrome attachment is needed for normal local agent login.

This removes the prior sign-in/attachment dependency. At that sign-in installation milestone, the selected-period journeys, four feature clicks and authenticated reload remained OPEN. They are now directly verified by the final BANK-1 delivery above.
