# Approved business reference definitions

Implemented 2026-10-06. Pure definition validation and a fixed full-entity reader; runtime client resolution and live company acceptance remain unverified.

A saved business step must preserve its exact customer, vendor, worker, product, account and tax-code choices. Its original SyncToken alone is insufficient for a continuing business: normal activity changes observed stock and balances. Rewriting the saved step after every such observation would also change its approved fingerprint and break dependent plans.

## Contract

business-reference.js binds each choice to its exact company connection, entity, ID, original canonical SyncToken and version-1 definition hash. The definition includes every returned field, including unknown fields, except these explicitly versioned exclusions:

| Entity | Current numeric observations excluded from the static definition |
| --- | --- |
| Customer | Balance, BalanceWithJobs |
| Vendor | Balance |
| Item | QtyOnHand |
| Account | CurrentBalance, CurrentBalanceWithSubAccounts |
| Employee, TaxCode | None |

SyncToken, read-only MetaData, domain and sparse envelope hints are also excluded. A sparse response is rejected, and excluded numeric observations must be finite numbers when present. The exclusion contract cannot be expanded silently: changing it requires a new supported definition version.

At execution, the original binding remains unchanged. The full current record must retain the same definition, remain active and have a canonical version at least as new as the saved version. New or missing static fields, changed account links, product type, customer/project/parent/currency/tax settings, and unknown changed fields reject execution. Preparation and execution require fresh exact company observations. Missing definition bindings are rejected; older plans are not silently upgraded.

The compiler still requires the exact operation and writer revision, full record hashes, current inventory sufficient for all requested lines, exact party/control-account relationships and separately approved Canadian tax policy. Current dynamic values change its evidence hash, while the saved step, policy and intent fingerprint remain unchanged. The original compiled request remains separately retained by the existing dispatch contract.

This comparison establishes unchanged master definitions, not the cause or legitimacy of a balance or stock movement. External-user changes and business-baseline drift still need read-back and report reconciliation. A TaxCode hash binds that record's own rate references; it does not independently validate the referenced TaxRate percentages, effective dates, place of supply or exemptions. Those still need separate current policy/rate evidence.

## Full reads and provenance

createBusinessReferenceReader has no default client or permissions. Its trusted resolver must return the existing company-scoped QBO client. The reader:

- accepts only the six supported master entities and numeric record IDs;
- checks the exact connection ID, realm, environment-specific API base and active connection before and after the request;
- uses fixed client.read(entity, id), which maps to a full entity GET, with no supplied query, projection or enrichment callback;
- accepts the exact returned entity envelope, clones the complete record, and rechecks the actor before returning;
- returns full-GET provenance bound to company, entity, ID, endpoint and full record hash.

Binding and execution validation require that provenance. A matching query projection without it is rejected even if it contains ID, version and active status. These objects are internal evidence, not authority accepted from public route bodies. The runtime resolver must preserve that trust boundary and not fabricate reader receipts.

The reader discards results on cancellation or after its one-minute return budget. The current QBOClient does not accept AbortSignal; its underlying GET/token refresh or retries may still finish. Network cancellation and bounded transport cleanup remain integration work. The reader itself does not create or edit business records; the existing client's token-refresh persistence is unchanged.

## Evidence

107 focused reference/compiler/plan/read-back/graph tests pass, backend syntax covers 104 files, and diff checks pass. Tests include unchanged intent/request through newer inventory/balance observations, changed evidence hashes, insufficient stock, unchanged-version tampering, account/customer/tax-code definition changes, partial evidence, wrong scopes, version downgrade, full GET shape, actor/connection changes, deadlines and cancellation. Required independent source reviews are clear. These are synthetic fixtures, not live Canadian acceptance or a completed business period.

Intuit documents automatic quantity-on-hand updates from recorded purchasing activity in [Manage inventory](https://developers.intuit.com/app/developer/qbo/docs/learn/learn-basic-bookkeeping/manage-inventory). Its [Account reference](https://developer.intuit.com/docs/api/accounting/account) identifies current balances as returned balance values. The official [Customer BalanceWithJobs reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/a1bbda72-70f2-f792-e813-ed1c868d0496.htm) describes the customer/sub-job open balance; that older SDK reference is supplemental schema evidence. These sources support the distinction between current balances/stock and approved master settings, not a guarantee of live response completeness, timing or company reconciliation.

No live requests, storage setup, company writes, service changes or schedule activation were performed for this slice.
