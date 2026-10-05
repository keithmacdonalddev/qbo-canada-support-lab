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
