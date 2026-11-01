# BANK-1 delivery evidence — 2026-11-01

Updated: 2026-11-01T23:10:29.629Z. Status: **AUTHENTICATION BLOCKED / DIRECT APPLICATION PROOF OPEN**. BANK-1 remains incomplete; no BANK-2/BANK-3 completion is claimed.

The canonical checkout is C:\Projects\qbo on main, configured upstream origin/main. Frontend commit 0281720 and backend commits 1d8d24f and 2871cef are pushed. Normal business services were left running; no explicit service control, QBO call, persistent database write, storage preparation, accepted-file change or native banking action was performed by this BANK-1 work.

## Fixed acceptance selection

Production connected company ending 2856; existing CAD accounts selected from real provisioned inventory, with retained activity rather than empty convenience examples:

| Account | Period | Retained package revision | Opening | Movement affecting balance | Closing | Rows |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Bank 123, Operating bank | 2023-09 | a86a4c4ff040c2ffed87384754e044446b8f8835433df3a5fd106a2c5a8abe65 / 1 | CAD 0.00 | CAD +21,292.25 | CAD 21,292.25 | 37 |
| Credit Card 85 | 2025-04 | 87d08dcbc5ffd16ed2fce19f1aa15c206b4e711c067af9d53d79b48c32338a33 / 1 | CAD 200.00 owed | CAD +100.00 owed | CAD 300.00 owed | 3 |

This is explicitly a **historical QBO reconstruction baseline**, not an independent bank witness. Pending activity is unobserved, with no fabricated pending count. Existing statement timing items are separately labelled reconstructed. Bank inflows/outflows are +/−; card charges are negative CSV amounts and payments/credits positive, with the opposite effect on amount owed.

## Acceptance ledger

| Condition | Observed result | Status / remaining proof |
| --- | --- | --- |
| 1. Durable account identity, CAD, evidenced opening, history, derived balance, stable lineage | Read-only Mongo inspection found existing bankingevents/bankingpackages and 208 registered periods. The production account service, without injected persistence, passed current company/membership checks and returned 12 account summaries and both selected histories. All 40 selected rows match source account/transaction/date/native amount, stable event/revision and row crosswalk. | State and retained arithmetic verified. This does not establish independent future bank operation. |
| 2. Usable desktop overview/detail/transaction/return and states | Source adds protected /company/bank, sidebar Bank, fictional Maple Harbour Bank, account cards, dated balances, month picker, transaction detail/focus return, loading, empty, error/retry and missing-evidence labels. | Authorized direct isolated agent-browser reached the actual app but redirected to /login. No reusable authenticated session or saved auth profile was available. Account interaction remains unverified pending normal app sign-in. |
| 3. Actual CSV/PDF downloads, exact signs/arithmetic/lineage/hashes | Retained CSV/PDF/manifest hashes all match. Reusing the existing CSV generator reproduces both CSVs byte for byte. Bank: 0 +24,340.90 inflows −3,048.65 outflows =21,292.25. Card: 200 +500 charges −400 payments =300 owed; CSV rows +300,−500,+100. Original PDFs rendered and all three pages inspected. | Retained artifact contents verified; all six original files re-hashed unchanged on resume. Zero actual feature downloads: controls remain behind normal app authentication. |
| 4. Reload/reopen same durable state/artifacts through normal app | Data already exists in provisioned MongoDB and retained hashed files, not UI fixtures. No migration/write needed. | A fresh MongoDB connection and fresh production service returned the exact same package IDs, content hashes, all 40 event payloads/transactions and balances. All four downloads through the production download service matched retained hashes. Normal authenticated HTTP/browser reload/reopen remains unverified; the fresh unauthenticated account request correctly returns401. |
| 5. Actual desktop/artifact inspection, checks, independent reviews, commit/push | Distinct harness-reviewer and harness-security-reviewer completed; no remaining material source findings. Excluded-row status correction rechecked. Workspace24/24 and integration10/10; touched backend syntax; frontend build/lint; diff checks pass. Code pushed. Readable transaction labels reuse the exact CSV formatter (2871cef), independently re-reviewed. | Account desktop proof still open. Prior source checks/reviews are reused: git diff dc097f6..HEAD shows no changes to the reviewed BANK-1 implementation. |

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

