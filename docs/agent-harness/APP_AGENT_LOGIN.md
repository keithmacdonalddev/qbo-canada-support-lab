# Automatic local agent sign-in

The owner authorizes local coding chats and agents to reuse the privately enrolled agent credential for already authorized Test Data Lab work. Do not ask the owner to provide a password, export a token, share Chrome, supply a CDP port or sign in again for routine app access.

From C:\Projects\qbo, use hidden Node child-process execution under AGENTS.md:

    node scripts/security/app-agent-login.cjs login --actor codex-cli

For Claude Code, use --actor claude-code. The helper creates a unique owned agent-browser session, signs into the existing account/company, opens /company/bank, and returns only its session name, URL and account/company verification booleans. Continue browser actions in that returned session. Optional --session accepts an explicitly owned unique app session; never default or qbo-ops. Optional --path selects a bounded ordinary app page. Repeating login reuses a still-valid app session or obtains a fresh server-issued session automatically.

Close only your owned browser session when the task finishes. Preserve other chats' sessions and the separate QuickBooks qbo-ops session.

## Private storage and scope

The random agent secret is encrypted with Windows DPAPI CurrentUser under:

    %LOCALAPPDATA%\TestDataLab\agent-access\credential-<UUID>.dpapi

current.json in that directory contains non-secret account/company/credential identifiers and the storage-target fingerprint. No password, secret, JWT or signing key belongs in chat, Git, argv, screenshots, instructions, logs or environment examples. The helper handles the private exchange; do not run the vault PowerShell script directly or print its plaintext output.

This works for agents executing as the same Windows user on this computer with access to the checkout and running local app. It does not provision unrelated remote machines/accounts. Agent labels are audit descriptions, not new authority.

The credential is attached to the existing user. Owner password, normal owner sessions, memberships, company connection and automation settings are preserved. The server issues normal expiring JWT sessions and validates the current account, credential, company, environment and stable connection identity on protected requests. OAuth token expiry does not prevent app/settings access; existing QBO action gates still apply. Explicit account recovery, credential revocation or replacement of the current company connection can invalidate agent access. Ordinary business write-fence changes do not.

This app sign-in grants no additional QBO actions, service control, arbitrary mutations or approval bypass.

## Status, enrollment and revocation

Routine check (no secret output):

    node scripts/security/app-agent-login.cjs status

Enrollment is already owner-authorized in the 2026-11-01 setup task. Do not enroll or rotate on every chat. Enrollment is idempotent and retains the existing credential. It uses the exact existing account and active company:

    node scripts/security/app-agent-login.cjs enroll --user-id <existing-id> --realm-id <existing-realm>

The encrypted immutable credential file is staged before the audited database transaction. If the process is interrupted after commit, repeat enrollment for that same target; it recovers the exact credential UUID recorded in the database. It does not reset the owner's password or create another account.

Explicit revocation (only when requested):

    node scripts/security/app-agent-login.cjs revoke

Revocation validates the current storage target, removes agent access transactionally with its audit, and leaves ordinary owner sessions alone. Private encrypted files are retained for deliberate operator cleanup, not automatically reused after revocation.

For a failure, report the helper's sanitized stage and app health. Diagnose that narrow failure; an empty agent-browser auth vault is irrelevant because this helper uses its own Windows-encrypted credential.

## Verified installation

2026-11-02T00:20:44.353Z: one private credential enrolled for the existing owner/company ending 2856. Two independent fresh sessions (Codex and Claude actor labels) both verified the same account/company and opened the normal bank page; repeat login reported sessionReused:true. The owner password, role and policy snapshot matches the pre-enrollment snapshot after accounting for the ordinary business write counter. No owner sign-in was required. See [implementation/evidence](../plans/agent-app-access-2026-11-01.md).
