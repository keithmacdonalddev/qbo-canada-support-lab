# Saved invoice and obsolete blocker recovery

Started 2026-11-01T20:16:33Z. Essential A01/A02 work: preserve accepted QuickBooks records, explain the live blockers, and prevent repeating a request that cannot retain its intended relationships. Smallest proof: original immutable request/receipt, current invoice and estimate links, and the actual obligation before any recovery. Next milestone: identify the missing relationship and choose a supported path without replacement creates.

## Direct observations

At 20:16 UTC the app still returned three blockers. Run 816e70a3fbcaf9a91974610d has Invoice 11331 and11332 classified mismatch. Runs c3060fe19c566ba8eb0f49a5 and 62aad9b69fe7db9612d3fea7 contain saved Payments 11330 and 11255/11256 despite a later linked-invoice drift refusal. These are mixed saved/remaining states; an older admission message saying nothing was sent does not describe the entire run.

The original invoice requests name Estimate 11217 and11218 in header LinkedTxn. The retained native responses have no such links. The current request matcher fails specifically on LinkedTxn; it is not merely object defaults or an added computed subtotal.

Four fresh scoped production GETs through the running app at 2026-11-01T20:18:07Z confirm:

| Record | Amount / state | Native links |
|---|---|---|
| Invoice 11331 | CAD285 total and balance | None |
| Invoice 11332 | CAD285 total and balance | None |
| Estimate 11217 | CAD285, Pending | None |
| Estimate 11218 | CAD285, Pending | None |

The synced Preferences observation dated 14:59:59 UTC has SalesFormsPrefs.UsingProgressInvoicing=true and AllowEstimates=true. This is retained settings evidence, not a fresh preference read. Intuit's [Invoice API reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice) documents ordinary estimate links but says progress invoicing is unsupported via the API. Combined with source's existing warning that QuickBooks may drop the estimate link, progress invoicing is a plausible explanation; do not report that inference as an independently reproduced provider cause.

## Required repair scope

1. Preserve both saved invoice IDs, amounts, tax, ownership and original receipts. Never create replacement invoices or label the links verified while they remain absent.
2. Prevent another API-only estimate conversion when the observed company configuration cannot retain the required link. Carry that restriction into executable guards and accountant/owner capability descriptions; route to a supported native procedure with exact evidence. Do not disable progress invoicing merely to make the API work.
3. Establish whether native QuickBooks can attach each existing invoice to its estimate without duplicating lines, amounts, tax or postings. Prepare that supported action and validate against unchanged native records before any authorized edit. No such native edit was performed in this investigation.
4. For A02, inspect all saved and remaining operations and original before-images. Payment 11330 already settled Invoice 11020; further payment is inappropriate. Replanning must represent only genuinely unsent work and retain earlier accepted effects.
5. Add focused actual-shape recovery regression evidence and distinct implementation/safety reviews before installing mutation/recovery changes. Keep UI/native proof separate from mocked checks.

## Work-value ledger

- 20:16–20:20 UTC: one approach; read-only source, database and four native records. Delivered exact missing-link diagnosis; no company writes, service changes or new infrastructure. Continue to supported pre-admission prevention and recovery design after the shared sign-in unit is closed.

At 20:21 UTC, original run/batch evidence showed the genuinely unsent work is Deposit grouped-deposit (linking saved Payments11255/11256) and Deposit bank-remittance (linking saved Payment11330). Both deposit batches have sends:0 and no receipt, while the earlier payment batches are answered with saved receipts. Admission diagnostics report mirrorHash:null for the invoice dependency; source guardBatch reloads the copy without the saved extras used during preparation. This narrows the next investigation to fresh dependency availability at deposit admission; it is not evidence that the payments failed or should be repeated.