## Checks and work-value checkpoint

Workers ran node --test test/banking-workspace.test.js and node --test test/banking-integration.test.js from backend/ (24 and10 passes), touched-file node --check, Vite build and ESLint from frontend/ (exit0). An initial integration invocation from repository root failed its cwd-dependent module lookup; correct backend cwd passed. Existing frontend chunk-size and three AICommandCenter hook warnings remain. Hidden Node REPL/child-process execution was used throughout. No persistent service command or live mutation check was run. Two local REPL reopen attempts stopped on a missing binding and cross-realm object-prototype comparison; the final canonical JSON content comparison passed with fresh connections closed after every attempt.

The essential outcome and smallest direct proof are in artifacts/bank-1/work-value.json. This milestone delivered usable source, real durable reads and exact retained-file evidence. Independent work continued while the browser capability boundary remained open; no historical repair or new banking framework was attempted. Next proof: authorized existing headless browser against the running localhost:5173 app, normal authenticated account selection/transaction/return/download/reload, desktop states and artifact hash comparison. Keep full SB01/SB02/D01 OPEN beyond this bounded slice; SB03–SB07 and BANK-2/BANK-3 remain OPEN.

Historical browser capability boundary (superseded for this task by the owner’s explicit isolated-agent-browser authorization): the first-party computer-use tool reports both native pipe and browser host unavailable. Its instruction requires explicit user permission before another UI automation technology is used. The pending question requests the existing headless browser solely for the running app; no fallback automation, app-session minting, credential recovery or new service was used. The exact remaining owner action is to answer that request (or restore the browser tool). Acceptance2 and normal-route portions of3/4/5 remain unverified.

## Resumed actual-application attempt — 2026-11-01T23:10:29.629Z

The owner explicitly authorized direct isolated headless agent-browser for localhost:5173, account journeys, four real file downloads and reload/reopen. No Terra task, synthetic readiness check, CUA-host probe, QuickBooks page, owner Chrome profile or desktop-app launch was used.

The direct installed CLI opened a uniquely owned `bank1-verify-20261101-*` session and set desktop1440×1000. Its actual app URL became `http://localhost:5173/login`, showing empty Email/Password fields and Sign in. Before opening the session, `session list` returned no active sessions; `auth list` returned an empty profiles array. No suitable app-state file was found in the repository’s retained artifacts. No credential was read, guessed or submitted, no token was fabricated, and no security/credential setting changed. An auth-profile name or exact app-only saved-state path was requested from the owner; authentication is required before dependent actions.

The running API returned200 with identity test-data-lab and database connected. An anonymous normal-origin account GET returned401 Authentication required. Six selected originals (two CSVs, two statements, two manifests) still match all retained hashes; this is supporting integrity evidence, not download-control proof. BANK-1 account overview/history/detail/return, four actual download clicks and both reload/reopen journeys remain **unverified**.

Private evidence: `artifacts/bank-1/desktop-resume/attempt.json` and `authentication-required.png`. The screenshot was visually inspected and proves only the authentication barrier, never BANK-1 acceptance. No source fix was justified by the sign-in barrier. Existing source reviews and focused checks remain applicable; no broad suites were repeated. Normal business services, data, accepted revisions and native evidence were preserved.

Work-value checkpoint: the existing browser-route uncertainty is resolved for this task; stop tool investigation. The sole dependent step is normal existing Test Data Lab authentication in the owned isolated session (an appropriate saved auth profile or app-only supported state). Keep the four downloads and account proof OPEN until that step is supplied.

Owned-browser cleanup: `close` confirmed closed; supported `session info` then returned active:false and pid:null. The session list retained a stale name, so absence from that list is not claimed. Other sessions were untouched.
