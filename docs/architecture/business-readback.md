# Exact business read-back

2026-10-06. Internal verification boundary; not a live execution or activation claim.

## What is checked

The compiler hashes its full artifact (scope-bound request, logical intent, evidence and relationships). Dispatch, the company writer and common transport preserve that identity. Read-back compares the exact saved record with the original artifact and creation receipt. Current observations must be company scoped, canonical-versioned, content hashed and no more than five minutes old.

Headers, item quantities, prices, cent amounts, control accounts, dimensions, line counts and exact originating line links are compared. Safe provider-generated subtotals are recognized; extra financial lines and unknown links fail. Reordering does not change line matching. Approved tax expectations must separately match total tax, each rate, percentage, taxable base and tax amount; arithmetic alone cannot pass tax verification. Policy loaders must derive these expectations from approved Canadian treatment, never copy the response they are checking.

Invoice and bill balances reconcile to exact applications from proven managed payments. PO API Received values reconcile by actual PO line ID to proven bill item quantities and expected open/closed state. Every source-line link must resolve exactly once; replaced or duplicated source IDs cannot silently remove consumption. This checks an API field, not the QBO screen's Billed column. Canadian response-shape acceptance remains to be demonstrated with authorized direct evidence.

## Two proof stages

verifyBusinessContent checks saved content and current scoped parent identities without claiming that the full parent graph is complete. A saved invoice can therefore supply current content evidence explaining its time activity's HasBeenBilled status. Descendant proofs require exact managed logical intent, compilation identity, physical ID, current version, creation receipt and backlink. They cannot be supplied as completed step evidence.

verifyBusinessReadback adds freshly completed parent proofs. The step store accepts only kind business-readback bound to the dispatched compilation hash, and enforces the same contract for stored dependency reads. Thus the runner can compute child content first, refresh parent completion, then close children without circular waiting. Every consumed proof retains its original expiry; a new read cannot extend an older neighbor proof's lifetime.

## Integration boundaries

All compilation, receipt, tax and neighbor loaders are explicit trusted server adapters. No defaults, new public routes, live calls, database setup or scheduling were added. Hashes detect drift; they do not grant authority. The step store now saves the original compiled artifact atomically with dispatch and exposes a scoped internal recovery read. business-graph-readback.md now describes the bounded model-backed graph reader and two-pass reconciliation. Its deployment adapters, atomic proof persistence and runner integration still need implementation. Existing global integration readiness remains closed.

## Verification

109 distinct focused read-back/compiler/step/writer/transport tests passed, followed by a 26-test step-store rerun after the artifact-field privacy correction. Backend syntax passed for 99 files. Independent implementation and safety source reviews are clear after corrections for orphan line links, stale proofs, logical graph identity, monetary precision, tax semantics and content-only proof separation. No live QBO or database mutations occurred.

The PO Received field description is from [Intuit's SDK Line schema](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPLine.php); the shape and lifecycle assumptions here still require target-company API verification.
