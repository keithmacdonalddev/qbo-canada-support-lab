# Nightly company mirror amount evidence

Implemented 2026-10-31. This describes configured behavior and isolated fixture evidence; no live company/report reconciliation was performed for this change.

After 02:00 America/Halifax, the existing sync worker compares these amounts once per Halifax day:

- The sum of open Invoice balances against the AgedReceivables grand total.
- The sum of open Bill balances against the AgedPayables grand total.
- Each Bank and Credit Card Account's CurrentBalance against a single live Account query, including inactive accounts. Comparisons preserve individual account identities and currencies; missing accounts differ from zero balances.

The first proof follows bootstrap on the next Halifax day, alongside the first existing COUNT sweep. CDC (QuickBooks change-data capture) is refreshed before comparing, even if the normal cadence is not yet due. Deferred checks require another CDC refresh if that observation is over two minutes old. A failed CDC retains its existing retry backoff and cannot produce a match.

All amounts are compared as integer cents, with zero tolerance. Foreign Invoice/Bill balances require an exact home-currency HomeBalance; missing conversion evidence is an error, never an implicit zero. Aging report name, time, currency, total column and grand-total row must be valid. An explicit empty-report marker can establish a zero total; an absent total cannot. An Account response at the 1,000-record query limit is unverified rather than silently treated as complete.

## Persistence and status

BusinessAgent.sync.amountReconciliation persists the latest proof in the existing scoped sync state; no model change or migration is needed. It contains the Halifax day, overall status, timestamps, zero-cent tolerance, timing note and checks keyed by receivables, payables and accounts.

Each check records status, attempts, checkedAt, cdcAt and qboAt. Receivables/payables record mirrorCents, qboCents and currency. Account evidence records qboId, status, mirrorCents, qboCents and each side's currency per account. Mismatches retain their initial evidence while recovery runs. No raw QBO records or account names enter this proof.

The sync snapshot publishes this object as amountReconciliation. The worker already saves the complete snapshot as BusinessAgent.syncView; publicSync spreads that view into the protected GET /api/company/business-agent response's sync object. No route, service, or frontend changes are required. A pending repair or failed/persistent comparison makes sync status attention and company figures provisional. A successful amount proof is point-in-time evidence, separate from the freshness of later CDC observations and the existing count checks.

## Recovery and request cost

A first mismatch resets only the affected Invoice, Bill or Account source to a full mirror generation. Existing keyset pagination, catch-up CDC and generation cleanup finish that source before exactly one re-check. The proof survives slice boundaries and process restarts. Saturation or a long bootstrap can replace the recovery generation; a completed newer full generation can satisfy the pending re-check. A second mismatch remains a visible problem without another recovery loop that night. Failed evidence reads remain errors until the next nightly cycle.

Normal amount verification costs three new QBO GETs (two reports and one Account query), plus one shared pre-check CDC GET: four requests, excluding the existing COUNT sweep and normal snapshot work. This is not a hard five-request cap including repairs. Each affected small source adds a full query, catch-up CDC and its single re-check; larger sources add pagination. All requests, including recovery and deferred work, share the existing maxRequests admission and timeout limits and are categorized as sync by qbo-request-meter. No QBO accounting writes were added.

A CDC cursor or last successful observation beyond the conservative 29-day lookback triggers full resync, even if a saved nextAt is in the future. This fallback existed for old cursors; the change also covers an old lastSuccessAt and prevents scheduling from delaying required recovery.

QuickBooks reads are not atomic. A transaction may change between CDC and the report/query; both observation times are retained. Aging reports may also include unapplied credits/payments, journal entries, date scope or currency effects that an Invoice/Bill-only sum does not capture. A persistent difference remains unverified and includes this explanation; the comparison never adjusts away a difference to manufacture a match.

## Verification and work-value record

- 2026-10-31 04:59 UTC: essential scoped issue recorded; smallest proof is mocked sync/reconciliation tests. No live company or database access authorized. Continue to a complete tested sync slice.
- 2026-10-31: node --test backend/test/business-agent-sync.test.js passed 44 tests, including the original 30 sync cases and amount matching, targeted recovery, persistent mismatch, one-request slices, refreshed CDC, outage fallback, malformed evidence, recovery saturation, backoff and currency invalidation.
- Separate read-only implementation and safety reviews found no remaining findings after regression fixes. Their evidence was source inspection, not a live company run.

Live QBO report compatibility and actual matched company amounts remain unverified. No persistent services were controlled; no QBO calls or MongoDB writes were made by the coding agent. Changes remain local at the owner's request.
