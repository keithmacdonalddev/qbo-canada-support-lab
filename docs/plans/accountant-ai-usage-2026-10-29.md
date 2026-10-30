# Accountant AI usage and owner limits

Implemented 2026-10-29 in the canonical main checkout, scoped to the accountant and its specialists. No QuickBooks writes or service control were performed.

The Business page Main accountant panel shows today, rolling seven days and current calendar month (UTC): tokens, review attempts, provider/model/role, estimated Anthropic API USD, and Codex plan reset state. Only a verified ChatGPT sign-in is labelled included in plan; API-key Codex billing is unverified. Historical usage cannot be reconstructed.

BusinessAgentUsage stores bounded metadata only, with a company/connection/time index and 180-day TTL. Collection/index setup occurs only when an enabled review first records usage, never on GET/import. Each model dispatch retains pending/unknown evidence, each response retains cumulative usage, and completion retains outcome/time. Missing usage or unknown prices pause applicable capped reviews. Stale interrupted reviews also count as incomplete evidence. No prompts, response text, keys or raw errors are stored.

Pricing is an explicit standard-global USD estimate in backend/src/config/business-agent-prices.js, sourced from Anthropic pricing on 2026-10-29. Unsupported model IDs remain unpriced. Cached input is counted separately and cache writes account for five-minute versus one-hour duration. Discounts, taxes and other billing adjustments are excluded. This is an estimate-based control, not a provider billing cap.

The configure-usage owner command uses the existing revision, idempotency, authorization and audit path. Either cap can be blank; zero pauses immediately. New model calls stop at or above the limit, while an already dispatched call may exceed it. Company monitoring continues. Raising/clearing a cap or UTC month rollover allows enabled reviews again. A native Codex quota error pauses automatic/codex reviews until its bounded reset time; without a reset, the owner can request another check after the plan recovers. Usage evidence retains quota even if an owner revision wins over the worker update. The accountant reads usage through its context/getBusinessState and cannot change caps.

## Outcome and work-value ledger

- 2026-10-29T22:29Z: essential outcome is owner visibility/control of review cost. Smallest direct proof: isolated recording/cost/quota/cap/API tests plus desktop rendering. Next milestone: integrated Main accountant panel. No optional investigation opened.
- 2026-10-29T23:01Z: implementation and focused fixtures present; independent implementation/safety source reviews identified cap/auto-provider/missing-usage issues, subsequently corrected. User-facing live data proof remains unverified.
- 2026-10-29T23:06Z: verification launch blocked. Luna receipts accountant-usage-20261029-receipt1.json and receipt2.json record thread-id-missing with no commands executed. Receipt1 could not locate the inherited executable; receipt2 used installed Codex 0.165.0 and exited before JSONL. Codex version inspection reports denied writes under the sandbox-read-only .codex directory. Hidden bridge route cannot establish an effective runner here; no substitute executor used. Defer runtime verification and preserve the prepared request.
- Browser security declined localhost access for a separate verification tab. No alternate browser route attempted. Desktop rendering remains unverified.

## Evidence status

Source: integrated feature and independent read-only implementation/safety reviews; both final source reviews reported no remaining findings after corrections. Focused fixtures cover recording, cached cost math, native quota/reset parsing, cap equality/zero/rollover, capped first call and next-round pause, missing evidence, scoped storage, owner API payload, and accountant read-only access.

Not executed: the prepared request artifacts/luna/accountant-usage-20261029.json lists one test file per command for usage, engine, service, tools, policy, store, work, catalog and Codex CLI, plus backend syntax, frontend lint/build and diff check. Both receipts are blocked, not passing evidence. Live Mongo aggregation/index creation, provider behavior and desktop rendering remain unverified. No live company mutation is needed for those checks.

Git closeout: main with upstream origin/main was verified, with no ahead commits or pre-existing staged changes. Staging the exact 21 owned paths failed: git could not create .git/index.lock (Permission denied). No commit or push was possible; all owned changes remain local. Concurrent accounting files and the pre-existing reviewer memory change were preserved and excluded.
