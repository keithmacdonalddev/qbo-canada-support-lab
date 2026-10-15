# Private local account recovery

The app requires a private signing key and database-validated, versioned sign-in. The historical public tester password and signing key are refused. Startup validates this configuration before opening MongoDB; the backend binds to 127.0.0.1. The desktop, launcher and companion use that same address. Browser origins must be explicitly configured; defaults cover the ordinary localhost/127.0.0.1 desktop ports.

This is an operator procedure, not an automatic migration or permission for a coding agent to change credentials or services. Keep the existing account ID so its company, memberships, records and work remain attached. Creating a new account does not transfer them.

1. Explicitly stop the backend before credential changes. The recovery command refuses apply while either loopback family answers on its configured port; it never stops a process. Keep other local sessions from editing credentials during the procedure.
2. Configure JWT_SECRET in the private local environment with at least 32 random bytes. Do not use a published example or reuse a provider key. Rotating this key invalidates all existing browser sessions. Never paste the value into chat, logs, commits or support evidence. JWT_EXPIRES_IN must be a positive duration of at most seven days. APP_HOST must be 127.0.0.1; APP_ALLOWED_ORIGINS, if supplied, is a comma-separated list of exact HTTP(S) origins without paths.
3. Preview only the existing reserved account, using its actual ID:

   node scripts/security/recover-account.cjs --user-id <existing-account-id>

   The preview identifies the account, retained role, authentication version, local storage target fingerprint and exact review hash. It does not show a password, password hash, database URI or provider key. The fingerprint binds the decision to a canonical scheme, host list/ports, effective database, replica set and SRV service name. Userinfo and all credential-bearing query parameters are excluded, so it is not a verifier for database credentials. The command honors the same configured DNS override as normal startup.
4. After explicit approval of that exact account/target preview, apply with its hash:

   node scripts/security/recover-account.cjs --user-id <existing-account-id> --apply --review-hash <exact-preview-hash>

   Enter the new password twice in the private interactive prompt. Passwords are not accepted in arguments or redirected input. Use at least 15 characters and at most 72 UTF-8 bytes, matching bcrypt's input limit. The existing account keeps its ID and role; the transaction changes its password, advances authVersion, revokes old sessions, pauses its automation and appends an audit. Audit failure rolls the transaction back. No QuickBooks records, ownership, memberships, jobs or plans are removed or promoted.
5. Start the updated app only with explicit service authorization, then sign in with that same account and the new private password. The read surfaces remain available while automation is paused. Settings → Your sign-in lists retained pending, authorized or uncertain work, with counts for completed history. Stop unwanted work on its own page. Active worker leases and uncertain requests keep their original barriers; a stop never cancels an already sent accounting request.
6. Enable automation only after reviewing that retained work. Enabling can resume work already authorized under the original company, calendar and write controls. It does not approve new plans or resolve uncertain requests. The exact review, current account version and durable audit are required in the enable transaction. If the response is lost, Settings reads current authority; an unreadable result is explicitly unknown. Repeating the same confirmed enable decision returns its existing result.

The recovery CLI is never called by app startup. It does not rotate OAuth tokens or encrypt historical stored keys. Those are separate credential-storage concerns; changing browser authentication alone does not establish encryption at rest.
