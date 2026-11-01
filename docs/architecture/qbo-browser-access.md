# Shared QuickBooks browser access

The existing QuickBooks API OAuth connection is independent of this native-screen login. The helper uses the Windows account running the application and its Generic Credential named `TestDataLab/QBO/production/2856`. Store the dedicated Intuit user's username and password there using Credential Manager → Windows Credentials → Add a generic credential. Never put them in the repository, task text, command arguments, environment variables or agent messages. Rotating/removing that credential or revoking the Intuit user controls future access.

The fixed target is Production **My Business**, company ID ending **2856**. The deterministic helper checks the current signed-in identity in the native QuickBooks account menu and actual QuickBooks company ID before admitting work. It uses the shared `qbo-ops` browser/profile and the existing global Terra lease. App banking and the command entry retain that lease throughout authentication and the entire native task. Actor names identify who requested a session; they do not grant permission.

From the repository root, use the installed Node executable with these arguments (coding agents must launch it using the hidden Windows process route required by AGENTS.md):

```text
node scripts/banking/qbo-session.cjs status --actor codex-cli
node scripts/banking/qbo-session.cjs ensure --actor codex-cli
node scripts/banking/qbo-session.cjs run --actor codex-cli --task artifacts/terra-live/tasks/<uuid>/task.txt
```

Use `claude-code`, `accountant` or `app` for the corresponding caller. `status` reads the last sanitized observation; it does not prove the browser is still signed in. `ensure` signs in or reuses the session and verifies identity/company, then releases the lease. Actual native work must use `run` or the app's governed banking runner so the lock covers the work itself. Do not run a separate browser task after `ensure` and assume it is coordinated.

A task file must already exist at the exact retained path shown above, contain 1–32,000 bytes, and state the intended company, authorized action, evidence and stop conditions. The command does not accept arbitrary executables, evaluation code or credential targets. The existing Terra scope, stop list, mutation authorization and banking accounting checks still apply. Raw persistent BF7 launches without the coordinator token are refused. Models never retrieve or type passwords; the private deterministic helper handles them.

The app's banking operator invokes this helper before creating a banking journal or starting an import. Authentication failures use separate durable retry state: a 15-minute cooldown, at most three attempts, preserved through heartbeats and restarts. A later successful verified sign-in permits a fresh check; it never clears an uncertain upload, Add, Match or reconciliation outcome. Those continue through the existing evidence-based recovery procedure.

If Intuit requires a text code, extra verification, CAPTCHA or another interactive challenge, the helper stops and records a sanitized blocked result. A saved password cannot guarantee unattended access indefinitely. Handle that challenge through the authorized account recovery/sign-in workflow; never place a verification code in a saved task or change authentication controls merely to make automation proceed.

Sanitized status and audit evidence is stored under `artifacts/banking/qbo-session-status.json` and `qbo-session-audit.jsonl`. It contains actor, scope, outcome and time, without credentials or raw page data. An uncertain child-process cleanup retains the global browser lease; inspect the retained process/native evidence before recovery. Do not delete a lock simply because progress looks slow.

See [implementation and bounded proof](../plans/qbo-automation-signin-2026-11-01.md) and the maintained [completion task list](../plans/app-completion-task-list-2026-11-01.md).
