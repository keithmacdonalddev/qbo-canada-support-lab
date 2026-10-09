# Autonomous reproduction cases — 2026-10-05

## Owner-approved behaviour

Connecting a company establishes its use as the lab. Submitting a reproduction case authorizes the work needed for that case, including production. The operator describes the issue once; the agent finds setup, creates its test records, performs supported edits/voids/deletions, reads the results, and reports evidence. There is no per-plan or typed production approval in this workflow.

This supersedes the October 2 proposal-and-approval behaviour for Reproduce. Legacy AI plan execution keeps its existing flags and approvals. Connecting alone does not launch work. Company scope remains visible and the operator can stop a run.

## Implementation

- POST /api/ai/reproduce receives the message, unique submission ID, displayed realm/environment and optional case session ID. Authenticated company scope and reproduction.run permission are checked on the server.
- reproduction-runner.js pins connection, realm, environment and initiating actor. It stores the submitted authorization, claims one run atomically, and starts a background task. Closing the case page does not cancel execution.
- reproduction-engine.js supplies existing internal read/create/update/void tools plus defineCase, deleteRecord, checkCase and finishCase. Returned record and line IDs support dependent actions without placeholders or additional user turns.
- AISession.reproduction holds progress, conditions, owned record IDs and checks. AIPlan steps are the durable operation receipts. No startup migration or live database preparation was performed for this change.
- Case.jsx polls progress and displays the actual operations and evidence. Background facts in a prompt are no longer presented as separate unfinished tasks. Previously proposed changes are superseded when an old case is continued; they are not silently executed.
- Codex and Anthropic use the same internal execution contracts. Codex bridge closure revokes queued calls and drains an in-flight operation before reporting the run stopped.

## Scope and failure handling

Create test-specific customers and vendors. Modify, void, delete and transaction-link only records created by the case. Existing accounts, taxes and service items can be reused. Existing inventory/bundle items are refused to protect unrelated stock. Nested customer/vendor/entity/parent and transaction references are checked; an update cannot hide its actual payload behind a second payload field.

### Owner-approved deletions and voids of existing records

Added 2026-10-05 at the owner's request ("I should be able to approve it"). When a request explicitly asks to delete or void a specific transaction that existed before the case (for example a duplicate bill), the agent calls deleteRecord or voidTransaction once. reproduction-engine.js does not send it: it re-reads the record, saves a pending step with `approval.state: needed`, the record's SyncToken and a display snapshot (number, party, total, balance, date, entry time), audits the request, and tells the agent to continue without it. An unaudited request is retired, unsupported types are refused and repeated requests reuse the waiting step. Edits of existing records remain refused: an approval card cannot yet show a field-by-field change, so the owner could not see what they approve.

The case page lists these under "Needs your approval". POST /api/ai/sessions/:id/approvals ({ planId, stepNumber, decision }) is handled by reproduction-approvals.js:

- Only the company owner (the account holding the connection) decides; shared-company members, including a coding agent's account, get 403.
- A decision takes a 20-minute session lock that requires the case not to be running in this process and not holding a live lease (an interrupted run whose lease lapsed counts as not running). Only the decision that took the lock releases it. startCase refuses to start a run while the lock is held or a step is being decided.
- The step is claimed atomically, so it runs at most once, and every later write is conditioned on that claim. A decision abandoned by a crash or reload is examined after 20 minutes: if nothing was sent it is offered again; if it may have reached QuickBooks it is marked unknown, the case outcome becomes unknown, and it is never sent again.
- Approval re-reads the record. If its SyncToken differs from the proposal, or QuickBooks reports it not found, nothing is changed and the step is marked stale. Any other connection or read failure leaves the request waiting.
- Deletion uses the entity delete operation with the approved Id/SyncToken and requires a deletion receipt. A void runs through the internal handler pinned to the approved version.
- An unconfirmed QuickBooks result marks the case outcome unknown. Decisions, attempts and results are audited under the acting user.
- The legacy plan approve/reject/execute routes refuse any plan containing these requests.

