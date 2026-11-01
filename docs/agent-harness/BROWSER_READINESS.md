# Browser verification readiness

Use the browser route that matches the task, before substantial UI implementation. A configured tool is not a connected browser; a working browser is not an authenticated app; an authenticated page is not completed feature acceptance.

## Identify the browser route before diagnosing it

Claude Code’s overnight Terra workflow used `terra-live.sh --flow` and isolated agent-browser, without a desktop-app dependency. Its original session records show the switch from Chrome-plugin mode at 2026-11-01T05:01:17Z, followed by an explicit route explanation at 05:19:53Z. Session: 5c0ba517-1424-42c8-818a-42acc6d80f63; retained rendered evidence: artifacts/terra-live/qbo-ops-20261101-013249/. Terra’s screenshots-only rule separately refused that run’s requested PDF. This proves historical page access/rendering, not current authentication or completed banking work.

The app-managed cua_repl plugin that currently reports a missing browser-access host is a different integration. Its manifest lists pass-through variable names; the inspected parent process lacks their values. That observation does not establish a regression in the working agent-browser route, and it does not establish that the owner’s previous workflow needed the desktop app. Compare the actual successful invocation, backend and retained result before changing setup. The isolated Playwright readiness check below is a separate verified route, not repair evidence for cua_repl or a current agent-browser flow.

## Local application inspection

When isolated browser automation is explicitly requested/permitted and the intended app is already running, use the repository command:

~~~text
npm run verify:browser -- --origin http://localhost:5173
~~~

Launch commands through the project's hidden general Node REPL route on Windows, with explicit executable/argument arrays. For npm use node plus the installed npm CLI rather than a shell wrapper. Do not start services for this check. The command uses the existing playwright-core dependency and installed Chrome engine; it does not use the owner's Chrome extension or personal profile. It does not depend on the first-party browser-access host.

The check verifies the app's healthy backend identity and frontend, launches its own hidden headless browser and temporary profile, clicks a known-byte synthetic download, renders the actual empty sign-in form at 1440×1000, captures it and reloads it. Page-context requests are exact-origin GET-only; application APIs and redirects, service workers, WebSockets and RTC are blocked. Only two existing static dependencies—the Vite runtime and the public discovery catalogue—are allowed through Vite's filesystem route; general filesystem access remains blocked. Chrome background/update/extension/sync suppression flags reduce browser background activity; this is not an operating-system network sandbox.

A 60-second work deadline and bounded cleanup apply. Only the owned browser process tree/profile and short-lived probe server are closed. Provider/tool variables are excluded from the browser and cleanup environment. Errors retain the failed stage and a sanitized code, without raw page content, credentials or provider errors. Evidence is written beneath ignored artifacts/browser-readiness/check-*; uncertain cleanup forces failure and retains the profile for diagnosis.

| Exit | Meaning | Required next action |
| --- | --- | --- |
| 1 | Readiness failed | Use the failed stage/code. Fix the smallest concrete dependency; preserve incomplete acceptance. |
| 2 | Browser mechanics work; app sign-in is still required | Arrange the existing authorized app authentication route, then verify the assigned feature. This is an intentional nonzero result. |

There is no exit 0 or feature-complete result. This command never retrieves credentials, mints sessions, signs in or clicks banking actions. Its probe is not a BANK-1 CSV or statement. Capture/download/reload readiness does not prove the authenticated account view, actual file downloads, persistence or QBO reconciliation. Those remain the assignment's separate direct acceptance evidence.

## Tool failure and fallback

1. Identify the target and required actions: local app, native QBO website or Windows app. Read the current assignment and reuse its valid authority. Do not substitute native desktop control for page inspection.
2. Check the selected route, then authentication and the planned verification actions early. Retain the exact failure once. Do not repeatedly probe a missing host or expand into speculative platform repairs.
3. If the first-party browser host is unavailable, use an already authorized isolated local route for local work. If tool policy genuinely requires permission that is absent, request only that specific scope once and continue independent work. Documentation does not grant tool permission.
4. Keep QBO website tasks on the shared coordinator/dedicated qbo-ops route with its existing locks, company scope and financial barriers. Local inspection does not grant QBO, database or service-control authority. Never take the banking session solely to inspect localhost.
5. Do not launch ChatGPT/other desktop apps, modify browser/security settings, fabricate access-host variables, retrieve credentials or restart services to guess at a repair. An external tool outage is not proof that a different browser route is broken.
6. Apply the existing five-minute optional/two-failed-approach and fifteen-minute essential checkpoints across retries and sessions. Preserve a blocked outcome honestly and take independent authorized work when possible; do not consume a feature session building another automation framework.

These are concrete checks and shared instructions, not a guarantee of external platform uptime or proof every future session followed them. Diagnose missing evidence before claiming delivery.

## Maintenance

~~~text
npm run test:browser-readiness
node --check scripts/agent-harness/check-app-browser.mjs
~~~

Focused regressions cover wrong-app identity, redirects, unsafe origins/methods, environment isolation, timed-out/late browser work, uncertain cleanup and false acceptance. After changing the route or browser launcher, perform the scoped live readiness invocation as well; adapters alone do not prove Windows/browser behavior. Changes to coding-harness command execution require distinct implementation and safety reviews.

## Verified checkpoint — 2026-11-01T22:03:41.792Z

The real localhost:5173 invocation exited 2 with appReachable, browserReady, desktopCapture, reloadReady, downloadMechanismReady and cleanupVerified all true. The lead inspected the actual 1440×1000 empty Sign in screenshot. Saved private evidence: artifacts/browser-readiness/check-SCaanF/result.json, desktop-login.png and download-probe.txt. Authentication remains required and both acceptance flags remain false. No app sign-in, QBO/database mutation, service restart or desktop app launch was performed.

The 12 focused regressions, 52 existing harness workflow tests, 32 static harness checks, Node syntax and diff whitespace checks pass. Distinct read-only implementation and safety reviews found no remaining concrete blocker in the final source. These reviews do not authorize live financial work.

Work-value ledger: this essential hardening advances an early, usable local verification route. The implementation file was created at 2026-11-01T21:52:49.293Z; preceding diagnosis is part of the same issue, not a reset. One REPL wait interruption was closed out without repeating an unknown action; render failures identified two concrete existing static dependencies, now narrowly allowed. The direct readiness milestone is delivered; stop this investigation and return the assigned feature owner to normal authenticated BANK-1 proof. No additional platform repair, framework, banking completion, token budget or automatic universal deadline is claimed.
