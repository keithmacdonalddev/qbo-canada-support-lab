# Business record choices

Implemented 2026-10-06. Explicit identity bindings in immutable business drafts, plus read-only compatibility inspection. No QBO creation, editing, adoption or activation is performed.

The proposed activity template now derives its required customers, suppliers, products and time worker from the same deterministic economics used by the calendar. Customer pooling keeps Development at 12 customer identities; Flagship uses 48 customers for these initial chains, three suppliers, nine items and one employee. This does not claim the approved full population targets (120 customers, 45 vendors, 90 items, 36 projects) are met. Broader lifecycle, project and dimension requirements remain open.

A draft may save masterBindings from stable business keys to explicit QBO record IDs. The input validator accepts only known keys and bounded IDs and rejects assigning one physical record to two distinct identities of the same entity type. Null selections are omitted. Switching to a smaller profile retains larger-profile choices so it does not silently erase prior identity decisions. Older snapshots without bindings load as empty; saving produces a new hashed, audited version through the existing transaction boundary.

The masters-check route requires blueprint.read, accepts only the loaded connection/version, derives company/environment on the server, and rechecks current scope and saved version after observation. Four QBO source lists share a bounded dispatch/page/record budget. Returned options contain names, IDs, active status, currency, item type, project flag, relevant account references and sync token. Addresses, contact details, balances, payroll information and raw errors are excluded.

Compatibility requires a unique explicit selected ID, complete source list, active status, required CAD currency and product type/account references matching the saved business mappings. Project customer IDs cannot be silently substituted for the customer identity. Missing fields remain unverified. Names never create selections or establish origin. A compatible selection is intended use only; it does not prove ownership, inventory starting state, tax correctness or approved baseline membership. Results remain readyToExecute false.

The Company UI groups roles by entity, pages 12 roles, excludes inactive options and distinguishes saved checks from unsaved selections. Exact selected IDs are included in the next draft save. Saving still requires the existing company permission and prepared storage; this feature does not grant a role or prepare the database.

## Verification

- 49 focused master/draft/detail/preview/mapping tests pass. Coverage includes stable profile identities, legacy fallback, explicit binding persistence, duplicate identities, invalid IDs/roles, no name-based adoption, source incompleteness, currency/activity/item-account mismatch, minimized private fields, and company/version changes during reads.
- Backend syntax: 88 files pass. Frontend build/lint and diff checks pass with existing chunk-size, three hook and line-ending warnings.
- Independent implementation and safety source reviews: no blocking findings.
- Existing Chrome connected-company flow: loading and 61 unresolved choices observed; customer paging moved 1–12 to 13–24; product view displayed nine roles. Read-only controls remained disabled for the current role. Desktop rendering inspected. No QBO or database mutations were performed.

Live draft saving remains unverified because the reviewed one-time storage/owner setup approval is still pending. The actual business is not yet activated, backfilled or current.
