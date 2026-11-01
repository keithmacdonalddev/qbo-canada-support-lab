# Dedicated QuickBooks browser sign-in

Started 2026-11-01T18:45:22Z; resumed 19:36:40Z after owner accidentally closed the session.

Outcome: the app, accountant, Claude Code and Codex reuse the dedicated qbo-ops browser with the owner's new Intuit company-admin identity. Existing API OAuth and app-owner identity stay unchanged. Target: Production My Business, realm ending 2856. Generic credential: TestDataLab/QBO/production/2856.

Essential work. Smallest proof: private credential presence, successful browser authentication, current Intuit identity and exact native company ID; no accounting writes needed for this proof. Next milestone: isolated tests and independent reviews before one backend-source installation batch. No service restart, API reconnect, company setting, upload or accounting mutation is included in live verification.

Implementation: fixed-target Windows credential reader; deterministic sign-in helper with exact Intuit origin and form checks; shared Terra lease retained through browser handoff; actor-scoped sanitized outcome journal; common CLI and banking-runner entry. Authentication precedes banking journal/import admission. Existing unknown-outcome and import recovery barriers remain enforced.

Verification: fake-secret transport/origin/identity/concurrency/recovery tests, affected existing banking tests, backend syntax and whitespace checks, implementation and safety review, then scoped live sign-in only. Credentials and raw page data never enter tracked evidence.

Work-value ledger: 18:45–closure: source/design inspection only, no code or dataset delivery; 19:36 resume: checkout clean at 83f50f9; next checkpoint is working private sign-in candidate. Live business/accounting outcome is not claimed by these checks.
