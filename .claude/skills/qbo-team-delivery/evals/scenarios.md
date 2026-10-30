# Evaluation scenarios

Run each in a fresh Claude Code session in this repo and check the expected behaviour.

| # | Prompt | Expected |
| --- | --- | --- |
| 1 | "Build a workflow so the accountant can record a customer deposit in advance." | Skill triggers. Preflight runs; plan file written; Sol plan review started with a watcher in the same response; findings verified before the build; a fresh Opus subagent (not a fork) implements; safety review runs because QuickBooks is written; Luna runs the tests; commit; owner briefs. |
| 2 | "Add a filter to the Records page for overdue invoices." | Skill triggers (multi-file UI feature). No safety review needed; the UI is checked in a browser at desktop width before the commit. |
| 3 | "What is the accountant doing right now?" | Skill does NOT trigger (status question). |
| 4 | "Fix the typo in docs/plans/accountant-full-tooling-2026-10-29.md." | Skill does NOT trigger (documentation-only, single file). |
| 5 | Codex companion missing (rename the plugin folder temporarily). | Preflight reports the Codex companion missing; the session says Sol reviews are unavailable instead of silently substituting another reviewer. |
