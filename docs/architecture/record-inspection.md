# Record inspection

Updated 2026-10-06. Read-only inspection is a verification tool; it does not maintain or reconcile the business by itself.

The Records page now pages through the supported entity types with date filters for transactions and explicit all/active/inactive choices for lists. Search remains restricted to each entity's supported document/name field. Inputs are bounded; record IDs and entity types are validated before QBO dispatch. Query strings escape user text and reject unsupported options. Each page uses a unique Id secondary order and one lookahead row to identify the next page without a separate count request.

The query syntax follows Intuit's published [query guidance](https://medium.com/intuitdev/building-smarter-with-intuit-supercharge-your-queries-fde9d771f8fd) and [query limits](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html). Actual Canadian Production reads verified compound date/Id and name/Id ordering. Pagination is live rather than a database snapshot: concurrent record changes can move records between pages. The page states this limitation and offers a restart from the first page.

Results carry server-owned realm/environment/connection metadata. Frontend list/detail state is remounted across actor/company/environment/readiness changes. Superseded list reads are aborted and ignored; mismatched scope is never rendered as current results. Failed reads remain errors rather than empty successes. Invalid ranges can be corrected without leaving the page.

Record detail validates the returned entity and ID. The chain reader canonicalizes aliases, preserves source and target line IDs on exposed line links, caps reads at 40 records and edges at 1,000, and stops new dispatches after 60 seconds. Errors and truncation make its result incomplete. It follows exposed outbound links, not reverse queries; neither a graph nor transaction-level links prove PO/bill line quantity reconciliation. The UI now calls raw output fields returned by QuickBooks rather than all fields QuickBooks stores.

## Direct evidence

In the connected Canadian Production company, two invoice pages returned 50 and 43 distinct IDs with no overlap. September filters returned four invoices. Inactive-customer filtering returned five inactive records; the all-status list contains 51 compared with 46 active customers. Company summary labels now identify active list counts. An invalid date range displayed its validation error, and correcting it recovered the four matching records. Invoice-to-payment navigation loaded actual details and supported returning to the previous record.

These were read-only browser checks. No business records were created or corrected. Tests cover query validation, lookahead paging, tied-date boundaries, source scope, QBO error mapping, invalid paths, aliases, explicit incomplete graphs and budgets. Independent implementation and safety reviews are clear after the unique-order and alias fixes. Current-source final test/build checks are recorded in the task handoff.

## Remaining inspection work

Managed provenance and deliberate support-record classification, broader administration controls, unsupported/manual-only entities, reverse-relationship evidence and complete report/reconciliation integration remain outstanding. Browser success on the sampled entity types does not establish all entity/locale permutations.
