# Historical generation recovery

Updated: 2026-10-02. Scope: fixes to the existing historical generator, not completion of the rebuild operation system.

## User behavior

- Start reserves one run for the active company and environment. Repeated starts and lost HTTP responses return that same reservation.
- New runs store the complete random plan before their first QBO transaction. Resume uses the stored dates, amounts, entity references and parent links; it does not regenerate a new batch.
- Confirmed records are skipped on resume. Explicitly rejected records and unattempted work can be retried; audit repair does not recreate QBO records.
- Running, Successful, Partially successful, Failed and Needs attention are distinct. Counts distinguish created, rejected, unattempted and uncertain records. Expired running state is projected on reads without a startup rewrite.
- Adding more records requires the separate Add Another Batch action and existing Production confirmation. Its previous-run reference makes a repeated submission resolve to the same successor. Earlier unresolved runs prevent additional batches.
- Older runs have no durable plan and are not automatically resumed. Old completed runs containing errors are displayed as partial/failed without a database migration.

## Safety and storage

GenerationScope uses MongoDB's built-in unique _id for an environment/realm reservation and stores its run ID and original configuration before run creation. It also binds the user and connection. This needs no migration or new uniqueness assumption about legacy GenerationRun rows.

A run is claimed with a ten-minute lease and a random ownership token. Every pre-dispatch step update requires that token and an unexpired lease. Expired runs are claimable only when the same atomic query finds no sending/uncertain steps. The full plan is stored once; subsequent progress writes update the current step rather than retransmitting the entire plan.

Sending is persisted before the QBO create call. A confirmed QBO ID is persisted before audit and before the next write. A network error, missing successful response ID, ambiguous server error, or an interrupted sending state stops the run. These steps are never automatically replayed. Known success with an unavailable audit remains visible; resume repairs audit first. Current response counts, transaction lists and errors derive from saved step evidence, even if aggregate finalization was interrupted.

Legacy startup maintenance excludes executionVersioned runs. App startup does not resume work. Access/login settings and existing Production confirmation are unchanged. No automatic scheduling, generic operation platform, QBO deletion, record adoption or live migration is added.

## Remaining limits

- Ambiguous writes and incomplete legacy runs require inspection. There is no automatic resolution/unlock or compensation path. This deliberately prevents an unverified retry from creating duplicates.
- An abruptly stopped run without an in-flight step becomes resumable after lease expiry (up to ten minutes); it is not resumed in the background.
- Audit receipt persistence can result in a duplicate audit entry if audit succeeds but saving its marker fails. This does not repeat the QBO write.
- Live MongoDB concurrency and real QBO acceptance are unverified. In-memory query fixtures cover the atomic predicates; they are not a live database test.

## Verification and outcome evidence

- backend/test/generation-recovery.test.js exercises competing starts, reservation recovery, linked-record resume, expired ownership, lost replies, failed receipt/audit persistence, old partial results, bounded inputs and current error projections.
- scripts/generation-ui.test.mjs renders the actual built React Lab Tools page at 1440×1000 with all API calls intercepted by fixtures. It covers empty, partial, Production-confirmed resume, successful, running-after-refresh, uncertain and status-error states, plus the additional-batch warning. It owns and closes its temporary browser and loopback static server.
- Screenshots are local/ignored under artifacts/generation-review/. They contain fixture data only.
- Independent implementation and safety reviews inspect the generation-owned change. Unrelated concurrent UI work is preserved.

Outcome ledger: saved-plan retry, duplicate-launch prevention and truthful results are fixture-verified; desktop interactions and rendered states are fixture-verified; live QBO records/report evidence and real database recovery remain unverified. No live company, database migration or persistent service was operated for this work.
