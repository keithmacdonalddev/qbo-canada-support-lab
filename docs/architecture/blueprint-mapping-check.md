# Business-plan mapping checks

Implemented 2026-10-06. Read-only prerequisite evidence; not activation authority.

The Company page checks the saved draft (or clearly labelled unsaved proposal) against fresh bounded account, tax-code and preference reads. The request accepts only the loaded connection ID and saved content hash. The server derives company/environment and blueprint.read authority, checks the version before observation, and re-reads authority/version afterward. Company switches or concurrent saves invalidate the result. Nothing is saved by this route.

Each role reports unassigned, unavailable, inactive, incompatible, unverified, review_required or compatible. A compatible account is structurally suitable only: its business use, balances and baseline membership remain unapproved. Missing active status is unverified. Inactive returned records remain available to validation but are excluded from selection choices. Duplicate IDs or incomplete lists cannot pass. Inventory and undeposited-funds detail types, receivables/payables control-account types and detail types, and explicitly CAD bank/receivables/payables accounts are flagship-plan policies, not claims about every possible QuickBooks transaction. Missing required subtype or currency is unverified; a conflicting value is incompatible. All 12 roles are validated, including new unassigned roles in older drafts.

Tax codes remain subject to transaction-specific review. An empty rate-list object is not evidence of tax-rate references. Sales and purchase lists are checked separately; even populated references do not establish correct rates, place of supply, exemptions, recoverability, effective dates or Canadian tax treatment. Non-taxable codes without lists are not declared invalid; they require review. The old Intuit SDK reference distinguishes [sales and purchase tax-rate lists](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/f8690620-a042-41fc-ed56-2942c6299ebc.htm). This structural reference is not a tax-policy approval or current Canadian rate source.

The response includes observation timestamp/source hash and exact draft hash. It always declares readyToActivate false because tax policy, reviewed baseline, transaction compilation, complete execution and outcome evidence remain open. Setup reads are bounded but are not a simultaneous database snapshot; a future executor must refresh requirements before writing. The UI cancels requests on unmount/version changes, verifies returned scope, and separates saved choices from unsaved edits.

## Verification

- Luna focused mapping/draft tests: 28/28 pass, including incomplete data, inactive/unknown activity, account type/currency/subtype mismatch, missing/duplicate IDs, malformed tax lists, proposal state, strict inputs and connection/version changes during a request.
- Backend syntax: 86 files pass. Frontend build/lint and diff checks pass, with existing chunk-size, hook and line-ending warnings.
- Independent implementation and safety source reviews: no blocking findings.
- Existing Chrome app, connected Canadian Production company: loading state observed, then CAD home currency and nine unassigned roles displayed. Desktop table and scope banner inspected. No QBO or database writes. Successful saved-mapping checks are covered by isolated fixtures; a live saved draft remains unavailable pending separate storage/owner setup approval.

Whole-app status remains incomplete. This check neither completes historical records nor authorizes production catch-up.

## Control-account completion — 2026-10-06

Added explicit receivables, payables and undeposited-funds choices to drafts, validation, operation preparation and the Company form. Forty-seven focused draft/mapping/operation/master tests pass; backend syntax covers 104 files; frontend build/lint and diff checks pass with existing warnings. Independent implementation and safety reviews found no blockers.

Read-only desktop inspection shows 12 unassigned roles and exact compatible account options for receivables, payables and undeposited funds in the connected Canadian Production company. Loading and the disabled read-only role were observed; the three-column desktop form was visually inspected. No choice was saved or activated. The earlier nine-role evidence above records the prior implementation.