Before editing a record, re-read it and validate its relationships. Use that validated SyncToken; a concurrent edit must conflict instead of silently accepting new relationships. No payment processing, outgoing messages, raw model-selected endpoints, company preference tools or arbitrary shell/browser tools are available.

Each write is durably recorded and audited before sending. A successful response is saved before the next operation. An unknown external write result stops the run and cannot be replayed automatically. A definite validation failure can be corrected within the same run. Stop requests are preserved across concurrent progress saves; already sent writes finish and retain their receipts.

A recovered run preserves its original connection/environment, waits for its prior execution lease to expire, rejects unresolved writes, reconstructs owned records from confirmed receipts, discards previous checks and recalculates the revision. It does not silently restart on backend startup. A continuation is explicit because an interrupted run is no longer actively executing.

Limits: 160 tool calls, 60 attempted writes, three provider passes and a 12-minute between-call deadline per run; 200 operation receipts per case; bounded payload/check evidence storage. The current provider call itself can continue until its own timeout. These are containment limits, not guarantees of scenario coverage.

## Evidence and honest results

The model records complete symptom conditions before writes. checkCase freshly reads case-owned QBO records; the server extracts field values and evaluates comparisons. Missing fields are unavailable, never zero. Final conclusions need current checks at the latest write revision for every condition.

- Reproduced: all defined conditions passed.
- Not reproduced: all conditions were observed, and at least one did not match in the tested sequence.
- Unverified: evidence was unavailable, stale, incomplete, or execution stopped.

The model still chooses the conditions and sources. Server validation cannot guarantee that those choices faithfully represent every nuance of the user's issue.

There is no QBO screen observation, internet research or Audit Log tool in this runner. For the 6-hour PO / 5 billed / 3.5 visible bill-hours case, it can attempt edit histories and inspect available line data, but API quantities alone cannot prove the billed quantity displayed on the PO screen. It must not force a discrepancy by editing a derived billed/closed value or claim that setup proves reproduction.

QBO transaction deletion uses the internal client with the entity-specific delete operation and current Id/SyncToken, and requires a returned deletion receipt. See the official [PurchaseOrder API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchaseorder) and [Intuit SDK delete implementation](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/DataService/DataService.php). Listing an entity in the tool is not proof that a particular company or transaction will accept the operation; validation errors remain visible.

## Verification boundary

Focused non-live tests cover multi-bill PO setup and quantity edits, generalized invoice conditions, saved IDs, missing/stale evidence, write isolation, stop races, duplicate submission, interrupted recovery and provider bridge shutdown. Independent implementation and safety source reviews found no remaining blocking findings on October 5. Desktop inspection used the running local app and temporary data-only fixtures for progress, stop, result, error, empty and record-detail states; the temporary files were removed.

No live provider-driven QBO reproduction has been run as part of this implementation. The exact PO discrepancy and broad real-world scenario coverage remain unverified. Live verification is a separate coding-agent action governed by AGENT_WORKFLOW.md and the project's explicit target/approval rules; product case authorization does not itself authorize a coding agent to start services or submit live test cases.

Final non-live verification: 125 backend tests passed; backend syntax checked 67 JavaScript files; frontend build and lint passed; git diff whitespace validation passed. Existing frontend hook-dependency warnings (three in AICommandCenter.jsx), a Vite large-chunk warning and Git line-ending conversion warnings remain. Commands ran through the assigned GPT-6 Luna low runner using hidden child processes; no service startup or live writes occurred.


## October 5 live-run corrections

A completed live case exposed two local defects: root QBO MetaData.LastModifiedByRef blocked edits during saved-record validation, and a later successful PO-line-ID comparison hid an earlier failed quantity comparison under the same condition.

Saved-record validation now excludes only root read-only MetaData. The original record and SyncToken remain intact for the guarded operation. Outgoing MetaData is refused; accounting links, nested references and shared-inventory checks remain enforced.

Evidence is grouped by distinct sources, comparison and expected value. Every established measurement must be available and current before the condition can pass. A passing line-ID check cannot hide a failed quantity check, and changing the expected value cannot erase failure. Rechecking the same measurement refreshes its evidence. Reaching the evidence limit stops with an unverified result without discarding prior checks. The read endpoint also applies this grouping to historical cases without rewriting saved data.

