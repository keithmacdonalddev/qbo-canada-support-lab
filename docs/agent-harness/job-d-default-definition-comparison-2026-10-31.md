# Job D: authenticated provider-default definition comparison

Prepared on main/origin/main; intentionally uncommitted and unpushed at the owner's request. No service-control commands, QBO API calls, or MongoDB writes. Read-only MongoDB connections were closed. Job X-owned files were not edited.

## Finding and direct proof

Operation 2bb2bd8194d01a1239285eca, Estimate step 6ae67cbb10ae4dae8c6c89c9, failed before dispatch on Item 47 (field-service-hour). Its retained approved v2 definition hash is ce28f388a339e8598e01f89b55442eac27ed660a65e9f5fc90ec8f54eb803c82; the stored failing observed hash is fa60d2d15137d22808cd0ae6ae26e33058b81f310f2c9fd9d00dcd1c3c731d99. Both versions were SyncToken 0. The retained Item actually omits DeferredRevenue; diagnostics represent that missing approved value as null.

All four retained reference rows (Account 124, Customer 121, Item 47, TaxCode 16) reproduce the original immutable approved hashes. Adding DeferredRevenue:false to the exact retained Item reproduces the recorded failing observed definition hash. The before replay through compileBusinessTransactionWithDefinitions fails with BUSINESS_REFERENCE_UNVERIFIED and precisely DeferredRevenue approved:null/current:false. After replay through the same runtime compiler succeeds as Estimate without modifying the stored intent, policy, references or approved hashes. Transport is never invoked.

The observation envelopes and freshness timestamps are reconstructed offline around stored rows. This is a hash-authenticated reconstruction of the failing definition, not a captured raw live GET or proof of dispatch.

## Changes and audit decisions

- business-reference.js: preserve existing v1/v2 hash generation; allow canonical fallback for both versions and Customer/Vendor as well as Item/TaxCode only after the retained record matches the exact original versioned hash. Replace blanket recursive false/null/empty removal with entity-specific top-level flags. For those flags only, absent/null/false compare equal; true, malformed values, unknown fields and nested values remain distinct.
- Audited current mirrored boolean fields: Item DeferredRevenue, SalesTaxIncluded, PurchaseTaxIncluded, TrackQtyOnHand, SubItem, Taxable, PrintGroupedItems; Customer Job, BillWithParent, IsProject, Taxable; Vendor Vendor1099, T4AEligible, T5018Eligible; TaxCode Hidden, Taxable, TaxGroup. Active and sparse remain full-record eligibility checks; TaxRate has no additional boolean in the observed mirror. This is an explicit allowlist, not permission to ignore future fields. Intuit's [Item field meanings](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/850f7b3b-9e8b-679d-9389-6a487f859b39.htm) and [TaxCode reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/TaxCode) informed the audit; observed boolean values alone do not prove default semantics. Prices, rates, account/reference destinations, strings, null unknown fields and empty collections stay exact.
- business-transaction-compiler.js and business-observation-store.js: retrieve original authenticated witnesses for both definition versions and all four supported list entities. Current evidence, company scope, ID, full-record validation, freshness, original hashes and cancellation remain enforced.
- business-added-roles.js: try both retained hash versions for list witnesses. The authenticated witness supplies the minimum accepted SyncToken; a 9-to-8 regression is refused. Creation receipt/audit/completion authentication remains intact.
- business-tax-policy.js: validate complete active current/original tax objects and original raw source hash, then use the same strict canonical comparator. Rates, history, applicability, agency/account destinations and versions remain bound.
- Added backend/test/business-definition-defaults.test.js, covering every allowed flag across absent/null/false pairs and both hash versions; true and malformed values; unknown/nested changes; missing/tampered/foreign/future witnesses; compiler lookup; retained reader; added-role version regression; tax sources.

Independent read-only implementation and safety reviews completed. Safety review caught the role-witness version floor gap during scratch preparation; it was fixed, regression-tested and re-reviewed before any source save. No remaining concrete findings.

## Verification and saved state

Five backend/src files saved once in one locked batch: 2026-11-01T00:42:11.729Z through 00:42:11.732Z. Locks released. Scratch tests passed before the batch; saved-source tests and exact-row replay passed afterward.

From backend/:

```text
node --test test/business-definition-defaults.test.js test/business-reference.test.js test/business-reference-runtime-r3.test.js test/business-added-roles.test.js test/business-tax-policy.test.js test/business-preparation-references.test.js test/business-transaction-compiler.test.js test/business-operation-freshness.test.js test/business-local-reads.test.js test/business-observation-general-write.test.js
```

106 passed, zero failures/skips. All five touched source files pass node --check. git diff --check passes.

Private stored rows, replay scripts, before/after results, boolean audit and final canonical-source test output remain outside the repository under C:/Users/NewAdmin/AppData/Local/Temp/qbo-job-d-1793493445714/. replay-canonical.cjs exercises the saved canonical source. Child checks exited and no test services remain; no persistent services were controlled.

Read-only post-save observation at 2026-11-01T00:42:42.892Z still shows operation blocked at 0/1 and step claimed at attempts/revision 3, with no dispatch, receipt or QBO ID. Its last claim predates the source batch. Live continuation/Estimate creation remains unverified; no replay or database reset was issued.

## Work-value checkpoint

Essential outcome: remove this false pre-dispatch refusal without relaxing real definition differences. First private evidence capture: 2026-11-01T00:37:25.714Z. Smallest proof: the exact stored intent/policy and hash-authenticated failing definition reach the runtime compiler, while changed definitions and regressed versions still refuse. At the source batch checkpoint, offline proof and focused tests were achieved. Live record delivery remains unverified at the post-save read-only checkpoint. No optional feature or independent operational work was added.
