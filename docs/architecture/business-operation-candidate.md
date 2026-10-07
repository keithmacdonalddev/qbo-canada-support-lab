# Prepared operation assembly

Implemented 2026-10-06. This is a pure server-side bridge from current preparation and original saved history into the existing immutable operation-plan contract. It does not read or write a database, call QuickBooks, approve rules, activate a company or claim execution readiness.

## Exact inputs and dependency order

The preparation output now binds business key, opening date and saved blueprint ID as well as the blueprint content hash and connected-company scope. Original history also retains its original business key. Assembly checks both source hashes, five-minute observation freshness, exact history roots, continuous calendar context, required report assertions and bounded counts/content.

New activity is finalized in dependency order. Its compiler step contains explicit business details, full reference bindings and exact dependency fingerprints. Display/status metadata is not part of new compiler intent. References and new dependency identities are sorted consistently. The per-step policy request names the resulting final step hash, after every parent identity is resolved.

Earlier entries require original saved or verified ownership and an exact physical record ID. Their full original step and policy are copied unchanged, including prior reference definitions and dependency metadata. The complete original closure is retained; unknown receipts, missing ancestors, cycles, cross-business lineage, duplicate physical records, changed fingerprints and unrelated earlier rows stop assembly. Any owned current-period activity requires resuming its original operation.

Missing current local receipts are required for new candidate entries but do not prove absence of unmanaged QuickBooks records. Baseline ownership review remains required. The supplied calendar, blueprint and baseline context is structurally validated here, not independently verified or activated.

## Requirements and policy binding

All current reference choices need complete definitions and resolved state. Only known prior-record/dependent-step blockers can carry forward as fresh-readback requirements. Operation-wide baseline, business-policy, period-control and execution requirements remain in both outputs. Unresolved home currency, an unsaved business plan and unknown requirements stop assembly instead of disappearing.

Policy binding accepts one separately approved policy for each finalized new step. Each supplied stepHash must already match; the assembler never edits policy status, evidence or hashes to fit. Original policies are not replaced. The completed candidate passes the existing plan-store validator and includes its candidate and plan hashes. Both phases explicitly return persisted=false and readyToExecute=false, requiring current activation fencing, ownership review and fresh saved-record checks.

Inputs must be server-owned. Hashes provide integrity, not authenticity. A future production loader must obtain retained approval and baseline evidence and enforce the current transactional activation fence before approval. Do not expose this function as a route accepting arbitrary client steps or policy claims. Candidate payloads must not be stored in generic AuditLog: existing audit endpoints return full documents. Existing Plan/Intent persistence is the target for the assembled server candidate.

## Verification and remaining integration

The initial candidate, plan-store, preview and full-reference set passed 64 tests. Review identified lost operation-wide blockers; the correction and additional original-closure/ownership regressions pass a 49-test candidate/plan-store rerun. Source syntax checks pass. Fixtures cover actual first-period preview chains, saved Plan/Intent persistence and compiler consumption; simulated policy approval and provider records are explicitly fixture inputs.

Both independent implementation and safety source reviews are clear. No production operation, baseline acceptance, tax approval, storage setup or complete-company outcome is established. Concrete retained policy/baseline review, production candidate loading, activation/drain maintenance, approval routes and desktop integration remain unfinished. The full app goal remains active.