The case screen shows separate quantity and relationship comparisons, and offers Continue reproduction for an incomplete result with no unknown write outcome. The continuation explicitly reuses saved records. The actual existing result was inspected on desktop: quantity 5 versus expected 3.5 is shown as not matching while its line link is shown separately as matching.

Conservative limit: choosing a different evidence path does not silently replace a prior unavailable measurement. A mistaken path may therefore leave the case unverified even after another path succeeds. An explicit, auditable evidence-replacement design is deferred; genuine unavailable screen evidence must not disappear merely because another field can be read.

These corrections have not retried the live bill edit or changed QBO/database records. Live continuation remains separate from code validation.

### Model timeout continuation (2026-10-05)

A positively identified model-provider timeout can continue within the same run without another user click. The Codex bridge is revoked and drained first; saved operation receipts and current company/actor/Stop state must reconcile before another model pass. Generic upstream 504s, ambiguous QBO writes, failed persistence/audit and lost authority do not qualify. Completed tool calls are not replayed. Each new pass receives saved records, operations, checks and a bounded optional planning checkpoint.

The run keeps shared call/write and twelve-minute budgets across at most six model passes. Two consecutive timeouts without new saved changes/checks stop the run. The last ninety seconds, last model pass, last twenty calls, or exhausted write budget reserve work for reads, checks and finalization. A time check immediately before sending a write prevents slow preflight work from consuming the verification reserve. After eight transaction changes the agent must inspect the changed records and referenced case transactions and record a comparison before more writes. These controls encourage complete experiments; they cannot make an unavailable QBO screen field observable or guarantee a product defect can be reproduced.

The UI shows automatic continuation and optional saved planning notes. Ledger group counts describe actions (including edits and failures), and do not sum successive versions into a misleading transaction balance. Interrupted backend processes still require explicit recovery; automatic model continuation does not restart services or retry uncertain external operations.


## Read-only screen evidence (2026-10-05)

The assistant now has a fixed checkScreen tool for case-created purchase-order quantities, with separate billedQuantity and receivedQuantity requests. The first browser adapter and the installation instructions live in [the Chrome companion](../../extensions/qbo-screen-reader/README.md). The case page brokers requests and displays the connection state and saved labelled observations. This is separate from API checkCase evidence. Missing screen access stays unverified; API Line.Received is never silently relabelled as UI Billed.

The reusable broker binds a short-lived single-use capability to owner/actor, run, realm/environment, PO and case revision, checks active authorization during waits and receipts, and rejects stale data. The companion redeems this capability directly with the local server before navigation. No model-provided selectors, code, credentials or arbitrary browser actions are supported. Version 0.2 uses persistent access limited to the QBO hosts and automatically creates its own Home tab after capability authorization; user interaction makes that tab ineligible for later reuse. The saved observation includes labelled line values and time, not a full-page dump or screenshot. A fresh QBO record read before/after capture rejects concurrent PO changes. This is client-observed evidence, not independent server attestation of QBO's UI.

The first adapter only supports English item-based PO tables and a recognised Company ID information dialog. Live Canadian DOM compatibility and automatic browser reconnection must be verified after one-time installation/update; unit/DOM fixtures alone do not establish those outcomes. Other screens need explicit adapters. A case page must remain open for this companion transport; server-only cases still complete supported API work and state the screen limitation.

