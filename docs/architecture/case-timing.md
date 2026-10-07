# Case timing

Implemented 2026-10-06. Case headers expose initial-request-to-latest-result elapsed time and the latest run duration separately. Elapsed time includes waiting between runs; it is not total active compute time or a latency guarantee.

New case submission stores the server request receipt time. Continuations preserve that origin and clear the previous completion timestamp before starting. Historical cases use the earliest saved user-message timestamp; only when unavailable do they use a labelled case-creation estimate. Existing timing is not migrated or written by reads. Missing, invalid, future or pre-run completion times remain unmeasured. Running cases measure through the server response time. An interrupted run without a valid finish receipt cannot claim a measured finish.

Public timing is computed after evidence-based outcome classification. Only a completed reproduced/not-reproduced result receives the verified-result label. Unverified results say latest result. All calculations use server wall-clock timestamps. The current implementation does not reconstruct active time across historical runs or subtract operator/code-fix waits.

The original PO case was inspected without restarting it: 10h46m from its first saved request to its latest result, with 38s for the latest run. This directly supports full-duration reporting, not an improvement to that historical elapsed time. Forty-nine timing/runner/engine tests passed, backend syntax and frontend build/lint passed, and implementation/safety source reviews were clear. Existing warnings remain. The case page also waits for saved case data before offering Continue reproduction, avoiding a misleading initial ready state while loading.
