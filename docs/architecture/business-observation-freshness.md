# Same-operation observation freshness (2026-10-31)

Transaction verification and compilation use complete exact-ID GETs taken after earlier operation writes. A recent write response or current synchronized generation is not a proof of the current transaction: a later linked save can change balances, links, received quantities or computed billing status without advancing the parent's SyncToken. All existing content, account, tax, relationship, version and writer-fence checks remain strict.

## Read-only blocked-operation evidence

Operation 3359607d8aee4df04a3d88da was blocked at nextOrdinal 18 of 36. Its last persisted attempt ended at 2026-10-31T19:18:52.681Z, before commit 11e334f at 19:23:24Z. There is no persisted post-fix attempt in the inspected data. The saved group is Estimate11112, TimeActivity1073742971 and Invoice11114. Retained mirror and create representations show the time entry as Billable; the invoice links that time entry. QuickBooks omitted the Estimate link (the established, separately labelled limitation), leaving the estimate open. Pure replay of retained conversion fields refuses Billable; an isolated replay with HasBeenBilled satisfies the conversion fields. This isolates the recorded stale observation, not a new live company read. No QBO call, operation resume, MongoDB write or service command was performed. The read-only database connection was closed.

## Audited ingress and strict consumers

| Point | Treatment |
| --- | --- |
| business-reference transaction reader | Saved/mirror observations cannot satisfy transaction reads, even with an injected store. Master definition reuse remains available. |
| business-transaction-batch-reader | Exact GET for every graph record, at most three concurrent; deduplicated physical IDs, peer cancellation and no partial result on failure. No query/mirror/saved-response fallback. |
| business-verification-runtime prepareRecords/readRecord | Prepared observations originate only those GETs and retain the runtime-owned WeakSet and freshness/hash/scope checks. Removes status-specific time workaround. |
| Omitted Invoice/Payment/BillPayment/CreditMemo account | Open ledger bracket on the already-fresh GET; keep independent closing GET, whole-record hash equality, original ownership/compilation/account definition, report and writer fences. Unchanged report reuse still keyed to the current full record hash. |
| Conversion compatibility Estimate and TimeActivity | Internal rawRecord is now the live reader. Both parent observations are fresh; closing Invoice GET and strict economics/links/billed checks remain. |
| Adopted PurchaseOrder tax/readback evidence | Internal rawRecord is live after receipt writes. Original import proof remains required. |
| business-compilation-runtime Item references | Item GETs are forced live because SalesReceipt compilation consumes QtyOnHand; earlier receipt/sale writes can change it without invalidating a definition mirror. Other dynamic master fields are not used for compilation decisions. |
| business-compilation-runtime dependencies and deposit availability | readRecord is live for exact comparison with just-persisted graph proof, and both sides of deposit absence checks. No relaxed equality. |
| business-graph-readback / business-readback | Pure topology/content consumers remain unchanged; strict balances, links, credit amounts, PO quantities and TimeActivity state use the fresh runtime observations. |
| business-receivables-route / business-estimate-conversion | Pure proof consumers remain strict; no synthesized status or version. |
| business-purchase-order-receipt / business-adopted-settlement | Runtime composition already passes exported live rawRecord. Production adoption reader included in fixture. |
| business-own-settlement / business-correction | Governance source adapters already make direct GETs; runtime correction admission already uses live rawRecord. |
| qbo-write-period / qbo-write-gate | Standard gate already passes actual client; each original/transitively linked record uses direct read, Preferences live. No cache introduced and no change required. General/population batch preflight memoization is confined before that batch's writes. |
| Governance general-write day-close ledger bracket | Mirror-first adapter replaced with targeted GETs; both sides can detect changed linked parents. |
| business-observation-store | Remains a copy/provenance service, not a current transaction-version oracle. Fixed lifecycle transaction consumers bypass it. General-write inventory enumeration/admission remains a separate mirror-based, default-off workflow; this change does not certify its computed fields or redesign it. |

## Read cost

One graph snapshot now costs N targeted GETs for N records, replacing zero reads on copy hits or one query per entity/page on misses. Compilation additionally reads each distinct Item binding live for current stock availability. It adds one targeted transaction read per dependency and one closing Payment read for each Deposit availability bracket. Conversion compatibility adds its two parent GETs; adopted PO evidence adds one. These points previously could return copies. Omitted-account brackets use the fresh opening observation and save the formerly duplicated opening GET; report reuse is unchanged. Period-guard reads are unchanged.

Actual per-operation deltas depend on the graph refreshes, cache hits, returned account fields and retries. A completed-operation differential against the old implementation cannot be measured because that implementation stalls. The fixtures measure the new transaction GETs (including unchanged period/adopted reads); graph+compilation+Item is the upper additional budget against hypothetical all-copy hits at those points:

| Single simulated operation | Graph GETs | Compilation dependency/bracket GETs | Total transaction GETs | Item GETs |
| --- | ---: | ---: | ---: | ---: |
| Settled field sale + deposit | 30 | 6 | 45 | 3 |
| Terms invoice + partial/full collections + deposits | 30 | 6 | 46 | 1 |
| Terms bill + own payment | 6 | 1 | 8 | 0 |
| Sent estimate + conversion | 12 | 3 | 17 | 3 |
| Stock order + receipt | 6 | 1 | 8 | 2 |
| Adopted invoice collection + deposit | 7 | 2 | 13 | 1 |
| Customer credit + application | 12 | 3 | 17 | 2 |
| Own-record correction + application | 12 | 3 | 17 | 2 |

Counts include verification after every save, prerequisite verification before compilation, and final closure. Large connected graphs still have the existing three-minute budget and fail closed on expiry.

## Verification boundary

business-operation-freshness.test.js exercises chronological v8 builders (and native care-credit planner), production compilation runtime/compiler, period GET guard, simulated saves and receipt persistence, production graph runtime, active observation store, and unchanged SyncTokens under one writer operation. The adopted chain uses production importedObligation/adoption reader. Earlier source dates and later settlement dates retain production's same-day-source prohibition. These are pipeline integration fixtures; full dispatcher/storage and live-company recovery are not proved by this seam.

Eight chains pass. Running the settled-sale fixture against unchanged source fails on stale Estimate relationships. The focused Item test also offers a stale zero-quantity mirror, verifies live stock, and refuses genuine shortages. Existing graph negatives retain wrong balances, unrelated links, changed customer/economics and genuinely unbilled time refusals. Independent implementation and safety reviews found no remaining source or fixture finding. Detailed local command output is under ignored artifacts/operation-freshness-20261031.

Final verification: 221/221 focused tests passed against the applied source across fourteen Node test files; 20/20 existing activity-lifecycle-v8, care-credit and correction-flow regressions passed against the staged source. All 292 backend JavaScript syntax checks and git diff --check passed. The initial combined broad run exceeded120 seconds; its bounded separate rerun completed in438 seconds with exit0. Five watched source files were saved once each at2026-10-31T19:47:29.434Z in a4ms batch, then compared byte-for-byte with the tested staged versions. No commits or service-control commands were made.
