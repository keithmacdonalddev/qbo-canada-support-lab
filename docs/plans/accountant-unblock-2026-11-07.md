# Accountant unblock — implementation brief (2026-11-07)

Owner-approved. Read `AGENTS.md` "Owner intent" first; it is the product direction. This brief only lists what in the current app works against it. Decide the how yourself; do not ask the owner anything the intent already answers.

## Problem in one line

The app spends most of its effort proving and protecting itself, so the accountant waits, re-checks and stalls instead of running the business.

## Evidence (live data, 2026-11-07)

- Books stuck at "verified through Nov 2" for days: the daily close must run in strict order with immutable proof, and each fix exposed another strict check. The latest blocker is a stock-quantity check that fails once the calendar is behind.
- 158 accountant reviews in 24h, about 81M tokens; only 48 saved records. Each review re-observes ~35 finished operations (~5,400 log events/day, `business-agent-accountability.js`).
- Nov 4: ~10,000 metered QuickBooks calls for 151 records, mostly proof reads, against an owner goal of ~3 per record. A self-imposed 10,000/day cap then stopped work. Intuit's real limits: writes unmetered; reads 500k/month.
- The accountant cannot fix problems it finds. An account is frozen over an opening mismatch, uncertainty holds forbid correction, and blockers become build requests that wait for a coding session.

## Required outcome

1. **Monthly close, like a real company.** Replace the daily verified close with a monthly close after bank reconciliation and HST. Daily checks are read-only and never block anything. Normal work never waits on any close. Retire the stuck previewed Nov 3 operation `b8cc7378793f84c2f3571259`.
2. **No idle re-checking.** Reviews happen when there is work. Between them the accountant advances coverage and realism (Owner intent item 2), not re-checks of finished work.
3. **Calls go to records, not proof.** Checks use the synced copy or one report read. Replace the 10,000/day self-cap with Intuit's real limits.
4. **The accountant fixes, never waits.** Every rule that stops work, freezes an account, or files a request and waits becomes a tool the accountant uses to fix the issue itself. Keep only: no duplicate records, the right company, every write audited, and the owner's 2026-10-05 approval rule for deleting pre-existing records in reproduction cases.
5. **No prescribed business.** Remove the fixed daily record target, the time-of-day trading schedule and any hard-coded business shape. The accountant decides what the business is and how active it is.
6. **Real "For Review" bank-feed items.** Business transactions are recorded through the API. The simulated bank's CSVs are uploaded into QuickBooks via browser so the feed matches them; bank-only items are added from the feed, and feed situations (duplicates, excludes, rules, mismatches) are exercised. Monthly reconcile against the simulated statements. Each bank line is recorded once. Cut the surrounding lock/journal/hold machinery to what one watched upload or reconcile actually needs.
7. **Plain-English visibility.** Status pages say what happened, what is unfinished and what is next, with no internal labels or hashes.

## How to work

- Prefer deleting or bypassing machinery over adding it. Add no new proof, hash, lease or gate layers.
- Send the owner a short plain-English plan first, then build in coherent batches. Saving `backend/src` restarts the backend (nodemon); the owner allows that for this work.
- Tests go through the `test-runner` subagent. One safety review on write-path changes only.
- Commit and push at each working milestone. Keep handoff notes to a few lines.
- Done means the live company shows it: activity flowing without waits, the calendar on monthly closes, a fraction of today's reviews and tokens, metered calls per record near the goal, and feed items imported and matched. Report before and after numbers.
