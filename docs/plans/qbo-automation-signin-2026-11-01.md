# Dedicated QuickBooks browser sign-in

Started 2026-11-01T18:45:22Z; resumed 19:36:40Z after owner accidentally closed the session.

Outcome: the app, accountant, Claude Code and Codex reuse the dedicated qbo-ops browser with the owner's new Intuit company-admin identity. Existing API OAuth and app-owner identity stay unchanged. Target: Production My Business, realm ending 2856. Generic credential: TestDataLab/QBO/production/2856.

Essential work. Smallest proof: private credential presence, successful browser authentication, current Intuit identity and exact native company ID; no accounting writes needed for this proof. Next milestone: isolated tests and independent reviews before one backend-source installation batch. No service restart, API reconnect, company setting, upload or accounting mutation is included in live verification.

Implementation: fixed-target Windows credential reader; deterministic sign-in helper with exact Intuit origin and form checks; shared Terra lease retained through browser handoff; actor-scoped sanitized outcome journal; common CLI and banking-runner entry. Authentication precedes banking journal/import admission. Existing unknown-outcome and import recovery barriers remain enforced.

Verification: fake-secret transport/origin/identity/concurrency/recovery tests, affected existing banking tests, backend syntax and whitespace checks, implementation and safety review, then scoped live sign-in only. Credentials and raw page data never enter tracked evidence.

Work-value ledger: 18:45–closure: source/design inspection only, no code or dataset delivery; 19:36 resume: checkout clean at 83f50f9; next checkpoint is working private sign-in candidate. Live business/accounting outcome is not claimed by these checks.

## Installed outcome — 2026-11-01T20:30:00Z

The common installed command `node scripts/banking/qbo-session.cjs ensure --actor codex-cli` exited0 at20:29:56UTC and returned ready with identityVerified=true and companyVerified=true for the exact production realm. It reused the dedicated session; initial private password submission was verified earlier. The normal QBO account popover provides the current signed-in identity. Opening Intuit security/overview after the session aged prompted extra verification, so routine identity checks no longer visit those pages. Genuine sign-in challenges still stop safely.

Implementation and safety reviewers found no remaining issues after corrections for form substitution, process cleanup uncertainty, continuous lease handoff and persisted retry history. Full preceding candidate suite:3,017 pass,7 skip,0 fail (3024 total;12m29s). Saved banking checks:151 pass,1 skip,0 fail. The final native-profile correction passed80 focused saved-source tests; the full suite was not repeated for that narrow change. Syntax:335 existing backend files plus9 candidate JavaScript files, shell syntax and diff whitespace passed.

The helper/CLI/banking integration is installed. Complete native banking task execution, forced sign-in expiry recovery and sustained unattended operation remain separate proof obligations. No accounting mutation, OAuth reconnect, company setting or service-control command was performed. [Operational usage](../architecture/qbo-browser-access.md).

Work-value checkpoint20:30UTC: working native sign-in and shared entry delivered; no new accounting records or reconciled periods claimed. Broad full-suite waiting delayed delivery unnecessarily; finish future bounded fixes with focused relevant checks and required reviews, expanding only for a concrete shared risk. Next essential delivery is A01/A02 posting recovery; direct diagnosis already identifies retained invoices, payments and unsent deposits.
