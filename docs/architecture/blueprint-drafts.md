# Company business-plan drafts

Implemented 2026-10-06. This is a draft workflow, not activation or a completed company.

The Company page loads the approved business direction, preserves new immutable draft versions, and reads bounded actual account/tax-code choices. GET /api/company/business-plan and GET /setup are read-only; POST saves only application data. No route creates QBO records, renames the connected company, starts scheduling, grants membership or prepares storage.

Saving requires a current explicit blueprint.manage membership and prepared transaction-capable storage. The legacy role bridge remains read-only. The loaded connection ID is an expectation checked against the server's current connection, never a scope override. Saves also compare the latest content hash. The returned draft becomes the form's new baseline directly, avoiding a reload that could discard new edits.

Each save inserts an append-only BlueprintVersion snapshot, allocates its realm-wide version and inserts a bounded audit in one MongoDB transaction. A company/actor/connection/request-key identity handles lost responses; changed payloads conflict. Integer validation prevents malformed or exhausted version allocation. Normal model save/update/delete paths reject history edits. Raw collection and bulk-write access remain outside the supported workflow and must not bypass this contract.

Storage readiness checks actual collections, a full non-sparse/non-partial unique realm/version index and transaction-capable deployment topology. Model imports do not initialize the new collections/indexes. Readiness is a precondition, not proof of a successful live transaction.

Setup reads share a bounded query budget. Incomplete sources remain incomplete; output contains selected account/tax options and preference observations, not raw records/errors. Mapping IDs are draft choices only: activation must validate exact company, active record, account type/subtype, currency, date-appropriate tax treatment and current content. Saving a draft does not approve these choices. The 12 roles include explicit receivables, payables and undeposited-funds accounts. Older drafts remain readable; missing new roles appear unassigned and normalize to null on the next save without changing previous choices. The chooser requires explicit active status and filters by the same type, detail-type and currency definitions as structural validation.

## Evidence and limits

Independent implementation and safety reviews corrected stale-connection and post-save-refresh races. Focused service/model and authenticated route tests cover optimistic conflicts, idempotency, audit rollback, integer allocation, permissions, source completeness, scope overrides and QBO error mapping. Tests use fixtures; no live save or database preparation has run.

The desktop app visibly loads the proposal and reads the connected company's actual setup. Current owner access remains on the legacy read-only bridge; new business storage is absent. Live successful save/retry and real transaction rollback remain unverified. Version browsing, activation, baseline ownership review, activity rules and operations integration are still required.
