# Record creation history

Implemented 2026-10-06 as a read-only inspection aid. This does not adopt a business baseline or authorize record changes.

## Evidence contract

GET /api/explore/:entity/:id/origin searches the signed-in workspace owner's saved creation receipts in the server-selected realm and configured environment. The route accepts no caller-supplied scope. It does not call QBO or change storage. Record detail remains a separate QBO read, so unavailable app history cannot hide the current record.

Sources searched: completed successful createRecord AI-plan steps; the four legacy createInvoice/applyPayment/createBill/applyBillPayment tools with fixed output entity types; version-1 generation step receipts; historical generation summaries lacking an environment; seed created-entity logs (both actual lowercase and canonical entity names); issue-pack created-entity logs. Matching uses exact entity plus saved ID within the same array element. Failed, pending, ambiguous and edit/void/delete steps are not creation evidence. A scope-mismatched receipt is excluded.

New reproduction steps persist versioned realm/environment/connection scope from server-owned plan/run state before dispatch. Historical steps are not backfilled from current session state. A generation receipt needs its recorded environment and a connection identifier. Older logs without environment are explicitly historical matches, even if the current session links to a support case. Case links require an owner/realm-matched reproduction session.

Six bounded Mongo aggregations run concurrently with a five-second server execution limit each. Each returns at most 20 sources plus a lookahead. Truncation or failure is explicit; failure does not become a complete empty result. Only source IDs, optional case link/step/date, original business operation/connection identifiers and scope labels reach the frontend. Raw prompts, record input/output and database errors are excluded. Existing collection scans can time out; indexes are not created automatically.

The complete flag means the named receipt searches completed within their bounds. It does not mean the app knows all historical origin, current existence, continued record contents, QBO Audit Log changes, external integrations, or missing/deleted app logs. An empty result is unknown, never an assertion that the record was manually created. A creation receipt is not proof of business plausibility, reconciliation, baseline membership or exclusive ownership. Multiple matches remain visible rather than choosing one silently.

## Desktop behavior and direct evidence

Records shows a separate creation-history section beside record details, with unknown, historical, scoped and incomplete states and retry. Requests are cancelled when the record/company changes. Record panels wait for the connection to be ready, avoiding provisional links into the wrong environment.

A read-only check in the connected Canadian Production company found the original PO reproduction's creation step and correct case link. A payment with no matching receipt showed unknown. The rendered desktop panel fits alongside the record list and line details. No record was created or changed for this check. New scoped receipt persistence is covered by an isolated engine fixture, not a live write. Error/retry behavior is source-reviewed and route-tested; a live database failure was not induced.


## Business operation creation evidence — 2026-10-06

Records also searches saved business QBO transport receipts. The query fixes owner, realm, environment, lowercase entity, create operation, saved outcome and exact observed QBO ID. Each bounded candidate joins its original start and response audit receipts through their exact lookup variables. Shared pure validation now serves both this origin view and the existing dispatch recovery reader; recovery still independently checks its original request and current operations.recover authority.

Origin validation rechecks returned identity rather than trusting the query alone. Receipt identity, response hash/record identity, original actor, both matching compact audits and observation timing must agree. Raw transport responses and audit data never enter the public result. The original historical connection is retained; reconnecting does not turn it into current connection authority. Multiple business creation claims, missing or changed audits, overflow and query errors make this source incomplete. No storage or indexes are created. Queries remain bounded and may report incomplete when storage cannot answer in time.

The frontend labels the source Business operation and shows its original operation identifier. This is creation provenance, not adoption, exclusive managed ownership, current content verification or proof of a complete baseline. Record inspection and the continuing-business classification remain distinct.

Verification: 43 focused origin/query/dispatch cases passed, including receipts produced by the original simulated dispatcher composition. Independent review caught an incorrect Mongo lookup-variable reference; the corrected origin suite passes 14 cases with an exact pipeline regression. Both changed backend modules passed syntax; frontend build/lint pass with existing chunk-size and AICommandCenter hook warnings. Both implementation and safety source reviews are clear. Real Mongo aggregation and a real new business-operation record remain unverified; no live company/database writes or service changes occurred.

Read-only desktop follow-up: the connected Production Records page loaded its invoice list and Invoice 592 detail. The creation-history panel displayed the existing historical assistant receipt, alongside the explicit unclassified-baseline statement, without obscuring record details. This confirms existing history rendering after the change; it does not validate a new business-operation receipt or its Mongo lookup against live data.
