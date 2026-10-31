# Activity metadata

Owner outcome: expand any My Business activity entry to inspect recorded time, elapsed duration, actual token counts and usage-based USD cost.

Scope: connect the existing saved review usage to feed events and transcript attempts; retain server-issued review IDs on new tool events; add local details without changing business execution, authorization, company data or services. Preserve unrelated workspace and record-composer edits. Work remains in the canonical main checkout, upstream origin/main.

Cost uses the existing model price table and actual uncached input, cached reads, cache writes and output counts. Codex is an API-equivalent comparison at standard base rates, not a subscription bill; request-level context surcharges are unavailable. Anthropic is an API estimate. Partial usage, unknown pricing, legacy cache splits and absent historical links must remain explicit. Associated review totals are shared across their entries and must never be added per row.

Proof: isolated tests for pricing/cache arithmetic, scope and missing/partial linkage; focused backend checks, frontend build/lint, independent implementation and safety reviews, and desktop rendered expansion/keyboard/overflow inspection with sanitized data. No live provider, QBO or database call or persistent service control is authorized.

Status: implemented. Focused non-live regression: 97 tests passed. Frontend build and full lint passed (three pre-existing hook warnings in AICommandCenter). All 292 backend source files passed syntax checks. Separate implementation and safety reviewers found no remaining issue after fixes for retry attribution and unfinished-review timing.

Desktop rendered acceptance and live database integration remain unverified: the browser tool timed out opening a separate verification tab twice. No owner review tab was operated; no services were started or restarted. This records code and isolated-test delivery, not live company evidence.

Pricing references inspected 2026-10-31: [OpenAI standard API pricing](https://developers.openai.com/api/docs/pricing), [GPT-6.1 Sol cache/context notes](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing). The existing price table and spend-cap behavior are unchanged.

Check commands used Node entrypoints through hidden child processes: node --test on business-activity-metadata, business-agent-live/progress/usage/service/transcript tests; Vite build and ESLint . from frontend; node scripts/agent-harness/check-backend-syntax.mjs; git diff --check. Early one-minute lint/syntax attempts timed out; the completed checks ran to clean process exit with longer timeouts.

Work-value checkpoint: the requested details flow is implemented and isolated verification is complete. Browser tooling repair is deferred; no further UI-tool investigation or live operations are authorized by this task.
