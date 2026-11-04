# Shared QuickBooks browser access

## Direct credentials for all local project chats

**Standing owner permission, 2026-11-03:** every local Claude Code/Codex project chat and its authorized agents may retrieve and use the dedicated AI account's actual email/password for QBO sign-in whenever needed for authorized project work, without asking again. This remains valid until revoked by the owner. Do not require the reported-failing automatic sign-in wrapper.

The credential file is `%LOCALAPPDATA%/TestDataLab/qbo-ai-login.json`, currently `C:/Users/NewAdmin/AppData/Local/TestDataLab/qbo-ai-login.json`. Its two fields are `email` and `password`; both contain actual values copied from the existing dedicated AI Windows credential. The owner confirmed this is the intended source account. This file is local, outside Git, and readable by fresh processes under the same Windows user. It is separate from the Test Data Lab app credential.

Read it directly in the general Node REPL; no authentication wrapper is involved:

~~~javascript
var fs = await import('node:fs/promises');
var os = await import('node:os');
var path = await import('node:path');
var aiQboLogin = JSON.parse(await fs.readFile(
  path.join(os.homedir(), 'AppData', 'Local', 'TestDataLab', 'qbo-ai-login.json'), 'utf8'
));
// Use aiQboLogin.email and aiQboLogin.password to fill the observed Intuit form.
// Keep values private in this runtime; never print aiQboLogin or its fields.
~~~

Use the actual values through the authorized browser's data-entry API or private stdin transport. Avoid passwords in shell arguments, task prompts, screenshots, saved browser state or logs. Clear the credential variables after sign-in. The file can be edited by the owner to replace either value; future chats read the current file, not a cached chat message. Do not change or rotate the account credentials yourself.

**Access verified, not sign-in verified:** on Nov3 the file was populated and a fresh hidden Node process confirmed both fields are readable/nonempty. No native QBO sign-in was performed in that check. If Intuit presents additional verification, report that exact page requirement; do not misclassify readable credentials as missing permission.

**Nov4 protocol evidence:** the reviewed default path completed browser startup and reached Intuit’s “Check your text messages” screen in about10seconds. An SMS verification code is required; dedicated identity/company readiness remainsOPEN until it is completed and checked. No company writes occurred in that check. This supersedes the former120second launcher timeout, not the account’s verification requirement.

**Nov4 password-only recovery:** a fresh direct sign-in offered the password form after entering the dedicated email. The saved password succeeded without a code. The live dedicated identity and exact Production My Business company ID were verified under the shared lease; the original historical banking job then resumed through its existing recovery checks and started its upload. The earlier SMS challenge describes that earlier page, not a permanent requirement. Try the observed password form first; never change authentication controls or assume sign-in proves a banking action complete. Sanitized proof: `artifacts/native-access-20261104/password-only-ready.json`.

## Shared browser and company scope

The target is Production **My Business**, company ID ending **2856**, using the owner's dedicated AI Intuit account. Verify the signed-in identity and exact company before company-scoped work. The API OAuth connection is independent. Standing login permission does not authorize new bookkeeping, account administration, OAuth reconnects or service changes.

Use the shared `qbo-ops` browser/profile for coordinated native work. Direct sign-in in the main coding chat need not call `qbo-session.cjs ensure`: acquire the existing shared browser lease (`acquireSessionLease` from `backend/src/modules/qbo-browser-session.js`) before operating it, retain it through sign-in and the actual task, and release only your own lease after cleanup. Do not take over another active or uncertain session, delete locks or launch conflicting browser work. Keep local app inspection in its separate owned session.

## Optional existing coordinated sign-in runner

The default coordinated runner now reads the authorized per-user `TestDataLab/qbo-ai-login.json` directly and launches the installed native Windows browser CLI. The legacy Windows Generic Credential reader remains available only to explicit internal callers; it is not a sign-in prerequisite. Direct main-chat sign-in remains available under the same shared lease. Native CLI completion requires actual parent exit plus its bounded terminal JSON, since the persistent browser daemon may retain inherited pipes. The BF7 accounting runner's existing lease/token/recovery checks remain unchanged. Perform direct credential sign-in in the main coding chat when needed; do not embed the email/password in a Terra task.

From the repository root, use the installed Node executable with these arguments (coding agents must launch it using the hidden Windows process route required by AGENTS.md):

```text
node scripts/banking/qbo-session.cjs status --actor codex-cli
node scripts/banking/qbo-session.cjs ensure --actor codex-cli
node scripts/banking/qbo-session.cjs run --actor codex-cli --task artifacts/terra-live/tasks/<uuid>/task.txt
```

Use `claude-code`, `accountant` or `app` for the corresponding caller. `status` reads the last sanitized observation; it does not prove the browser is still signed in. `ensure` signs in or reuses the session and verifies identity/company, then releases the lease. Existing BF7 banking execution must use `run` or the app's governed banking runner so the lock covers the work itself. Direct main-chat sign-in/work uses the shared lease described above. Do not run a separate browser task after `ensure` and assume it is coordinated.

A task file must already exist at the exact retained path shown above, contain 1–32,000 bytes, and state the intended company, authorized action, evidence and stop conditions. The command does not accept arbitrary executables, evaluation code or credential targets. The existing Terra scope, stop list, mutation authorization and banking accounting checks still apply. Raw persistent BF7 launches without the coordinator token are refused. For direct main-chat sign-in, the standing owner permission above allows reading and entering the actual dedicated credentials. The optional runner handles them privately; neither route prints credentials.

The app's banking operator invokes this helper before creating a banking journal or starting an import. Authentication failures use separate durable retry state: a 15-minute cooldown, at most three attempts, preserved through heartbeats and restarts. A later successful verified sign-in permits a fresh check; it never clears an uncertain upload, Add, Match or reconciliation outcome. Those continue through the existing evidence-based recovery procedure.

If Intuit requires a text code, extra verification, CAPTCHA or another interactive challenge, the helper stops and records a sanitized blocked result. A saved password cannot guarantee unattended access indefinitely. Handle that challenge through the authorized account recovery/sign-in workflow; never place a verification code in a saved task or change authentication controls merely to make automation proceed.

Sanitized status and audit evidence is stored under `artifacts/banking/qbo-session-status.json` and `qbo-session-audit.jsonl`. It contains actor, scope, outcome and time, without credentials or raw page data. An uncertain child-process cleanup retains the global browser lease; inspect the retained process/native evidence before recovery. Do not delete a lock simply because progress looks slow.

See [implementation and bounded proof](../plans/qbo-automation-signin-2026-11-01.md) and the maintained [completion task list](../plans/app-completion-task-list-2026-11-01.md).
