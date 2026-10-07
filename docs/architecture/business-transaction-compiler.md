# Business transaction compilation

Implemented 2026-10-06 as an internal pure module. No live execution, saved approved operation, or production acceptance is claimed.

## Inputs and authority

business-transaction-compiler.js accepts the exact saved step, a server-owned approved policy for its content hash and Canadian scope, current reference records, verified originating transactions, and an operation writer observation. It cannot obtain approval by itself and returns authorized:false. No route or AI tool exposes the policy/evidence objects as user-controlled authority.

The future runner must load the approved policy from durable server state and obtain evidence from trusted read adapters. A hash proves consistency of these inputs, not their authenticity. The compiler is deliberately not an approval or baseline service.

Every observed record is bound to company, connection, operation and writer revision. Its canonical timestamp must be within five minutes and not in the future. Exact reference IDs, active status, approved definition hashes and non-regressing versions, CAD party currency, product types and relevant product/control accounts are checked. Dates use the Halifax business calendar. Dates, line quantities and cent amounts are bounded and validated.

The output contains a frozen request plus dispatchEvidence. beginDispatch now requires that complete evidence object: scope, operation, logical activity, intent hash, exact request hash, evidence hash, writer revision and oldest observation timestamp. The concrete writer transaction rejects changed observations before recording dispatch; the common transport checks the subsequent revision and freshness again before admission. A recent snapshot cannot be reused after another coordinated write advances the writer.

## Current activity templates

- Estimates and invoices compile approved sales item quantities and prices. Service invoices link the exact estimate lines and time entry; saved work hours must equal invoiced hours. Time entries use the explicit customer, employee and service item and must match quoted hours.
- Purchase orders and bills compile inventory item lines using an explicit payables account. Full PO conversion requires an open source, no existing bill links, exact source item/quantity/rate/tax lines and an explicit zero Received value on each item line. Missing consumed-quantity evidence blocks conversion. This API field is never presented as proof of the screen-level billed quantity.
- Stock sales require verified received-stock dependencies, matching quantities and sufficient freshly observed inventory. Quantities are aggregated by physical item across all requested lines. Product asset, cost and income accounts must still match.
- Payments and bill payments use the actual saved source total including tax, require the source to remain fully unpaid, match its party/control account and use the chosen bank or undeposited-funds destination. Merchant processing is explicitly disabled.
- Deposits link the originating payment rather than adding another income line. They require a fully applied payment in undeposited funds plus separate current, scoped availability evidence. Missing links alone do not prove availability. The availability adapter must supply its own evidence hash and timestamp.

The initial item templates use an approved TaxExcluded Canadian policy and exact sales/purchase tax code IDs. They do not infer tax rates, exemptions, place of supply or recoverability. Unsupported financial source lines, including discounts, are rejected rather than dropped during full conversions. An exact final subtotal is accepted. Partial conversions, credits, returns, partial settlements and other future templates require explicit implementations.

## Provider references and evidence limits

The current [Invoice reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice) documents non-US global tax calculation and estimate/time links. The [PurchaseOrder reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchaseorder) describes item lines and payable/vendor references. The official [Intuit SDK Line schema](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPLine.php) documents the read-only PO Received field and line transaction links.

[Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment) and [BillPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) references support the linked settlement fields. Older official SDK [TimeActivity](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/TimeActivity.html) and [Deposit account](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/16a2c6a4-b52e-d356-bc8e-732a6eab6e32.htm) references are supplemental schema evidence. These sources do not prove that the complete generated payload is accepted by the connected Canadian company; controlled API acceptance/read-back remains required.

## Remaining integration

No default evidence adapter fabricates approvals, baseline acceptance, deposit availability or inventory state. The operation loader still needs to populate current control-account choices and dependency fingerprints from persisted approved intent. The current read-only preview is not directly executable. Source observations, request compilation, durable dispatch, saved receipts and read-back must be assembled in the runner; full report and calendar verification remain required afterward.

Reference revalidation is implemented in [business-reference.md](business-reference.md): fresh full entity GETs may have newer versions and changed explicitly allowed balances/stock, but their entire remaining scoped definition must match the saved binding. The saved step and approval remain unchanged. Runtime reader resolution and transport cancellation still need integration. External QuickBooks users/integrations are outside the application's writer lock; final read-back and reconciliation must detect their intervening changes. Storage bootstrap, activation and a complete live business period remain unverified.

## Original compilation retention — 2026-10-06

Compiler results now include a hash over the complete defined artifact and pass that artifact with dispatch evidence. The step store saves it atomically before sending; the common writer/admission contract binds the same hash. business-readback.md documents verification against the retained request and relationships. This does not enable the runner or authorize live execution.