Research basis: [Intuit's IPPLine definition](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPLine.php) describes Received as amount/quantity received depending on line type and read-only for POs. It does not establish equivalence to the Canadian screen's Billed column. [Intuit's Canadian education lesson](https://digitalasset.intuit.com/render/content/dam/intuit/ic/en_ca/content/Intuit-education-program-ca-qbo-lesson-10-2025.pdf) lists open-PO reports in the product; that does not establish a Reports API endpoint for the exact billed-quantity field. No supported public API/report route for this exact value was verified in this investigation. [Intuit Canada documents the Company ID shortcut](https://quickbooks.intuit.com/learn-support/en-ca/help-article/customer-company-settings/find-quickbooks-online-company-id/L7lp8O9yU_CA_en_CA) used by the fixed identity reader. These findings do not prove that no such API exists.

Verification for this addition: the focused reproduction suite passed 66/66 before the final two screen-boundary regressions; the final screen suite passed 14/14 including those additions. Backend syntax (70 files), extension syntax, frontend build/lint and diff whitespace checks passed. Build has the existing large-chunk warning; lint has three existing AICommandCenter dependency warnings. Independent implementation/safety source reviews covered the companion boundary. The disconnected setup panel was inspected in the existing desktop Chrome app. Installation, actual QBO screen capture and resulting live case comparison remain pending; no new live QBO mutations were performed for this feature.

### October 6 live compatibility check

The companion is installed and the app observed its enabled-tab connection. Direct browser inspection of the existing combined-test PO showed ordered quantity 6, three linked transactions and RECEIVED 3.5. This is a Received observation, not evidence of a Billed-labelled field. The actual Canadian Company ID dialog title (Company ID and keyboard shortcuts) and Your Company ID is text are now supported. Received and Billed use separate request fields, label validation and evidence paths; an unavailable Billed observation remains unavailable even when Received passes.

The focused reader/broker/engine suite passed 47/47 after these changes; syntax, frontend build/lint and whitespace checks passed with the existing warnings. Independent implementation and safety reviews found no blocking source findings. The latest live automatic checks still returned PO readiness failure and an invalid receivedQuantity request with the installed older background worker. Extension reload and successful saved automatic capture remain the acceptance gate. These checks changed no QBO records.

### Automatic companion connection (2026-10-06)

At the owner's request, version 0.2 replaces temporary activeTab enablement with exact production/sandbox QBO host permissions. The toolbar no longer selects or authorizes a tab. Permission status is connection readiness only; the server capability and Company ID checks still authorize each observation. A capture creates its own inactive tab in the existing Chrome profile; a clean owned tab is reused but navigated afresh for every capture. Closed, manually navigated or interacted-with tabs are abandoned without modifying or closing them. Session ownership is not persisted across extension/browser reload, so a later capture can create a new reader tab automatically.

Install/startup reattaches the versioned bridge to existing localhost app tabs, removing the normal app-refresh step. Old-protocol responses are ignored. Trusted button and keyboard interaction joins input/change protection; page-reader errors return as controlled failures rather than uncaught script errors. Loading and response deadlines now reserve time for identity checks and receipt delivery. The case panel describes automatic connection and one-time site permissions.

Outcome gate: source and lifecycle fixtures can establish no-toolbar behavior, isolated tab recovery and fresh same-PO navigation. Actual Chrome loading of version 0.2 and automatic saved QBO screen evidence remain unverified until the installed extension is updated; no QBO transactions were changed for this work.

Verification for automatic connection: 51 focused broker/reader/engine tests passed, including restart/reload lifecycle, edited-tab preservation, button-only interaction, repeat-PO refresh and bridge replacement. Extension syntax, frontend build/lint and diff checks passed with existing warnings. Independent implementation and safety reviews found no remaining blocking findings. Desktop inspection confirmed the updated panel and its disconnected state with the older installed extension. Actual version 0.2 permission acceptance, reconnection and saved live screen observation remain pending.

Live follow-up: after the owner reloaded version 0.2, the existing app page changed to Automatic screen checks ready without an ON click or page refresh. An authorized read-only run automatically created reader tabs, but returned unavailable Company ID and PO-number observations before those fields were later visible in direct browser inspection. Reconnection is observed; saved automatic quantity capture remains unverified. Readiness handling now retries the fixed identity shortcut while the app initializes (bounded to 15 seconds and the capability deadline), and waits longer for PO fields within the same deadline. The focused reader suite passed 9/9, syntax and whitespace checks passed, and independent implementation/safety reviews found no new blockers. The installed worker must load this readiness correction before the next live acceptance check. No QBO records changed.

Live capture acceptance: the automatic companion returned a saved observed_screen receipt for the existing combined-test PO: exact column RECEIVED, displayed and numeric quantity 3.5, ordered quantity 6. The case displayed Matched and Saved screen evidence (1) at its unchanged revision. The separate Billed column remained unavailable; this does not prove the original 5-billed discrepancy. No QBO records changed. Initial cold-page readiness still required a follow-up, so the inspector now retries at most once for an exact readiness-error allowlist, using fresh PO reads, a new capability and renewed authority checks. Wrong company, user interaction, unsupported column and Stop do not qualify. Only redeemed responses renew connection readiness. Evidence includes captureAttempts. Focused screen/engine tests passed 45/45, module syntax and whitespace checks passed, and independent implementation/safety reviews found no blockers.

Foreground-rendering correction: later repeat checks remained unreliable despite bounded retries. A direct companion diagnostic returned Tab: hidden; labelled value: missing; PO control: missing, while inspecting the foreground PO showed the correct field and earlier foreground observation returned RECEIVED 3.5. The reader now briefly activates only its own tab in the initiating app window before refreshing/capture. It restores the previously selected tab only if the reader is still active, no user interaction occurred, and no activation event happened during cleanup. Foreground rendering is an authorized part of the automatic check even for a background case; the previous selection is restored rather than forcing the case page. Unknown interaction state after an early failure conservatively leaves the current tab in place. It does not override a later user tab choice. This corrects the initial inactive-tab design above. Loading this extension change and verifying repeated automatic captures remain pending; earlier successful Received observation is historical evidence, not proof of reliable capture or of the Billed discrepancy.

Foreground-reader live acceptance (2026-10-06): after the owner reloaded the corrected extension, a read-only case run performed two consecutive automatic screen checks of the existing combined-test PO. Both returned exact label RECEIVED, text/numeric value 3.5, and passed the expected 3.5 at unchanged revision 38. The rendered case showed Matched and an expanded saved receipt with 6 ordered / RECEIVED 3.5. The second check followed a fresh PO navigation. No ON clicks, manual tab selection or QBO mutations occurred during this verification. The app retained a separate unavailable Billed measurement and an unverified discrepancy result. Automatic reconnection and repeated Received capture are observed; a Billed-labelled field, other layouts, and the original extra 1.5-hour symptom remain unverified.

## General agent and Codex tool guard (2026-10-08)

A live case ("create an owner's distributions account and transfer $40,000 to it for April 21, 2026") made zero tool calls across six model passes. Cause: Codex CLI 0.161.0 marks gpt-6.1-sol `supports_search_tool`, which defers every MCP tool behind `tool_search`; our isolated runs exposed none of the app's tools. The stripped catalog now sets `supports_search_tool=false` (and `node_repl_disabled=true`). `codex-cli.verifyToolAccess()` runs a dummy-tool probe once per Codex binary/model/isolation settings (pass cached 24 h) and the runner stops a Codex case before any model pass if tools are not reachable. `GET /api/ai/config?verifyTools=true` refreshes it.

The owner rejected scenario-specific prompting. The system prompt and tool descriptions are now general: a request may be data to build and inspect or a symptom to observe; building exactly the requested data is often the whole job. New: `askOperator` (ends the run as `needs_input`; the reply continues the case), outcome `completed` (built and verified, same evidence rule as `reproduced`), `checkReport` (report cell evidence), saved `agentReplies` and `toolTrace`, a zero-tool-call pass ends as `needs_input` instead of looping, company-local (Toronto) "Today", the provider pinned per run, Anthropic retries/16k output/stop_reason handling, read-only reference fields (terms, tax codes, ItemAccountRef, sub-account parents, JE Entity.Type), safe line updates (`replaceAllLines`), search filters/paging/apostrophes, report filters/paging, Preferences/CompanyInfo reads, definite classification of token-refresh/storage failures, immediate interruption of runs owned by a dead process, and `POST /api/ai/sessions/:id/reconcile` (read-only; resolves unknown write outcomes so a case can continue). Model passes: up to six per run (the earlier "three" above is stale).

Regression check: `node scripts/agent-eval/run.js --all` runs the real model against an in-memory simulated Canadian company (no QBO, no MongoDB) across diverse scenarios. Run it after any prompt, tool, provider or Codex change.
