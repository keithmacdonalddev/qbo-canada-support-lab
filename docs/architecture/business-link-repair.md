# Repairing a missing link on an owned service Invoice

This internal correction preserves an accepted Invoice and its original operation when QuickBooks saved its TimeActivity link but omitted its originating Estimate link. It is not a public route, scheduler, general transaction editor or authority to modify unmanaged records.

## Exact scope and authority

The original blocked approved operation must still own its published calendar and company writer. It must have no worker lease, queued execution, uncertain transport or pending completion. The current owner, selected connection, membership and protected-period controls are checked again by the existing QBO write gate. Both source parents must be accepted records in this same operation, with their original native creation receipts and audits.

The append-only BusinessAuthority collection retains a distinct business-link-repair-plan and, after successful verification, business-link-repair-outcome. Neither replaces calendar.authorityHash. Deterministic per-company/per-logical-key plan IDs prevent two approval decisions for the same original Invoice. No collection, index or migration is added.

The dedicated business-link-repair workflow admits one exact Invoice sparse update containing only Id, current SyncToken, sparse:true and the original Estimate and TimeActivity header links. It has its own mandatory QboWriteReceipt kind and start/result/approval/verification audits. Ordinary business permits remain create-only; legacy admission still cannot enter an owned operation. A refused or uncertain repair grants no retry.

## Saved result and read quarantine

A saved update retains its own unresolved company-writer pointer. Read-only graph snapshots may recognize only that exact known-saved receipt and its immutable repair authority. The snapshot carries the held pointer and response-evidence hash explicitly. Unknown or possibly-sent receipts remain blocked. No normal write becomes eligible during this inspection.

The three records are read through the original scoped QBO client. Missing Invoice ARAccountRef still needs independently refreshed exact receivables-ledger evidence. The repair verifies real Invoice header links and the sole Estimate backlink. A missing original Invoice line link is represented by a separately hashed full-Estimate conversion compatibility proof, never an inserted API field or rewritten original request. The proof requires the original source line ID, exactly one matching financial line on each record, identical item/quantity/rate/base/tax/customer/currency economics and billed original time. It remains labelled physicalInvoiceLineLinkReturned:false.

## Completion and recovery

Before clearing only the repair pointer, settlement independently verifies:

- Whole-record equality outside exact header-link, Estimate status, version and named causal metadata allowances. Creation metadata, all accounting fields, dates, parties, notes and line identities remain exact. The time and customer records remain unchanged.
- Complete original-month and current-year critical report sources and unchanged complete account definitions. Every reported account and leaf is checked by the unchanged native balance validator. An omitted parent requires its own exact filtered CAD Accrual GeneralLedger, explicit NoReportData:true and structurally empty Rows over the retained 1900-01-01 through current-date query. Its basis is zero direct postings, with children covered separately; no parent rollup balance is invented. Both sides must preserve this exact per-account coverage and establish zero direct-account change.
- The native graph envelope, exact original identities/revisions and complete parent closure. Native content and relationship proofs are regenerated from retained raw graph observations, original compilations, creation receipts and independently loaded approved tax policies.
- Unchanged accepted creation identities, original request/compilation/receipt hashes, operation cursor and company ownership.

The full graph is retained as bounded JSON text with a digest and a shallow typed summary, preserving source evidence without exceeding blueprint canonical nesting limits. Later compatibility reads validate the immutable outcome, mandatory audits and regenerated graph proof again.

A known-saved update can resume read-only verification without another POST. Its before reports retain their original review date; new admission requires current freshness, and completion requires fresh after reports. Lost acknowledgements or unknown results never cause replay. The original operation resumes only after verified repair settlement and ordinary native graph verification.

## Integration evidence

Invoice header linking to Estimates and TimeActivities is described in the [official Invoice API reference](https://developer.intuit.com/docs/api/accounting/invoice). Sparse-update retention and future create behavior are separate integration claims. Passing fixtures proves the bounded implementation; actual company readback is required before claiming either provider behavior worked.

## Storage-integrity recovery before admission

BusinessAuthority uses minimize:false to preserve empty objects covered by its content hash. A legacy malformed approval is never rewritten or accepted by ordinary plan loading. A distinct business-link-repair-recovery-plan may retain the original plan as bounded canonical JSON only when the old hash and approval audit match, the sole stored differences are the explicitly allowed missing empty subtotal/report objects, every raw before-image and exact request/creation identity/state is unchanged, and fresh financial evidence proves no movement.

Recovery requires absence of the original mandatory receipt by both deterministic ID and workflow correlation. Any receipt state forbids this source-only path. One deterministic recovery target prevents competing approvals; later lineage rejects ambiguous recovery IDs and regenerates the original native graph. No receipt, original approval or accepted creation is replaced. A fresh recovery authority still admits only one update through the same scoped gate and protected-period controls.
